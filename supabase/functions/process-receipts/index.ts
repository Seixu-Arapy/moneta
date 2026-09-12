// Scheduled worker that consumes the pending_expenses queue.
//
// For each pending row: downloads the receipt from the bucket, extracts the
// data with Gemini (structured output), checks for duplicates, and either
// resolves it into expenses/expense_items (resolve_pending_expense RPC) or
// asks the user through the Telegram bot and pauses the row as 'waiting_user'.
//
// Free-tier throttling, three layers:
// - small sequential batch per run (WORKER_BATCH_SIZE)
// - hard daily cap (WORKER_DAILY_BUDGET) counted through processed_at
// - on HTTP 429 the run stops; remaining rows wait for the next cron tick
//
// Deploy: supabase functions deploy process-receipts --no-verify-jwt
// Scheduling: pg_cron + pg_net (see README.md).

import { createClient } from "npm:@supabase/supabase-js@2";
import { GoogleGenAI, Type } from "npm:@google/genai";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

const WORKER_SECRET = Deno.env.get("WORKER_SECRET")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.6-flash";
const BATCH_SIZE = Number(Deno.env.get("WORKER_BATCH_SIZE") ?? "2");
const DAILY_BUDGET = Number(Deno.env.get("WORKER_DAILY_BUDGET") ?? "200");
const MAX_ATTEMPTS = Number(Deno.env.get("WORKER_MAX_ATTEMPTS") ?? "3");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const ai = new GoogleGenAI({ apiKey: Deno.env.get("GEMINI_API_KEY")! });

const BUCKET = "receipts";
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
};

const receiptSchema = {
  type: Type.OBJECT,
  properties: {
    merchant: { type: Type.STRING, nullable: true },
    transaction_time: { type: Type.STRING, nullable: true },
    amount: { type: Type.NUMBER },
    currency: { type: Type.STRING },
    category_id: { type: Type.STRING, nullable: true },
    category_confidence: { type: Type.NUMBER, nullable: true },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          description: { type: Type.STRING },
          quantity: { type: Type.NUMBER, nullable: true },
          unit_price: { type: Type.NUMBER, nullable: true },
          total: { type: Type.NUMBER, nullable: true },
        },
        required: ["description"],
      },
    },
    needs_detail: { type: Type.BOOLEAN },
    notes: { type: Type.STRING, nullable: true },
  },
  required: ["amount", "currency", "items", "needs_detail"],
};

interface ParsedItem {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  total: number | null;
}

interface ParsedReceipt {
  merchant: string | null;
  transaction_time: string | null;
  amount: number;
  currency: string;
  category_id: string | null;
  category_confidence: number | null;
  items: ParsedItem[];
  needs_detail: boolean;
  notes: string | null;
}

interface CategorySuggestion {
  category_id: string;
  category_name: string;
  confidence: number;
}

interface PendingRow {
  id: string;
  raw_input: string | null;
  image_url: string | null;
  parsed_data: Record<string, unknown> | null;
  telegram_chat_id: string | null;
  attempts: number;
}

async function tg(method: string, payload: Record<string, unknown>) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

function isRateLimit(err: unknown): boolean {
  const s = String(err);
  return s.includes("429") || s.includes("RESOURCE_EXHAUSTED");
}

async function countProcessedToday(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from("pending_expenses")
    .select("id", { count: "exact", head: true })
    .gte("processed_at", startOfDay.toISOString());
  if (error) throw new Error(`budget count failed: ${error.message}`);
  return count ?? 0;
}

async function extract(row: PendingRow): Promise<ParsedReceipt> {
  const parts: Record<string, unknown>[] = [];

  if (row.image_url) {
    const { data, error } = await supabase.storage.from(BUCKET).download(row.image_url);
    if (error) throw new Error(`bucket download failed: ${error.message}`);
    const ext = row.image_url.split(".").pop()?.toLowerCase() ?? "";
    parts.push({
      inlineData: {
        mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream",
        data: encodeBase64(new Uint8Array(await data.arrayBuffer())),
      },
    });
  }

  let prompt =
    "Extraia os dados desta despesa. Valores em formato numérico, data/hora em " +
    "ISO 8601 com timezone de São Paulo quando não houver outra indicação. " +
    "Liste cada item quando o recibo discriminar (senão, lista vazia). " +
    "Se um campo importante estiver ilegível ou faltando, use null, marque " +
    "needs_detail como true e explique em notes o que falta.";

  if (row.raw_input) {
    prompt += `\n\nContexto enviado pelo usuário:\n${row.raw_input}`;
  }
  parts.push({ text: prompt });

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts }],
    config: {
      responseMimeType: "application/json",
      responseSchema: receiptSchema,
    },
  });
  return JSON.parse(response.text ?? "") as ParsedReceipt;
}

