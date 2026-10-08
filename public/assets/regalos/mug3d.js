// mug3d.js — Visor 3D de taza en tiempo real (three.js).
// Unidades: centímetros. La taza se arma con geometría real (11 oz: Ø 8,2 × 9,5 cm)
// y el diseño del cliente se aplica como textura sobre una "banda" cilíndrica que
// cubre exactamente el área de impresión (por defecto 20 × 9 cm), dejando libre la
// zona del asa — igual que la sublimación real.
//
// API:
//   const v = createMugViewer(container, { printW, printH, height, diameter })
//   v.setDesign(canvas)            → canvas 2D con el diseño (proporción printW:printH)
//   v.refresh()                    → avisar que el canvas cambió
//   v.setColors({ inner, handle }) → colores interior/asa (hex) o null = blanco
//   v.setView('left'|'front'|'right'|azimutRad)
//   v.setAutoRotate(bool)
//   v.snapshot({ size, u })        → dataURL JPEG (u = posición 0..1 del diseño a mostrar)
//   v.dispose()

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch { return false; }
}

// Tubo de sección ovalada para una curva contenida en el plano x = 0 (el asa).
// rThick = radio en el plano de la curva, rWide = radio a lo ancho (eje x).
function ovalTube(curve, segs, radial, rThick, rWide) {
  const pos = [], nor = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const p = curve.getPointAt(t), tg = curve.getTangentAt(t);
    const n = new THREE.Vector3(0, -tg.z, tg.y).normalize();   // perpendicular dentro del plano
    const b = new THREE.Vector3(1, 0, 0);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      pos.push(p.x + b.x * s * rWide, p.y + n.y * c * rThick, p.z + n.z * c * rThick);
      // normal de la elipse
      const nn = new THREE.Vector3().addScaledVector(n, c / rThick).addScaledVector(b, s / rWide).normalize();
      nor.push(nn.x, nn.y, nn.z);
    }
  }
  for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b2 = a + radial + 1;
    idx.push(a, a + 1, b2, b2, a + 1, b2 + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

export function createMugViewer(container, opts = {}) {
  const printW = opts.printW || 20, printH = opts.printH || 9;
  const H = opts.height || 9.5, R = (opts.diameter || 8.2) / 2;
  const WALL = 0.32;

  // ── Renderer / escena ──────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Sin tone mapping: el diseño impreso tiene que verse con sus colores reales.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.035).texture;
  scene.environment = envTex;

  const camera = new THREE.PerspectiveCamera(26, 1, 0.5, 200);
  const target = new THREE.Vector3(0, H * 0.47, 0);

  // Luces: key con sombra suave + relleno de cielo + contraluz
  scene.add(new THREE.HemisphereLight(0xffffff, 0xe9e4da, 0.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(-7, 26, 14);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -10; key.shadow.camera.right = 10;
  key.shadow.camera.top = 10; key.shadow.camera.bottom = -10;
  key.shadow.camera.near = 1; key.shadow.camera.far = 60;
  key.shadow.bias = -0.0006;
  key.shadow.radius = 5;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.35);
  rim.position.set(10, 8, -12);
  scene.add(rim);

  // ── Materiales ─────────────────────────────────────────────────────────────
  const ceramic = () => new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.32, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.06,
    envMapIntensity: 0.62, side: THREE.DoubleSide,
  });
  const outerMat = ceramic();
  const innerMat = ceramic();
  const handleMat = ceramic();

  const mug = new THREE.Group();
  scene.add(mug);

  // ── Cuerpo (torno): exterior blanco ────────────────────────────────────────
  const V = (x, y) => new THREE.Vector2(x, y);
  const outerProfile = [
    V(0.001, 0.14), V(R - 0.78, 0.14), V(R - 0.66, 0.0), V(R - 0.24, 0.0), V(R - 0.06, 0.12),
    V(R - 0.005, 0.36), V(R, 0.5), V(R, H - 0.16), V(R - 0.012, H - 0.06), V(R - 0.07, H - 0.008),
    V(R - WALL * 0.5, H),
  ];
  const outer = new THREE.Mesh(new THREE.LatheGeometry(outerProfile, 160), outerMat);
  outer.castShadow = true; outer.receiveShadow = true;
  mug.add(outer);

  // Interior + borde superior (va del color del interior en las tazas de color)
  const innerProfile = [
    V(R - WALL * 0.5, H), V(R - WALL + 0.07, H - 0.008), V(R - WALL + 0.01, H - 0.07), V(R - WALL, H - 0.2),
    V(R - WALL, 1.0), V(R - WALL - 0.06, 0.82), V(R - WALL - 0.32, 0.7), V(0.001, 0.68),
  ];
  const inner = new THREE.Mesh(new THREE.LatheGeometry(innerProfile, 160), innerMat);
  inner.receiveShadow = true;
  mug.add(inner);

  // ── Banda de impresión (textura del diseño) ────────────────────────────────
  const thetaLen = Math.min(printW / R, Math.PI * 2 * 0.9);
  const bandH = Math.min(printH, H - 0.7);
  const bandGeo = new THREE.CylinderGeometry(R + 0.006, R + 0.006, bandH, 200, 1, true, -thetaLen / 2, thetaLen);
  const bandMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.34, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.06,
    envMapIntensity: 0.55, transparent: true, opacity: 1, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const band = new THREE.Mesh(bandGeo, bandMat);
  band.position.y = 0.5 + (H - 0.66) / 2;
  band.visible = false;
  mug.add(band);

  // ── Asa (tubo ovalado en el plano de la parte trasera, θ = π) ─────────────
  const z = d => -(R + d);
  const handleCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, H - 1.55, z(-0.35)),
    new THREE.Vector3(0, H - 1.45, z(0.9)),
    new THREE.Vector3(0, H - 1.9, z(2.35)),
    new THREE.Vector3(0, H * 0.5, z(2.95)),
    new THREE.Vector3(0, 2.25, z(2.4)),
    new THREE.Vector3(0, 1.75, z(1.0)),
    new THREE.Vector3(0, 1.85, z(-0.35)),
  ], false, 'catmullrom', 0.5);
  const handle = new THREE.Mesh(ovalTube(handleCurve, 140, 36, 0.44, 0.74), handleMat);
  handle.castShadow = true; handle.receiveShadow = true;
  mug.add(handle);

  // ── Piso: sombra proyectada + sombra de contacto ──────────────────────────
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.07 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const blobCanvas = document.createElement('canvas');
  blobCanvas.width = blobCanvas.height = 256;
  const bctx = blobCanvas.getContext('2d');
  const grd = bctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)'); grd.addColorStop(0.45, 'rgba(0,0,0,0.28)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
  bctx.fillStyle = grd; bctx.fillRect(0, 0, 256, 256);
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(R * 2.9, R * 2.9),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(blobCanvas), transparent: true, depthWrite: false })
  );
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.01;
  scene.add(blob);

  // ── Controles ──────────────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.75;
  controls.minDistance = 24; controls.maxDistance = 48;
  controls.minPolarAngle = 0.95; controls.maxPolarAngle = 1.6;
  controls.autoRotateSpeed = 2.2;
  const DIST = 34, POLAR = 1.3;
  const sph = new THREE.Spherical(DIST, POLAR, Math.PI / 2);
  camera.position.copy(new THREE.Vector3().setFromSpherical(sph).add(target));
  controls.update();

  // ── Estado / loop ──────────────────────────────────────────────────────────
  let dirty = true, raf = 0, disposed = false, tween = null, texture = null;

  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  function loop(t) {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    if (tween) {
      const k = Math.min(1, (t - tween.t0) / tween.ms);
      const e = 1 - Math.pow(1 - k, 3);
      setAzimuth(tween.from + (tween.to - tween.from) * e);
      if (k >= 1) tween = null;
    }
    const moved = controls.update();
    if (moved || dirty) { renderer.render(scene, camera); dirty = false; }
  }
  raf = requestAnimationFrame(loop);
  controls.addEventListener('start', () => { tween = null; });

  function setAzimuth(theta) {
    const off = camera.position.clone().sub(controls.target);
    const s = new THREE.Spherical().setFromVector3(off);
    s.theta = theta;
    camera.position.copy(new THREE.Vector3().setFromSpherical(s).add(controls.target));
    dirty = true;
  }
  // u (0..1 del ancho del diseño) → azimut que lo pone de frente a la cámara
  const uToAzimuth = u => -thetaLen / 2 + u * thetaLen;
  const VIEWS = { left: -Math.PI / 2, front: 0, right: Math.PI / 2, handle: Math.PI };

  // ── API ────────────────────────────────────────────────────────────────────
  const api = {
    thetaLen,
    uToAzimuth,
    setDesign(canvas) {
      if (texture) texture.dispose();
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      bandMat.map = texture;
      bandMat.needsUpdate = true;
      band.visible = true;
      dirty = true;
    },
    refresh() { if (texture) { texture.needsUpdate = true; dirty = true; } },
    setColors({ inner: ic, handle: hc } = {}) {
      innerMat.color.set(ic || '#ffffff');
      handleMat.color.set(hc || '#ffffff');
      dirty = true;
    },
    setView(v) {
      const to = typeof v === 'number' ? v : (VIEWS[v] ?? 0);
      const from = controls.getAzimuthalAngle();
      let d = to - from;
      d = Math.atan2(Math.sin(d), Math.cos(d));      // camino más corto
      controls.autoRotate = false;
      tween = { from, to: from + d, t0: performance.now(), ms: 650 };
    },
    setAutoRotate(on) { controls.autoRotate = !!on; tween = null; },
    get autoRotate() { return controls.autoRotate; },
    snapshot({ size = 600, u = 0.5, bg = ['#ffffff', '#eef3f8'], handle = false } = {}) {
      const prevPos = camera.position.clone();
      const prevPR = renderer.getPixelRatio();
      const prevSize = renderer.getSize(new THREE.Vector2());
      renderer.setPixelRatio(1);
      renderer.setSize(size, size, false);
      camera.aspect = 1; camera.updateProjectionMatrix();
      // handle=true: encuadre de catálogo con el asa asomando a la derecha
      const s = new THREE.Spherical(39, 1.3, handle ? Math.max(uToAzimuth(u), 0.9) : uToAzimuth(u) + 0.38);
      camera.position.copy(new THREE.Vector3().setFromSpherical(s).add(controls.target));
      camera.lookAt(controls.target);
      renderer.render(scene, camera);
      const out = document.createElement('canvas');
      out.width = out.height = size;
      const c = out.getContext('2d');
      const g = c.createLinearGradient(0, 0, 0, size);
      g.addColorStop(0, bg[0]); g.addColorStop(1, bg[1]);
      c.fillStyle = g; c.fillRect(0, 0, size, size);
      c.drawImage(renderer.domElement, 0, 0, size, size);
      // restaurar
      renderer.setPixelRatio(prevPR);
      renderer.setSize(prevSize.x, prevSize.y, false);
      camera.position.copy(prevPos);
      camera.aspect = prevSize.x / prevSize.y; camera.updateProjectionMatrix();
      camera.lookAt(controls.target);
      dirty = true;
      return out.toDataURL('image/jpeg', 0.88);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
      });
      envTex.dispose(); pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
  return api;
}
