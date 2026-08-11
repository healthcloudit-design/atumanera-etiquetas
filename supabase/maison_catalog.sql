-- =============================================================================
-- MAISON IMPORT — Tenant + catálogo (Bagués). Correr en el SQL Editor de Supabase.
-- Idempotente: se puede correr varias veces. slug de producto = código del catálogo.
-- Las fotos van en public/assets/maison/<codigo>.jpg (se despliegan con el sitio).
-- =============================================================================

-- ── Tenant ───────────────────────────────────────────────────────────────────
insert into public.tenants (slug, name, primary_color, secondary_color, logo_url, default_shipping_cost, active)
values ('maison', 'Maison Import', '#7A6E5C', '#B39A6E', '/assets/maison/logo.jpeg', 0, true)
on conflict (slug) do update
  set name = excluded.name, primary_color = excluded.primary_color,
      secondary_color = excluded.secondary_color, logo_url = excluded.logo_url, active = true;

-- ── Productos (LOTE 1) ───────────────────────────────────────────────────────
insert into public.products (tenant_id, name, slug, category, price, units_per_set, unit_label, material, size_description, notes, active)
select t.id, p.name, p.slug, p.category, p.price, 1, 'unidad', p.material, p.size, p.notes, true
from (values
  ('Avalon',        '10282085', 'Mi Primer Bagués', 1699900, 'Eau de Parfum · inspirado en I Love Love', '50 ml',
     'Salida: Pomelo, Naranja, Limón, Grosella roja. Corazón: Caña de azúcar, Muguete, Rosa de Bulgaria, Canela. Fondo: Almizcle, Cedro, Sándalo.'),
  ('Atlántica',     '10281132', 'Mi Primer Bagués', 1699900, 'Eau de Parfum · inspirado en Toy Pearl 2', '50 ml',
     'Salida: Sorbete lemon, Orégano, Pera, Ciclamen. Corazón: Fresia, Jazmín, Ozónico, Durazno. Fondo: Musk, Cypress, Vetiver, Cashmeran.'),
  ('Suspiro de Sol','19283005', 'Body Mist', 1549900, 'Body Mist · frutal cítrico', '125 ml',
     'Body mist frutal y floral, fresco y luminoso.'),
  ('Brillo de Luna','19283006', 'Body Mist', 1549900, 'Body Mist · ámbar vainilla', '125 ml',
     'Body mist envolvente con notas de caramelo, vainilla y miel, con glitter.'),
  ('Red Cherry',    '14305007', 'Lip Care', 819900, 'Lip Care', '3.3 g',
     'Bálsamo labial con aroma a cereza.'),
  ('Pure Karité',   '14305009', 'Lip Care', 819900, 'Lip Care', '3.3 g',
     'Bálsamo labial neutro y cremoso con karité, sin perfume.'),
  ('Pink Rose',     '14305008', 'Lip Care', 819900, 'Lip Care', '3.3 g',
     'Bálsamo labial con aroma a rosas.')
) as p(name, slug, category, price, material, size, notes)
cross join (select id from public.tenants where slug = 'maison') t
on conflict (tenant_id, slug) do update
  set name = excluded.name, category = excluded.category, price = excluded.price,
      material = excluded.material, size_description = excluded.size_description,
      notes = excluded.notes, active = true;
