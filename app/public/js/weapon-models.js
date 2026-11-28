/**
 * weapon-models.js — the first-person weapons and arms, the shell casing, the
 * held / thrown equipment and the ground pickups, all modelled in code.
 * Self-contained: imports only three.
 *
 *   Toolkit    side-profile extrusions (THREE.Shape with holes, chamfered),
 *              lathes / revolves, lofts with rounded-rectangle sections, a
 *              ground blade slab. Each primitive gets creased normals,
 *              box-projected UVs in metres, edge wear on its chamfers, then all
 *              of a weapon is voxelised once to bake ambient occlusion per
 *              vertex, and merged into one mesh per material per part.
 *   Materials  MeshStandardMaterial with small procedural canvas textures
 *              (steel, laminate, polymer, chequer, cloth, glove), a coated
 *              glass lens (Physical), and createVmEnvironment(): a procedural
 *              PMREM environment for the view-model scene.
 *   Models     buildViewModel(id)   pistol (PM), akm, ak74, svd (+PSO-1), knife;
 *                                   each gun has a detachable suppressor part
 *              buildWorldWeapon(id) the same guns without hands at a lower level
 *                                   of detail, for the ground pickups
 *              SUPPRESSORS          the suppressor profiles (view models and pickups)
 *              KIT                  the toolkit, shared with pickup-models.js
 *
 * Coordinates: metres; a weapon points along −Z with +Y up. Profiles are drawn
 * as (f, y) with f = −z, the distance forward. Everything is built once and
 * cached; nothing here runs per frame.
 */
import * as THREE from 'three';

const TAU = Math.PI * 2, PI = Math.PI;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/**
 * Level of detail for buildWorldWeapon: k scales the segment counts of lathes,
 * revolves, tori, loft corners and fillets; primitives smaller than `min`
 * metres are dropped. k = 1, min = 0 (the view models) changes nothing.
 */
const LOD = { k: 1, min: 0 };
const lodN = (n, lo = 6) => (LOD.k === 1 ? n : Math.max(lo, Math.round(n * LOD.k)));

// ───────────────────────────── noise ─────────────────────────────
function hashI(n) { n = Math.imul(n ^ (n >>> 16), 0x7feb352d); n = Math.imul(n ^ (n >>> 15), 0x846ca68b); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; }
const h3 = (x, y, z) => hashI(Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791));
/** periodic value noise on the unit tile with pu × pv cells */
function pnoise(u, v, pu, pv, s) {
  const x = u * pu, y = v * pv, xi = Math.floor(x), yi = Math.floor(y);
  let xf = x - xi, yf = y - yi; xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % pu) + pu) % pu, y0 = ((yi % pv) + pv) % pv, x1 = (x0 + 1) % pu, y1 = (y0 + 1) % pv;
  const a = h3(x0, y0, s), b = h3(x1, y0, s), c = h3(x0, y1, s), d = h3(x1, y1, s);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
function pfbm(u, v, pu, pv, oct, s) { let t = 0, a = 0.5, n = 0; for (let i = 0; i < oct; i++) { t += a * pnoise(u, v, pu, pv, s + i * 31); n += a; a *= 0.5; pu *= 2; pv *= 2; } return t / n; }
/** smooth 3-D value noise for per-vertex variation */
function noise3(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let xf = x - xi, yf = y - yi, zf = z - zi; xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf); zf = zf * zf * (3 - 2 * zf);
  let r = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = k >> 2;
    r += (dx ? xf : 1 - xf) * (dy ? yf : 1 - yf) * (dz ? zf : 1 - zf) * h3(xi + dx + s * 131, yi + dy, zi + dz);
  }
  return r;
}
/** wrapped 1-px scratch lines, mostly along u */
function scratchMask(N, count, seed) {
  const m = new Float32Array(N * N);
  let s = seed >>> 0;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < count; i++) {
    const x0 = rnd() * N, y0 = rnd() * N, ang = rnd() < 0.7 ? (rnd() - 0.5) * 0.4 : rnd() * PI;
    const len = (0.02 + rnd() * rnd() * 0.3) * N, k = 0.25 + rnd() * 0.75, dx = Math.cos(ang), dy = Math.sin(ang);
    for (let j = 0; j < len; j++) {
      const x = ((Math.round(x0 + dx * j) % N) + N) % N, y = ((Math.round(y0 + dy * j) % N) + N) % N, id = y * N + x;
      m[id] = Math.max(m[id], k * Math.sin(j / len * PI));
    }
  }
  return m;
}

// ───────────────────────────── textures ─────────────────────────────
function texOf(c, srgb, tile) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.repeat.set(1 / tile, 1 / tile);
  return t;
}
/** One pass fills an albedo (sRGB) and a pack texture (R height, G roughness, B metalness). */
function tex2(N, tile, fn, albedo = true) {
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; };
  const cp = mk(), gp = cp.getContext('2d'), ip = gp.createImageData(N, N), dp = ip.data;
  const ca = albedo ? mk() : null, ga = albedo ? ca.getContext('2d') : null, ia = albedo ? ga.createImageData(N, N) : null, da = albedo ? ia.data : null;
  const a = [0, 0, 0], p = [0, 0, 0];
  for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++, i += 4) {
    fn(x / N, y / N, x, y, a, p);
    if (da) { da[i] = a[0] * 255; da[i + 1] = a[1] * 255; da[i + 2] = a[2] * 255; da[i + 3] = 255; }
    dp[i] = p[0] * 255; dp[i + 1] = p[1] * 255; dp[i + 2] = p[2] * 255; dp[i + 3] = 255;
  }
  gp.putImageData(ip, 0, 0);
  if (ga) ga.putImageData(ia, 0, 0);
  return { A: albedo ? texOf(ca, true, tile) : null, P: texOf(cp, false, tile) };
}

let TEX = null;
function textures() {
  if (TEX) return TEX;
  const S = 512, scr = scratchMask(S, 1500, 11);
  // blued / parkerised steel: mottled finish, fine grain, handling polish, scratches (shinier)
  const steel = tex2(S, 0.11, (u, v, x, y, a, p) => {
    const m = pfbm(u, v, 4, 4, 4, 1), f = pfbm(u, v, 40, 40, 2, 2), sp = h3(x, y, 3) - 0.5, s = scr[y * S + x];
    const pol = sstep(0.58, 0.8, pfbm(u, v, 3, 3, 3, 4));
    const k = 0.9 + (m - 0.5) * 0.2 + (f - 0.5) * 0.07 + sp * 0.04 + s * 0.1 + pol * 0.05;
    a[0] = k; a[1] = k; a[2] = k * 1.015;
    p[0] = 0.5 + (f - 0.5) * 0.5 + sp * 0.25 - s * 0.3;
    p[1] = 0.66 + (m - 0.5) * 0.28 + sp * 0.06 - s * 0.36 - pol * 0.22;
    p[2] = 1 - sstep(0.32, 0.16, m) * 0.25;
  });
  // laminated birch with stain and varnish; u runs along the grain
  const wood = tex2(S, 0.24, (u, v, x, y, a, p) => {
    const warp = pfbm(u, v, 2, 3, 3, 21), streak = pfbm(u, v, 3, 64, 3, 22), pore = pnoise(u, v, 8, 256, 23);
    const layer = 0.5 + 0.5 * Math.sin((v * 7 + warp * 1.7) * TAU), fig = pfbm(u, v, 5, 5, 3, 24);
    const t = clamp01(0.5 + (streak - 0.5) * 0.62 + (layer - 0.5) * 0.22 + (fig - 0.5) * 0.34 - (pore < 0.22 ? 0.1 : 0));
    a[0] = lerp(0.2, 0.5, t); a[1] = lerp(0.085, 0.24, t); a[2] = lerp(0.05, 0.13, t);
    p[0] = clamp01(0.55 + (streak - 0.5) * 0.7 - (pore < 0.22 ? 0.3 : 0));
    p[1] = 0.3 + (1 - t) * 0.12 + sstep(0.62, 0.82, fig) * 0.2 + (pore < 0.22 ? 0.12 : 0);
    p[2] = 0;
  });
  // moulded polymer / bakelite: faint marbling, fine stipple
  const poly = tex2(256, 0.07, (u, v, x, y, a, p) => {
    const m = pfbm(u, v, 3, 3, 3, 31), st = pfbm(u, v, 48, 48, 2, 32), sp = h3(x, y, 33) - 0.5;
    const k = 0.9 + (m - 0.5) * 0.16 + (st - 0.5) * 0.05;
    a[0] = k; a[1] = k; a[2] = k;
    p[0] = 0.5 + (st - 0.5) * 0.7 + sp * 0.3;
    p[1] = 0.5 + (m - 0.5) * 0.18 + sp * 0.06;
    p[2] = 0;
  });
  // grip chequering: square pyramids on a diagonal grid, no emblem
  const cheq = tex2(256, 0.03, (u, v, x, y, a, p) => {
    const f = 24, A = (u + v) * f, B = (u - v) * f;
    const ta = 1 - Math.abs(2 * (A - Math.floor(A)) - 1), tb = 1 - Math.abs(2 * (B - Math.floor(B)) - 1);
    const hgt = Math.min(ta, tb);
    p[0] = hgt; p[1] = 0.66 - hgt * 0.16 + (h3(x, y, 41) - 0.5) * 0.06; p[2] = 0;
  }, false);
  // 2/2 twill uniform cloth
  const cloth = tex2(256, 0.05, (u, v, x, y, a, p) => {
    const F = 64, cx = Math.floor(u * F), cy = Math.floor(v * F), fu = u * F - cx, fv = v * F - cy;
    const warpTop = ((cx + cy) & 3) < 2, hgt = warpTop ? Math.sin(PI * fu) : Math.sin(PI * fv);
    const th = 0.93 + h3(warpTop ? cx : cy, warpTop ? 7 : 9, 51) * 0.1, mac = pfbm(u, v, 3, 3, 3, 52);
    const k = (0.8 + hgt * 0.2) * th * (0.9 + mac * 0.2);
    a[0] = k; a[1] = k; a[2] = k;
    p[0] = hgt * 0.8 + mac * 0.2; p[1] = 0.86 + (1 - hgt) * 0.12; p[2] = 0;
  });
  // synthetic glove leather: pebbled grain
  const glove = tex2(256, 0.04, (u, v, x, y, a, p) => {
    const c = pfbm(u, v, 40, 40, 2, 61), m = pfbm(u, v, 4, 4, 3, 62);
    const k = 0.86 + (c - 0.5) * 0.18 + (m - 0.5) * 0.14;
    a[0] = k; a[1] = k; a[2] = k;
    p[0] = c; p[1] = 0.6 + (c - 0.5) * 0.22 + (m - 0.5) * 0.12; p[2] = 0;
  });
  TEX = { steel, wood, poly, cheq, cloth, glove };
  return TEX;
}

// ───────────────────────────── materials ─────────────────────────────
let MAT = null;
function materials() {
  if (MAT) return MAT;
  const T = textures();
  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, ...o });
  const steel = (rough, bump = 0.5) => std({ map: T.steel.A, roughnessMap: T.steel.P, metalnessMap: T.steel.P, bumpMap: T.steel.P, bumpScale: bump, roughness: rough, metalness: 1, envMapIntensity: 0.8 });
  MAT = {
    steel: steel(0.46, 0.06),
    blued: steel(0.42, 0.04),
    bright: steel(0.4, 0.04),
    wood: std({ map: T.wood.A, roughnessMap: T.wood.P, bumpMap: T.wood.P, bumpScale: 0.1, roughness: 1, metalness: 0 }),
    poly: std({ map: T.poly.A, roughnessMap: T.poly.P, bumpMap: T.poly.P, bumpScale: 0.06, roughness: 1.15, metalness: 0 }),
    grip: std({ map: T.poly.A, roughnessMap: T.cheq.P, bumpMap: T.cheq.P, bumpScale: 0.35, roughness: 1, metalness: 0 }),
    rubber: std({ map: T.poly.A, roughnessMap: T.poly.P, bumpMap: T.poly.P, bumpScale: 0.08, roughness: 1.7, metalness: 0 }),
    cloth: std({ map: T.cloth.A, roughnessMap: T.cloth.P, bumpMap: T.cloth.P, bumpScale: 0.18, roughness: 1, metalness: 0 }),
    glove: std({ map: T.glove.A, roughnessMap: T.glove.P, bumpMap: T.glove.P, bumpScale: 0.08, roughness: 1, metalness: 0 }),
    brass: std({ map: T.steel.A, roughnessMap: T.steel.P, roughness: 0.55, metalness: 1 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x06080c, roughness: 0.04, metalness: 0, ior: 1.6, iridescence: 1, iridescenceIOR: 1.75,
      iridescenceThicknessRange: [260, 430], envMapIntensity: 2.4, specularIntensity: 1 }),
    world: new THREE.MeshLambertMaterial({ vertexColors: true }),
  };
  return MAT;
}

// ───────────────────────────── environment ─────────────────────────────
/**
 * A small procedural reflection environment for the view-model scene: a sky /
 * horizon / ground gradient with a soft key, overhead strips and a rim light, as
 * an equirect CanvasTexture (three prefilters it with its PMREM cache).
 * sync(sky, ground, key) re-tints it from the act's light colours, redrawing only
 * when the (quantised) colours change.
 */
const _white = new THREE.Color(1, 1, 1);
export function createVmEnvironment(renderer) {
  const W = 512, H = 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping; tex.colorSpace = THREE.SRGBColorSpace;
  void renderer;   // three's own PMREM cache converts the equirect texture (re-run on needsPMREMUpdate)
  const sky = new THREE.Color(), gnd = new THREE.Color(), key = new THREE.Color(), tmp = new THREE.Color();
  let lastKey = -1;
  const norm = (c, src) => { c.copy(src); const m = Math.max(c.r, c.g, c.b, 1e-4); c.multiplyScalar(1 / m); return c.lerp(_white, 0.5); };   // hue only, half-saturated
  const css = (c, k) => { tmp.copy(c).multiplyScalar(k); return '#' + tmp.getHexString(); };
  const blob = (u, v, rx, ry, c, k) => {
    const x = u * W, y = v * H;
    g.save(); g.translate(x, y); g.scale(1, ry / rx);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx * W);
    gr.addColorStop(0, css(c, k)); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(-rx * W, -rx * W, rx * W * 2, rx * W * 2); g.restore();
  };
  function draw() {
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, css(sky, 0.3)); gr.addColorStop(0.3, css(sky, 0.4)); gr.addColorStop(0.46, css(tmp.copy(sky).lerp(key, 0.35), 0.62));
    gr.addColorStop(0.5, css(gnd, 0.34)); gr.addColorStop(0.6, css(gnd, 0.18)); gr.addColorStop(1, css(gnd, 0.07));
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    blob(0.66, 0.2, 0.1, 0.08, key, 1.0);            // key softbox, matches the view-model sun (above, behind-right)
    blob(0.25, 0.25, 0.17, 0.022, key, 0.9);          // long overhead strip ahead: a crisp line on tops and barrels
    blob(0.25, 0.36, 0.12, 0.012, sky, 0.5);          // second, lower strip
    blob(0.0, 0.4, 0.06, 0.06, sky, 0.6); blob(1.0, 0.4, 0.06, 0.06, sky, 0.6);   // rim on the left
    blob(0.5, 0.42, 0.08, 0.03, sky, 0.45);           // low fill on the right
    g.globalCompositeOperation = 'source-over';
  }
  function build() { draw(); tex.needsUpdate = true; tex.needsPMREMUpdate = true; }
  const q = (c) => Math.round(c.r * 15) * 256 + Math.round(c.g * 15) * 16 + Math.round(c.b * 15);
  const env = {
    texture: null,
    /** Re-tint from linear colours (any brightness; only the hue is used). */
    sync(skyC, groundC, keyC) {
      norm(sky, skyC); norm(gnd, groundC); norm(key, keyC);
      const k = q(sky) * 4096 * 4096 + q(gnd) * 4096 + q(key);
      if (k === lastKey) return false;
      lastKey = k; build(); env.texture = tex;
      return true;
    },
  };
  env.sync(new THREE.Color(0.8, 0.85, 0.9), new THREE.Color(0.45, 0.42, 0.38), new THREE.Color(1, 0.97, 0.92));
  return env;
}

