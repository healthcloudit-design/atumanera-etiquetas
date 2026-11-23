// api/mp-webhook.js
// Recibe notificaciones de Mercado Pago y actualiza el estado del pedido.
// El tenant viene en el query (?tenant=<slug>) que setea create-preference,
// para usar el ACCESS TOKEN correcto (por tenant) al consultar el pago.

const { MercadoPagoConfig, Payment } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');
const { publicError, isUuid } = require('./_utils');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function getTenantBySlug(slug) {
  if (!slug) return null;
  const { data } = await supabase.from('tenants').select('id, slug').eq('slug', slug).maybeSingle();
  return data || null;
}
async function getTenantSecret(tenantId, name) {
  const { data, error } = await supabase.rpc('get_tenant_secret', { p_tenant: tenantId, p_name: name });
  if (error) { console.error('get_tenant_secret', name, error.message); return null; }
  return data || null;
}

const PRINT_MIME = { jpg: 'image/jpeg', png: 'image/png', tif: 'image/tiff', webp: 'image/webp', pdf: 'application/pdf' };

// Un print_job por ítem de impresión del pedido. Idempotente: si ya existe para
// ese order_item no se crea otro (Mercado Pago repite los avisos).
async function createPrintJobs(order) {
  const { data: items, error } = await supabase
    .from('order_items')
    .select('id, product_name, design_text, design, files')
    .eq('order_id', order.id);
  if (error) throw error;

  for (const it of items || []) {
    if (!it.design || it.design.kind !== 'print') continue;
    const { data: exists } = await supabase.from('print_jobs').select('id').eq('order_item_id', it.id).maybeSingle();
    if (exists) continue;

    const files = it.files || {};
    const prefix = 'storage:print-files/';
    const filePath = typeof files.print === 'string' && files.print.startsWith(prefix) ? files.print.slice(prefix.length) : null;
    const ext = filePath ? filePath.split('.').pop().toLowerCase() : null;

    const { data: job, error: jErr } = await supabase
      .from('print_jobs')
      .insert({
        tenant_id: order.tenant_id,
        source: 'tienda',
        order_id: order.id,
        order_item_id: it.id,
        client_name: order.buyer_name || '(sin nombre)',
        client_phone: order.buyer_phone || '',
        client_email: order.buyer_email || '',
        description: `${it.product_name} · ${it.design_text} (pagado en la tienda)`,
        file_path: filePath,
        file_name: files.fileName || (filePath ? filePath.split('/').pop() : null),
        file_mime: ext ? (PRINT_MIME[ext] || null) : null,
        external_link: it.design.link || files.link || null,
        price_detail: it.design,
      })
      .select('id, tenant_id')
      .single();
    if (jErr) {
      if (jErr.code !== '23505') console.error('print job insert', it.id, jErr.message);  // 23505 = ya existía
      continue;
    }
    const { error: evErr } = await supabase.from('print_job_events').insert({
      job_id: job.id, tenant_id: job.tenant_id, kind: 'creado', actor: 'tienda', note: 'Pedido pagado en la tienda',
    });
    if (evErr) console.error('print event', job.id, evErr.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return publicError(res, 405, 'Method not allowed');

  try {
    const { type, data } = req.body;
    if (type !== 'payment') return res.status(200).json({ ok: true });

    const tenantSlug = String(req.query?.tenant || '').trim().toLowerCase();
    const tenant = await getTenantBySlug(tenantSlug);

    // Token del tenant (Vault) con fallback a env
    const accessToken = (tenant && await getTenantSecret(tenant.id, 'mp_access_token')) || process.env.MP_ACCESS_TOKEN;
    if (!accessToken) return res.status(200).json({ ok: true });

    const mp = new MercadoPagoConfig({ accessToken });
    const payment = new Payment(mp);
    const paymentData = await payment.get({ id: data.id });

    const orderId = paymentData.external_reference;
    if (!isUuid(orderId)) return res.status(200).json({ ok: true });

    const mpStatus = paymentData.status; // approved | pending | rejected | cancelled

    // Buscar el pedido acotado al tenant (defensa en profundidad)
    let orderQuery = supabase.from('orders').select('id, total, status, tenant_id, buyer_name, buyer_email, buyer_phone').eq('id', orderId);
    if (tenant?.id) orderQuery = orderQuery.eq('tenant_id', tenant.id);
    const { data: order, error: orderError } = await orderQuery.single();
    if (orderError || !order) return res.status(200).json({ ok: true });

    const paidCents = Math.round(Number(paymentData.transaction_amount || 0) * 100);
    const amountMatches = Math.abs(paidCents - Number(order.total || 0)) <= 1;
    if (mpStatus === 'approved' && !amountMatches) {
      console.error(`Payment amount mismatch for order ${orderId}: payment=${paidCents}, order=${order.total}`);
      return res.status(200).json({ ok: true });
    }

    let orderStatus;
    switch (mpStatus) {
      case 'approved': orderStatus = 'paid'; break;
      case 'pending':
      case 'in_process': orderStatus = 'pending_payment'; break;
      case 'rejected':
      case 'cancelled': orderStatus = 'cancelled'; break;
      default: orderStatus = 'pending_payment';
    }

    await supabase
      .from('orders')
      .update({ mp_payment_id: String(paymentData.id), mp_status: mpStatus, status: orderStatus })
      .eq('id', orderId);

    console.log(`Order ${orderId} updated to ${orderStatus} (MP: ${mpStatus})`);

    // Productos de impresión pagados → trabajo en el panel de Impresiones.
    // Si falla no se corta el webhook (el pago ya quedó registrado).
    if (orderStatus === 'paid') {
      try { await createPrintJobs(order); }
      catch (e) { console.error('createPrintJobs', orderId, e.message || e); }
    }
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Webhook error:', err);
    return publicError(res, 500, 'Webhook error');
  }
};
