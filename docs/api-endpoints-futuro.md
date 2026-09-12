# Endpoints (Backend Original — Não Implementado)

> **Status: planejado, superado pela arquitetura atual.** O plano original previa um backend
> FastAPI com apenas duas rotas HTTP, chamado pelo frontend do app. A arquitetura atual (ver
> [`docs/planejamento.md`](planejamento.md)) usa Supabase Edge Functions em vez de FastAPI — o
> webhook do Telegram vai direto para `telegram-ingest`, e o processamento roda via `pg_cron` +
> `process-receipts`, sem servidor HTTP dedicado. Este documento fica como referência caso o app
> UI volte a precisar de um backend HTTP próprio (por exemplo, para a análise semanal via Kimi).

FastAPI — as duas únicas rotas

## `POST /chat`

Endpoint principal de conversa. Aceita mensagens de texto e/ou imagem em base64 (recibo). Mantém
o histórico da conversa passado pelo cliente. Chama o Gemini para extração/categorização. Retorna
a resposta do agente e, quando uma despesa é confirmada, um JSON estruturado da despesa para
persistir.

## `POST /analyse`

Análise sob demanda ou agendada. Lê dados agregados de despesas do Supabase e envia ao Kimi K2
para detecção de padrões, sugestões de economia e resumo narrativo. Retorna um relatório em
markdown. Ver [`docs/automacoes-futuras.md`](automacoes-futuras.md) para o desenho completo do
fluxo de análise semanal que consumiria esta rota.
