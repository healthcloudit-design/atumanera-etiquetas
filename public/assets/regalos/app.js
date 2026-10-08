// app.js — Tienda de Regalos Personalizados (regalos.atumaneragraf.com)
// Catálogo → editor (Fabric.js, vista plana del área de impresión) que alimenta en
// vivo el mockup 3D (mug3d.js) → carrito (localStorage) → checkout Mercado Pago.
// Comparte las APIs del sitio: /api/storefront, /api/upload-url, /api/andreani-quote,
// /api/create-preference (tenant atumanera).

import { createMugViewer, webglAvailable } from './mug3d.js';

const TENANT = 'atumanera';
const WHATSAPP = '5491176309675';
const CART_KEY = 'rg_cart_v1';
const DESIGN_W = 1000;                      // unidades lógicas del diseño (ancho)
const fabric = window.fabric;

// Motomensajería GBA — DEBE coincidir con MOTO_TARIFAS de api/create-preference.js
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

const FONTS = [
  { f: 'Pacifico', l: 'Pacifico' }, { f: 'Lobster', l: 'Lobster' }, { f: 'Dancing Script', l: 'Dancing' },
  { f: 'Great Vibes', l: 'Great Vibes' }, { f: 'Caveat', l: 'Caveat' }, { f: 'Permanent Marker', l: 'Marker' },
  { f: 'Amatic SC', l: 'Amatic' }, { f: 'Bebas Neue', l: 'BEBAS' }, { f: 'Montserrat', l: 'Montserrat', w: 800 },
  { f: 'Righteous', l: 'Righteous' }, { f: 'Playfair Display', l: 'Playfair', w: 700 }, { f: 'Nunito', l: 'Nunito', w: 800 },
];
const TEXT_COLORS = ['#1A1A1A', '#FFFFFF', '#EC008C', '#00AEEF', '#8DC63F', '#FFC107', '#D7262E', '#1F4FA8', '#7B3FA0', '#F57C00'];
const BG_COLORS = [null, '#FDE2EF', '#DDF3FD', '#E8F5D5', '#FFF3CD', '#EC008C', '#00AEEF', '#1A1A1A'];

// Próximamente (etapa 2): se muestran en el catálogo como adelanto.
const COMING_SOON = [
  { name: 'Remeras personalizadas', desc: 'Talles S a XXL · frente y espalda', icon: 'tee', color: '#00AEEF' },
  { name: 'Buzos personalizados', desc: 'Con capucha y canguro', icon: 'hoodie', color: '#8DC63F' },
  { name: 'Vasos personalizados', desc: 'Polímero y térmicos', icon: 'glass', color: '#FFC107' },
];

// ── Utilidades ───────────────────────────────────────────────────────────────
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = c => '$' + Math.round((Number(c) || 0) / 100).toLocaleString('es-AR');
const pesos = n => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
function toast(msg, kind = 'ok') {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + kind;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = 'toast'), 2800);
}
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
async function loadFont(f, w = 400) { try { await document.fonts.load(`${w} 60px "${f}"`); } catch {} }
function uid() { return Math.random().toString(36).slice(2, 10); }

// ── Estado ───────────────────────────────────────────────────────────────────
let PRODUCTS = [];
let cart = lsGet(CART_KEY, []);
const HAS_GL = webglAvailable();
let ed = null;   // editor actual

// ── Arranque ─────────────────────────────────────────────────────────────────
async function init() {
  fabric.Object.prototype.set({
    transparentCorners: false, cornerColor: '#EC008C', cornerStrokeColor: '#fff', borderColor: '#00AEEF',
    cornerStyle: 'circle', cornerSize: 14, touchCornerSize: 36, borderScaleFactor: 2, padding: 4,
  });
  updateCartBadge();
  bindGlobal();
  try {
    const r = await fetch(`/api/storefront?tenant=${TENANT}&category=Regalos`);
    if (!r.ok) throw new Error('storefront ' + r.status);
    const d = await r.json();
    PRODUCTS = (d.products || []).filter(p => p.options && p.options.editor);
  } catch (e) {
    console.warn(e);
  }
  renderCatalog();
  route();
  window.addEventListener('hashchange', route);
  handlePaymentReturn();
}

