// api/create-preference.js
// Vercel Serverless Function — crea la preferencia de pago en Mercado Pago

const { MercadoPagoConfig, Preference } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');

const mp = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { buyer, items, shipping, cartItems } = req.body;

    // 1. Crear el pedido en Supabase
    const total = cartItems.reduce((acc, item) => acc + item.price, 0) + (shipping.cost || 0);

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        buyer_name: buyer.name,
        buyer_email: buyer.email,
        buyer_phone: buyer.phone || null,
        shipping_method: shipping.method,
        shipping_address: shipping.address || null,
        shipping_city: shipping.city || null,
        shipping_zip: shipping.zip || null,
        shipping_province: shipping.province || null,
        shipping_cost: shipping.cost || 0,
        total: total,
        status: 'pending_payment',
      })
      .select()
      .single();

    if (orderError) throw orderError;

    // 2. Insertar items del pedido
    const orderItems = cartItems.map(item => ({
      order_id: order.id,
      product_id: item.productId,
      product_name: item.product,
      design_text: item.text,
      design_font: item.font,
      design_text_color: item.textColor || '#1A1A1A',
      design_icon_index: item.iconIndex ?? null,
      design_position: item.position || 'left',
      design_border_color: item.borderColor || null,
      design_pulsera_color: item.pulseraColor || null,
      design_thumbnail_url: item.thumbnailUrl || null,
      quantity: item.qty,
      units_total: item.qty * item.unitsPerSet,
      unit_price: item.unitPrice,
      subtotal: item.price,
    }));

    await supabase.from('order_items').insert(orderItems);

    // 3. Crear preferencia en Mercado Pago
    const preference = new Preference(mp);
    const mpItems = cartItems.map(item => ({
      id: item.productId,
      title: `${item.product} — "${item.text}"`,
      quantity: item.qty,
      unit_price: item.unitPrice / 100, // MP usa pesos enteros
      currency_id: 'ARS',
    }));

    if (shipping.cost > 0) {
      mpItems.push({
        id: 'shipping',
        title: `Envío ${shipping.method}`,
        quantity: 1,
        unit_price: shipping.cost / 100,
        currency_id: 'ARS',
      });
    }

    const prefResult = await preference.create({
      body: {
        items: mpItems,
        payer: {
          name: buyer.name,
          email: buyer.email,
          phone: buyer.phone ? { number: buyer.phone } : undefined,
        },
        back_urls: {
          success: `${process.env.SITE_URL}/pago-exitoso?order=${order.id}`,
          failure: `${process.env.SITE_URL}/pago-fallido?order=${order.id}`,
          pending: `${process.env.SITE_URL}/pago-pendiente?order=${order.id}`,
        },
        auto_return: 'approved',
        external_reference: order.id,
        notification_url: `${process.env.SITE_URL}/api/mp-webhook`,
        statement_descriptor: 'A TU MANERA ETIQUETAS',
      }
    });

    // 4. Guardar preference_id en el pedido
    await supabase
      .from('orders')
      .update({ mp_preference_id: prefResult.id })
      .eq('id', order.id);

    return res.status(200).json({
      preferenceId: prefResult.id,
      initPoint: prefResult.init_point,
      orderId: order.id,
      orderNumber: order.order_number,
    });

  } catch (err) {
    console.error('Error creating preference:', err);
    return res.status(500).json({ error: err.message });
  }
};
