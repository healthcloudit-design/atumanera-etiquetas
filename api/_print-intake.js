// api/print-jobs.js
// INTAKE público: el cliente carga datos y pide una URL firmada para subir su archivo.
// Después de subirlo, llama a /api/print-track (action: attach) para registrarlo.

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
  const fileMime = String(b.fileMime || '').toLowerCase();
  const fileSize = Number(b.fileSize);
  const ext = MIMES[fileMime];

  if (!name || name.length < 2) return publicError(res, 400, 'Falta el nombre');
  if (!phone || phone.replace(/\D/g, '').length < 6) return publicError(res, 400, 'Teléfono inválido');
  if (!email) return publicError(res, 400, 'Email inválido');
  if (!description || description.length < 5) return publicError(res, 400, 'Contanos qué querés imprimir');
  if (!ext) return publicError(res, 400, 'Formato no permitido (JPG, PNG, TIFF, WebP o PDF)');
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_BYTES) {
    return publicError(res, 400, 'El archivo supera los 50 MB');
  }

  try {
    const { data: tenant } = await supabase
      .from('tenants').select('id').eq('slug', getTenantSlug(req)).eq('active', true).maybeSingle();
    if (!tenant) return publicError(res, 400, 'Comercio no válido');

    const { data: job, error } = await supabase
      .from('print_jobs')
      .insert({ tenant_id: tenant.id, client_name: name, client_phone: phone, client_email: email, description })
      .select('id, tenant_id, public_token, job_number')
      .single();
    if (error) throw error;

    await logEvent(job, 'creado', 'Pedido cargado por el cliente');

    const path = `${tenant.id}/${job.id}/${crypto.randomUUID()}.${ext}`;
    const { data: up, error: upErr } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
    if (upErr) throw upErr;

    return res.status(200).json({
      token: job.public_token,
      jobNumber: job.job_number,
      trackUrl: trackUrl(job.public_token),
      uploadPath: path,
      uploadUrl: up.signedUrl,
    });
  } catch (e) {
    console.error('print-jobs error:', e.message || e);
    return publicError(res, 500, 'No se pudo crear el pedido');
  }
};
