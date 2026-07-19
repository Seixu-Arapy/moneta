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
}

async function handleMessage(msg: TelegramMessage) {
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
    .insert({ raw_input: rawInput, image_url: imagePath, status: "pending" });

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

  let update: { message?: TelegramMessage };
  try {
    update = await req.json();
  } catch {
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
