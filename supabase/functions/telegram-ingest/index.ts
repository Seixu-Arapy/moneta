// Ingestão de recibos via Telegram.
//
// Fluxo: webhook do Telegram → valida secret token + chat_id → baixa o arquivo →
// compacta em memória → upload no bucket `receipts` → insert em pending_expenses →
// só então apaga a mensagem no Telegram e confirma no chat.
//
// Deploy: supabase functions deploy telegram-ingest --no-verify-jwt
// (--no-verify-jwt é necessário: o Telegram não envia o JWT do Supabase)

import { createClient } from "npm:@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
// um ou mais chat_ids autorizados, separados por vírgula: "111111,222222"
const ALLOWED_CHAT_IDS = new Set(
  Deno.env.get("TELEGRAM_ALLOWED_CHAT_IDS")!.split(",").map((s) => s.trim()),
);

// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetadas automaticamente
// pelo runtime das Edge Functions.
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
  if (!info.ok) throw new Error(`getFile falhou: ${JSON.stringify(info)}`);
  const res = await fetch(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`,
  );
  if (!res.ok) throw new Error(`download do arquivo falhou: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

interface CompressedFile {
  bytes: Uint8Array;
  contentType: string;
  ext: string;
}

// Compacta em memória: redimensiona para no máx. 2000px e re-encoda em JPEG q80.
// PDFs passam direto; formatos que o decoder não conhece (ex.: HEIC) sobem
// como chegaram — o bucket aceita heic e o processamento com IA lida com eles.
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
    // msg.photo traz vários tamanhos; o último é o maior
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
    return; // nada útil (sticker, áudio etc.)
  }

  let imagePath: string | null = null;

  if (fileId) {
    const original = await downloadTelegramFile(fileId);
    const file = await compress(original, mime);
    imagePath = `${crypto.randomUUID()}.${file.ext}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(imagePath, file.bytes, { contentType: file.contentType });
    if (uploadError) throw new Error(`upload no bucket falhou: ${uploadError.message}`);
  }

  const { error: insertError } = await supabase
    .from("pending_expenses")
    .insert({ raw_input: rawInput, image_url: imagePath, status: "pending" });

  if (insertError) {
    // não deixa arquivo órfão no bucket se o registro falhou
    if (imagePath) {
      await supabase.storage.from(BUCKET).remove([imagePath]);
    }
    throw new Error(`insert em pending_expenses falhou: ${insertError.message}`);
  }

  // Salvo e registrado — só agora apaga a mensagem original do Telegram
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
  // mensagens de chats fora da allowlist são ignoradas silenciosamente
  if (!msg || !ALLOWED_CHAT_IDS.has(String(msg.chat?.id))) {
    return new Response("ok");
  }

  try {
    await handleMessage(msg);
  } catch (err) {
    console.error("ingestão falhou:", err);
    // mensagem original permanece no chat para não perder o recibo
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `⚠️ Falha ao registrar o recibo — a mensagem foi mantida no chat. Detalhe: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }).catch(() => {});
  }

  // sempre 200 para o Telegram não reenviar o update em loop
  return new Response("ok");
});
