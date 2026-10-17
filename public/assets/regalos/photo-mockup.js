// photo-mockup.js — Mockup FOTOGRÁFICO de prendas (remera, buzo) en tiempo real.
// A partir de una foto de la prenda BLANCA (frente y espalda en la misma imagen):
//  - recolorea la tela al color elegido conservando las luces y arrugas reales
//    (mapa de sombras precalculado: *-map.png, L = sombra/1.4, A = recorte de la prenda);
//  - apoya cada zona de impresión a su medida real (px por cm calibrados por el
//    ancho de pecho) y le aplica las sombras de la tela: parece estampado, no pegado.
//
// API (misma idea que tee2d.js):
//   const m = await loadPhotoMockup(canvas, 'remera')
//   m.render({ view:'both'|'front'|'back', color, textures:{zoneId: canvas}, zones, highlight })
//   m.snapshot({ view, color, textures, zones, size }) → dataURL JPEG
//   m.viewOf(zoneId) → 'front' | 'back'

// Calibración por foto (coordenadas en px de la imagen original, 1264×848).
// pxcm = píxeles por centímetro. Las prendas generadas son más largas que las reales,
// así que se usa el promedio geométrico entre la escala por ancho de pecho y por largo
// (remera L 52 × 74 cm, buzo L 59 × 70 cm): así el A4 no queda chico a lo alto.
const K_REMERA_F = Math.sqrt((292 / 52) * (560 / 74));   // ≈ 6,55 px/cm (frente)
const K_REMERA_B = Math.sqrt((306 / 52) * (570 / 74));   // ≈ 6,70 px/cm (espalda)
const K_BUZO = Math.sqrt((355 / 59) * (500 / 70));      // ≈ 6,56 px/cm
export const GARMENTS = {
  remera: {
    photo: '/assets/regalos/mockups/remera.jpg', map: '/assets/regalos/mockups/remera-map.png',
    pxcm: { front: K_REMERA_F, back: K_REMERA_B },
    crops: { front: [85, 170, 640, 640], back: [545, 170, 640, 640] },
    zones: {
      front:    { view: 'front', cx: 467, cy: 365, rot: 0 },     // pecho izquierdo (lado del corazón)
      back:     { view: 'back',  cx: 864, top: 275, rot: 0 },    // A4 centrado, ~6 cm bajo el cuello
      sleeve_r: { view: 'front', cx: 228, cy: 414, rot: 25 },    // manga derecha (a la izquierda del que mira)
      sleeve_l: { view: 'front', cx: 599, cy: 414, rot: -25 },
    },
  },
  buzo: {
    photo: '/assets/regalos/mockups/buzo.jpg', map: '/assets/regalos/mockups/buzo-map.png',
    pxcm: { front: K_BUZO, back: K_BUZO },
    crops: { front: [30, 140, 640, 640], back: [586, 140, 640, 640] },
    zones: {
      front:    { view: 'front', cx: 428, cy: 352, rot: 0 },     // al costado del cordón
      back:     { view: 'back',  cx: 906, top: 336, rot: 0 },    // arranca debajo de la capucha
      sleeve_r: { view: 'front', cx: 149, cy: 364, rot: -6 },    // parte de arriba del brazo
      sleeve_l: { view: 'front', cx: 554, cy: 364, rot: 6 },
    },
  },
};

// sRGB ↔ lineal con tablas (recolorear ~1M de píxeles en pocos ms)
const TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const TO_SRGB = new Uint8ClampedArray(4096);
for (let i = 0; i < 4096; i++) { const c = i / 4095; TO_SRGB[i] = Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); }
const enc = v => TO_SRGB[Math.max(0, Math.min(4095, (v * 4095) | 0))];

function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('No se pudo cargar ' + src)); i.src = src; });
}
function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

const cache = {};   // por prenda: { cfg, W, H, photoData, mapData, maskCanvas, shadeMul, recolored:{} }

