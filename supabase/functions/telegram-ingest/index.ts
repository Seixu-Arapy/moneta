// Receipt ingestion via Telegram.
//
// Flow: Telegram webhook → validate secret token + chat_id → download file →
// compress in memory → upload to the `receipts` bucket → insert into
// pending_expenses → only then delete the Telegram message and confirm in chat.
//
// Deploy: supabase functions deploy telegram-ingest --no-verify-jwt
// (--no-verify-jwt is required: Telegram does not send the Supabase JWT)

import { createClient } from "npm:@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
// one or more authorized chat_ids, comma-separated: "111111,222222"
const ALLOWED_CHAT_IDS = new Set(
  Deno.env.get("TELEGRAM_ALLOWED_CHAT_IDS")!.split(",").map((s) => s.trim()),
);

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically
// by the Edge Functions runtime.
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const BUCKET = "receipts";
// used by the /processar command to trigger the worker on demand
const WORKER_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/process-receipts`;
const WORKER_SECRET = Deno.env.get("WORKER_SECRET") ?? "";
const MAX_DIMENSION = 2000;
const JPEG_QUALITY = 80;

async function tg(method: string, payload: Record<string, unknown>) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

async function downloadTelegramFile(fileId: string): Promise<Uint8Array> {
  const info = await tg("getFile", { file_id: fileId });
  if (!info.ok) throw new Error(`getFile failed: ${JSON.stringify(info)}`);
  const res = await fetch(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`,
  );
  if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

interface CompressedFile {
  bytes: Uint8Array;
  contentType: string;
  ext: string;
}

// Compresses in memory: resizes to at most 2000px and re-encodes as JPEG q80.
// PDFs pass through untouched; formats the decoder does not support (e.g. HEIC)
// are uploaded as-is — the bucket accepts heic and the AI stage handles them.
async function compress(bytes: Uint8Array, mime: string): Promise<CompressedFile> {
  if (mime === "application/pdf") {
    return { bytes, contentType: mime, ext: "pdf" };
  }
  try {
    const img = await Image.decode(bytes);
    if (Math.max(img.width, img.height) > MAX_DIMENSION) {
      if (img.width >= img.height) {
        img.resize(MAX_DIMENSION, Image.RESIZE_AUTO);
      } else {
        img.resize(Image.RESIZE_AUTO, MAX_DIMENSION);
      }
    }
    const out = await img.encodeJPEG(JPEG_QUALITY);
    return { bytes: out, contentType: "image/jpeg", ext: "jpg" };
  } catch {
    const ext = mime.split("/")[1] ?? "bin";
    return { bytes, contentType: mime, ext };
  }
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: { file_id: string }[];
  document?: { file_id: string; mime_type?: string; file_name?: string };
  reply_to_message?: { message_id: number };
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

async function countByStatus(status: string): Promise<number> {
  const { count } = await supabase
    .from("pending_expenses")
    .select("id", { count: "exact", head: true })
    .eq("status", status);
  return count ?? 0;
}

async function sendQueueStatus(chatId: number) {
  const [pending, waiting, errors] = await Promise.all([
    countByStatus("pending"),
    countByStatus("waiting_user"),
    countByStatus("error"),
  ]);

  if (pending + waiting + errors === 0) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "✨ Nenhuma pendência — tudo processado.",
    });
    return;
  }

  const lines = ["📋 Situação da fila:"];
  if (pending > 0) lines.push(`• ${pending} aguardando processamento`);
  if (waiting > 0) lines.push(`• ${waiting} esperando resposta sua`);
  if (errors > 0) lines.push(`• ${errors} com erro (revisão manual)`);
  if (pending > 0) lines.push("\nEnvie /processar para rodar agora sem esperar o cron.");
  await tg("sendMessage", { chat_id: chatId, text: lines.join("\n") });
}

async function triggerWorker(chatId: number) {
  if (!WORKER_SECRET) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "⚠️ Worker não configurado (secret WORKER_SECRET ausente).",
    });
    return;
  }
  await tg("sendMessage", { chat_id: chatId, text: "⚙️ Processando a fila..." });

  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "x-worker-secret": WORKER_SECRET },
  });
  const body = await res.json().catch(() => ({}));

  let text: string;
  if (body.skipped) {
    text = "🛑 Orçamento diário de processamento atingido — a fila continua amanhã.";
  } else {
    const parts = [
      `${body.resolved ?? 0} registrado(s)`,
      `${body.asked ?? 0} pergunta(s) enviada(s)`,
    ];
    if (body.retrying) parts.push(`${body.retrying} com falha temporária (retentando)`);
    if (body.failed) parts.push(`${body.failed} com erro definitivo`);
    text = `✅ Rodada concluída: ${parts.join(", ")}.`;
    if (body.rateLimited) {
      text += "\n⏳ Limite do free tier atingido — o restante fica para o próximo ciclo.";
    }
  }
  await tg("sendMessage", { chat_id: chatId, text: text });
}