async function suggestCategories(merchant: string | null, amount: number): Promise<CategorySuggestion[]> {
  if (!merchant) return [];
  const { data, error } = await supabase.rpc("suggest_category_for_merchant", {
    p_merchant: merchant,
    p_amount: amount,
    p_limit: 3,
  });
  if (error) {
    console.warn(`category suggestion failed: ${error.message}`);
    return [];
  }
  return (data ?? []).map((row: { category_id: string; category_name: string; confidence: number }) => ({
    category_id: row.category_id,
    category_name: row.category_name,
    confidence: row.confidence,
  }));
}

async function findDuplicates(parsed: ParsedReceipt) {
  const ref = parsed.transaction_time ? new Date(parsed.transaction_time) : new Date();
  const start = new Date(ref.getTime() - 3 * 86400_000).toISOString();
  const end = new Date(ref.getTime() + 3 * 86400_000).toISOString();
  const { data, error } = await supabase
    .from("expenses")
    .select("id, merchant, amount, transaction_time")
    .eq("amount", parsed.amount)
    .gte("transaction_time", start)
    .lte("transaction_time", end)
    .limit(3);
  if (error) throw new Error(`duplicate check failed: ${error.message}`);
  return data ?? [];
}

function summaryLine(parsed: ParsedReceipt): string {
  const merchant = parsed.merchant ?? "Despesa";
  return `${merchant} — ${parsed.amount.toFixed(2)} ${parsed.currency}`;
}

async function resolveRow(row: PendingRow, parsed: ParsedReceipt) {
  const { error } = await supabase.rpc("resolve_pending_expense", {
    p_pending_id: row.id,
    p_expense: {
      merchant: parsed.merchant,
      transaction_time: parsed.transaction_time,
      amount: parsed.amount,
      currency: parsed.currency,
      category_id: parsed.category_id,
      notes: parsed.notes,
    },
    p_items: parsed.items,
  });
  if (error) throw new Error(`resolve_pending_expense failed: ${error.message}`);

  if (row.telegram_chat_id) {
    await tg("sendMessage", {
      chat_id: row.telegram_chat_id,
      text: `💾 ${summaryLine(parsed)} registrado${parsed.items.length > 0 ? ` (${parsed.items.length} itens)` : ""}.`,
    });
  }
}

async function pauseWithQuestion(
  row: PendingRow,
  parsed: ParsedReceipt,
  question: { text: string; reply_markup: Record<string, unknown> },
  extra: Record<string, unknown> = {},
) {
  const sent = await tg("sendMessage", {
    chat_id: row.telegram_chat_id,
    text: question.text,
    reply_markup: question.reply_markup,
  });
  if (!sent.ok) throw new Error(`question sendMessage failed: ${JSON.stringify(sent)}`);

  const { error } = await supabase
    .from("pending_expenses")
    .update({
      status: "waiting_user",
      question_message_id: sent.result.message_id,
      parsed_data: parsed as unknown as Record<string, unknown>,
      ...extra,
    })
    .eq("id", row.id);
  if (error) throw new Error(`waiting_user update failed: ${error.message}`);
}

type Outcome = "resolved" | "asked";