function route() {
  const m = location.hash.match(/^#\/p\/([a-z0-9-]+)/);
  if (m) {
    const p = PRODUCTS.find(x => x.slug === m[1]);
    if (p) return openEditor(p);
  }
  closeEditor();
}

// ── Catálogo ─────────────────────────────────────────────────────────────────
function renderCatalog() {
  const grid = $('#grid');
  const cards = PRODUCTS.map(p => `
    <a class="card" href="#/p/${esc(p.slug)}">
      <div class="cimg" data-thumb="${esc(p.slug)}"><div class="skel"></div></div>
      <div class="cbody">
        <span class="chip">Taza 11 oz</span>
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.notes || p.size_description || '')}</p>
        <div class="crow"><strong>${money(p.price)}</strong><span class="cta">Diseñar ✎</span></div>
      </div>
    </a>`).join('');
  const soon = COMING_SOON.map(c => `
    <div class="card soon">
      <div class="cimg" style="--c:${c.color}">${ICONS[c.icon]}</div>
      <div class="cbody"><span class="chip soonchip">Próximamente</span><h3>${esc(c.name)}</h3><p>${esc(c.desc)}</p></div>
    </div>`).join('');
  grid.innerHTML = (cards || `<div class="empty">Estamos cargando los productos. Escribinos por <a href="https://wa.me/${WHATSAPP}" target="_blank" rel="noopener">WhatsApp</a> y te ayudamos.</div>`) + soon;
  if (PRODUCTS.length) generateThumbs();
}

const thumbCache = {};
async function generateThumbs() {
  if (!HAS_GL) return;
  await document.fonts.ready;
  await Promise.all([loadFont('Pacifico'), loadFont('Nunito', 800)]);
  for (const p of PRODUCTS) {
    const box = $(`[data-thumb="${p.slug}"]`);
    if (!box) continue;
    if (!thumbCache[p.slug]) {
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-2000px;top:0;width:520px;height:520px;';
      document.body.appendChild(holder);
      try {
        const spec = specOf(p);
        const v = createMugViewer(holder, spec);
        v.setDesign(sampleDesign(spec));
        const c = (p.options.colors || []).find(x => x.name === 'Fucsia') || (p.options.colors || [])[0];
        if (c) v.setColors({ inner: c.hex, handle: c.hex });
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        thumbCache[p.slug] = v.snapshot({ size: 520, u: 0.62, bg: ['#ffffff', '#f1f5fa'], handle: true });
        v.dispose();
      } catch (e) { console.warn('thumb', e); }
      holder.remove();
    }
    if (thumbCache[p.slug]) box.innerHTML = `<img src="${thumbCache[p.slug]}" alt="${esc(p.name)}">`;
  }
}

// Diseño de ejemplo para las tarjetas del catálogo
function sampleDesign(spec) {
  const W = 2048, H = Math.round(W * spec.printH / spec.printW);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const cols = ['#00AEEF', '#EC008C', '#8DC63F', '#FFC107'];
  for (let i = 0; i < 70; i++) {
    x.fillStyle = cols[i % 4]; x.globalAlpha = 0.85;
    const r = 8 + (i * 37 % 22);
    x.beginPath(); x.arc((i * 293) % W, (i * 157) % H, r, 0, Math.PI * 2); x.fill();
  }
  x.globalAlpha = 1;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillStyle = '#EC008C'; x.font = `${Math.round(H * 0.3)}px Pacifico`;
  x.fillText('Tu foto', W * 0.66, H * 0.42);
  x.fillStyle = '#00AEEF'; x.font = `800 ${Math.round(H * 0.15)}px Nunito`;
  x.fillText('+ tu frase', W * 0.66, H * 0.74);
  return c;
}

const ICONS = {
  tee: `<svg viewBox="0 0 120 120"><path d="M42 18 L24 26 L10 46 L24 56 L32 48 L32 104 L88 104 L88 48 L96 56 L110 46 L96 26 L78 18 Q60 32 42 18Z" fill="var(--c)" opacity=".9"/><path d="M42 18 Q60 32 78 18" stroke="#fff" stroke-width="3" fill="none"/></svg>`,
  hoodie: `<svg viewBox="0 0 120 120"><path d="M40 22 Q60 6 80 22 L98 30 L112 70 L98 76 L90 58 L90 106 L30 106 L30 58 L22 76 L8 70 L22 30Z" fill="var(--c)" opacity=".9"/><path d="M44 26 Q60 44 76 26" stroke="#fff" stroke-width="3" fill="none"/><rect x="44" y="76" width="32" height="16" rx="5" fill="#fff" opacity=".45"/></svg>`,
  glass: `<svg viewBox="0 0 120 120"><path d="M34 16 L86 16 L80 104 Q60 110 40 104Z" fill="var(--c)" opacity=".85"/><path d="M40 30 L44 96" stroke="#fff" stroke-width="5" opacity=".5" stroke-linecap="round"/></svg>`,
};

// ── Editor ───────────────────────────────────────────────────────────────────
function specOf(p) {
  const o = p.options || {};
  return {
    printW: (o.print && o.print.w_cm) || 20, printH: (o.print && o.print.h_cm) || 9, dpi: (o.print && o.print.dpi) || 300,
    height: (o.mug && o.mug.height_cm) || 9.5, diameter: (o.mug && o.mug.diameter_cm) || 8.2,
  };
}

async function openEditor(p) {
  if (ed && ed.p.slug === p.slug) return;
  closeEditor();
  document.body.classList.add('editing');
  window.scrollTo(0, 0);
  const spec = specOf(p);
  const DESIGN_H = Math.round(DESIGN_W * spec.printH / spec.printW);
  const colors = (p.options.colors || []);
  ed = { p, spec, DESIGN_H, qty: 1, color: colors[0] || null, bg: null, photos: new Map(), viewer: null, fc: null };

  // Cabecera / info
  $('#edTitle').textContent = p.name;
  $('#edPrice').textContent = money(p.price);
  $('#edInfo').innerHTML = [p.material, p.size_description, p.elaboration_days ? 'Elaboración: ' + p.elaboration_days : '']
    .filter(Boolean).map(esc).join('<br>');
  $('#qtyVal').textContent = '1';

  // Color de taza
  const colorBox = $('#colorSection');
  if (colors.length) {
    colorBox.hidden = false;
    $('#colorLabel').textContent = p.options.color_label || 'Color';
    $('#colorRow').innerHTML = colors.map((c, i) => `<button class="sw${i === 0 ? ' on' : ''}" style="--sw:${esc(c.hex)}" data-color="${i}" title="${esc(c.name)}" aria-label="${esc(c.name)}"></button>`).join('');
    $('#colorName').textContent = colors[0].name;
  } else colorBox.hidden = true;

  // Fondo
  $('#bgRow').innerHTML = BG_COLORS.map((c, i) => `<button class="sw${i === 0 ? ' on' : ''}${c ? '' : ' none'}" style="--sw:${c || '#fff'}" data-bg="${i}" aria-label="${c ? 'Fondo ' + c : 'Sin fondo'}"></button>`).join('');

  // Mostrar la vista antes de medir (con display:none todo mide 0)
  $('#editorView').hidden = false;
  $('#catalogView').hidden = true;

  // Visor 3D
  const stage = $('#stage3d');
  stage.innerHTML = '';
  if (HAS_GL) {
    ed.viewer = createMugViewer(stage, spec);
    if (ed.color) ed.viewer.setColors({ inner: ed.color.hex, handle: ed.color.hex });
    $('#noGl').hidden = true;
  } else {
    $('#noGl').hidden = false;
  }

  // Canvas plano (Fabric)
  const wrap = $('#flatWrap');
  wrap.style.aspectRatio = `${spec.printW} / ${spec.printH}`;
  $('#flatHost').innerHTML = '<canvas id="flatCanvas"></canvas>';
  const fc = new fabric.Canvas('flatCanvas', { preserveObjectStacking: true, selection: false, enableRetinaScaling: true });
  ed.fc = fc;
  sizeFlat();
  ed.ro = new ResizeObserver(() => sizeFlat());
  ed.ro.observe(wrap);

  // Textura viva para el 3D
  ed.tex = document.createElement('canvas');
  ed.tex.width = 2048; ed.tex.height = Math.round(2048 * spec.printH / spec.printW);
  if (ed.viewer) ed.viewer.setDesign(ed.tex);
  let pending = false, busy = false;
  const pushTexture = () => {
    if (busy || pending || !ed) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!ed || ed.fc !== fc) return;
      busy = true;
      try {
        const el = fc.toCanvasElement(ed.tex.width / fc.getWidth());
        const x = ed.tex.getContext('2d');
        x.clearRect(0, 0, ed.tex.width, ed.tex.height);
        x.drawImage(el, 0, 0, ed.tex.width, ed.tex.height);
        if (ed.viewer) ed.viewer.refresh();
      } finally { busy = false; }
    });
  };
  ed.pushTexture = pushTexture;
  fc.on('after:render', pushTexture);
  fc.on('selection:created', syncSelection);
  fc.on('selection:updated', syncSelection);
  fc.on('selection:cleared', syncSelection);
  fc.on('object:modified', syncSelection);

  // Arranca con una frase de ejemplo para que la taza no esté vacía
  await loadFont('Pacifico');
  const t = new fabric.IText('Tu frase acá', {
    left: DESIGN_W / 2, top: DESIGN_H / 2, originX: 'center', originY: 'center',
    fontFamily: 'Pacifico', fontSize: 78, fill: '#EC008C', textAlign: 'center', rgPlaceholder: true,
  });
  fc.add(t);
  fc.requestRenderAll();
  syncSelection();
}