async function prepare(key) {
  if (cache[key]) return cache[key];
  const cfg = GARMENTS[key];
  if (!cfg) throw new Error('Prenda sin foto: ' + key);
  const [photo, map] = await Promise.all([loadImg(cfg.photo), loadImg(cfg.map)]);
  const W = photo.naturalWidth, H = photo.naturalHeight;
  const pc = canvasOf(W, H); const px = pc.getContext('2d', { willReadFrequently: true });
  px.drawImage(photo, 0, 0);
  const photoData = px.getImageData(0, 0, W, H);
  const mc = canvasOf(W, H); const mx = mc.getContext('2d', { willReadFrequently: true });
  mx.drawImage(map, 0, 0, W, H);
  const mapData = mx.getImageData(0, 0, W, H);   // PNG gris+alfa → R=G=B=sombra, A=recorte
  // recorte (solo alfa) y sombra para "multiply" sobre el estampado (≤ 1)
  const maskCanvas = canvasOf(W, H), shadeMul = canvasOf(W, H);
  const mk = maskCanvas.getContext('2d').createImageData(W, H);
  const sh = shadeMul.getContext('2d').createImageData(W, H);
  const d = mapData.data;
  for (let i = 0; i < d.length; i += 4) {
    mk.data[i + 3] = d[i + 3];
    // sombra real S (lineal) llevada a sRGB para el "multiply" del canvas; tope 1
    const s = 255 * Math.pow(Math.min(1, (d[i] / 255) * 1.4 * 1.02), 1 / 2.2);
    sh.data[i] = sh.data[i + 1] = sh.data[i + 2] = s; sh.data[i + 3] = 255;
  }
  maskCanvas.getContext('2d').putImageData(mk, 0, 0);
  shadeMul.getContext('2d').putImageData(sh, 0, 0);
  cache[key] = { cfg, W, H, photo, photoData, mapData, maskCanvas, shadeMul, recolored: {} };
  return cache[key];
}

// Foto con la prenda teñida del color pedido (se cachea por color)
function recolor(g, hex) {
  if (g.recolored[hex]) return g.recolored[hex];
  const v = String(hex || '#ffffff').replace('#', '');
  const C = [0, 2, 4].map(i => TO_LIN[parseInt(v.slice(i, i + 2), 16)]);
  const lumC = 0.2126 * C[0] + 0.7152 * C[1] + 0.0722 * C[2];
  const dark = lumC < 0.3, gam = dark ? 0.75 : 1;
  const out = canvasOf(g.W, g.H); const ox = out.getContext('2d');
  const img = ox.createImageData(g.W, g.H);
  const p = g.photoData.data, m = g.mapData.data, o = img.data;
  for (let i = 0; i < p.length; i += 4) {
    const a = m[i + 3] / 255;
    if (a === 0) { o[i] = p[i]; o[i + 1] = p[i + 1]; o[i + 2] = p[i + 2]; o[i + 3] = 255; continue; }
    const S = (m[i] / 255) * 1.4;
    const f = Math.pow(Math.min(S, 1.25), gam);
    let ex = 0;
    if (dark) ex = 0.014 * S + Math.max(0, S - 1) * 0.12;     // brillo leve de la tela en colores oscuros
    for (let c = 0; c < 3; c++) {
      const fab = C[c] * f + ex;
      const ph = TO_LIN[p[i + c]];
      o[i + c] = enc(ph * (1 - a) + fab * a);
    }
    o[i + 3] = 255;
  }
  ox.putImageData(img, 0, 0);
  g.recolored[hex] = out;
  return out;
}

function zoneRect(g, z, zc) {
  const k = g.cfg.pxcm[zc.view];
  const w = z.w_cm * k, h = z.h_cm * k;
  const cy = zc.top !== undefined ? zc.top + h / 2 : zc.cy;
  return { cx: zc.cx, cy, w, h, rot: zc.rot || 0 };
}

