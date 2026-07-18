-- payment_methods: cartões, contas e outros meios de pagamento
create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text,
  bank text,
  last_four text,
  active boolean not null default true
);

alter table public.payment_methods enable row level security;
