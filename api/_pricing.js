// api/_pricing.js
// Cálculo de precio para productos con matriz de precios (product_price_matrix)
// y add-ons (product_addons). Función pura: no toca la base.
// El servidor es la fuente de verdad: el cliente nunca manda el monto.
// Importes en centavos ARS (enteros).

const MAX_SIDE_CM = 300;      // tope de un lado para gran formato y banners
const MAX_UNITS_PER_ADDON = 500;

function round(n) { return Math.round(n); }

// selection: {
//   options: { <group>: <value> }   ej. { tamano: '10x15' }, { material: 'Vinilo Premium' }, { tipo: 'Simple faz' }
//   quantity: número (volantes/tarjetas: la cantidad de la lista)
//   widthCm, heightCm: solo para unit 'm2'
//   units: cantidad de unidades para add-ons 'per_unit' (ej. ojales)
//   addons: [nombre del add-on, ...]
// }
function priceSelection(matrix, addons, selection) {
  const sel = selection || {};
  const opts = sel.options || {};
  const groups = Object.keys(opts);
  if (!groups.length) throw new Error('Falta elegir una opción');

  // 1) Buscar la fila base
  const rows = (matrix || []).filter(r => groups.includes(r.option_group) && opts[r.option_group] === r.option_value);
  if (!rows.length) throw new Error('Combinación de opciones inexistente');
  const unit = rows[0].unit;
  const row = unit === 'unidad'
    ? rows.find(r => Number(r.quantity) === Number(sel.quantity))
    : rows[0];
  if (!row) throw new Error('Cantidad no disponible para esa opción');

  // 2) Precio base
  let base;
  let area = null;
  if (unit === 'unidad' || unit === 'fijo') {
    base = Number(row.price);
  } else if (unit === 'm2') {
    const w = Number(sel.widthCm), h = Number(sel.heightCm);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error('Ingresá ancho y alto en cm');
    if (w > MAX_SIDE_CM || h > MAX_SIDE_CM) throw new Error(`Medidas máximas: ${MAX_SIDE_CM} cm por lado`);
    area = (w * h) / 10000;
    base = round(Number(row.price) * area);
  } else {
    throw new Error('Unidad de precio desconocida');
  }

  // 3) Add-ons elegidos
  const wanted = Array.isArray(sel.addons) ? sel.addons : [];
  let extras = 0;
  const breakdown = [];
  for (const name of wanted) {
    const a = (addons || []).find(x => x.name === name);
    if (!a) throw new Error(`Add-on inexistente: ${name}`);
    let amount;
    if (a.kind === 'percent') {
      amount = round(base * Number(a.amount) / 100);
    } else if (a.kind === 'per_m2') {
      if (area === null) throw new Error(`${a.name} requiere medidas en cm`);
      amount = round(Number(a.amount) * area);
    } else if (a.kind === 'per_unit') {
      const u = Number(sel.units);
      if (!Number.isInteger(u) || u < 1 || u > MAX_UNITS_PER_ADDON) throw new Error(`Cantidad inválida para ${a.name}`);
      amount = Number(a.amount) * u;
    } else {
      throw new Error('Tipo de add-on desconocido');
    }
    extras += amount;
    breakdown.push({ name: a.name, amount });
  }

  return {
    basePrice: base,
    area,
    addons: breakdown,
    unitTotal: base + extras,         // total del pedido (no por unidad)
    units: unit === 'unidad' ? Number(row.quantity) : null,
  };
}

module.exports = { priceSelection, MAX_SIDE_CM };
