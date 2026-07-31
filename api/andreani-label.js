// api/andreani-label.js
// Genera una etiqueta de envío Andreani para un pedido pagado.
// Crea la orden en Andreani, obtiene el PDF de la etiqueta,
// y guarda el número de tracking en Supabase.
//
// Variables de entorno requeridas:
//   ANDREANI_USER            → usuario de la cuenta Andreani de Sandra
//   ANDREANI_PASS            → contraseña
//   ANDREANI_CONTRATO        → número de contrato empresarial
//   ANDREANI_CP_ORIGEN       → CP de la dirección de Sandra (ej: 1428)
//   ANDREANI_CALLE_ORIGEN    → calle de Sandra (ej: Juramento)
//   ANDREANI_NUM_ORIGEN      → número de la calle (ej: 1234)
//   ANDREANI_LOCALIDAD_ORIGEN → localidad (ej: Belgrano)
//   ANDREANI_REMITENTE_NOMBRE → nombre completo de Sandra
//   ANDREANI_REMITENTE_EMAIL  → email de Sandra
//   ANDREANI_REMITENTE_DNI    → DNI de Sandra (solo números)
//   ANDREANI_REMITENTE_TEL    → teléfono de Sandra (ej: 1156169164)
//   ADMIN_TOKEN              → token del panel admin (para proteger el endpoint)

const { createClient } = require('@supabase/supabase-js');
const {
  applyCors,
  sendOptions,
  publicError,
  getTenantSlug,
  assertAdmin,
  isUuid,
} = require('./_utils');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function getTenantSecret(tenantId, name) {
  const { data, error } = await supabase.rpc('get_tenant_secret', { p_tenant: tenantId, p_name: name });
  if (error) { console.error('get_tenant_secret', name, error.message); return null; }
  return data || null;
}

const BASE_URL_PROD = 'https://apis.andreani.com';
const BASE_URL_QA   = 'https://apisqa.andreani.com';

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return sendOptions(req, res, 'POST, OPTIONS');
  if (req.method !== 'POST') return publicError(res, 405, 'Method not allowed');

  // Auth del dashboard
  if (!assertAdmin(req, process.env.ADMIN_TOKEN)) {
    return publicError(res, 401, 'No autorizado');
  }

  const { orderId } = req.body || {};
  if (!isUuid(orderId)) return publicError(res, 400, 'orderId invalido');

  const tenant = await getTenant(getTenantSlug(req));
  if (!tenant) return publicError(res, 400, 'Comercio no valido');

  // Verificar configuración de Andreani (credenciales por tenant vía Vault, fallback env)
  const user     = (await getTenantSecret(tenant.id, 'andreani_user')) || process.env.ANDREANI_USER;
  const pass     = (await getTenantSecret(tenant.id, 'andreani_pass')) || process.env.ANDREANI_PASS;
  const contrato = tenant?.andreani_contract || process.env.ANDREANI_CONTRATO;

  if (!user || !pass || !contrato) {
    return res.status(200).json({
      ok: false,
      configPendiente: true,
      error: 'Andreani no configurado. Completar ANDREANI_USER, ANDREANI_PASS y ANDREANI_CONTRATO en las variables de entorno.',
    });
  }

  const baseUrl = BASE_URL_PROD;

  try {
    // 1. Obtener datos del pedido desde Supabase
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*, order_items(*)')
      .eq('id', orderId)
      .eq('tenant_id', tenant.id)
      .single();

    if (orderError || !order) {
      return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
    }

    if (!order.shipping_address || !order.shipping_zip) {
      return res.status(400).json({ ok: false, error: 'El pedido no tiene dirección de envío completa' });
    }

    // 2. Autenticar con Andreani
    const token = await getAndreaniToken(baseUrl, user, pass);
    if (!token) return res.status(200).json({ ok: false, error: 'No se pudo autenticar con Andreani' });

    // 3. Calcular peso y volumen total según los items del pedido
    const { kilos, volumen } = calcularPaquete(order.order_items || []);

    // 4. Construir y crear la orden en Andreani
    const ordenData = buildOrden(order, contrato, kilos, volumen);
    const ordenRes = await fetch(`${baseUrl}/v2/ordenes-de-envio`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-authorization-token': token,
      },
      body: JSON.stringify(ordenData),
    });

    if (!ordenRes.ok) {
      const errText = await ordenRes.text();
      console.error('Andreani crear orden error:', ordenRes.status, errText);
      return res.status(200).json({ ok: false, error: `Error al crear orden Andreani (${ordenRes.status}): ${errText}` });
    }

    const ordenResult = await ordenRes.json();
    const numeroDeEnvio = ordenResult?.bultos?.[0]?.numeroDeEnvio;

    if (!numeroDeEnvio) {
      return res.status(200).json({ ok: false, error: 'Andreani no devolvió número de envío', raw: ordenResult });
    }

    // 5. Obtener la etiqueta PDF
    const etiquetaRes = await fetch(`${baseUrl}/v2/ordenes-de-envio/${numeroDeEnvio}/etiquetas`, {
      method: 'GET',
      headers: { 'x-authorization-token': token },
    });

    let etiquetaBase64 = null;
    if (etiquetaRes.ok) {
      const pdfBuffer = await etiquetaRes.arrayBuffer();
      etiquetaBase64 = Buffer.from(pdfBuffer).toString('base64');
    }

    // 6. Guardar número de tracking en Supabase
    await supabase
      .from('orders')
      .update({ tracking_number: numeroDeEnvio, status: 'in_production' })
      .eq('id', orderId)
      .eq('tenant_id', tenant.id);

    return res.status(200).json({
      ok: true,
      numeroDeEnvio,
      etiquetaPdf: etiquetaBase64,  // base64 — el frontend lo convierte a blob para descargar
      estado: ordenResult.estado || 'Pendiente',
    });

  } catch (err) {
    console.error('andreani-label error:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo generar la etiqueta' });
  }
};

