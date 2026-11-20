/**
 * icons.js — item pictures for the equipment wheel and the HUD, rendered from
 * the game's own pickup models (so they match what lies in the world).
 *
 * Each item is rendered once, off screen, with neutral studio lighting at the
 * same three-quarter angle, cropped to its silhouette and cached as a small
 * transparent canvas (plus a dimmed grey copy for empty slots and a data URL
 * for <img> use). Night vision goggles and binoculars have no pickup model, so
 * they get small models of their own here. Nothing runs per frame.
 */
import * as THREE from 'three';
import { G } from './ctx.js';
import { buildPickup } from './models.js';

const SIZE = 160;                 // cached icon size (px); the wheel draws it at up to ~160 px on a 4K screen
const RENDER = 256;               // rendered larger, cropped to the silhouette and filtered down
const PICKUP_OF = { frag: 'frag', smoke: 'smoke', flash: 'flash', stone: 'stone', tknife: 'tknife', c4: 'c4', medkit: 'medkit',
  bandage: 'bandage', tourniquet: 'tourniquet', plate: 'plate', repair: 'repair' };
const ICONS = new Map();          // kind → { img, dim, url }
let built = false, stats = null;

// linear → sRGB with a gentle shoulder, as an 8-bit lookup table
const LUT = new Uint8ClampedArray(256);
for (let i = 0; i < 256; i++) {
  const x = i / 255 * 1.45, t = x / (1 + x * 0.2);
  LUT[i] = Math.round(255 * (t <= 0.0031308 ? t * 12.92 : 1.055 * Math.pow(t, 1 / 2.4) - 0.055));
}

function std(col, rough = 0.7, metal = 0) { return new THREE.MeshStandardMaterial({ color: col, roughness: rough, metalness: metal }); }

/** Soviet-style field binoculars: two prism bodies, objective and eyepiece barrels, a hinge and a strap ring. */
function binocularModel() {
  const g = new THREE.Group(), body = std(0x2e3328, 0.82), metal = std(0x1a1c1d, 0.45, 0.6), glass = std(0x30465a, 0.15, 0.4);
  for (const s of [-1, 1]) {
    const prism = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.07, 0.06), body); prism.position.set(s * 0.04, 0, 0); g.add(prism);
    const obj = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.07, 24), body); obj.rotation.x = Math.PI / 2; obj.position.set(s * 0.048, -0.008, 0.06); g.add(obj);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.008, 24), metal); rim.rotation.x = Math.PI / 2; rim.position.set(s * 0.048, -0.008, 0.097); g.add(rim);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.02, 24), glass); lens.position.set(s * 0.048, -0.008, 0.1015); g.add(lens);
    const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.05, 20), metal); eye.rotation.x = Math.PI / 2; eye.position.set(s * 0.032, 0.012, -0.05); g.add(eye);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.012, 20), std(0x111213, 0.95)); cup.rotation.x = Math.PI / 2; cup.position.set(s * 0.032, 0.012, -0.078); g.add(cup);
  }
  const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.1, 16), metal); hinge.rotation.x = Math.PI / 2; hinge.position.set(0, 0.012, 0.01); g.add(hinge);
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.014, 18), metal); knob.position.set(0, 0.028, -0.02); g.add(knob);
  return g;
}

/** Night vision goggles: a single-tube body with its objective, twin eyepieces and a head-mount plate. */
function nvgModel() {
  const g = new THREE.Group(), body = std(0x353a2c, 0.8), dark = std(0x16181a, 0.6, 0.3), glass = std(0x2a5a3a, 0.12, 0.5);
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.055, 0.07), body); g.add(box);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.028, 0.07, 24), body); tube.rotation.x = Math.PI / 2; tube.position.set(0, 0.002, 0.065); g.add(tube);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.01, 24), dark); rim.rotation.x = Math.PI / 2; rim.position.set(0, 0.002, 0.102); g.add(rim);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.023, 24), glass); lens.position.set(0, 0.002, 0.1075); g.add(lens);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.019, 0.04, 20), dark); eye.rotation.x = Math.PI / 2; eye.position.set(s * 0.032, 0, -0.054); g.add(eye);
  }
  const mount = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.03), dark); mount.position.set(0, 0.042, -0.005); g.add(mount);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.012), dark); arm.position.set(0, 0.07, -0.012); g.add(arm);
  const sw = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.012, 12), std(0x8a7a50, 0.5, 0.4)); sw.rotation.z = Math.PI / 2; sw.position.set(0.06, 0.008, 0.01); g.add(sw);
  return g;
}

