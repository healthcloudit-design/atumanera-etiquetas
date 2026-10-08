-- =============================================================================
-- REGALOS PERSONALIZADOS — Fase 1 (taza)                regalos.atumaneragraf.com
-- =============================================================================
-- IDEMPOTENTE y ADITIVO: solo agrega columnas nullable, ajusta el límite del
-- bucket y carga/actualiza productos de prueba. No toca datos de etiquetas.
-- =============================================================================

-- ── Columnas nuevas ──────────────────────────────────────────────────────────
-- products.options: configuración del editor por producto (tipo de editor,
-- área de impresión en cm, colores disponibles, peso/medidas para envío).
alter table public.products    add column if not exists options jsonb;

-- order_items: datos del diseño de regalos.
--   variant → { "color": "Rojo", "color_hex": "#D7262E" }  (talle/color)
--   design  → JSON del editor (objetos, posiciones, fuentes) para re-render
--   files   → { "production": "storage:designs/...png",
--               "originals": ["storage:designs/...jpg", ...] }
alter table public.order_items add column if not exists variant jsonb;
alter table public.order_items add column if not exists design  jsonb;
alter table public.order_items add column if not exists files   jsonb;

-- ── Storage ──────────────────────────────────────────────────────────────────
-- Fotos originales de celular (hasta ~12MP) + archivo de producción PNG 300dpi.
-- Se suben directo desde el navegador con URL firmada (no pasan por Vercel).
update storage.buckets set file_size_limit = 26214400  -- 25 MB
where id = 'designs';

-- ── Productos de prueba (tenant atumanera) ───────────────────────────────────
-- Precios en centavos. Datos de EJEMPLO: ajustar desde el panel.
insert into public.products
  (tenant_id, name, slug, category, price, units_per_set, unit_label,
   material, size_description, elaboration_days, notes, active, options)
select t.id, v.name, v.slug, 'Regalos', v.price, 1, 'unidad',
       v.material, v.size_description, v.elaboration_days, v.notes, true, v.options::jsonb
from public.tenants t
cross join (values
  ('Taza Personalizada Blanca 11 oz', 'taza-blanca-11oz', 1290000,
   'Cerámica blanca sublimable calidad AAA',
   '11 oz (325 ml) · Ø 8,2 × 9,5 cm · área de impresión 20 × 9 cm',
   '3 a 5 días hábiles',
   'Apta lavavajillas y microondas. Tu foto o frase alrededor de toda la taza.',
   '{"editor":"mug","line":"regalos","print":{"w_cm":20,"h_cm":9,"dpi":300},
     "mug":{"height_cm":9.5,"diameter_cm":8.2},
     "shipping":{"kg":0.45,"l":12,"w":12,"h":11}}'),
  ('Taza Personalizada Interior y Asa de Color', 'taza-color-11oz', 1490000,
   'Cerámica sublimable con interior y asa esmaltados',
   '11 oz (325 ml) · Ø 8,2 × 9,5 cm · área de impresión 20 × 9 cm',
   '3 a 5 días hábiles',
   'Exterior blanco para tu diseño, interior y asa del color que elijas.',
   '{"editor":"mug","line":"regalos","print":{"w_cm":20,"h_cm":9,"dpi":300},
     "mug":{"height_cm":9.5,"diameter_cm":8.2},
     "color_label":"Interior y asa",
     "colors":[{"name":"Rojo","hex":"#D7262E"},{"name":"Fucsia","hex":"#EC008C"},
               {"name":"Rosa","hex":"#F6A5C0"},{"name":"Naranja","hex":"#F57C00"},
               {"name":"Amarillo","hex":"#FFC107"},{"name":"Verde","hex":"#8DC63F"},
               {"name":"Celeste","hex":"#00AEEF"},{"name":"Azul","hex":"#1F4FA8"},
               {"name":"Negro","hex":"#1E1E1E"}],
     "shipping":{"kg":0.45,"l":12,"w":12,"h":11}}')
) as v(name, slug, price, material, size_description, elaboration_days, notes, options)
where t.slug = 'atumanera'
on conflict (tenant_id, slug) do update set
  name = excluded.name, category = excluded.category, material = excluded.material,
  size_description = excluded.size_description, elaboration_days = excluded.elaboration_days,
  notes = excluded.notes, options = excluded.options;
-- (el precio NO se pisa en re-ejecuciones: lo maneja Sandra desde el panel)
