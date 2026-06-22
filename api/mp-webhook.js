// api/mp-webhook.js
// Recibe notificaciones de Mercado Pago y actualiza el estado del pedido

const { MercadoPagoConfig, Payment } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');

const mp = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { type, data } = req.body;

    // Solo nos interesan notificaciones de pagos
    if (type !== 'payment') return res.status(200).json({ ok: true });

    const payment = new Payment(mp);
    const paymentData = await payment.get({ id: data.id });

    const orderId = paymentData.external_reference;
    const mpStatus = paymentData.status; // approved | pending | rejected | cancelled

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
    return res.status(500).json({ error: err.message });
  }
};