function modelFor(kind) {
  if (kind === 'binoculars') return binocularModel();
  if (kind === 'nvg') return nvgModel();
  const type = PICKUP_OF[kind];
  if (!type) return null;
  const m = buildPickup(type);
  if (m.userData.glow) m.remove(m.userData.glow);          // no glint sprite in a picture
  m.rotation.set(0, 0, 0);
  return m;
}

// per item: a yaw so the long side runs across the picture
const YAW = { tknife: 0.5, stone: 0.3, plate: -0.25, repair: -0.35, c4: -0.4, medkit: -0.4, bandage: 0.2, tourniquet: 0.2, binoculars: 0.62, nvg: 0.55 };

function release(obj) {
  obj.traverse((o) => {
    if (!o.isMesh || o.name.startsWith('pickup_')) return;   // pickup geometry and material are shared caches
    o.geometry.dispose(); o.material.dispose();
  });
}

/**
 * Stage 1 (can run early, off the critical path): build the models into one studio
 * scene with their framing cameras, and let the shaders compile in the background.
 */
let prep = null, preparing = null;
function stage(kinds) {
  if (prep) return prep;
  const t0 = performance.now();
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  scene.add(new THREE.HemisphereLight(0xe8eef4, 0x4a443c, 0.9));
  const key = new THREE.DirectionalLight(0xfff4e6, 2.6); key.position.set(-1.2, 2.2, 1.6); scene.add(key);
  const rim = new THREE.DirectionalLight(0xcfe0ff, 1.4); rim.position.set(1.5, 0.8, -1.8); scene.add(rim);
  const box = new THREE.Box3(), sph = new THREE.Sphere(), dir = new THREE.Vector3(0.62, 0.72, 1.0).normalize();
  const items = [];
  for (const kind of kinds) {
    const m = modelFor(kind);
    if (!m) continue;
    m.rotation.y = YAW[kind] || 0; m.visible = false;
    scene.add(m); m.updateMatrixWorld(true);
    box.setFromObject(m).getBoundingSphere(sph);
    const cam = new THREE.PerspectiveCamera(26, 1, sph.radius * 0.2, sph.radius * 8);
    cam.position.copy(sph.center).addScaledVector(dir, sph.radius / Math.sin(cam.fov * Math.PI / 360) * 1.02);
    cam.lookAt(sph.center); cam.updateMatrixWorld(true);
    items.push({ kind, m, cam });
  }
  prep = { scene, items, ms: performance.now() - t0 };
  return prep;
}

/** Build the models and compile their shaders in the background, then render. Resolves with the stats. */
export function prepareIcons(kinds) {
  if (built || !G.renderer) return Promise.resolve(stats);
  if (preparing) return preparing;
  const p = stage(kinds), r = G.renderer;
  for (const it of p.items) it.m.visible = true;
  const done = () => { for (const it of p.items) it.m.visible = false; return buildIcons(kinds); };
  preparing = (r.compileAsync ? r.compileAsync(p.scene, p.items[0].cam) : Promise.resolve()).then(done, done);
  return preparing;
}

/**
 * Stage 2: render every item into one atlas (one viewport each), read it back once,
 * crop each to its silhouette and cache it. Safe to call repeatedly; only the first call works.
 */
