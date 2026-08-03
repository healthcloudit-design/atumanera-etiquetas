// api/orders.js
// GET  /api/orders        — lista todos los pedidos (solo admin)
// GET  /api/orders?id=xx  — detalle de un pedido
// PUT  /api/orders        — actualizar estado o tracking

const { createClient } = require('@supabase/supabase-js');
const {
  applyCors,
  sendOptions,
  publicError,
  getTenantSlug,
  assertAdmin,
  cleanString,
  isUuid,
} = require('./_utils');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service key = bypass RLS
);

const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // token simple para el dashboard

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return sendOptions(req, res, 'GET, PUT, OPTIONS');

  // Auth simple con token
  if (!assertAdmin(req, ADMIN_TOKEN)) {
    return publicError(res, 401, 'No autorizado');
  }

  try {
    const tenant = await getTenant(getTenantSlug(req));
    if (!tenant) return publicError(res, 400, 'Comercio no valido');

    if (req.method === 'GET') {
      const { id, status } = req.query;

      if (id) {
        if (!isUuid(id)) return publicError(res, 400, 'Id invalido');
        // Detalle de un pedido con sus items (siempre acotado al tenant)
        const { data: order } = await supabase
          .from('orders')
          .select('*, order_items(*)')
          .eq('id', id)
          .eq('tenant_id', tenant.id)
          .single();
        await signThumbs(order);
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

      query = query.eq('tenant_id', tenant.id);
      if (status) query = query.eq('status', status);

      const { data: orders } = await query;
      await Promise.all((orders || []).map(signThumbs));
      return res.status(200).json(orders || []);
    }

    if (req.method === 'PUT') {
      const { id, status, tracking_number } = req.body;
      if (!isUuid(id)) return publicError(res, 400, 'Id invalido');

      const updates = {};
      if (status && ['pending_payment', 'paid', 'in_production', 'shipped', 'delivered', 'cancelled'].includes(status)) {
        updates.status = status;
      }
      if (tracking_number !== undefined) updates.tracking_number = cleanString(tracking_number, 80);

      const { data, error } = await supabase
        .from('orders')
        .update(updates)
        .eq('id', id)
        .eq('tenant_id', tenant.id)
        .select()
        .single();

      if (error) throw error;
      return res.status(200).json(data);
    }

    return publicError(res, 405, 'Method not allowed');

  } catch (err) {
    console.error('Orders API error:', err);
    return publicError(res, 500, 'No se pudieron cargar los pedidos');
  }
};

// Convierte rutas 'storage:designs/<path>' en URLs firmadas (1h). Deja pasar
// los data-URI base64 antiguos y las URLs http.
async function signThumb(value) {
  if (typeof value === 'string' && value.startsWith('storage:designs/')) {
    const path = value.slice('storage:designs/'.length);
    const { data } = await supabase.storage.from('designs').createSignedUrl(path, 3600);
    return data?.signedUrl || null;
  }
  return value;
}
async function signThumbs(order) {
  if (!order || !Array.isArray(order.order_items)) return order;
  await Promise.all(order.order_items.map(async (it) => {
    it.design_thumbnail_url = await signThumb(it.design_thumbnail_url);
  }));
  return order;
}

async function getTenant(slug) {
  const { data, error } = await supabase
    .from('tenants')
    .select('id, slug')
    .eq('slug', slug)
    .eq('active', true)
    .maybeSingle();

  if (error && error.code !== '42P01') throw error;
  return data || null;
}
