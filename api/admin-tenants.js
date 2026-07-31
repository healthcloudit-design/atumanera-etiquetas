// api/admin-tenants.js
// GET  → lista de tenants
// POST → crear tenant
// PUT  → actualizar configuración de un tenant
// Solo platform_admins.

const { applyCors, sendOptions, publicError, cleanString } = require('./_utils');
const { supabaseAdmin, requirePlatformAdmin, slugify } = require('./_admin');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return sendOptions(req, res, 'GET, POST, PUT, OPTIONS');

  const admin = await requirePlatformAdmin(req);
  if (!admin) return publicError(res, 401, 'No autorizado');

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin
        .from('tenants')
        .select('id, slug, name, primary_color, secondary_color, logo_url, custom_domain, custom_domain_verified, mp_public_key, andreani_contract, default_shipping_cost, active, created_at')
        .order('created_at', { ascending: true });
      if (error) throw error;

      // contadores por tenant (productos y pedidos)
      const withCounts = await Promise.all((data || []).map(async (t) => {
        const [{ count: products }, { count: orders }] = await Promise.all([
          supabaseAdmin.from('products').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
          supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
        ]);
        return { ...t, products_count: products || 0, orders_count: orders || 0 };
      }));
      return res.status(200).json(withCounts);
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const name = cleanString(b.name, 120);
      const slug = slugify(b.slug || b.name);
      if (!name || !slug) return publicError(res, 400, 'Nombre y slug requeridos');

      const insert = {
        slug,
        name,
        primary_color: cleanString(b.primary_color, 20) || '#00AEEF',
        secondary_color: cleanString(b.secondary_color, 20) || '#EC008C',
        custom_domain: cleanString(b.custom_domain, 120) || null,
        default_shipping_cost: Math.max(0, Math.round(Number(b.default_shipping_cost) || 0)),
        active: b.active !== false,
      };

      const { data, error } = await supabaseAdmin.from('tenants').insert(insert).select().single();
      if (error) {
        if (error.code === '23505') return publicError(res, 409, 'Ya existe un tenant con ese slug o dominio');
        throw error;
      }
      return res.status(200).json(data);
    }

    if (req.method === 'PUT') {
      const b = req.body || {};
      if (!b.id) return publicError(res, 400, 'id requerido');

      const updates = {};
      for (const k of ['name', 'primary_color', 'secondary_color', 'logo_url', 'custom_domain', 'andreani_contract', 'mp_public_key']) {
        if (b[k] !== undefined) updates[k] = b[k] === null ? null : cleanString(b[k], 500);
      }
      if (b.default_shipping_cost !== undefined) updates.default_shipping_cost = Math.max(0, Math.round(Number(b.default_shipping_cost) || 0));
      if (b.active !== undefined) updates.active = !!b.active;

      const { data, error } = await supabaseAdmin.from('tenants').update(updates).eq('id', b.id).select().single();
      if (error) {
        if (error.code === '23505') return publicError(res, 409, 'Slug o dominio ya en uso');
        throw error;
      }
      return res.status(200).json(data);
    }

    return publicError(res, 405, 'Method not allowed');
  } catch (e) {
    console.error('admin-tenants error:', e);
    return publicError(res, 500, 'Error procesando la solicitud');
  }
};
