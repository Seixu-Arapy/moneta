-- expenses: the definitive expense record
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  transaction_time timestamptz not null,
  merchant text,
  amount numeric not null,
  currency text not null default 'BRL',
  original_amount numeric,
  original_currency text,
  source text,
  notes text,
  installment_number integer,
  installments_total integer,
  is_gift boolean not null default false,
  payment_method_id uuid references public.payment_methods (id),
  -- FK to categories will be added once the categories table exists
  category_id uuid,
  created_at timestamptz not null default now()
);

create index expenses_transaction_time_idx on public.expenses (transaction_time);
create index expenses_payment_method_id_idx on public.expenses (payment_method_id);
create index expenses_category_id_idx on public.expenses (category_id);

alter table public.expenses enable row level security;

-- expense_items: line items of an expense's receipt
create table public.expense_items (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses (id) on delete cascade,
  description text not null,
  quantity numeric,
  unit_price numeric,
  total numeric
);

create index expense_items_expense_id_idx on public.expense_items (expense_id);

alter table public.expense_items enable row level security;