// Lowercases, strips accents, drops a trailing "@BotUsername" from slash
// commands (present in group chats), and trims punctuation — so "/Processar",
// "/processar@MyBot" and "Alguma pendência?" all normalize the same way.
function normalizeCommand(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^(\/\w+)@\w+/, "$1")
    .replace(/[?!.]+$/, "");
}

const STATUS_COMMANDS = new Set(["/pendencias", "/status", "alguma pendencia", "pendencias"]);
const PROCESS_COMMANDS = new Set(["/processar", "processar agora"]);
const REVIEW_COMMANDS = new Set(["/revisar", "revisar"]);

interface PendingExpense {
  id: string;
  merchant: string | null;
  amount: number;
  currency: string;
  image_url: string | null;
  raw_input: string | null;
  parsed_data: Record<string, unknown> | null;
  telegram_chat_id: string | null;
}

async function fetchPendingForReview(chatId: number): Promise<PendingExpense[]> {
  const { data, error } = await supabase
    .from("pending_expenses")
    .select("id, merchant, amount, currency, image_url, raw_input, parsed_data, telegram_chat_id")
    .in("status", ["pending", "waiting_user"])
    .eq("telegram_chat_id", String(chatId))
    .order("created_at");
  if (error) {
    console.error("fetch pending failed:", error);
    return [];
  }
  return (data ?? []) as PendingExpense[];
}

async function getSuggestedCategories(merchant: string | null, amount: number): Promise<Array<{ id: string; name: string; confidence: number }>> {
  if (!merchant) return [];
  const { data, error } = await supabase.rpc("suggest_category_for_merchant", {
    p_merchant: merchant,
    p_amount: amount,
    p_limit: 3,
  });
  if (error) {
    console.warn("category suggestion failed:", error);
    return [];
  }
  return (data ?? []).map((row: { category_id: string; category_name: string; confidence: number }) => ({
    id: row.category_id,
    name: row.category_name,
    confidence: row.confidence,
  }));
}

function formatReviewMessage(pending: PendingExpense, suggestions: Array<{ id: string; name: string; confidence: number }>): string {
  const merchant = pending.merchant ?? "Despesa";
  let msg = `📋 ${merchant} — R$ ${pending.amount.toFixed(2)} ${pending.currency}\n`;

  if (pending.parsed_data?.items && Array.isArray(pending.parsed_data.items)) {
    const items = pending.parsed_data.items as Array<{ description?: string }>;
    if (items.length > 0) {
      msg += `Itens: ${items.map((i) => i.description).join(", ")}\n`;
    }
  }

  if (suggestions.length > 0) {
    msg += "\n💡 Categorias sugeridas:\n";
    suggestions.forEach((s, i) => {
      msg += `${i + 1}. ${s.name} (${(s.confidence * 100).toFixed(0)}%)\n`;
    });
  }

  return msg;
}

async function sendReviewMessage(chatId: number, pending: PendingExpense, suggestions: Array<{ id: string; name: string; confidence: number }>) {
  const msg = formatReviewMessage(pending, suggestions);

  const keyboard = {
    inline_keyboard: [
      [
        { text: "👁️ Ver nota", callback_data: `ver:${pending.id}` },
        { text: "📝 Classificar", callback_data: `classificar:${pending.id}` },
      ],
      [
        { text: "✏️ Corrigir valor", callback_data: `corrigir:${pending.id}` },
        { text: "✅ Confirmar", callback_data: `confirmar:${pending.id}` },
      ],
      [
        { text: "⏰ Mais tarde", callback_data: `depois:${pending.id}` },
        { text: "🗑️ Descartar", callback_data: `descartar:${pending.id}` },
      ],
    ],
  };

  await tg("sendMessage", {
    chat_id: chatId,
    text: msg,
    reply_markup: keyboard,
  });
}