function closeEditor() {
  if (ed) {
    if (ed.ro) ed.ro.disconnect();
    try { ed.fc.dispose(); } catch {}
    if (ed.viewer) ed.viewer.dispose();
    ed.photos.forEach(ph => { if (ph.url) URL.revokeObjectURL(ph.url); });
    ed = null;
  }
  document.body.classList.remove('editing');
  $('#editorView').hidden = true;
  $('#catalogView').hidden = false;
}

function sizeFlat() {
  if (!ed) return;
  const host = $('#flatWrap');
  const w = Math.floor(host.clientWidth);
  if (w < 50 || w === ed.lastW) return;
  ed.lastW = w;
  const h = Math.round(w * ed.spec.printH / ed.spec.printW);
  ed.fc.setDimensions({ width: w, height: h });
  ed.fc.setZoom(w / DESIGN_W);
  ed.fc.requestRenderAll();
}

function activeObj() { return ed && ed.fc.getActiveObject(); }

function syncSelection() {
  if (!ed) return;
  const o = activeObj();
  $('#objTools').hidden = !o;
  const isText = o && o.type === 'i-text';
  $('#textTools').hidden = !isText;
  $('#photoTools').hidden = !(o && o.type === 'image');
  if (isText) {
    $('#textInput').value = o.text;
    $('#fontSel').value = o.fontFamily;
    $('#sizeRange').value = Math.round(o.fontSize * (o.scaleX || 1));
    $$('#textColorRow .sw').forEach(b => b.classList.toggle('on', b.dataset.c.toLowerCase() === String(o.fill).toLowerCase()));
    $('#strokeChk').checked = !!o.stroke;
  }
  $('#emptyHint').hidden = ed.fc.getObjects().length > 0;
}

