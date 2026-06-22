-- =============================================
-- A TU MANERA ETIQUETAS — Supabase Schema
-- =============================================

-- PRODUCTOS
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  category text not null,
  price integer not null, -- en ARS centavos (15900 = $15.900)
  units_per_set integer not null,
  unit_label text not null default 'unidades',
  material text,
  size_description text,
  elaboration_days text,
  notes text,
  active boolean default true,
  created_at timestamptz default now()
);

-- PEDIDOS
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_number serial unique not null,
  -- datos del comprador
  buyer_name text not null,
  buyer_email text not null,
  buyer_phone text,
  -- envío
  shipping_method text not null default 'andreani', -- 'andreani' | 'retiro'
  shipping_address text,
  shipping_city text,
  shipping_zip text,
  shipping_province text,
  shipping_cost integer default 0,
  tracking_number text,
  -- pago
  mp_preference_id text,
  mp_payment_id text,
  mp_status text, -- pending | approved | rejected
  total integer not null, -- en ARS centavos
  -- estado
  status text not null default 'pending_payment',
  -- pending_payment | paid | in_production | shipped | delivered
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ITEMS DE PEDIDO (con datos del diseño)
create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id) on delete cascade,
  product_id uuid references products(id),
  product_name text not null,
  -- datos del diseño personalizado
  design_text text not null,
  design_font text not null,
  design_text_color text default '#1A1A1A',
  design_icon_index integer, -- índice del dibujo elegido (null = sin dibujito)
  design_position text default 'left',
  design_border_color text, -- solo termoadhesivas
  design_pulsera_color text, -- solo pulseras
  -- cantidad y precio
  quantity integer not null default 1,
  units_total integer not null,
  unit_price integer not null,
  subtotal integer not null,
  -- imagen miniatura del diseño (generada con html2canvas)
  design_thumbnail_url text,
  created_at timestamptz default now()
);

-- PRODUCTOS SEED DATA
insert into products (name, slug, category, price, units_per_set, unit_label, material, size_description, elaboration_days, notes) values
  ('Cintas para coser + Llavero', 'cintas-falletina', 'coser', 1590000, 20, 'cintas', 'Falletina', '6 × 2,5 cm', '7 días hábiles', '+ llavero 3×6cm incluido'),
  ('32 Etiquetas Termoadhesivas', 'termo-32', 'termoadhesivas', 1299900, 32, 'etiquetas', 'Tela blanca', '5 × 1,5 cm', '7 días hábiles', 'No apta para toallas, polar ni lanas'),
  ('49 Etiquetas Termoadhesivas (plancha mixta)', 'termo-49', 'termoadhesivas', 1899000, 49, 'etiquetas', 'Tela blanca', '40 unid. 5×1,5cm + 9 unid. 6,5×3,5cm', '7 días hábiles', 'No apta para toallas, polar ni lanas'),
  ('Pulseras Cinta Fluor x30', 'pulseras-fluor', 'pulseras', 1990000, 30, 'pulseras', 'Raso flúor', '2,5 × 30 cm', '10-15 días hábiles', 'Colores surtidos: naranja, amarillo, verde, fucsia')
on conflict (slug) do nothing;

-- RLS (Row Level Security)
alter table products enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;

-- Productos: lectura pública
create policy "products_public_read" on products for select using (active = true);

-- Pedidos: inserción pública (cualquiera puede crear un pedido)
create policy "orders_public_insert" on orders for insert with check (true);

-- Pedidos: lectura solo por email del comprador (o admin)
create policy "orders_read_own" on orders for select using (
  auth.jwt() ->> 'email' = buyer_email
  or auth.jwt() ->> 'role' = 'admin'
);

-- Admin puede hacer todo
create policy "orders_admin_all" on orders for all using (
  auth.jwt() ->> 'role' = 'admin'
);
create policy "order_items_admin_all" on order_items for all using (
  auth.jwt() ->> 'role' = 'admin'
);
create policy "order_items_public_insert" on order_items for insert with check (true);

-- Trigger para updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger orders_updated_at
  before update on orders
  for each row execute function update_updated_at();

-- Storage bucket para miniaturas de diseños
insert into storage.buckets (id, name, public) values ('designs', 'designs', true)
on conflict do nothing;

create policy "designs_public_read" on storage.objects for select using (bucket_id = 'designs');
create policy "designs_public_insert" on storage.objects for insert with check (bucket_id = 'designs');
