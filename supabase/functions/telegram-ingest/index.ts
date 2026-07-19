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
      `${body.errors ?? 0} erro(s)`,
    ];
    text = `✅ Rodada concluída: ${parts.join(", ")}.`;
    if (body.rateLimited) {
      text += "\n⏳ Limite do free tier atingido — o restante fica para o próximo ciclo.";
    }
  }
  await tg("sendMessage", { chat_id: chatId, text: text });
}

// Chat commands are intercepted before ingestion — otherwise the text would
// itself become a pending expense. Returns false when the message is not a
// command.
async function handleCommand(msg: TelegramMessage): Promise<boolean> {
  if (!msg.text) return false;
  const text = msg.text.trim().toLowerCase().replace(/[?!.]+$/, "");

  if (["/pendencias", "/status", "alguma pendência", "alguma pendencia", "pendências", "pendencias"].includes(text)) {
    await sendQueueStatus(msg.chat.id);
    return true;
  }
  if (["/processar", "processar agora"].includes(text)) {
    await triggerWorker(msg.chat.id);
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

// Buttons from the worker's duplicate question: callback_data is "dup:<id>:<action>"
async function handleCallback(cq: TelegramCallbackQuery) {
  const chatId = cq.message?.chat.id;
  if (!chatId || !ALLOWED_CHAT_IDS.has(String(chatId))) return;

  const [kind, pendingId, action] = (cq.data ?? "").split(":");
  if (kind !== "dup" || !pendingId) return;

  const { data: row } = await supabase
    .from("pending_expenses")
    .select("id, parsed_data")
    .eq("id", pendingId)
    .eq("status", "waiting_user")
    .maybeSingle();

  let answerText = "Ok";
  let newText: string | null = null;

  if (!row) {
    answerText = "Essa pendência já foi tratada.";
  } else if (action === "discard") {
    await supabase
      .from("pending_expenses")
      .update({ status: "discarded", question_message_id: null })
      .eq("id", row.id);
    newText = "🗑️ Descartado como duplicata.";
  } else if (action === "keep") {
    // the worker stored the full parse; resolve directly without a new AI call
    const parsed = (row.parsed_data ?? {}) as Record<string, unknown>;
    const { error } = await supabase.rpc("resolve_pending_expense", {
      p_pending_id: row.id,
      p_expense: {
        merchant: parsed.merchant ?? null,
        transaction_time: parsed.transaction_time ?? null,
        amount: parsed.amount,
        currency: parsed.currency ?? "BRL",
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

  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: answerText });
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
