-- Extend pending_expenses table with fields needed by process-receipts Edge Function.
-- Supports user Q&A loop, processing tracking, and retry logic.

alter table public.pending_expenses
add column if not exists telegram_chat_id text,
add column if not exists question_message_id bigint,
add column if not exists processed_at timestamptz;

-- Ensure attempts column exists (added in 20260723000001 but make sure it's there)
alter table public.pending_expenses
add column if not exists attempts integer not null default 0;

-- Add index for finding records that need processing today
create index if not exists pending_expenses_processed_at_idx on public.pending_expenses (processed_at);
create index if not exists pending_expenses_attempts_idx on public.pending_expenses (attempts);

-- Add index for finding unresolved user questions
create index if not exists pending_expenses_waiting_user_idx on public.pending_expenses (status) where status = 'waiting_user';

comment on column public.pending_expenses.telegram_chat_id is 'Chat ID for Telegram bot communication (user identification)';
comment on column public.pending_expenses.question_message_id is 'Message ID of the last question sent to user via Telegram (for context)';
comment on column public.pending_expenses.processed_at is 'Timestamp when this record was last processed (for budget tracking)';
comment on column public.pending_expenses.attempts is 'Number of processing attempts (incremented on failure, reset on success)';
