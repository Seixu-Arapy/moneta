# Moneta

Personal finance management app. Current phase: pre-app groundwork — Supabase schema plus a Telegram ingestion bot so receipts can be registered manually before the app exists. The data model is defined by the ERD in `docs/pipeline-ia-recibos.md` and the migrations under `supabase/migrations/`.

## Conventions

- Commit messages in English.
- Code comments in English. Write comments only where they add lasting value to a future reader; never to narrate a change or answer a review/prompt.
- Variable, function, table, and column names in English.
- User-facing text (Telegram bot replies, future app UI) in Brazilian Portuguese.
- Documentation under `docs/` and setup guides may be written in Portuguese.

## Structure

- `supabase/migrations/` — SQL migrations, currently applied manually via the Supabase SQL Editor (see `supabase/README.md`).
- `supabase/functions/telegram-ingest/` — Edge Function: Telegram bot that ingests receipts into the `receipts` bucket and `pending_expenses`.
- `docs/` — architecture and pipeline design docs.

## Notes

- All tables have RLS enabled with no policies (access via service_role only) until the app has auth.
- The `receipts` bucket is private; store file paths in the DB, generate signed URLs on read.
- `expenses.category_id` intentionally has no FK yet — the constraint is added when the `categories` table is created.
