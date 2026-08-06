// api/tenant-orders.js
// Pedidos del tenant del usuario logueado (Supabase Auth JWT), con miniaturas
// firmadas (bucket privado). Lo consume el dashboard del dueño/staff.

const { createClient } = require('@supabase/supabase-js');
const { applyCors, sendOptions, publicError } = require('./_utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getUserTenant(req) {
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

async function signThumb(v) {
  if (typeof v === 'string' && v.startsWith('storage:designs/')) {
    const path = v.slice('storage:designs/'.length);
    const { data } = await supabase.storage.from('designs').createSignedUrl(path, 3600);
    return data?.signedUrl || null;
  }
  return v;
}
// Deriva la ruta del archivo de impresión (<idx>-print.jpg) desde la miniatura y la firma.
async function signPrint(v) {
  if (typeof v !== 'string' || !v.startsWith('storage:designs/')) return null;
  const path = v.slice('storage:designs/'.length);
  const printPath = path.replace(/\/([^/]+)\.[a-zA-Z0-9]+$/, '/$1-print.jpg');
  if (printPath === path) return null;
  const { data } = await supabase.storage.from('designs').createSignedUrl(printPath, 3600);
  return data?.signedUrl || null;
}

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return sendOptions(req, res, 'GET, OPTIONS');
  if (req.method !== 'GET') return publicError(res, 405, 'Method not allowed');

  const ctx = await getUserTenant(req);
  if (!ctx) return publicError(res, 401, 'No autorizado');

  try {
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, order_number, buyer_name, buyer_email, buyer_phone, shipping_method, shipping_address, shipping_city, shipping_zip, shipping_province, shipping_cost, tracking_number, mp_status, mp_payment_id, total, status, created_at, order_items(product_name, product_slug, design_text, design_font, design_border_color, design_thumbnail_url, quantity, units_total, unit_price, subtotal)')
      .eq('tenant_id', ctx.tenantId)
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw error;

    await Promise.all((orders || []).map(async (o) => {
      if (Array.isArray(o.order_items)) {
        await Promise.all(o.order_items.map(async (it) => {
          const raw = it.design_thumbnail_url;
          it.design_thumbnail_url = await signThumb(raw);
          it.design_print_url = await signPrint(raw);
        }));
      }
    }));

    return res.status(200).json(orders || []);
  } catch (e) {
    console.error('tenant-orders error:', e);
    return publicError(res, 500, 'No se pudieron cargar los pedidos');
  }
};
