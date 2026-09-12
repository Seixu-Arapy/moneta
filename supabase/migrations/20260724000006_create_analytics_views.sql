-- Analytics views for reporting and pipeline monitoring.
-- These views enable dashboards, debugging, and understanding system health.

-- Expense summary by category (used by dashboards)
create or replace view public.expense_summary_by_category as
select
  c.id as category_id,
  c.name as category_name,
  c.slug as category_slug,
  date_trunc('month', e.transaction_time) as month,
  count(*) as expense_count,
  sum(e.amount) as total_amount,
  avg(e.amount) as avg_amount,
  min(e.transaction_time) as first_expense,
  max(e.transaction_time) as last_expense
from public.expenses e
left join public.categories c on e.category_id = c.id
group by c.id, c.name, c.slug, date_trunc('month', e.transaction_time)
order by month desc, total_amount desc;

comment on view public.expense_summary_by_category is 'Aggregate expenses by category and month for dashboard charts';

-- Pending expenses queue health
create or replace view public.pending_expenses_status_summary as
select
  status,
  count(*) as count,
  min(created_at) as earliest_record,
  max(created_at) as latest_record,
  round(extract(epoch from (now() - min(created_at))) / 3600) as oldest_age_hours,
  round(extract(epoch from (now() - max(created_at))) / 3600) as newest_age_hours,
  avg(attempts) as avg_attempts
from public.pending_expenses
group by status
order by count desc;

comment on view public.pending_expenses_status_summary is 'Queue health: count by status, age in hours, retry attempts';

-- Processing performance metrics (last 30 days)
create or replace view public.processing_performance_metrics as
select
  count(*) as total_processed,
  count(*) filter (where status = 'done') as successful_resolutions,
  round(
    100.0 * count(*) filter (where status = 'done') / count(*)::numeric,
    2
  ) as success_rate_percent,
  count(*) filter (where status = 'error') as error_count,
  count(*) filter (where status = 'waiting_user') as awaiting_user,
  round(avg(attempts), 2) as avg_attempts_per_record,
  max(attempts) as max_attempts,
  count(distinct id) filter (where needs_detail = true) as needs_detail_count,
  count(distinct id) filter (where possible_duplicate_of is not null) as duplicate_detections
from public.pending_expenses
where created_at > now() - interval '30 days';

comment on view public.processing_performance_metrics is 'AI pipeline effectiveness: success rates, error counts, retry patterns';

-- Payment method usage
create or replace view public.payment_method_usage as
select
  pm.id,
  pm.name as payment_method,
  pm.type as payment_type,
  count(*) as usage_count,
  sum(e.amount) as total_amount,
  avg(e.amount) as avg_amount,
  max(e.transaction_time) as last_used,
  count(distinct date_trunc('month', e.transaction_time)) as months_active
from public.expenses e
left join public.payment_methods pm on e.payment_method_id = pm.id
group by pm.id, pm.name, pm.type
order by usage_count desc;

comment on view public.payment_method_usage is 'Which payment methods are used, how often, and recent activity';

-- Category auto-classification effectiveness
create or replace view public.category_effectiveness as
select
  c.id as category_id,
  c.name as category_name,
  c.slug,
  count(distinct e.id) filter (where e.source = 'ai_pipeline') as auto_classified,
  count(distinct uf.id) filter (where uf.feedback_type = 'category_corrected') as manual_corrections,
  round(
    100.0 * count(distinct uf.id) filter (where uf.feedback_type = 'category_corrected')
    / nullif(count(distinct e.id) filter (where e.source = 'ai_pipeline'), 0),
    2
  ) as correction_rate_percent
from public.categories c
left join public.expenses e on c.id = e.category_id
left join public.user_feedback uf on e.id = uf.pending_expense_id
where c.is_active = true
group by c.id, c.name, c.slug
having count(distinct e.id) > 0
order by auto_classified desc;

comment on view public.category_effectiveness is 'Which categories AI classifies well vs. which need manual correction';

-- Duplicate detection system health
create or replace view public.duplicate_detection_log as
select
  date_trunc('day', p.created_at)::date as date,
  count(*) filter (where p.possible_duplicate_of is not null) as duplicates_flagged,
  count(*) filter (where p.status = 'done' and p.possible_duplicate_of is not null) as confirmed_duplicates,
  count(*) filter (where p.status = 'discarded' and p.possible_duplicate_of is not null) as rejected_as_duplicate,
  round(
    100.0 * count(*) filter (where p.status = 'discarded' and p.possible_duplicate_of is not null)
    / nullif(count(*) filter (where p.possible_duplicate_of is not null), 0),
    2
  ) as discard_rate_percent
from public.pending_expenses p
where p.created_at > now() - interval '90 days'
group by date_trunc('day', p.created_at)
order by date desc;

comment on view public.duplicate_detection_log is 'Duplicate detection system health: flagged, confirmed, rejected over time';

-- Audit trail summary (who changed what, when)
create or replace view public.audit_summary as
select
  date_trunc('day', al.created_at)::date as date,
  al.source,
  al.action,
  al.table_name,
  count(*) as changes,
  count(distinct al.record_id) as unique_records,
  count(distinct al.user_id) as unique_users
from public.audit_log al
group by date_trunc('day', al.created_at), al.source, al.action, al.table_name
order by date desc, changes desc;

comment on view public.audit_summary is 'Changes by date, source, action type for compliance and debugging';
