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

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return sendOptions(req, res, 'GET, OPTIONS');
  if (req.method !== 'GET') return publicError(res, 405, 'Method not allowed');

  const ctx = await getUserTenant(req);
  if (!ctx) return publicError(res, 401, 'No autorizado');

  try {
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, order_number, buyer_name, buyer_email, total, status, created_at, order_items(product_name, design_text, design_thumbnail_url, quantity)')
      .eq('tenant_id', ctx.tenantId)
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw error;

    await Promise.all((orders || []).map(async (o) => {
      if (Array.isArray(o.order_items)) {
        await Promise.all(o.order_items.map(async (it) => {
          it.design_thumbnail_url = await signThumb(it.design_thumbnail_url);
        }));
      }
    }));

    return res.status(200).json(orders || []);
  } catch (e) {
    console.error('tenant-orders error:', e);
    return publicError(res, 500, 'No se pudieron cargar los pedidos');
  }
};
