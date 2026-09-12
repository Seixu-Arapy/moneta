-- Category suggestion function for intelligent auto-classification.
-- Uses user correction history, payment method patterns, and merchant name heuristics.

create or replace function public.suggest_category_for_merchant(
  p_merchant text,
  p_amount numeric default null,
  p_items jsonb default null,
  p_limit integer default 3
) returns table (
  category_id uuid,
  category_name text,
  confidence numeric
) language sql stable as $$
  select distinct on (cat_id)
    cat_id as category_id,
    cat_name as category_name,
    conf as confidence
  from (
    -- Strategy 1: User correction history (highest priority - confidence 0.95)
    select
      c.id as cat_id,
      c.name as cat_name,
      0.95::numeric as conf,
      1 as priority
    from public.user_feedback uf
    join public.pending_expenses pe on uf.pending_expense_id = pe.id
    join public.categories c on (uf.corrected_value->>'category_id')::uuid = c.id
    where pe.parsed_data->>'merchant' ilike '%' || lower(p_merchant) || '%'
      and uf.feedback_type = 'category_corrected'
    group by c.id, c.name

    union all

    -- Strategy 2: Similar amount + merchant (medium priority - confidence 0.75)
    select
      c.id,
      c.name,
      0.75::numeric,
      2
    from public.expenses e
    join public.categories c on e.category_id = c.id
    where p_amount is not null
      and e.amount between (p_amount * 0.8) and (p_amount * 1.2)
      and e.merchant ilike '%' || lower(p_merchant) || '%'
      and c.is_active = true
    group by c.id, c.name

    union all

    -- Strategy 3: Merchant name heuristics (lowest priority - confidence 0.60)
    select
      c.id,
      c.name,
      0.60::numeric,
      3
    from public.categories c
    where c.is_active = true
      and (
        (lower(p_merchant) like any(array['%mercado%', '%super%', '%food%', '%bakery%']) and c.slug in ('groceries', 'supermarket', 'food'))
        or (lower(p_merchant) like any(array['%restaurant%', '%cafe%', '%bar%', '%pizza%']) and c.slug in ('restaurants', 'dining', 'food'))
        or (lower(p_merchant) like any(array['%gas%', '%fuel%', '%parking%', '%metro%', '%uber%']) and c.slug in ('transportation', 'gas', 'transit'))
        or (lower(p_merchant) like any(array['%pharmacy%', '%hospital%', '%clinic%', '%doctor%']) and c.slug in ('health', 'medical', 'fitness'))
        or (lower(p_merchant) like any(array['%gym%', '%sport%', '%fitness%']) and c.slug in ('fitness', 'sports', 'health'))
        or (lower(p_merchant) like any(array['%netflix%', '%spotify%', '%cinema%', '%movie%']) and c.slug in ('entertainment', 'subscriptions'))
      )
  ) t
  order by cat_id, priority, conf desc
  limit p_limit;
$$;

comment on function public.suggest_category_for_merchant is 'Suggest categories for a merchant using: (1) user correction history, (2) amount matching, (3) merchant name heuristics. Returns up to 3 suggestions with confidence scores.';

-- Helper function to get top category predictions by merchant
create or replace function public.get_top_categories_by_merchant(
  p_merchant text,
  p_limit integer default 5
) returns table (
  category_id uuid,
  category_name text,
  usage_count bigint,
  last_used timestamptz
) language sql stable as $$
  select
    c.id,
    c.name,
    count(*) as usage_count,
    max(e.transaction_time) as last_used
  from public.expenses e
  join public.categories c on e.category_id = c.id
  where e.merchant ilike '%' || p_merchant || '%'
    and c.is_active = true
  group by c.id, c.name
  order by count(*) desc, max(e.transaction_time) desc
  limit p_limit;
$$;

comment on function public.get_top_categories_by_merchant is 'Fetch the top categories historically used with a merchant';
