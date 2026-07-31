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
    let orderQuery = supabase.from('orders').select('id, total, status, tenant_id').eq('id', orderId);
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
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Webhook error:', err);
    return publicError(res, 500, 'Webhook error');
  }
};
