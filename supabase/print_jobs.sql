-- =============================================================================
-- IMPRESIONES / PLOTTER — Pedidos de impresión (regalos.atumaneragraf.com)
-- =============================================================================
-- IDEMPOTENTE y ADITIVO: no toca tablas de etiquetas ni de regalos.
-- Correr entero en Supabase > SQL Editor (proyecto qsynlqxhoxhvzjzkyqaj).
--
-- Piezas:
--   print_jobs        → un pedido (datos del cliente, archivo, estado, observaciones)
--   print_job_events  → historial: cada cambio de estado, devolución, mail enviado
--   bucket print-files → archivos del cliente, PRIVADO (solo service_role)
--
-- Seguridad (mismo criterio que schema.sql):
--   - La app server-side usa service_role (bypassa RLS) y SIEMPRE acota por tenant.
--   - anon no tiene policies → no puede leer ni escribir estas tablas.
--   - El cliente hace seguimiento con public_token desde un endpoint server-side.
--   - Staff del tenant (authenticated + tenant_users) lee/escribe su tenant.
-- =============================================================================

-- ── PEDIDOS ──────────────────────────────────────────────────────────────────
-- Estados (todos cambiables a mano; la base no fuerza transiciones):
--   enviado            → cliente cargó datos y archivo; Sandra debe revisar
--   devuelto           → imagen devuelta con observaciones; espera nuevo archivo
--   confirmado         → Sandra confirmó a cliente (mail con plazo)
--   en_imprenta        → en producción en la imprenta
--   recibido_imprenta  → llegó de la imprenta, pendiente de entrega
--   entregado          → entregado al cliente
--   completado         → cerrado
create table if not exists public.print_jobs (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  job_number             bigint generated always as identity unique,
  -- token de seguimiento: 64 hex aleatorios (2 UUID v4), no secuencial, sin login
  public_token           text not null unique
                         default (replace(gen_random_uuid()::text, '-', '')
                               || replace(gen_random_uuid()::text, '-', '')),
  status                 text not null default 'enviado'
                         check (status in ('enviado','devuelto','confirmado','en_imprenta',
                                           'recibido_imprenta','entregado','completado')),
  -- datos del cliente
  client_name            text not null,
  client_phone           text not null,     -- WhatsApp
  client_email           text not null,
  description            text not null,     -- qué quiere imprimir
  -- archivo (bucket privado print-files)
  file_path              text,              -- <tenant_id>/<job_id>/<uuid>.<ext>
  file_name              text,
  file_mime              text,
  file_size_bytes        bigint,
  -- chequeo automático: SOLO ayuda para Sandra. Ej: {"w_px":3000,"h_px":2000,"dpi":300,"w_cm":25.4,"h_cm":16.9,"ok":true,"warnings":[]}
  file_check             jsonb,
  -- decisión de Sandra
  observations           text,              -- motivo de devolución (obligatorio al devolver)
  deadline_business_days integer,           -- plazo informado al confirmar (días hábiles)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- no se puede estar en "devuelto" sin observaciones
  constraint print_jobs_devuelto_obs
    check (status <> 'devuelto' or (observations is not null and length(trim(observations)) > 0)),
  constraint print_jobs_deadline_pos
    check (deadline_business_days is null or deadline_business_days > 0)
);

create index if not exists print_jobs_tenant_status_idx
  on public.print_jobs (tenant_id, status, created_at desc);

create or replace function public.print_jobs_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists print_jobs_touch on public.print_jobs;
create trigger print_jobs_touch before update on public.print_jobs
  for each row execute function public.print_jobs_touch();

-- ── HISTORIAL ────────────────────────────────────────────────────────────────
-- kind: creado | archivo_subido | status | observacion | mail
-- actor: 'cliente' | 'sistema' | 'staff:<user_id>'
create table if not exists public.print_job_events (
  id          bigint generated always as identity primary key,
  job_id      uuid not null references public.print_jobs(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  kind        text not null
              check (kind in ('creado','archivo_subido','status','observacion','mail')),
  from_status text,
  to_status   text,
  note        text,
  actor       text not null,
  created_at  timestamptz not null default now()
);

create index if not exists print_job_events_job_idx
  on public.print_job_events (job_id, created_at);

-- ── CAMBIO DE ESTADO ATÓMICO ─────────────────────────────────────────────────
-- Actualiza el pedido y registra el evento en una sola transacción.
-- p_obs se usa al devolver; p_days al confirmar. Ambos opcionales.
create or replace function public.print_job_set_status(
  p_job    uuid,
  p_status text,
  p_actor  text,
  p_note   text    default null,
  p_obs    text    default null,
  p_days   integer default null
) returns public.print_jobs
language plpgsql security definer set search_path = '' as $$
declare
  j          public.print_jobs;
  old_status text;
begin
  select * into j from public.print_jobs where id = p_job for update;
  if not found then
    raise exception 'print_job_not_found';
  end if;
  old_status := j.status;

  update public.print_jobs set
    status                 = p_status,
    observations           = coalesce(p_obs, observations),
    deadline_business_days = coalesce(p_days, deadline_business_days)
  where id = p_job
  returning * into j;

  insert into public.print_job_events
    (job_id, tenant_id, kind, from_status, to_status, note, actor)
  values
    (p_job, j.tenant_id, 'status', old_status, p_status, coalesce(p_note, p_obs), p_actor);

  return j;
end $$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.print_jobs       enable row level security;
alter table public.print_job_events enable row level security;

drop policy if exists "print_jobs_tenant_rw" on public.print_jobs;
create policy "print_jobs_tenant_rw" on public.print_jobs
  for all to authenticated
  using (private.has_tenant_access(tenant_id))
  with check (private.has_tenant_access(tenant_id));

drop policy if exists "print_job_events_tenant_read" on public.print_job_events;
create policy "print_job_events_tenant_read" on public.print_job_events
  for select to authenticated
  using (private.has_tenant_access(tenant_id));

-- Escritura del historial solo por service_role (endpoints server-side).
-- Sin policies para anon ni authenticated en INSERT/UPDATE/DELETE sobre events.

-- La función de estado es solo para service_role.
revoke all on function public.print_job_set_status(uuid, text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.print_job_set_status(uuid, text, text, text, text, integer)
  to service_role;

-- ── STORAGE: archivos del cliente ────────────────────────────────────────────
-- Privado. Sin policies para anon/authenticated → solo service_role firma URLs.
-- Límite 50 MB: es el máximo del plan Free. Para más hace falta Supabase Pro.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'print-files', 'print-files', false, 52428800,
  array['image/jpeg','image/png','image/tiff','image/webp','application/pdf']
)
on conflict (id) do update set
  public             = false,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ── VERIFICACIÓN (opcional, al final) ────────────────────────────────────────
-- select table_name from information_schema.tables
--  where table_schema = 'public' and table_name like 'print_%';
-- select id, file_size_limit from storage.buckets where id = 'print-files';
