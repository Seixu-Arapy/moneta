# Planejamento & Status

## Status Geral (2026-09-11)

| Fase | Status | Progresso |
|------|--------|-----------|
| **Backend - Schema** | ✅ Completo | 100% |
| **Backend - Audit & Analytics** | ✅ Completo | 100% |
| **Backend - RPC Functions** | ✅ Completo | 100% |
| **Edge Functions - Ingestão** | ✅ Operacional | 100% |
| **Edge Functions - Processamento** | ✅ Operacional | 90% |
| **Integração com Categorias** | 🔄 Em Progresso | 70% |
| **Comandos Telegram (`/revisar`)** | 🔄 Em Progresso | 80% |
| **App UI** | 📋 Planejado | 0% |
| **Análise Semanal (Kimi)** | 📋 Planejado | 0% |

## Banco de Dados: ✅ COMPLETO

**Tabelas Principais** (5):
- ✅ `expenses` — despesas finalizadas
- ✅ `expense_items` — itens de recibo
- ✅ `pending_expenses` — fila de processamento
- ✅ `payment_methods` — formas de pagamento
- ✅ `categories` — categorias hierárquicas (10 raízes + 40 subcategorias)

**Tabelas de Auditoria** (2):
- ✅ `audit_log` — registro imutável de todas as mudanças
- ✅ `user_feedback` — correções do usuário no parse da IA

**Visualizações** (7) e **Funções RPC** (8) — ver
[`docs/database-schema.md`](database-schema.md) para a referência completa.

### Métricas Atuais (2026-09-11)

- 122+ despesas na fila (pending_expenses)
- 109+ despesas processadas com sucesso
- 50+ categorias pré-seeded
- Webhook do Telegram ativo

