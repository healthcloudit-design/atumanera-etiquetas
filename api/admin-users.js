// api/admin-users.js
// GET  ?tenant_id=… → usuarios de un tenant (con email)
// POST → crear usuario (Supabase Auth) y asignarlo a un tenant con rol
// Solo platform_admins.

const { applyCors, sendOptions, publicError, cleanEmail, isUuid } = require('./_utils');
const { supabaseAdmin, requirePlatformAdmin } = require('./_admin');

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
        .from('tenant_users')
        .select('user_id, role, created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: true });
      if (error) throw error;

      const result = await Promise.all((data || []).map(async (row) => {
        const { data: u } = await supabaseAdmin.auth.admin.getUserById(row.user_id);
        return { user_id: row.user_id, role: row.role, created_at: row.created_at, email: u?.user?.email || null };
      }));
      return res.status(200).json(result);
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const email = cleanEmail(b.email);
      const password = String(b.password || '');
      const role = ['admin', 'staff'].includes(b.role) ? b.role : 'staff';
      const tenantId = b.tenant_id;

      if (!email || password.length < 8) return publicError(res, 400, 'Email y contraseña (min 8) requeridos');
      if (!isUuid(tenantId)) return publicError(res, 400, 'tenant_id invalido');

      const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (cErr) return publicError(res, 400, cErr.message || 'No se pudo crear el usuario');

      const { error: mErr } = await supabaseAdmin
        .from('tenant_users')
        .insert({ user_id: created.user.id, tenant_id: tenantId, role });
      if (mErr) {
        // rollback del usuario si falla la membresía
        await supabaseAdmin.auth.admin.deleteUser(created.user.id).catch(() => {});
        throw mErr;
      }

      return res.status(200).json({ ok: true, user_id: created.user.id, email, role });
    }

    return publicError(res, 405, 'Method not allowed');
  } catch (e) {
    console.error('admin-users error:', e);
    return publicError(res, 500, 'Error procesando la solicitud');
  }
};
