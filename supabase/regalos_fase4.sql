-- =============================================================================
-- REGALOS PERSONALIZADOS — Fase 4 (vaso térmico de aluminio)
-- =============================================================================
-- IDEMPOTENTE. Requiere regalos_fase1.sql (columna products.options).
-- Mockup fotográfico: public/assets/regalos/mockups/vaso2.* (garment "vaso2").
-- Precio y área de impresión: de EJEMPLO (confirmar con Sandra).
-- =============================================================================
insert into public.products
  (tenant_id, name, slug, category, price, units_per_set, unit_label,
   material, size_description, elaboration_days, notes, active, options)
select t.id,
  'Vaso Térmico de Aluminio', 'vaso-aluminio', 'Regalos', 1890000, 1, 'unidad',
  'Acero inoxidable doble pared, terminación negra mate, tapa con visor',
  '20 oz (590 ml) · área de impresión 7 × 9 cm',
  '3 a 5 días hábiles',
  'Mantiene frío o caliente por horas. Tu logo o foto a todo color.',
  true,
  '{"editor":"tee","garment":"vaso2","chip":"Vaso de aluminio","line":"regalos","dpi":300,
    "color_label":"Color",
    "colors":[{"name":"Negro","hex":"#1C1C1E"}],
    "zones":[{"id":"front","name":"Frente","w_cm":7,"h_cm":9,"price":0,"view":"front"}],
    "shipping":{"kg":0.45,"l":11,"w":11,"h":20}}'::jsonb
from public.tenants t
where t.slug = 'atumanera'
on conflict (tenant_id, slug) do update set
  name = excluded.name, category = excluded.category, material = excluded.material,
  size_description = excluded.size_description, elaboration_days = excluded.elaboration_days,
  notes = excluded.notes, options = excluded.options;