// ───────────────────────────── 2-D helpers ─────────────────────────────
/** Polygon with filleted corners: pts [[x, y, r?], …]. */
function fillet(pts, rDef = 0) {
  const out = [], n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i + n - 1) % n], b = pts[(i + 1) % n], r = p[2] ?? rDef;
    if (!(r > 0)) { out.push([p[0], p[1]]); continue; }
    let d1x = a[0] - p[0], d1y = a[1] - p[1], d2x = b[0] - p[0], d2y = b[1] - p[1];
    const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
    d1x /= l1; d1y /= l1; d2x /= l2; d2y /= l2;
    const th = Math.acos(Math.max(-1, Math.min(1, d1x * d2x + d1y * d2y)));
    if (th < 1e-3 || th > PI - 1e-3) { out.push([p[0], p[1]]); continue; }
    let t = r / Math.tan(th / 2), rr = r;
    const tmax = Math.min(l1, l2) * 0.49;
    if (t > tmax) { t = tmax; rr = t * Math.tan(th / 2); }
    const bx = d1x + d2x, by = d1y + d2y, bl = Math.hypot(bx, by), cd = rr / Math.sin(th / 2);
    const cx = p[0] + bx / bl * cd, cy = p[1] + by / bl * cd;
    const a1 = Math.atan2(p[1] + d1y * t - cy, p[0] + d1x * t - cx);
    let da = Math.atan2(p[1] + d2y * t - cy, p[0] + d2x * t - cx) - a1;
    while (da > PI) da -= TAU; while (da < -PI) da += TAU;
    const k = Math.max(1, Math.ceil(Math.abs(da) / (PI / 10 / LOD.k)));
    for (let j = 0; j <= k; j++) { const an = a1 + da * j / k; out.push([cx + Math.cos(an) * rr, cy + Math.sin(an) * rr]); }
  }
  // drop near-duplicates (earcut dislikes them)
  const clean = [];
  for (const q of out) { const l = clean[clean.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-6) clean.push(q); }
  if (clean.length > 2 && Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) < 1e-6) clean.pop();
  return clean;
}
function shapeOf(outline, holes) {
  const s = new THREE.Shape(fillet(outline).map((p) => new THREE.Vector2(p[0], p[1])));
  if (holes) for (const h of holes) s.holes.push(new THREE.Path(fillet(h).map((p) => new THREE.Vector2(p[0], p[1]))));
  return s;
}
/** Arc of points around (cx, cy), radius r, angles a0→a1 (n segments). */
function arcPts(cx, cy, r, a0, a1, n) { const o = []; for (let i = 0; i <= n; i++) { const a = lerp(a0, a1, i / n); o.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return o; }

// ───────────────────────────── primitives ─────────────────────────────
// A primitive is { p: Float32Array of non-indexed triangle positions, w: per-vertex edge wear 0..1 | null }.
function trisOf(geo) {
  const ng = geo.index ? geo.toNonIndexed() : geo;
  const p = new Float32Array(ng.attributes.position.array);
  if (ng !== geo) ng.dispose();
  geo.dispose();
  return p;
}
function faceAxisWear(p, ax, lo, hi) {
  const w = new Float32Array(p.length / 3);
  for (let i = 0; i < p.length; i += 9) {
    const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
    const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
    const c = Math.abs([nx, ny, nz][ax]) / l, e = c > lo && c < hi ? 1 : 0;
    w[i / 3] = w[i / 3 + 1] = w[i / 3 + 2] = e;
  }
  return w;
}
function mapP(p, fn) { const o = [0, 0, 0]; for (let i = 0; i < p.length; i += 3) { fn(p[i], p[i + 1], p[i + 2], o); p[i] = o[0]; p[i + 1] = o[1]; p[i + 2] = o[2]; } return p; }

function extrudeRaw(outline, holes, depth, bevel, seg) {
  const b = Math.max(0, Math.min(bevel, depth * 0.45));
  const g = new THREE.ExtrudeGeometry(shapeOf(outline, holes), { depth: Math.max(1e-5, depth - 2 * b), steps: 1, bevelEnabled: b > 1e-6,
    bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: seg, curveSegments: 4 });
  g.translate(0, 0, -(depth - 2 * b) / 2);
  const p = trisOf(g);
  return { p, w: faceAxisWear(p, 2, 0.12, 0.97) };
}
/** Side profile [(f, y, fillet)] extruded across the weapon (width along X, centred on o.x). */
function side(outline, width, o = {}) {
  const pr = extrudeRaw(outline, o.holes, width, o.bevel ?? 0.0009, o.seg ?? 1);
  const x0 = o.x || 0;
  mapP(pr.p, (x, y, z, r) => { r[0] = z + x0; r[1] = y; r[2] = -x; });
  return pr;
}
/** Front profile [(x, y, fillet)] extruded along the bore from f0 to f1. */
function front(outline, f0, f1, o = {}) {
  const pr = extrudeRaw(outline, o.holes, f1 - f0, o.bevel ?? 0.0008, o.seg ?? 1);
  const zc = -(f0 + f1) / 2;
  mapP(pr.p, (x, y, z, r) => { r[0] = x; r[1] = y; r[2] = zc + z; });
  return pr;
}
/** Plan profile [(x, f, fillet)] extruded vertically from y0 to y1. */
function plan(outline, y0, y1, o = {}) {
  const pr = extrudeRaw(outline, o.holes, y1 - y0, o.bevel ?? 0.0008, o.seg ?? 1);
  const yc = (y0 + y1) / 2;
  mapP(pr.p, (x, y, z, r) => { r[0] = x; r[1] = yc + z; r[2] = -y; });
  return pr;
}
/** Bevelled box, centre (cx, cy, cz) in gun space. */
function box(cx, cy, cz, w, h, d, bevel = 0.0007) {
  const f0 = -cz - d / 2, f1 = -cz + d / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  return side([[f0, y0], [f1, y0], [f1, y1], [f0, y1]], w, { x: cx, bevel: Math.min(bevel, w * 0.3, h * 0.3, d * 0.3) });
}
const AXES = {
  z: (x, y, z, r) => { r[0] = x; r[1] = z; r[2] = -y; },    // profile f → −z (forward)
  zb: (x, y, z, r) => { r[0] = x; r[1] = -z; r[2] = y; },   // profile f → +z (backward)
  y: (x, y, z, r) => { r[0] = x; r[1] = y; r[2] = z; },     // profile f → +y
  yd: (x, y, z, r) => { r[0] = x; r[1] = -y; r[2] = -z; },  // profile f → −y
  'x+': (x, y, z, r) => { r[0] = y; r[1] = -x; r[2] = z; },
  'x-': (x, y, z, r) => { r[0] = -y; r[1] = x; r[2] = z; },
};
/** Lathe of a profile [[r, f], …] (f increasing = outward normals). o: { seg, axis, at:[x,y,z], wear:false }. */
function lathe(profile, o = {}) {
  const g = new THREE.LatheGeometry(profile.map(([r, f]) => new THREE.Vector2(Math.max(0, r), f)), lodN(o.seg ?? 20));
  const p = trisOf(g);
  const w = o.wear === false ? null : faceAxisWear(p, 1, 0.25, 0.96);
  const fn = AXES[o.axis || 'z'], at = o.at || [0, 0, 0];
  mapP(p, (x, y, z, r) => { fn(x, y, z, r); r[0] += at[0]; r[1] += at[1]; r[2] += at[2]; });
  return { p, w };
}
/**
 * Surface of revolution about −z through (cx, cy) whose profile may depend on
 * the angle: prof(th, i) → [[r, f], …] (same count each time). th = 0 is +y,
 * th = π/2 is +x. skip(i, j) drops the quad at angle step i, profile step j.
 */
function revolve(prof, seg0, o = {}) {
  // under LOD the angle steps are fewer; prof and skip still see indices on the authored grid
  const seg = lodN(seg0, 8), vi = (i) => (seg === seg0 ? i : Math.round(i * seg0 / seg) % seg0);
  const rings = [];
  for (let i = 0; i <= seg; i++) rings.push(prof((i % seg) / seg * TAU, vi(i % seg)));
  const m = rings[0].length, out = [], cx = o.cx || 0, cy = o.cy || 0;
  const pt = (rf, th) => [cx + rf[0] * Math.sin(th), cy + rf[0] * Math.cos(th), -rf[1]];
  for (let i = 0; i < seg; i++) {
    const t0 = i / seg * TAU, t1 = (i + 1) / seg * TAU;
    for (let j = 0; j < m - 1; j++) {
      if (o.skip && o.skip(vi(i), j)) continue;
      const A = pt(rings[i][j], t0), B = pt(rings[i + 1][j], t1), C = pt(rings[i + 1][j + 1], t1), D = pt(rings[i][j + 1], t0);
      out.push(...A, ...B, ...D, ...C, ...D, ...B);
    }
  }
  const p = new Float32Array(out);
  return { p, w: o.wear === false ? null : faceAxisWear(p, 2, 0.25, 0.96) };
}
function torus(R, r, seg, tseg) { return { p: trisOf(new THREE.TorusGeometry(R, r, lodN(tseg, 4), lodN(seg, 6))), w: null }; }

/** Rounded rectangle section: points [x, y, nx, ny, wear], CCW from the right side. */
function rrect(w, h, rt, rb, cs, ss) {
  const hw = w / 2, hh = h / 2;
  rt = Math.min(rt, hw, hh); rb = Math.min(rb, hw, hh);
  const C = [[hw - rt, hh - rt, rt, 0], [-hw + rt, hh - rt, rt, PI / 2], [-hw + rb, -hh + rb, rb, PI], [hw - rb, -hh + rb, rb, 1.5 * PI]];
  const out = [];
  for (let c = 0; c < 4; c++) {
    const [cx, cy, r, a0] = C[c];
    for (let k = 0; k <= cs; k++) {
      const a = a0 + (PI / 2) * (k / cs), nx = Math.cos(a), ny = Math.sin(a);
      out.push([cx + nx * r, cy + ny * r, nx, ny, r > 0.0006 ? Math.pow(Math.sin(PI * k / cs), 0.5) : 0]);
    }
    if (ss > 0) {
      const p0 = out[out.length - 1], N = C[(c + 1) % 4], q = [N[0] + Math.cos(N[3]) * N[2], N[1] + Math.sin(N[3]) * N[2]];
      const sn = [Math.cos(a0 + PI / 2), Math.sin(a0 + PI / 2)];
      for (let k = 1; k <= ss; k++) { const t = k / (ss + 1); out.push([lerp(p0[0], q[0], t), lerp(p0[1], q[1], t), sn[0], sn[1], 0]); }
    }
  }
  return out;
}

/**
 * Tube through rings of equal point count, closed around; caps are fans to the
 * ring centroid. Orientation is fixed afterwards (outward normals).
 */
function tube(rings, wears, o = {}) {
  const out = [], wo = [], m = rings[0].length;
  const push = (P, w) => { out.push(P[0], P[1], P[2]); wo.push(w); };
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k], B = rings[k + 1], wa = wears ? wears[k] : null, wb = wears ? wears[k + 1] : null;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      if (o.skip && o.skip(k, j)) continue;
      push(A[j], wa ? wa[j] : 0); push(B[j], wb ? wb[j] : 0); push(B[j2], wb ? wb[j2] : 0);
      push(A[j], wa ? wa[j] : 0); push(B[j2], wb ? wb[j2] : 0); push(A[j2], wa ? wa[j2] : 0);
    }
  }
  const fan = (R, rev) => {
    let cx = 0, cy = 0, cz = 0;
    for (const q of R) { cx += q[0]; cy += q[1]; cz += q[2]; }
    const C = [cx / m, cy / m, cz / m];
    for (let j = 0; j < m; j++) { const j2 = (j + 1) % m; if (rev) { push(C, 0); push(R[j2], 0); push(R[j], 0); } else { push(C, 0); push(R[j], 0); push(R[j2], 0); } }
  };
  // rings run CCW about −t, so a fan in ring order faces back along the path
  if (o.cap0) fan(rings[0], false);
  if (o.cap1) fan(rings[rings.length - 1], true);
  const p = new Float32Array(out), w = new Float32Array(wo);
  // orientation: compare each face normal with the direction away from its ring's centre line
  let score = 0;
  const cen = rings.map((R) => { let x = 0, y = 0, z = 0; for (const q of R) { x += q[0]; y += q[1]; z += q[2]; } return [x / m, y / m, z / m]; });
  const r0 = o.skip ? 0 : (o.scoreFrom || 0), r1 = o.skip ? rings.length - 1 : Math.min(rings.length - 1, r0 + (o.scoreRings ? o.scoreRings - 1 : rings.length));
  for (let i = r0 * m * 18; i < Math.min(r1 * m * 18, out.length); i += 9) {
    const k = Math.min(cen.length - 1, Math.floor(i / (m * 18)));
    const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2], vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const c = cen[k], mx = (p[i] + p[i + 3] + p[i + 6]) / 3 - c[0], my = (p[i + 1] + p[i + 4] + p[i + 7]) / 3 - c[1], mz = (p[i + 2] + p[i + 5] + p[i + 8]) / 3 - c[2];
    score += Math.sign(nx * mx + ny * my + nz * mz);
  }
  if ((o.inside ? -score : score) < 0) flipTris(p, w);
  return { p, w };
}
function flipTris(p, w) {
  for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) { const a = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = a; }
  if (w) for (let i = 0; i < w.length; i += 3) { const a = w[i + 1]; w[i + 1] = w[i + 2]; w[i + 2] = a; }
}

/**
 * Loft of rounded-rectangle sections. station: { c:[x,y,z], w, h, r | rt, rb, up?:[x,y,z] }.
 * o: { up, cseg, sseg, disp(k, j, x, y, st) → offset along the section normal,
 *      cap0 / cap1: 'flat' | 'round' | 'inset' | null, capD, wear: false }
 */
function loft(st, o = {}) {
  const cs = lodN(o.cseg ?? 4, 1), ss = o.sseg ?? 0, n = st.length;
  const rings = [], wears = [], frames = [];
  for (let k = 0; k < n; k++) {
    const s = st[k], a = st[Math.max(0, k - 1)].c, b = st[Math.min(n - 1, k + 1)].c;
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    const u0 = s.up || o.up || [0, 1, 0];
    let rx = ty * u0[2] - tz * u0[1], ry = tz * u0[0] - tx * u0[2], rz = tx * u0[1] - ty * u0[0];
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const ux = ry * tz - rz * ty, uy = rz * tx - rx * tz, uz = rx * ty - ry * tx;
    const sec = rrect(s.w, s.h, s.rt ?? s.r ?? 0, s.rb ?? s.r ?? 0, cs, ss), ring = [], wr = [];
    for (let j = 0; j < sec.length; j++) {
      let [x, y, nx, ny, we] = sec[j];
      const d = o.disp ? o.disp(k, j, x, y, s) : 0;
      x += nx * d; y += ny * d;
      ring.push([s.c[0] + rx * x + ux * y, s.c[1] + ry * x + uy * y, s.c[2] + rz * x + uz * y]);
      wr.push(o.wear === false ? 0 : we);
    }
    rings.push(ring); wears.push(wr); frames.push({ c: s.c, t: [tx, ty, tz] });
  }
  const capRings = (k, dir, type) => {
    const R = rings[k], F = frames[k], D = o.capD ?? 0.004, add = [];
    if (type === 'round') {
      for (let i = 1; i <= 3; i++) {
        const an = (i / 4) * (PI / 2), sc = Math.cos(an), off = Math.sin(an) * D * dir;
        add.push(R.map((q) => [F.c[0] + (q[0] - F.c[0]) * sc + F.t[0] * off, F.c[1] + (q[1] - F.c[1]) * sc + F.t[1] * off, F.c[2] + (q[2] - F.c[2]) * sc + F.t[2] * off]));
      }
    } else if (type === 'inset') {
      for (const [sc, off] of [[0.84, -0.002], [0.8, -0.016]]) add.push(R.map((q) => [F.c[0] + (q[0] - F.c[0]) * sc + F.t[0] * off * dir, F.c[1] + (q[1] - F.c[1]) * sc + F.t[1] * off * dir, F.c[2] + (q[2] - F.c[2]) * sc + F.t[2] * off * dir]));
    }
    return add;
  };
  let all = rings, aw = wears, pre = 0;
  if (o.cap0 === 'round' || o.cap0 === 'inset') { const a = capRings(0, -1, o.cap0).reverse(); all = [...a, ...all]; aw = [...a.map(() => null), ...aw]; pre = a.length; }
  if (o.cap1 === 'round' || o.cap1 === 'inset') { const a = capRings(n - 1, 1, o.cap1); all = [...all, ...a]; aw = [...aw, ...a.map(() => null)]; }
  if (o.cap1 === 'hole') {
    // annulus from the last section to a circle (same angular order) and a short blind bore
    const R = rings[n - 1], F = frames[n - 1], h = o.hole, s = st[n - 1];
    const u0 = s.up || o.up || [0, 1, 0], t = F.t;
    const rv = new THREE.Vector3().crossVectors(new THREE.Vector3(...t), new THREE.Vector3(...u0)).normalize(), uv = new THREE.Vector3().crossVectors(rv, new THREE.Vector3(...t));
    const hc = [h.x ?? F.c[0], h.y ?? F.c[1], F.c[2]];
    const ringH = R.map((q) => {
      const dx = q[0] - hc[0], dy = q[1] - hc[1], dz = q[2] - hc[2], a = Math.atan2(dx * uv.x + dy * uv.y + dz * uv.z, dx * rv.x + dy * rv.y + dz * rv.z);
      return [hc[0] + (rv.x * Math.cos(a) + uv.x * Math.sin(a)) * h.r, hc[1] + (rv.y * Math.cos(a) + uv.y * Math.sin(a)) * h.r, hc[2] + (rv.z * Math.cos(a) + uv.z * Math.sin(a)) * h.r];
    });
    const ringI = ringH.map((q) => [q[0] - t[0] * h.depth, q[1] - t[1] * h.depth, q[2] - t[2] * h.depth]);
    all = [...all, ringH, ringI]; aw = [...aw, null, null];
  }
  return tube(all, aw, { cap0: !!o.cap0, cap1: !!o.cap1, scoreFrom: pre, scoreRings: n });
}
/** Rounded box via a short loft along z. */
function rbox(cx, cy, cz, w, h, d, r, o = {}) {
  const rc = Math.min(r, d * 0.45);
  return loft([{ c: [cx, cy, cz + d / 2 - rc], w, h, r }, { c: [cx, cy, cz - d / 2 + rc], w, h, r }], { cap0: 'round', cap1: 'round', capD: rc, cseg: o.cseg ?? 3 });
}

// ───────────────────────────── part builder ─────────────────────────────
const _col = new THREE.Color(), _col2 = new THREE.Color(), _wcol = new THREE.Color();
let _seed = 1;

