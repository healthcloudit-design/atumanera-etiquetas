// api/create-preference.js
// Crea un pedido y la preferencia de pago de Mercado Pago.

const { MercadoPagoConfig, Preference } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');
const {
  applyCors,
  sendOptions,
  publicError,
  getTenantSlug,
  cleanString,
  cleanEmail,
  cleanPhone,
  cents,
} = require('./_utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Lee un secreto del tenant desde Vault (o null si no está configurado).
async function getTenantSecret(tenantId, name) {
  const { data, error } = await supabase.rpc('get_tenant_secret', { p_tenant: tenantId, p_name: name });
  if (error) { console.error('get_tenant_secret', name, error.message); return null; }
  return data || null;
}

// NOTA: no hay productos "fallback" hardcodeados. Cada tenant solo puede vender
// productos que existan en su propia fila de la tabla `products`, a su precio real.
// Esto evita fugas entre tenants y precios desactualizados.

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return sendOptions(req, res, 'POST, OPTIONS');
  if (req.method !== 'POST') return publicError(res, 405, 'Method not allowed');

  try {
    const tenantSlug = getTenantSlug(req);
    const tenant = await getTenant(tenantSlug);
    if (!tenant) return publicError(res, 400, 'Comercio no valido');

    // Credenciales POR TENANT (Vault) con fallback a env para atumanera durante la transición
    const mpAccessToken = (await getTenantSecret(tenant.id, 'mp_access_token')) || process.env.MP_ACCESS_TOKEN;
    if (!mpAccessToken) return publicError(res, 400, 'El comercio no tiene medios de pago configurados');
    const andreaniCreds = {
      user: (await getTenantSecret(tenant.id, 'andreani_user')) || process.env.ANDREANI_USER,
      pass: (await getTenantSecret(tenant.id, 'andreani_pass')) || process.env.ANDREANI_PASS,
    };

    const { buyer = {}, shipping = {}, cartItems = [] } = req.body || {};

    if (!Array.isArray(cartItems) || cartItems.length === 0 || cartItems.length > 30) {
      return publicError(res, 400, 'Carrito invalido');
    }

    const buyerName = cleanString(buyer.name, 120);
    const buyerEmail = cleanEmail(buyer.email);
    const buyerPhone = cleanPhone(buyer.phone);
    if (!buyerName || !buyerEmail) return publicError(res, 400, 'Nombre y email requeridos');

    const shippingMethod = shipping.method === 'retiro' ? 'retiro' : 'andreani';
    const shippingZip = cleanString(shipping.zip, 12);
    if (shippingMethod === 'andreani' && !/^\d{4}$/.test(shippingZip || '')) {
      return publicError(res, 400, 'Codigo postal invalido');
    }

    const orderItems = await buildOrderItems(cartItems, tenant.id);
    const itemsSubtotal = orderItems.reduce((acc, item) => acc + item.subtotal, 0);
    const shippingCost = shippingMethod === 'andreani'
      ? await quoteShippingCents(shippingZip, tenant, andreaniCreds)
      : 0;
    const total = itemsSubtotal + shippingCost;

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        tenant_id: tenant.id,
        buyer_name: buyerName,
        buyer_email: buyerEmail,
        buyer_phone: buyerPhone,
        shipping_method: shippingMethod,
        shipping_address: shippingMethod === 'andreani' ? cleanString(shipping.address, 180) : null,
        shipping_city: shippingMethod === 'andreani' ? cleanString(shipping.city, 80) : null,
        shipping_zip: shippingMethod === 'andreani' ? shippingZip : null,
        shipping_province: shippingMethod === 'andreani' ? cleanString(shipping.province, 80) : null,
        shipping_cost: shippingCost,
        total,
        status: 'pending_payment',
      })
      .select()
      .single();

    if (orderError) throw orderError;

    // Mover miniaturas base64 al bucket privado 'designs' (F7). Si falla, se
    // conserva el data-URI para no romper el checkout.
    const rows = await Promise.all(orderItems.map(async (item, idx) => ({
      ...item,
      order_id: order.id,
      design_thumbnail_url: await storeThumbnail(tenant.id, order.id, idx, item.design_thumbnail_url),
    })));
    const { error: itemsError } = await supabase.from('order_items').insert(rows);
    if (itemsError) throw itemsError;

    const mp = new MercadoPagoConfig({ accessToken: mpAccessToken });
    const preference = new Preference(mp);
    const mpItems = orderItems.map(item => ({
      id: item.product_slug || item.product_id || item.product_name,
      title: `${item.product_name} - "${item.design_text}"`,
      quantity: item.quantity,
      unit_price: item.unit_price / 100,
      currency_id: 'ARS',
    }));

    if (shippingCost > 0) {
      mpItems.push({
        id: 'shipping',
        title: `Envio ${shippingMethod}`,
        quantity: 1,
        unit_price: shippingCost / 100,
        currency_id: 'ARS',
      });
    }

    const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
    const prefResult = await preference.create({
      body: {
        items: mpItems,
        payer: {
          name: buyerName,
          email: buyerEmail,
          phone: buyerPhone ? { number: buyerPhone } : undefined,
        },
        back_urls: {
          success: `${siteUrl}/pago-exitoso?order=${order.id}`,
          failure: `${siteUrl}/pago-fallido?order=${order.id}`,
          pending: `${siteUrl}/pago-pendiente?order=${order.id}`,
        },
        auto_return: 'approved',
        external_reference: order.id,
        notification_url: `${siteUrl}/api/mp-webhook?tenant=${encodeURIComponent(tenantSlug)}`,
        statement_descriptor: cleanString(tenant?.name || 'A TU MANERA', 22),
        metadata: { tenant_slug: tenantSlug },
      },
    });

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
    return publicError(res, 500, 'No se pudo crear el pago');
  }
};

