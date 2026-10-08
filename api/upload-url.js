// api/upload-url.js
// Entrega una URL firmada para que el navegador suba un archivo DIRECTO al
// bucket privado `designs` de Supabase Storage, sin pasar por Vercel (que corta
// los bodies en 4,5 MB). Lo usa la tienda de regalos para:
//   - la foto ORIGINAL del cliente (para producción, sin recomprimir)
//   - el archivo de PRODUCCIÓN (PNG 300 dpi del área de impresión)
//
// Los archivos quedan en <tenant_id>/pending/<YYYYMMDD>/<uuid>-<kind>.<ext>.
// create-preference los mueve a <tenant_id>/<order_id>/ al confirmar el pedido.
// Los pending huérfanos (carritos abandonados) se pueden limpiar por fecha.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { applyCors, sendOptions, publicError, getTenantSlug } = require('./_utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MAX_BYTES = 25 * 1024 * 1024;
const TYPES = {
  original:   { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' },
  production: { 'image/png': 'png' },
};

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return sendOptions(req, res, 'POST, OPTIONS');
  if (req.method !== 'POST') return publicError(res, 405, 'Method not allowed');

  const { kind, contentType, size } = req.body || {};
  const ext = TYPES[kind] && TYPES[kind][String(contentType || '').toLowerCase()];
  if (!ext) return publicError(res, 400, 'Tipo de archivo no permitido');
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_BYTES) {
    return publicError(res, 400, 'El archivo supera los 25 MB');
  }

  try {
    const { data: tenant } = await supabase
      .from('tenants').select('id').eq('slug', getTenantSlug(req)).eq('active', true).maybeSingle();
    if (!tenant) return publicError(res, 400, 'Comercio no valido');

    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const path = `${tenant.id}/pending/${day}/${crypto.randomUUID()}-${kind}.${ext}`;
    const { data, error } = await supabase.storage.from('designs').createSignedUploadUrl(path);
    if (error) throw error;

    return res.status(200).json({ path, signedUrl: data.signedUrl });
  } catch (e) {
    console.error('upload-url error:', e.message || e);
    return publicError(res, 500, 'No se pudo preparar la subida');
  }
};
