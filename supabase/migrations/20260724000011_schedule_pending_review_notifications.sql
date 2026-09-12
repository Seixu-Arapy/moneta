-- Schedule daily notification for pending review items.
-- Runs at 09:00 UTC every day to remind user about old pending_expenses.

-- Enable pg_cron extension if not already enabled
create extension if not exists pg_cron;

-- Schedule the notification job
-- cron expression: "0 9 * * *" = every day at 09:00 UTC
select
  cron.schedule(
    'notify-pending-review-daily',
    '0 9 * * *',
    $$
    select
      net.http_post(
        url := current_setting('app.supabase_url') || '/functions/v1/notify-pending-review',
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || current_setting('app.service_role_key'),
          'Content-Type',
          'application/json'
        ),
        body := '{}'::jsonb
      ) as request_id;
    $$
  );

comment on extension cron is 'pg_cron: scheduler for background jobs';