// Foto
async function handlePhoto(file) {
  if (!ed || !file) return;
  if (!/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) return toast('Elegí un archivo de imagen (JPG o PNG).', 'err');
  if (file.size > 25 * 1024 * 1024) return toast('La foto supera los 25 MB.', 'err');
  const url = URL.createObjectURL(file);
  let img;
  try {
    img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  } catch {
    URL.revokeObjectURL(url);
    return toast('No pudimos abrir esa imagen. Probá con una foto JPG o PNG.', 'err');
  }
  // Para editar alcanza con 3000 px de lado (el archivo original se sube intacto)
  let el = img;
  const max = 3000, big = Math.max(img.naturalWidth, img.naturalHeight);
  if (big > max) {
    const k = max / big, c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    el = c;
  }
  const id = uid();
  ed.photos.set(id, { file, url, path: null, w: img.naturalWidth, h: img.naturalHeight });
  const fimg = new fabric.Image(el, { originX: 'center', originY: 'center', rgPhotoId: id });
  const H = ed.DESIGN_H;
  const s = (H * 0.88) / fimg.height;
  const existing = ed.fc.getObjects().filter(o => o.type === 'image').length;
  fimg.set({ scaleX: s, scaleY: s, left: existing ? (existing % 2 ? 250 : 750) : DESIGN_W / 2, top: H / 2 });
  // la frase de ejemplo deja lugar a la foto
  ed.fc.getObjects().filter(o => o.rgPlaceholder && o.text === 'Tu frase acá').forEach(o => ed.fc.remove(o));
  ed.fc.add(fimg);
  ed.fc.setActiveObject(fimg);
  ed.fc.requestRenderAll();
  syncSelection();
  if (ed.viewer) ed.viewer.setView(0);
  toast('¡Foto cargada! Movela y agrandala sobre la taza.');
}

async function addText() {
  if (!ed) return;
  await loadFont('Pacifico');
  const t = new fabric.IText('Tu texto', {
    left: DESIGN_W / 2, top: ed.DESIGN_H * 0.78, originX: 'center', originY: 'center',
    fontFamily: 'Pacifico', fontSize: 64, fill: '#1A1A1A', textAlign: 'center',
  });
  ed.fc.add(t); ed.fc.setActiveObject(t); ed.fc.requestRenderAll(); syncSelection();
  const ti = $('#textInput'); ti.focus(); ti.select();
}

function photoFit(mode) {
  const o = activeObj(); if (!o || o.type !== 'image') return;
  const W = DESIGN_W, H = ed.DESIGN_H;
  const s = mode === 'cover' ? Math.max(W / o.width, H / o.height) : (H * 0.92) / o.height;
  o.set({ scaleX: s, scaleY: s, angle: 0, left: W / 2, top: H / 2 });
  o.setCoords(); ed.fc.requestRenderAll();
  if (ed.viewer) ed.viewer.setView(0);
}

async function bothSides() {
  const o = activeObj(); if (!o) return;
  const c = await new Promise(r => o.clone(r, ['rgPhotoId']));
  o.set({ left: 250 }); o.setCoords();
  c.set({ left: 750, top: o.top }); c.setCoords();
  ed.fc.add(c); ed.fc.requestRenderAll();
  toast('Listo: el diseño está de los dos lados de la taza.');
  if (ed.viewer) ed.viewer.setView('right');
}

// ── Exportación / subida ─────────────────────────────────────────────────────
function contentCenterU() {
  const objs = ed.fc.getObjects();
  if (!objs.length) return 0.5;
  let sx = 0, sw = 0;
  objs.forEach(o => { const b = o.getBoundingRect(true, true); const w = Math.max(1, b.width * b.height); sx += (b.left + b.width / 2) * w; sw += w; });
  return Math.min(0.95, Math.max(0.05, sx / sw / DESIGN_W));
}

async function dataUrlToBlob(d) { return (await fetch(d)).blob(); }

async function requestUpload(kind, blob) {
  const r = await fetch('/api/upload-url', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant': TENANT },
    body: JSON.stringify({ kind, contentType: blob.type, size: blob.size }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'No se pudo preparar la subida');
  return d;
}

function putSigned(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('cacheControl', '3600');
    fd.append('', blob);
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('x-upsert', 'false');
    x.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error('Error al subir (' + x.status + ')')));
    x.onerror = () => reject(new Error('Error de red al subir'));
    x.send(fd);
  });
}

