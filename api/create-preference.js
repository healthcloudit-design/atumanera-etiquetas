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
  buildParcel,
} = require('./_utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Lee un secreto del tenant desde Vault (o null si no está configurado).
async function getTenantSecret(tenantId, name) {
  const { data, error } = await supabase.rpc('get_tenant_secret', { p_tenant: tenantId, p_name: name });
  if (error) { console.error('get_tenant_secret', name, error.message); return null; }
  return data || null;
}

// Tarifas de motomensajería privada (GBA), en pesos. DEBEN coincidir con el cliente.
const MOTO_TARIFAS = {
  'CABA': 4490,
  'Avellaneda': 6490, 'San Martin': 6490, 'Tigre': 6490, 'Tres De Febrero': 6490, 'Vicente Lopez': 6490,
  'San Fernando': 4600, 'San Isidro': 4600,
  'San Miguel': 8690,
  'Almirante Brown': 9990, 'Berisso': 9990, 'Campana': 9990, 'Cañuelas': 9990, 'Del Viso': 9990,
  'Derqui': 9990, 'Ensenada': 9990, 'Escobar': 9990, 'Garín': 9990, 'General Rodriguez': 9990,
  'Guernica': 9990, 'Ingeniero Maschwitz': 9990, 'La Plata Centro': 9990, 'La Plata Norte': 9990,
  'La Plata Oeste': 9990, 'Lujan': 9990, 'Marcos Paz': 9990, 'Nordelta': 9990, 'Pilar': 9990,
  'San Vicente': 9990, 'Villa Rosa': 9990, 'Zarate': 9990, 'Berazategui': 9990,
  'Esteban Echeverria': 9990, 'Ezeiza': 9990, 'Florencio Varela': 9990, 'Hurlingham': 9990,
  'Ituzaingó': 9990, 'Jose C Paz': 9990, 'La Matanza Norte': 9990, 'La Matanza Sur': 9990,
  'Lanús': 9990, 'Lomas de Zamora': 9990, 'Malvinas Argentinas': 9990, 'Merlo': 9990,
  'Moreno': 9990, 'Moron': 9990, 'Quilmes': 9990,
};

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

    const shippingMethod = ['retiro', 'moto', 'andreani'].includes(shipping.method) ? shipping.method : 'andreani';
    const shippingZip = cleanString(shipping.zip, 12);
    if (shippingMethod === 'andreani' && !/^\d{4}$/.test(shippingZip || '')) {
      return publicError(res, 400, 'Codigo postal invalido');
    }
    const motoLocality = cleanString(shipping.locality || shipping.city, 80);
    if (shippingMethod === 'moto' && !(motoLocality in MOTO_TARIFAS)) {
      return publicError(res, 400, 'Localidad de envio invalida');
    }

    const orderItems = await buildOrderItems(cartItems, tenant.id);
    const itemsSubtotal = orderItems.reduce((acc, item) => acc + item.subtotal, 0);
    // Bulto: si hay productos con peso/medidas (regalos) se calcula; si no, el de siempre.
    const parcel = buildParcel(
      orderItems.map(i => (i._ship ? { ...i._ship, qty: i.quantity } : {})),
      itemsSubtotal / 100
    );
    const shippingCost =
        shippingMethod === 'andreani' ? await quoteShippingCents(shippingZip, tenant, andreaniCreds, parcel)
      : shippingMethod === 'moto'     ? cents(MOTO_TARIFAS[motoLocality] * 100)
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
        shipping_address: (shippingMethod === 'andreani' || shippingMethod === 'moto') ? cleanString(shipping.address, 180) : null,
        shipping_city: shippingMethod === 'moto' ? motoLocality : (shippingMethod === 'andreani' ? cleanString(shipping.city, 80) : null),
        shipping_zip: shippingMethod === 'andreani' ? shippingZip : null,
        shipping_province: shippingMethod === 'moto' ? 'Buenos Aires' : (shippingMethod === 'andreani' ? cleanString(shipping.province, 80) : null),
        shipping_cost: shippingCost,
        total,
        status: 'pending_payment',
      })
      .select()
      .single();

    if (orderError) throw orderError;

    // Mover miniaturas base64 al bucket privado 'designs' (F7). Si falla, se
    // conserva el data-URI para no romper el checkout.
    const rows = await Promise.all(orderItems.map(async (item, idx) => {
      const { _printFile, _ship, _pendingFiles, ...rest } = item;
      const thumb = await storeThumbnail(tenant.id, order.id, idx, item.design_thumbnail_url);
      // Archivo de impresión a tamaño real → ruta derivable "<idx>-print.jpg" (sin columna nueva)
      if (_printFile) await storeThumbnail(tenant.id, order.id, idx + '-print', _printFile);
      // Regalos: mover archivos subidos (pending) a la carpeta del pedido.
      if (_pendingFiles) rest.files = await claimPendingFiles(tenant.id, order.id, idx, _pendingFiles);
      return { ...rest, order_id: order.id, design_thumbnail_url: thumb };
    }));
    const { error: itemsError } = await supabase.from('order_items').insert(rows);
    if (itemsError) throw itemsError;

    const mp = new MercadoPagoConfig({ accessToken: mpAccessToken });
    const preference = new Preference(mp);
    const mpItems = orderItems.map(item => ({
      id: item.product_slug || item.product_id || item.product_name,
      title: item._pendingFiles
        ? `${item.product_name}${item.variant && item.variant.color ? ' · ' + item.variant.color : ''}`
        : `${item.product_name} - "${item.design_text}"`,
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

    const siteUrl = getPublicSiteUrl(req, tenantSlug);
    const backUrl = getBackUrlBuilder(req, siteUrl, order.id);
    const prefResult = await preference.create({
      body: {
        items: mpItems,
        payer: {
          name: buyerName,
          email: buyerEmail,
          phone: buyerPhone ? { number: buyerPhone } : undefined,
        },
        back_urls: {
          success: backUrl('exitoso'),
          failure: backUrl('fallido'),
          pending: backUrl('pendiente'),
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

const ATUMANERA_GRAF_HOSTS = new Set([
  'atumaneragraf.com',
  'www.atumaneragraf.com',
  'etiquetas.atumaneragraf.com',
]);
const REGALOS_HOST = 'regalos.atumaneragraf.com';

function getRequestHost(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
}

// Los dominios propios deben volver al mismo dominio después de Mercado Pago.
// El resto conserva SITE_URL como base de la plataforma.
function getPublicSiteUrl(req, tenantSlug) {
  const rawHost = getRequestHost(req);

  if (tenantSlug === 'feciega' && (rawHost === 'feciega.com' || rawHost === 'www.feciega.com')) {
    return 'https://feciega.com';
  }

  // Regalos: vuelve a su propio subdominio (el carrito vive en ese origen).
  if (tenantSlug === 'atumanera' && rawHost === REGALOS_HOST) {
    return 'https://' + REGALOS_HOST;
  }

  // A tu manera Gráfica: vuelve al apex; el middleware redirige /pago-* a etiquetas.*
  if (tenantSlug === 'atumanera' && ATUMANERA_GRAF_HOSTS.has(rawHost)) {
    return 'https://atumaneragraf.com';
  }

  return process.env.SITE_URL || 'https://personaliza.praxisoperativa.com';
}

// URLs de vuelta de Mercado Pago. Por defecto /pago-<estado> sobre siteUrl (igual
// que siempre). La tienda de regalos probada desde un preview de Vercel
// (*.vercel.app) vuelve a /regalos.html del mismo preview.
function getBackUrlBuilder(req, siteUrl, orderId) {
  const rawHost = getRequestHost(req);
  if (req.body && req.body.site === 'regalos' && rawHost.endsWith('.vercel.app')) {
    return (estado) => `https://${rawHost}/regalos.html?pago=${estado}&order=${orderId}`;
  }
  return (estado) => `${siteUrl}/pago-${estado}?order=${orderId}`;
}

// Mueve los archivos de regalos de <tenant>/pending/... a <tenant>/<order>/.
// Si un move falla, conserva la ruta pending (el archivo sigue accesible).
async function claimPendingFiles(tenantId, orderId, idx, pending) {
  const move = async (from, name) => {
    const ext = from.split('.').pop();
    const to = `${tenantId}/${orderId}/${idx}-${name}.${ext}`;
    const { error } = await supabase.storage.from('designs').move(from, to);
    if (error) { console.error('claimPendingFiles', from, error.message); return `storage:designs/${from}`; }
    return `storage:designs/${to}`;
  };
  const production = await move(pending.production, 'production');
  const originals = [];
  for (let k = 0; k < pending.originals.length; k++) originals.push(await move(pending.originals[k], `original-${k + 1}`));
  return { production, originals };
}

// Valida y normaliza el diseño de un ítem de regalos (producto con options.editor).
function validateGiftDesign(item, product, tenantId) {
  const opts = product.options || {};
  const pathRe = new RegExp(`^${tenantId}/pending/\\d{8}/[0-9a-f-]{36}-(original|production)\\.(jpg|png|webp|heic|heif)$`);
  const files = item.files || {};
  const production = typeof files.production === 'string' ? files.production : '';
  if (!pathRe.test(production) || !production.endsWith('-production.png')) {
    throw new Error(`Falta el archivo de producción: ${product.slug}`);
  }
  const originals = (Array.isArray(files.originals) ? files.originals : [])
    .filter(p => typeof p === 'string' && pathRe.test(p) && /-original\./.test(p))
    .slice(0, 6);

  let variant = null;
  if (Array.isArray(opts.colors) && opts.colors.length) {
    const wanted = cleanString(item.variant && item.variant.color, 40);
    const c = opts.colors.find(x => x.name === wanted);
    if (!c) throw new Error(`Color invalido para ${product.slug}`);
    variant = { color: c.name, color_hex: c.hex, label: opts.color_label || 'Color' };
  }

  let design = null;
  if (item.design && typeof item.design === 'object') {
    const json = JSON.stringify(item.design);
    if (json.length > 60000) throw new Error('Diseño demasiado grande');
    design = JSON.parse(json);
  }

  const ship = opts.shipping && Number(opts.shipping.kg) > 0
    ? { kg: Number(opts.shipping.kg), l: Number(opts.shipping.l), w: Number(opts.shipping.w), h: Number(opts.shipping.h) }
    : null;

  return { variant, design, pending: { production, originals }, ship };
}

async function getProductsBySlug(slugs, tenantId) {
  if (!slugs.length) return new Map();

  // El filtro por tenant_id es OBLIGATORIO: un tenant solo puede resolver
  // sus propios productos. Sin esto, dos tenants con el mismo slug se pisan.
  const base = 'id, tenant_id, name, slug, price, units_per_set, unit_label, active';
  const query = cols => supabase
    .from('products')
    .select(cols)
    .in('slug', slugs)
    .eq('active', true)
    .eq('tenant_id', tenantId);
  let { data, error } = await query(base + ', options');
  // 42703 = columna inexistente (migración regalos_fase1 aún no aplicada): seguir sin options.
  if (error && error.code === '42703') ({ data, error } = await query(base));
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
    printFile: cleanString(item.printFile, 600000),
    qty: Math.max(1, Math.min(10, Number.parseInt(item.qty, 10) || 1)),
    // Regalos (solo se usan si el producto tiene options.editor)
    design: item.design,
    files: item.files,
    variant: item.variant,
  }));

  const slugs = [...new Set(normalized.map(item => item.productSlug).filter(Boolean))];
  const products = await getProductsBySlug(slugs, tenantId);

  return normalized.map(item => {
    const product = products.get(item.productSlug);
    if (!product) throw new Error(`Producto invalido: ${item.productSlug || 'sin slug'}`);

    const unitPrice = cents(product.price);
    if (product.options && product.options.editor) {
      // Producto de regalos: exige diseño + archivo de producción subido.
      const g = validateGiftDesign(item, product, tenantId);
      return {
        product_id: product.id || null,
        product_slug: item.productSlug,
        product_name: cleanString(product.name, 120),
        design_text: item.designText,
        design_font: item.font,
        design_text_color: item.textColor,
        design_icon_index: null,
        design_position: 'wrap',
        design_border_color: null,
        design_pulsera_color: g.variant ? g.variant.color_hex : null,
        design_thumbnail_url: item.thumbnailUrl,
        variant: g.variant,
        design: g.design,
        files: null,                  // se completa al mover los archivos al pedido
        _pendingFiles: g.pending,
        _ship: g.ship,
        quantity: item.qty,
        units_total: item.qty * Number(product.units_per_set || 1),
        unit_price: unitPrice,
        subtotal: item.qty * unitPrice,
      };
    }
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
      _printFile: item.printFile,
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

async function quoteShippingCents(zip, tenant, andreaniCreds = {}, parcel = null) {
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
      bultos: [parcel || buildParcel([])],
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
