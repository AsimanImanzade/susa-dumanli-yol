/**
 * nature.js — procedural vegetation for the forest below Shusha in November:
 * firs and pines, bare oak / hornbeam / beech with a few clinging dry leaves,
 * limestone boulders, scrub bushes and ground cover (grass, bracken, weeds,
 * leaf litter, stumps, fallen branches, stones).
 *
 * Everything is generated here: geometry from a seeded PRNG (identical every
 * load), textures painted on canvases / computed into DataTextures, placement
 * from hash2. Drawn with a handful of BatchedMeshes (one draw call each):
 * wood, foliage cards, rocks, ground cover cards. Far instances are hidden and
 * trees switch to a lighter geometry past LOD_DIST, so the GPU only pays for
 * what the fog lets you see. Foliage and wood sway gently in the vertex shader.
 */
import * as THREE from 'three';
import { hash2 } from './ctx.js';

// ───────────────────────── small math ─────────────────────────
const TAU = Math.PI * 2;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const madd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0]; };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const UP = [0, 1, 0];
/** Rotate v around a unit axis (Rodrigues). */
function rot(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a), kv = cross(k, v), d = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d];
}
/** Any unit vector perpendicular to d. */
const perp = (d) => norm(cross(d, Math.abs(d[1]) < 0.9 ? UP : [1, 0, 0]));

/** Seeded PRNG (mulberry32): the kit is identical on every load. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Tileable value noise (periods px, py in lattice cells). */
function tvn(x, y, px, py, sd) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px, y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py, o = sd * 7919;
  const a = hash2(x0 + o, y0 - o), b = hash2(x1 + o, y0 - o), c = hash2(x0 + o, y1 - o), d = hash2(x1 + o, y1 - o);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function tfbm(x, y, px, py, oct, sd) {
  let s = 0, amp = 0.5, n = 0;
  for (let i = 0; i < oct; i++) { s += tvn(x, y, px, py, sd + i) * amp; n += amp; x *= 2; y *= 2; px *= 2; py *= 2; amp *= 0.5; }
  return s / n;
}
function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let fx = x - xi, fy = y - yi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy), l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy), fz);
}

// ───────────────────────── mesh builder ─────────────────────────
/** Accumulates one geometry with the attribute set every nature batch shares. */
class MB {
  constructor() { this.P = []; this.N = []; this.U = []; this.C = []; this.W = []; this.I = []; }
  get count() { return this.P.length / 3; }
  vert(p, n, u, v, c, w) {
    this.P.push(p[0], p[1], p[2]); this.N.push(n[0], n[1], n[2]); this.U.push(u, v); this.C.push(c[0], c[1], c[2]); this.W.push(w);
    return this.P.length / 3 - 1;
  }
  geo() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(this.W, 1));
    g.setIndex(this.I);
    return g;
  }
}

/**
 * Tube along a polyline (parallel-transport frames). rad[i] per point;
 * o: { uRep, vLen, col(p, i), sw(p), rmod(i, ang) }. Outward-facing, open ends.
 */
function tube(mb, pts, rad, sides, o) {
  const n = pts.length, base = mb.count;
  let N = null, vAcc = 0;
  for (let i = 0; i < n; i++) {
    const T = norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]));
    N = N ? norm(sub(N, mul(T, dot(N, T)))) : perp(T);
    const B = cross(T, N);
    if (i > 0) vAcc += len(sub(pts[i], pts[i - 1]));
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * TAU, ca = Math.cos(a), sa = Math.sin(a);
      const d = [N[0] * ca + B[0] * sa, N[1] * ca + B[1] * sa, N[2] * ca + B[2] * sa];
      const r = rad[i] * (o.rmod ? o.rmod(i, a) : 1), p = madd(pts[i], d, r);
      mb.vert(p, d, (k / sides) * o.uRep, vAcc / o.vLen, o.col(p, i), o.sw(p));
    }
  }
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < sides; k++) {
    const a = base + i * (sides + 1) + k, b = a + sides + 1;
    mb.I.push(a, a + 1, b, a + 1, b + 1, b);
  }
}

/**
 * Alpha card: base centre O, length axis A (unit), side axis S (unit), length
 * L, width W, atlas rect [u0, vTop, u1, vBase]. o: { segs, bend (offset at the
 * tip, quadratic), col(p, t), nrm(p), sw(p) }.
 */
function card(mb, O, A, S, L, W, rect, o) {
  const segs = o.segs || 1, base = mb.count, bend = o.bend;
  const fn = norm(cross(S, A));
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    let c = madd(O, A, L * t);
    if (bend) c = madd(c, bend, t * t);
    for (let j = 0; j < 2; j++) {
      const p = madd(c, S, (j - 0.5) * W);
      mb.vert(p, o.nrm ? o.nrm(p) : fn, j ? rect[2] : rect[0], rect[3] + (rect[1] - rect[3]) * t, o.col(p, t), o.sw(p));
    }
  }
  for (let i = 0; i < segs; i++) { const a = base + i * 2; mb.I.push(a, a + 1, a + 3, a, a + 3, a + 2); }
}

/** Polyline helpers: point and tangent at fraction f of the total length. */
function along(pts, f) {
  let tot = 0; const seg = [];
  for (let i = 1; i < pts.length; i++) { const l = len(sub(pts[i], pts[i - 1])); seg.push(l); tot += l; }
  let d = f * tot;
  for (let i = 0; i < seg.length; i++) {
    if (d <= seg[i] || i === seg.length - 1) {
      const t = seg[i] > 0 ? clamp(d / seg[i], 0, 1) : 0;
      return { p: madd(pts[i], sub(pts[i + 1], pts[i]), t), t: norm(sub(pts[i + 1], pts[i])), i, k: t };
    }
    d -= seg[i];
  }
  return { p: pts[pts.length - 1], t: [0, 1, 0], i: pts.length - 2, k: 1 };
}

// ───────────────────────── textures ─────────────────────────
const AW = 1024, AH = 1024;
const TILE = {
  fir: [0, 0, 256, 512], pine: [256, 0, 256, 512], twig: [512, 0, 256, 512], twigLeaf: [768, 0, 256, 512],
  leaves: [0, 512, 256, 512], grass: [256, 512, 256, 512], fern: [512, 512, 256, 512], weed: [768, 512, 256, 256], litter: [768, 768, 256, 256],
};
/** Atlas rects as [u0, vTop, u1, vBase] (DataTexture rows: canvas top row is v = 0). */
const RECT = {};
for (const k in TILE) { const [x, y, w, h] = TILE[k]; RECT[k] = [(x + 2) / AW, (y + 2) / AH, (x + w - 2) / AW, (y + h - 2) / AH]; }

const rgb = (r, g, b) => `rgb(${r | 0},${g | 0},${b | 0})`;

function leafPath(g, x, y, ang, L, W, lobes) {
  const ca = Math.cos(ang), sa = Math.sin(ang), N = 10;
  g.beginPath(); g.moveTo(x, y);
  for (let s = -1; s <= 1; s += 2) {
    for (let i = s < 0 ? 1 : N - 1; s < 0 ? i <= N : i >= 0; i += s < 0 ? 1 : -1) {
      const t = i / N;
      let hw = W * 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.08)), 0.75);
      if (lobes) hw *= 0.72 + 0.28 * Math.abs(Math.cos(t * Math.PI * lobes));
      const lx = t * L, ly = hw * s;
      g.lineTo(x + lx * ca - ly * sa, y + lx * sa + ly * ca);
    }
  }
  g.closePath();
}

function clipTile(g, t) { g.save(); g.beginPath(); g.rect(t[0] + 2, t[1] + 2, t[2] - 4, t[3] - 4); g.clip(); }

/** Fir spray: flat twig with two-ranked needles, base at the tile bottom. */
function paintFir(g, t, R) {
  clipTile(g, t);
  const [x0, y0, w, h] = t, cx = x0 + w / 2, by = y0 + h - 8, ty = y0 + 14;
  const axis = (f) => [cx + Math.sin(f * 2.4) * 7, by + (ty - by) * f];
  const shoots = [];
  for (let f = 0.03; f < 0.96; f += 0.05 + R() * 0.022) for (const sd of [-1, 1]) {
    const [ax, ay] = axis(f);
    const Lm = w * 0.47 * Math.pow(1 - f, 0.55) * (0.72 + R() * 0.38) * Math.min(1, 0.35 + f * 5);
    const a = -Math.PI / 2 + sd * (0.85 + R() * 0.3);
    shoots.push([ax, ay, a, Lm, f]);
    if (Lm > 46) { const f2 = 0.45 + R() * 0.2, bx = ax + Math.cos(a) * Lm * f2, byy = ay + Math.sin(a) * Lm * f2; shoots.push([bx, byy, a + sd * (0.7 + R() * 0.3), Lm * 0.42, f]); }
  }
  shoots.push([cx, by, -Math.PI / 2, by - ty, 0]);
  for (let pass = 0; pass < 2; pass++) {
    for (const [sx, sy, a, Lm, f] of shoots) {
      const ca = Math.cos(a), sa = Math.sin(a), step = 3.1;
      for (let d = 2; d < Lm; d += step) {
        const q = d / Lm, px = sx + ca * d, py = sy + sa * d;
        for (const sd of [-1, 1]) {
          if (pass === 1 && R() < 0.35) continue;
          const na = a + sd * (1.05 + R() * 0.35) * (1 - q * 0.25), nl = (pass ? 8 : 10.5) * (0.85 + R() * 0.35) * (1 - q * 0.3);
          const lt = pass ? 0.35 + 0.65 * q * (0.6 + f * 0.4) + R() * 0.15 : R() * 0.2;
          g.strokeStyle = pass ? rgb(30 + 38 * lt, 50 + 46 * lt, 32 + 20 * lt) : rgb(14 + R() * 8, 26 + R() * 10, 18 + R() * 6);
          g.lineWidth = pass ? 1.9 : 2.7;
          g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl); g.stroke();
        }
      }
    }
    if (pass === 0) { g.strokeStyle = rgb(62, 48, 34); for (const [sx, sy, a, Lm] of shoots) { g.lineWidth = Lm > 100 ? 3 : 1.6; g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + Math.cos(a) * Lm * 0.9, sy + Math.sin(a) * Lm * 0.9); g.stroke(); } }
  }
  g.restore();
}