/** Quantise-and-hash ids for rows of K ints. */
function hashRows(rows, K, n) {
  let cap = 1; while (cap < n * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1), ids = new Int32Array(n), first = new Int32Array(n);
  let count = 0;
  for (let v = 0; v < n; v++) {
    let h = 0; const o = v * K;
    for (let k = 0; k < K; k++) h = Math.imul(h ^ rows[o + k], 0x9e3779b1) + k;
    h = (h ^ (h >>> 15)) & (cap - 1);
    for (;;) {
      const id = table[h];
      if (id < 0) { table[h] = count; first[count] = v; ids[v] = count++; break; }
      const f = first[id] * K; let same = true;
      for (let k = 0; k < K; k++) if (rows[f + k] !== rows[o + k]) { same = false; break; }
      if (same) { ids[v] = id; break; }
      h = (h + 1) & (cap - 1);
    }
  }
  return { ids, first, count };
}

/** Per-corner normals: faces within `deg` of each other are smoothed (corner-angle weighted). */
function creaseNormals(P, deg) {
  const nt = P.length / 9, nv = nt * 3, cosT = Math.cos(deg * PI / 180);
  const fn = new Float32Array(nt * 3), ca = new Float32Array(nv);
  const ang = (ax, ay, az, bx, by, bz) => { const l = Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz); return l > 0 ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / l))) : 0; };
  for (let t = 0; t < nt; t++) {
    const o = t * 9;
    const ax = P[o], ay = P[o + 1], az = P[o + 2], bx = P[o + 3], by = P[o + 4], bz = P[o + 5], cx = P[o + 6], cy = P[o + 7], cz = P[o + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-16) { nx /= l; ny /= l; nz /= l; } else { nx = ny = nz = 0; }
    fn[t * 3] = nx; fn[t * 3 + 1] = ny; fn[t * 3 + 2] = nz;
    ca[t * 3] = ang(ux, uy, uz, vx, vy, vz);
    ca[t * 3 + 1] = ang(cx - bx, cy - by, cz - bz, ax - bx, ay - by, az - bz);
    ca[t * 3 + 2] = ang(ax - cx, ay - cy, az - cz, bx - cx, by - cy, bz - cz);
  }
  const rows = new Int32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) rows[i] = Math.round(P[i] * 1e5);
  const { ids, count } = hashRows(rows, 3, nv);
  const start = new Int32Array(count + 1);
  for (let v = 0; v < nv; v++) start[ids[v] + 1]++;
  for (let i = 0; i < count; i++) start[i + 1] += start[i];
  const fill = start.slice(), list = new Int32Array(nv);
  for (let v = 0; v < nv; v++) list[fill[ids[v]]++] = v;
  const N = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const t = (v / 3) | 0, id = ids[v], fx = fn[t * 3], fy = fn[t * 3 + 1], fz = fn[t * 3 + 2];
    let sx = 0, sy = 0, sz = 0;
    for (let q = start[id]; q < start[id + 1]; q++) {
      const v2 = list[q], t2 = (v2 / 3) | 0, gx = fn[t2 * 3], gy = fn[t2 * 3 + 1], gz = fn[t2 * 3 + 2];
      if (fx * gx + fy * gy + fz * gz >= cosT) { const w = ca[v2]; sx += gx * w; sy += gy * w; sz += gz * w; }
    }
    let l = Math.hypot(sx, sy, sz);
    if (l < 1e-12) { sx = fx; sy = fy; sz = fz || 1; l = Math.hypot(sx, sy, sz); }
    N[v * 3] = sx / l; N[v * 3 + 1] = sy / l; N[v * 3 + 2] = sz / l;
  }
  return N;
}

/** Largest side of a primitive's bounding box. */
function extentOf(p) {
  let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return Math.max(x1 - x0, y1 - y0, z1 - z0);
}

/**
 * Accumulates primitives per material. add(prim, mat, o):
 *   o.m       Matrix4 placing the primitive (mirrors are handled)
 *   o.col     base colour (sRGB hex) or o.colFn(x,y,z, nx,ny,nz, outColor)
 *   o.wear    0..1 how much the primitive's chamfers show bare material (o.wearCol)
 *   o.grain   texture grain axis in the primitive's local space: 'z' | 'y' | 'x'
 *   o.crease  smoothing angle in degrees; o.macro low-frequency colour variation
 */
class Part {
  constructor() { this.bk = new Map(); }
  add(pr, mat, o = {}) {
    if (LOD.min > 0 && extentOf(pr.p) < LOD.min) return this;   // rivets, pins, index marks: not at ground-pickup detail
    let b = this.bk.get(mat);
    if (!b) { b = { p: [], n: [], u: [], c: [] }; this.bk.set(mat, b); }
    const src = pr.p, m = o.m, P = new Float32Array(src.length);
    let L = src, W = pr.w;
    if (m) {
      const e = m.elements;
      for (let i = 0; i < src.length; i += 3) {
        const x = src[i], y = src[i + 1], z = src[i + 2];
        P[i] = e[0] * x + e[4] * y + e[8] * z + e[12]; P[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; P[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
      if (m.determinant() < 0) { L = new Float32Array(src); W = W ? new Float32Array(W) : null; flipTris(P, W); flipTris(L, null); }
    } else P.set(src);
    const N = creaseNormals(P, o.crease ?? 34);
    const seed = _seed++, uo = h3(seed, 1, 2) * 3, vo = h3(seed, 3, 4) * 3, grain = o.grain || 'z';
    _col.set(o.col ?? 0xffffff);
    const base = _col.clone();
    if (o.wearCol !== undefined) _wcol.set(o.wearCol);
    const wearK = o.wearCol !== undefined ? (o.wear ?? 0) : 0, macro = o.macro ?? 0.1;
    for (let i = 0; i < P.length; i += 9) {
      // box projection by the local face normal; grain axis kept on u
      const ux = L[i + 3] - L[i], uy = L[i + 4] - L[i + 1], uz = L[i + 5] - L[i + 2], vx = L[i + 6] - L[i], vy = L[i + 7] - L[i + 1], vz = L[i + 8] - L[i + 2];
      const ax = Math.abs(uy * vz - uz * vy), ay = Math.abs(uz * vx - ux * vz), az = Math.abs(ux * vy - uy * vx);
      let A, B;   // indices of the local axes giving u, v
      if (grain === 'z') { if (ax >= ay && ax >= az) { A = 2; B = 1; } else if (ay >= az) { A = 2; B = 0; } else { A = 0; B = 1; } }
      else if (grain === 'y') { if (ax >= ay && ax >= az) { A = 1; B = 2; } else if (az >= ay) { A = 1; B = 0; } else { A = 0; B = 2; } }
      else { if (ay >= ax && ay >= az) { A = 0; B = 2; } else if (az >= ax) { A = 0; B = 1; } else { A = 2; B = 1; } }
      for (let k = 0; k < 3; k++) {
        const q = i + k * 3, v = q / 3;
        b.p.push(P[q], P[q + 1], P[q + 2]);
        b.n.push(N[q], N[q + 1], N[q + 2]);
        b.u.push(L[q + A] + uo, L[q + B] + vo);
        if (o.colFn) o.colFn(P[q], P[q + 1], P[q + 2], N[q], N[q + 1], N[q + 2], _col2); else _col2.copy(base);
        const mk = 1 + (noise3(P[q] * 28, P[q + 1] * 28, P[q + 2] * 28, seed & 63) - 0.5) * macro;
        _col2.multiplyScalar(mk);
        if (wearK > 0 && W && W[v] > 0) {
          const e = sstep(0.25, 0.75, noise3(P[q] * 160, P[q + 1] * 160, P[q + 2] * 160, 7));
          _col2.lerp(_wcol, W[v] * wearK * (0.35 + 0.65 * e));
        }
        b.c.push(_col2.r, _col2.g, _col2.b);
      }
    }
    return this;
  }
  tris() { let n = 0; for (const b of this.bk.values()) n += b.p.length / 9; return n; }
}

// ───────────────────────────── ambient occlusion ─────────────────────────────
class Occ {
  constructor(min, max, cell) {
    this.c = cell; this.ox = min[0] - cell * 3; this.oy = min[1] - cell * 3; this.oz = min[2] - cell * 3;
    this.nx = Math.ceil((max[0] - min[0]) / cell) + 7; this.ny = Math.ceil((max[1] - min[1]) / cell) + 7; this.nz = Math.ceil((max[2] - min[2]) / cell) + 7;
    this.d = new Uint8Array(this.nx * this.ny * this.nz);
  }
  set(x, y, z) {
    const i = Math.floor((x - this.ox) / this.c), j = Math.floor((y - this.oy) / this.c), k = Math.floor((z - this.oz) / this.c);
    if (i >= 0 && j >= 0 && k >= 0 && i < this.nx && j < this.ny && k < this.nz) this.d[(k * this.ny + j) * this.nx + i] = 1;
  }
  get(x, y, z) {
    const i = Math.floor((x - this.ox) / this.c), j = Math.floor((y - this.oy) / this.c), k = Math.floor((z - this.oz) / this.c);
    return i >= 0 && j >= 0 && k >= 0 && i < this.nx && j < this.ny && k < this.nz ? this.d[(k * this.ny + j) * this.nx + i] : 0;
  }
  mark(P) {
    const s = this.c * 0.7;
    for (let o = 0; o < P.length; o += 9) {
      // start at the corner touching the shortest edge so long slivers stay cheap
      const L = [Math.hypot(P[o + 3] - P[o + 6], P[o + 4] - P[o + 7], P[o + 5] - P[o + 8]), Math.hypot(P[o] - P[o + 6], P[o + 1] - P[o + 7], P[o + 2] - P[o + 8]), Math.hypot(P[o] - P[o + 3], P[o + 1] - P[o + 4], P[o + 2] - P[o + 5])];
      const sh = L[0] <= L[1] && L[0] <= L[2] ? 0 : L[1] <= L[2] ? 1 : 2;
      const a = o + ((sh + 1) % 3) * 3, b = o + ((sh + 2) % 3) * 3, c = o + sh * 3;
      const e1 = Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]), e2 = Math.hypot(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]);
      const n1 = Math.max(1, Math.ceil(e1 / s)), n2 = Math.max(1, Math.ceil(e2 / s));
      for (let i = 0; i <= n1; i++) for (let j = 0; j <= n2; j++) {
        const u = i / n1, v = j / n2;
        if (u + v > 1.0001) continue;
        this.set(P[a] + (P[b] - P[a]) * u + (P[c] - P[a]) * v, P[a + 1] + (P[b + 1] - P[a + 1]) * u + (P[c + 1] - P[a + 1]) * v, P[a + 2] + (P[b + 2] - P[a + 2]) * u + (P[c + 2] - P[a + 2]) * v);
      }
    }
  }
}
const AO_DIRS = (() => { const n = 16, o = []; for (let i = 0; i < n; i++) { const z = Math.sqrt((i + 0.5) / n), r = Math.sqrt(1 - z * z), a = i * 2.399963; o.push([Math.cos(a) * r, Math.sin(a) * r, z]); } return o; })();
function aoAt(grid, px, py, pz, nx, ny, nz, steps) {
  const sg = nz >= 0 ? 1 : -1, a = -1 / (sg + nz), b = nx * ny * a;
  const t1x = 1 + sg * nx * nx * a, t1y = sg * b, t1z = -sg * nx, t2x = b, t2y = sg + ny * ny * a, t2z = -ny;
  const c = grid.c, off = c * 1.6;
  let occ = 0;
  for (const d of AO_DIRS) {
    const dx = t1x * d[0] + t2x * d[1] + nx * d[2], dy = t1y * d[0] + t2y * d[1] + ny * d[2], dz = t1z * d[0] + t2z * d[1] + nz * d[2];
    let x = px + nx * off, y = py + ny * off, z = pz + nz * off;
    for (let s = 1; s <= steps; s++) {
      x += dx * c; y += dy * c; z += dz * c;
      if (grid.get(x, y, z)) { occ += 1 - (s - 1) / steps * 0.7; break; }
    }
  }
  return occ / AO_DIRS.length;
}

/** Weld a bucket into an indexed geometry, bake AO from `grid`, return a BufferGeometry. */
function bucketGeometry(b, grid, aoK) {
  const nv = b.p.length / 3, rows = new Int32Array(nv * 11);
  for (let v = 0; v < nv; v++) {
    const o = v * 11;
    rows[o] = Math.round(b.p[v * 3] * 1e5); rows[o + 1] = Math.round(b.p[v * 3 + 1] * 1e5); rows[o + 2] = Math.round(b.p[v * 3 + 2] * 1e5);
    rows[o + 3] = Math.round(b.n[v * 3] * 1e3); rows[o + 4] = Math.round(b.n[v * 3 + 1] * 1e3); rows[o + 5] = Math.round(b.n[v * 3 + 2] * 1e3);
    rows[o + 6] = Math.round(b.u[v * 2] * 1e4); rows[o + 7] = Math.round(b.u[v * 2 + 1] * 1e4);
    rows[o + 8] = Math.round(b.c[v * 3] * 1e3); rows[o + 9] = Math.round(b.c[v * 3 + 1] * 1e3); rows[o + 10] = Math.round(b.c[v * 3 + 2] * 1e3);
  }
  const { ids, first, count } = hashRows(rows, 11, nv);
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), uv = new Float32Array(count * 2), col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = first[i];
    for (let k = 0; k < 3; k++) { pos[i * 3 + k] = b.p[v * 3 + k]; nrm[i * 3 + k] = b.n[v * 3 + k]; col[i * 3 + k] = b.c[v * 3 + k]; }
    uv[i * 2] = b.u[v * 2]; uv[i * 2 + 1] = b.u[v * 2 + 1];
    if (grid && aoK > 0) {
      const occ = aoAt(grid, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2], 8);
      const k = Math.max(0.22, 1 - aoK * Math.pow(occ, 0.85));
      col[i * 3] *= k; col[i * 3 + 1] *= k; col[i * 3 + 2] *= k;
    }
  }
  const index = count > 65535 ? new Uint32Array(nv) : new Uint16Array(nv);
  for (let v = 0; v < nv; v++) index[v] = ids[v];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}
