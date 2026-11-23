// api/storefront.js
// Datos públicos de una tienda (branding + catálogo) por slug de tenant.
// Solo lectura, sin auth. Alimenta el storefront multitenant (tienda.html).

const { createClient } = require('@supabase/supabase-js');
const { applyCors, sendOptions, publicError, cleanString } = require('./_utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return sendOptions(req, res, 'GET, OPTIONS');
  if (req.method !== 'GET') return publicError(res, 405, 'Method not allowed');

  const slug = cleanString(req.query.tenant, 63);
  // Resolución alternativa por dominio propio (hostname). Permite que cada tenant
  // conecte su propio dominio (tenants.custom_domain) sin hardcodear nada.
  const rawHost = cleanString(req.query.host, 255);
  const host = rawHost ? rawHost.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '') : '';
  if (!slug && !host) return publicError(res, 400, 'tenant o host requerido');

  try {
    let tq = supabase
      .from('tenants')
      .select('id, slug, name, primary_color, secondary_color, logo_url, default_shipping_cost, active')
      .eq('active', true);
    tq = slug ? tq.eq('slug', slug) : tq.in('custom_domain', [host, 'www.' + host]);
    const { data: tenant, error: tErr } = await tq.maybeSingle();
    if (tErr) throw tErr;
    if (!tenant) return publicError(res, 404, 'Tienda no encontrada');

    const baseCols = 'name, slug, category, price, units_per_set, unit_label, material, size_description, elaboration_days, notes';
    const productsQuery = cols => {
      let q = supabase.from('products').select(cols).eq('tenant_id', tenant.id).eq('active', true);
      // ?category=Regalos → solo esa categoría (lo usa regalos.atumaneragraf.com)
      const cat = cleanString(req.query.category, 60);
      if (cat) q = q.eq('category', cat);
      return q.order('price', { ascending: true });
    };
    // `options` (config del editor de regalos) solo existe tras la migración regalos_fase1.
    let { data: products, error: pErr } = await productsQuery(baseCols + ', options');
    if (pErr && pErr.code === '42703') ({ data: products, error: pErr } = await productsQuery(baseCols));
    if (pErr) throw pErr;

    // Matriz de precios y add-ons (migración product_price_matrix / product_addons).
    // Si las tablas todavía no existen (42P01) la tienda sigue igual que antes.
    const list = products || [];
    if (list.length) {
      const { data: idRows } = await supabase.from('products').select('id, slug').eq('tenant_id', tenant.id);
      const idBySlug = new Map((idRows || []).map(r => [r.slug, r.id]));
      const { data: mRows, error: mErr } = await supabase
        .from('product_price_matrix')
        .select('product_id, option_group, option_value, quantity, unit, price')
        .eq('tenant_id', tenant.id);
      const { data: aRows, error: aErr } = await supabase
        .from('product_addons')
        .select('product_id, name, kind, amount, notice, sort_order')
        .eq('tenant_id', tenant.id)
        .eq('active', true)
        .order('sort_order', { ascending: true });
      const okM = !mErr || mErr.code !== '42P01';
      const okA = !aErr || aErr.code !== '42P01';
      if (mErr && okM) console.error('storefront matrix:', mErr.message);
      if (aErr && okA) console.error('storefront addons:', aErr.message);
      for (const p of list) {
        const pid = idBySlug.get(p.slug);
        p.matrix = okM ? (mRows || []).filter(r => r.product_id === pid).map(({ product_id, ...rest }) => rest) : [];
        p.addons = okA ? (aRows || []).filter(r => r.product_id === pid).map(({ product_id, ...rest }) => rest) : [];
      }
    }

    return res.status(200).json({
      tenant: {
        slug: tenant.slug,
        name: tenant.name,
        primary_color: tenant.primary_color || '#00AEEF',
        secondary_color: tenant.secondary_color || '#EC008C',
        logo_url: tenant.logo_url || null,
        default_shipping_cost: tenant.default_shipping_cost || 0,
      },
      products: products || [],
    });
  } catch (e) {
    console.error('storefront error:', e);
    return publicError(res, 500, 'No se pudo cargar la tienda');
  }
};