/** Pine tuft: twig ending in brushes of long needles. */
function paintPine(g, t, R) {
  clipTile(g, t);
  const [x0, y0, w, h] = t, cx = x0 + w / 2, by = y0 + h - 6;
  const pts = []; let x = cx, y = by;
  for (let i = 0; i <= 20; i++) { pts.push([x, y]); x += (R() - 0.5) * 5; y -= h * 0.042; }
  g.strokeStyle = rgb(78, 56, 38); g.lineWidth = 5; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts) g.lineTo(p[0], p[1]); g.stroke();
  for (let pass = 0; pass < 2; pass++) for (let i = 5; i <= 20; i++) {
    const [px, py] = pts[i], f = i / 20, n = 10 + f * 16;
    for (let k = 0; k < n; k++) {
      const a = -Math.PI / 2 + (R() - 0.5) * (2.3 - f * 0.6), L = (40 + R() * 46) * (0.7 + f * 0.35);
      const cx2 = px + Math.cos(a) * L * 0.5 + (R() - 0.5) * 8, cy2 = py + Math.sin(a) * L * 0.5;
      const lt = pass ? 0.3 + R() * 0.5 + f * 0.25 : R() * 0.2;
      g.strokeStyle = pass ? rgb(34 + 40 * lt, 52 + 42 * lt, 28 + 16 * lt) : rgb(16, 28, 18);
      g.lineWidth = pass ? 1.5 : 2.4;
      g.beginPath(); g.moveTo(px, py); g.quadraticCurveTo(cx2, cy2, px + Math.cos(a) * L, py + Math.sin(a) * L + L * 0.08); g.stroke();
    }
  }
  g.restore();
}

/** Fractal twig spray; leafy = dry hornbeam / oak leaves clinging on. */
function paintTwig(g, t, R, leafy) {
  clipTile(g, t);
  const [x0, y0, w, h] = t, leaves = [];
  const br = (x, y, a, L, wd, depth) => {
    const x2 = x + Math.cos(a) * L, y2 = y + Math.sin(a) * L;
    g.strokeStyle = rgb(70 + depth * 4 + R() * 14, 62 + depth * 4 + R() * 10, 54 + depth * 3 + R() * 8); g.lineWidth = wd;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo((x + x2) / 2 + (R() - 0.5) * L * 0.25, (y + y2) / 2 + (R() - 0.5) * L * 0.2, x2, y2); g.stroke();
    if (depth === 0) { if (leafy && R() < 0.75) leaves.push([x2, y2, a]); return; }
    const n = 2 + (R() < 0.45 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const f = i === n - 1 ? 1 : 0.35 + R() * 0.55, bx = x + (x2 - x) * f, byy = y + (y2 - y) * f;
      br(bx, byy, a + (i === n - 1 ? (R() - 0.5) * 0.4 : (R() < 0.5 ? -1 : 1) * (0.35 + R() * 0.45)), L * (0.62 + R() * 0.16), Math.max(1.4, wd * 0.7), depth - 1);
    }
  };
  br(x0 + w / 2, y0 + h - 6, -Math.PI / 2 + (R() - 0.5) * 0.2, h * 0.27, 6, 6);
  br(x0 + w / 2, y0 + h * 0.7, -Math.PI / 2 - 0.5, h * 0.2, 3.5, 5);
  br(x0 + w / 2, y0 + h * 0.6, -Math.PI / 2 + 0.5, h * 0.2, 3.5, 5);
  const LC = [[120, 74, 38], [138, 92, 48], [96, 60, 32], [150, 108, 60], [84, 52, 30], [112, 82, 52]];
  for (const [x, y, a] of leaves) {
    const n = 1 + (R() * 2.6 | 0);
    for (let i = 0; i < n; i++) {
      const c = LC[(R() * LC.length) | 0], L = 30 + R() * 16, la = a + (R() - 0.5) * 2.2 + 0.6;
      g.fillStyle = rgb(c[0] * (0.8 + R() * 0.3), c[1] * (0.8 + R() * 0.3), c[2] * (0.8 + R() * 0.3));
      leafPath(g, x, y, la, L, L * (0.42 + R() * 0.15), R() < 0.5 ? 4 + (R() * 2 | 0) : 0); g.fill();
      g.strokeStyle = 'rgba(40,25,15,0.45)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(la) * L * 0.9, y + Math.sin(la) * L * 0.9); g.stroke();
    }
  }
  g.restore();
}

/** Dense scrub leaf cluster: bramble greens, a few reds and dry browns. */
function paintLeaves(g, t, R) {
  clipTile(g, t);
  const [x0, y0, w, h] = t, cx = x0 + w / 2, cy = y0 + h * 0.52;
  g.strokeStyle = rgb(52, 40, 32);
  for (let i = 0; i < 9; i++) { g.lineWidth = 2 + R() * 2; g.beginPath(); g.moveTo(cx + (R() - 0.5) * 30, y0 + h - 4); g.quadraticCurveTo(cx + (R() - 0.5) * w * 0.6, cy, cx + (R() - 0.5) * w * 0.9, y0 + h * (0.1 + R() * 0.3)); g.stroke(); }
  const G = [[30, 46, 28], [40, 58, 32], [26, 38, 24], [48, 62, 36], [36, 52, 34]], O = [[74, 40, 36], [112, 72, 38], [132, 92, 50], [92, 64, 36]];
  for (let i = 0; i < 560; i++) {
    const r = Math.pow(R(), 0.62), a = R() * TAU, x = cx + Math.cos(a) * r * w * 0.47, y = cy + Math.sin(a) * r * h * 0.47;
    const deep = i < 220, c = R() < 0.74 ? G[(R() * G.length) | 0] : O[(R() * O.length) | 0], k = deep ? 0.55 + R() * 0.2 : 0.85 + R() * 0.35;
    const L = 22 + R() * 18;
    g.fillStyle = rgb(c[0] * k, c[1] * k, c[2] * k);
    leafPath(g, x, y, R() * TAU, L, L * (0.48 + R() * 0.12), 0); g.fill();
    if (!deep) { g.strokeStyle = `rgba(${c[0] + 40},${c[1] + 40},${c[2] + 30},0.35)`; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (R() - 0.5) * 10, y + (R() - 0.5) * 10); g.stroke(); }
  }
  g.restore();
}

/** Dry autumn grass tuft, blades rising from the tile bottom. */
function paintGrass(g, t, R) {
  clipTile(g, t);
  const [x0, y0, w, h] = t, cx = x0 + w / 2, by = y0 + h - 2;
  const C = [[150, 136, 96], [124, 110, 76], [100, 92, 64], [84, 92, 62], [168, 150, 108], [70, 64, 46]];
  for (let i = 0; i < 90; i++) {
    const bx = cx + (R() - 0.5) * w * 0.45, tx = bx + (R() - 0.5) * w * 0.85, ty = by - h * (0.35 + R() * 0.6), bw = 2 + R() * 2.6;
    const mx = (bx + tx) / 2 + (R() - 0.5) * 30, my = (by + ty) / 2;
    const c = C[i < 25 ? 5 : (R() * 5) | 0], k = 0.8 + R() * 0.35;
    g.fillStyle = rgb(c[0] * k, c[1] * k, c[2] * k);
    g.beginPath(); g.moveTo(bx - bw, by); g.quadraticCurveTo(mx, my, tx, ty); g.quadraticCurveTo(mx + bw, my, bx + bw, by); g.closePath(); g.fill();
  }
  g.restore();
}

/** Bracken frond, rusty November colours. */
function paintFern(g, t, R) {
  clipTile(g, t);
  const [x0, y0, w, h] = t, cx = x0 + w / 2, by = y0 + h - 4;
  const C = [[140, 74, 36], [112, 60, 30], [160, 98, 48], [124, 84, 44], [96, 70, 40]];
  const ax = (f) => [cx + Math.sin(f * 2) * 10, by - f * (h - 16)];
  g.strokeStyle = rgb(92, 62, 36); g.lineWidth = 3.5; g.beginPath();
  for (let f = 0; f <= 1.001; f += 0.05) { const p = ax(f); f === 0 ? g.moveTo(p[0], p[1]) : g.lineTo(p[0], p[1]); } g.stroke();
  for (let f = 0.14, sd = 1; f < 0.97; f += 0.055, sd = -sd) {
    const [px, py] = ax(f), L = w * 0.47 * Math.sin(Math.PI * Math.min(1, (1 - f) * 1.15)) * (0.85 + R() * 0.2) + 8;
    const a = -Math.PI / 2 + sd * (1.05 + R() * 0.2), ca = Math.cos(a), sa = Math.sin(a), c = C[(R() * C.length) | 0];
    g.strokeStyle = rgb(c[0] * 0.7, c[1] * 0.7, c[2] * 0.7); g.lineWidth = 1.6; g.beginPath(); g.moveTo(px, py); g.lineTo(px + ca * L, py + sa * L); g.stroke();
    for (let d = 4; d < L; d += 5.2) {
      const q = d / L, pl = (11 - q * 7) * (0.9 + R() * 0.2), k = 0.8 + R() * 0.35;
      for (const s2 of [-1, 1]) {
        g.fillStyle = rgb(c[0] * k, c[1] * k, c[2] * k);
        leafPath(g, px + ca * d, py + sa * d, a + s2 * 1.2 - sd * 0.3, pl, pl * 0.6, 0); g.fill();
      }
    }
  }
  g.restore();
}

/** Dead weed stalks with seed heads. */
function paintWeed(g, t, R) {
  clipTile(g, t);
  const [x0, y0, w, h] = t, cx = x0 + w / 2, by = y0 + h - 2;
  for (let i = 0; i < 9; i++) {
    const bx = cx + (R() - 0.5) * 50, tx = bx + (R() - 0.5) * 110, ty = y0 + 10 + R() * h * 0.45, c = 60 + R() * 40;
    g.strokeStyle = rgb(c * 1.1, c * 0.9, c * 0.65); g.lineWidth = 1.4 + R(); g.beginPath(); g.moveTo(bx, by); g.quadraticCurveTo((bx + tx) / 2 + (R() - 0.5) * 30, (by + ty) / 2, tx, ty); g.stroke();
    const umb = R() < 0.5;
    for (let k = 0; k < (umb ? 9 : 5); k++) {
      const a = -Math.PI / 2 + (R() - 0.5) * (umb ? 2.4 : 1.2), L = umb ? 14 + R() * 8 : 6 + R() * 10, ex = tx + Math.cos(a) * L, ey = ty + Math.sin(a) * L;
      g.lineWidth = 1; g.beginPath(); g.moveTo(tx, ty); g.lineTo(ex, ey); g.stroke();
      g.fillStyle = rgb(c * 0.8, c * 0.6, c * 0.4); g.beginPath(); g.arc(ex, ey, umb ? 2.2 : 3.4, 0, TAU); g.fill();
    }
  }
  g.restore();
}