// Sube una miniatura data-URI al bucket privado y devuelve la ruta de storage.
// Si el valor no es data-URI o falla, devuelve el valor original sin romper nada.
async function storeThumbnail(tenantId, orderId, idx, value) {
  if (typeof value !== 'string' || !value.startsWith('data:image')) return value || null;
  try {
    const m = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) return value;
    const contentType = m[1];
    const ext = (contentType.split('/')[1] || 'png').replace('+xml', '');
    const buffer = Buffer.from(m[2], 'base64');
    if (buffer.length > 5 * 1024 * 1024) return value; // >5MB: no subir
    const path = `${tenantId}/${orderId}/${idx}.${ext}`;
    const { error } = await supabase.storage.from('designs').upload(path, buffer, { contentType, upsert: true });
    if (error) { console.error('thumbnail upload', error.message); return value; }
    return `storage:designs/${path}`;
  } catch (e) {
    console.error('storeThumbnail', e.message);
    return value;
  }
}

async function getTenant(slug) {
  const { data, error } = await supabase
    .from('tenants')
    .select('id, slug, name, andreani_contract, default_shipping_cost')
    .eq('slug', slug)
    .eq('active', true)
    .maybeSingle();

  if (error && error.code !== '42P01') throw error;
  return data || null;
}

async function getProductsBySlug(slugs, tenantId) {
  if (!slugs.length) return new Map();

  // El filtro por tenant_id es OBLIGATORIO: un tenant solo puede resolver
  // sus propios productos. Sin esto, dos tenants con el mismo slug se pisan.
  const { data, error } = await supabase
    .from('products')
    .select('id, tenant_id, name, slug, price, units_per_set, unit_label, active')
    .in('slug', slugs)
    .eq('active', true)
    .eq('tenant_id', tenantId);
  if (error) throw error;

  return new Map((data || []).map(product => [product.slug, product]));
}

