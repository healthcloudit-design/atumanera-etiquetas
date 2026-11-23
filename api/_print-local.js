// api/_print-local.js
// Alta de pedidos cargados por el taller en el local (Impresiones / Etiquetas / A medida).
// Entran al panel de Impresiones ya confirmados, con su plazo, y si el cliente dejó
// email le llega el mail de confirmación con el link de seguimiento.
// El precio lo calcula el servidor (misma matriz que la tienda); el taller puede
// cambiar el total (descuento, ajuste) y queda registrado el precio de lista.

const crypto = require('crypto');
const { cleanString, cleanEmail, cleanPhone } = require('./_utils');
const { priceSelection } = require('./_pricing');
const { supabase, sendJobMail, logEvent, trackUrl, BUCKET } = require('./_print');

const PAYMENTS = ['efectivo', 'transferencia', 'mercadopago_local', 'pendiente'];
const KINDS = ['impresion', 'etiquetas', 'medida'];
const EXT_MIME = { jpg: 'image/jpeg', png: 'image/png', tif: 'image/tiff', webp: 'image/webp', pdf: 'application/pdf' };
const MAX_TOTAL = 100000000; // $1.000.000 en centavos

class InputError extends Error {}
function bad(msg) { throw new InputError(msg); }

async function getProduct(tenantId, slug) {
  const s = cleanString(slug, 120);
  if (!s) bad('Elegí un producto');
  const { data, error } = await supabase
    .from('products')
    .select('id, name, slug, price, units_per_set, unit_label')
    .eq('tenant_id', tenantId).eq('slug', s).eq('active', true)
    .maybeSingle();
  if (error) throw error;
  if (!data) bad('Producto no encontrado');
  return data;
}

// Devuelve { total, description, detail } según el tipo de pedido.
async function quote(tenantId, b) {
  if (b.kind === 'impresion') {
    const p = await getProduct(tenantId, b.productSlug);
    const [mRes, aRes] = await Promise.all([
      supabase.from('product_price_matrix')
        .select('option_group, option_value, quantity, unit, price')
        .eq('tenant_id', tenantId).eq('product_id', p.id),
      supabase.from('product_addons')
        .select('name, kind, amount')
        .eq('tenant_id', tenantId).eq('product_id', p.id).eq('active', true),
    ]);
    if (mRes.error) throw mRes.error;
    if (aRes.error) throw aRes.error;
    if (!mRes.data || !mRes.data.length) bad('Ese producto no tiene lista de precios');

    const pj = b.printJob && typeof b.printJob === 'object' ? b.printJob : {};
    const options = {};
    for (const [k, v] of Object.entries(pj.options || {})) {
      const kk = cleanString(k, 30), vv = cleanString(v, 80);
      if (kk && vv) options[kk] = vv;
    }
    const units = Number.parseInt(pj.units, 10);
    const sel = {
      options,
      quantity: Number.parseInt(pj.quantity, 10) || null,
      widthCm: Number(pj.widthCm),
      heightCm: Number(pj.heightCm),
      units: Number.isInteger(units) ? units : null,
      addons: Array.isArray(pj.addons) ? pj.addons.map(a => cleanString(a, 60)).filter(Boolean).slice(0, 10) : [],
    };
    let r;
    try { r = priceSelection(mRes.data, aRes.data || [], sel); } catch (e) { bad(e.message); }
    const withSize = r.area !== null;
    const perUnit = r.addons.some(x => (aRes.data || []).some(a => a.name === x.name && a.kind === 'per_unit'));
    const summary = [
      ...Object.values(options),
      r.units ? `${r.units} u.` : null,
      withSize ? `${sel.widthCm}x${sel.heightCm} cm` : null,
      ...r.addons.map(a => a.name + (perUnit && a.name && sel.units ? '' : '')),
    ].filter(Boolean).join(' · ');
    return {
      total: r.unitTotal,
      description: `${p.name} · ${summary}`,
      detail: {
        kind: 'impresion', product: p.slug, options, quantity: r.units,
        widthCm: withSize ? sel.widthCm : null, heightCm: withSize ? sel.heightCm : null, area: r.area,
        units: perUnit ? sel.units : null, basePrice: r.basePrice, addons: r.addons,
      },
    };
  }

  if (b.kind === 'etiquetas') {
    const p = await getProduct(tenantId, b.productSlug);
    const qty = Number.parseInt(b.qty, 10);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) bad('La cantidad tiene que ser entre 1 y 100');
    const text = cleanString(b.text, 120);
    if (!text) bad('Escribí el texto de la etiqueta');
    const unit = Number(p.price) || 0;
    const per = p.units_per_set ? ` (${qty * Number(p.units_per_set)} ${p.unit_label || 'unidades'})` : '';
    return {
      total: unit * qty,
      description: `${p.name} · "${text}" · ${qty} ${qty === 1 ? 'pack' : 'packs'}${per}`,
      detail: { kind: 'etiquetas', product: p.slug, text, qty, unitPrice: unit },
    };
  }

  // A medida: descripción y precio los pone el taller
  const description = cleanString(b.description, 1000);
  if (!description) bad('Describí el trabajo');
  return { total: null, description, detail: { kind: 'medida' } };
}

