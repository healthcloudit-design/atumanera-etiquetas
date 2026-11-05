// api/_print.js
// Helpers compartidos del módulo Impresiones / Plotter.
// Tablas: print_jobs, print_job_events (ver supabase/print_jobs.sql).

const { createClient } = require('@supabase/supabase-js');
const { isUuid } = require('./_utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const BUCKET = 'print-files';
const MAX_BYTES = 52428800; // 50 MB (máximo plan Free)
const MIMES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/tiff': 'tif',
  'image/webp': 'webp', 'application/pdf': 'pdf',
};
const STATUSES = [
  'enviado', 'devuelto', 'confirmado', 'en_imprenta',
  'recibido_imprenta', 'entregado', 'completado',
];
const TOKEN_RE = /^[0-9a-f]{64}$/;

function trackUrl(token) {
  const base = process.env.PRINT_TRACK_BASE || 'https://regalos.atumaneragraf.com/seguimiento?t=';
  return `${base}${token}`;
}

// Staff del tenant (JWT de Supabase Auth + fila en tenant_users).
async function getStaff(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: mems } = await supabase
    .from('tenant_users')
    .select('tenant_id, role')
    .eq('user_id', data.user.id);
  if (!mems || !mems.length) return null;
  return { userId: data.user.id, tenantId: mems[0].tenant_id, role: mems[0].role };
}

function actorLabel(actor) {
  if (actor === 'cliente') return 'Cliente';
  if (actor === 'sistema') return 'Sistema';
  if (String(actor).startsWith('staff:')) return 'Taller';
  return 'Otro';
}

async function logEvent(job, kind, note) {
  const { error } = await supabase.from('print_job_events').insert({
    job_id: job.id, tenant_id: job.tenant_id, kind, note, actor: 'sistema',
  });
  if (error) console.error('print event error:', error.message);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function sendEmail({ to, subject, text, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY no configurada');
  const payload = {
    from: process.env.PRINT_MAIL_FROM || 'A tu manera Gráfica <impresiones@atumaneragraf.com>',
    to: [to], subject, text, html,
  };
  if (replyTo) payload.reply_to = replyTo;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Mails al cliente. Solo 'confirmado' y 'devuelto' (los cambios manuales de estado no mandan mail).
async function sendJobMail(type, job) {
  const url = trackUrl(job.public_token);
  const n = job.job_number;
  let subject;
  let lines;
  if (type === 'confirmado') {
    subject = `Tu pedido #${n} está en marcha`;
    lines = [
      `Hola ${job.client_name}, recibimos tu archivo y ya lo estamos trabajando.`,
      `Tu pedido se finaliza en ${job.deadline_business_days} días hábiles.`,
      `Podés seguir el estado acá: ${url}`,
    ];
  } else if (type === 'devuelto') {
    subject = `Necesitamos un ajuste en tu archivo (pedido #${n})`;
    lines = [
      `Hola ${job.client_name}, revisamos tu archivo y necesita un ajuste:`,
      job.observations,
      `Subí una nueva versión desde este link: ${url}`,
    ];
  } else {
    throw new Error(`Tipo de mail desconocido: ${type}`);
  }
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">`
    + lines.map(l => `<p>${escapeHtml(l).replace(/\n/g, '<br>')}</p>`).join('')
    + `<p style="color:#888;font-size:12px">A tu manera Gráfica</p></div>`;
  return sendEmail({
    to: job.client_email,
    subject,
    text: lines.join('\n\n'),
    html,
    replyTo: process.env.PRINT_MAIL_REPLY_TO || undefined,
  });
}

module.exports = {
  supabase, getStaff, logEvent, sendJobMail, actorLabel, trackUrl,
  BUCKET, MAX_BYTES, MIMES, STATUSES, TOKEN_RE,
};