/** Leaf litter patch (lies flat on the ground). */
function paintLitter(g, t, R) {
  clipTile(g, t);
  const [x0, y0, w, h] = t, cx = x0 + w / 2, cy = y0 + h / 2;
  const C = [[92, 58, 32], [120, 78, 40], [70, 46, 28], [140, 100, 56], [60, 44, 32], [104, 84, 56], [84, 70, 50]];
  for (let i = 0; i < 10; i++) { g.strokeStyle = rgb(60, 48, 38); g.lineWidth = 1.2 + R(); const a = R() * TAU, r = R() * 70; g.beginPath(); g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); g.lineTo(cx + Math.cos(a) * r + (R() - 0.5) * 70, cy + Math.sin(a) * r + (R() - 0.5) * 70); g.stroke(); }
  for (let i = 0; i < 230; i++) {
    const r = Math.pow(R(), 0.8) * w * 0.47, a = R() * TAU, c = C[(R() * C.length) | 0], k = 0.75 + R() * 0.4, L = 13 + R() * 12;
    g.fillStyle = rgb(c[0] * k, c[1] * k, c[2] * k);
    leafPath(g, cx + Math.cos(a) * r, cy + Math.sin(a) * r, R() * TAU, L, L * (0.45 + R() * 0.2), R() < 0.4 ? 4 : 0); g.fill();
  }
  g.restore();
}

/** Foliage atlas → DataTexture. Transparent texels get the tile's mean colour so mips don't fringe dark. */
function buildAtlas() {
  const cv = document.createElement('canvas'); cv.width = AW; cv.height = AH;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.lineCap = 'round';
  const R = rng(9001);
  paintFir(g, TILE.fir, R); paintPine(g, TILE.pine, R); paintTwig(g, TILE.twig, R, false); paintTwig(g, TILE.twigLeaf, R, true);
  paintLeaves(g, TILE.leaves, R); paintGrass(g, TILE.grass, R); paintFern(g, TILE.fern, R); paintWeed(g, TILE.weed, R); paintLitter(g, TILE.litter, R);
  const img = g.getImageData(0, 0, AW, AH), d = img.data;
  for (const k in TILE) {
    const [x0, y0, w, h] = TILE[k]; let r = 0, gg = 0, b = 0, n = 0;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * AW + x) * 4; if (d[i + 3] > 128) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; } }
    if (!n) continue; r /= n; gg /= n; b /= n;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * AW + x) * 4; if (d[i + 3] < 10) { d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 0; } }
  }
  const tex = new THREE.DataTexture(new Uint8Array(d.buffer), AW, AH, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4; tex.needsUpdate = true;
  return tex;
}

/** Height field → tangent-space normal map bytes (OpenGL convention, rows = +v). */
function normalBytes(hf, W, H, k) {
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const hl = hf[y * W + ((x + W - 1) % W)], hr = hf[y * W + ((x + 1) % W)], hd = hf[((y + H - 1) % H) * W + x], hu = hf[((y + 1) % H) * W + x];
    const nx = -(hr - hl) * k, ny = -(hu - hd) * k, l = Math.hypot(nx, ny, 1), i = (y * W + x) * 4;
    out[i] = (nx / l * 0.5 + 0.5) * 255; out[i + 1] = (ny / l * 0.5 + 0.5) * 255; out[i + 2] = (1 / l * 0.5 + 0.5) * 255; out[i + 3] = 255;
  }
  return out;
}
function dataTex(bytes, W, H, srgb) {
  const t = new THREE.DataTexture(bytes, W, H, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
  return t;
}

/** Furrowed bark with lichen blotches (neutral; vertex colours give the species hue). One tile ≈ 0.7 m × 1.4 m. */
function buildBark() {
  const W = 256, H = 512, hf = new Float32Array(W * H), col = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H;
    const warp = tfbm(u * 4, v * 2, 4, 2, 2, 1);
    const n = tfbm(u * 7 + warp * 2.2, v * 2, 7, 2, 4, 3);
    const r = 1 - Math.abs(2 * n - 1), furrow = sstep(0.72, 0.97, r);
    const crack = sstep(0.16, 0.05, tvn(u * 9, v * 30, 9, 30, 9)) * (1 - furrow);
    const fine = tfbm(u * 32, v * 32, 32, 32, 2, 13);
    let h = (1 - furrow * 0.85) * (0.82 + 0.18 * tfbm(u * 8, v * 8, 8, 8, 2, 17)) - crack * 0.4 + (fine - 0.5) * 0.12;
    hf[y * W + x] = h;
    const s = clamp(h, 0, 1);
    let cr = mix(0.13, 0.6, s), cg = mix(0.11, 0.55, s), cb = mix(0.1, 0.5, s);
    const li = sstep(0.6, 0.7, tfbm(u * 3, v * 3, 3, 3, 3, 21)) * s * 0.75;
    cr = mix(cr, 0.64, li); cg = mix(cg, 0.68, li); cb = mix(cb, 0.58, li);
    const g = 0.92 + fine * 0.16, i = (y * W + x) * 4;
    col[i] = clamp(cr * g, 0, 1) * 255; col[i + 1] = clamp(cg * g, 0, 1) * 255; col[i + 2] = clamp(cb * g, 0, 1) * 255; col[i + 3] = 255;
  }
  return { map: dataTex(col, W, H, true), normal: dataTex(normalBytes(hf, W, H, 5), W, H, false) };
}

/** Limestone: mottled pale grey, cracks, pits, lichen; alpha = moss mask. One tile ≈ 1.6 m (triplanar). */
function buildRockTex() {
  const W = 256, H = 256, hf = new Float32Array(W * H), col = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H;
    const m = tfbm(u * 4, v * 4, 4, 4, 4, 41), w = tfbm(u * 3, v * 3, 3, 3, 2, 45);
    const cl = 1 - Math.abs(2 * tfbm(u * 5 + w * 2, v * 5 - w * 2, 5, 5, 3, 47) - 1), crack = sstep(0.935, 0.99, cl);
    const det = tfbm(u * 16, v * 16, 16, 16, 3, 51), pit = sstep(0.34, 0.2, tvn(u * 40, v * 40, 40, 40, 55));
    const h = m * 0.5 + det * 0.5 - crack * 0.55 - pit * 0.2;
    hf[y * W + x] = h;
    let k = 0.72 + (m - 0.5) * 0.7 + (det - 0.5) * 0.35;
    let cr = 0.66 * k, cg = 0.64 * k, cb = 0.59 * k;
    const dark = Math.max(crack * 0.7, pit * 0.45);
    cr = mix(cr, 0.2, dark); cg = mix(cg, 0.19, dark); cb = mix(cb, 0.17, dark);
    const li = sstep(0.64, 0.7, tfbm(u * 6, v * 6, 6, 6, 3, 57)) * (1 - dark);
    cr = mix(cr, 0.78, li * 0.6); cg = mix(cg, 0.8, li * 0.6); cb = mix(cb, 0.72, li * 0.6);
    if (hash2(x + 911, y * 3 + 17) < 0.035) { cr *= 0.6; cg *= 0.6; cb *= 0.6; }
    const i = (y * W + x) * 4;
    col[i] = clamp(cr, 0, 1) * 255; col[i + 1] = clamp(cg, 0, 1) * 255; col[i + 2] = clamp(cb, 0, 1) * 255;
    col[i + 3] = tfbm(u * 2, v * 2, 2, 2, 3, 61) * 255;
  }
  return { map: dataTex(col, W, H, true), normal: dataTex(normalBytes(hf, W, H, 6), W, H, false) };
}

// ───────────────────────── materials ─────────────────────────
const U = { time: { value: 0 }, wind: { value: new THREE.Vector2(0.09, 0.05) }, fade: { value: 40 }, texSize: { value: new THREE.Vector2(AW, AH) } };

const WIND_VS = /* glsl */ `
{
  #ifdef USE_BATCHING
    vec3 nIP = batchingMatrix[3].xyz; mat3 nIR = mat3(batchingMatrix);
  #else
    vec3 nIP = vec3(0.0); mat3 nIR = mat3(1.0);
  #endif
  float nPh = dot(nIP.xz, vec2(0.21, 0.17));
  float nG = sin(uTime * 0.83 + nPh) * 0.55 + sin(uTime * 1.97 + nPh * 1.7) * 0.25 + 0.4;
  float nFl = sin(uTime * 6.3 + dot(position, vec3(3.1, 2.3, 2.7))) * 0.22 * sway;
  vec3 nW = vec3(uWind.x, 0.0, uWind.y) * sway * (nG + nFl);
  nW.y = nFl * sway * 0.05;
  transformed += (transpose(nIR) * nW) / max(1e-4, dot(nIR[0], nIR[0]));
  #ifdef NATURE_FADE
    float nFd = 1.0 - smoothstep(uFade * 0.72, uFade, distance(nIP, cameraPosition));
    transformed *= nFd;
  #endif
}
`;