async function uploadBlob(kind, blob, label) {
  const { path, signedUrl } = await requestUpload(kind, blob);
  await putSigned(signedUrl, blob, p => setBusy(`${label} ${Math.round(p * 100)}%`));
  return path;
}

function normalizedType(file) {
  if (file.type) return file.type.toLowerCase();
  if (/\.heic$/i.test(file.name)) return 'image/heic';
  if (/\.heif$/i.test(file.name)) return 'image/heif';
  return 'image/jpeg';
}

async function addToCart() {
  if (!ed) return;
  const fc = ed.fc;
  const objs = fc.getObjects();
  const onlyPlaceholder = objs.length && objs.every(o => o.rgPlaceholder && o.text === 'Tu frase acá');
  if (!objs.length || onlyPlaceholder) return toast('Personalizá tu taza: subí una foto o escribí tu frase.', 'err');

  fc.discardActiveObject(); fc.requestRenderAll(); syncSelection();
  const btn = $('#addBtn'); btn.disabled = true;
  try {
    setBusy('Preparando tu diseño…');
    // 1) Archivo de producción: PNG del área de impresión a 300 dpi (transparente)
    const pxW = Math.round(ed.spec.printW / 2.54 * ed.spec.dpi);
    const prodData = fc.toDataURL({ format: 'png', multiplier: pxW / fc.getWidth() });
    const prodBlob = await dataUrlToBlob(prodData);

    // 2) Fotos originales (solo las que siguen en el diseño)
    const usedIds = [...new Set(objs.filter(o => o.rgPhotoId).map(o => o.rgPhotoId))];
    let n = 0;
    for (const id of usedIds) {
      const ph = ed.photos.get(id);
      if (!ph || ph.path) continue;
      n++;
      const typed = new Blob([ph.file], { type: normalizedType(ph.file) });
      ph.path = await uploadBlob('original', typed, `Subiendo tu foto${usedIds.length > 1 ? ' ' + n : ''}…`);
    }
    const production = await uploadBlob('production', prodBlob, 'Guardando el archivo de impresión…');

    // 3) Mockup para el carrito / panel
    setBusy('Generando vista previa…');
    const thumb = ed.viewer
      ? ed.viewer.snapshot({ size: 480, u: contentCenterU() })
      : fc.toDataURL({ format: 'jpeg', quality: 0.85, multiplier: 480 / fc.getWidth() });

    // 4) Diseño (JSON) para poder regenerarlo
    const json = fc.toJSON(['rgPhotoId']);
    json.objects.forEach(o => { if (o.type === 'image' && o.rgPhotoId) o.src = 'photo:' + o.rgPhotoId; });
    const photos = {};
    usedIds.forEach(id => { const ph = ed.photos.get(id); if (ph) photos[id] = { path: ph.path, w: ph.w, h: ph.h, name: ph.file.name }; });
    const texts = objs.filter(o => o.type === 'i-text').map(o => o.text.trim()).filter(Boolean);
    const design = {
      v: 1, editor: 'mug', product: ed.p.slug,
      print: { w_cm: ed.spec.printW, h_cm: ed.spec.printH, dpi: ed.spec.dpi, design_w: DESIGN_W, design_h: ed.DESIGN_H },
      background: ed.bg, photos, canvas: json,
    };

    const item = {
      id: uid(), productSlug: ed.p.slug, name: ed.p.name, unitPrice: ed.p.price, qty: ed.qty,
      color: ed.color ? ed.color.name : null, colorHex: ed.color ? ed.color.hex : null,
      colorLabel: ed.p.options.color_label || 'Color',
      text: (texts.join(' / ') || '(foto)').slice(0, 60),
      font: (objs.find(o => o.type === 'i-text') || {}).fontFamily || '-',
      thumb, design, files: { production, originals: usedIds.map(id => ed.photos.get(id).path).filter(Boolean) },
      ship: ed.p.options.shipping || null,
    };
    cart.push(item);
    if (!saveCart()) { cart.pop(); throw new Error('No hay espacio en el navegador para guardar el carrito.'); }
    updateCartBadge();
    setBusy(null);
    toast('¡Agregado al carrito!');
    openCart();
  } catch (e) {
    console.error(e);
    setBusy(null);
    toast(e.message || 'No se pudo agregar. Probá de nuevo.', 'err');
  } finally {
    btn.disabled = false;
  }
}

function setBusy(msg) {
  const b = $('#busy');
  if (!msg) { b.hidden = true; return; }
  b.hidden = false; $('#busyMsg').textContent = msg;
}

