-- Update resolve_pending_expense RPC to support category_id insertion.
-- Allows Gemini-predicted categories to be saved directly.

create or replace function public.resolve_pending_expense(
  p_pending_id uuid,
  p_expense jsonb,
  p_items jsonb
) returns uuid
language plpgsql
security definer
as $$
declare
  v_expense_id uuid;
begin
  insert into public.expenses (transaction_time, merchant, amount, currency, category_id, source, notes)
  values (
    coalesce((p_expense->>'transaction_time')::timestamptz, now()),
    p_expense->>'merchant',
    (p_expense->>'amount')::numeric,
    coalesce(p_expense->>'currency', 'BRL'),
    (p_expense->>'category_id')::uuid,
    coalesce(p_expense->>'source', 'ai_pipeline'),
    p_expense->>'notes'
  )
  returning id into v_expense_id;

  insert into public.expense_items (expense_id, description, quantity, unit_price, total)
  select v_expense_id,
         item->>'description',
         (item->>'quantity')::numeric,
         (item->>'unit_price')::numeric,
         (item->>'total')::numeric
  from jsonb_array_elements(p_items) as item;

  update public.pending_expenses
  set status = 'done',
      resolved_expense_id = v_expense_id,
      parsed_data = p_expense || jsonb_build_object('items', p_items)
  where id = p_pending_id;

  return v_expense_id;
end;
$$;

comment on function public.resolve_pending_expense is 'Atomically create expense + items from parsed data and mark pending as done. Handles category_id from Gemini prediction.';