function natureMat(kind, o, rockT) {
  const m = new THREE.MeshStandardMaterial(o);
  m.envMapIntensity = kind === 'rock' ? 0.5 : 0.3;
  const fade = kind === 'ground';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.time; sh.uniforms.uWind = U.wind; sh.uniforms.uFade = U.fade; sh.uniforms.uTexSize = U.texSize;
    let vs = sh.vertexShader.replace('#include <common>', `#include <common>
attribute float sway;
uniform float uTime; uniform vec2 uWind; uniform float uFade;
varying vec3 vNatP; varying vec3 vNatN; varying float vNatY;
${fade ? '#define NATURE_FADE' : ''}`);
    vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>
${kind === 'rock' ? '' : WIND_VS}
{
  #ifdef USE_BATCHING
    mat4 nBM = batchingMatrix;
  #else
    mat4 nBM = mat4(1.0);
  #endif
  vNatP = (modelMatrix * nBM * vec4(transformed, 1.0)).xyz;
  vNatN = normalize(mat3(modelMatrix) * mat3(nBM) * normal);
  vNatY = transformed.y;
}`);
    sh.vertexShader = vs;
    let fs = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform vec2 uTexSize; uniform sampler2D tRockA; uniform sampler2D tRockN;
varying vec3 vNatP; varying vec3 vNatN; varying float vNatY;`);
    if (kind === 'leaf' || kind === 'ground') {
      // keep bent foliage normals on back faces; keep alpha-tested coverage in the mips
      fs = fs.replace('normal *= faceDirection;', '');
      fs = fs.replace('#include <alphatest_fragment>', `
#ifdef USE_MAP
  { vec2 nDx = dFdx(vMapUv * uTexSize), nDy = dFdy(vMapUv * uTexSize);
    float nMip = max(0.0, 0.5 * log2(max(dot(nDx, nDx), dot(nDy, nDy))));
    diffuseColor.a *= 1.0 + nMip * 0.3; }
#endif
#include <alphatest_fragment>`);
    }
    if (kind === 'rock') {
      sh.uniforms.tRockA = { value: rockT.map }; sh.uniforms.tRockN = { value: rockT.normal };
      fs = fs.replace('#include <map_fragment>', `
vec3 nN = normalize(vNatN);
vec3 nTw = pow(abs(nN), vec3(4.0)); nTw /= (nTw.x + nTw.y + nTw.z);
vec3 nTp = vNatP * 0.62;
vec4 nAx = texture2D(tRockA, nTp.zy), nAy = texture2D(tRockA, nTp.xz), nAz = texture2D(tRockA, nTp.xy);
vec4 nAlb = nAx * nTw.x + nAy * nTw.y + nAz * nTw.z;
float nMac = texture2D(tRockA, nTp.xz * 0.13 + nTp.y * 0.05).a;
float nMoss = smoothstep(0.42, 0.8, nN.y + (nAlb.a - 0.5) * 0.9 + (nMac - 0.5) * 0.5);
vec3 nCol = nAlb.rgb * (0.85 + nMac * 0.3);
nCol = mix(nCol, vec3(0.16, 0.2, 0.09) * (0.75 + nAlb.a * 0.6), nMoss * 0.85);
nCol = mix(nCol, nCol * vec3(0.5, 0.45, 0.38), 1.0 - smoothstep(-0.05, 0.22, vNatY));
diffuseColor.rgb *= nCol;`);
      fs = fs.replace('#include <normal_fragment_maps>', `
{
  vec3 nx = texture2D(tRockN, nTp.zy).xyz * 2.0 - 1.0, ny = texture2D(tRockN, nTp.xz).xyz * 2.0 - 1.0, nz = texture2D(tRockN, nTp.xy).xyz * 2.0 - 1.0;
  nx = vec3(nx.xy + nN.zy, abs(nx.z) * nN.x);
  ny = vec3(ny.xy + nN.xz, abs(ny.z) * nN.y);
  nz = vec3(nz.xy + nN.xy, abs(nz.z) * nN.z);
  vec3 nWn = normalize(nx.zyx * nTw.x + ny.xzy * nTw.y + nz.xyz * nTw.z);
  nWn = normalize(mix(nN, nWn, 1.0 - nMoss * 0.6));
  normal = normalize((viewMatrix * vec4(nWn, 0.0)).xyz);
}`);
      fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 1.0, nMoss);');
    }
    sh.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => 'nature-' + kind;
  return m;
}

// ───────────────────────── conifers ─────────────────────────
const CONIFERS = [
  { name: 'fir', H: 12.5, cb: 1.7, spacing: 0.64, per: [4, 2], rise: 0.12, droop: 0.42, len: (t) => 0.35 + 3.0 * Math.pow(1 - t, 0.95), gap: 0.08, tile: 'fir', bark: [0.62, 0.58, 0.54], tint: [0.92, 1.0, 0.94], seed: 11 },
  { name: 'fir-slender', H: 13.5, cb: 2.4, spacing: 0.6, per: [4, 2], rise: 0.08, droop: 0.5, len: (t) => 0.3 + 2.3 * Math.pow(1 - t, 0.85), gap: 0.12, tile: 'fir', bark: [0.58, 0.55, 0.52], tint: [0.88, 0.96, 0.92], seed: 23 },
  { name: 'pine', H: 14, cb: 6.8, spacing: 0.75, per: [3, 3], rise: 0.32, droop: 0.22, len: (t) => 0.7 + 3.3 * Math.sin(Math.PI * (0.18 + 0.72 * (1 - t))), gap: 0.15, tile: 'pine', bark: [0.82, 0.55, 0.38], tint: [1.04, 1.04, 0.86], seed: 37, pine: true },
  { name: 'fir-young', H: 9.5, cb: 1.1, spacing: 0.6, per: [4, 2], rise: 0.16, droop: 0.36, len: (t) => 0.4 + 2.5 * Math.pow(1 - t, 1.0), gap: 0.22, tile: 'fir', bark: [0.6, 0.56, 0.5], tint: [0.95, 1.02, 0.9], seed: 51 },
];

/** Trunk radius ≈ 0.23 at chest height (collider half-width 0.22 · s), root flare and buttresses at the base. */
function trunkTube(mb, R, H, top, sides, bark, swf, radAt) {
  const ph = R() * TAU, wx = (R() - 0.5) * 0.25, wz = (R() - 0.5) * 0.25;
  const ys = [-0.8, -0.35, -0.05, 0.2, 0.5, 0.9, 1.5];
  for (let y = 2.4; y < top - 0.3; y += 1.1) ys.push(y);
  ys.push(top);
  const axis = (y) => [wx * Math.sin(y * 0.4) * (y / H), y, wz * Math.sin(y * 0.33 + 1) * (y / H)];
  const pts = ys.map(axis), rad = ys.map((y) => radAt(y) * (1 + 0.85 * Math.exp(-Math.max(0, y + 0.05) / 0.32)));
  tube(mb, pts, rad, sides, {
    uRep: Math.max(1, Math.round((TAU * 0.25) / 0.7)), vLen: 1.4,
    rmod: (i, a) => 1 + 0.38 * Math.exp(-Math.max(0, ys[i]) / 0.3) * Math.pow(Math.max(0, Math.cos(a * 5 + ph)), 3),
    col: (p) => bark(p), sw: swf,
  });
  return axis;
}

function buildConifer(cfg, lod) {
  const R = rng(cfg.seed), wood = new MB(), leaf = new MB();
  const H = cfg.H, cb = cfg.cb, r13 = 0.235;
  const radAt = (y) => Math.max(0.025, r13 * Math.pow(Math.max(0.02, 1 - y / H), 0.8) / Math.pow(1 - 1.3 / H, 0.8));
  const sw = (p) => { const rr = Math.hypot(p[0], p[2]); return Math.pow(clamp(p[1] / H, 0, 1), 1.6) * 0.45 + Math.pow(clamp(rr / 3.2, 0, 1), 1.5) * 0.7; };
  const barkCol = (p) => {
    const b = cfg.bark, up = cfg.pine ? sstep(3, 8, p[1]) : 0, moss = (1 - sstep(0.2, 1.6, p[1])) * 0.35;
    return [mix(b[0] * 0.72, b[0] * 1.15, up) * (1 - moss * 0.4), mix(b[1] * 0.75, b[1] * 0.95, up) * (1 - moss * 0.1), mix(b[2] * 0.78, b[2] * 0.8, up) * (1 - moss * 0.5)];
  };
  const axis = trunkTube(wood, R, H, H - 0.2, lod ? 7 : 11, barkCol, sw, radAt);
  const tint = cfg.tint, reach = (y) => cfg.len(clamp((y - cb) / (H - cb), 0, 1)) + 0.35;
  const leafCol = (p) => {
    const a = axis(p[1]), rr = Math.hypot(p[0] - a[0], p[2] - a[2]), t = clamp(p[1] / H, 0, 1);
    const ao = (0.3 + 0.7 * sstep(0.02, 0.95, rr / reach(p[1]))) * (0.62 + 0.38 * t);
    return [tint[0] * ao, tint[1] * ao, tint[2] * ao];
  };
  const leafN = (p) => {
    const a = axis(p[1]), rx = p[0] - a[0], rz = p[2] - a[2], rr = Math.hypot(rx, rz), k = Math.min(1, rr / 0.4) / Math.max(rr, 1e-3);
    return norm([rx * k * 0.85, 0.55 + 0.2 * clamp(p[1] / H, 0, 1), rz * k * 0.85]);
  };
  const rect = RECT[cfg.tile];
  const spray = (O, A, L, W, roll, bendDown) => {
    const Sh = norm(cross(A, UP)), S = norm(rot(Sh, A, roll));
    card(leaf, O, A, S, L, W, rect, { segs: 2, bend: [0, -bendDown, 0], col: leafCol, nrm: leafN, sw });
  };
  // dead stubs below the crown
  for (let y = 1.2; y < cb - 0.2; y += 0.4 + R() * 0.5) {
    if (lod) break;
    const a = R() * TAU, d = [Math.cos(a), -0.1 - R() * 0.3, Math.sin(a)], L = 0.25 + R() * (cfg.pine ? 0.4 : 0.9), p0 = madd(axis(y), d, radAt(y) * 0.7);
    tube(wood, [p0, madd(p0, d, L)], [0.022, 0.006], 3, { uRep: 1, vLen: 1.4, col: () => [0.32, 0.29, 0.26], sw });
  }
  // whorls
  let y = cb;
  while (y < H - 0.5) {
    const t = (y - cb) / (H - cb), n = cfg.per[0] + ((R() * cfg.per[1]) | 0), a0 = R() * TAU;
    for (let j = 0; j < n; j++) {
      if (R() < cfg.gap) continue;
      const az = a0 + (j * TAU) / n + (R() - 0.5) * 0.7, L = cfg.len(t) * (0.8 + R() * 0.4);
      const dir = [Math.cos(az), 0, Math.sin(az)], side = [-dir[2], 0, dir[0]], droop = cfg.droop * (1 - t * 0.55), curl = (R() - 0.5) * 0.4;
      const o = axis(y), pts = [];
      for (const f of [0, 0.34, 0.68, 1]) {
        const dd = radAt(y) * 0.6 + f * L;
        const yy = y + L * (cfg.rise * f - droop * f * f) + (f === 1 ? L * 0.06 : 0);
        pts.push([o[0] + dir[0] * dd + side[0] * curl * f * f * L * 0.3, yy, o[2] + dir[2] * dd + side[2] * curl * f * f * L * 0.3]);
      }
      if (!lod) tube(wood, pts, [0.02 + 0.022 * L, 0.014 + 0.012 * L, 0.009, 0.004], 3, { uRep: 1, vLen: 1.4, col: barkCol, sw });
      const sL = Math.min(1.05, 0.5 + 0.22 * L) * (0.9 + R() * 0.2);
      if (cfg.pine) {
        // tufts at the outer half of the branch
        const nt = lod ? Math.max(1, Math.round(L / 1.2)) : Math.max(2, Math.round(L / 0.42));
        for (let k = 0; k < nt; k++) {
          const at = along(pts, 1 - (k / nt) * 0.6), A = norm(add(mul(at.t, 0.7), [(R() - 0.5) * 0.4, 0.75, (R() - 0.5) * 0.4])), Ls = (lod ? 1.9 : 1.45) * (0.8 + R() * 0.3);
          for (let c = 0; c < (lod ? 2 : 3); c++) spray(madd(at.p, A, -Ls * 0.4), A, Ls, Ls * 0.55, (c * Math.PI) / (lod ? 2 : 3) + R() * 0.5, 0.15);
        }
        continue;
      }
      const ns = Math.max(1, Math.round(L / (lod ? 0.9 : 0.5)));
      for (let k = 0; k < ns; k++) {
        const f = 0.15 + 0.85 * ((k + 0.5 + (R() - 0.5) * 0.3) / ns), at = along(pts, Math.min(1, f));
        const A = norm([at.t[0] + (R() - 0.5) * 0.25, at.t[1] * 0.5 - 0.05, at.t[2] + (R() - 0.5) * 0.25]);
        const Ls = sL * (lod ? 1.5 : 1) * (1 - f * 0.25), Ws = Ls * 0.5 * (lod ? 1.35 : 1);
        const O = madd(at.p, A, -Ls * 0.3);
        spray(O, A, Ls, Ws, 0.55 + R() * 0.35, 0.12 + 0.15 * f);
        spray(O, A, Ls, Ws, -0.55 - R() * 0.35, 0.12 + 0.15 * f);
        if (!lod && L > 0.7 && f < 0.9) for (const sd of [-1, 1]) {
          if (R() < 0.2) continue;
          // side shoots hanging off the branch: give each shelf some depth
          const A2 = norm(rot([A[0], A[1] - 0.35 - R() * 0.3, A[2]], UP, sd * (0.55 + R() * 0.4)));
          spray(madd(at.p, A2, -0.05), A2, Ls * 0.8, Ls * 0.42, sd * (0.4 + R() * 0.6), 0.1);
        }
      }
    }
    y += cfg.spacing * (0.75 + R() * 0.5) * (1 - 0.3 * t);
  }
  // dark core around the trunk so the crown never reads as see-through
  if (!cfg.pine) for (let yc = cb + 0.4; yc < H - 2.2; yc += lod ? 2.2 : 1.5) {
    const wc = Math.min(2.8, reach(yc) * 1.15), a0 = R() * TAU;
    for (let k = 0; k < (lod ? 2 : 3); k++) {
      const S = [Math.cos(a0 + (k * Math.PI) / (lod ? 2 : 3)), 0, Math.sin(a0 + (k * Math.PI) / (lod ? 2 : 3))];
      card(leaf, axis(yc - 0.5), UP, S, lod ? 2.6 : 1.9, wc, rect, { col: leafCol, nrm: leafN, sw });
    }
  }
  // leader
  const top = axis(H - 1.3);
  for (let k = 0; k < 3; k++) {
    const S = [Math.cos((k * Math.PI) / 3), 0, Math.sin((k * Math.PI) / 3)];
    card(leaf, top, UP, S, 1.6, 0.55, rect, { col: leafCol, nrm: leafN, sw });
  }
  return { wood: wood.geo(), leaf: leaf.geo() };
}

