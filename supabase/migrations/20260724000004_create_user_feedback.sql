-- User feedback table for capturing corrections and learning from them.
-- Separate from pending_expenses: allows feedback to accumulate independent of resolution.

create table public.user_feedback (
  id uuid primary key default gen_random_uuid(),
  pending_expense_id uuid not null references public.pending_expenses (id) on delete cascade,
  feedback_type text not null,
  old_value jsonb,
  corrected_value jsonb not null,
  telegram_message_id bigint,
  telegram_chat_id text,
  confidence_score numeric,
  notes text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  linked_audit_log_id uuid references public.audit_log (id),

  constraint valid_feedback_type check (feedback_type in (
    'duplicate_corrected',
    'category_corrected',
    'needs_detail_provided',
    'rejected',
    'manual_entry'
  ))
);

create index user_feedback_pending_expense_id_idx on public.user_feedback (pending_expense_id);
create index user_feedback_feedback_type_idx on public.user_feedback (feedback_type);
create index user_feedback_created_at_idx on public.user_feedback (created_at);
create index user_feedback_resolved_at_idx on public.user_feedback (resolved_at);
create index user_feedback_unresolved_idx on public.user_feedback (resolved_at) where resolved_at is null;

comment on table public.user_feedback is 'User corrections and feedback on AI-parsed data. Used for learning and improving predictions.';
comment on column public.user_feedback.pending_expense_id is 'Link to the pending_expenses record being corrected';
comment on column public.user_feedback.feedback_type is 'Type of feedback: duplicate_corrected, category_corrected, needs_detail_provided, rejected, manual_entry';
comment on column public.user_feedback.old_value is 'What the AI predicted or system had before correction';
comment on column public.user_feedback.corrected_value is 'What the user provided as the correct value';
comment on column public.user_feedback.telegram_message_id is 'Link to Telegram message for context traceability';
comment on column public.user_feedback.telegram_chat_id is 'User''s Telegram chat ID for context';
comment on column public.user_feedback.confidence_score is 'AI confidence in its prediction (0-1), if available';
comment on column public.user_feedback.notes is 'User''s explanation or reasoning for the correction';
comment on column public.user_feedback.resolved_at is 'When the feedback was actioned (null = pending review)';
comment on column public.user_feedback.linked_audit_log_id is 'Reference to the audit_log entry when feedback was applied';

alter table public.user_feedback enable row level security;
