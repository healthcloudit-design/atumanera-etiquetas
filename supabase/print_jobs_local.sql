-- =============================================================================
-- IMPRESIONES: pedidos cargados por Sandra en el local + total y medio de pago
-- =============================================================================
-- IDEMPOTENTE y ADITIVO. Correr entero en Supabase > SQL Editor.

alter table public.print_jobs
  add column if not exists total_cents    integer,
  add column if not exists payment_method text;

alter table public.print_jobs drop constraint if exists print_jobs_total_chk;
alter table public.print_jobs add constraint print_jobs_total_chk
  check (total_cents is null or total_cents >= 0);

alter table public.print_jobs drop constraint if exists print_jobs_payment_chk;
alter table public.print_jobs add constraint print_jobs_payment_chk
  check (payment_method is null or payment_method in
    ('efectivo', 'transferencia', 'mercadopago_local', 'mercadopago_online', 'pendiente'));

-- Origen: formulario web, tienda online o cargado en el local
alter table public.print_jobs drop constraint if exists print_jobs_source_chk;
alter table public.print_jobs add constraint print_jobs_source_chk
  check (source in ('formulario', 'tienda', 'local'));

-- Los pedidos ya pagados online guardan su total y medio de pago
update public.print_jobs j
   set total_cents = oi.subtotal, payment_method = 'mercadopago_online'
  from public.order_items oi
 where j.order_item_id = oi.id and j.total_cents is null;