// ───────────────────────── bare deciduous trees ─────────────────────────
const DECIDUOUS = [
  { name: 'oak', trunkL: 4.2, kids: [4, 3, 3], ang: [0.75, 0.7, 0.65], lenR: [0.86, 0.74, 0.66], gnarl: [0.1, 0.32, 0.38, 0.4], trop: [0.05, -0.02, 0.0, 0.06], leafy: 0.45, bark: [0.5, 0.47, 0.43], seed: 101 },
  { name: 'hornbeam', trunkL: 3.4, kids: [3, 3, 3], ang: [0.45, 0.55, 0.6], lenR: [1.0, 0.74, 0.66], gnarl: [0.06, 0.18, 0.28, 0.35], trop: [0.04, 0.12, 0.08, 0.06], leafy: 0.3, bark: [0.66, 0.66, 0.62], seed: 131 },
  { name: 'beech', trunkL: 5.0, kids: [3, 3, 4], ang: [0.5, 0.6, 0.6], lenR: [0.9, 0.72, 0.64], gnarl: [0.05, 0.16, 0.26, 0.32], trop: [0.04, 0.08, 0.04, 0.02], leafy: 0.55, bark: [0.74, 0.72, 0.67], seed: 151 },
  { name: 'young-oak', trunkL: 3.0, kids: [3, 3, 3], ang: [0.6, 0.65, 0.65], lenR: [0.95, 0.74, 0.66], gnarl: [0.14, 0.3, 0.36, 0.42], trop: [0.06, 0.04, 0.02, 0.05], leafy: 0.7, bark: [0.55, 0.5, 0.45], seed: 171 },
];

function buildDeciduous(cfg, lod) {
  const R = rng(cfg.seed), wood = new MB(), leaf = new MB();
  const H = 12;
  const sw = (p) => Math.pow(clamp((p[1] - 2) / H, 0, 1), 1.4) * 0.5 + Math.pow(clamp(Math.hypot(p[0], p[2]) / 5, 0, 1), 1.3) * 0.65;
  const b = cfg.bark;
  const barkCol = (p) => {
    const moss = (1 - sstep(0.3, 2.2, p[1])) * sstep(-0.2, 0.6, p[2] / Math.max(0.15, Math.hypot(p[0], p[2])));
    const k = 0.85 + 0.15 * sstep(0, 6, p[1]);
    return [b[0] * k * (1 - moss * 0.35), b[1] * k * (1 - moss * 0.08), b[2] * k * (1 - moss * 0.5)];
  };
  const leafCol = (p) => { const k = 0.6 + 0.4 * clamp(p[1] / H, 0, 1); return [k, k * 0.97, k * 0.93]; };
  const leafN = (p) => norm([p[0] * 0.25, 0.6, p[2] * 0.25]);
  const SIDES = lod ? [7, 4, 3, 0] : [11, 6, 4, 3], SEGS = [7, 5, 4, 3];
  const grow = (P, D, L, r0, lvl) => {
    const nSeg = SEGS[lvl], pts = [P], rad = [];
    let p = P, d = D;
    for (let i = 1; i <= nSeg; i++) {
      const rv = [R() - 0.5, (R() - 0.5) * 0.5, R() - 0.5];
      d = norm(add(madd(d, rv, cfg.gnarl[lvl] * (lvl === 0 && i < 3 ? 0.3 : 1)), [0, cfg.trop[lvl], 0]));
      p = madd(p, d, L / nSeg); pts.push(p);
    }
    for (let i = 0; i <= nSeg; i++) rad.push(Math.max(0.006, r0 * (1 - 0.48 * (i / nSeg))));
    if (lvl === 0) {
      const ph = R() * TAU;
      for (let i = 0; i <= nSeg; i++) { const y = pts[i][1]; rad[i] *= 1 + 0.8 * Math.exp(-Math.max(0, y + 0.1) / 0.35); }
      tube(wood, pts, rad, SIDES[0], { uRep: 2, vLen: 1.4, col: barkCol, sw, rmod: (i, a) => 1 + 0.35 * Math.exp(-Math.max(0, pts[i][1]) / 0.32) * Math.pow(Math.max(0, Math.cos(a * 4 + ph)), 3) + (cfg.name === 'hornbeam' ? 0.07 * Math.cos(a * 6 + ph) : 0) });
    } else if (SIDES[lvl]) tube(wood, pts, rad, SIDES[lvl], { uRep: 1, vLen: 1.4, col: barkCol, sw });
    if (lvl === 3) {
      // fine twig spray cards around the twig end
      const nc = lod ? 1 : 3;
      for (let c = 0; c < nc; c++) {
        const at = along(pts, 0.15 + R() * 0.4), A = norm(add(at.t, [(R() - 0.5) * 0.7, 0.1, (R() - 0.5) * 0.7])), Lc = (1.1 + R() * 0.6) * (lod ? 1.4 : 1);
        const S = norm(rot(perp(A), A, R() * TAU));
        card(leaf, at.p, A, S, Lc, Lc * 0.5, R() < cfg.leafy ? RECT.twigLeaf : RECT.twig, { col: leafCol, nrm: leafN, sw });
      }
      return;
    }
    const nK = cfg.kids[lvl] + (R() < 0.4 ? 1 : 0), axisU = perp(d), axisV = cross(d, axisU);
    let phi = R() * TAU;
    for (let k = 0; k < nK; k++) {
      const last = k === nK - 1, f = last ? 1 : lvl === 0 ? 0.62 + R() * 0.35 : 0.3 + R() * 0.6;
      const at = along(pts, f), dd = at.t;
      phi += 2.4 + (R() - 0.5) * 0.6;
      const u = perp(dd), v = cross(dd, u), ax = norm(add(mul(u, Math.cos(phi)), mul(v, Math.sin(phi))));
      const th = cfg.ang[lvl] * (last ? 0.45 : 0.75 + R() * 0.55);
      const cd = norm(add(mul(dd, Math.cos(th)), mul(ax, Math.sin(th))));
      const rr = r0 * (1 - 0.48 * f) * (last ? 0.78 : 0.5 + R() * 0.22);
      grow(at.p, cd, L * cfg.lenR[lvl] * (0.8 + R() * 0.4) * (1 - 0.25 * f * (lvl ? 1 : 0)), rr, lvl + 1);
      if (lvl === 2 && !lod && R() < 0.6) {
        const S = perp(cd);
        card(leaf, at.p, cd, S, 1.0, 0.5, R() < cfg.leafy * 0.7 ? RECT.twigLeaf : RECT.twig, { col: leafCol, nrm: leafN, sw });
      }
    }
    void axisU; void axisV;
  };
  grow([0, -0.7, 0], norm([(R() - 0.5) * 0.08, 1, (R() - 0.5) * 0.08]), cfg.trunkL + 0.7, 0.29, 0);
  return { wood: wood.geo(), leaf: leaf.geo() };
}