**Arquitetura**: Supabase Edge Functions (não FastAPI) — ver seção
[Arquitetura Decidida](#arquitetura-decidida-edge-functions-não-fastapi).

## Edge Functions: 🔄 EM INTEGRAÇÃO

### `telegram-ingest` (✅ Operacional)
- ✅ Valida secret token do webhook
- ✅ Comprime imagens em memória (JPEG q80, max 2000px)
- ✅ Upload no bucket `receipts`
- ✅ Insert em `pending_expenses`
- ✅ Apaga mensagem após sucesso
- ✅ Comandos: `/pendencias`, `/processar`, `/revisar`
- ✅ Q&A de duplicata (inline buttons)
- ✅ Tratamento de respostas do usuário
- ✅ Fluxo `/revisar`: ver nota, classificar por sugestão, corrigir valor, confirmar, descartar

**Próximo**: testar o fluxo `/revisar` end-to-end com recibos reais; revisar taxa de acerto das
sugestões de categoria via `category_effectiveness`.

### `process-receipts` (✅ Operacional, 90%)
- ✅ Busca `status='pending'` com budget-aware
- ✅ Download de imagem do bucket
- ✅ Chamada ao Gemini com schema estruturado
- ✅ Sugestão de categoria via `suggest_category_for_merchant()` aplicada quando a Gemini não
  escolhe uma (evita uma segunda chamada de IA por recibo)
- ✅ Detecção de duplicata (±3 dias, amount+date+merchant)
- ✅ Pergunta ao usuário se duplicata ou se `needs_detail=true`
- ✅ Insere expenses + expense_items
- ✅ Retry logic (até 3 tentativas)
- ✅ Budget tracking (200/dia free tier)
- ✅ Feedback via Telegram

**Próximo**: chamadas a `log_audit()` para rastreamento automático (hoje é manual); considerar
passar a lista de categorias sugeridas para dentro do próprio prompt da Gemini (feito só como
fallback pós-parse hoje).

### `notify-pending-review` (✅ Implementado)
- ✅ Roda diariamente via `pg_cron`
- ✅ Notifica o usuário sobre `pending_expenses` com mais de 1 dia sem revisão

## Arquitetura Decidida: Edge Functions (não FastAPI)

### Por Quê?
- ✅ Zero infraestrutura — tudo no Supabase
- ✅ Sem servidor separado para gerenciar
- ✅ Webhook do Telegram direto → Edge Function
- ✅ `pg_cron` agendado dentro do Supabase
- ✅ RPC functions para operações atômicas
- ✅ Custos baixos (free tier)
- ⚠️ Desvio: original era FastAPI + Vercel; Edge Functions é mais simples para essa escala

### Comparação com Planejamento Original

| Aspecto | Original (Planejado) | Atual (Edge Functions) |
|--------|-----|------|
| Backend | FastAPI (Render) | Supabase Edge Functions |
| Frontend | Vite.js (Vercel) | Ainda a fazer |
| Banco | Supabase | Supabase ✅ |
| Telegram | Webhook → DB → Bot | Webhook → Edge Function |
| Agendamento | Cron externo (APScheduler) | `pg_cron` + Edge Function |
| AI | Gemini + Kimi | Gemini (Kimi planejado p/ análise) |

Os endpoints e fluxos do plano original (FastAPI + Kimi) ficam documentados em
[`docs/api-endpoints-futuro.md`](api-endpoints-futuro.md) e
[`docs/automacoes-futuras.md`](automacoes-futuras.md) como referência, mesmo sem estarem
implementados na arquitetura atual.

**Resultado**: backend 100% funcional, integração de categorias em andamento. Frontend pendente.
Análise semanal (Kimi) planejada para depois.

## Próximas Prioridades

### 1. Fechar integração de categorias (em andamento)
- [x] Chamar `suggest_category_for_merchant()` em `process-receipts`
- [x] Incluir `category_id` + `category_confidence` no schema do Gemini
- [ ] Testar com 10+ recibos reais
- [ ] Revisar taxa de acertos via `category_effectiveness`

### 2. Fechar comandos Telegram de revisão (em andamento)
- [x] `/revisar` — lista pendências com inline buttons
- [x] Callback `classificar` — mostra sugestões de categoria
- [x] Callback `corrigir` — pede e aplica valor corrigido
- [ ] Testar o fluxo completo (ver → classificar → confirmar) em produção

### 3. Construir App UI (depois)
- [ ] Conectar aos RPC functions
- [ ] Dashboard com analytics views
- [ ] Lista de despesas com filtros
- [ ] Formulário de entrada manual
- [ ] Reclassificação em lote

### 4. Testes & Otimização
- [ ] Testar fluxo end-to-end com dados reais
- [ ] Auditar taxa de sucesso do Gemini
- [ ] Validar RLS policies com app auth
- [ ] Monitorar performance de queries

### 5. Análise Semanal (Depois)
- [ ] Integrar Kimi K2 para análise comportamental
- [ ] Tags de contexto (Lazer vs Trabalho no mesmo mercado)
- [ ] Alertas de orçamento
- [ ] Recomendações de cortes

## Riscos & Mitigações

| Risco | Probabilidade | Mitigação |
|-------|---------------|-----------|
| Gemini rate limit (free tier) | Média | Budget cap em 200/dia, retry logic implementado ✅ |
| Schema inadequado | Baixa | Audit + feedback tables garantem ajustes futuros ✅ |
| UI abandonment | Média | Core backend 100% funcional; UI é "nice to have" |
| Duplicatas mal detectadas | Baixa | User feedback loop captura erros e retreina ✅ |
| Categorização incorreta não revisada | Média | Fluxo `/revisar` + `category_effectiveness` para monitorar 🔄 |

## Dependências Externas

- ✅ Supabase (database + storage + edge functions)
- ✅ Gemini API (free tier, chave configurada)
- ✅ Telegram Bot (webhook ativo)
- 📋 App frontend (Vite.js, Vercel — ainda a fazer)
- 📋 Kimi K2 (análise semanal — planejado, não urgente)
