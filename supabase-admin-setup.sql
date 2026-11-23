-- Executar no SQL Editor do Supabase. O painel usa Supabase Auth e esta lista
-- de permissões; nunca colocar uma chave service_role no código do navegador.

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
revoke all on table public.admin_users from anon, authenticated;
grant select on table public.admin_users to authenticated;

drop policy if exists "Admins can view their own access" on public.admin_users;
create policy "Admins can view their own access"
on public.admin_users
for select
to authenticated
using (user_id = (select auth.uid()));

grant select on table public.products to anon, authenticated;
grant insert, update, delete on table public.products to authenticated;

drop policy if exists "Admins can manage products" on public.products;
create policy "Admins can manage products"
on public.products
for all
to authenticated
using (
  exists (
    select 1
    from public.admin_users
    where user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.admin_users
    where user_id = (select auth.uid())
  )
);

create or replace function public.set_products_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_products_updated_at on public.products;
create trigger set_products_updated_at
before update on public.products
for each row
execute function public.set_products_updated_at();

-- Depois de criar a conta em Authentication > Users, adicionar o UUID do user:
-- insert into public.admin_users (user_id) values ('UUID-DA-CONTA-ADMIN');
