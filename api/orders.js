// api/orders.js
// GET  /api/orders        — lista todos los pedidos (solo admin)
// GET  /api/orders?id=xx  — detalle de un pedido
// PUT  /api/orders        — actualizar estado o tracking

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service key = bypass RLS
);

const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // token simple para el dashboard

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth simple con token
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    if (req.method === 'GET') {
      const { id, status } = req.query;

      if (id) {
        // Detalle de un pedido con sus items
        const { data: order } = await supabase
          .from('orders')
          .select('*, order_items(*)')
          .eq('id', id)
          .single();
        return res.status(200).json(order);
      }

      // Lista de pedidos con filtro opcional por estado
      let query = supabase
        .from('orders')
        .select(`
          id, order_number, buyer_name, buyer_email, buyer_phone,
          shipping_method, shipping_address, shipping_city, shipping_zip,
          shipping_province, shipping_cost, tracking_number, mp_status, total, status,
          created_at, updated_at,
          order_items(id, product_name, design_text, design_font,
            design_icon_index, design_thumbnail_url, quantity, units_total, subtotal)
        `)
        .order('created_at', { ascending: false });

      if (status) query = query.eq('status', status);

      const { data: orders } = await query;
      return res.status(200).json(orders || []);
    }

    if (req.method === 'PUT') {
      const { id, status, tracking_number } = req.body;
      if (!id) return res.status(400).json({ error: 'Falta id' });

      const updates = {};
      if (status) updates.status = status;
      if (tracking_number !== undefined) updates.tracking_number = tracking_number;

      const { data, error } = await supabase
        .from('orders')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return res.status(200).json(data);
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('Orders API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