// ───────────────────────── bushes ─────────────────────────
/** tiles: [tile, weight, tint]; unit radius 1, unit height (instance scales y). */
const BUSHES = [
  { name: 'bramble', n: 92, tiles: [['leaves', 1, [0.95, 1.0, 0.9]]], seed: 401 },
  { name: 'dry-scrub', n: 84, tiles: [['twigLeaf', 0.55, [1.05, 0.95, 0.85]], ['leaves', 0.45, [1.15, 0.85, 0.6]]], seed: 421 },
  { name: 'mixed', n: 90, tiles: [['leaves', 0.7, [1, 0.98, 0.88]], ['twigLeaf', 0.3, [1, 0.92, 0.82]]], seed: 443 },
  { name: 'juniper', n: 96, tiles: [['fir', 0.8, [0.8, 0.92, 0.86]], ['leaves', 0.2, [0.85, 0.95, 0.85]]], seed: 467 },
];
function buildBush(cfg) {
  const R = rng(cfg.seed), wood = new MB(), leaf = new MB();
  const sw = (p) => 0.25 + 0.55 * clamp(p[1], 0, 1);
  const pick = () => { let u = R(); for (const t of cfg.tiles) { u -= t[1]; if (u <= 0) return t; } return cfg.tiles[0]; };
  // stems fanning out from the root
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * TAU + R() * 0.5, rr = 0.55 + R() * 0.4, top = 0.55 + R() * 0.4;
    const p0 = [(R() - 0.5) * 0.2, -0.05, (R() - 0.5) * 0.2], p1 = [Math.cos(a) * rr * 0.35, top * 0.5, Math.sin(a) * rr * 0.35], p2 = [Math.cos(a) * rr, top, Math.sin(a) * rr];
    tube(wood, [p0, p1, p2], [0.035, 0.022, 0.008], 3, { uRep: 1, vLen: 1.4, col: () => [0.45, 0.4, 0.36], sw });
  }
  const C = [0, 0.38, 0];
  for (let i = 0; i < cfg.n; i++) {
    const skirt = i < cfg.n * 0.22, inner = !skirt && R() < 0.25;
    const a = R() * TAU;
    let rho = skirt ? 0.82 + R() * 0.2 : Math.sqrt(R()) * (inner ? 0.55 : 0.92);
    const sprig = !skirt && !inner && R() < 0.12;   // a few shoots poking out break the dome outline
    if (sprig) rho *= 0.8;
    const y = skirt ? 0.08 + R() * 0.3 : (0.2 + 0.8 * Math.sqrt(Math.max(0, 1 - rho * rho * 0.8))) * (sprig ? 1.15 + R() * 0.2 : 0.7 + R() * 0.3);
    const P = [Math.cos(a) * rho, y, Math.sin(a) * rho];
    const out = norm(sub(P, C));
    const A = norm(add(add(mul(UP, skirt ? 0.4 : 0.75), mul(out, 0.55)), [(R() - 0.5) * 0.5, 0, (R() - 0.5) * 0.5]));
    const S = norm(cross(A, out)), L = (skirt ? 0.6 : 0.72) * (0.8 + R() * 0.45), [tile, , tint] = pick();
    const hue = 0.9 + R() * 0.2;
    const colF = (p) => { const d = clamp(len(sub(p, C)) / 0.95, 0, 1), ao = (0.3 + 0.7 * sstep(0.15, 1.0, d)) * (0.75 + 0.25 * clamp(p[1], 0, 1)); return [tint[0] * ao * hue, tint[1] * ao, tint[2] * ao * (2 - hue)]; };
    const nrm = (p) => norm(add(mul(norm(sub(p, C)), 0.85), [0, 0.35, 0]));
    const O = madd(P, A, -L * 0.45);
    card(leaf, O, A, S, L, L * 0.55, RECT[tile], { col: colF, nrm, sw });
    card(leaf, O, A, norm(rot(S, A, Math.PI / 2)), L, L * 0.55, RECT[tile], { col: colF, nrm, sw });
  }
  return { wood: wood.geo(), leaf: leaf.geo() };
}

// ───────────────────────── ground cover ─────────────────────────
/** Card clumps (ground batch): grass, weeds, bracken, litter, seedlings. Wood: stumps and fallen branches. */
function buildGroundKit() {
  const R = rng(777), cards = [], wood = [];
  const swG = (p) => clamp(p[1] / 0.6, 0, 1) * 0.9;
  const tuft = (n, H, Wd, tile, tint, spread) => {
    const mb = new MB();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI + R() * 0.6, S = [Math.cos(a), 0, Math.sin(a)], tilt = (R() - 0.5) * spread;
      const A = norm([-S[2] * tilt, 1, S[0] * tilt]), h = H * (0.75 + R() * 0.45), k = 0.85 + R() * 0.3;
      card(mb, [(R() - 0.5) * 0.12, -0.03, (R() - 0.5) * 0.12], A, S, h, Wd * (0.8 + R() * 0.4), RECT[tile], {
        col: (p, t) => { const ao = 0.55 + 0.45 * clamp(p[1] / H, 0, 1); return [tint[0] * k * ao, tint[1] * k * ao, tint[2] * k * ao]; },
        nrm: (p) => norm([p[0] * 0.6, 1, p[2] * 0.6]), sw: swG,
      });
    }
    return mb.geo();
  };
  cards.push(tuft(5, 0.5, 0.42, 'grass', [1, 1, 1], 0.5));
  cards.push(tuft(4, 0.36, 0.36, 'grass', [0.92, 1.0, 0.85], 0.7));
  cards.push(tuft(3, 0.75, 0.5, 'weed', [1, 1, 1], 0.4));
  for (const nF of [6, 8]) {   // bracken: fronds arching out and down
    const mb = new MB();
    for (let i = 0; i < nF; i++) {
      const a = (i / nF) * TAU + R() * 0.5, d = [Math.cos(a), 0, Math.sin(a)], L = 0.7 + R() * 0.35, A = norm(add(mul(d, 0.65), [0, 0.75, 0])), S = [-d[2], 0, d[0]];
      const k = 0.8 + R() * 0.35;
      card(mb, [0, -0.02, 0], A, norm(rot(S, A, (R() - 0.5) * 0.6)), L, L * 0.55, RECT.fern, {
        segs: 3, bend: [d[0] * 0.15, -L * 0.55, d[2] * 0.15],
        col: (p, t) => { const ao = 0.6 + 0.4 * t; return [k * ao, k * ao * 0.95, k * ao * 0.9]; }, nrm: (p) => norm([p[0], 1.2, p[2]]), sw: (p) => clamp(len(p) / 0.8, 0, 1) * 0.8,
      });
    }
    cards.push(mb.geo());
  }
  { // litter: flat patches just above the ground
    const mb = new MB();
    for (let i = 0; i < 2; i++) {
      const a = R() * TAU, s = i ? 1.0 : 1.5, A = [Math.cos(a), 0, Math.sin(a)], S = [-A[2], 0, A[0]];
      card(mb, madd([0, 0.025 + i * 0.01, 0], A, -s / 2), A, S, s, s, RECT.litter, { col: () => [0.62, 0.6, 0.58], nrm: () => UP, sw: () => 0 });
    }
    cards.push(mb.geo());
  }
  cards.push(tuft(4, 0.45, 0.32, 'leaves', [0.9, 0.95, 0.85], 0.8));   // bramble seedling
  // stumps
  for (let v = 0; v < 2; v++) {
    const mb = new MB(), h = 0.45 + R() * 0.35, r = 0.24 + R() * 0.1, ph = R() * TAU;
    const ys = [-0.3, 0, 0.12, h * 0.6, h];
    tube(mb, ys.map((y) => [0, y, 0]), ys.map((y) => r * (1 + 0.6 * Math.exp(-Math.max(0, y) / 0.15))), 9, {
      uRep: 1, vLen: 1.4, col: (p) => [0.5, 0.46, 0.42], sw: () => 0, rmod: (i, a) => 1 + 0.3 * Math.exp(-Math.max(0, ys[i]) / 0.12) * Math.pow(Math.max(0, Math.cos(a * 4 + ph)), 3),
    });
    const c = mb.vert([0, h + 0.02, 0], UP, 0.5, 0.5, [0.75, 0.62, 0.45], 0), base = mb.count;
    for (let k = 0; k <= 9; k++) { const a = (k / 9) * TAU, rr = r * (0.92 + (k % 2) * 0.05); mb.vert([Math.cos(a) * rr, h - (k % 3) * 0.02, Math.sin(a) * rr], UP, 0.5 + Math.cos(a) * 0.05, 0.5, [0.62, 0.5, 0.36], 0); }
    for (let k = 0; k < 9; k++) mb.I.push(c, base + k + 1, base + k);
    wood.push(mb.geo());
  }
  // fallen branches lying on the ground
  for (let v = 0; v < 2; v++) {
    const mb = new MB(), L = 2.2 + R() * 1.6, r0 = 0.07 + R() * 0.05, pts = [];
    for (let i = 0; i <= 5; i++) pts.push([-L / 2 + (L * i) / 5, r0 * (1 - 0.5 * (i / 5)) - 0.02, (R() - 0.5) * 0.15]);
    const col = () => [0.42, 0.38, 0.34], sw0 = () => 0;
    tube(mb, pts, pts.map((_, i) => r0 * (1 - 0.6 * (i / 5))), 5, { uRep: 1, vLen: 1.4, col, sw: sw0 });
    for (let k = 0; k < 3; k++) {
      const b = pts[1 + k], sd = k % 2 ? 1 : -1, e = [b[0] + 0.5 + R() * 0.4, 0.04 + R() * 0.15, b[2] + sd * (0.4 + R() * 0.4)];
      tube(mb, [b, e], [r0 * 0.45, 0.01], 3, { uRep: 1, vLen: 1.4, col, sw: sw0 });
    }
    wood.push(mb.geo());
  }
  return { cards, wood };
}

// ───────────────────────── rocks ─────────────────────────
/** Indexed icosphere: { P: [[x,y,z]], I: [] }. */
function icosphere(detail) {
  const t = (1 + Math.sqrt(5)) / 2;
  let P = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm);
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let d = 0; d < detail; d++) {
    const cache = new Map(), nf = [];
    const mid = (a, b) => { const k = a < b ? a * 65536 + b : b * 65536 + a; let i = cache.get(k); if (i === undefined) { i = P.length; P.push(norm(add(P[a], P[b]))); cache.set(k, i); } return i; };
    for (const [a, b, c] of F) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    F = nf;
  }
  return { P, I: F.flat() };
}

