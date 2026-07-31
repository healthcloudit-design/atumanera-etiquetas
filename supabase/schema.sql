-- =============================================================================
-- PRAXIS PERSONALIZA — Schema multitenant (Supabase / Postgres)
-- =============================================================================
-- SaaS de ecommerce para productos personalizables. Cada comercio es un `tenant`.
-- "A Tu Manera Gráfica" es solo uno de los tenants.
--
-- Este archivo es IDEMPOTENTE: se puede correr entero varias veces sin romper
-- datos existentes (usa `if not exists`, `on conflict do nothing`,
-- `drop policy if exists` antes de cada `create policy`).
--
-- SEGURIDAD: la app server-side usa la service_role key (bypassa RLS). El
-- aislamiento entre tenants se hace: (1) en el código, acotando SIEMPRE por
-- tenant_id, y (2) resolviendo el tenant desde el host/login, nunca desde un
-- header que mande el cliente. Las políticas RLS de abajo son la segunda línea
-- de defensa para el día que se exponga la anon key al browser.
-- =============================================================================

-- ── TENANTS / COMERCIOS ──────────────────────────────────────────────────────
create table if not exists tenants (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text unique not null,
  name                  text not null,
  logo_url              text,
  primary_color         text default '#00AEEF',
  secondary_color       text default '#EC008C',
  mp_public_key         text,           -- public key de Mercado Pago del tenant
  andreani_contract     text,
  default_shipping_cost integer default 0,   -- centavos ARS
  active                boolean default true,
  created_at            timestamptz default now()
);

insert into tenants (slug, name, primary_color, secondary_color)
values ('atumanera', 'A Tu Manera Gráfica', '#00AEEF', '#EC008C')
on conflict (slug) do nothing;

-- ── PRODUCTOS ────────────────────────────────────────────────────────────────
create table if not exists products (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  name             text not null,
  slug             text not null,       -- único POR tenant (ver índice abajo)
  category         text not null,
  price            integer not null,    -- centavos ARS (1590000 = $15.900)
  units_per_set    integer not null,
  unit_label       text not null default 'unidades',
  material         text,
  size_description text,
  elaboration_days text,
  notes            text,
  active           boolean default true,
  created_at       timestamptz default now()
);