async function processRow(row: PendingRow): Promise<Outcome> {
  // budget accounting happens per Gemini attempt, whatever the outcome
  await supabase
    .from("pending_expenses")
    .update({ processed_at: new Date().toISOString() })
    .eq("id", row.id);

  const parsed = await extract(row);

  // Merchant is only known after the first parse, so category suggestions from
  // history can't reach the same Gemini call — apply the top match directly
  // instead of spending a second Gemini call on it.
  if (parsed.merchant && !parsed.category_id) {
    const suggestions = await suggestCategories(parsed.merchant, parsed.amount);
    if (suggestions.length > 0) {
      parsed.category_id = suggestions[0].category_id;
      parsed.category_confidence = suggestions[0].confidence;
    }
  }

  const duplicateConfirmed = row.parsed_data?.duplicate_confirmed === true;
  if (!duplicateConfirmed) {
    const dupes = await findDuplicates(parsed);
    if (dupes.length > 0 && row.telegram_chat_id) {
      const when = dupes[0].transaction_time?.slice(0, 10) ?? "?";
      await pauseWithQuestion(
        row,
        parsed,
        {
          text:
            `🤔 ${summaryLine(parsed)} parece duplicado: já existe uma despesa ` +
            `de mesmo valor em ${when} (${dupes[0].merchant ?? "sem estabelecimento"}). O que faço?`,
          reply_markup: {
            inline_keyboard: [[
              { text: "É duplicata, descartar", callback_data: `dup:${row.id}:discard` },
              { text: "Registrar mesmo assim", callback_data: `dup:${row.id}:keep` },
            ]],
          },
        },
        { possible_duplicate_of: dupes.map((d) => d.id) },
      );
      return "asked";
    }
  }

  if (parsed.needs_detail && row.telegram_chat_id) {
    const hint = parsed.notes ? ` (${parsed.notes})` : "";
    await pauseWithQuestion(row, parsed, {
      text:
        `🤔 Não consegui ler tudo deste recibo${hint}. ` +
        "Responda a esta mensagem com a informação que falta.",
      reply_markup: { force_reply: true },
    });
    return "asked";
  }

  await resolveRow(row, parsed);
  return "resolved";
}

// A transient failure (network blip, temporary Gemini/Supabase error) stays
// 'pending' and is retried on a later run, up to MAX_ATTEMPTS. Only once
// retries are exhausted does the row become a permanent 'error' requiring
// manual review — this is what keeps a single bad receipt from silently
// burning through the daily Gemini budget forever.
async function markFailure(row: PendingRow, err: unknown): Promise<"retrying" | "failed"> {
  const attempts = row.attempts + 1;
  const detail = String(err).slice(0, 500);
  const exhausted = attempts >= MAX_ATTEMPTS;

  await supabase
    .from("pending_expenses")
    .update({
      status: exhausted ? "error" : "pending",
      attempts,
      parsed_data: { ...(row.parsed_data ?? {}), error: detail },
    })
    .eq("id", row.id);

  if (exhausted && row.telegram_chat_id) {
    await tg("sendMessage", {
      chat_id: row.telegram_chat_id,
      text:
        `⚠️ Não consegui processar um recibo depois de ${attempts} tentativas — ` +
        `ficou marcado para revisão.\n\n${detail}`,
    }).catch(() => {});
  }

  return exhausted ? "failed" : "retrying";
}

Deno.serve(async (req) => {
  if (req.headers.get("x-worker-secret") !== WORKER_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const processedToday = await countProcessedToday();
  const remainingBudget = DAILY_BUDGET - processedToday;
  if (remainingBudget <= 0) {
    return Response.json({ skipped: "daily budget reached", processedToday });
  }

  const { data: batch, error } = await supabase
    .from("pending_expenses")
    .select("id, raw_input, image_url, parsed_data, telegram_chat_id, attempts")
    .eq("status", "pending")
    .order("created_at")
    .limit(Math.min(BATCH_SIZE, remainingBudget));
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const result = { resolved: 0, asked: 0, retrying: 0, failed: 0, rateLimited: false };

  for (const row of batch ?? []) {
    try {
      const outcome = await processRow(row as PendingRow);
      if (outcome === "asked") result.asked++;
      else result.resolved++;
    } catch (err) {
      if (isRateLimit(err)) {
        // free-tier limit hit: stop the whole run, the queue keeps the rest
        result.rateLimited = true;
        break;
      }
      console.error(`processing ${row.id} failed:`, err);
      const outcome = await markFailure(row as PendingRow, err);
      if (outcome === "retrying") result.retrying++;
      else result.failed++;
    }
  }

  return Response.json(result);
});