// ── Carrito ──────────────────────────────────────────────────────────────────
function saveCart() { return lsSet(CART_KEY, cart); }
function cartTotal() { return cart.reduce((a, i) => a + i.unitPrice * i.qty, 0); }
function updateCartBadge() {
  const n = cart.reduce((a, i) => a + i.qty, 0);
  $('#cartCount').textContent = n;
  $('#cartCount').hidden = !n;
}
function openCart() { renderCart(); $('#cartDrawer').classList.add('open'); $('#shade').hidden = false; }
function closeCart() { $('#cartDrawer').classList.remove('open'); $('#shade').hidden = true; }
function renderCart() {
  const box = $('#cartItems');
  if (!cart.length) {
    box.innerHTML = '<div class="cempty">Tu carrito está vacío.<br><a href="#" data-close-cart>Elegí un producto para diseñar</a></div>';
  } else {
    box.innerHTML = cart.map((it, i) => `
      <div class="citem">
        <img src="${esc(it.thumb)}" alt="">
        <div class="cinfo">
          <strong>${esc(it.name)}</strong>
          ${it.color ? `<span class="muted"><i class="dot" style="background:${esc(it.colorHex)}"></i>${esc(it.colorLabel)}: ${esc(it.color)}</span>` : ''}
          <span class="muted">${esc(it.text)}</span>
          <div class="qty sm"><button data-q="${i}" data-d="-1" aria-label="Menos">−</button><span>${it.qty}</span><button data-q="${i}" data-d="1" aria-label="Más">+</button></div>
        </div>
        <div class="cright"><strong>${money(it.unitPrice * it.qty)}</strong><button class="link" data-rm="${i}">Quitar</button></div>
      </div>`).join('');
  }
  $('#cartTotal').textContent = money(cartTotal());
  $('#checkoutBtn').disabled = !cart.length;
}

// ── Checkout ─────────────────────────────────────────────────────────────────
let quote = { method: 'retiro', cost: 0, ok: true };
function openCheckout() {
  if (!cart.length) return;
  closeCart();
  const locs = Object.keys(MOTO_TARIFAS).sort((a, b) => a.localeCompare(b));
  $('#motoLocality').innerHTML = '<option value="">Elegí tu localidad…</option>' + locs.map(l => `<option value="${esc(l)}">${esc(l)} — ${pesos(MOTO_TARIFAS[l])}</option>`).join('');
  $('#coItems').innerHTML = cart.map(it => `<div class="srow"><span>${esc(it.name)}${it.color ? ' · ' + esc(it.color) : ''} ×${it.qty}</span><span>${money(it.unitPrice * it.qty)}</span></div>`).join('');
  $('#coErr').textContent = '';
  setShip($('input[name=ship]:checked').value);
  $('#checkoutModal').hidden = false;
}
function closeCheckout() { $('#checkoutModal').hidden = true; }

function setShip(method) {
  quote = { method, cost: 0, ok: method === 'retiro' };
  $('#motoFields').hidden = method !== 'moto';
  $('#andreaniFields').hidden = method !== 'andreani';
  $('#shipInfo').textContent = method === 'retiro' ? 'Retirás sin cargo en San Fernando (coordinamos por WhatsApp).' : '';
  if (method === 'moto') onMoto();
  if (method === 'andreani') onZip();
  renderSummary();
}
function onMoto() {
  const l = $('#motoLocality').value;
  quote.ok = !!MOTO_TARIFAS[l]; quote.cost = MOTO_TARIFAS[l] || 0;
  $('#shipInfo').textContent = l ? `🛵 Motomensajería a ${l}: ${pesos(quote.cost)}` : 'Elegí tu localidad.';
  renderSummary();
}
let zipTimer = null, zipCtl = null;
function onZip() {
  clearTimeout(zipTimer);
  const cp = $('#shipZip').value.trim();
  quote.ok = false; quote.cost = 0; renderSummary();
  if (!/^\d{4}$/.test(cp)) { $('#shipInfo').textContent = 'Ingresá tu código postal (4 dígitos).'; return; }
  $('#shipInfo').textContent = '⏳ Cotizando Andreani…';
  zipTimer = setTimeout(async () => {
    if (zipCtl) zipCtl.abort();
    zipCtl = new AbortController();
    try {
      const items = cart.map(i => (i.ship ? { ...i.ship, qty: i.qty } : {}));
      const r = await fetch('/api/andreani-quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant': TENANT },
        body: JSON.stringify({ cpDestino: cp, items, declared: cartTotal() / 100 }), signal: zipCtl.signal,
      });
      const d = await r.json();
      if (d.ok && d.totalARS) {
        quote.ok = true; quote.cost = d.totalARS;
        $('#shipInfo').textContent = `🚚 Envío Andreani a CP ${cp}: ${pesos(d.totalARS)}`;
      } else {
        quote.ok = true; quote.cost = null;
        $('#shipInfo').textContent = '🚚 Envío Andreani: el costo final se calcula al pagar.';
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      quote.ok = true; quote.cost = null;
      $('#shipInfo').textContent = '🚚 Envío Andreani: el costo final se calcula al pagar.';
    }
    renderSummary();
  }, 350);
}
function renderSummary() {
  const sub = cartTotal() / 100;
  const ship = quote.cost;
  $('#coShip').textContent = quote.method === 'retiro' ? 'Sin cargo' : (ship == null ? 'a calcular' : (ship ? pesos(ship) : '—'));
  $('#coTotal').textContent = pesos(sub + (ship || 0));
}

