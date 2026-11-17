-- Gleam&Glow: galeria de até 5 imagens por produto.
-- Executar no SQL Editor do Supabase como postgres.
-- Não elimina ficheiros do Storage nem altera encomendas, pagamentos ou stock.

begin;

-- 1. Criar a tabela da galeria.
-- Mantém products.image_url para compatibilidade com o site atual.

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null
    references public.products(id) on delete cascade,
  image_url text not null,
  storage_path text,
  sort_order integer not null
    check (sort_order between 0 and 4),
  is_cover boolean not null default false,
  created_at timestamptz not null default now()
);

-- Impedir posições repetidas e mais de uma capa por produto.

create unique index if not exists
  product_images_product_sort_order_key
  on public.product_images(product_id, sort_order);

create unique index if not exists
  product_images_one_cover_per_product_key
  on public.product_images(product_id)
  where is_cover = true;

-- 2. Importar as imagens antigas sem duplicar galerias existentes.

insert into public.product_images (
  product_id,
  image_url,
  sort_order,
  is_cover
)
select
  p.id,
  p.image_url,
  0,
  true
from public.products p
where p.image_url is not null
  and not exists (
    select 1
    from public.product_images pi
    where pi.product_id = p.id
  );

-- Garantir uma capa para cada galeria que ainda não tenha nenhuma.

with chosen_images as (
  select distinct on (pi.product_id)
    pi.id
  from public.product_images pi
  where not exists (
    select 1
    from public.product_images cover
    where cover.product_id = pi.product_id
      and cover.is_cover = true
  )
  order by
    pi.product_id,
    pi.sort_order,
    pi.created_at,
    pi.id
)
update public.product_images pi
set is_cover = true
from chosen_images chosen
where pi.id = chosen.id;

-- Sincronizar a imagem de capa com a coluna antiga.

update public.products p
set image_url = pi.image_url
from public.product_images pi
where pi.product_id = p.id
  and pi.is_cover = true
  and p.image_url is distinct from pi.image_url;

-- 3. Permissões: leitura pública apenas para produtos ativos.
-- Escrita exclusivamente através das funções administrativas.

alter table public.product_images enable row level security;

revoke all privileges
on table public.product_images
from public, anon, authenticated;

grant select
on table public.product_images
to anon, authenticated;

drop policy if exists
  "Public can view images of active products"
  on public.product_images;

create policy "Public can view images of active products"
on public.product_images
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.products p
    where p.id = product_images.product_id
      and p.is_active = true
  )
);

drop policy if exists
  "Admins can view all product images"
  on public.product_images;

create policy "Admins can view all product images"
on public.product_images
for select
to authenticated
using (
  exists (
    select 1
    from public.admin_users au
    where au.user_id = (select auth.uid())
  )
);

-- 4. Limite de cinco imagens, também aplicado na base de dados.
-- O bloqueio do produto evita ultrapassar o limite em operações
-- concorrentes.

create or replace function public.enforce_product_image_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  image_count integer;
begin
  perform 1
  from public.products
  where id = new.product_id
  for update;

  if not found then
    raise exception 'Product % does not exist', new.product_id;
  end if;

  select count(*)
  into image_count
  from public.product_images
  where product_id = new.product_id
    and (tg_op = 'INSERT' or id <> new.id);

  if image_count >= 5 then
    raise exception 'A product cannot have more than five images';
  end if;

  return new;
end;
$$;

drop trigger if exists
  enforce_product_image_limit
  on public.product_images;

create trigger enforce_product_image_limit
before insert or update of product_id
on public.product_images
for each row
execute function public.enforce_product_image_limit();

-- 5. Adicionar uma imagem à galeria.
-- A primeira imagem passa automaticamente a ser a capa.

