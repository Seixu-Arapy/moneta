-- pending_expenses: raw input (text or image) awaiting resolution into expenses
create table public.pending_expenses (
  id uuid primary key default gen_random_uuid(),
  raw_input text,
  image_url text,
  parsed_data jsonb,
  needs_detail boolean not null default false,
  possible_duplicate_of jsonb,
  resolved_expense_id uuid references public.expenses (id),
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index pending_expenses_status_idx on public.pending_expenses (status);
create index pending_expenses_resolved_expense_id_idx on public.pending_expenses (resolved_expense_id);

alter table public.pending_expenses enable row level security;