// Compone la foto completa (prenda teñida + estampados con sombras)
function compose(g, { color = '#ffffff', textures = {}, zones = [] }) {
  if (!g.full) { g.full = canvasOf(g.W, g.H); g.layer = canvasOf(g.W, g.H); g.alpha = canvasOf(g.W, g.H); }
  const fx = g.full.getContext('2d'), lx = g.layer.getContext('2d'), ax = g.alpha.getContext('2d');
  fx.globalCompositeOperation = 'source-over';
  fx.drawImage(recolor(g, color), 0, 0);
  lx.globalCompositeOperation = 'source-over';
  lx.clearRect(0, 0, g.W, g.H);
  let any = false;
  for (const z of zones) {
    const zc = g.cfg.zones[z.id], tex = textures[z.id];
    if (!zc || !tex || !tex.width) continue;
    const r = zoneRect(g, z, zc);
    lx.save(); lx.translate(r.cx, r.cy); lx.rotate(r.rot * Math.PI / 180);
    lx.drawImage(tex, -r.w / 2, -r.h / 2, r.w, r.h);
    lx.restore();
    any = true;
  }
  if (any) {
    ax.globalCompositeOperation = 'copy'; ax.drawImage(g.layer, 0, 0);
    lx.globalCompositeOperation = 'multiply'; lx.drawImage(g.shadeMul, 0, 0);       // sombras de la tela
    lx.globalCompositeOperation = 'destination-in'; lx.drawImage(g.alpha, 0, 0);    // solo donde hay diseño
    lx.drawImage(g.maskCanvas, 0, 0);                                                 // solo sobre la prenda
    lx.globalCompositeOperation = 'source-over';
    fx.drawImage(g.layer, 0, 0);
  }
  return g.full;
}

function srcRect(g, view) {
  if (view === 'front' || view === 'back') return g.cfg.crops[view];
  return [0, 0, g.W, g.H];
}

export async function loadPhotoMockup(canvas, key) {
  const g = await prepare(key);
  const ctx = canvas.getContext('2d');
  let last = null;
  const api = {
    garment: key,
    aspect(view) { const r = srcRect(g, view); return r[2] / r[3]; },
    viewOf(zid) { return (g.cfg.zones[zid] || {}).view || 'front'; },
    render(opts) {
      last = opts;
      const view = opts.view || 'both';
      const [sx, sy, sw, sh] = srcRect(g, view);
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(100, Math.round(rect.width * dpr)), h = Math.round(w * sh / sw);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const full = compose(g, opts);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(full, sx, sy, sw, sh, 0, 0, w, h);
      // marco de la zona que se está editando
      const z = opts.highlight && (opts.zones || []).find(x => x.id === opts.highlight);
      const zc = z && g.cfg.zones[z.id];
      if (zc) {
        const r = zoneRect(g, z, zc), k = w / sw;
        ctx.save();
        ctx.translate((r.cx - sx) * k, (r.cy - sy) * k); ctx.rotate(r.rot * Math.PI / 180);
        const v = String(opts.color || '#fff').replace('#', '');
        const lum = (0.299 * parseInt(v.slice(0, 2), 16) + 0.587 * parseInt(v.slice(2, 4), 16) + 0.114 * parseInt(v.slice(4, 6), 16)) / 255;
        ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
        ctx.strokeStyle = lum < 0.45 ? 'rgba(255,255,255,.85)' : 'rgba(236,0,140,.85)';
        ctx.strokeRect(-r.w * k / 2, -r.h * k / 2, r.w * k, r.h * k);
        ctx.restore();
      }
    },
    rerender() { if (last) api.render(last); },
    snapshot(opts) {
      const size = opts.size || 480;
      const full = compose(g, opts);
      const c = canvasOf(size, size), x = c.getContext('2d');
      const grd = x.createLinearGradient(0, 0, 0, size);
      grd.addColorStop(0, '#ffffff'); grd.addColorStop(1, '#eef3f8');
      x.fillStyle = grd; x.fillRect(0, 0, size, size);
      x.imageSmoothingQuality = 'high';
      const [sx, sy, sw, sh] = srcRect(g, opts.view || 'both');
      const k = Math.min(size / sw, size / sh);
      x.drawImage(full, sx, sy, sw, sh, (size - sw * k) / 2, (size - sh * k) / 2, sw * k, sh * k);
      return c.toDataURL('image/jpeg', 0.88);
    },
  };
  return api;
}
