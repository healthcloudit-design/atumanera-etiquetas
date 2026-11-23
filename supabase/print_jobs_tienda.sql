-- =============================================================================
-- IMPRESIONES ← TIENDA: los pedidos pagados de la tienda entran al panel de Impresiones
-- =============================================================================
-- IDEMPOTENTE y ADITIVO. Correr entero en Supabase > SQL Editor.
-- Un print_job por ítem de pedido (un pedido puede traer varios productos de impresión).

alter table public.print_jobs
  add column if not exists source        text not null default 'formulario',
  add column if not exists order_id      uuid references public.orders(id) on delete set null,
  add column if not exists order_item_id uuid references public.order_items(id) on delete set null,
  add column if not exists price_detail  jsonb;   -- opciones elegidas + desglose de precio (lo ve Sandra)

alter table public.print_jobs drop constraint if exists print_jobs_source_chk;
alter table public.print_jobs add constraint print_jobs_source_chk
  check (source in ('formulario', 'tienda'));

-- Idempotencia: Mercado Pago repite webhooks; un ítem pagado genera UN solo trabajo.
create unique index if not exists print_jobs_order_item_uidx
  on public.print_jobs(order_item_id) where order_item_id is not null;
create index if not exists print_jobs_order_idx on public.print_jobs(order_id);