async function getTenant(slug) {
  const { data, error } = await supabase
    .from('tenants')
    .select('id, slug, andreani_contract')
    .eq('slug', slug)
    .eq('active', true)
    .maybeSingle();

  if (error && error.code !== '42P01') throw error;
  return data || null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getAndreaniToken(baseUrl, user, pass) {
  try {
    const authRes = await fetch(`${baseUrl}/login`, {
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') },
    });
    if (!authRes.ok) return null;
    return authRes.headers.get('x-authorization-token') || authRes.headers.get('X-Authorization-token');
  } catch {
    return null;
  }
}

function calcularPaquete(items) {
  // Peso base por set según tipo de producto (kg)
  const PESOS = {
    'Cintas Falletina': 0.20,
    '32 Etiquetas Termoadhesivas': 0.10,
    '49 Etiquetas Termoadhesivas (plancha mixta)': 0.12,
    'Pulseras Cinta Fluor x30': 0.15,
  };
  // Volumen base en cm³
  const VOLUMENES = {
    'Cintas Falletina': 600,
    '32 Etiquetas Termoadhesivas': 300,
    '49 Etiquetas Termoadhesivas (plancha mixta)': 400,
    'Pulseras Cinta Fluor x30': 500,
  };

  let kilos = 0;
  let volumen = 0;

  for (const item of items) {
    const pesoUnit = PESOS[item.product_name] || 0.15;
    const volUnit  = VOLUMENES[item.product_name] || 400;
    kilos  += pesoUnit * (item.quantity || 1);
    volumen += volUnit * (item.quantity || 1);
  }

  // Mínimo razonable
  return {
    kilos: Math.max(kilos, 0.1),
    volumen: Math.max(volumen, 200),
  };
}

function buildOrden(order, contrato, kilos, volumen) {
  const env = process.env;

  // Parsear dirección del destinatario
  // shipping_address = "Av. Corrientes 1234, 3° A" (guardado así desde el checkout)
  const addressParts = (order.shipping_address || '').split(',');
  const calleNum = addressParts[0]?.trim() || order.shipping_address || '';
  const piso     = addressParts[1]?.trim() || '';

  // Separar calle y número del string "Av. Corrientes 1234"
  const calleNumMatch = calleNum.match(/^(.+?)\s+(\d+[a-zA-Z]?)$/);
  const calleDest = calleNumMatch ? calleNumMatch[1] : calleNum;
  const numDest   = calleNumMatch ? calleNumMatch[2] : 'S/N';

  return {
    contrato,
    origen: {
      postal: {
        codigoPostal: env.ANDREANI_CP_ORIGEN || '1428',
        calle:        env.ANDREANI_CALLE_ORIGEN || 'Belgrano',
        numero:       env.ANDREANI_NUM_ORIGEN || '1',
        localidad:    env.ANDREANI_LOCALIDAD_ORIGEN || 'Belgrano',
        region:       'AR-C',
        pais:         'Argentina',
      },
    },
    destino: {
      postal: {
        codigoPostal: order.shipping_zip,
        calle:        calleDest,
        numero:       numDest,
        localidad:    order.shipping_city || '',
        region:       '', // Andreani lo resuelve por CP
        pais:         'Argentina',
        componentesDeDireccion: piso
          ? [{ meta: 'piso', contenido: piso }]
          : [],
      },
    },
    remitente: {
      nombreCompleto: env.ANDREANI_REMITENTE_NOMBRE || 'A Tu Manera Etiquetas',
      email:          env.ANDREANI_REMITENTE_EMAIL  || 'etiquetas@atumanera.com',
      documentoTipo:  'DNI',
      documentoNumero: env.ANDREANI_REMITENTE_DNI || '00000000',
      telefonos: [{
        tipo:   1,
        numero: env.ANDREANI_REMITENTE_TEL || '1100000000',
      }],
    },
    destinatario: [{
      nombreCompleto:  order.buyer_name,
      email:           order.buyer_email,
      documentoTipo:   'DNI',
      documentoNumero: '00000000', // No lo pedimos en checkout; Andreani lo acepta
      telefonos: order.buyer_phone
        ? [{ tipo: 1, numero: order.buyer_phone.replace(/\D/g, '') }]
        : [{ tipo: 1, numero: '1100000000' }],
    }],
    productoAEntregar: 'Etiquetas personalizadas',
    bultos: [{
      kilos:    Math.round(kilos * 1000) / 1000,
      largoCm:  20,
      anchoCm:  15,
      altoCm:   Math.max(2, Math.round(kilos * 10)),
      volumenCm: Math.round(volumen),
      valorDeclaradoSinImpuestos: Math.round(order.total / 121),  // total sin IVA
      valorDeclaradoConImpuestos: Math.round(order.total / 100),  // total en ARS
      referencias: [{
        meta:     'idCliente',
        contenido: String(order.order_number),
      }],
    }],
  };
}