create or replace function public.add_product_image(
  p_product_id uuid,
  p_image_url text,
  p_storage_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  image_id uuid;
  next_order integer;
  make_cover boolean;
begin
  if (select auth.uid()) is null
     or not exists (
       select 1
       from public.admin_users au
       where au.user_id = (select auth.uid())
     )
  then
    raise exception 'Administrator access required';
  end if;

  if p_image_url is null or length(trim(p_image_url)) = 0 then
    raise exception 'Image URL is required';
  end if;

  perform 1
  from public.products
  where id = p_product_id
  for update;

  if not found then
    raise exception 'Product % does not exist', p_product_id;
  end if;

  select slots.candidate
  into next_order
  from generate_series(0, 4) as slots(candidate)
  where not exists (
    select 1
    from public.product_images pi
    where pi.product_id = p_product_id
      and pi.sort_order = slots.candidate
  )
  order by slots.candidate
  limit 1;

  if next_order is null then
    raise exception 'A product cannot have more than five images';
  end if;

  make_cover := not exists (
    select 1
    from public.product_images pi
    where pi.product_id = p_product_id
      and pi.is_cover = true
  );

  insert into public.product_images (
    product_id,
    image_url,
    storage_path,
    sort_order,
    is_cover
  )
  values (
    p_product_id,
    p_image_url,
    p_storage_path,
    next_order,
    make_cover
  )
  returning id into image_id;

  if make_cover then
    update public.products
    set image_url = p_image_url
    where id = p_product_id;
  end if;

  return image_id;
end;
$$;

-- 6. Escolher a capa de um produto.

create or replace function public.set_product_image_cover(
  p_image_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_product_id uuid;
  target_url text;
begin
  if (select auth.uid()) is null
     or not exists (
       select 1
       from public.admin_users au
       where au.user_id = (select auth.uid())
     )
  then
    raise exception 'Administrator access required';
  end if;

  select pi.product_id
  into target_product_id
  from public.product_images pi
  where pi.id = p_image_id;

  if not found then
    raise exception 'Product image % does not exist', p_image_id;
  end if;

  perform 1
  from public.products
  where id = target_product_id
  for update;

  select pi.image_url
  into target_url
  from public.product_images pi
  where pi.id = p_image_id
    and pi.product_id = target_product_id
  for update;

  if not found then
    raise exception 'Product image % does not exist', p_image_id;
  end if;

  update public.product_images
  set is_cover = false
  where product_id = target_product_id
    and is_cover = true;

  update public.product_images
  set is_cover = true
  where id = p_image_id;

  update public.products
  set image_url = target_url
  where id = target_product_id;
end;
$$;

-- 7. Eliminar uma imagem da galeria.
-- Se a capa for eliminada, escolhe outra automaticamente.
-- Se não restarem imagens, products.image_url passa a NULL.
-- O objeto físico do Storage nunca é eliminado por esta função.

create or replace function public.delete_product_image(
  p_image_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_product_id uuid;
  next_image_id uuid;
  next_image_url text;
begin
  if (select auth.uid()) is null
     or not exists (
       select 1
       from public.admin_users au
       where au.user_id = (select auth.uid())
     )
  then
    raise exception 'Administrator access required';
  end if;

  select pi.product_id
  into target_product_id
  from public.product_images pi
  where pi.id = p_image_id;

  if not found then
    raise exception 'Product image % does not exist', p_image_id;
  end if;

  perform 1
  from public.products
  where id = target_product_id
  for update;

  delete from public.product_images
  where id = p_image_id
    and product_id = target_product_id;

  if not found then
    raise exception 'Product image % does not exist', p_image_id;
  end if;

  select pi.id, pi.image_url
  into next_image_id, next_image_url
  from public.product_images pi
  where pi.product_id = target_product_id
  order by pi.is_cover desc, pi.sort_order, pi.created_at, pi.id
  limit 1;

  if next_image_id is not null then
    update public.product_images
    set is_cover = false
    where product_id = target_product_id
      and is_cover = true;

    update public.product_images
    set is_cover = true
    where id = next_image_id;
  end if;

  update public.products
  set image_url = next_image_url
  where id = target_product_id;
end;
$$;

-- 8. Restringir a execução das funções.
-- Apenas utilizadores autenticados podem chamar os RPCs;
-- cada função verifica adicionalmente se o utilizador é administrador.

revoke all on function
  public.add_product_image(uuid, text, text)
from public, anon, authenticated, service_role;

revoke all on function
  public.set_product_image_cover(uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.delete_product_image(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.add_product_image(uuid, text, text)
to authenticated;

grant execute on function
  public.set_product_image_cover(uuid)
to authenticated;

grant execute on function
  public.delete_product_image(uuid)
to authenticated;

commit;