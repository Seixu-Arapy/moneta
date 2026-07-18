# telegram-ingest — Bot de ingestão de recibos

Edge Function que recebe o webhook do Telegram e faz a ingestão: valida o remetente, baixa a foto/PDF, **compacta em memória** (JPEG q80, máx. 2000px), sobe no bucket `receipts`, registra em `pending_expenses` e — só após confirmar que tudo foi salvo — **apaga a mensagem do chat** e responde ✅.

## O que o bot aceita

| Você envia | O que acontece |
|---|---|
| Foto (com ou sem legenda) | Foto compactada → bucket; legenda vira `raw_input` |
| Documento (imagem ou PDF) | Imagem compactada / PDF direto → bucket |
| **Só texto** ("almoço 42,50 no cartão Nubank") | Vira `pending_expenses` só com `raw_input`, sem imagem — a IA extrai os dados do texto na etapa de processamento |
| Outros (áudio, sticker...) | Ignorado |

Mensagens de qualquer chat fora da allowlist são ignoradas silenciosamente. A allowlist aceita **mais de um usuário**: basta listar os `chat_id`s separados por vírgula no secret `TELEGRAM_ALLOWED_CHAT_IDS` (ex.: `111111,222222`). Cada pessoa autorizada conversa com o mesmo bot e os recibos caem todos no mesmo banco.

## Configuração (uma vez)

### 1. Criar o bot

Fale com [@BotFather](https://t.me/BotFather) no Telegram → `/newbot` → escolha nome e username. Guarde o **token** (formato `123456:ABC-DEF...`).

### 2. Descobrir seu chat_id

Envie qualquer mensagem para o seu bot recém-criado, depois rode:

```sh
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9-]*' 
```

O número que aparecer é o seu `chat_id`. (Alternativa: mande uma mensagem para o bot @userinfobot.)

### 3. Configurar secrets e fazer deploy

Com a [CLI do Supabase](https://supabase.com/docs/guides/local-development/cli/getting-started) instalada e o projeto linkado (`supabase login` + `supabase link --project-ref <ref>`):

```sh
# gere o secret do webhook e guarde-o — será usado no passo 4
WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "WEBHOOK_SECRET=$WEBHOOK_SECRET"

supabase secrets set \
  TELEGRAM_BOT_TOKEN=<token do BotFather> \
  TELEGRAM_WEBHOOK_SECRET=$WEBHOOK_SECRET \
  TELEGRAM_ALLOWED_CHAT_IDS=<chat_id ou lista: 111111,222222>

supabase functions deploy telegram-ingest --no-verify-jwt
```

> `--no-verify-jwt` é obrigatório: o Telegram não envia o JWT do Supabase. A autenticação da função é feita pelo secret token do webhook.

### 4. Registrar o webhook no Telegram

```sh
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<project-ref>.supabase.co/functions/v1/telegram-ingest" \
  -d "secret_token=$WEBHOOK_SECRET" \
  -d "allowed_updates=[\"message\"]"
```

Deve responder `{"ok":true,...}`. Para conferir: `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`.

### 5. Testar

Envie uma foto de recibo para o bot. Esperado: a foto some do chat, chega um "✅ Recibo registrado", o arquivo aparece em **Storage → receipts** e a linha em **Table Editor → pending_expenses** com `status = 'pending'`.

Se algo falhar, o bot responde ⚠️ com o motivo e **mantém a mensagem no chat** (o recibo não se perde). Logs: `supabase functions logs telegram-ingest` ou no dashboard.

## Segurança (resumo)

- **Secret token do webhook**: requests sem o header `X-Telegram-Bot-Api-Secret-Token` correto recebem 401 — ninguém forja chamadas.
- **Allowlist de chat_id**: só as suas mensagens são processadas.
- **Auto-delete**: a foto é apagada do Telegram somente após upload + insert confirmados.
- **Chaves**: token do bot e `service_role` vivem apenas nos secrets da função — nunca no código ou no repositório.
