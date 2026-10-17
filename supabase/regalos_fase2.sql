-- =============================================================================
-- REGALOS PERSONALIZADOS — Fase 2 (remeras)            regalos.atumaneragraf.com
-- =============================================================================
-- IDEMPOTENTE. Requiere regalos_fase1.sql aplicado (columna products.options).
-- Precio final = price (remera lisa) + price de cada zona personalizada.
-- Medidas de impresión: reales (definidas por Sandra). Precios: de EJEMPLO.
-- =============================================================================
insert into public.products
  (tenant_id, name, slug, category, price, units_per_set, unit_label,
   material, size_description, elaboration_days, notes, active, options)
select t.id,
  'Remera Personalizada', 'remera-personalizada', 'Regalos', 990000, 1, 'unidad',
  'Algodón peinado 24/1 · estampado DTF',
  'Talles S a XXL · blanca o negra',
  '4 a 6 días hábiles',
  'Escudo en el pecho, espalda tamaño A4 y nombre o detalle en las mangas.',
  true,
  '{"editor":"tee","line":"regalos",
    "dpi":300,
    "sizes":["S","M","L","XL","XXL"],
    "color_label":"Color de remera",
    "colors":[{"name":"Blanca","hex":"#FFFFFF"},{"name":"Negra","hex":"#1C1C1E"}],
    "zones":[
      {"id":"front",   "name":"Escudo (pecho)",  "w_cm":10, "h_cm":10,   "price":350000, "view":"front"},
      {"id":"back",    "name":"Espalda",         "w_cm":21, "h_cm":29.7, "price":650000, "view":"back"},
      {"id":"sleeve_r","name":"Manga derecha",   "w_cm":6,  "h_cm":2,    "price":180000, "view":"front"},
      {"id":"sleeve_l","name":"Manga izquierda", "w_cm":6,  "h_cm":2,    "price":180000, "view":"front"}
    ],
    "shipping":{"kg":0.25,"l":30,"w":25,"h":3}}'::jsonb
from public.tenants t
where t.slug = 'atumanera'
on conflict (tenant_id, slug) do update set
  name = excluded.name, category = excluded.category, material = excluded.material,
  size_description = excluded.size_description, elaboration_days = excluded.elaboration_days,
  notes = excluded.notes, options = excluded.options;
-- (el precio base NO se pisa en re-ejecuciones: lo maneja Sandra desde el panel;
--  los precios por zona se editan en options.zones[].price, en centavos)