async function startReview(chatId: number) {
  const pending = await fetchPendingForReview(chatId);

  if (pending.length === 0) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "✨ Sem gastos para revisar — tudo processado.",
    });
    return;
  }

  await tg("sendMessage", {
    chat_id: chatId,
    text: `📌 Você tem ${pending.length} gastos para revisar`,
  });

  // Show the first one
  const first = pending[0];
  const suggestions = await getSuggestedCategories(first.merchant, first.amount);
  await sendReviewMessage(chatId, first, suggestions);
}

// Chat commands are intercepted before ingestion — otherwise the text would
// itself become a pending expense. Returns false when the message is not a
// command.
async function handleCommand(msg: TelegramMessage): Promise<boolean> {
  if (!msg.text) return false;
  const text = normalizeCommand(msg.text);

  if (STATUS_COMMANDS.has(text)) {
    await sendQueueStatus(msg.chat.id);
    return true;
  }
  if (PROCESS_COMMANDS.has(text)) {
    await triggerWorker(msg.chat.id);
    return true;
  }
  if (REVIEW_COMMANDS.has(text)) {
    await startReview(msg.chat.id);
    return true;
  }
  return false;
}

// A reply to one of the worker's questions re-queues the paused row with the
// answer appended as context. Returns false when the message is not a reply
// to a pending question (normal ingestion should proceed).
async function handleQuestionReply(msg: TelegramMessage): Promise<boolean> {
  if (!msg.reply_to_message || !msg.text) return false;

  const { data: waiting } = await supabase
    .from("pending_expenses")
    .select("id, raw_input")
    .eq("question_message_id", msg.reply_to_message.message_id)
    .eq("telegram_chat_id", String(msg.chat.id))
    .eq("status", "waiting_user")
    .maybeSingle();
  if (!waiting) return false;

  const rawInput = [waiting.raw_input, `Resposta do usuário à pergunta: ${msg.text}`]
    .filter(Boolean)
    .join("\n");
  const { error } = await supabase
    .from("pending_expenses")
    .update({ raw_input: rawInput, status: "pending", question_message_id: null })
    .eq("id", waiting.id);
  if (error) throw new Error(`reply update failed: ${error.message}`);

  await tg("sendMessage", {
    chat_id: msg.chat.id,
    text: "👍 Obrigado! Vou reprocessar com essa informação.",
  });
  return true;
}

