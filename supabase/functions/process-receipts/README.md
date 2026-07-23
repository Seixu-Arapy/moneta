# process-receipts — Worker de processamento com IA

Edge Function agendada (cron) que consome a fila `pending_expenses`: baixa o recibo do bucket, extrai os dados com o **Gemini** (saída estruturada), checa duplicatas e grava `expenses` + `expense_items` via a RPC `resolve_pending_expense`. Quando fica em dúvida, pergunta pelo bot do Telegram e pausa a pendência como `waiting_user` (o `telegram-ingest` trata a resposta e devolve a linha para a fila).

## Controle de consumo (free tier)

Três camadas, todas configuráveis por secret:

| Camada | Como funciona | Config |
|---|---|---|
| Lote pequeno e sequencial | Cada execução processa poucos recibos, um por vez — nunca estoura o limite por minuto | `WORKER_BATCH_SIZE` (padrão 2) |
| Orçamento diário | Conta os recibos processados hoje (`processed_at`) e para ao atingir o teto | `WORKER_DAILY_BUDGET` (padrão 200) |
| Parada em 429 | Se o Google devolver rate limit, a execução encerra; o restante fica na fila para o próximo ciclo | automático |

Com cron a cada 10 min × lote 2, o teto natural é ~288 chamadas/dia — o orçamento diário corta antes disso.

> ⚠️ **Garantindo que nada é cobrado**: crie a `GEMINI_API_KEY` em um **projeto do Google Cloud sem billing vinculado** (no AI Studio, escolha/crie um projeto sem faturamento ao gerar a chave). Um projeto sem billing é travado no free tier por construção — ao estourar o limite, as chamadas falham com 429 (e a fila espera), mas **nunca geram cobrança**. Não reutilize a chave de um projeto com billing ativo: nele, o excedente do free tier é cobrado da sua cota paga.

## Configuração

### 1. Migrações

Além das migrações iniciais, aplique no SQL Editor:

- `20260719000001_add_worker_support.sql` — colunas `telegram_chat_id`, `question_message_id`, `processed_at`
- `20260719000002_resolve_pending_expense.sql` — a RPC transacional

### 2. Secrets e deploy

```sh
WORKER_SECRET=$(openssl rand -hex 32)
echo "WORKER_SECRET=$WORKER_SECRET"   # guarde — vai no agendamento do passo 3

supabase secrets set \
  GEMINI_API_KEY=<chave do AI Studio (projeto SEM billing)> \
  WORKER_SECRET=$WORKER_SECRET
# TELEGRAM_BOT_TOKEN já está definido pelo telegram-ingest
# opcionais: GEMINI_MODEL, WORKER_BATCH_SIZE, WORKER_DAILY_BUDGET

supabase functions deploy process-receipts --no-verify-jwt
```

> **Modelo padrão**: `gemini-3.6-flash` (a geração atual no momento em que este worker foi escrito). O Google aposenta modelos com frequência e chaves novas costumam ficar bloqueadas nas versões antigas — se aparecer o erro "this model is no longer available to new users" (visível na mensagem de ⚠️ do bot), confira o nome atual em [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models) e ajuste com `supabase secrets set GEMINI_MODEL=<nome atual>` — sem precisar alterar código.

### 3. Agendar com pg_cron

No SQL Editor (substitua `<project-ref>` e `<WORKER_SECRET>`):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'process-receipts',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/process-receipts',
    headers := jsonb_build_object('x-worker-secret', '<WORKER_SECRET>')
  );
  $$
);
```

Para pausar: `select cron.unschedule('process-receipts');`

### 4. Atualizar o webhook do Telegram

O ciclo de dúvidas usa botões (`callback_query`), então reregistre o webhook incluindo esse tipo de update — comando atualizado no README do `telegram-ingest`.

## Testar

1. Envie um recibo pelo bot e aguarde o próximo ciclo do cron (ou dispare manualmente: `curl -H "x-worker-secret: $WORKER_SECRET" https://<project-ref>.supabase.co/functions/v1/process-receipts`).
2. Esperado: mensagem "💾 ... registrado" no chat, linha em `expenses` (+ `expense_items` se o recibo discriminar), e a pendência com `status = 'done'`.
3. Envie o mesmo recibo de novo para ver o fluxo de duplicata (pergunta com botões).

Logs: `supabase functions logs process-receipts`.
