// tee2d.js — Mockup realista de remera (canvas 2D), a escala real.
// La remera se dibuja en CENTÍMETROS (talle L, prenda extendida: 55 cm de ancho,
// 74 cm de largo) y cada zona de impresión se ubica con su medida física real,
// así el cliente ve el tamaño verdadero del estampado sobre la prenda.
// El diseño se dibuja ANTES de las sombras/arrugas/textura: queda "dentro" de la tela.
//
// API:
//   const m = createTeeMockup(canvas)
//   m.render({ view:'front'|'back', color:'#fff', textures:{zoneId: canvas}, zones:[...], highlight:zoneId })
//   m.snapshot({ view, color, textures, zones, size }) → dataURL JPEG

// Ubicación de cada zona sobre la prenda (centro en cm; x desde el centro, y desde el hombro)
// y rotación (grados). "Derecha/izquierda" = como la lleva puesta el cliente.
export const ZONE_PLACEMENT = {
  front:    { view: 'front', cx: 10.5, cy: 20.5, rot: 0 },     // pecho izquierdo (lado del corazón)
  back:     { view: 'back',  cx: 0,    cy: 8,    rot: 0, anchorTop: true },  // A4 centrado, 8 cm bajo el cuello
  sleeve_r: { view: 'front', cx: -32.2, cy: 20.6, rot: 51 },   // en vista frontal, a la izquierda del que mira
  sleeve_l: { view: 'front', cx: 32.2,  cy: 20.6, rot: -51 },
};

const VIEW = { x0: -45, y0: -4, w: 90, h: 84 };   // ventana del mundo en cm

function teePath(ctx, back) {
  // Silueta (cm). Simétrica; se arma la mitad izquierda y se espeja.
  const neckDrop = back ? 2.4 : 9;
  ctx.beginPath();
  ctx.moveTo(-9.6, 0.4);
  ctx.quadraticCurveTo(0, back ? neckDrop + 0.6 : neckDrop * 1.25, 9.6, 0.4);     // escote
  ctx.lineTo(23.5, 4.2);                                         // hombro der.
  ctx.quadraticCurveTo(25.2, 4.8, 26.6, 6.6);
  ctx.lineTo(39.6, 18.0);                                        // manga, borde superior
  ctx.quadraticCurveTo(40.2, 18.8, 39.6, 19.6);
  ctx.lineTo(30.0, 31.2);                                        // ruedo de manga
  ctx.quadraticCurveTo(29.2, 31.6, 28.6, 30.7);
  ctx.quadraticCurveTo(27.4, 28.0, 27.0, 25.6);                  // axila
  ctx.quadraticCurveTo(26.3, 50, 27.7, 72.6);                    // costado
  ctx.quadraticCurveTo(27.6, 73.6, 26.6, 73.7);
  ctx.quadraticCurveTo(0, 74.9, -26.6, 73.7);                    // ruedo inferior
  ctx.quadraticCurveTo(-27.6, 73.6, -27.7, 72.6);
  ctx.quadraticCurveTo(-26.3, 50, -27.0, 25.6);
  ctx.quadraticCurveTo(-27.4, 28.0, -28.6, 30.7);
  ctx.quadraticCurveTo(-29.2, 31.6, -30.0, 31.2);
  ctx.lineTo(-39.6, 19.6);
  ctx.quadraticCurveTo(-40.2, 18.8, -39.6, 18.0);
  ctx.lineTo(-26.6, 6.6);
  ctx.quadraticCurveTo(-25.2, 4.8, -23.5, 4.2);
  ctx.closePath();
}

function hexToRgb(h) {
  const m = String(h || '#ffffff').replace('#', '');
  const v = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
const shade = (rgb, f) => `rgb(${rgb.map(c => Math.max(0, Math.min(255, Math.round(c * f)))).join(',')})`;

let noiseCanvas = null;
function noise() {
  if (noiseCanvas) return noiseCanvas;
  noiseCanvas = document.createElement('canvas');
  noiseCanvas.width = noiseCanvas.height = 160;
  const x = noiseCanvas.getContext('2d');
  const img = x.createImageData(160, 160);
  for (let i = 0; i < img.data.length; i += 4) {
    // trama de tejido: ruido + leve patrón de punto
    const p = (i / 4), px = p % 160, py = (p / 160) | 0;
    const knit = ((px + (py % 2)) % 2) * 18;
    const v = 118 + Math.random() * 30 + knit;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return noiseCanvas;
}

// Arruga/brillo suave: elipse con degradé radial (sin ctx.filter, anda en Safari)
function blob(ctx, x, y, len, wid, angDeg, color, alpha) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(angDeg * Math.PI / 180); ctx.scale(len, wid);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, `rgba(${color},${alpha})`); g.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = g; ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}