async function handleCallback(cq: TelegramCallbackQuery) {
  const chatId = cq.message?.chat.id;
  if (!chatId || !ALLOWED_CHAT_IDS.has(String(chatId))) return;

  const parts = (cq.data ?? "").split(":", 3);
  const [kind, pendingId] = parts;

  let answerText = "Ok";
  let newText: string | null = null;

  // Duplicate question from worker: "dup:<id>:<action>"
  if (kind === "dup") {
    const action = parts[2];
    const { data: row } = await supabase
      .from("pending_expenses")
      .select("id, parsed_data")
      .eq("id", pendingId)
      .eq("status", "waiting_user")
      .maybeSingle();

    if (!row) {
      answerText = "Essa pendência já foi tratada.";
    } else if (action === "discard") {
      await supabase
        .from("pending_expenses")
        .update({ status: "discarded", question_message_id: null })
        .eq("id", row.id);
      newText = "🗑️ Descartado como duplicata.";
    } else if (action === "keep") {
      const parsed = (row.parsed_data ?? {}) as Record<string, unknown>;
      const { error } = await supabase.rpc("resolve_pending_expense", {
        p_pending_id: row.id,
        p_expense: {
          merchant: parsed.merchant ?? null,
          transaction_time: parsed.transaction_time ?? null,
          amount: parsed.amount,
          currency: parsed.currency ?? "BRL",
          category_id: parsed.category_id ?? null,
          notes: parsed.notes ?? null,
        },
        p_items: parsed.items ?? [],
      });
      if (error) {
        console.error("resolve after keep failed:", error);
        answerText = "⚠️ Falha ao registrar — tente de novo.";
      } else {
        await supabase
          .from("pending_expenses")
          .update({ question_message_id: null })
          .eq("id", row.id);
        newText = "💾 Registrado mesmo assim.";
      }
    }
  }
  // Review flow callbacks
  else if (kind === "ver") {
    // Show the image/text
    const { data: pending } = await supabase
      .from("pending_expenses")
      .select("image_url, raw_input")
      .eq("id", pendingId)
      .maybeSingle();

    if (pending?.image_url) {
      const { data: signed, error: signError } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(pending.image_url, 300);
      if (!signError && signed) {
        await tg("sendPhoto", { chat_id: chatId, photo: signed.signedUrl });
        answerText = "Foto do recibo:";
      }
    }
    if (pending?.raw_input) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `📄 Nota original:\n\n${pending.raw_input}`,
      });
      answerText = "Nota mostrada acima.";
    }
  } else if (kind === "classificar") {
    // Show category options
    const { data: pending } = await supabase
      .from("pending_expenses")
      .select("merchant, amount")
      .eq("id", pendingId)
      .maybeSingle();

    if (pending) {
      const suggestions = await getSuggestedCategories(pending.merchant, pending.amount);
      if (suggestions.length > 0) {
        const keyboard = {
          inline_keyboard: suggestions.map((s) => [
            { text: `${s.name} (${(s.confidence * 100).toFixed(0)}%)`, callback_data: `cat:${pendingId}:${s.id}` },
          ]),
        };
        await tg("sendMessage", {
          chat_id: chatId,
          text: "Escolha a categoria:",
          reply_markup: keyboard,
        });
      } else {
        answerText = "Sem sugestões disponíveis.";
      }
    }
  } else if (kind === "cat") {
    // Save category (merged into existing parsed_data) and re-show
    const categoryId = parts[2];
    const { data: current } = await supabase
      .from("pending_expenses")
      .select("parsed_data")
      .eq("id", pendingId)
      .maybeSingle();
    const { error } = await supabase
      .from("pending_expenses")
      .update({ parsed_data: { ...(current?.parsed_data ?? {}), category_id: categoryId } })
      .eq("id", pendingId);

    if (!error) {
      const { data: pending } = await supabase
        .from("pending_expenses")
        .select("id, merchant, amount, currency, image_url, raw_input, parsed_data, telegram_chat_id")
        .eq("id", pendingId)
        .maybeSingle();

      if (pending) {
        const suggestions = await getSuggestedCategories(pending.merchant, pending.amount);
        newText = formatReviewMessage(pending as PendingExpense, suggestions);
        answerText = "✅ Categoria salva";
      }
    } else {
      answerText = "Falha ao salvar categoria";
    }
  } else if (kind === "corrigir") {
    // Ask for the new value; the reply is captured by handleQuestionReply,
    // which needs question_message_id + status='waiting_user' to match it.
    const sent = await tg("sendMessage", {
      chat_id: chatId,
      text: "Qual é o novo valor? (ex: 150.50)",
      reply_markup: { force_reply: true },
    });
    const sentMessageId = sent?.result?.message_id;
    if (sentMessageId) {
      await supabase
        .from("pending_expenses")
        .update({ question_message_id: sentMessageId, status: "waiting_user" })
        .eq("id", pendingId);
      answerText = "Digite o novo valor e eu salvo";
    } else {
      answerText = "Falha ao iniciar correção — tente de novo.";
    }
  } else if (kind === "confirmar") {
    // Resolve the pending expense
    const { data: pending } = await supabase
      .from("pending_expenses")
      .select("id, parsed_data")
      .eq("id", pendingId)
      .maybeSingle();

    if (pending) {
      const parsed = (pending.parsed_data ?? {}) as Record<string, unknown>;
      const { error } = await supabase.rpc("resolve_pending_expense", {
        p_pending_id: pendingId,
        p_expense: {
          merchant: parsed.merchant ?? null,
          transaction_time: parsed.transaction_time ?? null,
          amount: parsed.amount,
          currency: parsed.currency ?? "BRL",
          category_id: parsed.category_id ?? null,
          notes: parsed.notes ?? null,
        },
        p_items: parsed.items ?? [],
      });

      if (!error) {
        newText = "✅ Confirmado e registrado.";
        // Show next pending (if any)
        const allPending = await fetchPendingForReview(chatId);
        const remaining = allPending.filter((p) => p.id !== pendingId);
        if (remaining.length > 0) {
          await tg("sendMessage", {
            chat_id: chatId,
            text: `\nPróxima (${remaining.length} restando):`,
          });
          const next = remaining[0];
          const suggestions = await getSuggestedCategories(next.merchant, next.amount);
          await sendReviewMessage(chatId, next, suggestions);
        }
      } else {
        answerText = "Falha ao confirmar";
      }
    }
  } else if (kind === "depois") {
    // Just respond and leave
    newText = "Ok, deixo para depois";
    answerText = "";
  } else if (kind === "descartar") {
    // Mark as discarded
    const { error } = await supabase
      .from("pending_expenses")
      .update({ status: "discarded" })
      .eq("id", pendingId);

    if (!error) {
      newText = "🗑️ Descartado.";
      // Show next pending
      const allPending = await fetchPendingForReview(chatId);
      const remaining = allPending.filter((p) => p.id !== pendingId);
      if (remaining.length > 0) {
        await tg("sendMessage", {
          chat_id: chatId,
          text: `\nPróxima (${remaining.length} restando):`,
        });
        const next = remaining[0];
        const suggestions = await getSuggestedCategories(next.merchant, next.amount);
        await sendReviewMessage(chatId, next, suggestions);
      }
    } else {
      answerText = "Falha ao descartar";
    }
  }

  if (answerText) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: answerText });
  }
  if (newText && cq.message) {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cq.message.message_id,
      text: newText,
    });
  }
}