export function buildIcons(kinds) {
  if (built || !G.renderer) return stats;
  built = true;
  const t0 = performance.now(), r = G.renderer, p = stage(kinds), n = p.items.length;
  const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), AW = cols * RENDER, AH = rows * RENDER;
  const rt = new THREE.WebGLRenderTarget(AW, AH, { depthBuffer: true });
  const px = new Uint8Array(AW * AH * 4);
  const prevRT = r.getRenderTarget(), prevCol = new THREE.Color(), prevA = r.getClearAlpha(), prevAuto = r.autoClear;
  r.getClearColor(prevCol);
  for (const it of p.items) it.m.visible = false;
  try {
    r.setClearColor(0x000000, 0); r.autoClear = false;
    rt.scissorTest = false; r.setRenderTarget(rt); r.clear(true, true, true);
    rt.scissorTest = true;
    p.items.forEach((it, i) => {
      const x = (i % cols) * RENDER, y = Math.floor(i / cols) * RENDER;
      rt.viewport.set(x, y, RENDER, RENDER); rt.scissor.set(x, y, RENDER, RENDER);
      r.setRenderTarget(rt);
      it.m.visible = true; r.render(p.scene, it.cam); it.m.visible = false;
    });
    r.readRenderTargetPixels(rt, 0, 0, AW, AH, px);
  } finally {
    r.setRenderTarget(prevRT); r.setClearColor(prevCol, prevA); r.autoClear = prevAuto;
    rt.dispose();
  }
  const tRender = performance.now() - t0;
  const work = document.createElement('canvas'); work.width = work.height = RENDER;
  const work2 = document.createElement('canvas'); work2.width = work2.height = RENDER;
  const wk = work.getContext('2d'), wk2 = work2.getContext('2d'), img = wk.createImageData(RENDER, RENDER), d = img.data, img2 = wk2.createImageData(RENDER, RENDER), d2 = img2.data;
  p.items.forEach((it, i) => {
    const ox = (i % cols) * RENDER, oy = Math.floor(i / cols) * RENDER;
    // flip rows, encode to sRGB, find the silhouette
    let x0 = RENDER, y0 = RENDER, x1 = -1, y1 = -1;
    for (let y = 0; y < RENDER; y++) {
      const src = ((oy + RENDER - 1 - y) * AW + ox) * 4, dst = y * RENDER * 4;
      for (let x = 0; x < RENDER; x++) {
        const s = src + x * 4, o = dst + x * 4, a = px[s + 3];
        const R0 = LUT[px[s]], G0 = LUT[px[s + 1]], B0 = LUT[px[s + 2]];
        d[o] = R0; d[o + 1] = G0; d[o + 2] = B0; d[o + 3] = a;
        // faded grey copy for an empty slot
        d2[o] = d2[o + 1] = d2[o + 2] = (R0 * 0.3 + G0 * 0.55 + B0 * 0.15) * 0.9; d2[o + 3] = a * 0.5;
        if (a > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) return;
    wk.putImageData(img, 0, 0); wk2.putImageData(img2, 0, 0);
    // crop to a square around the silhouette so every item fills its frame the same way
    const side = Math.max(x1 - x0, y1 - y0) * 1.1 + 4, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const crop = (src) => {
      const c = document.createElement('canvas'); c.width = c.height = SIZE;
      const k = c.getContext('2d'); k.imageSmoothingQuality = 'high';
      k.drawImage(src, cx - side / 2, cy - side / 2, side, side, 0, 0, SIZE, SIZE);
      return c;
    };
    ICONS.set(it.kind, { img: crop(work), dim: crop(work2), url: '' });
  });
  for (const it of p.items) { p.scene.remove(it.m); release(it.m); }
  stats = { ms: Math.round(performance.now() - t0 + p.ms), stage: Math.round(p.ms), render: Math.round(tRender), count: ICONS.size };
  prep = null;
  return stats;
}

export const icons = {
  ready() { return built && ICONS.size > 0; },
  /** The cached picture (canvas) of an item, or null. dim: the faded copy for an empty slot. */
  get(kind, dim = false) { const e = ICONS.get(kind); return e ? (dim ? e.dim : e.img) : null; },
  /** A data URL for <img> use (made on first request). */
  url(kind) { const e = ICONS.get(kind); if (!e) return ''; if (!e.url) e.url = e.img.toDataURL('image/png'); return e.url; },
  stats() { return stats; },
};
