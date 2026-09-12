-- Immutable audit log table for tracking all changes to financial data.
-- Enables debugging, compliance, and understanding how data evolved over time.

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  table_name text not null,
  record_id uuid not null,
  old_values jsonb,
  new_values jsonb,
  changed_fields text[],
  source text not null,
  user_id uuid,
  error_message text,
  metadata jsonb,
  created_at timestamptz not null default now(),

  constraint valid_action check (action in ('insert', 'update', 'delete', 'manual_review', 'reclassify', 'user_resolved', 'error_state'))
);

create index audit_log_record_id_table_name_idx on public.audit_log (record_id, table_name);
create index audit_log_created_at_idx on public.audit_log (created_at);
create index audit_log_action_idx on public.audit_log (action);
create index audit_log_source_idx on public.audit_log (source);
create index audit_log_table_name_idx on public.audit_log (table_name);

comment on table public.audit_log is 'Immutable log of all data changes. Used for debugging, compliance, and understanding data evolution.';
comment on column public.audit_log.action is 'Type of operation: insert, update, delete, manual_review, reclassify, user_resolved, error_state';
comment on column public.audit_log.table_name is 'Table affected: expenses, pending_expenses, categories, etc.';
comment on column public.audit_log.record_id is 'ID of the affected record';
comment on column public.audit_log.old_values is 'Values before the change (for updates/deletes)';
comment on column public.audit_log.new_values is 'Values after the change (for inserts/updates)';
comment on column public.audit_log.changed_fields is 'Array of field names that changed (for updates)';
comment on column public.audit_log.source is 'Origin of the change: ai_pipeline, user_manual, telegram_bot, api, etc.';
comment on column public.audit_log.user_id is 'User who triggered the change (null for automated actions)';
comment on column public.audit_log.error_message is 'Error details if the action failed or resulted in manual review';
comment on column public.audit_log.metadata is 'Context data: Gemini attempt #, duplicate alternatives, confidence scores, etc.';

alter table public.audit_log enable row level security;

-- RPC to insert audit log entries (service_role only via RLS policy later)
create or replace function public.log_audit(
  p_action text,
  p_table_name text,
  p_record_id uuid,
  p_old_values jsonb default null,
  p_new_values jsonb default null,
  p_changed_fields text[] default null,
  p_source text default 'api',
  p_user_id uuid default null,
  p_error_message text default null,
  p_metadata jsonb default null
) returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.audit_log (
    action, table_name, record_id, old_values, new_values, changed_fields,
    source, user_id, error_message, metadata
  ) values (
    p_action, p_table_name, p_record_id, p_old_values, p_new_values, p_changed_fields,
    p_source, p_user_id, p_error_message, p_metadata
  ) returning id into v_id;
  return v_id;
end;
$$;

comment on function public.log_audit is 'Insert an audit log entry. Called by Edge Functions to track changes.';