async function handleMessage(msg: TelegramMessage) {
  if (await handleQuestionReply(msg)) return;
  if (await handleCommand(msg)) return;

  const rawInput = msg.caption ?? msg.text ?? null;

  let fileId: string | null = null;
  let mime = "image/jpeg";

  if (msg.photo && msg.photo.length > 0) {
    // msg.photo lists multiple sizes; the last one is the largest
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.document) {
    const docMime = msg.document.mime_type ?? "";
    if (!docMime.startsWith("image/") && docMime !== "application/pdf") {
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        text: "⚠️ Só aceito imagens ou PDF de recibos.",
      });
      return;
    }
    fileId = msg.document.file_id;
    mime = docMime;
  } else if (!rawInput) {
    return; // nothing useful (sticker, audio, etc.)
  }

  let imagePath: string | null = null;

  if (fileId) {
    const original = await downloadTelegramFile(fileId);
    const file = await compress(original, mime);
    imagePath = `${crypto.randomUUID()}.${file.ext}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(imagePath, file.bytes, { contentType: file.contentType });
    if (uploadError) throw new Error(`bucket upload failed: ${uploadError.message}`);
  }

  const { error: insertError } = await supabase
    .from("pending_expenses")
    .insert({
      raw_input: rawInput,
      image_url: imagePath,
      status: "pending",
      telegram_chat_id: String(msg.chat.id),
    });

  if (insertError) {
    // avoid leaving an orphaned file in the bucket when the insert fails
    if (imagePath) {
      await supabase.storage.from(BUCKET).remove([imagePath]);
    }
    throw new Error(`pending_expenses insert failed: ${insertError.message}`);
  }

  // Saved and registered — only now delete the original Telegram message
  if (fileId) {
    await tg("deleteMessage", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
    });
  }

  await tg("sendMessage", {
    chat_id: msg.chat.id,
    text: imagePath
      ? "✅ Recibo registrado e foto apagada do chat."
      : "✅ Despesa registrada (texto).",
  });

  // Auto-start review for the new entry
  await tg("sendMessage", {
    chat_id: msg.chat.id,
    text: "📌 Você tem 1 gasto para revisar",
  });
  const newPending = await fetchPendingForReview(msg.chat.id);
  if (newPending.length > 0) {
    const latest = newPending[newPending.length - 1];
    const suggestions = await getSuggestedCategories(latest.merchant, latest.amount);
    await sendReviewMessage(msg.chat.id, latest, suggestions);
  }
}

Deno.serve(async (req) => {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  let update: { message?: TelegramMessage; callback_query?: TelegramCallbackQuery };
  try {
    update = await req.json();
  } catch {
    return new Response("ok");
  }

  if (update.callback_query) {
    try {
      await handleCallback(update.callback_query);
    } catch (err) {
      console.error("callback handling failed:", err);
    }
    return new Response("ok");
  }

  const msg = update.message;
  // messages from chats outside the allowlist are silently ignored
  if (!msg || !ALLOWED_CHAT_IDS.has(String(msg.chat?.id))) {
    return new Response("ok");
  }

  try {
    await handleMessage(msg);
  } catch (err) {
    console.error("ingestion failed:", err);
    // the original message stays in the chat so the receipt is not lost
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `⚠️ Falha ao registrar o recibo — a mensagem foi mantida no chat. Detalhe: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }).catch(() => {});
  }

  // always 200 so Telegram does not keep retrying the update
  return new Response("ok");
});