/**
 * Limestone boulder: lumpy ellipsoid, flattened fracture planes, horizontal
 * bedding strata, smooth normals. Fitted to the collider: |xz| ≲ 0.9, top ≈ 0.95,
 * buried to −0.35. Small = pebble clusters for the ground cover.
 */
function buildRock(seed, detail, small) {
  const R = rng(seed), { P, I } = icosphere(detail), o = seed * 0.37;
  const sx = 1, sy = 0.62 + R() * 0.3, sz = 0.78 + R() * 0.25;
  const planes = [];
  const nCut = small ? 2 : 3 + ((R() * 3) | 0);
  for (let i = 0; i < nCut; i++) {
    const a = R() * TAU, e = i === 0 ? 1.2 + R() * 0.3 : (R() - 0.35) * 0.9;
    planes.push({ n: norm([Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)]), d: 0.5 + R() * 0.28 });
  }
  const sf = 9 + R() * 5, sph = R() * TAU;
  const pts = P.map((d) => {
    let p = [d[0] * sx, d[1] * sy, d[2] * sz];
    const n1 = noise3(d[0] * 1.4 + o, d[1] * 1.4, d[2] * 1.4 - o), n2 = noise3(d[0] * 3.3 - o, d[1] * 3.3 + 5, d[2] * 3.3);
    p = mul(p, 1 + (n1 - 0.5) * 0.5 + (n2 - 0.5) * 0.14);
    for (const pl of planes) {
      const dd = dot(p, pl.n) - pl.d;
      if (dd > 0) p = madd(p, pl.n, -dd * 0.93 + (noise3(p[0] * 7, p[1] * 7, p[2] * 7) - 0.5) * 0.025);
    }
    if (!small) {
      const s = Math.sin(p[1] * sf + n2 * 2.5 + sph), k = 1 - 0.045 * sstep(0.35, 0.95, s) - 0.02 * (noise3(p[0] * 12, p[1] * 30, p[2] * 12) - 0.5);
      p = [p[0] * k, p[1], p[2] * k];
    }
    return p;
  });
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const p of pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  const hr = Math.max(mx[0] - mn[0], mx[2] - mn[2]) / 2, cx = (mx[0] + mn[0]) / 2, cz = (mx[2] + mn[2]) / 2;
  const top = small ? 0.6 : 0.95, bot = -0.35, rx = small ? 1 : 0.9;
  const mb = new MB();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = [((p[0] - cx) / hr) * rx, bot + ((p[1] - mn[1]) / (mx[1] - mn[1])) * (top - bot), ((p[2] - cz) / hr) * rx];
    const ao = clamp(0.7 + (len(p) - 0.8) * 0.9, 0.55, 1.05) * (0.92 + hash3(i, seed, 3) * 0.1);
    mb.vert(q, [0, 1, 0], 0, 0, [ao, ao * 0.99, ao * 0.97], 0);
  }
  mb.I = I.slice();
  const g = mb.geo();
  g.computeVertexNormals();
  return g;
}

/** Cluster of 2–4 pebbles in one geometry. */
function buildPebbles(seed) {
  const R = rng(seed), parts = [];
  const n = 2 + ((R() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const g = buildRock(seed * 13 + i, 1, true), s = 0.09 + R() * 0.2, a = R() * TAU, r = i ? 0.15 + R() * 0.35 : 0;
    g.scale(s, s * (0.6 + R() * 0.5), s * (0.8 + R() * 0.4)); g.rotateY(R() * TAU); g.translate(Math.cos(a) * r, 0, Math.sin(a) * r);
    parts.push(g);
  }
  return mergeGeos(parts);
}
function mergeGeos(gs) {
  const out = new THREE.BufferGeometry(), names = ['position', 'normal', 'uv', 'color', 'sway'];
  for (const nm of names) {
    const it = gs[0].attributes[nm].itemSize, arr = [];
    for (const g of gs) arr.push(...g.attributes[nm].array);
    out.setAttribute(nm, new THREE.Float32BufferAttribute(arr, it));
  }
  const idx = []; let off = 0;
  for (const g of gs) { for (const i of g.index.array) idx.push(i + off); off += g.attributes.position.count; }
  out.setIndex(idx);
  return out;
}

// ───────────────────────── batches ─────────────────────────
/** A BatchedMesh in the making: geometries + placed instances (with optional far LOD). */
class Batch {
  constructor(mat, o = {}) { this.mat = mat; this.geos = []; this.items = []; this.o = o; }
  geo(g) { this.geos.push(g); return this.geos.length - 1; }
  add(g, m, c, x, z, lodG = -1, ck = 1) { this.items.push({ g, m, c: c.clone(), x, z, lodG, ck: ck * ck }); }
  build(group) {
    if (!this.items.length) return null;
    let nv = 0, ni = 0;
    for (const g of this.geos) { nv += g.attributes.position.count; ni += g.index.count; }
    const bm = new THREE.BatchedMesh(this.items.length, nv, ni, this.mat);
    const ids = this.geos.map((g) => bm.addGeometry(g));
    this.ids = ids;
    this.inst = this.items.map((it) => { const id = bm.addInstance(ids[it.g]); bm.setMatrixAt(id, it.m); bm.setColorAt(id, it.c); return id; });
    this.vis = new Uint8Array(this.items.length).fill(1); this.far = new Uint8Array(this.items.length);
    bm.castShadow = !!this.o.cast; bm.receiveShadow = true;
    bm.sortObjects = !!this.o.sort; bm.perObjectFrustumCulled = true;
    bm.name = 'nature-' + (this.o.name || '');
    group.add(bm);
    this.mesh = bm;
    return bm;
  }
  /** Hide instances beyond cut, swap to LOD geometry past lodD. */
  cull(cx, cz, cut, lodD) {
    const bm = this.mesh, c2 = cut * cut, l2 = lodD * lodD;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i], d2 = (it.x - cx) ** 2 + (it.z - cz) ** 2, v = d2 < c2 * it.ck ? 1 : 0;
      if (v !== this.vis[i]) { this.vis[i] = v; bm.setVisibleAt(this.inst[i], !!v); }
      if (it.lodG >= 0 && v) {
        const f = d2 > l2 ? 1 : 0;
        if (f !== this.far[i]) { this.far[i] = f; bm.setGeometryIdAt(this.inst[i], this.ids[f ? it.lodG : it.g]); }
      }
    }
  }
}

let KIT = null;
/** Shared textures + materials + vegetation geometries (built once, reused by every level). */
function kit() {
  if (KIT) return KIT;
  const t0 = performance.now();
  const atlas = buildAtlas(), bark = buildBark(), rockT = buildRockTex();
  const tTex = performance.now() - t0;
  const mats = {
    wood: natureMat('wood', { map: bark.map, normalMap: bark.normal, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.95, metalness: 0, vertexColors: true }),
    leaf: natureMat('leaf', { map: atlas, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.82, metalness: 0, vertexColors: true }),
    ground: natureMat('ground', { map: atlas, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, vertexColors: true }),
    rock: natureMat('rock', { roughness: 0.86, metalness: 0, vertexColors: true }, rockT),
  };
  const conifers = CONIFERS.map((c) => ({ near: buildConifer(c, 0), far: buildConifer(c, 1) }));
  const deciduous = DECIDUOUS.map((c) => ({ near: buildDeciduous(c, 0), far: buildDeciduous(c, 1) }));
  const rocks = [201, 223, 257, 281].map((s) => buildRock(s, 4, false));
  const pebbles = [301, 317, 331].map(buildPebbles);
  const bushes = BUSHES.map(buildBush), groundKit = buildGroundKit();
  KIT = { mats, atlas, bark, rockT, conifers, deciduous, rocks, pebbles, bushes, groundKit, tTex, tGeo: performance.now() - t0 - tTex };
  return KIT;
}

const triCount = (g) => g.index.count / 3;

/**
 * Build all vegetation of a level into level.group. Reads level.trees, rocks,
 * bushes (fields x, z, s, kind, r; optional v forces a variant, for the
 * viewer), level.gy, level.terrainOpts.surface, level.indoor, level.noWalkFns.
 * Returns stats { ms, draws, instances, ... } and an update(camera, scene) hook
 * (also run automatically from the batches' onBeforeRender).
 */
