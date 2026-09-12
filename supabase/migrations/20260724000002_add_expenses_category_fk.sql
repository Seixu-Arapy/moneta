-- Add foreign key constraint to expenses.category_id now that categories table exists.
-- ON DELETE SET NULL allows category deletion without orphaning expenses.

alter table public.expenses
add constraint expenses_category_id_fk
foreign key (category_id) references public.categories (id) on delete set null;

comment on column public.expenses.category_id is 'References categories table (nullable). Allows category deletion without orphaning expenses.';
