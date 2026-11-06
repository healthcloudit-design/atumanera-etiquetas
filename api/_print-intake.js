// api/_print-intake.js
// INTAKE público (handler de /api/print?op=intake). Crea el pedido.
// El cliente manda archivo, link de descarga (archivos > 50 MB) o ambos.
// Si hay archivo, devuelve una URL firmada para subirlo directo a Storage.

const crypto = require('crypto');
const { applyCors, sendOptions, publicError, getTenantSlug, cleanString, cleanEmail, cleanPhone } = require('./_utils');
const { supabase, logEvent, BUCKET, MAX_BYTES, MIMES, trackUrl } = require('./_print');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return sendOptions(req, res, 'POST, OPTIONS');
  if (req.method !== 'POST') return publicError(res, 405, 'Method not allowed');

  const b = req.body || {};
  const name = cleanString(b.name, 120);
  const phone = cleanPhone(b.phone);
  const email = cleanEmail(b.email);
  const description = cleanString(b.description, 2000);

  if (!name || name.length < 2) return publicError(res, 400, 'Falta el nombre');
  if (!phone || phone.replace(/\D/g, '').length < 6) return publicError(res, 400, 'Teléfono inválido');
  if (!email) return publicError(res, 400, 'Email inválido');
  if (!description || description.length < 5) return publicError(res, 400, 'Contanos qué querés imprimir');

  let externalLink = null;
  const rawLink = cleanString(b.externalLink, 500);
  if (rawLink) {
    let u = null;
    try { u = new URL(rawLink); } catch (e) { u = null; }
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) {
      return publicError(res, 400, 'El link no es válido (tiene que empezar con https://)');
    }
    externalLink = u.toString();
  }

  const fileMime = String(b.fileMime || '').toLowerCase();
  const hasFile = !!fileMime;
  const fileSize = Number(b.fileSize);
  let ext = null;
  if (hasFile) {
    ext = MIMES[fileMime];
    if (!ext) return publicError(res, 400, 'Formato no permitido (JPG, PNG, TIFF, WebP o PDF)');
    if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_BYTES) {
      return publicError(res, 400, 'El archivo supera los 50 MB. Pegá un link de descarga en su lugar.');
    }
  }
  if (!hasFile && !externalLink) return publicError(res, 400, 'Subí tu archivo o pegá un link de descarga');

  try {
    const { data: tenant } = await supabase
      .from('tenants').select('id').eq('slug', getTenantSlug(req)).eq('active', true).maybeSingle();
    if (!tenant) return publicError(res, 400, 'Comercio no válido');

    const { data: job, error } = await supabase
      .from('print_jobs')
      .insert({ tenant_id: tenant.id, client_name: name, client_phone: phone, client_email: email, description, external_link: externalLink })
      .select('id, tenant_id, public_token, job_number')
      .single();
    if (error) throw error;

    await logEvent(job, 'creado', hasFile ? 'Pedido cargado por el cliente' : 'Pedido cargado con link de descarga');

    const base = {
      token: job.public_token,
      jobNumber: job.job_number,
      trackUrl: trackUrl(job.public_token),
    };
    if (!hasFile) return res.status(200).json(base);

    const path = `${tenant.id}/${job.id}/${crypto.randomUUID()}.${ext}`;
    const { data: up, error: upErr } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
    if (upErr) throw upErr;

    return res.status(200).json({ ...base, uploadPath: path, uploadUrl: up.signedUrl });
  } catch (e) {
    console.error('print-intake error:', e.message || e);
    return publicError(res, 500, 'No se pudo crear el pedido');
  }
};
