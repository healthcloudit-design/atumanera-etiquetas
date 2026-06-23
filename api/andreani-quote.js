// api/andreani-quote.js
// Cotiza el costo de envío Andreani para un código postal destino.
//
// Variables de entorno necesarias:
//   ANDREANI_USER      → usuario (email) de la cuenta Andreani
//   ANDREANI_PASS      → contraseña de la cuenta Andreani
//   ANDREANI_CONTRATO  → número de contrato empresarial (ej: 300006611)
//                        Si está vacío, usa el ambiente QA con contrato de prueba
//   ANDREANI_CP_ORIGEN → CP de origen (el de Sandra). Default: 1646
//
// Paquete estimado para etiquetas: 150g, 15×10×2cm = 300cm³

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cpDestino } = req.body || {};
  if (!cpDestino) return res.status(400).json({ ok: false, error: 'cpDestino requerido' });

  const user     = process.env.ANDREANI_USER;
  const pass     = process.env.ANDREANI_PASS;
  const contrato = process.env.ANDREANI_CONTRATO;
  const cpOrigen = process.env.ANDREANI_CP_ORIGEN || '1646';

  // Si no hay credenciales, no podemos llamar a la API
  if (!user || !pass) {
    return res.status(200).json({
      ok: false,
      fallback: true,
      error: 'Credenciales Andreani no configuradas',
    });
  }

  // Si no hay contrato, usamos ambiente QA con contrato de prueba (para demo)
  const usandoQA = !contrato;
  const contratoFinal = contrato || '400006711';
  const baseUrl = usandoQA
    ? 'https://apisqa.andreani.com'
    : 'https://apis.andreani.com';

  try {
    // 1. Autenticar → obtener token
    const authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    const authRes = await fetch(`${baseUrl}/login`, {
      method: 'GET',
      headers: { 'Authorization': authHeader },
    });

    if (!authRes.ok) {
      console.error('Andreani auth failed:', authRes.status, await authRes.text());
      return res.status(200).json({ ok: false, fallback: true, error: `Auth fallida (${authRes.status})` });
    }

    const token = authRes.headers.get('x-authorization-token') || authRes.headers.get('X-Authorization-token');
    if (!token) {
      return res.status(200).json({ ok: false, fallback: true, error: 'No se recibió token' });
    }

    // 2. Cotizar — paquete tipo sobre/caja pequeña para etiquetas
    // Parámetros de bulto: 150g, 15×10×2cm, valorDeclarado=$10.000
    const bultos = [
      {
        kilos: 0.15,
        largoCm: 15,
        anchoCm: 10,
        altoCm: 2,
        volumen: 300,           // 15×10×2 = 300 cm³
        valorDeclarado: 10000,  // ARS
      }
    ];

    // Construir query string manualmente (la API espera bultos[0][kilos]=0.15 etc.)
    const qs = buildQuery({ cpDestino, contrato: contratoFinal, bultos });
    const tarifaUrl = `${baseUrl}/v1/tarifas?${qs}`;

    const tarifaRes = await fetch(tarifaUrl, {
      method: 'GET',
      headers: { 'x-authorization-token': token, 'Content-Type': 'application/json' },
    });

    if (!tarifaRes.ok) {
      const errText = await tarifaRes.text();
      console.error('Andreani tarifas error:', tarifaRes.status, errText);
      return res.status(200).json({ ok: false, fallback: true, error: `Tarifas error ${tarifaRes.status}: ${errText}` });
    }

    const tarifa = await tarifaRes.json();

    // Precio con IVA en ARS (la API devuelve strings con decimales)
    const totalConIva = parseFloat(tarifa?.tarifaConIva?.total || tarifa?.tarifaSinIva?.total || 0);

    if (!totalConIva) {
      return res.status(200).json({ ok: false, fallback: true, error: 'Tarifa vacía', raw: tarifa });
    }

    return res.status(200).json({
      ok: true,
      totalARS: Math.ceil(totalConIva),   // pesos ARS, sin decimales
      pesoAforadoKg: tarifa.pesoAforado || null,
      desglose: tarifa.tarifaConIva || null,
      ambiente: usandoQA ? 'qa-demo' : 'produccion',
    });

  } catch (err) {
    console.error('andreani-quote error:', err);
    return res.status(200).json({ ok: false, fallback: true, error: err.message });
  }
};

/**
 * Construye un query string compatible con el formato PHP http_build_query
 * para arrays anidados: bultos[0][kilos]=0.15&bultos[0][volumen]=300 etc.
 */
function buildQuery(params, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, idx) => {
        parts.push(buildQuery(item, `${paramKey}[${idx}]`));
      });
    } else if (value !== null && typeof value === 'object') {
      parts.push(buildQuery(value, paramKey));
    } else if (value !== undefined && value !== null) {
      parts.push(`${encodeURIComponent(paramKey)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join('&');
}