async function createLocalJob(ctx, b) {
  if (!KINDS.includes(b.kind)) bad('Tipo de pedido no válido');
  const name = cleanString(b.clientName, 120);
  if (!name) bad('Falta el nombre del cliente');
  const phone = cleanPhone(b.clientPhone) || '';
  let email = '';
  if (b.clientEmail && String(b.clientEmail).trim()) {
    email = cleanEmail(b.clientEmail);
    if (!email) bad('El email no es válido');
  }
  if (!PAYMENTS.includes(b.paymentMethod)) bad('Elegí cómo pagó el cliente');
  const days = Number(b.days);
  if (!Number.isInteger(days) || days < 1 || days > 60) bad('Indicá el plazo en días hábiles (1 a 60)');

  const q = await quote(ctx.tenantId, b);
  let total = q.total;
  const hasOverride = b.totalCents !== undefined && b.totalCents !== null && b.totalCents !== '';
  if (hasOverride) {
    const t = Number(b.totalCents);
    if (!Number.isInteger(t) || t < 0 || t > MAX_TOTAL) bad('El total no es válido');
    if (total !== null && t !== total) q.detail.listTotal = total;   // queda el precio de lista
    total = t;
  }
  if (total === null) bad('Indicá el precio del trabajo');
  q.detail.total = total;
  q.detail.payment = b.paymentMethod;

  let link = null;
  if (b.link && String(b.link).trim()) {
    try {
      const u = new URL(String(b.link).trim());
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocolo');
      link = u.toString().slice(0, 500);
    } catch (_) { bad('El link de descarga no es válido'); }
  }
  const pendRe = new RegExp(`^${ctx.tenantId}/pending/\\d{8}/[0-9a-f-]{36}-print\\.(jpg|png|tif|webp|pdf)$`);
  const pending = typeof b.file === 'string' && pendRe.test(b.file) ? b.file : null;
  if (b.file && !pending) bad('El archivo no es válido. Volvé a subirlo.');

  const { data: job, error } = await supabase
    .from('print_jobs')
    .insert({
      tenant_id: ctx.tenantId,
      source: 'local',
      status: 'confirmado',
      deadline_business_days: days,
      client_name: name,
      client_phone: phone,
      client_email: email,
      description: q.description,
      external_link: link,
      total_cents: total,
      payment_method: b.paymentMethod,
      price_detail: q.detail,
    })
    .select('*')
    .single();
  if (error) throw error;

  const actor = `staff:${ctx.userId}`;
  const events = [
    { job_id: job.id, tenant_id: job.tenant_id, kind: 'creado', actor, note: 'Pedido cargado en el local' },
    { job_id: job.id, tenant_id: job.tenant_id, kind: 'status', actor, to_status: 'confirmado', note: `Confirmado en el local · plazo ${days} días hábiles` },
  ];

  let finalJob = job;
  if (pending) {
    const ext = pending.split('.').pop();
    const to = `${ctx.tenantId}/${job.id}/${crypto.randomUUID()}.${ext}`;
    const { error: mvErr } = await supabase.storage.from(BUCKET).move(pending, to);
    const filePath = mvErr ? pending : to;
    if (mvErr) console.error('local job move', pending, mvErr.message);
    const { data: upd, error: uErr } = await supabase
      .from('print_jobs')
      .update({ file_path: filePath, file_name: cleanString(b.fileName, 200) || to.split('/').pop(), file_mime: EXT_MIME[ext] || null })
      .eq('id', job.id).select('*').single();
    if (uErr) console.error('local job file update', uErr.message); else finalJob = upd;
    events.push({ job_id: job.id, tenant_id: job.tenant_id, kind: 'archivo_subido', actor, note: cleanString(b.fileName, 200) || 'Archivo cargado en el local' });
  }
  const { error: evErr } = await supabase.from('print_job_events').insert(events);
  if (evErr) console.error('local job events', evErr.message);

  let mailError = null, mailSent = false;
  if (email) {
    try {
      await sendJobMail('confirmado', finalJob);
      mailSent = true;
      await logEvent(finalJob, 'mail', `Mail "confirmado" enviado a ${email}`);
    } catch (e) {
      mailError = e.message || String(e);
      console.error('local job mail', mailError);
      await logEvent(finalJob, 'mail', `Falló mail "confirmado": ${mailError.slice(0, 200)}`);
    }
  }
  return { job: finalJob, trackUrl: trackUrl(finalJob.public_token), mailSent, mailError };
}

module.exports = { createLocalJob, InputError };
