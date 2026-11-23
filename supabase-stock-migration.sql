-- Charmistry stock reservations for the future trusted checkout/webhook.
-- Run in the Supabase SQL Editor as postgres only after reviewing.
-- Does not modify orders, order_items, payments, or existing product data.

begin;

create table if not exists public.product_stock_reservations (
  reservation_id uuid not null,
  product_id uuid not null
    references public.products (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'confirmed', 'released', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (reservation_id, product_id)
);

create index if not exists product_stock_reservations_active_by_product
  on public.product_stock_reservations (product_id, expires_at)
  where status = 'reserved';

alter table public.product_stock_reservations enable row level security;

do $$
declare
  existing_policy record;
begin
  for existing_policy in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'product_stock_reservations'
  loop
    execute format(
      'drop policy %I on public.product_stock_reservations',
      existing_policy.policyname
    );
  end loop;
end
$$;

revoke all privileges on table public.product_stock_reservations
  from public, anon, authenticated, service_role;

-- Public availability excludes temporary payment holds but never exposes
-- reservation IDs or customer/payment data.
create or replace function public.get_available_product_stock(p_product_ids uuid[])
returns table (product_id uuid, available_stock integer)
language sql
stable
security definer
set search_path = ''
as $$
  select
    product.id,
    greatest(
      product.stock::bigint - coalesce(sum(reservation.quantity), 0),
      0
    )::integer
  from public.products as product
  left join public.product_stock_reservations as reservation
    on reservation.product_id = product.id
    and reservation.status = 'reserved'
    and reservation.expires_at > now()
  where product.is_active
    and product.id = any(p_product_ids)
  group by product.id, product.stock;
$$;

-- A reservation reduces the stock available to other reservations without
-- changing products.stock. Only a confirmed payment decrements products.stock.
create or replace function public.reserve_product_stock(
  p_reservation_id uuid,
  p_items jsonb,
  p_ttl_seconds integer default 900
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested record;
  current_stock integer;
  reserved_quantity bigint;
  expires_at_value timestamptz;
  requested_count integer;
  distinct_product_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted server access required';
  end if;
  if p_reservation_id is null then
    raise exception 'Reservation ID is required';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'A non-empty product list is required';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'A non-empty product list is required';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 3600 then
    raise exception 'Reservation lifetime must be between 60 and 3600 seconds';
  end if;

  select count(*), count(distinct item.product_id)
  into requested_count, distinct_product_count
  from jsonb_to_recordset(p_items) as item(product_id uuid, quantity integer);

  if requested_count = 0 or requested_count <> distinct_product_count then
    raise exception 'Each product may appear only once in the reservation';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(product_id uuid, quantity integer)
    where item.product_id is null or item.quantity is null or item.quantity <= 0
  ) then
    raise exception 'Product IDs and positive integer quantities are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_reservation_id::text, 0));
  if exists (
    select 1
    from public.product_stock_reservations
    where reservation_id = p_reservation_id
  ) then
    raise exception 'Reservation ID has already been used';
  end if;

  -- Lock product rows in a stable order so competing reservations serialize.
  perform product.id
  from public.products as product
  join (
    select item.product_id
    from jsonb_to_recordset(p_items) as item(product_id uuid, quantity integer)
  ) as requested_products on requested_products.product_id = product.id
  order by product.id
  for update of product;

  if (
    select count(*)
    from public.products as product
    join (
      select item.product_id
      from jsonb_to_recordset(p_items) as item(product_id uuid, quantity integer)
    ) as requested_products on requested_products.product_id = product.id
    where product.is_active
  ) <> requested_count then
    raise exception 'One or more products do not exist or are inactive';
  end if;

  for requested in
    select item.product_id, item.quantity
    from jsonb_to_recordset(p_items) as item(product_id uuid, quantity integer)
    order by item.product_id
  loop
    select product.stock
    into current_stock
    from public.products as product
    where product.id = requested.product_id
      and product.is_active;

    select coalesce(sum(reservation.quantity), 0)
    into reserved_quantity
    from public.product_stock_reservations as reservation
    where reservation.product_id = requested.product_id
      and reservation.status = 'reserved'
      and reservation.expires_at > now();

    if current_stock::bigint - reserved_quantity < requested.quantity then
      raise exception 'Insufficient stock for product %: available %, requested %',
        requested.product_id,
        greatest(current_stock::bigint - reserved_quantity, 0),
        requested.quantity;
    end if;
  end loop;

  expires_at_value := now() + make_interval(secs => p_ttl_seconds);
  insert into public.product_stock_reservations (
    reservation_id, product_id, quantity, expires_at
  )
  select
    p_reservation_id,
    item.product_id,
    item.quantity,
    expires_at_value
  from jsonb_to_recordset(p_items) as item(product_id uuid, quantity integer);

  return expires_at_value;
end;
$$;

create or replace function public.confirm_product_stock(p_reservation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted server access required';
  end if;

  perform product.id
  from public.products as product
  join public.product_stock_reservations as reservation
    on reservation.product_id = product.id
  where reservation.reservation_id = p_reservation_id
  order by product.id
  for update of product;

  perform 1
  from public.product_stock_reservations
  where reservation_id = p_reservation_id
  for update;

  if not exists (
    select 1
    from public.product_stock_reservations
    where reservation_id = p_reservation_id
  ) then
    raise exception 'Reservation does not exist';
  end if;
  if exists (
    select 1
    from public.product_stock_reservations
    where reservation_id = p_reservation_id
      and status = 'confirmed'
  ) and not exists (
    select 1
    from public.product_stock_reservations
    where reservation_id = p_reservation_id
      and status <> 'confirmed'
  ) then
    return;
  end if;
  if exists (
    select 1
    from public.product_stock_reservations
    where reservation_id = p_reservation_id
      and (status <> 'reserved' or expires_at <= now())
  ) then
    raise exception 'Reservation is no longer active; do not capture or fulfill this payment';
  end if;

  update public.product_stock_reservations
  set status = 'confirmed', updated_at = now()
  where reservation_id = p_reservation_id;

  for reservation in
    select product_id, quantity
    from public.product_stock_reservations
    where reservation_id = p_reservation_id
    order by product_id
  loop
    update public.products
    set stock = stock - reservation.quantity
    where id = reservation.product_id
      and stock >= reservation.quantity;

    if not found then
      raise exception 'Stock changed before reservation % could be confirmed', p_reservation_id;
    end if;
  end loop;
end;
$$;

create or replace function public.release_product_stock(p_reservation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted server access required';
  end if;

  perform product.id
  from public.products as product
  join public.product_stock_reservations as reservation
    on reservation.product_id = product.id
  where reservation.reservation_id = p_reservation_id
  order by product.id
  for update of product;

  perform 1
  from public.product_stock_reservations
  where reservation_id = p_reservation_id
  for update;

  if not exists (
    select 1
    from public.product_stock_reservations
    where reservation_id = p_reservation_id
  ) then
    raise exception 'Reservation does not exist';
  end if;
  if exists (
    select 1
    from public.product_stock_reservations
    where reservation_id = p_reservation_id
      and status = 'confirmed'
  ) then
    raise exception 'Confirmed stock cannot be released as an unpaid reservation';
  end if;

  update public.product_stock_reservations
  set
    status = case when expires_at <= now() then 'expired' else 'released' end,
    updated_at = now()
  where reservation_id = p_reservation_id
    and status = 'reserved';
end;
$$;

-- Prevent the admin panel from reducing stock below outstanding reservations.
create or replace function public.prevent_stock_below_reservations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reserved_quantity bigint;
begin
  if new.stock < old.stock then
    select coalesce(sum(reservation.quantity), 0)
    into reserved_quantity
    from public.product_stock_reservations as reservation
    where reservation.product_id = new.id
      and reservation.status = 'reserved'
      and reservation.expires_at > now();

    if new.stock < reserved_quantity then
      raise exception 'Stock cannot be reduced below % units reserved for pending payments',
        reserved_quantity;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_stock_below_reservations on public.products;
create trigger prevent_stock_below_reservations
before update of stock on public.products
for each row
execute function public.prevent_stock_below_reservations();

revoke all on function public.reserve_product_stock(uuid, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.confirm_product_stock(uuid)
  from public, anon, authenticated;
revoke all on function public.release_product_stock(uuid)
  from public, anon, authenticated;
revoke all on function public.prevent_stock_below_reservations()
  from public, anon, authenticated, service_role;
revoke all on function public.get_available_product_stock(uuid[])
  from public, anon, authenticated, service_role;

grant execute on function public.reserve_product_stock(uuid, jsonb, integer)
  to service_role;
grant execute on function public.confirm_product_stock(uuid)
  to service_role;
grant execute on function public.release_product_stock(uuid)
  to service_role;
grant execute on function public.get_available_product_stock(uuid[])
  to anon, authenticated;

commit;