function drawTee(ctx, W, H, { view = 'front', color = '#ffffff', textures = {}, zones = [], highlight = null, bg = null }) {
  const back = view === 'back';
  const rgb = hexToRgb(color);
  const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  const dark = lum < 0.35;
  const k = W / VIEW.w;

  ctx.save();
  ctx.clearRect(0, 0, W, H);
  if (bg) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, bg[0]); g.addColorStop(1, bg[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  ctx.setTransform(k, 0, 0, k, -VIEW.x0 * k, -VIEW.y0 * k);   // de acá en más: cm

  // 1) sombra proyectada + color base
  ctx.save();
  ctx.shadowColor = 'rgba(20,30,50,0.22)';
  ctx.shadowBlur = 2.2 * k; ctx.shadowOffsetY = 0.9 * k;
  teePath(ctx, back); ctx.fillStyle = shade(rgb, 1); ctx.fill();
  ctx.restore();

  ctx.save();
  teePath(ctx, back); ctx.clip();

  // 2) interior del cuello visible (solo de frente)
  if (!back) {
    ctx.save();
    ctx.beginPath(); ctx.moveTo(-9.6, 0.4); ctx.quadraticCurveTo(0, 11.2, 9.6, 0.4);
    ctx.quadraticCurveTo(0, 3.4, -9.6, 0.4); ctx.closePath();
    ctx.fillStyle = shade(rgb, dark ? 0.7 : 0.86); ctx.fill();
    ctx.restore();
  }

  // 3) diseños de cada zona (medida real)
  for (const z of zones) {
    const pl = ZONE_PLACEMENT[z.id];
    const tex = textures[z.id];
    if (!pl || pl.view !== view) continue;
    ctx.save();
    const cy = pl.anchorTop ? pl.cy + z.h_cm / 2 : pl.cy;
    ctx.translate(pl.cx, cy); ctx.rotate(pl.rot * Math.PI / 180);
    if (tex && tex.width) ctx.drawImage(tex, -z.w_cm / 2, -z.h_cm / 2, z.w_cm, z.h_cm);
    if (highlight === z.id) {
      ctx.setLineDash([0.5, 0.35]); ctx.lineWidth = 0.14;
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.75)' : 'rgba(236,0,140,0.8)';
      ctx.strokeRect(-z.w_cm / 2, -z.h_cm / 2, z.w_cm, z.h_cm);
    }
    ctx.restore();
  }

  // 4) volumen: sombras (multiply) y brillos (screen) — afectan también al diseño
  const sA = dark ? 0.35 : 1, hA = dark ? 1.6 : 0.75;
  ctx.globalCompositeOperation = 'multiply';
  // cuerpo redondeado: oscurece hacia los costados (solo el torso)
  ctx.save(); ctx.beginPath(); ctx.rect(-28.5, -4, 57, 84); ctx.clip();
  let g = ctx.createLinearGradient(-28, 0, 28, 0);
  g.addColorStop(0, `rgba(0,0,0,${0.13 * sA})`); g.addColorStop(0.16, 'rgba(0,0,0,0)');
  g.addColorStop(0.84, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${0.13 * sA})`);
  ctx.fillStyle = g; ctx.fillRect(-45, -4, 90, 84);
  ctx.restore();
  // mangas: leve sombra hacia el ruedo
  for (const sx of [-1, 1]) {
    g = ctx.createLinearGradient(sx * 27, 8, sx * 36, 28);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${0.07 * sA})`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(sx * 26, 4); ctx.lineTo(sx * 42, 18); ctx.lineTo(sx * 30, 33); ctx.lineTo(sx * 26, 28); ctx.closePath(); ctx.fill();
  }
  g = ctx.createLinearGradient(0, 0, 0, 75);             // leve caída de luz hacia abajo
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${0.06 * sA})`);
  ctx.fillStyle = g; ctx.fillRect(-45, -4, 90, 84);
  // costuras de manga y axilas
  blob(ctx, -26.6, 15, 1.0, 10, 6, '0,0,0', 0.14 * sA);
  blob(ctx, 26.6, 15, 1.0, 10, -6, '0,0,0', 0.14 * sA);
  blob(ctx, -27.4, 29, 1.8, 5, 0, '0,0,0', 0.14 * sA);
  blob(ctx, 27.4, 29, 1.8, 5, 0, '0,0,0', 0.14 * sA);
  // arrugas de tela
  // arrugas de tela: anchas y suaves (pliegues, no rayas)
  const folds = back
    ? [[-11, 55, 2.6, 15, 10], [10, 60, 2.4, 13, -9], [19, 44, 1.8, 9, -14]]
    : [[-12, 54, 2.6, 15, 12], [11, 59, 2.4, 13, -10], [-19, 41, 1.8, 9, 15], [-34, 23, 1.2, 4.5, 50], [34, 23, 1.2, 4.5, -50]];
  for (const f of folds) blob(ctx, f[0], f[1], f[2], f[3], f[4], '0,0,0', 0.075 * sA);
  // sombra del cuello sobre el pecho
  blob(ctx, 0, back ? 2.6 : 9.6, 10, 1.6, 0, '0,0,0', (back ? 0.1 : 0.14) * sA);

  ctx.globalCompositeOperation = 'screen';
  const highs = back
    ? [[-8, 52, 2.4, 14, 10], [13, 57, 2, 12, -9], [0, 22, 15, 9, 0, 0.5]]
    : [[-8, 51, 2.4, 14, 12], [14, 56, 2, 12, -10], [-4, 28, 13, 11, 0, 0.5], [-32, 15, 3, 6, 50], [32, 15, 3, 6, -50]];
  for (const h of highs) blob(ctx, h[0], h[1], h[2], h[3], h[4], '255,255,255', (dark ? 0.06 * (h[5] ?? 1) * 0.6 : 0.09) * hA);
  ctx.globalCompositeOperation = 'source-over';
  // 5) textura de tejido
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = dark ? 0.1 : 0.07;
  ctx.save();
  ctx.scale(1 / k * 1.2, 1 / k * 1.2);   // patrón en píxeles de pantalla
  ctx.fillStyle = ctx.createPattern(noise(), 'repeat');
  ctx.fillRect(-60 * k, -10 * k, 140 * k, 110 * k);
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // 6) costuras (pespuntes)
  ctx.lineWidth = 0.08;
  ctx.setLineDash([0.32, 0.22]);
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.16)';
  ctx.beginPath(); ctx.moveTo(-26.4, 71.8); ctx.quadraticCurveTo(0, 73.0, 26.4, 71.8); ctx.stroke();   // ruedo
  ctx.beginPath(); ctx.moveTo(-38.6, 19.6); ctx.lineTo(-29.6, 30.4); ctx.stroke();                    // ruedos de manga
  ctx.beginPath(); ctx.moveTo(38.6, 19.6); ctx.lineTo(29.6, 30.4); ctx.stroke();
  ctx.setLineDash([]);
  // cuello acanalado
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = shade(rgb, dark ? 1.25 : 0.95);
  ctx.beginPath(); ctx.moveTo(-9.6, 0.4); ctx.quadraticCurveTo(0, back ? 3.6 : 11.2, 9.6, 0.4); ctx.stroke();
  ctx.lineWidth = 0.07; ctx.strokeStyle = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)';
  ctx.beginPath(); ctx.moveTo(-10.3, 0.6); ctx.quadraticCurveTo(0, back ? 4.6 : 12.5, 10.3, 0.6); ctx.stroke();
  ctx.restore();   // fin clip

  // 7) contorno sutil
  teePath(ctx, back);
  ctx.lineWidth = 0.09; ctx.strokeStyle = dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.13)';
  ctx.stroke();
  ctx.restore();
}

export function createTeeMockup(canvas) {
  const ctx = canvas.getContext('2d');
  let last = null;
  function fit() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(100, Math.round(r.width * dpr));
    const h = Math.round(w * VIEW.h / VIEW.w);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  return {
    render(opts) {
      last = opts; fit();
      drawTee(ctx, canvas.width, canvas.height, opts);
    },
    rerender() { if (last) this.render(last); },
    snapshot(opts) {
      const size = opts.size || 520;
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 0, size);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#eef3f8');
      x.fillStyle = g; x.fillRect(0, 0, size, size);
      const tmp = document.createElement('canvas');
      tmp.width = Math.round(size * 0.96); tmp.height = Math.round(tmp.width * VIEW.h / VIEW.w);
      drawTee(tmp.getContext('2d'), tmp.width, tmp.height, { ...opts, highlight: null });
      x.drawImage(tmp, (size - tmp.width) / 2, (size - tmp.height) / 2);
      return c.toDataURL('image/jpeg', 0.88);
    },
  };
}
export const TEE_ASPECT = VIEW.w / VIEW.h;
