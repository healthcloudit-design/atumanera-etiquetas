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
  if (!slug) return publicError(res, 400, 'tenant requerido');

  try {
    const { data: tenant, error: tErr } = await supabase
      .from('tenants')
      .select('id, slug, name, primary_color, secondary_color, logo_url, default_shipping_cost, active')
      .eq('slug', slug)
      .eq('active', true)
      .maybeSingle();
    if (tErr) throw tErr;
    if (!tenant) return publicError(res, 404, 'Tienda no encontrada');

    const { data: products, error: pErr } = await supabase
      .from('products')
      .select('name, slug, category, price, units_per_set, unit_label, material, size_description, elaboration_days, notes')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('price', { ascending: true });
    if (pErr) throw pErr;

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
