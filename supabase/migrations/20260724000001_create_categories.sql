-- Categories table with parent/child hierarchy for expense classification.
-- Enables unlimited nesting depth, self-referential constraint prevents loops.

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  description text,
  parent_id uuid references public.categories (id) on delete set null,
  color text,
  icon text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint category_no_self_reference check (parent_id != id)
);

create index categories_parent_id_idx on public.categories (parent_id);
create index categories_slug_idx on public.categories (slug);
create index categories_is_active_idx on public.categories (is_active);

comment on table public.categories is 'Hierarchical expense categories with optional parent for subcategories';
comment on column public.categories.name is 'Display name (e.g., "Groceries", "Housing")';
comment on column public.categories.slug is 'URL-friendly identifier (e.g., "groceries", "housing")';
comment on column public.categories.parent_id is 'Reference to parent category for subcategories (nullable)';
comment on column public.categories.color is 'Hex color or color name for UI display';
comment on column public.categories.icon is 'Emoji or icon identifier for UI';
comment on column public.categories.is_active is 'Soft-delete flag: only show active categories in UI';
comment on column public.categories.sort_order is 'Display order in UI (ascending)';

alter table public.categories enable row level security;

-- Recursive function to fetch full category hierarchy
create or replace function public.get_category_hierarchy(p_category_id uuid default null)
returns table (
  id uuid,
  name text,
  slug text,
  parent_id uuid,
  level int
) language sql stable as $$
  with recursive category_tree as (
    select
      c.id,
      c.name,
      c.slug,
      c.parent_id,
      0 as level
    from public.categories c
    where (p_category_id is null or c.id = p_category_id or c.parent_id = p_category_id)
      and c.is_active = true

    union all

    select
      c.id,
      c.name,
      c.slug,
      c.parent_id,
      ct.level + 1
    from public.categories c
    inner join category_tree ct on c.parent_id = ct.id
    where c.is_active = true
  )
  select * from category_tree;
$$;

comment on function public.get_category_hierarchy is 'Recursively fetch category tree starting from root or a specific category';
