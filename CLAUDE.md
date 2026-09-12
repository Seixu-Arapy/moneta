# Moneta

Personal finance management app. **Current phase: backend complete** — Full Supabase schema with categories, audit logging, and analytics. Telegram ingestion bot functional (122+ pending receipts, 109+ processed expenses). Ready for Edge Function enhancements and app UI. The data model is defined by the ERD in `docs/pipeline-ia-recibos.md` and the migrations under `supabase/migrations/`.

## Conventions

- Commit messages in English.
- Code comments in English. Write comments only where they add lasting value to a future reader; never to narrate a change or answer a review/prompt.
- Variable, function, table, and column names in English.
- User-facing text (Telegram bot replies, future app UI) in Brazilian Portuguese.
- Documentation under `docs/` and setup guides may be written in Portuguese.

## Structure

### Database (`supabase/migrations/`)
- **Core tables**:
  - `expenses` — resolved expense records with merchant, amount, category, payment method
  - `expense_items` — line items within each expense (from receipt parsing)
  - `pending_expenses` — raw receipts (image + text) awaiting AI processing or user confirmation
  - `payment_methods` — registered payment methods (cards, accounts)
  - `categories` — hierarchical expense categories (root + subcategories)

- **Audit & Learning**:
  - `audit_log` — immutable log of all data changes (insert/update/delete/reclassify)
  - `user_feedback` — user corrections and feedback on AI predictions (for learning)

- **Analytics Views** (7 pre-built):
  - `expense_summary_by_category` — spending by category & month
  - `pending_expenses_status_summary` — queue health metrics
  - `processing_performance_metrics` — AI pipeline success rates
  - `payment_method_usage` — payment method frequency & totals
  - `category_effectiveness` — which categories need manual correction
  - `duplicate_detection_log` — false positive/negative analysis
  - `audit_summary` — change tracking by source & type

- **RPC Functions** (8 total):
  - `resolve_pending_expense()` — atomic expense + items insert (existing)
  - `create_manual_expense()` — create expense from app UI
  - `reclassify_expense()` — update category + audit
  - `resolve_pending_with_feedback()` — resolve with user corrections
  - `bulk_update_pending_expenses()` — batch process error queue
  - `suggest_category_for_merchant()` — AI-assisted category prediction
  - `get_top_categories_by_merchant()` — historical category lookup
  - `log_audit()` — insert audit trail entries

### Edge Functions
- `supabase/functions/telegram-ingest/` — Telegram bot: receives receipts (photo + text), compresses images, uploads to bucket, creates `pending_expenses` entries, handles user Q&A (duplicate confirmation, detail requests, category selection via inline buttons)
- `supabase/functions/process-receipts/` — Scheduled worker (pg_cron): fetches pending receipts, calls Gemini for parsing, detects duplicates, asks user for confirmation if needed, atomically resolves via RPC, respects free-tier rate limits & daily budget

### Documentation
- `docs/pipeline-ia-recibos.md` — Architecture and design decisions
- `supabase/README.md` — Migration setup guide
- `supabase/functions/telegram-ingest/README.md` — Telegram bot setup (token, webhook, secrets)
- `supabase/functions/process-receipts/README.md` — Worker setup and scheduling

## Database Design Notes

### Security & Access Control
- All tables have RLS enabled with no policies — access via `service_role` key only (Edge Functions)
- The `receipts` bucket is private; file paths stored in DB, signed URLs generated on read
- `expenses.category_id` now has a proper FK constraint to `categories.category_id` (ON DELETE SET NULL)
- Audit log is append-only (no updates/deletes) for compliance & debugging

### Category System
- **Hierarchical**: 10 root categories (Housing, Food, Transportation, etc.) with 40+ subcategories
- **Pre-seeded**: All categories shipped with the schema (fast Gemini prompts, no DB queries needed)
- **Auto-suggestion**: `suggest_category_for_merchant()` uses: (1) user correction history → 0.95 confidence, (2) amount matching → 0.75, (3) merchant name regex → 0.60
- **Learning**: User feedback stored in `user_feedback` table, linked to audit log for traceability

### Processing Pipeline
- **Ingestion** (telegram-ingest): Validates webhook secret, compresses images in memory (JPEG q80, max 2000px), uploads to bucket, inserts `pending_expenses` row before any AI call (fail-safe)
- **Processing** (process-receipts): Batched (2 receipts/run), budget-capped (200/day free tier), retries up to 3x for transient failures, only after max attempts does row become `status='error'`
- **Duplicate detection**: ±3 day window, fuzzy match on (amount, transaction_time, merchant), asks user to confirm before discarding
- **User Q&A loop**: `needs_detail=true` or duplicate question → status='waiting_user', Telegram sends message, user responds via keyboard or reply, bot reclassifies and re-enqueues

### Audit Trail
- Every data change logged: who/what/when/why (via `log_audit()` RPC or Edge Functions)
- `source` field distinguishes: `ai_pipeline` vs `user_manual` vs `telegram_bot` vs `api`
- `metadata` JSONB captures context (Gemini attempt #, confidence scores, duplicate candidates)
- User corrections in `user_feedback` linked back to audit entries for model training

### Next Steps (Phase 4)
- [ ] Update `process-receipts` to call `suggest_category_for_merchant()` and pass predictions to Gemini
- [ ] Update `telegram-ingest` with `/classify` and `/review` commands for manual category selection
- [ ] Wire up `log_audit()` calls from Edge Functions (currently manual, should be automatic)
- [ ] Add RLS policies for future app auth (read own expenses, write via approved functions only)
- [ ] Build app UI to consume the RPC functions and analytics views
