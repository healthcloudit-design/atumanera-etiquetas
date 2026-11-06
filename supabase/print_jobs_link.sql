-- =============================================================================
-- IMPRESIONES — link de descarga alternativo al archivo (archivos > 50 MB)
-- =============================================================================
-- Correr ANTES de desplegar el código nuevo: el intake y el panel leen esta columna.
-- Idempotente.
-- =============================================================================
alter table public.print_jobs add column if not exists external_link text;
