// api/print-track.js
// Seguimiento del CLIENTE por token (sin login).
//   GET  ?t=<token>                         → estado, observaciones y línea de tiempo pública
//   POST {token, action:'attach', path, name, mime, size, check} → registra el archivo subido
// Nunca expone ids internos, rutas de storage ni datos de otros pedidos.

const crypto = require('crypto');
const { applyCors, sendOptions, publicError, cleanString } = require('./_utils');
const { supabase, BUCKET, MAX_BYTES, MIMES, TOKEN_RE, actorLabel } = require('./_print');

const PUBLIC_KINDS = ['creado', 'status', 'archivo_subido'];

function sanitizeCheck(c) {
  if (!c || typeof c !== 'object') return null;
  const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  return {
    w_px: num(c.w_px), h_px: num(c.h_px), dpi: num(c.dpi),
    w_cm: num(c.w_cm), h_cm: num(c.h_cm),
    ok: !!c.ok,
    warnings: Array.isArray(c.warnings) ? c.warnings.slice(0, 5).map(w => String(w).slice(0, 200)) : [],
    source: 'navegador',   // el chequeo lo corre el navegador del cliente: es orientativo
  };
}

async function findJob(token) {
  if (!TOKEN_RE.test(token)) return null;
  const { data } = await supabase.from('print_jobs').select('*').eq('public_token', token).maybeSingle();
  return data || null;
}

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return sendOptions(req, res, 'GET, POST, OPTIONS');
  if (req.method !== 'GET' && req.method !== 'POST') return publicError(res, 405, 'Method not allowed');

  const token = String((req.method === 'GET' ? req.query?.t : req.body?.token) || '').trim().toLowerCase();

  try {
    const job = await findJob(token);
    if (!job) return publicError(res, 404, 'Pedido no encontrado');

    if (req.method === 'GET') {
      const { data: events } = await supabase
        .from('print_job_events')
        .select('kind, from_status, to_status, note, actor, created_at')
        .eq('job_id', job.id)
        .in('kind', PUBLIC_KINDS)
        .order('created_at', { ascending: true });
      return res.status(200).json({
        jobNumber: job.job_number,
        status: job.status,
        clientName: job.client_name,
        description: job.description,
        observations: job.status === 'devuelto' ? job.observations : null,
        deadlineBusinessDays: job.deadline_business_days,
        fileName: job.file_name,
        hasFile: !!job.file_path,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
        events: (events || []).map(e => ({
          kind: e.kind, from: e.from_status, to: e.to_status,
          note: e.note, by: actorLabel(e.actor), at: e.created_at,
        })),
      });
    }

    // POST: registrar archivo subido
    const b = req.body || {};
    if (b.action === 'sign') {
      if (!['enviado', 'devuelto'].includes(job.status)) {
        return publicError(res, 409, 'Este pedido ya no admite archivos nuevos');
      }
      const mime = String(b.mime || '').toLowerCase();
      const size = Number(b.size);
      const ext = MIMES[mime];
      if (!ext) return publicError(res, 400, 'Formato no permitido (JPG, PNG, TIFF, WebP o PDF)');
      if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
        return publicError(res, 400, 'El archivo supera los 50 MB');
      }
      const path = `${job.tenant_id}/${job.id}/${crypto.randomUUID()}.${ext}`;
      const { data: up, error: upErr } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
      if (upErr) throw upErr;
      return res.status(200).json({ uploadPath: path, uploadUrl: up.signedUrl });
    }
    if (b.action !== 'attach') return publicError(res, 400, 'Acción no válida');
    if (!['enviado', 'devuelto'].includes(job.status)) {
      return publicError(res, 409, 'Este pedido ya no admite archivos nuevos');
    }

    const path = String(b.path || '');
    if (!path.startsWith(`${job.tenant_id}/${job.id}/`) || path.includes('..')) {
      return publicError(res, 400, 'Ruta de archivo inválida');
    }
    const mime = String(b.mime || '').toLowerCase();
    const size = Number(b.size);
    if (!MIMES[mime]) return publicError(res, 400, 'Formato no permitido (JPG, PNG, TIFF, WebP o PDF)');
    if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
      return publicError(res, 400, 'El archivo supera los 50 MB');
    }

    // Confirmar que el archivo realmente llegó a Storage.
    const slash = path.lastIndexOf('/');
    const dir = path.slice(0, slash);
    const fname = path.slice(slash + 1);
    const { data: list, error: listErr } = await supabase.storage
      .from(BUCKET).list(dir, { search: fname, limit: 5 });
    if (listErr || !list || !list.some(f => f.name === fname)) {
      return publicError(res, 400, 'El archivo no llegó. Probá subirlo de nuevo.');
    }

    const name = cleanString(b.name, 200) || fname;
    const { error: upErr } = await supabase.from('print_jobs').update({
      file_path: path,
      file_name: name,
      file_mime: mime,
      file_size_bytes: size,
      file_check: sanitizeCheck(b.check),
    }).eq('id', job.id);
    if (upErr) throw upErr;

    await supabase.from('print_job_events').insert({
      job_id: job.id, tenant_id: job.tenant_id, kind: 'archivo_subido', note: name, actor: 'cliente',
    });

    let status = job.status;
    if (job.status === 'devuelto') {
      const { error: rpcErr } = await supabase.rpc('print_job_set_status', {
        p_job: job.id, p_status: 'enviado', p_actor: 'cliente',
        p_note: 'Cliente subió una nueva versión', p_obs: null, p_days: null,
      });
      if (rpcErr) throw rpcErr;
      status = 'enviado';
    }
    return res.status(200).json({ ok: true, status });
  } catch (e) {
    console.error('print-track error:', e.message || e);
    return publicError(res, 500, 'No se pudo procesar la solicitud');
  }
};
