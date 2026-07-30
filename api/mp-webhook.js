// api/mp-webhook.js
// Recibe notificaciones de Mercado Pago y actualiza el estado del pedido

const { MercadoPagoConfig, Payment } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');
const { publicError, isUuid } = require('./_utils');

const mp = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return publicError(res, 405, 'Method not allowed');

  try {
    const { type, data } = req.body;

    // Solo nos interesan notificaciones de pagos
    if (type !== 'payment') return res.status(200).json({ ok: true });

    const payment = new Payment(mp);
    const paymentData = await payment.get({ id: data.id });

    const orderId = paymentData.external_reference;
    if (!isUuid(orderId)) return res.status(200).json({ ok: true });

    const mpStatus = paymentData.status; // approved | pending | rejected | cancelled

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, total, status')
      .eq('id', orderId)
      .single();

    if (orderError || !order) return res.status(200).json({ ok: true });

    const paidCents = Math.round(Number(paymentData.transaction_amount || 0) * 100);
    const amountMatches = Math.abs(paidCents - Number(order.total || 0)) <= 1;
    if (mpStatus === 'approved' && !amountMatches) {
      console.error(`Payment amount mismatch for order ${orderId}: payment=${paidCents}, order=${order.total}`);
      return res.status(200).json({ ok: true });
    }

    // Mapear status de MP a nuestros estados
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
      .update({
        mp_payment_id: String(paymentData.id),
        mp_status: mpStatus,
        status: orderStatus,
      })
      .eq('id', orderId);

    console.log(`Order ${orderId} updated to ${orderStatus} (MP: ${mpStatus})`);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Webhook error:', err);
    return publicError(res, 500, 'Webhook error');
  }
};
