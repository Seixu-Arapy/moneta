-- Support columns for the scheduled processing worker and the
-- ask-the-user loop through the Telegram bot.
--
-- pending_expenses.status values used by the pipeline:
--   'pending'      → waiting to be processed by the worker
--   'waiting_user' → worker asked a question via Telegram, awaiting answer
--   'done'         → resolved into expenses/expense_items
--   'discarded'    → confirmed duplicate, intentionally not registered
--   'error'        → processing failed; reason stored in parsed_data.error
alter table public.pending_expenses
  add column telegram_chat_id text,
  add column question_message_id bigint,
  add column processed_at timestamptz;

-- Matches bot replies (reply_to_message) back to the row that asked
create index pending_expenses_question_message_id_idx
  on public.pending_expenses (question_message_id);

-- Supports the worker's daily budget count
create index pending_expenses_processed_at_idx
  on public.pending_expenses (processed_at);
