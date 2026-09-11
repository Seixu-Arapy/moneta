-- Bounded-retry counter: transient failures (network blips, temporary
-- Gemini errors) are retried automatically by the worker on the next run
-- instead of requiring a manual reset. status = 'error' is only set once
-- WORKER_MAX_ATTEMPTS consecutive failures are reached.
alter table public.pending_expenses
  add column attempts integer not null default 0;
