// api/print-admin.js
// Panel de Sandra / staff del tenant (JWT Supabase + tenant_users).
//   GET  ?status=<estado>        → lista de pedidos del tenant
//   GET  ?id=<uuid>              → detalle + historial + URL firmada de previsualización
//   POST {id, action:'confirm', days}          → confirmar a cliente + mail con plazo
//   POST {id, action:'return', observations}   → devolver imagen + mail con observaciones
//   POST {id, action:'status', status, note?}  → cambio manual de estado (sin mail)
// Todo acotado por tenant_id del staff. El mail falla sin revertir el cambio de estado.

const { applyCors, sendOptions, publicError, cleanString, isUuid } = require('./_utils');
const { supabase, getStaff, logEvent, sendJobMail, trackUrl, BUCKET, STATUSES } = require('./_print');

async function ownJob(id, tenantId) {
  if (!isUuid(id)) return null;
  const { data } = await supabase
    .from('print_jobs').select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
  return data || null;
}

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return sendOptions(req, res, 'GET, POST, OPTIONS');

  const ctx = await getStaff(req);
  if (!ctx) return publicError(res, 401, 'No autorizado');

  try {
    if (req.method === 'GET') {
      if (req.query?.id) {
        const job = await ownJob(req.query.id, ctx.tenantId);
        if (!job) return publicError(res, 404, 'Pedido no encontrado');
        const { data: events } = await supabase
          .from('print_job_events').select('*').eq('job_id', job.id).order('created_at', { ascending: true });
        let previewUrl = null;
        if (job.file_path) {
          const { data } = await supabase.storage.from(BUCKET).createSignedUrl(job.file_path, 3600);
          previewUrl = data?.signedUrl || null;
        }
        return res.status(200).json({ job, events: events || [], previewUrl, trackUrl: trackUrl(job.public_token) });
      }

      let q = supabase
        .from('print_jobs')
        .select('id, job_number, status, client_name, client_phone, client_email, description, file_name, file_size_bytes, file_check, deadline_business_days, created_at, updated_at')
        .eq('tenant_id', ctx.tenantId)
        .order('created_at', { ascending: false })
        .limit(300);
      if (req.query?.status && STATUSES.includes(req.query.status)) q = q.eq('status', req.query.status);
      const { data, error } = await q;
      if (error) throw error;
      return res.status(200).json(data || []);
    }

    if (req.method !== 'POST') return publicError(res, 405, 'Method not allowed');

    const b = req.body || {};
    const job = await ownJob(b.id, ctx.tenantId);
    if (!job) return publicError(res, 404, 'Pedido no encontrado');

    let args;
    let mailType = null;
    if (b.action === 'confirm') {
      const days = Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > 60) {
        return publicError(res, 400, 'Indicá el plazo en días hábiles (1 a 60)');
      }
      if (!job.file_path) return publicError(res, 409, 'El pedido todavía no tiene archivo');
      args = { p_status: 'confirmado', p_note: `Confirmado a cliente · plazo ${days} días hábiles`, p_obs: null, p_days: days };
      mailType = 'confirmado';
    } else if (b.action === 'return') {
      const obs = cleanString(b.observations, 1000);
      if (!obs) return publicError(res, 400, 'Las observaciones son obligatorias para devolver la imagen');
      args = { p_status: 'devuelto', p_note: obs, p_obs: obs, p_days: null };
      mailType = 'devuelto';
    } else if (b.action === 'status') {
      if (!STATUSES.includes(b.status)) return publicError(res, 400, 'Estado no válido');
      args = { p_status: b.status, p_note: cleanString(b.note, 500) || null, p_obs: null, p_days: null };
    } else {
      return publicError(res, 400, 'Acción no válida');
    }

    const { data: updated, error } = await supabase.rpc('print_job_set_status', {
      p_job: job.id, p_actor: `staff:${ctx.userId}`, ...args,
    });
    if (error) {
      if (error.code === '23514') {
        return publicError(res, 400, 'Para devolver la imagen hay que cargar observaciones (usá "Devolver imagen")');
      }
      throw error;
    }

    let mailError = null;
    if (mailType) {
      try {
        await sendJobMail(mailType, updated);
        await logEvent(updated, 'mail', `Mail "${mailType}" enviado a ${updated.client_email}`);
      } catch (e) {
        mailError = e.message || String(e);
        console.error('print mail error:', mailError);
        await logEvent(updated, 'mail', `Falló mail "${mailType}": ${mailError.slice(0, 200)}`);
      }
    }
    return res.status(200).json({ job: updated, mailError });
  } catch (e) {
    console.error('print-admin error:', e.message || e);
    return publicError(res, 500, 'No se pudo procesar la solicitud');
  }
};