function boundsOf(parts) {
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const p of parts) if (p) for (const b of p.bk.values()) for (let i = 0; i < b.p.length; i += 3) for (let k = 0; k < 3; k++) { const v = b.p[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  return [mn, mx];
}
/**
 * Turn named Parts into Groups of Meshes (one per material). AO: static parts
 * are occluded by the static set (body, mag, slide); the moving left hand and
 * the suppressor also by themselves, so nothing leaves a stale shadow behind.
 */
function assemble(parts, o = {}) {
  const list = Object.values(parts).filter(Boolean);
  const [mn, mx] = boundsOf(list), cell = o.cell ?? 0.004;
  const gA = new Occ(mn, mx, cell);
  for (const k of ['body', 'mag', 'slide']) if (parts[k]) for (const b of parts[k].bk.values()) gA.mark(b.p);
  let gB = null;
  if (parts.handL || parts.sup) {
    gB = new Occ(mn, mx, cell); gB.d.set(gA.d);
    for (const k of ['handL', 'sup']) if (parts[k]) for (const b of parts[k].bk.values()) gB.mark(b.p);
  }
  const out = {};
  let tris = 0, calls = 0;
  for (const [name, part] of Object.entries(parts)) {
    if (!part) { out[name] = null; continue; }
    const g = new THREE.Group(); g.name = name;
    for (const [mat, b] of part.bk) {
      const geo = bucketGeometry(b, name === 'handL' || name === 'sup' ? gB : gA, o.ao ?? 0.85);
      const mesh = new THREE.Mesh(geo, mat); mesh.name = name;
      g.add(mesh); tris += geo.index.count / 3; calls++;
    }
    out[name] = g;
  }
  out.stats = { tris, calls };
  return out;
}

// ───────────────────────────── palette ─────────────────────────────
const C = {
  steel: 0x55595f, steelD: 0x45484d, bare: 0xc8ccd1, blued: 0x5a6472, bluedBare: 0xbcc3cc, carrier: 0xaaaeb3, dark: 0x0b0b0c,
  wood: 0xffffff, woodWear: 0xe0b48a, plum: 0x5e2b27, plumWear: 0x8c5a4f, black: 0x1d1e20, blackWear: 0x4a4b4e,
  bakelite: 0x3d2c22, olive: 0x5f6345, oliveDark: 0x4c5036, gloveBack: 0x2b2c2e, glovePalm: 0x3e3933, gloveGuard: 0x1a1b1c, rubber: 0x161718,
};

/** Dev-viewer switches (dev/weapon.html): arms false builds the weapons without hands. */
export const DEV = { arms: true };

// ───────────────────────────── hands and sleeves ─────────────────────────────
const FINGERS = [   // right hand: palm faces −Y, fingers along −Z, thumb at −X, wrist at the origin
  { b: [-0.0285, 0.0025, -0.083], L: [0.042, 0.025, 0.021], R: [0.0101, 0.0093, 0.0085] },
  { b: [-0.0092, 0.0035, -0.087], L: [0.046, 0.029, 0.022], R: [0.0105, 0.0096, 0.0087] },
  { b: [0.0102, 0.0025, -0.084], L: [0.043, 0.027, 0.021], R: [0.0099, 0.0091, 0.0083] },
  { b: [0.0282, 0.0, -0.077], L: [0.034, 0.021, 0.019], R: [0.0089, 0.0082, 0.0076] },
];
const THUMB = { b: [-0.024, -0.009, -0.016], L: [0.04, 0.031, 0.026], R: [0.0145, 0.0115, 0.0102] };
const _pcache = new Map();
function phalanx(len, r, tip) {
  const key = len + ':' + r + ':' + tip;
  if (_pcache.has(key)) return _pcache.get(key);
  const pts = [], k = 4, r2 = r * (tip ? 0.9 : 0.97);
  for (let i = 0; i <= k; i++) { const a = -PI / 2 + (PI / 2) * i / k; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
  pts.push([r * 0.94, len * 0.5]);
  for (let i = 0; i <= k; i++) { const a = (PI / 2) * i / k; pts.push([Math.cos(a) * r2, len + Math.sin(a) * r2 * (tip ? 1.15 : 1)]); }
  const pr = lathe(pts, { seg: 10, wear: false });
  _pcache.set(key, pr);
  return pr;
}
/** Hand frame: wrist position, direction wrist → knuckles, direction the back of the hand faces. */
function handFrame(o, fwd, back, left = false) {
  const z = new THREE.Vector3(fwd[0], fwd[1], fwd[2]).normalize().negate();
  const y = new THREE.Vector3(back[0], back[1], back[2]);
  y.addScaledVector(z, -y.dot(z)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  if (left) x.negate();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(o[0], o[1], o[2]);
}
const _T = new THREE.Matrix4(), _R = new THREE.Matrix4(), _E = new THREE.Euler();
/**
 * Gloved hand. pose: { f: [[spread, mcp, pip, dip] × 4] (radians, + curls toward the palm),
 * t: [[x, y, z] × 3] thumb joint Euler angles (YXZ) }.
 */
function buildHand(part, F, pose) {
  const M = materials();
  const back = new THREE.Vector3().setFromMatrixColumn(F, 1).normalize();
  const palm = new THREE.Color(C.glovePalm), bk = new THREE.Color(C.gloveBack);
  const colFn = (x, y, z, nx, ny, nz, out) => { out.copy(palm).lerp(bk, sstep(-0.5, 0.15, nx * back.x + ny * back.y + nz * back.z)); };
  const add = (pr, m, o = {}) => part.add(pr, M.glove, { m, colFn, crease: 70, macro: 0.06, ...o });
  // palm
  add(loft([
    { c: [0.0015, 0.0, 0.01], w: 0.054, h: 0.033, rt: 0.013, rb: 0.015 },
    { c: [0.0, 0.0005, -0.014], w: 0.066, h: 0.034, rt: 0.013, rb: 0.015 },
    { c: [0.0, 0.0012, -0.042], w: 0.079, h: 0.031, rt: 0.011, rb: 0.013 },
    { c: [0.0, 0.0018, -0.066], w: 0.085, h: 0.028, rt: 0.01, rb: 0.012 },
    { c: [0.0005, 0.002, -0.08], w: 0.083, h: 0.024, rt: 0.009, rb: 0.01 },
  ], { cap0: 'round', cap1: 'round', capD: 0.008, cseg: 4, sseg: 1, wear: false }), F);
  // fingers
  const sc = new THREE.Matrix4().makeScale(1.1, 0.92, 1);
  for (let i = 0; i < 4; i++) {
    const fd = FINGERS[i], ps = pose.f[i];
    const Mf = F.clone().multiply(_T.makeTranslation(fd.b[0], fd.b[1], fd.b[2])).multiply(_R.makeRotationY(ps[0])).multiply(_R.makeRotationX(-ps[1]));
    for (let s = 0; s < 3; s++) {
      add(phalanx(fd.L[s], fd.R[s], s === 2), Mf.clone().multiply(sc));
      if (s < 2) Mf.multiply(_T.makeTranslation(0, 0, -fd.L[s])).multiply(_R.makeRotationX(-ps[s + 2]));
    }
  }
  // thumb
  const Mt = F.clone().multiply(_T.makeTranslation(THUMB.b[0], THUMB.b[1], THUMB.b[2]));
  for (let s = 0; s < 3; s++) {
    const e = pose.t[s];
    Mt.multiply(_R.makeRotationFromEuler(_E.set(e[0], e[1], e[2], 'YXZ')));
    add(phalanx(THUMB.L[s], THUMB.R[s], s === 2), Mt.clone().multiply(sc));
    Mt.multiply(_T.makeTranslation(0, 0, -THUMB.L[s]));
  }
  // hard knuckle guard across the back of the hand
  const kg = [];
  for (let i = 0; i <= 6; i++) { const x = lerp(-0.039, 0.037, i / 6); kg.push({ c: [x, 0.0128 - x * x * 3.2, -0.0735 + Math.abs(x) * 0.08], w: 0.017, h: 0.0072, r: 0.0034 }); }
  part.add(loft(kg, { up: [0, 1, 0], cap0: 'round', cap1: 'round', capD: 0.003, cseg: 3, wear: false }), M.glove, { m: F, col: C.gloveGuard, crease: 60, macro: 0.05 });
  // padded cuff with a hook-and-loop tab
  add(loft([{ c: [0.0, 0.0, 0.006], w: 0.06, h: 0.043, r: 0.019 }, { c: [0.0, 0.0, 0.038], w: 0.061, h: 0.045, r: 0.02 }], { cap0: 'flat', cap1: 'flat', cseg: 5, wear: false }), F);
  part.add(rbox(0.006, 0.022, 0.022, 0.032, 0.005, 0.024, 0.002), M.glove, { m: F, col: C.gloveGuard, crease: 50 });
}
/** Uniform sleeve from the glove cuff to past the elbow, with a hem and cloth folds. */
function buildSleeve(part, F, elbow, seed = 0) {
  const M = materials();
  const s0 = new THREE.Vector3(0, 0.0005, 0.03).applyMatrix4(F), e = new THREE.Vector3(elbow[0], elbow[1], elbow[2]);
  const up = new THREE.Vector3().setFromMatrixColumn(F, 1).normalize(), u = [up.x, up.y, up.z];
  const st = [], T = [0, 0.03, 0.07, 0.085, 0.11, 0.16, 0.22, 0.3, 0.38, 0.47, 0.56, 0.66, 0.76, 0.88, 1];
  for (const t of T) {
    const c = s0.clone().lerp(e, t), hem = t <= 0.07 ? 0.007 : t < 0.09 ? 0.003 : 0, g = Math.sqrt(t);
    st.push({ c: [c.x, c.y, c.z], w: lerp(0.072, 0.11, g) + hem, h: lerp(0.064, 0.1, g) + hem, r: 0.05, up: u });
  }
  const disp = (k, j, x, y) => {
    const t = T[k], a = Math.atan2(y, x) + seed;
    let d = 0.0022 * Math.sin(3 * a + 6 * t + seed * 2) + 0.0016 * Math.sin(5 * a - 10 * t + 1.7) + 0.001 * Math.sin(9 * a + 3 * t);
    if (t > 0.09) d += 0.0032 * Math.sin(t * 34 + a * 1.3 + seed) * Math.pow(1 - t, 0.6);   // bunching rings / diagonal folds
    return t < 0.09 ? d * 0.25 : d;
  };
  part.add(loft(st, { cap0: 'inset', cap1: 'flat', cseg: 6, sseg: 2, disp, wear: false }), M.cloth, { col: C.olive, crease: 60, macro: 0.12 });
}

// ───────────────────────────── suppressors ─────────────────────────────
/**
 * Suppressor cans as revolve profiles: prof(th, i) → [[r, f], …] with f the
 * distance forward of the weapon origin, so a can sits on its own muzzle.
 * f0 / f1 span the can, r its body radius; the ground pickups build the same shapes.
 *   pistol  threaded onto the PM barrel, knurled collar
 *   akm     over the AKM compensator / AK-74 brake thread
 *   svd     a long slim can clamped over the SVD flash hider, two grip rings
 */
export const SUPPRESSORS = {
  pistol: { f0: 0.1612, f1: 0.307, r: 0.0157, col: 0x2b2d30, wear: 0.4,
    prof: (th, i) => { const kn = i % 2 ? 0.0004 : -0.0002; return [[0.0063, 0.1612], [0.0112, 0.1615], [0.0118 + kn, 0.1635], [0.0118 + kn, 0.172], [0.0128, 0.1742], [0.0152, 0.1762], [0.0157, 0.1785], [0.0157, 0.1925], [0.015, 0.1935], [0.015, 0.1965], [0.0157, 0.1975], [0.0157, 0.3], [0.015, 0.3045], [0.0126, 0.307], [0.0052, 0.307], [0.0045, 0.305], [0.0045, 0.29]]; } },
  akm: { f0: 0.602, f1: 0.811, r: 0.0172, col: 0x2c2e31, wear: 0.35,
    prof: (th, i) => { const kn = 0.00045 * (i % 2 ? 1 : -1); return [[0.0105, 0.602], [0.0132, 0.604], [0.0138 + kn, 0.607], [0.0138 + kn, 0.62], [0.0148, 0.623], [0.0168, 0.627], [0.0172, 0.63], [0.0172, 0.69], [0.0166, 0.692], [0.0166, 0.695], [0.0172, 0.697], [0.0172, 0.802], [0.0164, 0.808], [0.0128, 0.811], [0.0055, 0.811], [0.0048, 0.808], [0.0048, 0.79]]; } },
  svd: { f0: 0.826, f1: 1.127, r: 0.0168, col: 0x2a2c2f, wear: 0.35,
    prof: (th, i) => { const kn = 0.00045 * (i % 2 ? 1 : -1); return [[0.0099, 0.826], [0.0128, 0.8275], [0.0136 + kn, 0.8305], [0.0136 + kn, 0.852], [0.0146, 0.855], [0.0163, 0.859], [0.0168, 0.862], [0.0168, 0.93], [0.0161, 0.932], [0.0161, 0.936], [0.0168, 0.938], [0.0168, 1.03], [0.0161, 1.032], [0.0161, 1.036], [0.0168, 1.038], [0.0168, 1.118], [0.016, 1.124], [0.0126, 1.127], [0.0056, 1.127], [0.0049, 1.124], [0.0049, 1.105]]; } },
};

// ───────────────────────────── weapons ─────────────────────────────
function magProfile(top, fTop, d0, d1, R, L, lugs = true) {
  // a forward-curving magazine: centre line starts heading straight down at (fTop, top)
  const ph = L / R, fc = fTop + R, n = 14, rear = [], frontE = [];
  for (let i = 0; i <= n; i++) {
    const a = ph * i / n, d = lerp(d0, d1, i / n);
    rear.push([fc - (R + d / 2) * Math.cos(a), top - (R + d / 2) * Math.sin(a)]);
    frontE.push([fc - (R - d / 2) * Math.cos(a), top - (R - d / 2) * Math.sin(a)]);
  }
  const pts = [];
  for (const p of rear) pts.push(p);
  for (let i = frontE.length - 1; i >= 0; i--) pts.push(frontE[i]);
  if (lugs) {   // front locking lug at the top front
    pts[pts.length - 1] = [frontE[0][0] + 0.003, frontE[0][1]];
    pts.splice(pts.length - 1, 0, [frontE[1][0] + 0.003, frontE[1][1] + 0.002]);
  }
  return { pts, rear, front: frontE, ph, fc, R, top };
}
/** Floor plate outline at the bottom of a magazine profile: overhang rear / front, height up / down. */
function floorPlate(mp, rearO, frontO, up, down) {
  const a = mp.ph, tg = [Math.sin(a), -Math.cos(a)], rf = [Math.cos(a), Math.sin(a)];
  const bR = mp.rear[mp.rear.length - 1], bF = mp.front[mp.front.length - 1];
  const P = (p, r, t, f) => [p[0] + rf[0] * r + tg[0] * t, p[1] + rf[1] * r + tg[1] * t, f];
  return [P(bR, -rearO, -up, 0.001), P(bF, frontO, -up, 0.001), P(bF, frontO + 0.0005, down, 0.0012), P(bR, -rearO, down, 0.0012)];
}
/** A rib across a magazine profile at angle a (radians along the curve), between radii r0..r1. */
function crossRib(mp, a, r0, r1, wa) {
  const o = [];
  for (const [r, s] of [[r0, -1], [r1, -1], [r1, 1], [r0, 1]]) { const aa = a + s * wa / 2; o.push([mp.fc - r * Math.cos(aa), mp.top - r * Math.sin(aa), 0.0008]); }
  return o;
}

/** AKM / AK-74. */
function buildAK(v74) {
  const M = materials(), body = new Part(), mag = new Part(), slide = new Part(), sup = new Part(), handL = new Part();
  const FUR = v74 ? M.poly : M.wood, furCol = v74 ? C.plum : C.wood, furWear = v74 ? C.plumWear : C.woodWear;
  const st = (pr, col = C.steel, o = {}) => body.add(pr, M.steel, { col, wear: 0.6, wearCol: C.bare, ...o });
  const fur = (pr, o = {}) => body.add(pr, FUR, { col: furCol, wear: v74 ? 0.3 : 0.45, wearCol: furWear, crease: 45, ...o });
  const W = 0.0395, hw = W / 2;

  // ── receiver: solid lower half, thin upper walls (ejection port on the right), arched ribbed dust cover
  st(side([[0, -0.006], [0, -0.039, 0.004], [0.007, -0.046, 0.003], [0.241, -0.046, 0.002], [0.246, -0.04, 0.002], [0.246, -0.006]], W, { bevel: 0.0011 }));
  const wy0 = -0.0075, wy1 = 0.0105, wt = 0.0016, wx = hw - wt / 2;
  st(side([[0, wy0], [0.246, wy0], [0.246, wy1], [0, wy1]], wt, { x: -wx, bevel: 0.0005 }));
  st(side([[0, wy0], [0.246, wy0], [0.246, wy1], [0.208, wy1, 0.001], [0.205, -0.0035, 0.001], [0.106, -0.0035, 0.001], [0.103, wy1, 0.001], [0, wy1]], wt, { x: wx, bevel: 0.0005 }));
  st(box(0, 0.0015, -0.016, W - 0.003, 0.017, 0.032), C.steelD);                // rear trunnion
  st(box(0, 0.0015, -0.2275, W - 0.003, 0.017, 0.037), C.steelD);               // front trunnion
  const dcover = (f0, f1, g) => loft([{ c: [0, 0.0178 + g / 2, -f0], w: 0.0409 + g, h: 0.0177 + g, rt: 0.0132, rb: 0.0006 }, { c: [0, 0.0178 + g / 2, -f1], w: 0.0409 + g, h: 0.0177 + g, rt: 0.0132, rb: 0.0006 }], { cap0: 'flat', cap1: 'flat', cseg: 6 });
  st(dcover(0.003, 0.239, 0), C.steel, { grain: 'z' });
  for (let i = 0; i < 11; i++) { const f = 0.05 + i * 0.0158; st(dcover(f, f + 0.0042, 0.0013), C.steel, { wear: 0.9 }); }
  st(lathe([[0, -0.006], [0.0034, -0.006], [0.0034, 0.004], [0, 0.004]], { seg: 12, at: [0, 0.0158, 0] }), C.steelD);   // recoil spring guide button
  // rivets and pins on both sides
  const rivet = (f, y, s, r = 0.0021) => st(lathe([[0, 0], [r, 0], [r * 0.95, 0.0004], [r * 0.72, 0.00095], [0, 0.0012]], { seg: 10, axis: s > 0 ? 'x+' : 'x-', at: [s * (hw - 0.0002), y, -f] }), C.steelD, { wear: 0.9 });
  const pin = (f, y, s, r = 0.0026) => st(lathe([[0, 0], [r, 0], [r, 0.0004], [0, 0.0005]], { seg: 12, axis: s > 0 ? 'x+' : 'x-', at: [s * (hw - 0.0001), y, -f] }), C.steelD, { wear: 0.7 });
  for (const s of [-1, 1]) {
    for (const [f, y] of [[0.011, -0.016], [0.011, -0.033], [0.024, -0.038]]) rivet(f, y, s);
    for (const [f, y] of [[0.214, -0.013], [0.234, -0.013], [0.214, -0.031], [0.234, -0.031], [0.224, -0.022]]) rivet(f, y, s);
    pin(0.064, -0.023, s); pin(0.092, -0.027, s); if (s < 0) pin(0.038, -0.03, s, 0.002);
    // stamped magazine-well dimple
    st(side([[0.163, -0.041, 0.002], [0.207, -0.041, 0.002], [0.207, -0.026, 0.002], [0.163, -0.026, 0.002]], 0.0006, { x: s * (hw + 0.0001), bevel: 0.00025 }), C.steel, { wear: 0.5 });
  }
  // trigger guard, trigger, magazine catch
  st(side([[0.054, -0.04], [0.054, -0.07, 0.006], [0.065, -0.0835, 0.008], [0.134, -0.0835, 0.008], [0.147, -0.072, 0.008], [0.149, -0.04]], 0.0125,
    { holes: [[[0.0585, -0.043], [0.0585, -0.068, 0.004], [0.067, -0.079, 0.005], [0.131, -0.079, 0.005], [0.1425, -0.07, 0.005], [0.1435, -0.043]]], bevel: 0.0011 }));
  st(side([[0.0895, -0.044], [0.091, -0.056, 0.003], [0.0885, -0.066, 0.003], [0.083, -0.0735, 0.002], [0.079, -0.0745], [0.0815, -0.066, 0.003], [0.0835, -0.057, 0.003], [0.0825, -0.044]], 0.0075, { bevel: 0.0007 }));
  st(side([[0.1475, -0.044], [0.1475, -0.067, 0.002], [0.1515, -0.0715, 0.002], [0.1565, -0.069, 0.002], [0.1545, -0.044]], 0.012, { bevel: 0.0008 }));
  // selector lever on the right (middle position) and its pivot boss
  st(lathe([[0, 0], [0.0078, 0], [0.0078, 0.0016], [0.0062, 0.0026], [0, 0.0026]], { seg: 18, axis: 'x+', at: [hw, -0.012, -0.02] }));
  st(side([[0.018, -0.0074], [0.137, -0.0262, 0.002], [0.1415, -0.0325, 0.003], [0.1355, -0.0368, 0.002], [0.124, -0.0338], [0.018, -0.0168]], 0.0021, { x: hw + 0.0013, bevel: 0.0006 }));
  st(box(hw + 0.0032, -0.0315, -0.1335, 0.0036, 0.0082, 0.011, 0.0008));

  // ── furniture: pistol grip and stock
  const gT = [0, -0.042, -0.051], gB = [0, -0.152, -0.017], gd = [gB[0] - gT[0], gB[1] - gT[1], gB[2] - gT[2]];
  const gl = Math.hypot(...gd), gup = [0, -gd[2] / gl, gd[1] / gl];
  const grip = [[0, 0.026, 0.038], [0.12, 0.0268, 0.0385], [0.4, 0.029, 0.04], [0.7, 0.0302, 0.0415], [0.9, 0.0302, 0.042], [1, 0.0292, 0.0412]]
    .map(([t, w, h]) => ({ c: lerp3(gT, gB, t), w, h, rt: 0.0115, rb: 0.0125, up: gup }));
  fur(loft(grip, { cap0: 'flat', cap1: 'round', capD: 0.004, cseg: 5, sseg: 1 }), { grain: 'y' });
  st(lathe([[0, 0], [0.0048, 0], [0.0048, 0.0012], [0, 0.0014]], { seg: 14, axis: 'yd', at: [0, -0.1555, -0.018] }), C.steelD);
  const stock = [];
  for (const f of [0.004, -0.012, -0.035, -0.065, -0.1, -0.14, -0.18, -0.215, -0.244]) {
    const top = 0.004 + f * 0.17, bot = -0.046 + 0.5 * f + 0.15 * f * f, w = 0.034 + -f * 0.031;
    stock.push({ c: [0, (top + bot) / 2, -f], w, h: top - bot, rt: 0.0095, rb: 0.012, f });
  }
  const groove = v74 ? (k, j, x, y, s) => (s.f < -0.03 && s.f > -0.21 && Math.abs(x) > s.w / 2 - 0.0005 && Math.abs(y) < s.h * 0.2 ? -0.0022 * Math.sin(PI * clamp01((-s.f - 0.03) / 0.18)) : 0) : null;
  fur(loft(stock, { cap0: 'flat', cap1: 'flat', cseg: 4, sseg: v74 ? 4 : 1, disp: groove }));
  const bEnd = stock[stock.length - 1];
  if (v74) {   // rubber butt pad with ribs
    const pad = []; for (let i = 0; i <= 8; i++) { const f = -0.244 - i * 0.0022, rib = i % 2 ? 0.0012 : 0; pad.push({ c: [0, bEnd.c[1] - 0.0005, -f], w: bEnd.w + 0.001 + rib, h: bEnd.h + 0.001 + rib, rt: 0.01, rb: 0.012 }); }
    body.add(loft(pad, { cap0: 'flat', cap1: 'flat', cseg: 4 }), M.rubber, { col: C.rubber, crease: 40 });
  } else {
    st(loft([{ c: [0, bEnd.c[1], 0.2435], w: bEnd.w + 0.001, h: bEnd.h + 0.0012, rt: 0.0095, rb: 0.012 }, { c: [0, bEnd.c[1], 0.2505], w: bEnd.w + 0.0006, h: bEnd.h + 0.0008, rt: 0.009, rb: 0.011 }], { cap0: 'flat', cap1: 'flat', cseg: 4 }), C.steel);
  }
  // rear sling loop on the left of the stock
  st(box(-(0.034 + 0.14 * 0.031) / 2 - 0.0007, -0.083, 0.14, 0.0018, 0.012, 0.03, 0.0005), C.steelD);
  st(torus(0.0072, 0.0013, 14, 6), C.steelD, { m: new THREE.Matrix4().makeRotationY(PI / 2).setPosition(-0.0205, -0.083, 0.14 + 0.0) });

  // ── rear sight block, leaf and notch
  st(side([[0.236, -0.008], [0.236, 0.026, 0.002], [0.252, 0.031, 0.003], [0.3, 0.034, 0.003], [0.312, 0.029, 0.002], [0.312, -0.008]], 0.026, { bevel: 0.0012 }));
  st(side([[0.256, 0.0342], [0.302, 0.0342], [0.302, 0.0384, 0.001], [0.256, 0.0398, 0.001]], 0.0145, { bevel: 0.0005 }), C.steelD);
  // rear notch: its shoulders sit on the sight line (y 0.05), level with the front post top
  st(front([[-0.0075, 0.0335], [0.0075, 0.0335], [0.0075, 0.05, 0.0008], [0.0018, 0.05], [0.0013, 0.0466, 0.0004], [-0.0013, 0.0466, 0.0004], [-0.0018, 0.05], [-0.0075, 0.05, 0.0008]], 0.2512, 0.2545, { bevel: 0.0004 }), C.steelD, { wear: 0.8 });
  st(box(0, 0.0372, -0.277, 0.0178, 0.0066, 0.0068, 0.0009));
  st(lathe([[0, 0], [0.0032, 0], [0.0032, 0.0024], [0, 0.0024]], { seg: 10, axis: 'x+', at: [0.0089, 0.0372, -0.277] }));
  st(lathe([[0, -0.0085], [0.0022, -0.0085], [0.0022, 0.0085], [0, 0.0085]], { seg: 10, axis: 'x+', at: [0, 0.035, -0.303] }), C.steelD);

  // ── handguards, gas tube, gas block
  const lower = [[0.248, 0.04], [0.262, 0.042], [0.3, 0.0432], [0.335, 0.0438], [0.36, 0.047], [0.38, 0.053], [0.398, 0.0545], [0.414, 0.0515], [0.426, 0.046], [0.437, 0.0432]]
    .map(([f, w]) => ({ c: [0, -0.009, -f], w, h: 0.046, rt: 0.004, rb: 0.017 }));
  fur(loft(lower, { cap0: 'flat', cap1: 'flat', cseg: 5, sseg: 1 }));
  const upper = [[0.307, 0.031, 0.0285], [0.33, 0.0312, 0.0292], [0.4, 0.0305, 0.0292], [0.43, 0.029, 0.0282]].map(([f, w, h]) => ({ c: [0, 0.0135 + h / 2, -f], w, h, rt: 0.0135, rb: 0.004 }));
  fur(loft(upper, { cap0: 'flat', cap1: 'flat', cseg: 5 }));
  st(lathe([[0.0108, 0.428], [0.0108, 0.449]], { seg: 16, at: [0, 0.027, 0] }));
  for (const s of [-1, 1]) for (const f of [0.434, 0.441]) st(lathe([[0, 0], [0.0015, 0], [0.0015, 0.0003], [0, 0.0003]], { seg: 8, axis: s > 0 ? 'x+' : 'x-', at: [s * 0.0104, 0.027, -f] }), C.dark, { wear: 0 });
  st(loft([{ c: [0, -0.0085, -0.4365], w: 0.0455, h: 0.0482, rt: 0.006, rb: 0.018 }, { c: [0, -0.0085, -0.4485], w: 0.0455, h: 0.0482, rt: 0.006, rb: 0.018 }], { cap0: 'flat', cap1: 'flat', cseg: 5 }));
  st(side([[0.438, -0.006], [0.447, -0.006], [0.447, 0.004], [0.438, 0.004]], 0.004, { x: 0.024, bevel: 0.0006 }));
  st(side([[0.447, -0.0125], [0.447, 0.0398, 0.002], [0.4615, 0.0398, 0.002], [0.4905, 0.0112, 0.002], [0.4905, -0.0125, 0.001]], 0.0235, { bevel: 0.0013 }));
  st(side([[0.459, -0.012], [0.461, -0.0245, 0.0015], [0.488, -0.0245, 0.0015], [0.4905, -0.012]], 0.0125, { bevel: 0.0009 }));
  if (!v74) st(torus(0.0072, 0.0014, 14, 6), C.steelD, { m: new THREE.Matrix4().makeRotationY(PI / 2).setPosition(-0.0135, 0.001, -0.468) });

  // ── barrel, front sight, cleaning rod
  st(lathe([[0.0105, 0.24], [0.0105, 0.447], [0.0099, 0.49], [0.0094, 0.555], [0.0091, 0.6], [0.0087, 0.602], [0.0087, 0.616], [0.006, 0.6175], [0.0042, 0.6175], [0.0042, 0.6]], { seg: 20 }));
  st(lathe([[0.0118, 0.552], [0.0128, 0.5555], [0.0128, 0.5955], [0.0118, 0.599]], { seg: 20 }));
  st(front([[-0.0098, -0.004], [0.0098, -0.004], [0.0098, 0.047, 0.002], [0.0086, 0.0565, 0.001], [0.0058, 0.0565, 0.0006], [0.0058, 0.031, 0.004], [-0.0058, 0.031, 0.004], [-0.0058, 0.0565, 0.0006], [-0.0086, 0.0565, 0.001], [-0.0098, 0.047, 0.002]], 0.566, 0.59, { bevel: 0.0011 }));
  st(side([[0.568, -0.006], [0.569, -0.0215, 0.003], [0.597, -0.0215, 0.003], [0.598, -0.006]], 0.0125, { bevel: 0.0009 }));
  st(lathe([[0, 0.0305], [0.0043, 0.0305], [0.0043, 0.0338], [0, 0.0338]], { seg: 12, axis: 'y', at: [0, 0, -0.5785] }));
  st(lathe([[0, 0.033], [0.0013, 0.033], [0.0013, 0.0494], [0.0011, 0.05], [0, 0.05]], { seg: 10, axis: 'y', at: [0, 0, -0.5785] }), C.steelD, { wear: 0.4 });
  st(lathe([[0.0029, 0.44], [0.0029, 0.586], [0.0042, 0.5875], [0.0042, 0.598], [0, 0.599]], { seg: 10, at: [0, -0.0168, 0] }));

  // ── muzzle device
  let fMuzzle;
  if (!v74) {
    // AKM slant compensator: the lower lip runs longer
    st(revolve((th) => { const ff = 0.6365 - 0.0055 * Math.cos(th); return [[0.0098, 0.606], [0.0114, 0.6085], [0.0119, 0.611], [0.0119, ff - 0.0012], [0.0109, ff], [0.0047, ff], [0.0047, 0.618]]; }, 24));
    fMuzzle = 0.638;
  } else {
    // AK-74 two-chamber brake with large side windows
    const P = [[0.0098, 0.606], [0.0117, 0.608], [0.0117, 0.62], [0.011, 0.6215], [0.011, 0.6245], [0.0123, 0.626], [0.0123, 0.6455], [0.0123, 0.6725], [0.0123, 0.69], [0.0108, 0.6935], [0.0069, 0.6935], [0.0069, 0.676], [0.0095, 0.675], [0.0095, 0.644], [0.0048, 0.643], [0.0048, 0.63]];
    st(revolve(() => P, 32, { skip: (i, j) => j === 6 && (i % 16 > 4 && i % 16 < 12) }));
    const inner = revolve(() => [[0.0094, 0.6448], [0.0094, 0.6735]], 16, { wear: false });
    flipTris(inner.p, null);
    st(inner, C.dark, { wear: 0 });                     // sooty chamber seen through the windows
    fMuzzle = 0.694;
  }

  // ── magazine (separate part)
  const mp = v74 ? magProfile(-0.02, 0.188, 0.062, 0.067, 0.44, 0.226) : magProfile(-0.02, 0.189, 0.0635, 0.0735, 0.3, 0.236);
  const MAGM = v74 ? M.poly : M.steel, magCol = v74 ? C.plum : C.steel;
  const mw = v74 ? 0.031 : 0.0325;
  mag.add(side(mp.pts, mw, { bevel: 0.0022, seg: 1 }), MAGM, { col: magCol, wear: 0.5, wearCol: v74 ? C.plumWear : C.bare, crease: 40 });
  // floor plate following the bottom end, with the forward lip
  const ph = mp.ph;
  mag.add(side(floorPlate(mp, 0.0015, 0.0045, 0.006, 0.0028), mw + 0.0025, { bevel: 0.0012 }), M.steel, { col: v74 ? C.black : C.steelD, wear: 0.7, wearCol: C.bare });
  // side ribs (steel) or spine and lugs (polymer)
  const rib = (r0, r1, a0, a1) => { const o = []; for (let i = 0; i <= 10; i++) { const a = lerp(a0, a1, i / 10); o.push([mp.fc - r0 * Math.cos(a), -0.02 - r0 * Math.sin(a)]); } for (let i = 10; i >= 0; i--) { const a = lerp(a0, a1, i / 10); o.push([mp.fc - r1 * Math.cos(a), -0.02 - r1 * Math.sin(a)]); } return o; };
  if (!v74) {
    for (const rr of [mp.R + 0.017, mp.R - 0.017]) mag.add(side(rib(rr - 0.0032, rr + 0.0032, 0.13, ph - 0.07), mw + 0.0024, { bevel: 0.0009 }), M.steel, { col: C.steel, wear: 0.8, wearCol: C.bare });
  } else {
    mag.add(side(rib(mp.R + 0.0255, mp.R + 0.0335, 0.09, ph - 0.04), mw - 0.006, { bevel: 0.0012 }), M.poly, { col: C.plum, wear: 0.4, wearCol: C.plumWear });
    mag.add(side(rib(mp.R - 0.008, mp.R + 0.008, 0.16, ph - 0.1), mw + 0.0018, { bevel: 0.001 }), M.poly, { col: C.plum, wear: 0.5, wearCol: C.plumWear });
    mag.add(side([[0.139, -0.045], [0.146, -0.045], [0.146, -0.06], [0.139, -0.06]], mw + 0.0014, { bevel: 0.0007 }), M.steel, { col: C.steelD, wear: 0.6, wearCol: C.bare });
  }

  // ── bolt carrier, bolt and charging handle (separate part)
  const sl = (pr, col = C.carrier, o = {}) => slide.add(pr, M.bright, { col, wear: 0.5, wearCol: 0xd0d4d8, ...o });
  sl(box(0, 0.0012, -0.1015, 0.0332, 0.0152, 0.133, 0.0012));
  sl(box(0.0123, 0.0065, -0.1015, 0.008, 0.005, 0.133, 0.0008), 0x7d8185);
  sl(lathe([[0.0064, 0.168], [0.0064, 0.205], [0.0052, 0.207], [0, 0.207]], { seg: 14, at: [0, 0.0012, 0] }));
  sl(box(0.0115, 0.0015, -0.2, 0.0024, 0.004, 0.006, 0.0006), 0x6d7175);
  sl(box(hw + 0.0055, 0.0035, -0.2, 0.012, 0.0058, 0.0074, 0.0012), C.steel);
  slide.add(rbox(hw + 0.0145, 0.0048, -0.2, 0.0105, 0.0105, 0.012, 0.0045), M.steel, { col: C.steel, wear: 0.9, wearCol: C.bare, crease: 50 });

  // ── suppressor (separate part)
  const SA = SUPPRESSORS.akm;
  sup.add(revolve(SA.prof, 40), M.steel, { col: SA.col, wear: SA.wear, wearCol: 0x8a8e92 });

  // ── hands and sleeves
  const FR = handFrame([0.036, -0.073, 0.014], [-0.2, -0.24, -1], [1, 0.12, -0.05]);
  if (DEV.arms) buildHand(body, FR, { f: [[0.18, 0.18, 0.12, 0.08], [0.02, 1.32, 1.45, 0.85], [-0.04, 1.38, 1.42, 0.8], [-0.1, 1.42, 1.35, 0.75]], t: [[-0.55, 0.85, 0.5], [0.05, 0.2, 0], [0, 0.35, 0]] });
  if (DEV.arms) buildSleeve(body, FR, [0.15, -0.26, 0.3], 0.3);
  const FL = handFrame([-0.046, -0.06, -0.33], [0.78, 0.22, -0.58], [-0.25, -1, 0.05], true);
  if (DEV.arms) buildHand(handL, FL, { f: [[0.12, 0.72, 0.95, 0.55], [0.02, 0.85, 1.05, 0.6], [-0.05, 0.95, 1.05, 0.6], [-0.12, 1.0, 1.0, 0.6]], t: [[-0.3, 0.55, 0.35], [0, 0.15, 0], [0, 0.2, 0]] });
  if (DEV.arms) buildSleeve(handL, FL, [-0.2, -0.26, -0.06], 1.7);

  return { parts: { body, mag, slide, sup, handL }, muzzle: [0, 0, -fMuzzle], supMuzzle: [0, 0, -SA.f1], eject: [hw + 0.006, 0.004, -0.15], sightY: 0.05, adsZ: -0.15, hip: [0.13, -0.104, -0.33], hipRot: [0.02, 0.06, -0.16], slideTravel: 0.055 };
}

/** SVD with a PSO-1 style scope. */
function buildSVD() {
  const M = materials(), body = new Part(), mag = new Part(), slide = new Part(), sup = new Part(), handL = new Part();
  const st = (pr, col = C.steel, o = {}) => body.add(pr, M.steel, { col, wear: 0.55, wearCol: C.bare, ...o });
  const bl = (pr, col = 0x34383e, o = {}) => body.add(pr, M.blued, { col, wear: 0.5, wearCol: C.bluedBare, ...o });
  const wd = (pr, o = {}) => body.add(pr, M.wood, { col: 0xe4c8bc, wear: 0.45, wearCol: C.woodWear, crease: 45, ...o });
  const W = 0.036, hw = W / 2;
  // receiver
  st(side([[0, -0.006], [0, -0.036, 0.004], [0.006, -0.042, 0.003], [0.231, -0.042, 0.002], [0.236, -0.036, 0.002], [0.236, -0.006]], W, { bevel: 0.0011 }));
  const wy0 = -0.0075, wy1 = 0.0105, wt = 0.0016, wx = hw - wt / 2;
  st(side([[0, wy0], [0.236, wy0], [0.236, wy1], [0, wy1]], wt, { x: -wx, bevel: 0.0005 }));
  st(side([[0, wy0], [0.236, wy0], [0.236, wy1], [0.2, wy1, 0.001], [0.197, -0.003, 0.001], [0.098, -0.003, 0.001], [0.095, wy1, 0.001], [0, wy1]], wt, { x: wx, bevel: 0.0005 }));
  st(box(0, 0.0015, -0.016, W - 0.003, 0.017, 0.032), C.steelD);
  st(box(0, 0.0015, -0.219, W - 0.003, 0.017, 0.034), C.steelD);
  st(loft([{ c: [0, 0.0175, -0.003], w: 0.0372, h: 0.0172, rt: 0.012, rb: 0.0006 }, { c: [0, 0.0175, -0.229], w: 0.0372, h: 0.0172, rt: 0.012, rb: 0.0006 }], { cap0: 'flat', cap1: 'flat', cseg: 6 }));
  st(loft([{ c: [0, 0.019, 0.002], w: 0.026, h: 0.016, rt: 0.007, rb: 0.001 }, { c: [0, 0.019, -0.012], w: 0.026, h: 0.016, rt: 0.007, rb: 0.001 }], { cap0: 'round', cap1: 'flat', capD: 0.004 }), C.steelD);
  // left scope rail
  st(side([[0.04, -0.011, 0.001], [0.2, -0.011, 0.001], [0.2, 0.0035, 0.001], [0.04, 0.0035, 0.001]], 0.0055, { x: -hw - 0.0025, bevel: 0.0009 }), C.steelD);
  for (const s of [-1, 1]) for (const [f, y] of [[0.011, -0.016], [0.011, -0.03], [0.208, -0.014], [0.224, -0.014], [0.216, -0.03]]) st(lathe([[0, 0], [0.002, 0], [0.0019, 0.0004], [0.0014, 0.0009], [0, 0.0011]], { seg: 10, axis: s > 0 ? 'x+' : 'x-', at: [s * (hw - 0.0002), y, -f] }), C.steelD, { wear: 0.9 });
  // trigger guard, trigger, safety
  st(side([[0.046, -0.037], [0.046, -0.064, 0.006], [0.056, -0.077, 0.008], [0.106, -0.077, 0.008], [0.118, -0.066, 0.008], [0.12, -0.037]], 0.012, { holes: [[[0.0505, -0.04], [0.0505, -0.062, 0.004], [0.058, -0.0725, 0.005], [0.103, -0.0725, 0.005], [0.1135, -0.064, 0.005], [0.1145, -0.04]]], bevel: 0.001 }));
  st(side([[0.0745, -0.04], [0.076, -0.052, 0.003], [0.0735, -0.062, 0.003], [0.068, -0.069, 0.002], [0.064, -0.07], [0.0665, -0.062, 0.003], [0.0685, -0.053, 0.003], [0.0675, -0.04]], 0.0075, { bevel: 0.0007 }));
  st(side([[0.12, -0.04], [0.12, -0.063, 0.002], [0.124, -0.067, 0.002], [0.129, -0.065, 0.002], [0.127, -0.04]], 0.011, { bevel: 0.0008 }));
  st(lathe([[0, 0], [0.0074, 0], [0.0074, 0.0016], [0.006, 0.0026], [0, 0.0026]], { seg: 18, axis: 'x+', at: [hw, -0.012, -0.02] }));
  st(side([[0.018, -0.0072], [0.128, -0.0242, 0.002], [0.1325, -0.0305, 0.003], [0.1265, -0.0348, 0.002], [0.115, -0.0318], [0.018, -0.0166]], 0.0021, { x: hw + 0.0013, bevel: 0.0006 }));
  // skeleton stock with thumbhole, cheek rest and butt pad
  wd(side([[0.002, 0.004], [-0.3, -0.004, 0.02], [-0.338, -0.008, 0.012], [-0.346, -0.155, 0.01], [-0.3, -0.163, 0.02], [-0.11, -0.148, 0.03], [-0.03, -0.144, 0.015], [0.006, -0.14, 0.01], [0.044, -0.04, 0.01], [0.002, -0.04]], 0.0415,
    { holes: [[[-0.012, -0.034, 0.016], [-0.285, -0.035, 0.03], [-0.29, -0.118, 0.03], [-0.12, -0.115, 0.04], [-0.034, -0.114, 0.012]]], bevel: 0.0105, seg: 3 }), { grain: 'z', crease: 40 });
  body.add(loft([[-0.07, 0.005], [-0.1, 0.019], [-0.15, 0.024], [-0.2, 0.025], [-0.24, 0.022], [-0.262, 0.012]].map(([f, h]) => ({ c: [0, -0.004 + f * 0.026 + h / 2 - 0.004, -f], w: 0.044, h: h + 0.008, rt: 0.012, rb: 0.004 })), { cap0: 'round', cap1: 'round', capD: 0.008, cseg: 5 }), M.rubber, { col: 0x2a2622, crease: 50 });
  body.add(side([[-0.346, -0.157, 0.008], [-0.338, -0.006, 0.006], [-0.3485, -0.006, 0.004], [-0.357, -0.158, 0.005]], 0.043, { bevel: 0.004, seg: 2 }), M.rubber, { col: C.rubber, crease: 40 });
  // handguards (laminate) with vent slots
  wd(loft([[0.24, 0.044], [0.3, 0.046], [0.44, 0.046], [0.488, 0.044]].map(([f, w]) => ({ c: [0, -0.0065, -f], w, h: 0.037, rt: 0.004, rb: 0.017 })), { cap0: 'flat', cap1: 'flat', cseg: 5, sseg: 1 }));
  wd(loft([[0.246, 0.04], [0.3, 0.0415], [0.44, 0.0415], [0.484, 0.04]].map(([f, w]) => ({ c: [0, 0.024, -f], w, h: 0.025, rt: 0.016, rb: 0.003 })), { cap0: 'flat', cap1: 'flat', cseg: 5 }));
  for (const s of [-1, 1]) for (const f of [0.29, 0.345, 0.4]) {
    st(side([[f, -0.0075, 0.003], [f + 0.036, -0.0075, 0.003], [f + 0.036, 0.0005, 0.003], [f, 0.0005, 0.003]], 0.0012, { x: s * 0.0232, bevel: 0.0004 }), C.dark, { wear: 0 });
    st(side([[f + 0.004, 0.0225, 0.003], [f + 0.032, 0.0225, 0.003], [f + 0.032, 0.0285, 0.003], [f + 0.004, 0.0285, 0.003]], 0.0012, { x: s * 0.0206, bevel: 0.0004 }), C.dark, { wear: 0 });
  }
  st(loft([{ c: [0, 0.006, -0.236], w: 0.04, h: 0.048, rt: 0.014, rb: 0.016 }, { c: [0, 0.006, -0.247], w: 0.04, h: 0.048, rt: 0.014, rb: 0.016 }], { cap0: 'flat', cap1: 'flat', cseg: 5 }));
  st(loft([{ c: [0, 0.006, -0.486], w: 0.046, h: 0.05, rt: 0.016, rb: 0.017 }, { c: [0, 0.006, -0.497], w: 0.046, h: 0.05, rt: 0.016, rb: 0.017 }], { cap0: 'flat', cap1: 'flat', cseg: 5 }));
  // gas block with regulator, barrel, front sight, flash hider
  st(side([[0.497, -0.0135], [0.497, 0.039, 0.002], [0.53, 0.039, 0.003], [0.535, 0.03, 0.002], [0.535, -0.0135, 0.002]], 0.025, { bevel: 0.0013 }));
  st(lathe([[0, 0.535], [0.009, 0.535], [0.009, 0.544], [0.007, 0.546], [0, 0.546]], { seg: 16, at: [0, 0.027, 0] }));
  st(box(0, 0.027 + 0.008, -0.5405, 0.004, 0.009, 0.008, 0.0008), C.steelD);
  st(torus(0.0075, 0.0014, 14, 6), C.steelD, { m: new THREE.Matrix4().makeRotationY(PI / 2).setPosition(-0.0145, 0.0, -0.515) });
  st(lathe([[0.0115, 0.235], [0.0115, 0.497], [0.0105, 0.54], [0.0099, 0.7], [0.0094, 0.79], [0.0092, 0.832], [0.0045, 0.833], [0.0045, 0.82]], { seg: 20 }));
  st(lathe([[0.0118, 0.772], [0.0128, 0.7755], [0.0128, 0.8085], [0.0118, 0.812]], { seg: 20 }));
  st(front([[-0.0098, -0.004], [0.0098, -0.004], [0.0098, 0.042, 0.002], [0.0086, 0.0505, 0.001], [0.0058, 0.0505, 0.0006], [0.0058, 0.027, 0.004], [-0.0058, 0.027, 0.004], [-0.0058, 0.0505, 0.0006], [-0.0086, 0.0505, 0.001], [-0.0098, 0.042, 0.002]], 0.78, 0.802, { bevel: 0.0011 }));
  st(lathe([[0, 0.027], [0.0012, 0.027], [0.0012, 0.0445], [0, 0.045]], { seg: 10, axis: 'y', at: [0, 0, -0.791] }), C.steelD);
  st(revolve(() => [[0.0092, 0.83], [0.0113, 0.832], [0.0117, 0.835], [0.0117, 0.84], [0.0117, 0.878], [0.0117, 0.883], [0.0105, 0.886], [0.0083, 0.886], [0.0083, 0.84]], 30, { skip: (i, j) => j === 4 && i % 6 > 1 && i % 6 < 5 }));
  { const pr = revolve(() => [[0.0083, 0.84], [0.0083, 0.884]], 15, { wear: false }); flipTris(pr.p, null); st(pr, C.dark, { wear: 0 }); }

  // PSO-1 style scope on the left-side mount
  const sy = 0.075, sc = (pr, col = 0x2e3236, o = {}) => body.add(pr, M.blued, { col, wear: 0.45, wearCol: C.bluedBare, ...o });
  sc(lathe([[0.0185, -0.095], [0.0185, -0.064, 0.001], [0.0168, -0.058], [0.0136, -0.053], [0.0136, 0.052], [0.0176, 0.056], [0.0176, 0.114], [0.0136, 0.118], [0.0136, 0.188], [0.0165, 0.203], [0.0197, 0.214], [0.0206, 0.22], [0.0206, 0.268], [0.0198, 0.2715], [0.0186, 0.2715], [0.0186, 0.258], [0.0172, 0.257], [0.0172, 0.25]], { seg: 28, at: [0, sy, 0] }));
  sc(box(0, sy + 0.017, -0.085, 0.026, 0.009, 0.05, 0.0018));
  sc(box(0, sy, -0.085, 0.039, 0.03, 0.05, 0.003), 0x2a2e32);
  const knurl = (r, h, n) => (th) => { const k = r + (Math.cos(th * n) > 0 ? 0.00035 : -0.00035); return [[0, 0], [r + 0.0006, 0], [r + 0.0006, h * 0.22], [k, h * 0.26], [k, h * 0.88], [r - 0.0008, h], [0, h]]; };
  sc(revolve(knurl(0.012, 0.018, 36), 72), 0x2a2d31, { m: new THREE.Matrix4().makeRotationX(PI / 2).setPosition(0, sy + 0.0215, -0.085) });
  sc(revolve(knurl(0.0095, 0.014, 30), 60), 0x2a2d31, { m: new THREE.Matrix4().makeRotationY(-PI / 2).setPosition(0.0195, sy, -0.085) });
  sc(lathe([[0, 0], [0.0078, 0], [0.0078, 0.011], [0.0068, 0.0125], [0, 0.0125]], { seg: 18, axis: 'x-', at: [-0.0195, sy + 0.004, -0.068] }));
  for (let i = 0; i < 12; i++) {   // white index marks on the elevation drum
    const a = i / 12 * TAU, m = new THREE.Matrix4().makeRotationY(a).setPosition(Math.sin(a) * 0.0124, sy + 0.0215 + 0.0135, -0.085 + Math.cos(a) * 0.0124);
    body.add(box(0, 0, 0, 0.0011, i % 3 ? 0.0028 : 0.0045, 0.0006, 0.0002), M.poly, { m, col: 0xd8d4c8, macro: 0 });
  }
  // rubber eyecup (profile measured backwards from the origin: outer wall out, inner wall back in)
  body.add(lathe([[0.0186, 0.095], [0.0205, 0.106], [0.0224, 0.122], [0.0226, 0.133], [0.0215, 0.1362], [0.0195, 0.1362], [0.018, 0.133], [0.0165, 0.103]], { seg: 28, axis: 'zb', at: [0, sy, 0], wear: false }), M.rubber, { col: C.rubber, crease: 45 });
  // coated lenses, slightly domed
  body.add(lathe([[0.0174, 0.2555], [0.009, 0.2568], [0, 0.2572]], { seg: 24, at: [0, sy, 0], wear: false }), M.glass, { col: 0xffffff, macro: 0 });
  body.add(lathe([[0.0168, 0.0995], [0.008, 0.1003], [0, 0.1005]], { seg: 24, axis: 'zb', at: [0, sy, 0], wear: false }), M.glass, { col: 0xffffff, macro: 0 });
  // mount bracket, clamp lever and knob
  sc(side([[0.035, -0.012, 0.002], [0.17, -0.012, 0.002], [0.17, 0.004, 0.003], [0.148, sy - 0.006, 0.004], [0.052, sy - 0.006, 0.004], [0.035, 0.004, 0.003]], 0.008, { x: -0.0245, bevel: 0.0012, holes: [[[0.07, 0.016, 0.006], [0.13, 0.016, 0.006], [0.12, 0.05, 0.006], [0.08, 0.05, 0.006]]] }), 0x30343a);
  sc(box(-0.0125, sy - 0.0125, -0.1, 0.017, 0.012, 0.108, 0.002), 0x30343a);
  sc(side([[0.06, -0.004, 0.003], [0.155, 0.0, 0.003], [0.155, 0.007, 0.003], [0.06, 0.004, 0.003]], 0.0035, { x: -0.031, bevel: 0.0008 }), 0x2a2d31);
  sc(lathe([[0, 0], [0.0068, 0], [0.0068, 0.006], [0.0058, 0.0075], [0, 0.0075]], { seg: 16, axis: 'x-', at: [-0.0285, 0.02, -0.122] }), 0x2a2d31);

  // magazine (10 rounds)
  const mp = magProfile(-0.02, 0.122, 0.074, 0.077, 0.62, 0.118);
  mag.add(side(mp.pts, 0.0295, { bevel: 0.002 }), M.steel, { col: C.steel, wear: 0.55, wearCol: C.bare, crease: 40 });
  mag.add(side(floorPlate(mp, 0.0015, 0.003, 0.005, 0.003), 0.032, { bevel: 0.0011 }), M.steel, { col: C.steelD, wear: 0.7, wearCol: C.bare });
  for (const k of [0.4, 0.58, 0.76]) mag.add(side(crossRib(mp, mp.ph * k, mp.R - 0.03, mp.R + 0.03, 0.0045 / mp.R), 0.0317, { bevel: 0.0007 }), M.steel, { col: C.steel, wear: 0.8, wearCol: C.bare });

  // bolt carrier and charging handle
  const sl = (pr, col = C.carrier) => slide.add(pr, M.bright, { col, wear: 0.5, wearCol: 0xd0d4d8 });
  sl(box(0, 0.0012, -0.095, 0.0302, 0.015, 0.12, 0.0012));
  sl(lathe([[0.0062, 0.155], [0.0062, 0.196], [0.005, 0.198], [0, 0.198]], { seg: 14, at: [0, 0.0012, 0] }));
  sl(box(hw + 0.0055, 0.0035, -0.191, 0.012, 0.0058, 0.0074, 0.0012), C.steel);
  slide.add(loft([{ c: [hw + 0.0135, 0.004, -0.185], w: 0.009, h: 0.009, r: 0.0042 }, { c: [hw + 0.0165, 0.0055, -0.197], w: 0.0105, h: 0.0105, r: 0.005 }], { cap0: 'round', cap1: 'round', capD: 0.004 }), M.steel, { col: C.steel, wear: 0.9, wearCol: C.bare, crease: 50 });

  // suppressor (separate part): clamps over the flash hider, well below the scope's line of sight
  const SS = SUPPRESSORS.svd;
  sup.add(revolve(SS.prof, 40), M.steel, { col: SS.col, wear: SS.wear, wearCol: 0x8a8e92 });

  // hands
  const FR = handFrame([0.036, -0.069, 0.024], [-0.18, -0.26, -1], [1, 0.12, -0.05]);
  if (DEV.arms) buildHand(body, FR, { f: [[0.2, 0.2, 0.14, 0.08], [0.02, 1.28, 1.45, 0.85], [-0.04, 1.34, 1.42, 0.8], [-0.1, 1.38, 1.36, 0.75]], t: [[-0.55, 0.85, 0.5], [0.05, 0.2, 0], [0, 0.35, 0]] });
  if (DEV.arms) buildSleeve(body, FR, [0.15, -0.25, 0.31], 0.3);
  const FL = handFrame([-0.047, -0.058, -0.38], [0.78, 0.22, -0.58], [-0.25, -1, 0.05], true);
  if (DEV.arms) buildHand(handL, FL, { f: [[0.12, 0.72, 0.95, 0.55], [0.02, 0.85, 1.05, 0.6], [-0.05, 0.95, 1.05, 0.6], [-0.12, 1.0, 1.0, 0.6]], t: [[-0.3, 0.55, 0.35], [0, 0.15, 0], [0, 0.2, 0]] });
  if (DEV.arms) buildSleeve(handL, FL, [-0.2, -0.26, -0.11], 1.7);

  return { parts: { body, mag, slide, sup, handL }, muzzle: [0, 0, -0.886], supMuzzle: [0, 0, -SS.f1], eject: [hw + 0.006, 0.004, -0.145], sightY: sy, adsZ: -0.2, hip: [0.13, -0.118, -0.34], hipRot: [0.02, 0.06, -0.14], slideTravel: 0.05 };
}

/** Makarov-pattern service pistol with a threaded barrel and detachable suppressor. */
function buildPM() {
  const M = materials(), body = new Part(), mag = new Part(), slide = new Part(), sup = new Part(), handL = new Part();
  const bl = (part, pr, col = C.blued, o = {}) => part.add(pr, M.blued, { col, wear: 0.65, wearCol: C.bluedBare, ...o });
  // slide: rounded top, tapered nose with the muzzle opening
  const SL = [[0.0, 0.0204, 0.0114, -0.011, 0.0058], [0.0035, 0.0222, 0.0133, -0.011, 0.0064], [0.14, 0.0222, 0.0135, -0.011, 0.0065], [0.152, 0.0216, 0.0132, -0.011, 0.0067], [0.158, 0.0202, 0.0124, -0.0108, 0.0068], [0.1615, 0.0186, 0.0113, -0.0104, 0.0066]]
    .map(([f, w, top, bot, rt]) => ({ c: [0, (top + bot) / 2, -f], w, h: top - bot, rt, rb: 0.0012 }));
  // the nose is closed by an annulus around the barrel and a short bore
  bl(slide, loft(SL, { cap0: 'flat', cap1: 'hole', hole: { x: 0, y: 0, r: 0.0063, depth: 0.014 }, cseg: 5, sseg: 1 }));
  for (const s of [-1, 1]) for (let i = 0; i < 9; i++) { const f = 0.0095 + i * 0.0029; bl(slide, side([[f, -0.006], [f + 0.0013, -0.006], [f + 0.0013, 0.0068], [f, 0.0068]], 0.0006, { x: s * 0.0113, bevel: 0.0002 }), C.blued, { wear: 0.9 }); }
  bl(slide, side([[0.058, -0.0025, 0.001], [0.086, -0.0025, 0.001], [0.086, 0.0085, 0.001], [0.058, 0.0085, 0.001]], 0.0005, { x: 0.0112, bevel: 0.0001 }), C.dark, { wear: 0 });
  bl(slide, front([[-0.0056, 0.0125], [0.0056, 0.0125], [0.0056, 0.0162, 0.0005], [0.0012, 0.0162], [0.0012, 0.0141, 0.0003], [-0.0012, 0.0141, 0.0003], [-0.0012, 0.0162], [-0.0056, 0.0162, 0.0005]], 0.006, 0.0155, { bevel: 0.0004 }), C.blued, { wear: 0.8 });
  bl(slide, side([[0.1425, 0.012], [0.1455, 0.0162, 0.0006], [0.1525, 0.0162, 0.0004], [0.1545, 0.012]], 0.0024, { bevel: 0.0004 }), C.blued, { wear: 0.8 });
  bl(slide, lathe([[0, 0], [0.0049, 0], [0.0049, 0.0012], [0.004, 0.0018], [0, 0.0018]], { seg: 16, axis: 'x-', at: [-0.0111, 0.003, -0.014] }));
  bl(slide, side([[0.012, 0.0012], [0.031, 0.0062, 0.001], [0.0335, 0.0098, 0.0012], [0.027, 0.011, 0.001], [0.012, 0.0072]], 0.0017, { x: -0.0128, bevel: 0.0005 }), C.blued, { wear: 0.9 });
  // barrel with thread
  bl(body, lathe([[0.0058, 0.142], [0.0058, 0.1616], [0.0061, 0.1626], [0.0055, 0.1641], [0.0061, 0.1656], [0.0055, 0.1671], [0.0061, 0.1686], [0.0055, 0.1701], [0.0059, 0.1712], [0.0046, 0.1722], [0.0039, 0.1722], [0.0039, 0.155]], { seg: 18 }), 0x4a4f56);
  // frame, grip frame, trigger guard, trigger, hammer, slide stop
  bl(body, side([[0.004, -0.0108], [0.157, -0.0108], [0.1585, -0.0165, 0.002], [0.152, -0.0215, 0.002], [0.12, -0.0215], [0.114, -0.0195], [0.052, -0.0195], [0.05, -0.03, 0.003], [0.031, -0.111, 0.004], [0.026, -0.1135, 0.002], [-0.007, -0.1135, 0.002], [-0.0125, -0.109, 0.003], [0.0005, -0.03, 0.006], [0.002, -0.018, 0.004]], 0.0202, { bevel: 0.0009 }));
  bl(body, side([[0.0515, -0.019], [0.0515, -0.031, 0.004], [0.059, -0.0475, 0.008], [0.072, -0.0525, 0.008], [0.101, -0.0525, 0.008], [0.1135, -0.046, 0.008], [0.1185, -0.034, 0.005], [0.1185, -0.019]], 0.0088,
    { holes: [[[0.0555, -0.0215], [0.0555, -0.0315, 0.003], [0.0615, -0.044, 0.006], [0.0725, -0.0485, 0.006], [0.1, -0.0485, 0.006], [0.11, -0.043, 0.006], [0.1145, -0.0335, 0.004], [0.1145, -0.0215]]], bevel: 0.0009 }));
  bl(body, side([[0.0805, -0.02], [0.0815, -0.03, 0.002], [0.079, -0.038, 0.002], [0.074, -0.0425, 0.001], [0.0712, -0.0425], [0.0745, -0.0375, 0.002], [0.0763, -0.03, 0.002], [0.0758, -0.02]], 0.0062, { bevel: 0.0006 }));
  bl(body, side([[0.004, -0.004], [0.004, 0.0065, 0.001], [-0.0015, 0.0128, 0.002], [-0.0068, 0.0115, 0.002], [-0.0058, 0.004, 0.002], [-0.001, -0.004]], 0.0078, { bevel: 0.0007 }), C.blued, { wear: 0.9 });
  bl(body, side([[0.056, -0.0138, 0.001], [0.074, -0.0128, 0.001], [0.074, -0.0098, 0.001], [0.056, -0.0105, 0.001]], 0.0014, { x: -0.0109, bevel: 0.0004 }));
  bl(body, lathe([[0, 0], [0.0021, 0], [0.0021, 0.0005], [0, 0.0006]], { seg: 10, axis: 'x-', at: [-0.0101, -0.0165, -0.108] }));
  bl(body, lathe([[0, 0], [0.0021, 0], [0.0021, 0.0005], [0, 0.0006]], { seg: 10, axis: 'x-', at: [-0.0101, -0.0158, -0.124] }));
  // wraparound bakelite grip with chequering
  const gT = [0, -0.0175, -0.0235], gB = [0, -0.1125, -0.005], gd = [gB[0] - gT[0], gB[1] - gT[1], gB[2] - gT[2]];
  const gl = Math.hypot(...gd), gup = [0, -gd[2] / gl, gd[1] / gl];
  const grip = [[0, 0.0278, 0.0466], [0.15, 0.0286, 0.0472], [0.5, 0.0296, 0.048], [0.85, 0.0293, 0.0486], [1, 0.0284, 0.048]].map(([t, w, h]) => ({ c: lerp3(gT, gB, t), w, h, rt: 0.0085, rb: 0.0135, up: gup }));
  body.add(loft(grip, { cap0: 'flat', cap1: 'flat', cseg: 5, sseg: 1 }), M.grip, { col: C.bakelite, grain: 'y', crease: 45, wear: 0.3, wearCol: 0x6a5446 });
  bl(body, lathe([[0, 0], [0.0032, 0], [0.0032, 0.0008], [0.0024, 0.0012], [0, 0.0012]], { seg: 12, axis: 'zb', at: [0, -0.085, 0.0145] }));
  bl(body, lathe([[0, 0], [0.0024, 0], [0.0024, 0.003], [0, 0.003]], { seg: 10, axis: 'x-', at: [-0.0138, -0.106, 0.0085] }));
  bl(body, torus(0.0052, 0.0011, 14, 6), C.blued, { m: new THREE.Matrix4().makeRotationY(PI / 2).multiply(new THREE.Matrix4().makeRotationZ(0.5)).setPosition(-0.0172, -0.11, 0.0085) });
  bl(body, side([[-0.0105, -0.1135], [-0.002, -0.1135], [-0.002, -0.1105], [-0.0115, -0.1105]], 0.009, { bevel: 0.0005 }));
  // magazine: body inside the grip, base plate below
  const mg = [0.05, 0.4, 1].map((t) => ({ c: lerp3([0, -0.022, -0.0225], [0, -0.111, -0.0055], t), w: 0.0168, h: 0.033, r: 0.003, up: gup }));
  bl(mag, loft(mg, { cap0: 'flat', cap1: 'flat', cseg: 2 }), 0x5a5f66);
  bl(mag, loft([{ c: [0, -0.1151, -0.0062], w: 0.0262, h: 0.0472, r: 0.004, up: [0, 0, -1] }, { c: [0, -0.1178, -0.0062], w: 0.0255, h: 0.0466, r: 0.0035, up: [0, 0, -1] }], { cap0: 'flat', cap1: 'flat', cseg: 3 }), C.blued, { wear: 0.7 });
  // suppressor with a knurled collar
  const SP = SUPPRESSORS.pistol;
  sup.add(revolve(SP.prof, 40), M.steel, { col: SP.col, wear: SP.wear, wearCol: 0x8a8e92 });
  // hands: shooting hand on the grip, index along the frame; support hand wrapped below the guard
  const FR = handFrame([0.036, -0.058, 0.026], [-0.18, -0.13, -1], [1, 0.16, 0.0]);
  if (DEV.arms) buildHand(body, FR, { f: [[0.22, 0.12, 0.08, 0.05], [0.0, 1.3, 1.5, 0.85], [-0.05, 1.36, 1.45, 0.8], [-0.1, 1.42, 1.38, 0.75]], t: [[-0.5, 0.95, 0.45], [0.1, 0.25, 0], [0, 0.3, 0]] });
  if (DEV.arms) buildSleeve(body, FR, [0.13, -0.27, 0.32], 0.4);
  const FL = handFrame([-0.04, -0.092, 0.02], [0.15, 0.2, -1], [-1, -0.3, 0.0], true);
  if (DEV.arms) buildHand(handL, FL, { f: [[0.1, 1.15, 1.3, 0.7], [0.0, 1.25, 1.35, 0.75], [-0.05, 1.3, 1.3, 0.7], [-0.1, 1.35, 1.25, 0.65]], t: [[-0.35, 0.6, 0.3], [0.1, 0.1, 0], [0, 0.15, 0]] });
  if (DEV.arms) buildSleeve(handL, FL, [-0.17, -0.3, 0.27], 1.9);
  return { parts: { body, mag, slide, sup, handL }, muzzle: [0, 0, -0.172], supMuzzle: [0, 0, -SP.f1], eject: [0.013, 0.004, -0.072], sightY: 0.0162, adsZ: -0.33, hip: [0.12, -0.105, -0.33], hipRot: [0.03, 0.08, -0.12], slideTravel: 0.028 };
}

/** Combat knife: clip-point blade with a fuller, steel guard, ridged rubber handle. */
function buildKnife() {
  const M = materials(), body = new Part();
  // blade slab: spine / edge profile, flat grind, fuller near the spine
  const L = 0.16, f0 = 0.058, nu = 36, nv = 10, ptsL = [], ptsR = [];
  const ys = (u) => (u < 0.62 ? 0.0105 : 0.0105 - 0.0118 * Math.pow((u - 0.62) / 0.38, 1.35));
  const ye = (u) => -0.0185 + 0.0173 * Math.pow(u, 2.1);
  const th = (u, s) => {
    let t = 0.0046 * (1 - 0.55 * u);
    if (u > 0.05) t *= s < 0.55 ? 0.07 + 0.93 * Math.pow(s / 0.55, 0.9) : 1;
    if (u > 0.1 && u < 0.6 && s > 0.64 && s < 0.86) t -= 0.0017 * Math.sin(PI * (s - 0.64) / 0.22) * sstep(0.1, 0.16, u) * sstep(0.6, 0.54, u);
    return Math.max(0.00012, t);
  };
  for (let i = 0; i <= nu; i++) {
    const u = i / nu, rl = [], rr = [];
    for (let j = 0; j <= nv; j++) { const s = j / nv, y = lerp(ye(u), ys(u), s), t = th(u, s) / 2; rl.push([-t, y, -(f0 + u * L)]); rr.push([t, y, -(f0 + u * L)]); }
    ptsL.push(rl); ptsR.push(rr);
  }
  const tri = [], wv = [];
  const q = (a, b, c, d, w0 = 0) => { tri.push(...a, ...b, ...c, ...a, ...c, ...d); for (let k = 0; k < 6; k++) wv.push(w0); };
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const e = j < 2 ? 1 : 0;
    q(ptsR[i][j], ptsR[i + 1][j], ptsR[i + 1][j + 1], ptsR[i][j + 1], e);
    q(ptsL[i][j + 1], ptsL[i + 1][j + 1], ptsL[i + 1][j], ptsL[i][j], e);
  }
  for (let i = 0; i < nu; i++) { q(ptsR[i][nv], ptsR[i + 1][nv], ptsL[i + 1][nv], ptsL[i][nv]); q(ptsL[i][0], ptsL[i + 1][0], ptsR[i + 1][0], ptsR[i][0], 1); }
  for (let j = 0; j < nv; j++) q(ptsL[0][j], ptsL[0][j + 1], ptsR[0][j + 1], ptsR[0][j]);
  const blade = { p: new Float32Array(tri), w: new Float32Array(wv) };
  body.add(blade, M.bright, { col: 0x9da2a8, wear: 0.8, wearCol: 0xdfe3e8, crease: 30, grain: 'z' });
  // guard, handle, pommel
  body.add(front([[-0.0085, -0.031, 0.004], [0.0085, -0.031, 0.004], [0.0085, 0.024, 0.004], [-0.0085, 0.024, 0.004]], 0.05, 0.058, { bevel: 0.0014 }), M.blued, { col: 0x33373c, wear: 0.7, wearCol: C.bluedBare });
  const H = [];
  for (let i = 0; i <= 22; i++) {
    const t = i / 22, f = lerp(0.05, -0.068, t), ridge = i % 2 ? 0.0012 : 0, fing = 0.0016 * Math.sin(t * PI * 4 + 0.5) * (t < 0.8 ? 1 : 0);
    H.push({ c: [0, -0.003, -f], w: 0.0225 + ridge + (t > 0.85 ? 0.002 : 0), h: 0.0285 + ridge + fing + (t > 0.85 ? 0.003 : 0), rt: 0.0095, rb: 0.011 });
  }
  body.add(loft(H, { cap0: 'flat', cap1: 'flat', cseg: 4 }), M.grip, { col: 0x262825, crease: 50 });
  body.add(lathe([[0.012, 0.067], [0.0135, 0.071], [0.0135, 0.078], [0.0105, 0.082], [0, 0.0835]], { seg: 18, axis: 'zb', at: [0, -0.003, 0] }), M.blued, { col: 0x33373c, wear: 0.7, wearCol: C.bluedBare });
  // hand in a hammer grip
  const FR = handFrame([0.03, -0.062, 0.03], [-0.12, 0.62, -0.78], [0.94, 0.25, -0.2]);
  if (DEV.arms) buildHand(body, FR, { f: [[0.06, 1.25, 1.5, 0.9], [0.0, 1.3, 1.5, 0.9], [-0.04, 1.35, 1.45, 0.85], [-0.08, 1.4, 1.4, 0.8]], t: [[-0.5, 0.9, 0.6], [0.2, 0.3, 0], [0, 0.4, 0]] });
  if (DEV.arms) buildSleeve(body, FR, [0.14, -0.29, 0.28], 0.6);
  return { parts: { body, mag: null, slide: null, sup: null, handL: null }, muzzle: [0, 0, -(f0 + L)], eject: [0, 0, 0], sightY: 0.02, adsZ: -0.3, hip: [0.2, -0.2, -0.36], slideTravel: 0 };
}

const BUILD = { pistol: buildPM, akm: () => buildAK(false), ak74: () => buildAK(true), svd: buildSVD, knife: buildKnife };

/**
 * Build a first-person weapon. Returns
 * { root, mag, slide, sup, handL, muzzle, supMuzzle, eject, sightY, hip, adsZ, slideTravel, stats }.
 * `root` points along −Z and is positioned by weapons.js; mag / slide / sup /
 * handL are Groups animated by offset from their rest pose (position 0,0,0).
 * `muzzle` is the bare muzzle, `supMuzzle` the end of the suppressor (null when the gun takes none).
 */
export function buildViewModel(id) {
  const t0 = performance.now();
  const def = (BUILD[id] || buildKnife)();
  const parts = assemble(def.parts);
  const root = new THREE.Group(); root.name = 'vm_' + id;
  for (const k of ['body', 'mag', 'slide', 'sup', 'handL']) if (parts[k]) root.add(parts[k]);
  const muzzle = new THREE.Object3D(), eject = new THREE.Object3D();
  muzzle.position.fromArray(def.muzzle); eject.position.fromArray(def.eject);
  root.add(muzzle, eject);
  let supMuzzle = null;
  if (def.supMuzzle) { supMuzzle = new THREE.Object3D(); supMuzzle.position.fromArray(def.supMuzzle); root.add(supMuzzle); }
  if (parts.sup) parts.sup.visible = false;
  return { root, mag: parts.mag, slide: parts.slide, sup: parts.sup, handL: parts.handL, muzzle, supMuzzle, eject,
    sightY: def.sightY, hip: def.hip, hipRot: def.hipRot || [0, 0, 0], adsZ: def.adsZ, slideTravel: def.slideTravel,
    stats: { ...parts.stats, ms: Math.round(performance.now() - t0) } };
}

/**
 * A gun for the ground pickups: the view model's own parts without the hands,
 * at a lower level of detail (about two fifths of the segments, nothing under
 * 5.5 mm), with ambient occlusion baked. o: { sup: fit the suppressor, lod, minSize }.
 * Returns { parts: { body, mag, slide, sup }, muzzle, supMuzzle, stats } where each
 * part is [{ mat, geometry }] (mat names a key of the material set: 'steel',
 * 'blued', 'bright', 'wood', 'poly', 'grip', 'rubber', 'glass', …) or null.
 * Coordinates as the view model: barrel along −Z, grip near the origin.
 */
export function buildWorldWeapon(id, o = {}) {
  const t0 = performance.now(), arms = DEV.arms;
  let def;
  DEV.arms = false; LOD.k = o.lod ?? 0.42; LOD.min = o.minSize ?? 0.0055;
  try { def = (BUILD[id] || BUILD.akm)(); } finally { DEV.arms = arms; LOD.k = 1; LOD.min = 0; }
  const keep = { body: def.parts.body, mag: def.parts.mag, slide: def.parts.slide, sup: o.sup ? def.parts.sup : null };
  const parts = assemble(keep, { cell: 0.005 });
  const names = new Map(Object.entries(materials()).map(([k, m]) => [m, k]));
  const out = {};
  for (const k of Object.keys(keep)) out[k] = parts[k] ? parts[k].children.map((m) => ({ mat: names.get(m.material), geometry: m.geometry })) : null;
  return { parts: out, muzzle: def.muzzle, supMuzzle: def.supMuzzle || null, stats: { ...parts.stats, ms: Math.round(performance.now() - t0) } };
}

/** The modelling toolkit, for pickup-models.js (the same primitives and conventions as above). */
export const KIT = {
  TAU, PI, clamp01, lerp, sstep, h3, pnoise, pfbm, noise3, scratchMask,
  fillet, arcPts, trisOf, faceAxisWear, mapP, flipTris, creaseNormals, hashRows,
  side, front, plan, box, lathe, revolve, torus, rrect, tube, loft, rbox, Occ, aoAt,
};

// ───────────────────────────── item hands and props ─────────────────────────────
/**
 * Finger poses for the item animations (vm-items.js). Same convention as buildHand:
 * [spread, mcp, pip, dip] per finger, thumb joint Euler angles (YXZ).
 */
const ITEM_POSES = {
  grip: { f: [[0.16, 0.74, 0.86, 0.48], [0.03, 0.8, 0.9, 0.5], [-0.07, 0.86, 0.88, 0.48], [-0.17, 0.92, 0.84, 0.46]], t: [[-0.72, 0.7, 0.62], [0.12, 0.32, 0], [0, 0.3, 0]] },
  fist: { f: [[0.06, 1.25, 1.5, 0.9], [0.0, 1.3, 1.5, 0.9], [-0.04, 1.35, 1.45, 0.85], [-0.08, 1.4, 1.4, 0.8]], t: [[-0.5, 0.9, 0.6], [0.2, 0.3, 0], [0, 0.4, 0]] },
  pinch: { f: [[0.1, 0.62, 0.95, 0.6], [0.0, 1.2, 1.4, 0.8], [-0.06, 1.32, 1.4, 0.8], [-0.12, 1.42, 1.36, 0.75]], t: [[-0.62, 0.62, 0.42], [0.15, 0.38, 0], [0, 0.38, 0]] },
  flat: { f: [[0.13, 0.12, 0.12, 0.06], [0.02, 0.08, 0.1, 0.05], [-0.07, 0.1, 0.12, 0.06], [-0.17, 0.14, 0.14, 0.07]], t: [[-0.12, 0.6, 0.12], [0.05, 0.12, 0], [0, 0.12, 0]] },
  hold: { f: [[0.1, 0.5, 0.62, 0.34], [0.02, 0.55, 0.62, 0.34], [-0.06, 0.6, 0.62, 0.34], [-0.14, 0.66, 0.6, 0.34]], t: [[-0.3, 0.72, 0.25], [0.06, 0.18, 0], [0, 0.18, 0]] },
};
/** Elbow of the item arms in the canonical wrist frame, and the sleeve's section along the forearm (as buildSleeve makes it). */
const ARM_ELBOW = [0.004, -0.012, 0.3];
function sleeveAt(z, extra = 0, out = { c: [0, 0, 0], w: 0, h: 0, r: 0.05 }) {
  const t = clamp01((z - 0.03) / (ARM_ELBOW[2] - 0.03)), g = Math.sqrt(t), hem = t <= 0.07 ? 0.007 : t < 0.09 ? 0.003 : 0;
  out.c[0] = ARM_ELBOW[0] * t; out.c[1] = lerp(0.0005, ARM_ELBOW[1], t); out.c[2] = z;
  out.w = lerp(0.072, 0.11, g) + hem + extra; out.h = lerp(0.064, 0.1, g) + hem + extra;
  return out;
}
/** A band round the forearm from z0 to z1 (bandage turns, the tourniquet strap). */
function armBand(z0, z1, extra) { return loft([sleeveAt(z0, extra), sleeveAt((z0 + z1) / 2, extra * 1.05), sleeveAt(z1, extra)], { cap0: 'flat', cap1: 'flat', cseg: 6, sseg: 2, wear: false }); }

/**
 * Hands and props for the first-person item animations, built once at start-up.
 *   hands   a right glove + sleeve per finger pose (grip, fist, pinch, flat, hold): wrist at the
 *           origin, fingers along −Z, back of the hand +Y, thumb at −X, forearm along +Z. The left
 *           hand is the same geometry mirrored (scale.x = −1).
 *   props   pouch (+ lid hinged on its x axis), injector (+ cap), dressing, roll (along x), strip
 *           (1 m along −Z, scaled to length), wraps (bandage turns, canonical arm frame), tourniquet
 *           (+ rod), carrier (plate-carrier front, top edge at y = 0), rod (cleaning rod along −Z),
 *           clacker (+ squeeze lever hinged at its back end).
 */
export function buildItemKit() {
  const t0 = performance.now(), M = materials();
  const hands = {}, props = {};
  const F = new THREE.Matrix4();
  for (const [name, pose] of Object.entries(ITEM_POSES)) {
    const body = new Part();
    buildHand(body, F, pose); buildSleeve(body, F, ARM_ELBOW, 0.9);
    hands[name] = assemble({ body }).body;
  }
  const one = (fn) => { const p = new Part(); fn(p); return assemble({ body: p }).body; };
  // a prop with one moving piece: both built in place (so the AO is right), then the piece is re-centred on its pivot
  const two = (fa, fb, pivot = [0, 0, 0]) => {
    const a = new Part(), b = new Part(); fa(a); fb(b);
    const o = assemble({ body: a, sup: b });
    for (const m of o.sup.children) { m.geometry.translate(-pivot[0], -pivot[1], -pivot[2]); m.geometry.computeBoundingSphere(); }
    o.sup.position.fromArray(pivot); o.sup.visible = true; o.body.add(o.sup);
    return { root: o.body, moving: o.sup };
  };
  const cloth = (part, pr, col, o = {}) => part.add(pr, M.cloth, { col, crease: 50, macro: 0.1, ...o });
  const rub = (part, pr, col, o = {}) => part.add(pr, M.rubber, { col, crease: 50, ...o });
  const poly = (part, pr, col, o = {}) => part.add(pr, M.poly, { col, crease: 40, ...o });
  // medical pouch: red cordura, lid hinged along the back edge, black zip round three sides
  const PW = 0.16, PT = 0.052, PD = 0.104;
  const pouch = two((p) => {
    cloth(p, rbox(0, 0, 0, PW, PT, PD, 0.016), 0x7a2a24);
    cloth(p, rbox(0, PT / 2 - 0.002, -0.004, PW - 0.026, 0.006, PD - 0.028, 0.005), 0x161210, { macro: 0.05 });     // the opening
    cloth(p, rbox(-0.028, PT / 2 - 0.0005, -0.006, 0.058, 0.008, 0.05, 0.003), 0x8a8264);                        // a dressing inside
    cloth(p, lathe([[0.004, -0.028], [0.016, -0.03], [0.0165, 0.028], [0.004, 0.03]], { seg: 14, axis: 'x+', at: [0.038, PT / 2 - 0.008, 0.01] }), 0xe2dccb);
    cloth(p, rbox(PW / 2 + 0.006, 0, 0, 0.01, 0.012, 0.05, 0.003), 0x2b2c25);                                     // grab handle
  }, (p) => {
    const y = PT / 2 - 0.003;
    cloth(p, rbox(0, y + 0.004, 0, PW + 0.002, 0.01, PD + 0.002, 0.005), 0x7a2a24);
    for (const s of [-1, 1]) rub(p, rbox(s * (PW / 2 - 0.001), y + 0.001, 0, 0.006, 0.006, PD - 0.01, 0.002), 0x191a17);
    rub(p, rbox(0, y + 0.001, -PD / 2 + 0.001, PW - 0.01, 0.006, 0.006, 0.002), 0x191a17);
    cloth(p, rbox(-0.008, y + 0.0095, 0, 0.062, 0.0016, 0.048, 0.002), 0x4b5038);
    cloth(p, rbox(-0.008, y + 0.0105, 0, 0.036, 0.0012, 0.01, 0.0005), 0xb8b2a0);
    cloth(p, rbox(-0.008, y + 0.0105, 0, 0.01, 0.0012, 0.036, 0.0005), 0xb8b2a0);
    p.add(rbox(-PW / 2 + 0.008, y + 0.003, -PD / 2 + 0.002, 0.012, 0.004, 0.008, 0.0015), M.steel, { col: 0x3c3e3e });     // zip slider and pull
    rub(p, rbox(-PW / 2 + 0.004, y + 0.002, -PD / 2 - 0.012, 0.005, 0.0028, 0.026, 0.0012), 0x1d1e1a);
  }, [0, PT / 2 - 0.003, PD / 2 - 0.001]);
  props.pouch = { root: pouch.root, lid: pouch.moving, size: [PW, PT, PD] };
  // auto-injector along −Z (needle end forward), safety cap on the back
  const inj = two((p) => {
    poly(p, lathe([[0, -0.064], [0.0084, -0.064], [0.0094, -0.06], [0.0094, 0.05], [0.0084, 0.056], [0.0062, 0.06], [0.0062, 0.066], [0, 0.067]], { seg: 18 }), 0x56633f);
    poly(p, lathe([[0.0097, 0.034], [0.0097, 0.046]], { seg: 18 }), 0xc9a227);
    rub(p, lathe([[0.0063, 0.06], [0.0063, 0.067], [0, 0.068]], { seg: 14 }), 0x202020);
  }, (p) => poly(p, lathe([[0, 0], [0.0102, 0], [0.0102, 0.022], [0.009, 0.025], [0, 0.025]], { seg: 18, axis: 'zb', at: [0, 0, 0.056] }), 0xc8762a));
  props.injector = { root: inj.root, cap: inj.moving };
  props.dressing = one((p) => {
    cloth(p, rbox(0, 0, 0, 0.09, 0.012, 0.068, 0.004), 0xa89e7a);
    cloth(p, rbox(0, -0.006, 0, 0.078, 0.003, 0.058, 0.0012), 0xe2dccb);
  });
  // bandage: the roll (along x), the strip being paid out, the turns that build up on the forearm
  props.roll = one((p) => cloth(p, lathe([[0.0055, -0.034], [0.019, -0.035], [0.0215, -0.033], [0.0215, 0.033], [0.019, 0.035], [0.0055, 0.034], [0.0055, -0.034]], { seg: 20, axis: 'x+' }), 0xe6e0d0, { crease: 60 }));
  props.strip = one((p) => cloth(p, rbox(0, 0, -0.5, 0.06, 0.0016, 1.0, 0.0006), 0xe6e0d0));
  props.wraps = [];
  for (let i = 0; i < 5; i++) { const z0 = 0.04 + i * 0.028; props.wraps.push(one((p) => cloth(p, armBand(z0, z0 + 0.044, 0.0105 + i * 0.0008), i % 2 ? 0xd2ccba : 0xdbd5c4))); }
  // windlass tourniquet round the forearm near the elbow: rod over the top (+Y), clip beside it
  const TZ = 0.215, tq = sleeveAt(TZ + 0.019, 0.01), top = tq.c[1] + tq.h / 2;
  const tqp = two((p) => {
    p.add(armBand(TZ, TZ + 0.038, 0.01), M.cloth, { col: 0x1e1f1c, crease: 50 });
    poly(p, rbox(tq.c[0], top + 0.002, TZ + 0.019, 0.05, 0.006, 0.03, 0.002), 0x262725);
    for (const s of [-1, 1]) poly(p, rbox(tq.c[0] + 0.058, top - 0.002 + s * 0.008, TZ + 0.019, 0.014, 0.005, 0.03, 0.0015), 0x222321);
    cloth(p, rbox(tq.c[0] - 0.042, top - 0.004, TZ + 0.019, 0.02, 0.003, 0.026, 0.001), 0xe2e0d8);
  }, (p) => poly(p, rbox(tq.c[0], top + 0.009, TZ + 0.019, 0.1, 0.0105, 0.0115, 0.004), 0x1b1c1b, { wear: 0.3, wearCol: 0x4a4b48 }), [tq.c[0], top + 0.009, TZ + 0.019]);
  props.tourniquet = { root: tqp.root, rod: tqp.moving, side: [tq.c[0] + tq.w / 2, tq.c[1], TZ + 0.019] };
  // plate carrier front at the chest: top edge (the pocket mouth) at y = 0, webbing below
  props.carrier = one((p) => {
    cloth(p, rbox(0, -0.16, -0.02, 0.32, 0.32, 0.016, 0.008), 0x5f6345);                       // outer panel
    cloth(p, rbox(0, -0.002, -0.02, 0.322, 0.008, 0.02, 0.004), 0x2c2e24);                       // binding on its top edge
    cloth(p, rbox(0, -0.18, 0.019, 0.3, 0.3, 0.012, 0.006), 0x53573c);                           // inner panel, against the chest
    cloth(p, rbox(0, -0.032, 0.019, 0.302, 0.008, 0.016, 0.004), 0x2c2e24);
    for (const s of [-1, 1]) cloth(p, rbox(s * 0.156, -0.17, 0, 0.012, 0.3, 0.05, 0.005), 0x4c5036);   // side seams
    for (const s of [-1, 1]) cloth(p, rbox(s * 0.1, 0.02, 0.022, 0.05, 0.07, 0.008, 0.004), 0x4c5036);   // shoulder straps rising off the inner panel
  });
  // cleaning rod: handle in the fist at the origin, rod forward, bore brush on the tip
  props.rod = one((p) => {
    poly(p, lathe([[0, -0.03], [0.0085, -0.03], [0.0095, -0.024], [0.0095, 0.05], [0.0085, 0.056], [0, 0.056]], { seg: 14, axis: 'zb' }), 0x26231f);
    p.add(lathe([[0.0027, 0.024], [0.0027, 0.3]], { seg: 10 }), M.steel, { col: 0x8d9195, wear: 0.4, wearCol: 0xc0c4c8 });
    p.add(lathe([[0, 0.29], [0.0058, 0.293], [0.0062, 0.33], [0.004, 0.336], [0, 0.337]], { seg: 14 }), M.brass, { col: 0x8a7240, crease: 70 });
  });
  // clacker (firing device): squeeze lever under the body, hinged at its back end; wire out of the front
  const clk = two((p) => {
    poly(p, rbox(0, 0, 0, 0.034, 0.03, 0.1, 0.006), 0x4b5236, { wear: 0.4, wearCol: 0x6d7257 });
    poly(p, rbox(0, 0.0165, 0.01, 0.022, 0.004, 0.05, 0.002), 0x3d4230);
    rub(p, lathe([[0, 0], [0.004, 0], [0.004, 0.012], [0, 0.012]], { seg: 10, at: [0, 0.002, -0.05] }), 0x1f2020);
    rub(p, loft([[0, 0.002, -0.06], [0.004, -0.004, -0.1], [0.02, -0.03, -0.14], [0.05, -0.08, -0.16], [0.09, -0.16, -0.15]].map((c) => ({ c, w: 0.0045, h: 0.0045, r: 0.002 })), { cap0: 'flat', cap1: 'flat', cseg: 2 }), 0x1b1d1a, { crease: 60 });
  }, (p) => {
    poly(p, rbox(0, -0.022, 0.002, 0.026, 0.008, 0.088, 0.003), 0x3a3f2c, { wear: 0.4, wearCol: 0x5e634c });
    p.add(rbox(0, -0.019, 0.044, 0.03, 0.01, 0.008, 0.003), M.steel, { col: 0x3c3e3e });
  }, [0, -0.016, 0.046]);
  props.clacker = { root: clk.root, lever: clk.moving };
  return { hands, props, section: sleeveAt, ms: Math.round(performance.now() - t0) };
}