export function buildNature(level, opts = {}) {
  const t0 = performance.now();
  const K = kit();
  const gy = (x, z) => level.gy(x, z);
  const variant = (it, n, salt) => (it.v ?? Math.floor(hash2(Math.round(it.x * 10) + salt, Math.round(it.z * 10) - salt) * n)) % n;
  const B = {
    wood: new Batch(K.mats.wood, { cast: true, sort: true, name: 'wood' }),
    leaf: new Batch(K.mats.leaf, { cast: true, sort: true, name: 'leaf' }),
    rock: new Batch(K.mats.rock, { cast: true, sort: true, name: 'rock' }),
    ground: new Batch(K.mats.ground, { cast: false, sort: false, name: 'ground' }),
  };
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
  const col = new THREE.Color();
  const mat = (x, y, z, rx, ry, rz, sx, sy, sz) => { e.set(rx, ry, rz, 'YXZ'); q.setFromEuler(e); return new THREE.Matrix4().compose(pv.set(x, y, z), q, sv.set(sx, sy, sz)); };
  void m4;

  // trees: one geometry pair (near, far) per variant and kind
  const treeG = { 0: [], 1: [] };
  for (const [kind, set] of [[0, K.conifers], [1, K.deciduous]]) for (const v of set) {
    treeG[kind].push({ wn: B.wood.geo(v.near.wood), wf: B.wood.geo(v.far.wood), ln: B.leaf.geo(v.near.leaf), lf: B.leaf.geo(v.far.leaf) });
  }
  for (const it of level.trees) {
    const set = treeG[it.kind === 1 ? 1 : 0], v = variant(it, set.length, 3), G = set[v];
    const h1 = hash2(Math.round(it.x * 7) + 5, Math.round(it.z * 7) + 9), h2 = hash2(Math.round(it.x * 5) - 3, Math.round(it.z * 9) + 1);
    const m = mat(it.x, gy(it.x, it.z), it.z, (h1 - 0.5) * 0.07, it.r, (h2 - 0.5) * 0.07, it.s, it.s * (0.94 + h1 * 0.12), it.s);
    const k = 0.9 + h2 * 0.18;
    col.setRGB(k * (0.97 + h1 * 0.06), k, k * (1.03 - h1 * 0.06));
    B.wood.add(G.wn, m, col, it.x, it.z, G.wf);
    B.leaf.add(G.ln, m, col, it.x, it.z, G.lf);
  }

  // boulders: seated at the lowest ground under their footprint
  const rockG = K.rocks.map((g) => B.rock.geo(g));
  for (const it of level.rocks) {
    const v = variant(it, rockG.length, 7), h1 = hash2(Math.round(it.x * 9) + 1, Math.round(it.z * 9) - 4), s = it.s;
    let y = gy(it.x, it.z);
    for (let k = 0; k < 4; k++) { const a = (k * TAU) / 4; y = Math.min(y, gy(it.x + Math.cos(a) * 0.7 * s, it.z + Math.sin(a) * 0.7 * s)); }
    const m = mat(it.x, y, it.z, (h1 - 0.5) * 0.12, it.r, (hash2(v, Math.round(it.x)) - 0.5) * 0.12, s, s * (0.92 + h1 * 0.16), s);
    const k = 0.88 + h1 * 0.2;
    B.rock.add(rockG[v], m, col.setRGB(k, k * (0.98 + h1 * 0.03), k * (0.95 + h1 * 0.04)), it.x, it.z);
  }
  // bushes: unit dome scaled to the hide radius, never lower than a crouching soldier
  const bushG = K.bushes.map((b) => ({ w: B.wood.geo(b.wood), l: B.leaf.geo(b.leaf) }));
  for (const it of level.bushes) {
    const v = variant(it, bushG.length, 11), h1 = hash2(Math.round(it.x * 11) + 3, Math.round(it.z * 11) + 8);
    const hgt = Math.max(1.4, it.r * 0.78) * (0.95 + h1 * 0.12);
    const m = mat(it.x, gy(it.x, it.z) - 0.06, it.z, 0, h1 * TAU, 0, it.r, hgt, it.r);
    const k = 0.88 + h1 * 0.22;
    col.setRGB(k * (0.96 + h1 * 0.1), k, k * (1.04 - h1 * 0.1));
    B.wood.add(bushG[v].w, m, col, it.x, it.z);
    B.leaf.add(bushG[v].l, m, col, it.x, it.z);
  }

  if (opts.ground !== false) scatterGround(level, K, B, gy);

  const group = opts.group || level.group;
  const meshes = Object.values(B).map((b) => b.build(group)).filter(Boolean);
  const st = { lastX: 1e9, lastZ: 1e9, cut: -1 };
  const update = (camera, scene) => {
    U.time.value = performance.now() * 0.001;
    const e2 = camera.matrixWorld.elements, cx = e2[12], cz = e2[14], fog = scene && scene.fog;
    const vis = fog ? (fog.isFogExp2 ? 2.6 / Math.max(1e-4, fog.density) : fog.far) : 400;
    const cut = clamp(vis, 55, opts.maxDist || 130);
    if (Math.abs(cut - st.cut) < 1 && (cx - st.lastX) ** 2 + (cz - st.lastZ) ** 2 < 4) return;
    st.cut = cut; st.lastX = cx; st.lastZ = cz;
    U.fade.value = Math.min(46, cut * 0.62);
    const lodD = opts.lodDist ?? 24;
    for (const b of Object.values(B)) if (b.mesh) b.cull(cx, cz, b === B.ground ? U.fade.value : cut, lodD);
  };
  for (const bm of meshes) {
    const orig = bm.onBeforeRender;
    bm.onBeforeRender = function (renderer, scene, camera, geometry, material, grp) { update(camera, scene); return orig.call(this, renderer, scene, camera, geometry, material, grp); };
  }
  const stats = {
    ms: performance.now() - t0, texMs: K.tTex, kitGeoMs: K.tGeo, draws: meshes.length,
    instances: Object.fromEntries(Object.entries(B).map(([k, b]) => [k, b.items.length])),
    tris: {
      conifer: K.conifers.map((c) => [triCount(c.near.wood) + triCount(c.near.leaf), triCount(c.far.wood) + triCount(c.far.leaf)]),
      deciduous: K.deciduous.map((c) => [triCount(c.near.wood) + triCount(c.near.leaf), triCount(c.far.wood) + triCount(c.far.leaf)]),
    },
  };
  return { stats, update, meshes, batches: B };
}

/**
 * Ground cover on a jittered grid, deterministic (hash2): only on 'grass'
 * surface, kept off paths, buildings and no-walk zones, denser near trees,
 * bushes and rocks; tilted to the terrain slope.
 */
function scatterGround(level, K, B, gy) {
  const surf = level.terrainOpts && level.terrainOpts.surface, bd = level.bounds || (level.terrainOpts && level.terrainOpts.bounds);
  if (!surf || !bd) return;
  const GC = K.groundKit.cards.map((g) => B.ground.geo(g)), GW = K.groundKit.wood.map((g) => B.wood.geo(g)), GP = K.pebbles.map((g) => B.rock.geo(g));
  const cell = 6, grid = new Map(), key = (i, j) => i * 100003 + j;
  const put = (x, z, rad, w) => { const k = key(Math.floor(x / cell), Math.floor(z / cell)); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(x, z, rad, w); };
  for (const t of level.trees) put(t.x, t.z, 0.42 * t.s, 1);
  for (const r of level.rocks) put(r.x, r.z, 0.85 * r.s, 0.7);
  for (const b of level.bushes) put(b.x, b.z, b.r * 0.6, 0.6);
  const near = (x, z) => {
    let f = 0, clear = 1e9;
    const ci = Math.floor(x / cell), cj = Math.floor(z / cell);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      const a = grid.get(key(i, j)); if (!a) continue;
      for (let k = 0; k < a.length; k += 4) { const d = Math.hypot(x - a[k], z - a[k + 1]) - a[k + 2]; clear = Math.min(clear, d); f += a[k + 3] * Math.exp(-Math.max(0, d) / 2.6); }
    }
    return { f, clear };
  };
  const indoor = (x, z) => (level.indoor || []).some((b) => { const dx = x - b.x, dz = z - b.z; return Math.abs(dx * b.c - dz * b.s) < b.hx + 0.3 && Math.abs(dx * b.s + dz * b.c) < b.hz + 0.3; });
  const noWalk = (x, z) => (level.noWalkFns || []).some((fn) => fn(x, z));
  const grassAt = (x, z) => surf(x, z) === 'grass';
  const q = new THREE.Quaternion(), qy = new THREE.Quaternion(), nv = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), pv = new THREE.Vector3(), sv = new THREE.Vector3(), col = new THREE.Color();
  const place = (x, z, yaw, s, sy, lift, follow) => {
    const hx = gy(x + 0.4, z) - gy(x - 0.4, z), hz = gy(x, z + 0.4) - gy(x, z - 0.4);
    nv.set(-hx / 0.8, 1, -hz / 0.8).normalize().lerp(up, 1 - follow).normalize();
    q.setFromUnitVectors(up, nv).multiply(qy.setFromAxisAngle(up, yaw));
    return new THREE.Matrix4().compose(pv.set(x, gy(x, z) + lift, z), q, sv.set(s, s * sy, s));
  };
  const cs = 1.0;
  const nx = Math.ceil((bd.maxX - bd.minX) / cs), nz = Math.ceil((bd.maxZ - bd.minZ) / cs);
  for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) {
    const h = (k) => hash2(ix * 7 + k * 131, iz * 11 - k * 71);
    const x = bd.minX + (ix + h(1)) * cs, z = bd.minZ + (iz + h(2)) * cs;
    if (!grassAt(x, z) || !grassAt(x + 0.9, z) || !grassAt(x - 0.9, z) || !grassAt(x, z + 0.9) || !grassAt(x, z - 0.9)) continue;
    if (indoor(x, z) || noWalk(x, z)) continue;
    const nb = near(x, z);
    if (nb.clear < 0.15) continue;
    const fo = Math.min(1, nb.f), yaw = h(3) * TAU, hv = h(9);
    // sparse wood and stones
    const hw = h(4);
    if (hw < 0.012 * fo && nb.clear > 0.6) { col.setRGB(0.9 + hv * 0.2, 0.9 + hv * 0.15, 0.9 + hv * 0.1); B.wood.add(GW[h(5) < 0.5 ? 0 : 1], place(x, z, yaw, 0.85 + hv * 0.4, 1, 0, 0.3), col, x, z, -1, 0.75); continue; }
    if (hw < 0.045 && fo > 0.15 && nb.clear > 1.8) { col.setRGB(0.85 + hv * 0.25, 0.85 + hv * 0.2, 0.85 + hv * 0.15); B.wood.add(GW[h(5) < 0.5 ? 2 : 3], place(x, z, yaw, 0.8 + hv * 0.5, 1, 0, 1), col, x, z, -1, 0.6); continue; }
    if (h(6) < 0.05) { const k = 0.85 + hv * 0.25; B.rock.add(GP[(h(5) * GP.length) | 0], place(x, z, yaw, 0.8 + hv * 0.8, 1, -0.02, 1), col.setRGB(k, k, k * 0.97), x, z, -1, 0.5); }
    // card clumps
    if (h(7) > 0.32 + 0.6 * fo) continue;
    const w = [1.3 - fo * 0.9, 0.8 - fo * 0.5, 0.35, 0.15 + fo * 0.45, 0.1 + fo * 0.35, 0.15 + fo * 1.1, 0.12 + fo * 0.25];
    let u = h(8) * w.reduce((a, b) => a + b, 0), t = 0;
    while (t < w.length - 1 && (u -= w[t]) > 0) t++;
    const s = (t === 5 ? 0.9 + hv * 0.6 : 0.95 + hv * 0.7), k = 0.62 + h(10) * 0.22;
    col.setRGB(k * (0.95 + hv * 0.12), k, k * (1.02 - hv * 0.1));
    B.ground.add(GC[t], place(x, z, yaw, s, t === 5 ? 1 : 0.9 + h(11) * 0.3, 0, t === 5 ? 1 : 0.35), col, x, z);
  }
}

/** Debug access to the shared kit (textures, materials, geometries) for dev/nature.html. */
export function natureKit() { return kit(); }