-- ── PEDIDOS ──────────────────────────────────────────────────────────────────
create table if not exists orders (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  order_number     serial unique not null,
  buyer_name       text not null,
  buyer_email      text not null,
  buyer_phone      text,
  shipping_method  text not null default 'andreani',  -- 'andreani' | 'retiro'
  shipping_address text,
  shipping_city    text,
  shipping_zip     text,
  shipping_province text,
  shipping_cost    integer default 0,   -- centavos ARS
  tracking_number  text,
  mp_preference_id text,
  mp_payment_id    text,
  mp_status        text,                -- pending | approved | rejected
  total            integer not null,    -- centavos ARS
  status           text not null default 'pending_payment',
  -- pending_payment | paid | in_production | shipped | delivered | cancelled
  notes            text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- ── ITEMS DE PEDIDO (con datos del diseño personalizado) ─────────────────────
create table if not exists order_items (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid references orders(id) on delete cascade,
  product_id           uuid references products(id),
  product_slug         text,
  product_name         text not null,
  design_text          text not null,
  design_font          text not null,
  design_text_color    text default '#1A1A1A',
  design_icon_index    integer,
  design_position      text default 'left',
  design_border_color  text,
  design_pulsera_color text,
  quantity             integer not null default 1,
  units_total          integer not null,
  unit_price           integer not null,   -- centavos ARS
  subtotal             integer not null,   -- centavos ARS
  design_thumbnail_url text,               -- ver nota de escalabilidad abajo
  created_at           timestamptz default now()
);

-- NOTA DE ESCALABILIDAD (design_thumbnail_url):
-- Hoy guarda la miniatura como data-URI base64 (hasta ~250KB por item) dentro de
-- la fila. Esto infla la tabla y las respuestas del dashboard. El objetivo es
-- subir la imagen al bucket privado `designs` y guardar acá solo la ruta,
-- sirviéndola con URL firmada. (Pendiente Fase 2.)

-- ── COMPATIBILIDAD CON BASES EXISTENTES (idempotente) ────────────────────────
alter table products    add column if not exists tenant_id uuid references tenants(id) on delete cascade;
alter table orders      add column if not exists tenant_id uuid references tenants(id) on delete cascade;
alter table order_items add column if not exists product_slug text;

update products set tenant_id = (select id from tenants where slug='atumanera') where tenant_id is null;
update orders   set tenant_id = (select id from tenants where slug='atumanera') where tenant_id is null;

alter table products alter column tenant_id set not null;
alter table orders   alter column tenant_id set not null;

-- El slug es único POR tenant, no globalmente (se quita el unique global viejo).
alter table products drop constraint if exists products_slug_key;
create unique index if not exists products_tenant_slug_idx on products(tenant_id, slug);
create index        if not exists orders_tenant_created_idx on orders(tenant_id, created_at desc);
create index        if not exists order_items_order_idx     on order_items(order_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table tenants     enable row level security;
alter table products    enable row level security;
alter table orders      enable row level security;
alter table order_items enable row level security;

-- Lectura pública de tenants y productos activos
drop policy if exists "tenants_public_read" on tenants;
create policy "tenants_public_read" on tenants for select using (active = true);

drop policy if exists "products_public_read" on products;
create policy "products_public_read" on products for select using (active = true);

-- Pedidos: lectura del propio comprador (por email en el JWT) o admin
drop policy if exists "orders_read_own" on orders;
create policy "orders_read_own" on orders for select using (
  auth.jwt() ->> 'email' = buyer_email
  or auth.jwt() ->> 'role' = 'admin'
);

-- Admin puede todo (rol en el JWT). El alta de pedidos la hace la app con la
-- service_role key; NO existe política de insert público (se removió por seguridad).
drop policy if exists "orders_admin_all" on orders;
create policy "orders_admin_all" on orders for all using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists "order_items_admin_all" on order_items;
create policy "order_items_admin_all" on order_items for all using (auth.jwt() ->> 'role' = 'admin');

-- ── TRIGGER updated_at ───────────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger
language plpgsql
set search_path = ''          -- evita el hallazgo "search_path mutable"
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists orders_updated_at on orders;
create trigger orders_updated_at
  before update on orders
  for each row execute function update_updated_at();

-- ── STORAGE ──────────────────────────────────────────────────────────────────
-- Bucket PRIVADO para miniaturas de diseño (se sirve con URL firmada).
-- Sin políticas públicas de insert/listado (se removieron por seguridad).
insert into storage.buckets (id, name, public) values ('designs', 'designs', false)
on conflict (id) do update set public = false;

-- =============================================================================
-- IDENTIDAD Y RUTEO (Fase 2)
-- =============================================================================

-- Ruteo híbrido:
--   Default : platform.praxisoperativa.com/personaliza/<slug>   (usa tenants.slug)
--   Opcional: dominio propio del comercio (ej. atumanera.com.ar) → tenants.custom_domain
alter table public.tenants add column if not exists custom_domain text;
alter table public.tenants add column if not exists custom_domain_verified boolean default false;
create unique index if not exists tenants_custom_domain_idx
  on public.tenants (lower(custom_domain)) where custom_domain is not null;

-- Superadmins de la plataforma (Praxis Personaliza)
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz default now()
);

-- Membresía usuario ↔ tenant con rol
create table if not exists public.tenant_users (
  user_id    uuid not null references auth.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  role       text not null default 'staff' check (role in ('admin','staff')),
  created_at timestamptz default now(),
  primary key (user_id, tenant_id)
);
create index if not exists tenant_users_tenant_idx on public.tenant_users(tenant_id);

-- Helpers en schema privado (PostgREST NO expone `private` → no son RPC-invocables).
-- security definer: evalúan sin recursión de RLS.
create schema if not exists private;

create or replace function private.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create or replace function private.has_tenant_access(tid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_platform_admin()
      or exists (select 1 from public.tenant_users
                 where user_id = auth.uid() and tenant_id = tid);
$$;

create or replace function private.order_tenant(oid uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select tenant_id from public.orders where id = oid;
$$;

revoke all on schema private from public;
grant usage on schema private to authenticated;
grant execute on function private.is_platform_admin()     to authenticated;
grant execute on function private.has_tenant_access(uuid) to authenticated;
grant execute on function private.order_tenant(uuid)      to authenticated;

alter table public.platform_admins enable row level security;
alter table public.tenant_users    enable row level security;

drop policy if exists "platform_admins_su" on public.platform_admins;
create policy "platform_admins_su" on public.platform_admins
  for all to authenticated using (private.is_platform_admin());

drop policy if exists "tenant_users_su" on public.tenant_users;
create policy "tenant_users_su" on public.tenant_users
  for all to authenticated using (private.is_platform_admin());

drop policy if exists "tenant_users_self_read" on public.tenant_users;
create policy "tenant_users_self_read" on public.tenant_users
  for select to authenticated using (user_id = auth.uid());

-- RLS efectiva por tenant (segunda barrera; la app server-side usa service_role).
-- Acotadas al rol `authenticated` para no interferir con la lectura pública anon.
drop policy if exists "products_tenant_rw" on public.products;
create policy "products_tenant_rw" on public.products
  for all to authenticated
  using (private.has_tenant_access(tenant_id))
  with check (private.has_tenant_access(tenant_id));

drop policy if exists "orders_tenant_rw" on public.orders;
create policy "orders_tenant_rw" on public.orders
  for all to authenticated
  using (private.has_tenant_access(tenant_id))
  with check (private.has_tenant_access(tenant_id));

drop policy if exists "order_items_tenant_rw" on public.order_items;
create policy "order_items_tenant_rw" on public.order_items
  for all to authenticated
  using (private.has_tenant_access(private.order_tenant(order_id)))
  with check (private.has_tenant_access(private.order_tenant(order_id)));

-- =============================================================================
-- SECRETOS POR TENANT (Supabase Vault) — Fase 2
-- =============================================================================
-- Credenciales sensibles por tenant (MP access token, pass de Andreani, etc.)
-- cifradas en vault.secrets. Solo el service_role (endpoints server-side) puede
-- leerlas/escribirlas mediante las funciones de abajo.
create table if not exists public.tenant_secrets (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,   -- 'mp_access_token' | 'andreani_pass' | ...
  secret_id  uuid not null,   -- referencia a vault.secrets(id)
  created_at timestamptz default now(),
  primary key (tenant_id, name)
);
alter table public.tenant_secrets enable row level security;
drop policy if exists "tenant_secrets_deny" on public.tenant_secrets;
create policy "tenant_secrets_deny" on public.tenant_secrets
  for all to anon, authenticated using (false) with check (false);

create or replace function public.get_tenant_secret(p_tenant uuid, p_name text)
returns text language sql stable security definer set search_path = '' as $$
  select ds.decrypted_secret
  from public.tenant_secrets ts
  join vault.decrypted_secrets ds on ds.id = ts.secret_id
  where ts.tenant_id = p_tenant and ts.name = p_name;
$$;

create or replace function public.set_tenant_secret(p_tenant uuid, p_name text, p_value text)
returns void language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
  select secret_id into sid from public.tenant_secrets where tenant_id = p_tenant and name = p_name;
  if sid is null then
    sid := vault.create_secret(p_value, p_tenant::text || ':' || p_name, 'praxis tenant secret');
    insert into public.tenant_secrets(tenant_id, name, secret_id) values (p_tenant, p_name, sid);
  else
    perform vault.update_secret(sid, p_value);
  end if;
end $$;

-- Solo service_role puede ejecutar estas funciones
revoke all on function public.get_tenant_secret(uuid, text)       from public, anon, authenticated;
revoke all on function public.set_tenant_secret(uuid, text, text) from public, anon, authenticated;
grant execute on function public.get_tenant_secret(uuid, text)       to service_role;
grant execute on function public.set_tenant_secret(uuid, text, text) to service_role;
