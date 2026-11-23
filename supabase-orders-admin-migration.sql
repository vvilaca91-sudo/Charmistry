-- Executar no SQL Editor do Supabase como postgres.
-- Preserva orders.status e os dados existentes. As novas colunas separam
-- pagamento de preparação/envio. Não altera admin_users nem Storage.
--
-- Os estados antigos paid/refunded são reconhecidos explicitamente;
-- estados pendentes continuam pending e estados ambíguos ficam unknown.

begin;

-- Abort instead of silently classifying an unreviewed legacy value.
do $$
declare
  unexpected_statuses text[];
begin
  select array_agg(distinct status order by status)
  into unexpected_statuses
  from public.orders
  where status is null
    or status not in ('pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded');

  if unexpected_statuses is not null then
    raise exception 'Unexpected public.orders.status values; review before migration: %', unexpected_statuses;
  end if;
end
$$;

alter table public.orders
  add column if not exists payment_status text,
  add column if not exists fulfillment_status text;

do $$
begin
  if exists (
    select 1 from public.orders
    where payment_status is not null
      and payment_status not in ('pending', 'paid', 'failed', 'refunded', 'unknown')
  ) then
    raise exception 'Existing payment_status values fall outside the migration CHECK constraint.';
  end if;

  if exists (
    select 1 from public.orders
    where fulfillment_status is not null
      and fulfillment_status not in ('pending', 'processing', 'shipped', 'delivered', 'cancelled')
  ) then
    raise exception 'Existing fulfillment_status values fall outside the migration CHECK constraint.';
  end if;
end
$$;

update public.orders
set
  payment_status = coalesce(
    payment_status,
    case status
      when 'paid' then 'paid'
      when 'refunded' then 'refunded'
      when 'pending' then 'pending'
      else 'unknown'
    end
  ),
  fulfillment_status = coalesce(
    fulfillment_status,
    case status
      when 'processing' then 'processing'
      when 'shipped' then 'shipped'
      when 'delivered' then 'delivered'
      when 'cancelled' then 'cancelled'
      else 'pending'
    end
  )
where payment_status is null or fulfillment_status is null;

alter table public.orders
  alter column payment_status set default 'pending',
  alter column payment_status set not null,
  alter column fulfillment_status set default 'pending',
  alter column fulfillment_status set not null;

alter table public.orders
  drop constraint if exists orders_payment_status_check,
  add constraint orders_payment_status_check
    check (payment_status in ('pending', 'paid', 'failed', 'refunded', 'unknown')),
  drop constraint if exists orders_fulfillment_status_check,
  add constraint orders_fulfillment_status_check
    check (fulfillment_status in ('pending', 'processing', 'shipped', 'delivered', 'cancelled'));

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- Remove explicit legacy policy names, including those from the earlier setup.
drop policy if exists "Admins can view orders" on public.orders;
drop policy if exists "Admins can update orders" on public.orders;
drop policy if exists "Admins can view order items" on public.order_items;

-- Replace every policy on these two tables so no older permissive policy can
-- grant customer access and no stale restrictive policy can block admins.
do $$
declare
  existing_policy record;
begin
  for existing_policy in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('orders', 'order_items')
  loop
    execute format(
      'drop policy %I on %I.%I',
      existing_policy.policyname,
      existing_policy.schemaname,
      existing_policy.tablename
    );
  end loop;
end
$$;

-- Column-level grants survive a table-level REVOKE, so remove any old
-- per-column grants too. The authenticated client receives only SELECT and
-- UPDATE on fulfillment_status; it receives no order or item write access.
do $$
declare
  column_name text;
begin
  for column_name in
    select attname
    from pg_attribute
    where attrelid = 'public.orders'::regclass
      and attnum > 0
      and not attisdropped
  loop
    execute format(
      'revoke select (%1$I), insert (%1$I), update (%1$I), references (%1$I) on table public.orders from public, anon, authenticated, service_role',
      column_name
    );
  end loop;

  for column_name in
    select attname
    from pg_attribute
    where attrelid = 'public.order_items'::regclass
      and attnum > 0
      and not attisdropped
  loop
    execute format(
      'revoke select (%1$I), insert (%1$I), update (%1$I), references (%1$I) on table public.order_items from public, anon, authenticated, service_role',
      column_name
    );
  end loop;
end
$$;

revoke all privileges on table public.orders from public, anon, authenticated;
revoke all privileges on table public.order_items from public, anon, authenticated;
revoke all privileges on table public.orders from service_role;
revoke all privileges on table public.order_items from service_role;
grant select on table public.orders to authenticated;
grant update (fulfillment_status) on table public.orders to authenticated;
grant select on table public.order_items to authenticated;

