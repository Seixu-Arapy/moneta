-- Atomically resolves a pending expense: inserts the expense and its items
-- and marks the pending row as done — all in a single transaction.
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
  insert into public.expenses (transaction_time, merchant, amount, currency, source, notes)
  values (
    coalesce((p_expense->>'transaction_time')::timestamptz, now()),
    p_expense->>'merchant',
    (p_expense->>'amount')::numeric,
    coalesce(p_expense->>'currency', 'BRL'),
    'ai_pipeline',
    p_expense->>'notes'
  )
  returning id into v_expense_id;

  insert into public.expense_items (expense_id, description, quantity, unit_price, total)
  select v_expense_id,
         item->>'description',
         (item->>'quantity')::numeric,
         (item->>'unit_price')::numeric,
         (item->>'total')::numeric
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as item;

  update public.pending_expenses
  set status = 'done',
      resolved_expense_id = v_expense_id,
      parsed_data = p_expense || jsonb_build_object('items', p_items)
  where id = p_pending_id;

  return v_expense_id;
end;
$$;
