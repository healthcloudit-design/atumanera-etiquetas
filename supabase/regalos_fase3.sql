-- =============================================================================
-- REGALOS PERSONALIZADOS — Fase 3 (buzos + vaso térmico + mockups fotográficos)
-- =============================================================================
-- IDEMPOTENTE. Requiere regalos_fase1.sql y regalos_fase2.sql aplicados.
-- Precios: de EJEMPLO (el precio base no se pisa en re-ejecuciones).
-- =============================================================================

-- Remera: usar el mockup fotográfico (public/assets/regalos/mockups/remera.*)
update public.products
set options = options || '{"garment":"remera"}'::jsonb
where slug = 'remera-personalizada'
  and tenant_id = (select id from public.tenants where slug = 'atumanera');

insert into public.products
  (tenant_id, name, slug, category, price, units_per_set, unit_label,
   material, size_description, elaboration_days, notes, active, options)
select t.id, v.name, v.slug, 'Regalos', v.price, 1, 'unidad',
       v.material, v.size_description, v.elaboration_days, v.notes, true, v.options::jsonb
from public.tenants t
cross join (values
  ('Buzo Personalizado', 'buzo-personalizado', 1990000,
   'Buzo con capucha y bolsillo canguro, frisa · estampado DTF',
   'Talles S a XXL · 6 colores',
   '5 a 7 días hábiles',
   'Escudo en el pecho, espalda tamaño A4 y nombre o detalle en las mangas.',
   '{"editor":"tee","garment":"buzo","line":"regalos","dpi":300,
     "sizes":["S","M","L","XL","XXL"],
     "color_label":"Color de buzo",
     "colors":[{"name":"Blanco","hex":"#FFFFFF"},{"name":"Gris claro","hex":"#C8CBD0"},
               {"name":"Gris oscuro","hex":"#4A4D53"},{"name":"Negro","hex":"#1C1C1E"},
               {"name":"Azul","hex":"#1E4FA3"},{"name":"Rosa","hex":"#F4B8CB"}],
     "zones":[
       {"id":"front",   "name":"Escudo (pecho)",  "w_cm":10, "h_cm":10,   "price":350000, "view":"front"},
       {"id":"back",    "name":"Espalda",         "w_cm":21, "h_cm":29.7, "price":650000, "view":"back"},
       {"id":"sleeve_r","name":"Manga derecha",   "w_cm":6,  "h_cm":2,    "price":180000, "view":"front"},
       {"id":"sleeve_l","name":"Manga izquierda", "w_cm":6,  "h_cm":2,    "price":180000, "view":"front"}
     ],
     "shipping":{"kg":0.6,"l":35,"w":28,"h":6}}'),
  ('Vaso Térmico Personalizado', 'vaso-termico', 1690000,
   'Vaso térmico de viaje con tapa a presión y asa',
   '450 ml · área de impresión 21 × 9 cm',
   '3 a 5 días hábiles',
   'Ideal para el auto: la base entra en el posavasos. Tu foto o frase alrededor del vaso.',
   '{"editor":"mug","line":"regalos","print":{"w_cm":21,"h_cm":9,"dpi":300},
     "mug":{"model":"travel","height_cm":18.3,"diameter_cm":8.6,"base_diameter_cm":6.9},
     "shipping":{"kg":0.4,"l":12,"w":12,"h":20}}')
) as v(name, slug, price, material, size_description, elaboration_days, notes, options)
where t.slug = 'atumanera'
on conflict (tenant_id, slug) do update set
  name = excluded.name, category = excluded.category, material = excluded.material,
  size_description = excluded.size_description, elaboration_days = excluded.elaboration_days,
  notes = excluded.notes, options = excluded.options;