-- Narrow service_role grants for the future server-side checkout/webhook:
-- create order and item snapshots, read the identifiers needed by the webhook,
-- and update payment_status only. Never expose this role's key to a browser.
grant select (id, payment_session_id, payment_status, total_cents)
  on table public.orders to service_role;
grant insert (
  customer_name, customer_email, customer_phone, shipping_address,
  shipping_postal_code, shipping_city, shipping_country,
  subtotal_cents, shipping_cents, total_cents, payment_session_id
) on table public.orders to service_role;
grant insert (order_id, product_id, product_name, unit_price_cents, quantity)
  on table public.order_items to service_role;
grant update (payment_status) on table public.orders to service_role;

-- Fail and roll back if inherited grants or unexpected role memberships leave
-- more access than the direct grants above. Such inherited ACLs must be
-- corrected at their source before this migration can safely complete.
do $$
declare
  column_row record;
  expected_select boolean;
  expected_insert boolean;
  expected_update boolean;
begin
  if has_table_privilege('authenticated', 'public.orders', 'INSERT')
    or has_table_privilege('authenticated', 'public.orders', 'DELETE')
    or has_table_privilege('authenticated', 'public.orders', 'TRUNCATE')
    or has_table_privilege('authenticated', 'public.orders', 'REFERENCES')
    or has_table_privilege('authenticated', 'public.orders', 'TRIGGER')
    or has_table_privilege('authenticated', 'public.order_items', 'INSERT')
    or has_table_privilege('authenticated', 'public.order_items', 'UPDATE')
    or has_table_privilege('authenticated', 'public.order_items', 'DELETE')
    or has_table_privilege('authenticated', 'public.order_items', 'TRUNCATE')
    or has_table_privilege('authenticated', 'public.order_items', 'REFERENCES')
    or has_table_privilege('authenticated', 'public.order_items', 'TRIGGER')
    or has_table_privilege('anon', 'public.orders', 'SELECT')
    or has_table_privilege('anon', 'public.orders', 'INSERT')
    or has_table_privilege('anon', 'public.orders', 'UPDATE')
    or has_table_privilege('anon', 'public.orders', 'DELETE')
    or has_table_privilege('anon', 'public.order_items', 'SELECT')
    or has_table_privilege('anon', 'public.order_items', 'INSERT')
    or has_table_privilege('anon', 'public.order_items', 'UPDATE')
    or has_table_privilege('anon', 'public.order_items', 'DELETE') then
    raise exception 'Unexpected table-level privileges remain for anon/authenticated on orders/order_items.';
  end if;

  for column_row in
    select attname
    from pg_attribute
    where attrelid = 'public.orders'::regclass
      and attnum > 0
      and not attisdropped
  loop
    if has_column_privilege('authenticated', 'public.orders', column_row.attname, 'UPDATE')
      <> (column_row.attname = 'fulfillment_status')
      or has_column_privilege('authenticated', 'public.orders', column_row.attname, 'INSERT')
      or has_column_privilege('authenticated', 'public.orders', column_row.attname, 'REFERENCES')
      or has_column_privilege('anon', 'public.orders', column_row.attname, 'SELECT')
      or has_column_privilege('anon', 'public.orders', column_row.attname, 'INSERT')
      or has_column_privilege('anon', 'public.orders', column_row.attname, 'UPDATE')
      or has_column_privilege('anon', 'public.orders', column_row.attname, 'REFERENCES') then
      raise exception 'Unexpected authenticated write privilege on public.orders.%', column_row.attname;
    end if;
  end loop;

  for column_row in
    select attname
    from pg_attribute
    where attrelid = 'public.order_items'::regclass
      and attnum > 0
      and not attisdropped
  loop
    if has_column_privilege('authenticated', 'public.order_items', column_row.attname, 'INSERT')
    or has_column_privilege('authenticated', 'public.order_items', column_row.attname, 'UPDATE')
    or has_column_privilege('authenticated', 'public.order_items', column_row.attname, 'REFERENCES')
    or has_column_privilege('anon', 'public.order_items', column_row.attname, 'SELECT')
    or has_column_privilege('anon', 'public.order_items', column_row.attname, 'INSERT')
    or has_column_privilege('anon', 'public.order_items', column_row.attname, 'UPDATE')
    or has_column_privilege('anon', 'public.order_items', column_row.attname, 'REFERENCES') then
    raise exception 'Unexpected authenticated write privilege on public.order_items.%', column_row.attname;
    end if;
  end loop;

  if has_table_privilege('service_role', 'public.orders', 'SELECT')
    or has_table_privilege('service_role', 'public.orders', 'INSERT')
    or has_table_privilege('service_role', 'public.orders', 'UPDATE')
    or has_table_privilege('service_role', 'public.orders', 'DELETE')
    or has_table_privilege('service_role', 'public.orders', 'TRUNCATE')
    or has_table_privilege('service_role', 'public.orders', 'REFERENCES')
    or has_table_privilege('service_role', 'public.orders', 'TRIGGER')
    or has_table_privilege('service_role', 'public.order_items', 'SELECT')
    or has_table_privilege('service_role', 'public.order_items', 'INSERT')
    or has_table_privilege('service_role', 'public.order_items', 'UPDATE')
    or has_table_privilege('service_role', 'public.order_items', 'DELETE')
    or has_table_privilege('service_role', 'public.order_items', 'TRUNCATE')
    or has_table_privilege('service_role', 'public.order_items', 'REFERENCES')
    or has_table_privilege('service_role', 'public.order_items', 'TRIGGER') then
    raise exception 'Unexpected table-level service_role privileges remain on orders/order_items.';
  end if;

  for column_row in
    select attname
    from pg_attribute
    where attrelid = 'public.orders'::regclass
      and attnum > 0
      and not attisdropped
  loop
    expected_select := column_row.attname in ('id', 'payment_session_id', 'payment_status', 'total_cents');
    expected_insert := column_row.attname in (
      'customer_name', 'customer_email', 'customer_phone', 'shipping_address',
      'shipping_postal_code', 'shipping_city', 'shipping_country',
      'subtotal_cents', 'shipping_cents', 'total_cents', 'payment_session_id'
    );
    expected_update := column_row.attname = 'payment_status';

    if has_column_privilege('service_role', 'public.orders', column_row.attname, 'SELECT') <> expected_select
      or has_column_privilege('service_role', 'public.orders', column_row.attname, 'INSERT') <> expected_insert
      or has_column_privilege('service_role', 'public.orders', column_row.attname, 'UPDATE') <> expected_update
      or has_column_privilege('service_role', 'public.orders', column_row.attname, 'REFERENCES') then
      raise exception 'Unexpected effective service_role privilege on public.orders.%', column_row.attname;
    end if;
  end loop;

  for column_row in
    select attname
    from pg_attribute
    where attrelid = 'public.order_items'::regclass
      and attnum > 0
      and not attisdropped
  loop
    expected_insert := column_row.attname in (
      'order_id', 'product_id', 'product_name', 'unit_price_cents', 'quantity'
    );
    if has_column_privilege('service_role', 'public.order_items', column_row.attname, 'SELECT')
      or has_column_privilege('service_role', 'public.order_items', column_row.attname, 'UPDATE')
      or has_column_privilege('service_role', 'public.order_items', column_row.attname, 'DELETE')
      or has_column_privilege('service_role', 'public.order_items', column_row.attname, 'INSERT') <> expected_insert
      or has_column_privilege('service_role', 'public.order_items', column_row.attname, 'REFERENCES') then
      raise exception 'Unexpected effective service_role privilege on public.order_items.%', column_row.attname;
    end if;
  end loop;
end
$$;

-- A permissive policy allows authorized operations; a restrictive policy
-- ensures any additional permissive policy cannot widen admin-only access.
create policy "Admins can read orders"
on public.orders
as permissive
for select
to authenticated
using (
  exists (
    select 1
    from public.admin_users
    where user_id = (select auth.uid())
  )
);

create policy "Admin-only order reads"
on public.orders
as restrictive
for select
to authenticated
using (
  exists (
    select 1
    from public.admin_users
    where user_id = (select auth.uid())
  )
);

create policy "Admins can update order fulfillment"
on public.orders
as permissive
for update
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

create policy "Admin-only order updates"
on public.orders
as restrictive
for update
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

create policy "Admins can read order items"
on public.order_items
as permissive
for select
to authenticated
using (
  exists (
    select 1
    from public.admin_users
    where user_id = (select auth.uid())
  )
);

create policy "Admin-only order item reads"
on public.order_items
as restrictive
for select
to authenticated
using (
  exists (
    select 1
    from public.admin_users
    where user_id = (select auth.uid())
  )
);

create or replace function public.set_orders_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_orders_updated_at on public.orders;
create trigger set_orders_updated_at
before update on public.orders
for each row
execute function public.set_orders_updated_at();

commit;