async function pay() {
  const err = $('#coErr'); err.textContent = '';
  const buyer = { name: $('#bName').value.trim(), email: $('#bEmail').value.trim(), phone: $('#bPhone').value.trim() };
  if (!buyer.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer.email)) { err.textContent = 'Completá tu nombre y un email válido (ahí te avisamos del pedido).'; return; }
  const method = $('input[name=ship]:checked').value;
  const shipping = { method };
  if (method === 'moto') {
    shipping.locality = $('#motoLocality').value; shipping.address = $('#motoAddr').value.trim();
    if (!MOTO_TARIFAS[shipping.locality]) { err.textContent = 'Elegí tu localidad para la moto.'; return; }
    if (!shipping.address) { err.textContent = 'Completá la dirección de entrega.'; return; }
  }
  if (method === 'andreani') {
    shipping.zip = $('#shipZip').value.trim(); shipping.address = $('#shipAddr').value.trim();
    shipping.city = $('#shipCity').value.trim(); shipping.province = $('#shipProv').value.trim();
    if (!/^\d{4}$/.test(shipping.zip)) { err.textContent = 'Ingresá un código postal válido.'; return; }
    if (!shipping.address || !shipping.city) { err.textContent = 'Completá dirección y localidad.'; return; }
  }
  const cartItems = cart.map(it => ({
    productSlug: it.productSlug, qty: it.qty, text: it.text, font: it.font,
    thumbnailUrl: it.thumb, design: it.design, files: it.files,
    variant: it.color ? { color: it.color } : null,
  }));
  const b = $('#payBtn'); b.disabled = true; b.textContent = 'Procesando…';
  try {
    const r = await fetch('/api/create-preference', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant': TENANT },
      body: JSON.stringify({ site: 'regalos', buyer, shipping, cartItems }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.initPoint) throw new Error(d.error || 'No se pudo iniciar el pago');
    lsSet('rg_last_order', { id: d.orderId, n: d.orderNumber, at: Date.now() });
    location.href = d.initPoint;
  } catch (e) {
    err.textContent = e.message + '. Si sigue fallando, escribinos por WhatsApp.';
    b.disabled = false; b.textContent = 'Pagar con Mercado Pago';
  }
}

function handlePaymentReturn() {
  const qs = new URLSearchParams(location.search);
  const m = location.pathname.match(/^\/pago-(exitoso|fallido|pendiente)/);
  const st = (m && m[1]) || qs.get('pago');
  if (!st) return;
  const last = lsGet('rg_last_order', null);
  const num = last && last.n ? ` #${last.n}` : '';
  const MSG = {
    exitoso: ['¡Gracias por tu compra! 🎉', `Recibimos tu pedido${num}. Revisamos tu diseño y te avisamos por mail cuando entre en producción.`],
    pendiente: ['Tu pago está pendiente', 'Apenas Mercado Pago lo acredite, empezamos con tu pedido. Te avisamos por mail.'],
    fallido: ['El pago no se completó', 'No se realizó ningún cobro. Tu carrito sigue guardado para que lo intentes de nuevo.'],
  }[st];
  if (!MSG) return;
  if (st === 'exitoso') { cart = []; saveCart(); updateCartBadge(); }
  $('#resultTitle').textContent = MSG[0];
  $('#resultMsg').textContent = MSG[1];
  $('#resultModal').hidden = false;
  history.replaceState(null, '', (m ? '/' : location.pathname) + (location.hash || ''));
}