async function buildOrderItems(cartItems, tenantId) {
  const normalized = cartItems.map(item => ({
    productSlug: normalizeProductSlug(item.productSlug || item.productId || item.product),
    designText: cleanString(item.text, 60) || '(sin texto)',
    font: cleanString(item.font, 80) || 'Nunito',
    textColor: cleanString(item.textColor, 20) || '#1A1A1A',
    iconIndex: item.iconIndex === null || item.iconIndex === undefined ? null : Number(item.iconIndex),
    position: cleanString(item.position, 20) || 'left',
    borderColor: cleanString(item.borderColor, 20),
    pulseraColor: cleanString(item.pulseraColor, 20),
    thumbnailUrl: cleanString(item.thumbnailUrl, 250000),
    qty: Math.max(1, Math.min(10, Number.parseInt(item.qty, 10) || 1)),
  }));

  const slugs = [...new Set(normalized.map(item => item.productSlug).filter(Boolean))];
  const products = await getProductsBySlug(slugs, tenantId);

  return normalized.map(item => {
    const product = products.get(item.productSlug);
    if (!product) throw new Error(`Producto invalido: ${item.productSlug || 'sin slug'}`);

    const unitPrice = cents(product.price);
    return {
      product_id: product.id || null,
      product_slug: item.productSlug,
      product_name: cleanString(product.name, 120),
      design_text: item.designText,
      design_font: item.font,
      design_text_color: item.textColor,
      design_icon_index: Number.isInteger(item.iconIndex) && item.iconIndex >= 0 && item.iconIndex < 100 ? item.iconIndex : null,
      design_position: item.position,
      design_border_color: item.borderColor,
      design_pulsera_color: item.pulseraColor,
      design_thumbnail_url: item.thumbnailUrl,
      quantity: item.qty,
      units_total: item.qty * Number(product.units_per_set || 1),
      unit_price: unitPrice,
      subtotal: item.qty * unitPrice,
    };
  });
}

function normalizeProductSlug(value) {
  const raw = cleanString(value, 120);
  const aliases = {
    falletina: 'cintas-falletina',
    termo32: 'termo-32',
    termo49: 'termo-49',
    pulsera: 'pulseras-fluor',
    'Cintas Falletina': 'cintas-falletina',
    'Termoadhesivas x32': 'termo-32',
    'Termoadhesivas x49': 'termo-49',
    'Pulseras Fluor x30': 'pulseras-fluor',
  };
  if (!raw) return null;
  return aliases[raw] || raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function quoteShippingCents(zip, tenant, andreaniCreds = {}) {
  const fallback = cents(tenant?.default_shipping_cost || process.env.DEFAULT_SHIPPING_COST_CENTS || 0);
  const user = andreaniCreds.user;
  const pass = andreaniCreds.pass;
  if (!user || !pass) return fallback;

  const contrato = tenant?.andreani_contract || process.env.ANDREANI_CONTRATO;
  if (!contrato) return fallback;

  const baseUrl = 'https://apis.andreani.com';
  try {
    const authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    const authRes = await fetch(`${baseUrl}/login`, { method: 'GET', headers: { Authorization: authHeader } });
    if (!authRes.ok) return fallback;

    const token = authRes.headers.get('x-authorization-token') || authRes.headers.get('X-Authorization-token');
    if (!token) return fallback;

    const qs = buildQuery({
      cpDestino: zip,
      contrato,
      bultos: [{ kilos: 0.15, largoCm: 15, anchoCm: 10, altoCm: 2, volumen: 300, valorDeclarado: 10000 }],
    });
    const tarifaRes = await fetch(`${baseUrl}/v1/tarifas?${qs}`, {
      method: 'GET',
      headers: { 'x-authorization-token': token, 'Content-Type': 'application/json' },
    });
    if (!tarifaRes.ok) return fallback;

    const tarifa = await tarifaRes.json();
    const totalARS = Number.parseFloat(tarifa?.tarifaConIva?.total || tarifa?.tarifaSinIva?.total || 0);
    return totalARS > 0 ? Math.ceil(totalARS * 100) : fallback;
  } catch {
    return fallback;
  }
}

function buildQuery(params, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, idx) => parts.push(buildQuery(item, `${paramKey}[${idx}]`)));
    } else if (value !== null && typeof value === 'object') {
      parts.push(buildQuery(value, paramKey));
    } else if (value !== undefined && value !== null) {
      parts.push(`${encodeURIComponent(paramKey)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join('&');
}
