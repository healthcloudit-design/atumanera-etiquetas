// api/admin-secrets.js
// GET  ?tenant_id=… → nombres de secretos configurados (NUNCA los valores)
// POST → setear un secreto por tenant (guardado cifrado en Supabase Vault)
// Solo platform_admins.

const { applyCors, sendOptions, publicError, isUuid } = require('./_utils');
const { supabaseAdmin, requirePlatformAdmin } = require('./_admin');

// Secretos permitidos (van a Vault). La MP public key NO es secreta → se setea
// como campo del tenant vía admin-tenants (PUT mp_public_key).
const ALLOWED = ['mp_access_token', 'andreani_user', 'andreani_pass'];

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return sendOptions(req, res, 'GET, POST, OPTIONS');

  const admin = await requirePlatformAdmin(req);
  if (!admin) return publicError(res, 401, 'No autorizado');

  try {
    if (req.method === 'GET') {
      const tenantId = req.query.tenant_id;
      if (!isUuid(tenantId)) return publicError(res, 400, 'tenant_id invalido');

      const { data, error } = await supabaseAdmin
        .from('tenant_secrets')
        .select('name, created_at')
        .eq('tenant_id', tenantId);
      if (error) throw error;
      return res.status(200).json(data || []); // solo nombres
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const tenantId = b.tenant_id;
      const name = b.name;
      const value = String(b.value || '');

      if (!isUuid(tenantId)) return publicError(res, 400, 'tenant_id invalido');
      if (!ALLOWED.includes(name)) return publicError(res, 400, 'Nombre de secreto invalido');
      if (!value) return publicError(res, 400, 'Valor requerido');

      const { error } = await supabaseAdmin.rpc('set_tenant_secret', {
        p_tenant: tenantId,
        p_name: name,
        p_value: value,
      });
      if (error) throw error;

      return res.status(200).json({ ok: true });
    }

    return publicError(res, 405, 'Method not allowed');
  } catch (e) {
    console.error('admin-secrets error:', e);
    return publicError(res, 500, 'Error procesando la solicitud');
  }
};
