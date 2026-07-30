// api/andreani-quote.js
// Cotiza Andreani para el tenant actual.

const { createClient } = require('@supabase/supabase-js');
const { applyCors, sendOptions, publicError, getTenantSlug, cleanString } = require('./_utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return sendOptions(req, res, 'POST, OPTIONS');
  if (req.method !== 'POST') return publicError(res, 405, 'Method not allowed');

  const cpDestino = cleanString(req.body?.cpDestino, 12);
  if (!/^\d{4}$/.test(cpDestino || '')) {
    return res.status(400).json({ ok: false, error: 'cpDestino requerido' });
  }

  const tenant = await getTenant(getTenantSlug(req));
  const user = process.env.ANDREANI_USER;
  const pass = process.env.ANDREANI_PASS;
  const contrato = tenant?.andreani_contract || process.env.ANDREANI_CONTRATO;
  const cpOrigen = process.env.ANDREANI_CP_ORIGEN || '1646';

  if (!user || !pass) {
    return res.status(200).json({ ok: false, fallback: true, error: 'Credenciales Andreani no configuradas' });
  }

  const usandoQA = !contrato;
  const contratoFinal = contrato || '400006711';
  const baseUrl = usandoQA ? 'https://apisqa.andreani.com' : 'https://apis.andreani.com';

  try {
    const authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    const authRes = await fetch(`${baseUrl}/login`, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });

    if (!authRes.ok) {
      console.error('Andreani auth failed:', authRes.status, await authRes.text());
      return res.status(200).json({ ok: false, fallback: true, error: `Auth fallida (${authRes.status})` });
    }

    const token = authRes.headers.get('x-authorization-token') || authRes.headers.get('X-Authorization-token');
    if (!token) {
      return res.status(200).json({ ok: false, fallback: true, error: 'No se recibio token' });
    }

    const bultos = [{
      kilos: 0.15,
      largoCm: 15,
      anchoCm: 10,
      altoCm: 2,
      volumen: 300,
      valorDeclarado: 10000,
    }];

    const qs = buildQuery({ cpDestino, cpOrigen, contrato: contratoFinal, bultos });
    const tarifaRes = await fetch(`${baseUrl}/v1/tarifas?${qs}`, {
      method: 'GET',
      headers: { 'x-authorization-token': token, 'Content-Type': 'application/json' },
    });

    if (!tarifaRes.ok) {
      const errText = await tarifaRes.text();
      console.error('Andreani tarifas error:', tarifaRes.status, errText);
      return res.status(200).json({ ok: false, fallback: true, error: `Tarifas error ${tarifaRes.status}` });
    }

    const tarifa = await tarifaRes.json();
    const totalConIva = parseFloat(tarifa?.tarifaConIva?.total || tarifa?.tarifaSinIva?.total || 0);
    if (!totalConIva) {
      return res.status(200).json({ ok: false, fallback: true, error: 'Tarifa vacia' });
    }

    return res.status(200).json({
      ok: true,
      totalARS: Math.ceil(totalConIva),
      pesoAforadoKg: tarifa.pesoAforado || null,
      desglose: tarifa.tarifaConIva || null,
      ambiente: usandoQA ? 'qa-demo' : 'produccion',
    });
  } catch (err) {
    console.error('andreani-quote error:', err);
    return res.status(200).json({ ok: false, fallback: true, error: 'No se pudo cotizar Andreani' });
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
