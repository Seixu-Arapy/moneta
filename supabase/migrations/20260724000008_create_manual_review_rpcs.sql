-- Phase 3: Manual review and classification RPC functions
-- These functions enable users (via Telegram or future UI) to correct AI parsing and categorization

-- RPC: Create manual expense (for app UI)
create or replace function public.create_manual_expense(
  p_transaction_time timestamptz,
  p_merchant text,
  p_amount numeric,
  p_currency text,
  p_category_id uuid,
  p_payment_method_id uuid default null,
  p_items jsonb default null,
  p_notes text default null,
  p_source text default 'user_manual'
) returns uuid language plpgsql as $$
declare
  v_expense_id uuid;
  v_audit_id uuid;
begin
  -- Insert expense
  insert into public.expenses (
    transaction_time, merchant, amount, currency, category_id, payment_method_id, source, notes
  ) values (
    p_transaction_time, p_merchant, p_amount, p_currency, p_category_id, p_payment_method_id, p_source, p_notes
  ) returning id into v_expense_id;

  -- Insert items if provided
  if p_items is not null and jsonb_array_length(p_items) > 0 then
    insert into public.expense_items (expense_id, description, quantity, unit_price, total)
    select
      v_expense_id,
      item->>'description',
      (item->>'quantity')::numeric,
      (item->>'unit_price')::numeric,
      (item->>'total')::numeric
    from jsonb_array_elements(p_items) as item;
  end if;

  -- Log the action
  v_audit_id := public.log_audit(
    p_action := 'insert',
    p_table_name := 'expenses',
    p_record_id := v_expense_id,
    p_new_values := jsonb_build_object(
      'merchant', p_merchant,
      'amount', p_amount,
      'currency', p_currency,
      'category_id', p_category_id,
      'source', p_source
    ),
    p_source := p_source
  );

  return v_expense_id;
end;
$$;

comment on function public.create_manual_expense is 'Create a new expense manually (from app UI or user input). Returns the new expense ID.';

-- RPC: Reclassify an expense
create or replace function public.reclassify_expense(
  p_expense_id uuid,
  p_new_category_id uuid,
  p_notes text default null,
  p_source text default 'user_manual'
) returns void language plpgsql as $$
declare
  v_old_category_id uuid;
  v_audit_id uuid;
begin
  -- Get old category
  select category_id into v_old_category_id from public.expenses where id = p_expense_id;

  if v_old_category_id is null and not found then
    raise exception 'Expense % not found', p_expense_id;
  end if;

  -- Update category
  update public.expenses
  set category_id = p_new_category_id, updated_at = now()
  where id = p_expense_id;

  -- Log the change
  v_audit_id := public.log_audit(
    p_action := 'reclassify',
    p_table_name := 'expenses',
    p_record_id := p_expense_id,
    p_old_values := jsonb_build_object('category_id', v_old_category_id),
    p_new_values := jsonb_build_object('category_id', p_new_category_id),
    p_changed_fields := array['category_id'],
    p_source := p_source,
    p_metadata := jsonb_build_object('notes', p_notes)
  );
end;
$$;

comment on function public.reclassify_expense is 'Change the category of an existing expense and log the change for audit trail.';

-- RPC: Resolve pending expense with user feedback
create or replace function public.resolve_pending_with_feedback(
  p_pending_id uuid,
  p_category_id uuid default null,
  p_merchant text default null,
  p_corrected_fields jsonb default '{}'::jsonb,
  p_notes text default null
) returns uuid language plpgsql as $$
declare
  v_pending_expense record;
  v_expense_id uuid;
  v_i jsonb;
  v_feedback_id uuid;
begin
  -- Fetch pending expense
  select * into v_pending_expense from public.pending_expenses where id = p_pending_id;
  if not found then
    raise exception 'Pending expense % not found', p_pending_id;
  end if;

  -- Build expense data (use corrected values if provided)
  v_i := v_pending_expense.parsed_data || p_corrected_fields;
  if p_merchant is not null then
    v_i := v_i || jsonb_build_object('merchant', p_merchant);
  end if;

  -- Resolve using existing RPC
  v_expense_id := public.resolve_pending_expense(
    p_pending_id := p_pending_id,
    p_expense := v_i - 'items',
    p_items := v_i->'items'
  );

  -- If category was corrected separately, update it
  if p_category_id is not null then
    update public.expenses set category_id = p_category_id where id = v_expense_id;
  end if;

  -- Create user feedback entry for each correction
  if p_corrected_fields != '{}'::jsonb then
    for v_i in select * from jsonb_each(p_corrected_fields) loop
      insert into public.user_feedback (
        pending_expense_id,
        feedback_type,
        old_value,
        corrected_value,
        notes,
        telegram_chat_id,
        linked_audit_log_id
      ) values (
        p_pending_id,
        case v_i.key
          when 'category_id' then 'category_corrected'
          when 'needs_detail' then 'needs_detail_provided'
          else 'manual_entry'
        end,
        v_pending_expense.parsed_data -> v_i.key,
        v_i.value,
        p_notes,
        v_pending_expense.telegram_chat_id,
        null
      );
    end loop;
  end if;

  return v_expense_id;
end;
$$;

comment on function public.resolve_pending_with_feedback is 'Resolve a pending expense with user-provided corrections. Captures feedback for learning.';

-- RPC: Bulk update pending expenses (for admin batch processing)
create or replace function public.bulk_update_pending_expenses(
  p_updates jsonb
) returns table (
  updated_id uuid,
  success boolean,
  error_message text
) language plpgsql as $$
declare
  v_update jsonb;
  v_expense_id uuid;
  v_category_id uuid;
  v_new_status text;
  v_notes text;
  v_error_msg text;
begin
  for v_update in select * from jsonb_array_elements(p_updates) loop
    begin
      v_expense_id := (v_update->>'id')::uuid;
      v_category_id := (v_update->>'category_id')::uuid;
      v_new_status := v_update->>'status';
      v_notes := v_update->>'notes';

      -- Reclassify if category provided
      if v_category_id is not null then
        perform public.reclassify_expense(
          v_expense_id, v_category_id, v_notes, 'admin_bulk'
        );
      end if;

      -- Update status if provided (e.g., 'discarded', 'done')
      if v_new_status is not null then
        update public.pending_expenses
        set status = v_new_status
        where id = v_expense_id;
      end if;

      return query select v_expense_id, true::boolean, null::text;
    exception when others then
      v_error_msg := sqlerrm;
      return query select v_expense_id, false::boolean, v_error_msg::text;
    end;
  end loop;
end;
$$;

comment on function public.bulk_update_pending_expenses is 'Batch update multiple pending expenses. Returns per-row success/error.';