// ── Eventos ──────────────────────────────────────────────────────────────────
function bindGlobal() {
  $('#cartBtn').onclick = openCart;
  $('#shade').onclick = closeCart;
  $('#closeCart').onclick = closeCart;
  $('#checkoutBtn').onclick = openCheckout;
  $('#closeCheckout').onclick = closeCheckout;
  $('#payBtn').onclick = pay;
  $('#resultOk').onclick = () => ($('#resultModal').hidden = true);
  $$('input[name=ship]').forEach(r => (r.onchange = () => setShip(r.value)));
  $('#motoLocality').onchange = onMoto;
  $('#shipZip').oninput = onZip;
  $('#cartItems').onclick = e => {
    const q = e.target.closest('[data-q]'), rm = e.target.closest('[data-rm]'), cl = e.target.closest('[data-close-cart]');
    if (q) { const it = cart[+q.dataset.q]; it.qty = Math.max(1, Math.min(10, it.qty + +q.dataset.d)); }
    if (rm) cart.splice(+rm.dataset.rm, 1);
    if (cl) { e.preventDefault(); closeCart(); location.hash = ''; return; }
    if (q || rm) { saveCart(); updateCartBadge(); renderCart(); }
  };

  // Editor
  $('#backBtn').onclick = e => { e.preventDefault(); location.hash = ''; };
  $('#photoInput').onchange = e => { handlePhoto(e.target.files[0]); e.target.value = ''; };
  const drop = $('#dropZone');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => handlePhoto(e.dataTransfer.files[0]));
  $('#addTextBtn').onclick = addText;
  $('#textInput').oninput = e => { const o = activeObj(); if (o && o.type === 'i-text') { o.set({ text: e.target.value || ' ', rgPlaceholder: false }); ed.fc.requestRenderAll(); } };
  $('#fontSel').innerHTML = FONTS.map(f => `<option value="${esc(f.f)}" style="font-family:'${esc(f.f)}'">${esc(f.l)}</option>`).join('');
  $('#fontSel').onchange = async e => {
    const o = activeObj(); if (!o || o.type !== 'i-text') return;
    const f = FONTS.find(x => x.f === e.target.value) || {};
    await loadFont(e.target.value, f.w || 400);
    o.set({ fontFamily: e.target.value, fontWeight: f.w || 'normal' });
    ed.fc.requestRenderAll();
  };
  $('#sizeRange').oninput = e => { const o = activeObj(); if (o && o.type === 'i-text') { o.set({ fontSize: +e.target.value, scaleX: 1, scaleY: 1 }); o.setCoords(); ed.fc.requestRenderAll(); } };
  $('#textColorRow').innerHTML = TEXT_COLORS.map(c => `<button class="sw" style="--sw:${c}" data-c="${c}" aria-label="Color ${c}"></button>`).join('');
  $('#textColorRow').onclick = e => {
    const b = e.target.closest('[data-c]'); const o = activeObj(); if (!b || !o || o.type !== 'i-text') return;
    o.set({ fill: b.dataset.c }); ed.fc.requestRenderAll(); syncSelection();
  };
  $('#strokeChk').onchange = e => {
    const o = activeObj(); if (!o || o.type !== 'i-text') return;
    const light = ['#ffffff', '#ffc107', '#fde2ef'].includes(String(o.fill).toLowerCase());
    o.set(e.target.checked ? { stroke: light ? '#1A1A1A' : '#FFFFFF', strokeWidth: 6, paintFirst: 'stroke' } : { stroke: null, strokeWidth: 0 });
    ed.fc.requestRenderAll();
  };
  $('#fitFront').onclick = () => photoFit('front');
  $('#fitCover').onclick = () => photoFit('cover');
  $('#bothSides').onclick = bothSides;
  $('#centerBtn').onclick = () => { const o = activeObj(); if (!o) return; o.set({ left: DESIGN_W / 2, top: ed.DESIGN_H / 2 }); o.setCoords(); ed.fc.requestRenderAll(); if (ed.viewer) ed.viewer.setView(0); };
  $('#fwdBtn').onclick = () => { const o = activeObj(); if (o) { ed.fc.bringForward(o); ed.fc.requestRenderAll(); } };
  $('#backLayerBtn').onclick = () => { const o = activeObj(); if (o) { ed.fc.sendBackwards(o); ed.fc.requestRenderAll(); } };
  $('#delBtn').onclick = () => { const o = activeObj(); if (o) { ed.fc.remove(o); ed.fc.discardActiveObject(); ed.fc.requestRenderAll(); syncSelection(); } };
  document.addEventListener('keydown', e => {
    if (!ed || !['Delete', 'Backspace'].includes(e.key)) return;
    if (/input|textarea|select/i.test(document.activeElement.tagName)) return;
    const o = activeObj(); if (o && !o.isEditing) { ed.fc.remove(o); ed.fc.requestRenderAll(); syncSelection(); }
  });
  $('#colorRow').onclick = e => {
    const b = e.target.closest('[data-color]'); if (!b || !ed) return;
    ed.color = ed.p.options.colors[+b.dataset.color];
    $$('#colorRow .sw').forEach(x => x.classList.toggle('on', x === b));
    $('#colorName').textContent = ed.color.name;
    if (ed.viewer) { ed.viewer.setColors({ inner: ed.color.hex, handle: ed.color.hex }); ed.viewer.setView(Math.PI * 0.72); }
  };
  $('#bgRow').onclick = e => {
    const b = e.target.closest('[data-bg]'); if (!b || !ed) return;
    ed.bg = BG_COLORS[+b.dataset.bg];
    $$('#bgRow .sw').forEach(x => x.classList.toggle('on', x === b));
    ed.fc.setBackgroundColor(ed.bg || '', () => ed.fc.requestRenderAll());
  };
  $$('[data-view]').forEach(b => (b.onclick = () => {
    if (!ed || !ed.viewer) return;
    if (b.dataset.view === 'spin') { ed.viewer.setAutoRotate(!ed.viewer.autoRotate); b.classList.toggle('on', ed.viewer.autoRotate); return; }
    ed.viewer.setView(b.dataset.view);
  }));
  $('#qtyMinus').onclick = () => { if (!ed) return; ed.qty = Math.max(1, ed.qty - 1); $('#qtyVal').textContent = ed.qty; };
  $('#qtyPlus').onclick = () => { if (!ed) return; ed.qty = Math.min(10, ed.qty + 1); $('#qtyVal').textContent = ed.qty; };
  $('#addBtn').onclick = addToCart;
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(sizeFlat, 120); });
}

init();
