/**
 * military.js — field fortifications and military set dressing, built in code.
 *
 * The level kit (level.js) exposes each piece as a kit method; the functions
 * here write the visuals into the level's shared batches and register the
 * colliders, lamps and fires through the kit, so a piece costs no extra draw
 * calls beyond the handful of batches every act already has:
 *
 *   dirt     earth berms, spoil, sod roofs, mud      wood   planks, revetment, duckboards
 *   bark     round logs, poles, stakes, brushwood     stone  dry-stone walls, hearths
 *   cloth    felt, tarpaulin, canvas tilts, nets (double sided), sandbags (structures.js)
 *   concrete blocks                                   dark   recesses, ash, shadows
 *   st_paint / st_pwood / st_metal / st_rubber / st_glass   structures.js' own batches
 *            (painted steel, ammunition boxes, wire and guns, tyres, cab glass)
 *
 * What looks solid stops movement and bullets; felt and brush stop sight and
 * let bullets through at reduced damage (F.THIN); wire stops only movement;
 * nets and duckboards have no colliders. Nothing carries markings or text.
 *
 * Convention: every piece is built in a local frame at (x, z) with yaw `rot`
 * (the kit's P() convention). Local −Z is the front: the field of fire of a
 * position, the entrance of a shelter, the bonnet of a truck. A soldier
 * placed in a position faces it with `face: rot`.
 */
import * as THREE from 'three';
import { makeRng, clamp01, smoothstep, lerp } from './ctx.js';
import { C, buildProp } from './structures.js';
import { Geo } from './models.js';
import { F, WALL } from './physics.js';

const PI = Math.PI, TAU = PI * 2;
const THIN = F.SOLID | F.VISION | F.BULLET | F.THIN;      // felt, brush, planks: bullets pass once
const SOFT = F.VISION | F.BULLET | F.THIN;                // overhead felt / brush: sight only
const POST = F.SOLID | F.BULLET;                          // poles, legs, stakes

// ───────────────────────────── colour helpers ─────────────────────────────
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const jit = (a, rng, amt) => { const k = 1 + (rng() - 0.5) * amt; return [a[0] * k * (1 + (rng() - 0.5) * amt * 0.4), a[1] * k, a[2] * k * (1 + (rng() - 0.5) * amt * 0.4)]; };
const seedOf = (x, z, salt = 0) => ((Math.floor(x * 7.31 + 1000) * 73856093) ^ (Math.floor(z * 5.17 + 1000) * 19349663) ^ (salt * 83492791)) >>> 0;

const COL = {
  earth: C(0x6b5a44), earthDk: C(0x4a3e30), mud: C(0x3e3428), moss: C(0x56603a), grass: C(0x6f7650), leaf: C(0x8a5a2a), leaf2: C(0xa27a3a),
  stone: C(0x9a968a), stoneDk: C(0x7a766c), plank: C(0xa08a6a), plankDk: C(0x6e5c44), log: C(0x6a5440), logDk: C(0x4a3c30), cut: C(0xc8aa7a),
  felt: C(0xb8ab92), feltDk: C(0x8a7d68), hide: C(0x7a5a3e), tarp: C(0x5a6046), canvas: C(0x6a6a4e), rope: C(0x5a4a34),
  olive: C(0x4e5438), oliveDk: C(0x3a3f2c), steel: C(0x55585a), gun: C(0x2a2c2e), brass: C(0xb08a48), conc: C(0xa8a49a),
  brush: C(0x4f5a34), brushDk: C(0x3a4228), dryBrush: C(0x7a6a44), ash: C(0x2a2826), ember: C(0xff8a3a), white: C(0xd8d4c8), red: C(0x8a2a22),
};

// ───────────────────────────── frame + vertex ─────────────────────────────
const _M = new THREE.Matrix4(), _E = new THREE.Euler();
let FE = null;
/** Current frame: (x,y,z) with yaw ry; everything emitted next is written through it. */
function at(x, y, z, ry = 0) { _M.makeRotationFromEuler(_E.set(0, ry, 0, 'YXZ')).setPosition(x, y, z); FE = _M.elements; }
function noFrame() { FE = null; }
/** Local (lx, lz) → world [x, z] for a frame at (x, z) with yaw rot (the kit's P()). */
export function frameP(x, z, rot) { const c = Math.cos(rot), s = Math.sin(rot); return (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c]; }

function V(g, x, y, z, nx, ny, nz, c, k, u, v) {
  if (FE) {
    const e = FE;
    const X = e[0] * x + e[4] * y + e[8] * z + e[12], Y = e[1] * x + e[5] * y + e[9] * z + e[13], Z = e[2] * x + e[6] * y + e[10] * z + e[14];
    const NX = e[0] * nx + e[4] * ny + e[8] * nz, NY = e[1] * nx + e[5] * ny + e[9] * nz, NZ = e[2] * nx + e[6] * ny + e[10] * nz;
    x = X; y = Y; z = Z; nx = NX; ny = NY; nz = NZ;
  }
  g.p.push(x, y, z); g.n.push(nx, ny, nz); g.c.push(c[0] * k, c[1] * k, c[2] * k); g.t.push(u, v);
  return g.count++;
}

// ───────────────────────────── primitives ─────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Quad a,b,c,d counter-clockwise seen from the front. */
function quad(g, a, b, c, d, col, k = 1, uv = null, ks = null) {
  const n = norm(cross(sub(b, a), sub(d, a)));
  const U = uv || [0, 0, 1, 0, 1, 1, 0, 1], i = g.count;
  V(g, a[0], a[1], a[2], n[0], n[1], n[2], col, ks ? ks[0] * k : k, U[0], U[1]);
  V(g, b[0], b[1], b[2], n[0], n[1], n[2], col, ks ? ks[1] * k : k, U[2], U[3]);
  V(g, c[0], c[1], c[2], n[0], n[1], n[2], col, ks ? ks[2] * k : k, U[4], U[5]);
  V(g, d[0], d[1], d[2], n[0], n[1], n[2], col, ks ? ks[3] * k : k, U[6], U[7]);
  g.i.push(i, i + 1, i + 2, i, i + 2, i + 3);
}
function tri(g, a, b, c, col, k = 1) {
  const n = norm(cross(sub(b, a), sub(c, a))), i = g.count;
  V(g, a[0], a[1], a[2], n[0], n[1], n[2], col, k, a[0], a[2]);
  V(g, b[0], b[1], b[2], n[0], n[1], n[2], col, k, b[0], b[2]);
  V(g, c[0], c[1], c[2], n[0], n[1], n[2], col, k, c[0], c[2]);
  g.i.push(i, i + 1, i + 2);
}

const BOX_F = [
  [1, 0, 0, [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], 2, 1],
  [-1, 0, 0, [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], 2, 1],
  [0, 1, 0, [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], 0, 2],
  [0, -1, 0, [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], 0, 2],
  [0, 0, 1, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], 0, 1],
  [0, 0, -1, [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], 0, 1],
];
const _R = new THREE.Matrix4();
/**
 * Box centred at (cx,cy,cz), full size (sx,sy,sz), in the current frame.
 * o: { ry, rx, rz, us (metres per uv repeat), skip (mask 1 +x 2 −x 4 +y 8 −y 16 +z 32 −z), k, kb (shade at the bottom) }
 */
function box(g, cx, cy, cz, sx, sy, sz, col, o = {}) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2, us = o.us || 1, skip = o.skip ?? 8, k = o.k ?? 1, kb = o.kb ?? 1;
  let e = null;
  if (o.ry || o.rx || o.rz) { _R.makeRotationFromEuler(_E.set(o.rx || 0, o.ry || 0, o.rz || 0, 'YXZ')); e = _R.elements; }
  const off = [cx, cy, cz], h = [hx, hy, hz];
  for (let f = 0; f < 6; f++) {
    if (skip & (1 << f)) continue;
    const [nx0, ny0, nz0, cs, ua, va] = BOX_F[f];
    let nx = nx0, ny = ny0, nz = nz0;
    if (e) { nx = e[0] * nx0 + e[4] * ny0 + e[8] * nz0; ny = e[1] * nx0 + e[5] * ny0 + e[9] * nz0; nz = e[2] * nx0 + e[6] * ny0 + e[10] * nz0; }
    const base = g.count;
    for (let q = 0; q < 4; q++) {
      const l = cs[q];
      let x = l[0] * hx, y = l[1] * hy, z = l[2] * hz;
      const u = (l[ua] * h[ua] + off[ua]) / us, v = (l[va] * h[va] + off[va]) / us;
      if (e) { const X = e[0] * x + e[4] * y + e[8] * z, Y = e[1] * x + e[5] * y + e[9] * z, Z = e[2] * x + e[6] * y + e[10] * z; x = X; y = Y; z = Z; }
      V(g, x + cx, y + cy, z + cz, nx, ny, nz, col, k * (l[1] < 0 ? kb : 1), u, v);
    }
    g.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** Cylinder / frustum from local point a to b (radii r0 at a, r1 at b), smooth sides. o: { seg, caps, k, us, uvW (u across the side 0..uvW) } */
function rod(g, a, b, r0, r1, col, o = {}) {
  const seg = o.seg || 6, d = sub(b, a), len = Math.hypot(d[0], d[1], d[2]) || 1e-6, dn = [d[0] / len, d[1] / len, d[2] / len];
  const ref = Math.abs(dn[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(dn, ref)), w = cross(dn, u), us = o.us || 1, k = o.k ?? 1, slope = (r0 - r1) / len;
  const base = g.count;
  for (let s = 0; s <= seg; s++) {
    const t = (s / seg) * TAU, ct = Math.cos(t), st = Math.sin(t);
    const rx = u[0] * ct + w[0] * st, ry = u[1] * ct + w[1] * st, rz = u[2] * ct + w[2] * st;
    const n = norm([rx + dn[0] * slope, ry + dn[1] * slope, rz + dn[2] * slope]);
    const uu = o.uvW != null ? (s / seg) * o.uvW : (s / seg) * TAU * Math.max(r0, r1) / us;
    if (o.swap) {
      V(g, a[0] + rx * r0, a[1] + ry * r0, a[2] + rz * r0, n[0], n[1], n[2], col, k * (o.kb ?? 1), 0, uu);
      V(g, b[0] + rx * r1, b[1] + ry * r1, b[2] + rz * r1, n[0], n[1], n[2], col, k, len / us, uu);
    } else {
      V(g, a[0] + rx * r0, a[1] + ry * r0, a[2] + rz * r0, n[0], n[1], n[2], col, k * (o.kb ?? 1), uu, 0);
      V(g, b[0] + rx * r1, b[1] + ry * r1, b[2] + rz * r1, n[0], n[1], n[2], col, k, uu, len / us);
    }
  }
  for (let s = 0; s < seg; s++) { const i = base + s * 2; g.i.push(i, i + 2, i + 3, i, i + 3, i + 1); }
  if (o.caps !== false) for (const [p, r, sg, cc] of [[b, r1, 1, o.capCol], [a, r0, -1, o.capCol]]) {
    if (r < 0.004 || (sg < 0 && o.capA === false)) continue;
    const c0 = g.count, nn = [dn[0] * sg, dn[1] * sg, dn[2] * sg];
    V(g, p[0], p[1], p[2], nn[0], nn[1], nn[2], cc || col, k, o.capUV ? o.capUV[0] : 0.5, o.capUV ? o.capUV[1] : 0.5);
    for (let s = 0; s <= seg; s++) {
      const t = (s / seg) * TAU, ct = Math.cos(t), st = Math.sin(t);
      const cu = o.capUV ? o.capUV[0] + ct * o.capUV[2] : 0.5 + ct * 0.5 * r, cv = o.capUV ? o.capUV[1] + st * o.capUV[2] : 0.5 + st * 0.5 * r;
      V(g, p[0] + (u[0] * ct + w[0] * st) * r, p[1] + (u[1] * ct + w[1] * st) * r, p[2] + (u[2] * ct + w[2] * st) * r, nn[0], nn[1], nn[2], cc || col, k * 0.95, cu, cv);
    }
    for (let s = 0; s < seg; s++) { if (sg > 0) g.i.push(c0, c0 + 1 + s, c0 + 2 + s); else g.i.push(c0, c0 + 2 + s, c0 + 1 + s); }
  }
}

/** Square-section beam from a to b, w wide (across, horizontal-ish) and h deep. o: { k, us, ends (default true) } */
function bar(g, a, b, w, h, col, o = {}) {
  const d = sub(b, a), len = Math.hypot(d[0], d[1], d[2]) || 1e-6, dn = [d[0] / len, d[1] / len, d[2] / len];
  const ref = Math.abs(dn[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(dn, ref)), v = cross(u, dn), us = o.us || 1, k = o.k ?? 1;
  const c = (p, su, sv) => [p[0] + u[0] * su * w / 2 + v[0] * sv * h / 2, p[1] + u[1] * su * w / 2 + v[1] * sv * h / 2, p[2] + u[2] * su * w / 2 + v[2] * sv * h / 2];
  const sides = [[1, 1, -1, 1], [-1, 1, -1, -1], [-1, -1, 1, -1], [1, -1, 1, 1]];
  for (const [s0, t0, s1, t1] of sides) quad(g, c(a, s1, t1), c(a, s0, t0), c(b, s0, t0), c(b, s1, t1), col, k, [0, 0, w / us, 0, w / us, len / us, 0, len / us]);
  if (o.ends !== false) { quad(g, c(a, 1, 1), c(a, -1, 1), c(a, -1, -1), c(a, 1, -1), col, k * 0.9); quad(g, c(b, 1, -1), c(b, -1, -1), c(b, -1, 1), c(b, 1, 1), col, k * 0.9); }
}

/**
 * Lattice surface with smooth normals; pos(i, j) → [x,y,z], i ∈ 0..nu, j ∈ 0..nv.
 * o: { colAt(i,j,p) → [col,k], uv(i,j,p) → [u,v], flip, skip(i,j) → true to leave a cell out }
 */
function sheet(g, nu, nv, pos, col, o = {}) {
  const cu = nu + 1, cv = nv + 1, P = new Array(cu * cv), N = new Float32Array(cu * cv * 3);
  for (let j = 0; j < cv; j++) for (let i = 0; i < cu; i++) P[j * cu + i] = pos(i, j);
  const sg = o.flip ? -1 : 1;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = P[j * cu + i], b = P[j * cu + i + 1], c = P[(j + 1) * cu + i + 1], d = P[(j + 1) * cu + i];
    const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], vx = d[0] - b[0], vy = d[1] - b[1], vz = d[2] - b[2];
    const nx = (uy * vz - uz * vy) * sg, ny = (uz * vx - ux * vz) * sg, nz = (ux * vy - uy * vx) * sg;
    for (const q of [j * cu + i, j * cu + i + 1, (j + 1) * cu + i + 1, (j + 1) * cu + i]) { N[q * 3] += nx; N[q * 3 + 1] += ny; N[q * 3 + 2] += nz; }
  }
  const base = g.count;
  for (let j = 0; j < cv; j++) for (let i = 0; i < cu; i++) {
    const q = j * cu + i, p = P[q];
    let nx = N[q * 3], ny = N[q * 3 + 1], nz = N[q * 3 + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    const ck = o.colAt ? o.colAt(i, j, p) : null, uv = o.uv ? o.uv(i, j, p) : [p[0] * 0.5 + p[2] * 0.5, p[1] * 0.5];
    V(g, p[0], p[1], p[2], nx / l, ny / l, nz / l, ck ? ck[0] : col, ck ? ck[1] : 1, uv[0], uv[1]);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    if (o.skip && o.skip(i, j)) continue;
    const a = base + j * cu + i, b = a + 1, c = a + cu + 1, d = a + cu;
    if (o.flip) g.i.push(a, c, b, a, d, c); else g.i.push(a, b, c, a, c, d);
  }
}

// ───────────────────────────── batches ─────────────────────────────
/** Shared level batches plus structures.js' own (built by finalizeStructures). */
function K(L) {
  if (L._milK) return L._milK;
  const st = (name) => { const m = L._stb || (L._stb = new Map()); let g = m.get(name); if (!g) { g = new Geo({ uv: true }); m.set(name, g); } return g; };
  L._milK = {
    dirt: L._batch('dirt'), wood: L._batch('wood'), bark: L._batch('bark'), stone: L._batch('stone'), cloth: L._batch('cloth'),
    conc: L._batch('concrete'), dark: L._batch('dark'), roof: L._batch('roof'), glow: L._batch('glow'),
    paint: st('st_paint'), pwood: st('st_pwood'), metal: st('st_metal'), rubber: st('st_rubber'), glass: st('st_glass'),
  };
  return L._milK;
}
let DEPTH = 0;
/** Index counts per batch (shared and structures'), to report what this module added. */
const batchSizes = (L) => { const m = {}; for (const [k, g] of L.batches) m[k] = g.i.length; if (L._stb) for (const [k, g] of L._stb) m[k] = g.i.length; return m; };
const timed = (L, fn) => {
  const t0 = performance.now(), before = DEPTH ? null : batchSizes(L); DEPTH++;
  try { return fn(); } finally {
    DEPTH--; FE = null;
    const S = L.milStats || (L.milStats = { ms: 0, pieces: 0, tris: 0, byBatch: {} });
    S.pieces++;
    if (!DEPTH) {
      S.ms += performance.now() - t0;
      const after = batchSizes(L);
      for (const k in after) { const d = (after[k] - (before[k] || 0)) / 3; if (d) { S.byBatch[k] = (S.byBatch[k] || 0) + d; S.tris += d; } }
    }
  }
};

/** Height of the rendered terrain mesh (linear over the act's grid), so floors and mud sit exactly on it. */
export function meshY(L, x, z) {
  const o = L.terrainOpts, b = L.bounds, st = o.step || 2;
  const fx = (x - b.minX) / st, fz = (z - b.minZ) / st, ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz;
  const X0 = b.minX + ix * st, Z0 = b.minZ + iz * st;
  const h00 = L.h(X0, Z0), h10 = L.h(X0 + st, Z0), h01 = L.h(X0, Z0 + st), h11 = L.h(X0 + st, Z0 + st);
  if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
  return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
}
const groundMin = (L, pts) => Math.min(...pts.map((p) => Math.min(L.gy(p[0], p[1]), meshY(L, p[0], p[1]))));

/** A rotated collider box with its base at y0, height h. */
function col(L, x, z, y0, w, h, d, rot, flags = WALL, mat = 'stone', tag) {
  return L.world.addBox({ x, y: y0 + h / 2, z, hx: w / 2, hy: h / 2, hz: d / 2, rot, flags, mat, tag });
}

// ───────────────────────────── small reusable bits ─────────────────────────────
/** Scatter fallen leaves (tiny flat quads) over a local rectangle at heights given by yAt(lx, lz). */
function leaves(g, rng, n, x0, z0, x1, z1, yAt) {
  for (let i = 0; i < n; i++) {
    const lx = rng.range(x0, x1), lz = rng.range(z0, z1), y = yAt(lx, lz) + 0.015, s = rng.range(0.05, 0.09), a = rng() * TAU;
    const ca = Math.cos(a) * s, sa = Math.sin(a) * s, cl = jit(rng() < 0.5 ? COL.leaf : COL.leaf2, rng, 0.4);
    quad(g, [lx - ca, y, lz - sa], [lx - sa, y, lz + ca], [lx + ca, y, lz + sa], [lx + sa, y, lz - ca], cl, 0.9);
  }
}
/** An olive ammunition box (painted wood), local frame, base at y. */
function ammoBox(Kt, x, y, z, ry, rng, s = 1) {
  const w = 0.62 * s, h = 0.3 * s, d = 0.34 * s, c = jit(COL.olive, rng, 0.2);
  box(Kt.pwood, x, y + h / 2, z, w, h, d, c, { ry, us: 0.9 });
  box(Kt.pwood, x, y + h + 0.012, z, w + 0.02, 0.024, d + 0.02, mul(c, 0.85), { ry, us: 0.9 });
  const cs = Math.cos(ry), sn = Math.sin(ry);
  for (const e of [-1, 1]) box(Kt.metal, x + cs * e * (w / 2 + 0.01), y + h * 0.65, z - sn * e * (w / 2 + 0.01), 0.02, 0.04, 0.12, COL.steel, { ry });
}
/** A camp kettle (blackened steel). */
function kettle(Kt, x, y, z, rng) {
  const c = mul(COL.gun, 1.2);
  rod(Kt.metal, [x, y, z], [x, y + 0.14, z], 0.1, 0.085, c, { seg: 10, capA: false });
  rod(Kt.metal, [x, y + 0.14, z], [x, y + 0.17, z], 0.06, 0.02, c, { seg: 8 });
  rod(Kt.metal, [x + 0.08, y + 0.06, z], [x + 0.17, y + 0.14, z], 0.018, 0.01, c, { seg: 4 });
  rod(Kt.metal, [x - 0.07, y + 0.15, z], [x, y + 0.25, z], 0.006, 0.006, c, { seg: 3, caps: false });
  rod(Kt.metal, [x, y + 0.25, z], [x + 0.07, y + 0.15, z], 0.006, 0.006, c, { seg: 3, caps: false });
  void rng;
}
/** Bent stick / branch from a toward b with a sag, as 2 rods. */
function branch(g, a, b, r, col, sag = 0.1) {
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - sag, (a[2] + b[2]) / 2];
  rod(g, a, m, r, r * 0.8, col, { seg: 4, caps: false }); rod(g, m, b, r * 0.8, r * 0.45, col, { seg: 4, caps: false });
}
/** A clump of foliage (brushwood, cut boughs): a few crossed leafy quads. */
function brushClump(g, x, y, z, s, rng, dry = false) {
  for (let i = 0; i < 3; i++) {
    const a = rng() * PI, ca = Math.cos(a) * s, sa = Math.sin(a) * s, h = s * rng.range(0.6, 1.0), cl = jit(dry ? COL.dryBrush : rng() < 0.5 ? COL.brush : COL.brushDk, rng, 0.35);
    quad(g, [x - ca, y - 0.02, z - sa], [x + ca, y - 0.02, z + sa], [x + ca * 0.7, y + h, z + sa * 0.7], [x - ca * 0.6, y + h * 0.9, z - sa * 0.6], cl, 1, null, [0.6, 0.6, 1, 1]);
  }
}

// ═════════════════════════════ SƏNGƏR — stone-and-sandbag breastwork ═════════════════════════════
/**
 * A chest-high horseshoe of dry-stone wall topped with sandbags, open at the back,
 * with firing notches in the front courses and a firing step; o.roof adds a log-and-earth roof.
 * o: { r (inner radius, default 2.3), arc (half-angle of the wall, default 1.95 rad), roof }
 * Returns { x, z, rot, seats: [[x,z],...] } (spots behind the notches for soldiers).
 */
export function sanger(L, x, z, rot, o = {}) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 1)), Pp = frameP(x, z, rot);
    const R = o.r ?? 2.3, T = 0.7, arc = o.arc ?? 1.95, n = Math.max(5, Math.round(arc * 2 * (R + T / 2) / 1.15));
    const Hs = 0.82, Hb = 1.32;                   // stone height, total height
    const y0 = L.gy(x, z);
    const notchAt = new Set([Math.floor(n / 2), Math.floor(n / 2) - 2, Math.floor(n / 2) + 2]);
    const seats = [];
    for (let i = 0; i < n; i++) {
      const a0 = -arc + (i / n) * arc * 2, a1 = -arc + ((i + 1) / n) * arc * 2, am = (a0 + a1) / 2;
      const rm = R + T / 2, len = 2 * rm * Math.sin((a1 - a0) / 2) + 0.12;
      // local centre (front is −Z: angle 0 → (0, −r))
      const lx = Math.sin(am) * rm, lz = -Math.cos(am) * rm;
      const [wx, wz] = Pp(lx, lz), srot = rot - am;    // wall runs along local x of the segment frame
      const gy0 = L.gy(wx, wz), base = Math.min(gy0, meshY(L, wx, wz)) - 0.25;
      const notch = notchAt.has(i);
      // colliders: full body, top course split around the notch
      if (notch) {
        col(L, wx, wz, base, len, gy0 + 1.0 - base, T, srot, WALL, 'stone');
        const pc = Math.cos(srot), ps = Math.sin(srot), half = (len - 0.42) / 2;
        for (const e of [-1, 1]) col(L, wx + pc * e * (half / 2 + 0.21), wz - ps * e * (half / 2 + 0.21), gy0 + 1.0, half, Hb - 1.0, T, srot, WALL, 'dirt');
        seats.push(Pp(Math.sin(am) * (R - 0.95), -Math.cos(am) * (R - 0.95)));
      } else col(L, wx, wz, base, len, gy0 + Hb - base, T, srot, WALL, 'stone');
      // dry-stone facing: rows of irregular stones on both faces, a core between
      at(wx, 0, wz, srot);
      box(Kt.stone, 0, (base + gy0 + Hs) / 2, 0, len - 0.04, gy0 + Hs - base, T - 0.12, mul(COL.stoneDk, 0.8), { us: 2.6 });
      const rows = 4, rh = Hs / rows;
      for (let r = 0; r < rows; r++) {
        let u = -len / 2 + (r % 2) * 0.12;
        while (u < len / 2 - 0.05) {
          const sw = Math.min(rng.range(0.26, 0.44), len / 2 - u), cl = jit(rng() < 0.2 ? COL.moss : COL.stone, rng, 0.3);
          for (const side of [-1, 1]) {
            const depth = rng.range(0.16, 0.24);
            box(Kt.stone, u + sw / 2, gy0 - 0.06 + rh * (r + 0.5), side * (T / 2 - depth / 2 + 0.02), sw - 0.025, rh - rng.range(0.015, 0.04), depth, mul(cl, r === 0 ? 0.75 : 1), { us: 2.6, ry: (rng() - 0.5) * 0.08, rz: (rng() - 0.5) * 0.06, skip: 8 });
          }
          u += sw;
        }
      }
      // moss and leaves at the foot of the outer face
      leaves(Kt.dirt, rng, 6, -len / 2, -T / 2 - 0.5, len / 2, -T / 2, () => gy0 - 0.05);
      noFrame();
      // sandbags on top (two courses), the notch cut through the top course
      const sb = (lx2, len2, yb, h) => { const p = Pp(lx2 * Math.cos(-am) + Math.sin(am) * rm, -lx2 * Math.sin(-am) - Math.cos(am) * rm); buildProp(L, 'sandbags', { x: p[0], z: p[1], y: yb, len: len2, rot: srot, h }); };
      if (notch) {
        sb(0, len, gy0 + Hs, 0.2);
        const half = (len - 0.42) / 2;
        sb(-(half / 2 + 0.21), half, gy0 + Hs + 0.18, 0.32); sb(half / 2 + 0.21, half, gy0 + Hs + 0.18, 0.32);
      } else sb(0, len, gy0 + Hs, 0.5);
    }
    // firing step: a low earth bench inside the front, edged with a plank
    at(x, 0, z, rot);
    const fsY = y0, fsR = R - 0.28;
    for (let i = 0; i < 5; i++) {
      const a = -0.9 + i * 0.45, lx = Math.sin(a) * fsR, lz = -Math.cos(a) * fsR;
      box(Kt.dirt, lx, fsY + 0.09, lz, 0.5, 0.22, 0.5, jit(COL.earth, rng, 0.2), { ry: -a, us: 4 });
      box(Kt.wood, Math.sin(a) * (fsR - 0.26), fsY + 0.1, -Math.cos(a) * (fsR - 0.26), 0.52, 0.2, 0.04, COL.plankDk, { ry: -a, us: 1.8 });
    }
    // floor: trampled mud, a few spent cases and an ammo box
    const mudC = mix(COL.mud, COL.earth, 0.3);
    sheet(Kt.dirt, 6, 4, (i, j) => { const a = -PI + (i / 6) * TAU, r = (j / 4) * (R - 0.1); const lx = Math.sin(a) * r, lz = -Math.cos(a) * r; const w = Pp(lx, lz); return [lx, meshY(L, w[0], w[1]) + 0.025, lz]; }, mudC,
      { colAt: (i, j) => [jit(mudC, rng, 0.25), 1 - j * 0.03], uv: (i, j, p) => [p[0] / 4, p[2] / 4] });
    ammoBox(Kt, 0.9, y0, -0.6, 0.4, rng);
    for (let i = 0; i < 6; i++) { const cx = rng.range(-1, 1), cz = rng.range(-1.4, -0.4), a = rng() * TAU; rod(Kt.metal, [cx, y0 + 0.03, cz], [cx + Math.cos(a) * 0.04, y0 + 0.03, cz + Math.sin(a) * 0.04], 0.006, 0.006, COL.brass, { seg: 4 }); }
    // optional roof of logs and earth over the front half, on four posts
    if (o.roof) {
      const ry = y0 + 1.95, w = (R + 0.3) * 2, d0 = -R - 0.55, d1 = 0.1;
      for (const [px, pz] of [[-R + 0.15, -R * 0.62], [R - 0.15, -R * 0.62], [-R + 0.25, 0], [R - 0.25, 0]]) {
        rod(Kt.bark, [px, y0 - 0.1, pz], [px, ry, pz], 0.09, 0.08, COL.log, { seg: 6, us: 1.5 });
        const w2 = Pp(px, pz); col(L, w2[0], w2[1], y0, 0.18, 1.95, 0.18, rot, POST, 'wood');
      }
      for (let k = 0; k < 11; k++) {
        const lz = d0 + (k + 0.5) * (d1 - d0) / 11;
        rod(Kt.bark, [-w / 2, ry + 0.09, lz], [w / 2, ry + 0.09 + (rng() - 0.5) * 0.04, lz + (rng() - 0.5) * 0.06], 0.1, 0.09, jit(COL.log, rng, 0.2), { seg: 6, us: 1.5, capCol: COL.cut });
      }
      sheet(Kt.dirt, 6, 4, (i, j) => { const lx = -w / 2 - 0.1 + (i / 6) * (w + 0.2), lz = d0 - 0.15 + (j / 4) * (d1 - d0 + 0.3); const bump = Math.sin((i / 6) * PI) * Math.sin((j / 4) * PI) * 0.3; return [lx, ry + 0.17 + bump, lz]; }, COL.earth,
        { flip: true, colAt: (i, j) => [jit(rng() < 0.5 ? COL.moss : COL.earth, rng, 0.3), 1], uv: (i, j, p) => [p[0] / 4, p[2] / 4] });
      leaves(Kt.dirt, rng, 16, -w / 2, d0, w / 2, d1, (lx, lz) => ry + 0.17 + Math.sin(clamp01((lx + w / 2) / w) * PI) * Math.sin(clamp01((lz - d0) / (d1 - d0)) * PI) * 0.3);
      const wc = Pp(0, (d0 + d1) / 2);
      col(L, wc[0], wc[1], ry, w, 0.45, d1 - d0, rot, WALL, 'dirt');
    }
    noFrame();
    return { x, z, rot, seats };
  });
}

// ═════════════════════════════ SƏNGƏR — dug trench line ═════════════════════════════
/**
 * A zig-zag fighting trench. The floor stays at ground level and the sides are
 * built up from the spoil (the terrain mesh is too coarse to cut a 2 m trench
 * into), so it is 1.45 m deep on the enemy side and 1.25 m at the back:
 * a soldier inside is covered to the chest, a crouching player completely.
 * Inside: plank or wattle revetment, duckboards, a fire step, ammunition niches;
 * both ends taper into exit ramps. The parados (back wall) is low enough to
 * vault, the parapet can be climbed from the berm outside.
 * pts: [[x,z], ...] centre line; face: yaw of the field of fire.
 * Returns { seats: [[x,z,face],...] } fire positions along the parapet.
 */
export function trench(L, pts, face, o = {}) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(pts[0][0], pts[0][1], 2));
    const W = o.width ?? 2.4, HF = 1.45, HR = 1.25, TF = 0.9, TR = 0.75;
    const fx = -Math.sin(face), fz = -Math.cos(face);
    const n = pts.length;
    // segment directions and left normals
    const seg = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], len = Math.hypot(dx, dz);
      const ux = dx / len, uz = dz / len, nx = -uz, nz = ux;                          // normal to the left (x→z: rotate +90)
      seg.push({ ux, uz, nx, nz, len, sF: nx * fx + nz * fz >= 0 ? 1 : -1 });
    }
    // mitred offset of vertex i to side sg (+1 left normal) by distance off
    const offAt = (i, sideOf, off) => {
      const a = seg[Math.max(0, i - 1)], b = seg[Math.min(n - 2, i)];
      const sa = sideOf(a), sb = sideOf(b);
      let mx = a.nx * sa + b.nx * sb, mz = a.nz * sa + b.nz * sb;
      const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
      const dot = Math.max(0.5, mx * a.nx * sa + mz * a.nz * sa);
      return [pts[i][0] + mx * off / dot, pts[i][1] + mz * off / dot];
    };
    const seats = [];
    const mudC = mix(COL.mud, COL.earthDk, 0.4);
    for (let i = 0; i < n - 1; i++) {
      const S = seg[i];
      for (const front of [true, false]) {
        const sideOf = (sg) => (front ? sg.sF : -sg.sF), sd = sideOf(S);
        const a = offAt(i, sideOf, W / 2), b = offAt(i + 1, sideOf, W / 2);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]), np = Math.max(1, Math.ceil(len / 2.6));
        const H = front ? HF : HR, T = front ? TF : TR;
        const ox = S.nx * sd, oz = S.nz * sd;                    // outward (into the wall)
        const rot = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
        const style = (seedOf(a[0], a[1], 7) % 3);               // 0 planks, 1 wattle, 2 logs
        for (let p = 0; p < np; p++) {
          const t0 = p / np, t1 = (p + 1) / np;
          const ax = lerp(a[0], b[0], t0), az = lerp(a[1], b[1], t0), bx = lerp(a[0], b[0], t1), bz = lerp(a[1], b[1], t1);
          const pl = len / np, mx = (ax + bx) / 2, mz = (az + bz) / 2;
          // taper at the two ends of the line: exit ramps
          const endA = i === 0 && p === 0, endB = i === n - 2 && p === np - 1;
          const g0 = L.gy(mx, mz), gmin = groundMin(L, [[ax, az], [bx, bz], [mx, mz]]);
          const base = gmin - 0.3;
          // colliders: the wall (vaultable only at the back), a low steppable berm outside it
          if (endA || endB) {
            const h1 = H * 0.62, h2 = H * 0.3;                    // two steps down to the ground
            const inner = endA ? 1 : -1;                          // which half is nearer the trench body
            for (const [frac, hh] of [[0.25 * inner, h1], [-0.25 * inner, h2]]) {
              const cx = mx + (bx - ax) * frac + ox * T / 2, cz = mz + (bz - az) * frac + oz * T / 2;
              col(L, cx, cz, base, pl / 2 + 0.05, g0 + hh - base, T, rot, WALL, 'dirt');
            }
          } else {
            col(L, mx + ox * T / 2, mz + oz * T / 2, base, pl + 0.3, g0 + H - base, T, rot, WALL, 'dirt');
            col(L, mx + ox * (T + 0.5), mz + oz * (T + 0.5), base, pl + 0.3, gmin + 0.38 - base, 1.0, rot, WALL, 'dirt');
            if (front) col(L, mx - ox * 0.22, mz - oz * 0.22, base, pl, gmin + 0.28 - base, 0.44, rot, WALL, 'dirt');   // fire step
          }
          // visuals in the piece's frame: local x along the wall, local z outward = sd·(left normal) → sign
          at(ax, 0, az, rot);
          const zs = (oz * Math.cos(rot) + ox * Math.sin(rot)) >= 0 ? 1 : -1;   // local +z is outward when zs = 1
          const Lz = (v) => v * zs;
          const fy = (u) => meshY(L, ax + (bx - ax) * (u / pl), az + (bz - az) * (u / pl));
          const hAt = (u) => { let h = H; if (endA) h *= lerp(0.12, 1, smoothstep(0, pl, u)); if (endB) h *= lerp(1, 0.12, smoothstep(0, pl, u)); return h; };
          const topE = (u) => fy(u) + hAt(u) - (front && style !== 2 ? 0.3 : 0.05);
          // revetment on the inner face
          const nu = Math.max(2, Math.round(pl / 0.65));
          if (style === 2) {        // horizontal logs held by stakes
            for (let r = 0; r < 6; r++) {
              const yr = 0.11 + r * 0.2, cl = jit(COL.log, rng, 0.25);
              if (yr > hAt(pl / 2) - 0.1) break;
              rod(Kt.bark, [-0.1, fy(0) + yr, Lz(0.1)], [pl + 0.1, fy(pl) + yr, Lz(0.1)], 0.1, 0.095, cl, { seg: 6, us: 1.5, capCol: COL.cut });
            }
          } else if (style === 0) { // planks
            const rows = Math.ceil((H - 0.1) / 0.24);
            for (let r = 0; r < rows; r++) {
              const yy = 0.12 + r * 0.24, cl = jit(rng() < 0.15 ? COL.plankDk : COL.plank, rng, 0.25);
              if (yy > hAt(pl / 2) - 0.15) break;
              box(Kt.wood, pl / 2, (fy(0) + fy(pl)) / 2 + yy, Lz(0.03), pl + 0.04, 0.22, 0.05, mul(cl, r === 0 ? 0.65 : 1), { us: 1.8, rz: Math.atan2(fy(pl) - fy(0), pl) + (rng() - 0.5) * 0.02 });
            }
          } else {                  // wattle: woven bands between stakes
            const rows = Math.ceil((H - 0.1) / 0.13);
            for (let r = 0; r < rows; r++) {
              const yy = 0.08 + r * 0.13;
              if (yy > hAt(pl / 2) - 0.12) break;
              for (let s = 0; s < nu; s++) {
                const u0 = (s / nu) * pl, u1 = ((s + 1) / nu) * pl, wv = ((r + s) % 2 ? 0.03 : -0.01);
                box(Kt.bark, (u0 + u1) / 2, (fy(u0) + fy(u1)) / 2 + yy, Lz(0.04 + wv), u1 - u0 + 0.06, 0.11, 0.05, jit(rng() < 0.5 ? COL.dryBrush : COL.log, rng, 0.3), { us: 1.5, kb: 0.8 });
              }
            }
          }
          if (style !== 2) for (let s = 0; s <= nu; s += (style === 0 ? 2 : 1)) {   // stakes
            const u = (s / nu) * pl;
            rod(Kt.bark, [u, fy(u) - 0.1, Lz(-0.03)], [u, topE(u) + 0.12, Lz(-0.03)], 0.05, 0.045, jit(COL.log, rng, 0.2), { seg: 5, us: 1.5, capCol: COL.cut });
          }
          // earth berm: flat top behind the revetment, then the outer slope down to the ground
          const nb = Math.max(2, Math.round(pl / 0.7));
          const prof = [[0.0, 0], [0.45, 0.05], [T + 0.1, -0.2], [T + 0.8, -0.85], [T + 1.6, -1]];
          sheet(Kt.dirt, nb, prof.length - 1, (ii, j) => {
            const u = -0.25 + (ii / nb) * (pl + 0.5), [d, hk] = prof[j];
            const wx2 = ax + (bx - ax) * (u / pl) + ox * d, wz2 = az + (bz - az) * (u / pl) + oz * d;
            const gyv = meshY(L, wx2, wz2), lump = (seedOf(wx2 * 3, wz2 * 3, 9) % 100) / 100 * 0.12;
            const y = j === prof.length - 1 ? gyv - 0.12 : lerp(topE(Math.min(pl, Math.max(0, u))) + (j === 1 ? 0.05 : 0) + lump, gyv, -hk) ;
            return [u, j === 0 ? topE(Math.min(pl, Math.max(0, u))) : y, Lz(d)];
          }, COL.earth, {
            flip: zs > 0,
            colAt: (ii, j) => { const t = j / (prof.length - 1); const c = mix(mix(COL.earth, COL.earthDk, rng() * 0.4), rng() < 0.5 ? COL.moss : COL.grass, smoothstep(0.35, 1, t) * 0.8); return [rng() < 0.07 ? COL.leaf : c, 0.95 + rng() * 0.1]; },
            uv: (ii, j, pp) => [pp[0] / 4, (pp[1] + pp[2]) / 4],
          });
          leaves(Kt.dirt, rng, 5, 0, Lz(0.1), pl, Lz(T + 1.2), (u) => topE(clamp01(u / pl) * pl) - 0.3);
          // parapet cap: sandbags on the enemy side (or a log), sod at the back
          noFrame();
          if (front && !(endA || endB)) {
            const cxp = mx + ox * 0.36, czp = mz + oz * 0.36;
            if (style !== 2) buildProp(L, 'sandbags', { x: cxp, z: czp, y: g0 + H - 0.3, len: pl + 0.05, rot, h: 0.3 });
            else { at(ax, 0, az, rot); rod(Kt.bark, [-0.05, topE(0) + 0.12, Lz(0.36)], [pl + 0.05, topE(pl) + 0.12, Lz(0.36)], 0.13, 0.12, jit(COL.log, rng, 0.2), { seg: 7, us: 1.5, capCol: COL.cut }); noFrame(); }
            // a fire position every other piece: a seat behind the parapet
            if ((p + i) % 2 === 0) seats.push([mx - ox * 0.55, mz - oz * 0.55, face]);
          }
          at(ax, 0, az, rot);
          // fire step: earth bench with a plank edge
          if (front && !(endA || endB)) {
            box(Kt.dirt, pl / 2, (fy(0) + fy(pl)) / 2 + 0.12, Lz(-0.22), pl, 0.28, 0.44, jit(COL.earth, rng, 0.2), { us: 4, rz: Math.atan2(fy(pl) - fy(0), pl) });
            box(Kt.wood, pl / 2, (fy(0) + fy(pl)) / 2 + 0.13, Lz(-0.45), pl, 0.26, 0.04, COL.plankDk, { us: 1.8, rz: Math.atan2(fy(pl) - fy(0), pl) });
            // ammunition niche in every third piece
            if ((p + i * 2) % 3 === 1) {
              const u = pl * 0.5, yb = fy(u) + 0.45;
              box(Kt.dark, u, yb + 0.2, Lz(0.06), 0.8, 0.42, 0.04, mul(COL.ash, 0.6), { skip: 0 });
              box(Kt.wood, u, yb + 0.43, Lz(0.0), 0.86, 0.05, 0.12, COL.plankDk, { us: 1.8 });
              ammoBox(Kt, u - 0.1, yb, Lz(0.0), 0, rng, 0.8);
            }
          }
          noFrame();
        }
      }
      // floor: mud strip and a duckboard walk along the centre line
      const [p0, p1] = [pts[i], pts[i + 1]];
      const rot = Math.atan2(-(p1[1] - p0[1]), p1[0] - p0[0]), len = S.len;
      at(p0[0], 0, p0[1], rot);
      const ns = Math.max(2, Math.round(len / 1.2));
      sheet(Kt.dirt, ns, 2, (ii, j) => {
        const u = -0.4 + (ii / ns) * (len + 0.8), v = -W / 2 - 0.05 + (j / 2) * (W + 0.1);
        const wx = p0[0] + S.ux * u - S.uz * v, wz = p0[1] + S.uz * u + S.ux * v;
        return [u, meshY(L, wx, wz) + 0.03 + (j === 1 ? -0.015 : 0), v];
      }, mudC, { flip: true, colAt: (ii, j) => [jit(mudC, rng, 0.3), j === 1 ? 0.85 : 1], uv: (ii, j, pp) => [pp[0] / 4, pp[2] / 4] });
      const yAt = (u) => meshY(L, p0[0] + S.ux * u, p0[1] + S.uz * u);
      const slats = Math.floor(len / 0.24);
      for (const v of [-0.3, 0.3]) rod(Kt.bark, [0.1, yAt(0.1) + 0.06, v], [len - 0.1, yAt(len - 0.1) + 0.06, v], 0.04, 0.04, COL.logDk, { seg: 4 });
      for (let k = 0; k < slats; k++) {
        if (rng() < 0.06) continue;                                          // a missing slat
        const u = 0.15 + k * 0.24;
        box(Kt.wood, u, yAt(u) + 0.11, (rng() - 0.5) * 0.04, 0.12, 0.03, 0.8, jit(rng() < 0.5 ? COL.plankDk : COL.plank, rng, 0.3), { us: 1.8, ry: (rng() - 0.5) * 0.06, kb: 0.6 });
      }
      noFrame();
    }
    return { seats };
  });
}

// ═════════════════════════════ ALAÇIQ — herders' felt shelter ═════════════════════════════
const DOME = [[2.08, -0.08], [2.12, 0.45], [2.06, 0.95], [1.86, 1.45], [1.5, 1.88], [0.98, 2.2], [0.34, 2.36]];
/**
 * A round felt shelter on a frame of bent poles, patched with hides and tarpaulin
 * and weighed down with brushwood; a low entrance at local −Z, a hearth with a
 * kettle and bedding inside. o: { lamp (a lantern inside), fire (a campfire outside
 * the entrance), bed (default true) }. Returns { x, z, rot, inside: [[x,z],...], door: [x,z] }.
 */
export function alacig(L, x, z, rot, o = {}) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 3)), Pp = frameP(x, z, rot), y0 = L.gy(x, z);
    const nu = 16, nv = DOME.length - 1, door = (i) => i === nu / 2 - 1 || i === nu / 2;
    const ang = (i) => -PI + (i / nu) * TAU;
    const at3 = (i, j, out = 0) => { const a = ang(i), [r, y] = DOME[j]; const rr = r + out; const lx = Math.sin(a) * rr, lz = -Math.cos(a) * rr; const w = Pp(lx, lz); return [lx, (j === 0 ? meshY(L, w[0], w[1]) - 0.06 : y0 + y), lz]; };
    at(x, 0, z, rot);
    // felt shell (cloth is double sided, so it reads from inside too)
    sheet(Kt.cloth, nu, nv, (i, j) => at3(i, j), COL.felt, {
      skip: (i, j) => door(i) && j < 3, flip: true,
      colAt: (i, j) => { const soot = smoothstep(3, 6, j) * 0.35, dirt = j === 0 ? 0.55 : j === 1 ? 0.85 : 1; return [mix(jit(rng() < 0.25 ? COL.feltDk : COL.felt, rng, 0.12), COL.ash, soot), dirt]; },
      uv: (i, j) => [i / nu * 8, j * 0.6],
    });
    // reed-mat skirt round the bottom
    sheet(Kt.cloth, nu, 1, (i, j) => at3(i, j, 0.05), COL.dryBrush, { skip: (i) => door(i), flip: true, colAt: (i) => [jit(COL.dryBrush, rng, 0.25), i % 2 ? 0.8 : 1], uv: (i, j) => [i * 2, j * 3] });
    // patches: a tarpaulin over the weather side, two hides near the top
    const patch = (i0, i1, j0, j1, out, c, amt) => sheet(Kt.cloth, i1 - i0, j1 - j0, (i, j) => at3(i0 + i, j0 + j, out), c, { flip: true, colAt: () => [jit(c, rng, amt), 1], uv: (i, j) => [i, j] });
    const ti = 1 + (seedOf(x, z, 4) % 2);
    patch(ti, ti + 4, 2, 5, 0.06, COL.tarp, 0.1);
    patch(nu - ti - 3, nu - ti, 3, 6, 0.07, COL.hide, 0.2);
    patch(ti + 6, ti + 8, 4, 6, 0.08, mul(COL.hide, 0.8), 0.2);
    // ropes round the dome and pegged guy lines
    for (const j of [1.4, 3.3]) {
      const jj = Math.floor(j), f = j - jj;
      for (let i = 0; i < nu; i++) {
        if (door(i) && j < 3) continue;
        const pa = at3(i, jj, 0.09), pb = at3(i + 1, jj, 0.09), qa = at3(i, jj + 1, 0.09), qb = at3(i + 1, jj + 1, 0.09);
        rod(Kt.bark, mix(pa, qa, f), mix(pb, qb, f), 0.016, 0.016, COL.rope, { seg: 3, caps: false });
      }
    }
    for (const i of [2, 6, 12, 15]) { const pa = at3(i, 2, 0.08), a = ang(i); const peg = [Math.sin(a) * 3.0, 0, -Math.cos(a) * 3.0]; const w = Pp(peg[0], peg[2]); peg[1] = meshY(L, w[0], w[1]) + 0.12; rod(Kt.bark, pa, peg, 0.012, 0.012, COL.rope, { seg: 3, caps: false }); rod(Kt.bark, [peg[0], peg[1] - 0.2, peg[2]], [peg[0], peg[1] + 0.06, peg[2]], 0.03, 0.025, COL.cut, { seg: 4 }); }
    // brushwood and poles laid over the roof
    for (let k = 0; k < 9; k++) {
      const i = Math.floor(rng() * nu), a = at3(i, 6, 0.1), b = at3((i + 2) % nu, 3, 0.12);
      branch(Kt.bark, a, b, 0.025, jit(COL.logDk, rng, 0.3), -0.12);
    }
    // smoke hole: a dark wooden ring at the crown
    for (let i = 0; i < 8; i++) { const a0 = (i / 8) * TAU, a1 = ((i + 1) / 8) * TAU; rod(Kt.bark, [Math.cos(a0) * 0.34, y0 + 2.37, Math.sin(a0) * 0.34], [Math.cos(a1) * 0.34, y0 + 2.37, Math.sin(a1) * 0.34], 0.04, 0.04, COL.logDk, { seg: 4, caps: false }); }
    box(Kt.dark, 0, y0 + 2.33, 0, 0.6, 0.02, 0.6, COL.ash, { skip: 0 });
    // entrance: a frame of poles and the felt door rolled up over it
    const dz = -2.02, dw = 0.78;
    for (const sx of [-1, 1]) rod(Kt.bark, [sx * dw, y0 - 0.1, dz], [sx * dw * 0.92, y0 + 1.55, dz - 0.02], 0.05, 0.045, COL.log, { seg: 5 });
    rod(Kt.bark, [-dw - 0.15, y0 + 1.52, dz - 0.02], [dw + 0.15, y0 + 1.52, dz - 0.02], 0.045, 0.045, COL.log, { seg: 5, capCol: COL.cut });
    rod(Kt.cloth, [-dw - 0.1, y0 + 1.64, dz - 0.06], [dw + 0.1, y0 + 1.64, dz - 0.06], 0.11, 0.11, COL.feltDk, { seg: 8 });
    // inside: hearth with stones and ash, a kettle, bedding, a pack
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + rng() * 0.2; box(Kt.stone, Math.cos(a) * 0.36, y0 + 0.06, Math.sin(a) * 0.36 + 0.1, 0.18, 0.14, 0.14, jit(COL.stoneDk, rng, 0.3), { ry: -a, us: 2.6 }); }
    rod(Kt.dark, [0, y0 - 0.02, 0.1], [0, y0 + 0.03, 0.1], 0.3, 0.27, COL.ash, { seg: 10 });
    for (let i = 0; i < 4; i++) { const a = rng() * TAU; rod(Kt.bark, [Math.cos(a) * 0.05, y0 + 0.05, 0.1 + Math.sin(a) * 0.05], [Math.cos(a) * 0.3, y0 + 0.08, 0.1 + Math.sin(a) * 0.3], 0.025, 0.02, mul(COL.ash, 1.4), { seg: 4 }); }
    kettle(Kt, 0.45, y0, -0.25, rng);
    if (o.bed !== false) {
      const blank = [C(0x6a4a3a), C(0x4a5040), C(0x7a6a52), C(0x5a3a32)];
      for (const [bx2, bz2, ba] of [[-1.15, 0.45, 1.25], [1.1, 0.6, -1.3]]) {
        box(Kt.cloth, bx2, y0 + 0.05, bz2, 1.75, 0.12, 0.7, mul(COL.feltDk, 0.85), { ry: ba, us: 1.2 });
        box(Kt.cloth, bx2 + Math.cos(ba) * 0.15, y0 + 0.13, bz2 - Math.sin(ba) * 0.15, 1.2, 0.05, 0.74, jit(rng.pick(blank), rng, 0.2), { ry: ba + 0.06, us: 1.2 });
        const ex = bx2 - Math.cos(ba) * 0.72, ez = bz2 + Math.sin(ba) * 0.72;
        rod(Kt.cloth, [ex - Math.sin(ba) * 0.28, y0 + 0.18, ez - Math.cos(ba) * 0.28], [ex + Math.sin(ba) * 0.28, y0 + 0.18, ez + Math.cos(ba) * 0.28], 0.09, 0.09, COL.canvas, { seg: 7 });
      }
    }
    box(Kt.cloth, -0.3, y0 + 0.22, 1.6, 0.45, 0.45, 0.28, mul(COL.olive, 1.1), { ry: 0.3, us: 1.2 });   // a pack against the wall
    ammoBox(Kt, 0.6, y0, 1.55, -0.2, rng);
    noFrame();
    // colliders: a ring of felt walls with a gap at the door, a low lintel, a sight-blocking crown
    const nRing = 12, gapA = 0.5, rr = 2.0;
    for (let k = 0; k < nRing; k++) {
      const a0 = gapA + (k / nRing) * (TAU - 2 * gapA), a1 = gapA + ((k + 1) / nRing) * (TAU - 2 * gapA), am = (a0 + a1) / 2;
      const w = Pp(Math.sin(am) * rr, -Math.cos(am) * rr), len = 2 * rr * Math.sin((a1 - a0) / 2) + 0.1;
      col(L, w[0], w[1], y0 - 0.2, len, 1.75, 0.24, rot - am, THIN, 'dirt');
    }
    const dpos = Pp(0, -rr);
    col(L, dpos[0], dpos[1], y0 + 1.72, 1.6, 0.5, 0.3, rot, F.SOLID | F.VISION, 'dirt');
    col(L, x, z, y0 + 1.55, 2.9, 0.85, 2.9, rot, SOFT, 'dirt');
    if (o.lamp) L.lamps.push({ x, y: y0 + 1.2, z, r: 6, i: 0.55, flicker: true, color: 0xffb060 });
    if (o.lamp) { at(x, 0, z, rot); lantern(Kt, -0.5, y0 + 0.02, 1.0); noFrame(); }
    const out = Pp(0, -3.3);
    if (o.fire) L.campfire(out[0], out[1]);
    return { x, z, rot, door: Pp(0, -2.6), inside: [Pp(-0.6, 0.9), Pp(0.7, -0.6), Pp(0.2, 1.3)], fire: o.fire ? out : null };
  });
}
/** A kerosene lantern: glass glows, frame of wire. */
function lantern(Kt, x, y, z) {
  rod(Kt.metal, [x, y, z], [x, y + 0.06, z], 0.07, 0.07, COL.gun, { seg: 8 });
  rod(Kt.glow, [x, y + 0.06, z], [x, y + 0.2, z], 0.05, 0.045, C(0xffc070), { seg: 8, caps: false });
  rod(Kt.metal, [x, y + 0.2, z], [x, y + 0.26, z], 0.06, 0.02, COL.gun, { seg: 8 });
}

/**
 * A rough lean-to: a ridge pole on two forked posts, rafters down to the
 * ground behind, thatched with cut boughs or a tarpaulin; open to local −Z.
 * Returns { inside: [[x,z]] }.
 */
export function leanTo(L, x, z, rot, o = {}) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 5)), Pp = frameP(x, z, rot), y0 = L.gy(x, z);
    const w = 3.2, hr = 1.65, back = 2.0, tarp = o.tarp ?? rng() < 0.5;
    at(x, 0, z, rot);
    for (const sx of [-1, 1]) {
      rod(Kt.bark, [sx * w / 2, y0 - 0.15, 0], [sx * w / 2, y0 + hr + 0.15, 0], 0.07, 0.06, COL.log, { seg: 6, us: 1.5 });
      rod(Kt.bark, [sx * w / 2, y0 + hr - 0.05, 0], [sx * (w / 2 + 0.15), y0 + hr + 0.2, -0.05], 0.035, 0.03, COL.log, { seg: 4 });
      const w2 = Pp(sx * w / 2, 0); col(L, w2[0], w2[1], y0, 0.16, hr, 0.16, rot, POST, 'wood');
    }
    rod(Kt.bark, [-w / 2 - 0.3, y0 + hr + 0.05, 0], [w / 2 + 0.3, y0 + hr + 0.05, 0], 0.065, 0.06, COL.log, { seg: 6, us: 1.5, capCol: COL.cut });
    for (let k = 0; k < 6; k++) { const lx = -w / 2 + 0.15 + k * (w - 0.3) / 5; rod(Kt.bark, [lx, y0 + hr + 0.1, -0.15], [lx + (rng() - 0.5) * 0.15, meshY(L, ...Pp(lx, back)) - 0.05, back], 0.04, 0.035, jit(COL.log, rng, 0.25), { seg: 4 }); }
    const roof = (i, j) => { const lx = -w / 2 - 0.25 + (i / 6) * (w + 0.5), t = j / 4, lz = lerp(-0.2, back + 0.15, t); const gy2 = meshY(L, ...Pp(lx, lz)); return [lx, lerp(y0 + hr + 0.15, gy2 - 0.05, t) + Math.sin(t * PI) * 0.06 + (rng() - 0.5) * 0.05, lz]; };
    if (tarp) sheet(Kt.cloth, 6, 4, roof, COL.tarp, { colAt: () => [jit(COL.tarp, rng, 0.12), 1], uv: (i, j) => [i, j] });
    else sheet(Kt.cloth, 6, 4, roof, COL.brush, { colAt: () => [jit(rng() < 0.3 ? COL.dryBrush : COL.brush, rng, 0.35), 1], uv: (i, j) => [i, j] });
    for (let k = 0; k < (tarp ? 4 : 10); k++) { const p = roof(rng.int(0, 6), rng.int(0, 3)); brushClump(Kt.cloth, p[0], p[1] - 0.1, p[2], 0.45, rng, rng() < 0.3); }
    // bed of boughs inside and a pack
    sheet(Kt.cloth, 3, 2, (i, j) => { const lx = -1.1 + i * 0.73, lz = 0.25 + j * 0.55; return [lx, meshY(L, ...Pp(lx, lz)) + 0.06 + (rng() * 0.04), lz]; }, COL.brushDk, { colAt: () => [jit(COL.brushDk, rng, 0.3), 1], uv: (i, j) => [i, j] });
    box(Kt.cloth, 1.0, y0 + 0.2, 0.7, 0.42, 0.4, 0.26, mul(COL.olive, 1.1), { ry: -0.4, us: 1.2 });
    leaves(Kt.dirt, rng, 14, -w / 2, -1.5, w / 2, back, (lx, lz) => meshY(L, ...Pp(lx, lz)));
    noFrame();
    // the sloped back blocks sight and slows bullets; the front is open
    const c1 = Pp(0, back * 0.72), c2 = Pp(0, back * 0.25);
    col(L, c1[0], c1[1], y0 - 0.1, w, 0.95, back * 0.5, rot, THIN, 'dirt');
    col(L, c2[0], c2[1], y0 + 0.95, w, hr - 0.75, back * 0.5, rot, SOFT, 'dirt');
    return { inside: [Pp(-0.6, 0.4), Pp(0.5, 0.3)] };
  });
}

/** A curved brushwood windbreak (stakes, woven brush, cut boughs), about 1.4 m tall; arc bulging to local +Z. */
export function windbreak(L, x, z, rot, len = 4) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 6)), Pp = frameP(x, z, rot);
    const n = Math.max(3, Math.round(len / 0.8)), bow = len * 0.18, h = 1.35;
    const pt = (t) => { const lx = (t - 0.5) * len, lz = Math.sin(t * PI) * bow; return [lx, lz]; };
    at(x, 0, z, rot);
    for (let k = 0; k <= n; k++) {
      const [lx, lz] = pt(k / n), gy2 = meshY(L, ...Pp(lx, lz));
      rod(Kt.bark, [lx, gy2 - 0.1, lz], [lx + (rng() - 0.5) * 0.1, gy2 + h + rng.range(0, 0.2), lz], 0.04, 0.03, jit(COL.log, rng, 0.2), { seg: 4 });
    }
    for (let r = 0; r < 8; r++) for (let k = 0; k < n; k++) {
      const [ax, az] = pt(k / n), [bx, bz] = pt((k + 1) / n), wv = (r + k) % 2 ? 0.04 : -0.04;
      const ya = meshY(L, ...Pp(ax, az)) + 0.12 + r * 0.16, yb = meshY(L, ...Pp(bx, bz)) + 0.12 + r * 0.16;
      rod(Kt.bark, [ax, ya, az + wv], [bx, yb, bz - wv], 0.03, 0.03, jit(rng() < 0.5 ? COL.dryBrush : COL.logDk, rng, 0.3), { seg: 4, caps: false });
    }
    for (let k = 0; k < n * 2; k++) { const [lx, lz] = pt(rng()), gy2 = meshY(L, ...Pp(lx, lz)); brushClump(Kt.cloth, lx, gy2 + rng.range(0.4, 1.0), lz + 0.08, 0.45, rng, rng() < 0.5); }
    noFrame();
    for (let k = 0; k < n; k++) {
      const [ax, az] = pt(k / n), [bx, bz] = pt((k + 1) / n), m = Pp((ax + bx) / 2, (az + bz) / 2);
      col(L, m[0], m[1], L.gy(m[0], m[1]) - 0.2, Math.hypot(bx - ax, bz - az) + 0.1, h + 0.2, 0.3, rot - Math.atan2(bz - az, bx - ax), THIN, 'wood');
    }
  });
}

// ═════════════════════════════ observation tower ═════════════════════════════
/**
 * Timber tower: four raked log legs with cross braces, a plank platform with a
 * breast-high rail, a tin roof on the legs and a ladder at the back (local +Z).
 * Returns { x, z, top } (the platform floor; a `fixed` sentry stands at y: top).
 */
export function watchtower(L, x, z, rot, o = {}) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 12)), Pp = frameP(x, z, rot), y0 = L.gy(x, z);
    const H = o.h ?? 4.6, top = y0 + H, b = 1.3, t = 1.0, D = 1.25;
    at(x, 0, z, rot);
    const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [sx, sz] of legs) {
      const gy2 = meshY(L, ...Pp(sx * b, sz * b));
      rod(Kt.bark, [sx * b, gy2 - 0.2, sz * b], [sx * t, top + 2.05, sz * t], 0.12, 0.09, jit(COL.log, rng, 0.15), { seg: 7, us: 1.5, capCol: COL.cut });
      const w = Pp(sx * (b + t) / 2, sz * (b + t) / 2); col(L, w[0], w[1], y0 - 0.2, 0.26, H, 0.26, rot, POST, 'wood');
    }
    const legAt = (sx, sz, y) => { const f = (y - y0) / (H + 2.05); const r = lerp(b, t, f); return [sx * r, y, sz * r]; };
    for (let k = 0; k < 4; k++) {
      const [ax, az] = legs[k], [bx, bz] = legs[(k + 1) % 4];
      for (const [ya, yb] of [[y0 + 0.4, y0 + H * 0.5], [y0 + H * 0.5, top - 0.25]]) {
        rod(Kt.bark, legAt(ax, az, ya), legAt(bx, bz, yb), 0.05, 0.05, COL.logDk, { seg: 5 });
        rod(Kt.bark, legAt(bx, bz, ya), legAt(ax, az, yb), 0.05, 0.05, COL.logDk, { seg: 5 });
      }
      rod(Kt.bark, legAt(ax, az, top - 0.18), legAt(bx, bz, top - 0.18), 0.08, 0.08, COL.log, { seg: 6 });
    }
    for (let k = 0; k < 9; k++) box(Kt.wood, -D + (k + 0.5) * (2 * D / 9), top - 0.05, 0, 2 * D / 9 - 0.02, 0.1, 2 * D + 0.1, jit(COL.plank, rng, 0.2), { us: 1.8, skip: 0 });
    const railSide = (ax, az, bx, bz, gap) => {
      const len = Math.hypot(bx - ax, bz - az), ry = Math.atan2(-(bz - az), bx - ax);
      for (let r = 0; r < 4; r++) {
        const yy = top + 0.18 + r * 0.24;
        if (gap) for (const e of [-1, 1]) { const cx = (ax + bx) / 2 + e * (len / 4 + 0.2) * Math.cos(ry), cz = (az + bz) / 2 - e * (len / 4 + 0.2) * Math.sin(ry); box(Kt.wood, cx, yy, cz, len / 2 - 0.4, 0.2, 0.05, jit(COL.plank, rng, 0.25), { ry, us: 1.8, skip: 0 }); }
        else box(Kt.wood, (ax + bx) / 2, yy, (az + bz) / 2, len, 0.2, 0.05, jit(COL.plank, rng, 0.25), { ry, us: 1.8, skip: 0 });
      }
    };
    railSide(-D, -D, D, -D); railSide(D, -D, D, D); railSide(-D, D, -D, -D); railSide(D, D, -D, D, true);
    box(Kt.paint, 0, top + 2.15, 0.1, 2 * D + 0.7, 0.05, 2 * D + 0.9, mix(jit(C(0x7a7a72), rng, 0.15), C(0x6a4a32), 0.4), { rx: 0.12, us: 1.6, skip: 0 });
    box(Kt.cloth, 0, top + 1.55, -D - 0.03, 2 * D, 0.5, 0.02, COL.tarp, { skip: 0 });
    box(Kt.paint, 0.8, top + 0.12, -0.7, 0.24, 0.14, 0.12, COL.olive, { us: 1.6 });
    ammoBox(Kt, -0.7, top, -0.8, 0.3, rng);
    noFrame();
    col(L, x, z, top - 0.2, 2 * D, 0.2, 2 * D, rot, WALL, 'wood');
    for (const [lx, lz, w, d] of [[0, -D, 2 * D, 0.1], [D, 0, 0.1, 2 * D], [-D, 0, 0.1, 2 * D], [-D * 0.62, D, D * 0.76, 0.1], [D * 0.62, D, D * 0.76, 0.1]]) { const p = Pp(lx, lz); col(L, p[0], p[1], top, w, 1.05, d, rot, THIN, 'woodThin'); }
    col(L, x, z, top + 2.08, 2 * D + 0.5, 0.14, 2 * D + 0.5, rot, F.SOLID | F.VISION | F.BULLET, 'metal');
    const lf = Pp(0, D + 0.4);
    L.ladder(lf[0], lf[1], rot, top - L.gy(lf[0], lf[1]) + 0.1);
    return { x, z, top };
  });
}

// ═════════════════════════════ dugout / command post ═════════════════════════════
/**
 * Log-and-earth bunker dug into the ground: a log front with a door and a firing
 * slit (local −Z), earth banked over the sides, back and roof; inside a map
 * table, a radio, a bench and a lantern. Returns { inside: [[x,z],...], door: [x,z] }.
 */
export function dugout(L, x, z, rot) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 13)), Pp = frameP(x, z, rot), y0 = L.gy(x, z);
    const hx = 1.6, hz = 1.5, Hc = 2.05, dl = -1.3, dr = -0.3, s0 = 0.25, s1 = 1.15, sy0 = 1.2, sy1 = 1.42;
    at(x, 0, z, rot);
    for (let r = 0; r < 10; r++) {
      const yb = y0 - 0.05 + r * 0.21, yc = yb + 0.105, cl = jit(COL.log, rng, 0.2);
      const runs = [];
      let from = -hx - 0.35;
      if (yb < y0 + 1.85) { runs.push([from, dl]); from = dr; }
      if (yc > y0 + sy0 && yc < y0 + sy1 + 0.05) { runs.push([from, s0]); from = s1; }
      runs.push([from, hx + 0.35]);
      for (const [a, b] of runs) if (b - a > 0.1) rod(Kt.bark, [a, yc, -hz - 0.12], [b, yc, -hz - 0.12 + (rng() - 0.5) * 0.04], 0.105, 0.1, cl, { seg: 6, us: 1.5, capCol: COL.cut });
    }
    for (const sx of [dl - 0.06, dr + 0.06]) rod(Kt.bark, [sx, y0 - 0.1, -hz - 0.28], [sx, y0 + Hc + 0.1, -hz - 0.28], 0.08, 0.075, COL.logDk, { seg: 6 });
    rod(Kt.bark, [dl - 0.3, y0 + 1.92, -hz - 0.3], [dr + 0.3, y0 + 1.92, -hz - 0.3], 0.09, 0.09, COL.logDk, { seg: 6, capCol: COL.cut });
    box(Kt.wood, (s0 + s1) / 2, y0 + sy0 - 0.03, -hz - 0.2, s1 - s0 + 0.1, 0.06, 0.4, COL.plankDk, { us: 1.8, skip: 0 });
    box(Kt.wood, 0, y0 + Hc / 2, hz + 0.05, 2 * hx, Hc, 0.1, mul(COL.plankDk, 0.8), { us: 1.8 });
    for (const sx of [-1, 1]) box(Kt.wood, sx * (hx + 0.05), y0 + Hc / 2, 0, 0.1, Hc, 2 * hz, mul(COL.plankDk, 0.8), { us: 1.8 });
    for (let k = 0; k < 8; k++) box(Kt.wood, -hx + (k + 0.5) * (2 * hx / 8), y0 + 0.02, 0, 2 * hx / 8 - 0.02, 0.05, 2 * hz, jit(COL.plankDk, rng, 0.25), { us: 1.8 });
    for (let k = 0; k < 13; k++) rod(Kt.bark, [-hx - 0.5, y0 + Hc + 0.1, -hz - 0.25 + k * 0.26], [hx + 0.5, y0 + Hc + 0.1, -hz - 0.25 + k * 0.26], 0.12, 0.11, jit(COL.log, rng, 0.2), { seg: 6, us: 1.5, capCol: COL.cut });
    const ex = hx + 2.6, ez0 = -hz - 0.35, ez1 = hz + 2.6;
    sheet(Kt.dirt, 10, 8, (i, j) => {
      const lx = -ex + (i / 10) * 2 * ex, lz = ez0 + (j / 8) * (ez1 - ez0), ground = meshY(L, ...Pp(lx, lz));
      const ox = Math.max(0, Math.abs(lx) - hx - 0.3) / 2.3, oz = Math.max(0, lz - hz - 0.3) / 2.3, o2 = Math.min(1, Math.hypot(ox, oz));
      const roofY = y0 + Hc + 0.45 + Math.cos(Math.min(1, Math.hypot(lx / (hx + 0.3), (lz - 0.2) / (hz + 0.3))) * PI / 2) * 0.3;
      return [lx, lerp(roofY, ground - 0.1, smoothstep(0, 1, o2)) + (seedOf(lx * 5, lz * 5, 3) % 100) / 100 * 0.06, lz];
    }, COL.earth, { flip: true, colAt: () => [jit(rng() < 0.45 ? COL.moss : rng() < 0.2 ? COL.leaf : COL.earth, rng, 0.25), 1], uv: (i, j, p) => [p[0] / 4, p[2] / 4] });
    // the front face of the earth bank either side of the log front and over its top edge
    const mY = (lx, lz) => { const ox = Math.max(0, Math.abs(lx) - hx - 0.3) / 2.3, o2 = Math.min(1, ox); const roofY = y0 + Hc + 0.45 + Math.cos(Math.min(1, Math.hypot(lx / (hx + 0.3), (lz - 0.2) / (hz + 0.3))) * PI / 2) * 0.3; return lerp(roofY, meshY(L, ...Pp(lx, lz)) - 0.1, smoothstep(0, 1, o2)); };
    sheet(Kt.dirt, 10, 1, (i, j) => { const lx = -ex + (i / 10) * 2 * ex; return j ? [lx, mY(lx, ez0), ez0] : [lx * 1.04, Math.abs(lx) < hx + 0.3 ? y0 + Hc + 0.1 : meshY(L, ...Pp(lx, ez0 - 0.9)) - 0.1, ez0 - (Math.abs(lx) < hx + 0.3 ? 0.05 : 0.9)]; }, COL.earth,
      { flip: true, colAt: () => [jit(rng() < 0.3 ? COL.moss : COL.earthDk, rng, 0.25), 1], uv: (i, j, p) => [p[0] / 4, p[1] / 4] });
    leaves(Kt.dirt, rng, 20, -hx, -hz, hx, hz, () => y0 + Hc + 0.72);
    noFrame();
    for (const lx of [-hx - 0.9, hx + 0.9]) { const p = Pp(lx, -hz - 0.55); buildProp(L, 'sandbags', { x: p[0], z: p[1], y: L.gy(p[0], p[1]), len: 1.2, rot: rot + PI / 2, h: 0.9 }); col(L, p[0], p[1], L.gy(p[0], p[1]) - 0.1, 1.2, 1.0, 0.6, rot + PI / 2, WALL, 'dirt'); }
    at(x, 0, z, rot);
    for (const [lx, lz] of [[-0.55, 0.55], [0.55, 0.55], [-0.55, 1.15], [0.55, 1.15]]) box(Kt.wood, lx, y0 + 0.38, lz, 0.06, 0.76, 0.06, COL.plankDk, { us: 1.8 });
    box(Kt.wood, 0, y0 + 0.79, 0.85, 1.3, 0.05, 0.75, COL.plank, { us: 1.8, skip: 0 });
    box(Kt.cloth, 0.05, y0 + 0.82, 0.85, 0.9, 0.006, 0.6, C(0xd8d0b0), { ry: 0.08 });
    for (let k = 0; k < 6; k++) box(Kt.cloth, rng.range(-0.3, 0.4), y0 + 0.826, 0.85 + rng.range(-0.2, 0.2), rng.range(0.08, 0.25), 0.004, rng.range(0.05, 0.15), rng.pick([C(0x7a9a6a), C(0x8aa0b0), C(0xa08a6a)]), { ry: rng() * PI });
    box(Kt.paint, 1.1, y0 + 0.5, 1.2, 0.5, 0.32, 0.3, COL.olive, { us: 1.6 });
    box(Kt.dark, 1.1, y0 + 0.55, 1.04, 0.38, 0.18, 0.02, COL.gun, { skip: 0 });
    for (let k = 0; k < 3; k++) rod(Kt.metal, [0.98 + k * 0.1, y0 + 0.58, 1.03], [0.98 + k * 0.1, y0 + 0.58, 1.0], 0.018, 0.018, COL.steel, { seg: 6 });
    box(Kt.wood, 1.1, y0 + 0.17, 1.2, 0.6, 0.34, 0.4, COL.plankDk, { us: 1.8 });
    rod(Kt.metal, [1.3, y0 + 0.66, 1.3], [1.32, y0 + Hc + 1.4, 1.32], 0.008, 0.004, COL.gun, { seg: 3 });
    box(Kt.wood, -1.25, y0 + 0.42, 0, 0.35, 0.05, 2.4, COL.plank, { us: 1.8 });
    for (const lz of [-1, 1]) box(Kt.wood, -1.25, y0 + 0.2, lz, 0.3, 0.4, 0.06, COL.plankDk, { us: 1.8 });
    lantern(Kt, -0.3, y0 + 0.82, 0.7);
    ammoBox(Kt, 1.1, y0, -0.6, 0.2, rng); ammoBox(Kt, 1.1, y0 + 0.31, -0.6, 0.1, rng);
    noFrame();
    const wc = (lx, lz, w, d, yb, yt, fl = WALL) => { const p = Pp(lx, lz); col(L, p[0], p[1], y0 + yb, w, yt - yb, d, rot, fl, 'wood'); };
    const fz = -hz - 0.15, ft = 0.34;
    wc((-hx - 0.4 + dl) / 2, fz, dl + hx + 0.4, ft, -0.3, Hc);
    wc((dl + dr) / 2, fz, dr - dl, ft, 1.85, Hc);
    wc((dr + s0) / 2, fz, s0 - dr, ft, -0.3, Hc);
    wc((s0 + s1) / 2, fz, s1 - s0, ft, -0.3, sy0); wc((s0 + s1) / 2, fz, s1 - s0, ft, sy1, Hc);
    wc((s1 + hx + 0.4) / 2, fz, hx + 0.4 - s1, ft, -0.3, Hc);
    wc(0, hz + 0.6, 2 * hx + 1.2, 1.1, -0.3, Hc + 0.3);
    for (const sx of [-1, 1]) wc(sx * (hx + 0.6), 0.2, 1.1, 2 * hz + 0.4, -0.3, Hc + 0.3);
    wc(0, 0.2, 2 * hx + 1.2, 2 * hz + 1.2, Hc, Hc + 0.6);
    const lp = Pp(-0.3, 0.7);
    L.lamps.push({ x: lp[0], y: y0 + 1.1, z: lp[1], r: 6, i: 0.6, flicker: true, color: 0xffb060 });
    L.indoor.push({ x, z, hx, hz, c: Math.cos(rot), s: Math.sin(rot), y0, y1: y0 + Hc });
    return { door: Pp((dl + dr) / 2, -hz - 1.0), inside: [Pp(0.25, 0.8), Pp(-1.2, -0.6), Pp(1.0, 0.0)], tableY: y0 + 0.82 };
  });
}

// ═════════════════════════════ machine-gun nest ═════════════════════════════
/** A tripod-mounted general-purpose machine gun (prop), facing local −Z of the current frame. */
function machineGun(Kt, x, y, z) {
  const g = COL.gun, gl = mul(COL.gun, 1.4), py = y + 0.6;
  for (const [lx, lz] of [[-0.38, -0.42], [0.38, -0.42], [0, 0.7]]) rod(Kt.metal, [x, py - 0.05, z], [x + lx, y + 0.02, z + lz], 0.016, 0.014, g, { seg: 5 });
  rod(Kt.metal, [x, py - 0.08, z], [x, py + 0.04, z], 0.03, 0.03, g, { seg: 6 });
  box(Kt.metal, x, py + 0.1, z - 0.05, 0.08, 0.11, 0.5, g, { skip: 0 });
  box(Kt.metal, x, py + 0.17, z - 0.02, 0.07, 0.03, 0.28, gl, { skip: 0 });
  rod(Kt.metal, [x, py + 0.12, z - 0.3], [x, py + 0.12, z - 0.92], 0.014, 0.013, g, { seg: 6 });
  rod(Kt.metal, [x, py + 0.12, z - 0.92], [x, py + 0.12, z - 1.0], 0.022, 0.02, g, { seg: 6 });
  rod(Kt.metal, [x, py + 0.075, z - 0.3], [x, py + 0.075, z - 0.66], 0.012, 0.012, gl, { seg: 5 });
  for (const sx of [-0.03, 0.03]) rod(Kt.metal, [x + sx, py + 0.06, z - 0.62], [x + sx * 3, py + 0.06, z - 0.32], 0.006, 0.006, g, { seg: 3 });
  box(Kt.metal, x, py + 0.09, z + 0.36, 0.04, 0.13, 0.26, g, { skip: 0 });
  box(Kt.metal, x, py, z + 0.14, 0.035, 0.12, 0.05, g, { rx: 0.3, skip: 0 });
  box(Kt.paint, x + 0.13, py - 0.02, z - 0.04, 0.1, 0.17, 0.22, COL.olive, { us: 1.6, skip: 0 });
  for (let k = 0; k < 6; k++) box(Kt.metal, x + 0.1 - k * 0.018, py + 0.08 + Math.sin(k * 0.6) * 0.03, z - 0.05, 0.016, 0.012, 0.06, COL.brass, { skip: 0 });
}
/**
 * Sandbag ring on an earth base round a tripod machine gun, the front course
 * lowered for the barrel, ammunition boxes inside, a camouflage net overhead.
 * o: { urban (grey net, no leaves), net (default true) }. Returns { seat: [x,z] } behind the gun.
 */
export function mgNest(L, x, z, rot, o = {}) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 14)), Pp = frameP(x, z, rot), y0 = L.gy(x, z);
    const R = 1.55, T = 0.62, arc = 2.15, n = 7;
    for (let i = 0; i < n; i++) {
      const a0 = -arc + (i / n) * arc * 2, a1 = -arc + ((i + 1) / n) * arc * 2, am = (a0 + a1) / 2, rm = R + T / 2;
      const len = 2 * rm * Math.sin((a1 - a0) / 2) + 0.12, [wx, wz] = Pp(Math.sin(am) * rm, -Math.cos(am) * rm), srot = rot - am;
      const gy0 = L.gy(wx, wz), notch = i === (n - 1) / 2, hb = notch ? 0.22 : 0.45;
      at(wx, 0, wz, srot);
      box(Kt.dirt, 0, gy0 + 0.12, 0, len, 0.5, T + 0.2, jit(o.urban ? COL.earthDk : COL.earth, rng, 0.2), { us: 4 });
      noFrame();
      buildProp(L, 'sandbags', { x: wx, z: wz, y: gy0 + 0.35, len, rot: srot, h: hb });
      col(L, wx, wz, gy0 - 0.2, len, 0.55 + hb, T, srot, WALL, 'dirt');
    }
    const fp = Pp(0, -1.0);
    buildProp(L, 'sandbags', { x: fp[0], z: fp[1], y: y0, len: 0.9, rot, h: 0.3 });
    at(x, 0, z, rot);
    machineGun(Kt, 0, y0 + 0.05, -0.95);
    ammoBox(Kt, 0.75, y0, -0.3, 0.6, rng); ammoBox(Kt, 0.85, y0, 0.2, -0.3, rng); ammoBox(Kt, 0.85, y0 + 0.31, 0.2, -0.1, rng); ammoBox(Kt, -0.8, y0, -0.2, 0.9, rng);
    for (let i = 0; i < 14; i++) { const cx = rng.range(-0.6, 0.6), cz = rng.range(-0.8, 0.2), a = rng() * TAU; rod(Kt.metal, [cx, y0 + 0.03, cz], [cx + Math.cos(a) * 0.05, y0 + 0.03, cz + Math.sin(a) * 0.05], 0.006, 0.006, COL.brass, { seg: 4 }); }
    if (!o.urban) leaves(Kt.dirt, rng, 12, -2.2, -2.2, 2.2, 2.2, (lx, lz) => meshY(L, ...Pp(lx, lz)));
    noFrame();
    if (o.net !== false) camoNet(L, x, z, rot, 4.8, 4.4, 2.05, { urban: o.urban, poles: 'corners' });
    return { seat: Pp(0, -0.15) };
  });
}

// ═════════════════════════════ obstacles ═════════════════════════════
/** Concertina wire on angle-iron pickets from (x1,z1) to (x2,z2): stops movement only; sight and bullets pass. */
export function wire(L, x1, z1, x2, z2) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x1, z1, 15)), len = Math.hypot(x2 - x1, z2 - z1), rot = Math.atan2(-(z2 - z1), x2 - x1);
    const ux = (x2 - x1) / len, uz = (z2 - z1) / len, nx = -uz, nz = ux;
    const wc = mix(COL.steel, C(0x6a4a32), 0.45), r = 0.42, pitch = 0.24, seg = 9;
    const P = (s, a, rr) => [x1 + ux * s + nx * Math.cos(a) * rr, meshY(L, x1 + ux * s, z1 + uz * s) + 0.44 + Math.sin(a) * rr * 0.95, z1 + uz * s + nz * Math.cos(a) * rr];
    let prev = P(0, 0, r);
    const steps = Math.ceil(len / pitch) * seg;
    for (let k = 1; k <= steps; k++) {
      const s = (k / steps) * len, a = (k / seg) * TAU, rr = r * (0.9 + 0.2 * Math.sin(k * 0.37));
      const p = P(s, a, rr);
      rod(Kt.metal, prev, p, 0.007, 0.007, wc, { seg: 3, caps: false });
      prev = p;
    }
    const nPk = Math.max(2, Math.round(len / 2.6));
    for (let k = 0; k <= nPk; k++) {
      const s = (k / nPk) * len, bx = x1 + ux * s, bz = z1 + uz * s, gy2 = meshY(L, bx, bz), lean = (rng() - 0.5) * 0.08;
      bar(Kt.metal, [bx, gy2 - 0.15, bz], [bx + nx * lean, gy2 + 1.05, bz + nz * lean], 0.045, 0.045, mul(wc, 0.85), { us: 2 });
      if (k < nPk) for (const hh of [0.15, 0.6, 1.0]) { const s2 = ((k + 1) / nPk) * len; rod(Kt.metal, [bx, gy2 + hh, bz], [x1 + ux * s2, meshY(L, x1 + ux * s2, z1 + uz * s2) + hh - 0.04, z1 + uz * s2], 0.005, 0.005, wc, { seg: 3, caps: false }); }
    }
    col(L, (x1 + x2) / 2, (z1 + z2) / 2, Math.min(L.gy(x1, z1), L.gy(x2, z2)) - 0.2, len, 1.2, 0.9, rot, F.SOLID, 'metal');
  });
}
/** Steel hedgehog: three crossed rusty beams standing on three points. Stops movement; sight and bullets pass. */
export function hedgehog(L, x, z, rot = 0) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 16)), y0 = L.gy(x, z), half = 0.85;
    const m = new THREE.Matrix4().makeRotationY(rot + rng() * 0.5).multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, -1).normalize(), Math.acos(1 / Math.sqrt(3))));
    const cy = y0 + half / Math.sqrt(3) + 0.02, c = mix(C(0x5a3a26), COL.steel, 0.35);
    for (const ax of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      const v = new THREE.Vector3(...ax).applyMatrix4(m);
      bar(Kt.metal, [x - v.x * half, cy - v.y * half, z - v.z * half], [x + v.x * half, cy + v.y * half, z + v.z * half], 0.13, 0.13, jit(c, rng, 0.2), { us: 2 });
    }
    col(L, x, z, y0, 1.3, 1.0, 1.3, rot, F.SOLID, 'metal');
  });
}
/** A cast concrete block with lifting loops, chipped and stained. */
export function concreteBlock(L, x, z, rot = 0) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 17)), y0 = L.gy(x, z);
    at(x, 0, z, rot);
    const c = jit(COL.conc, rng, 0.12), rust = mul(C(0x6a4a32), 0.9);
    box(Kt.conc, 0, y0 + 0.36, 0, 1.5, 0.8, 0.7, c, { us: 3, kb: 0.7 });
    box(Kt.conc, 0, y0 + 0.78, 0, 1.4, 0.06, 0.6, mul(c, 1.03), { us: 3 });
    box(Kt.dark, -0.62 + rng() * 1.2, y0 + 0.6, 0.351, 0.18, 0.12, 0.01, mul(COL.stoneDk, 0.7), { skip: 0 });
    for (const lx of [-0.45, 0.45]) { rod(Kt.metal, [lx - 0.08, y0 + 0.8, 0], [lx, y0 + 0.92, 0], 0.012, 0.012, rust, { seg: 4 }); rod(Kt.metal, [lx, y0 + 0.92, 0], [lx + 0.08, y0 + 0.8, 0], 0.012, 0.012, rust, { seg: 4 }); }
    noFrame();
    col(L, x, z, y0 - 0.1, 1.5, 0.9, 0.7, rot, WALL, 'stone');
  });
}
/** Striped road barrier: a pivot post with counterweight, the boom resting on a forked post. The boom stops walking. */
export function roadBarrier(L, x, z, rot = 0, len = 4.5, o = {}) {
  return timed(L, () => {
    const Kt = K(L), Pp = frameP(x, z, rot), y0 = L.gy(x, z);
    at(x, 0, z, rot);
    const hx = len / 2, by = y0 + 0.98;
    box(Kt.paint, -hx, y0 + 0.55, 0, 0.16, 1.15, 0.16, mul(COL.white, 0.9), { us: 1.6 });
    box(Kt.paint, -hx - 0.35, by, 0, 0.5, 0.22, 0.2, mul(COL.gun, 1.3), { us: 1.6, skip: 0 });
    for (const sx of [-0.07, 0.07]) box(Kt.paint, hx, y0 + 0.45, sx, 0.08, 0.95, 0.05, mul(COL.white, 0.85), { us: 1.6 });
    const nS = Math.round(len / 0.45);
    const up = o.open ? 1.25 : 0;                 // raised boom: the road is open
    const bp = (u) => [-hx + Math.cos(up) * (u + hx), by + Math.sin(up) * (u + hx), 0];
    for (let k = 0; k < nS; k++) { const a = -hx + (k / nS) * len, b = -hx + ((k + 1) / nS) * len; rod(Kt.paint, bp(a), bp(b), 0.055, 0.055, k % 2 ? COL.white : COL.red, { seg: 8, caps: k === nS - 1 }); }
    noFrame();
    const m = Pp(0, 0);
    if (!o.open) col(L, m[0], m[1], by - 0.1, len, 0.2, 0.15, rot, F.SOLID, 'metal');
    for (const lx of [-hx, hx]) { const p = Pp(lx, 0); col(L, p[0], p[1], y0, 0.18, 1.1, 0.18, rot, POST, 'metal'); }
  });
}
/** Log barricade: four logs stacked between X-shaped trestles; waist high, vaultable cover. */
export function logBarricade(L, x, z, rot = 0, len = 4) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 19)), y0 = L.gy(x, z);
    at(x, 0, z, rot);
    const hx = len / 2;
    for (const lx of [-hx + 0.3, 0, hx - 0.3]) for (const e of [-1, 1]) rod(Kt.bark, [lx, y0 - 0.05, e * 0.45], [lx + (rng() - 0.5) * 0.1, y0 + 1.25, -e * 0.35], 0.06, 0.05, COL.logDk, { seg: 5, capCol: COL.cut });
    for (let r = 0; r < 4; r++) rod(Kt.bark, [-hx - rng() * 0.3, y0 + 0.17 + r * 0.27, (rng() - 0.5) * 0.08], [hx + rng() * 0.3, y0 + 0.17 + r * 0.27, (rng() - 0.5) * 0.08], 0.15, 0.13, jit(COL.log, rng, 0.2), { seg: 7, us: 1.5, capCol: COL.cut });
    noFrame();
    col(L, x, z, y0 - 0.2, len, 1.25, 0.5, rot, WALL, 'wood');
  });
}

// ═════════════════════════════ camp and supply dressing ═════════════════════════════
const NET_F = [C(0x4a5234), C(0x5e6440), C(0x3c4430), C(0x6a5a3c), C(0x55603a)];
const NET_U = [C(0x6e6a5a), C(0x8a7e62), C(0x5a5a4a), C(0x7a7460), C(0x4e4e44)];
/**
 * Camouflage net on poles, peaked over a centre pole, sagging between the corners,
 * garnish hanging at the edges. No collider except the poles.
 * o: { urban (grey-tan net), poles: 'corners' (no centre pole) }
 */
export function camoNet(L, x, z, rot, w = 6, d = 4.5, h = 2.3, o = {}) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 20)), Pp = frameP(x, z, rot), pal = o.urban ? NET_U : NET_F;
    const hw = w / 2, hd = d / 2, ov = 0.6, nu = 10, nv = 8, base = meshY(L, x, z);
    at(x, 0, z, rot);
    const yRel = (lx, lz) => {
      const ex = Math.max(0, Math.abs(lx) - hw), ez = Math.max(0, Math.abs(lz) - hd), out = Math.max(ex, ez);
      const fx = clamp01(Math.abs(lx) / hw), fz = clamp01(Math.abs(lz) / hd);
      const peak = (o.poles === 'corners' ? 0.15 : 0.45) * (1 - Math.max(fx, fz)), sag = 0.28 * (Math.sin(fx * PI) * fz * fz + Math.sin(fz * PI) * fx * fx);
      return h + peak - sag - out * 1.3;
    };
    sheet(Kt.cloth, nu, nv, (i, j) => { const lx = -hw - ov + (i / nu) * (w + 2 * ov), lz = -hd - ov + (j / nv) * (d + 2 * ov); return [lx + (rng() - 0.5) * 0.08, base + yRel(lx, lz) + (rng() - 0.5) * 0.06, lz + (rng() - 0.5) * 0.08]; }, pal[0],
      { colAt: (i, j) => { const k = (seedOf(Math.floor(i / 2) * 3.1, Math.floor(j / 2) * 2.7, 21) % pal.length); return [jit(pal[k], rng, 0.2), 1]; }, uv: (i, j) => [i * 0.8, j * 0.8] });
    for (let k = 0; k < 26; k++) {
      const t = rng(), side = k % 4, lx = side < 2 ? (t - 0.5) * (w + ov) : (side === 2 ? -1 : 1) * (hw + ov * 0.8), lz = side < 2 ? (side === 0 ? -1 : 1) * (hd + ov * 0.8) : (t - 0.5) * (d + ov);
      const y = base + yRel(lx, lz), s = rng.range(0.15, 0.3), a = rng() * PI;
      tri(Kt.cloth, [lx - Math.cos(a) * s, y, lz - Math.sin(a) * s], [lx + Math.cos(a) * s, y, lz + Math.sin(a) * s], [lx + (rng() - 0.5) * 0.1, y - s * 1.6, lz + (rng() - 0.5) * 0.1], jit(rng.pick(pal), rng, 0.2));
    }
    const poles = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
    if (o.poles !== 'corners') poles.push([0, 0]);
    for (const [lx, lz] of poles) {
      const p = Pp(lx, lz), gy2 = meshY(L, p[0], p[1]), top = base + yRel(lx, lz) - 0.02;
      rod(Kt.bark, [lx, gy2 - 0.1, lz], [lx, top, lz], 0.045, 0.04, jit(COL.log, rng, 0.2), { seg: 5 });
      col(L, p[0], p[1], gy2, 0.12, top - gy2, 0.12, rot, POST, 'wood');
      if (lx !== 0) { const sx = Math.sign(lx), sz = Math.sign(lz); rod(Kt.bark, [lx, top - 0.05, lz], [lx + sx * 0.9, meshY(L, ...Pp(lx + sx * 0.9, lz + sz * 0.9)) + 0.05, lz + sz * 0.9], 0.008, 0.008, COL.rope, { seg: 3, caps: false }); }
    }
    noFrame();
  });
}
/** A stack of ammunition boxes on pallet boards (n boxes, 3 per row, 2 rows deep, then up). */
export function ammoStack(L, x, z, rot = 0, n = 8) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 22)), y0 = L.gy(x, z);
    at(x, 0, z, rot);
    let layers = 0;
    for (let k = 0; k < n; k++) {
      const lay = Math.floor(k / 6), r = k % 6, cx = ((r % 3) - 1) * 0.64, cz = (Math.floor(r / 3) - 0.5) * 0.36;
      ammoBox(Kt, cx + (rng() - 0.5) * 0.04, y0 + 0.06 + lay * 0.325, cz, (rng() - 0.5) * 0.06, rng);
      layers = lay + 1;
    }
    box(Kt.wood, 0, y0 - 0.02, 0, 2.1, 0.08, 0.9, COL.plankDk, { us: 1.8 });
    if (n >= 6) box(Kt.cloth, -0.35, y0 + 0.06 + layers * 0.325 + 0.01, 0, 1.4, 0.02, 0.95, COL.tarp, { ry: 0.05 });
    noFrame();
    col(L, x, z, y0 - 0.1, 2.0, layers * 0.325 + 0.2, 0.8, rot, WALL, 'wood');
  });
}
/** Spent artillery shell cases, a heap and a few standing, beside long shell crates. */
export function shellCases(L, x, z, rot = 0) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 23)), y0 = L.gy(x, z);
    at(x, 0, z, rot);
    for (let k = 0; k < 14; k++) {
      const a = rng() * TAU, r = rng() * 0.6, cx = Math.cos(a) * r, cz = Math.sin(a) * r, d = rng() * TAU, hy = y0 + 0.07 + (k > 8 ? 0.12 : 0);
      rod(Kt.metal, [cx, hy, cz], [cx + Math.cos(d) * 0.42, hy + (rng() - 0.5) * 0.06, cz + Math.sin(d) * 0.42], 0.065, 0.06, jit(COL.brass, rng, 0.25), { seg: 8, capCol: mul(COL.brass, 0.6) });
    }
    for (let k = 0; k < 4; k++) rod(Kt.metal, [0.9 + k * 0.15, y0, -0.3 + (k % 2) * 0.14], [0.9 + k * 0.15, y0 + 0.44, -0.3 + (k % 2) * 0.14], 0.065, 0.06, jit(COL.brass, rng, 0.2), { seg: 8, capCol: mul(COL.brass, 0.5) });
    for (let k = 0; k < 3; k++) box(Kt.pwood, -1.1, y0 + 0.11 + k * 0.23, 0.2, 0.42, 0.22, 1.25, jit(COL.olive, rng, 0.2), { ry: (rng() - 0.5) * 0.08, us: 0.9 });
    noFrame();
    const p = frameP(x, z, rot)(-1.1, 0.2); col(L, p[0], p[1], y0 - 0.1, 0.45, 0.8, 1.3, rot, WALL, 'wood');
  });
}
/** Jerrycans in a row (no collider: knee-high clutter). */
export function jerrycans(L, x, z, rot = 0, n = 4) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 24)), y0 = L.gy(x, z);
    at(x, 0, z, rot);
    for (let k = 0; k < n; k++) {
      const cx = (k - (n - 1) / 2) * 0.22, c = jit(rng() < 0.7 ? COL.olive : C(0x5a4a3a), rng, 0.15);
      if (k === n - 1 && rng() < 0.5) { box(Kt.paint, cx + 0.3, y0 + 0.09, 0.15, 0.47, 0.17, 0.35, c, { us: 1.6, ry: 0.4 }); continue; }
      box(Kt.paint, cx, y0 + 0.235, 0, 0.17, 0.47, 0.35, c, { us: 1.6 });
      for (const sz of [-1, 1]) box(Kt.paint, cx + 0.087, y0 + 0.235, sz * 0.08, 0.006, 0.36, 0.12, mul(c, 0.85), { rx: sz * 0.5, skip: 0 });
      for (const hz of [-0.08, 0, 0.08]) box(Kt.paint, cx, y0 + 0.5, hz, 0.03, 0.04, 0.03, mul(c, 0.9));
      rod(Kt.metal, [cx, y0 + 0.47, 0.13], [cx, y0 + 0.53, 0.15], 0.02, 0.02, COL.steel, { seg: 6 });
    }
    noFrame();
  });
}
/** Generator on a skid with a work light on a tripod (a real lamp). o: { lightAt: [lx, lz], r, i } */
export function generator(L, x, z, rot = 0, o = {}) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 25)), Pp = frameP(x, z, rot), y0 = L.gy(x, z);
    at(x, y0, z, rot);
    const c = jit(COL.olive, rng, 0.12);
    for (const sz of [-0.32, 0.32]) box(Kt.metal, 0, 0.05, sz, 1.4, 0.1, 0.08, COL.gun, { us: 2 });
    box(Kt.paint, -0.15, 0.42, 0, 0.8, 0.64, 0.6, c, { us: 1.6 });
    box(Kt.paint, 0.48, 0.38, 0, 0.36, 0.56, 0.58, mul(c, 0.9), { us: 1.6 });
    for (let k = 0; k < 6; k++) box(Kt.dark, -0.15, 0.25 + k * 0.08, 0.305, 0.6, 0.03, 0.01, COL.ash, { skip: 0 });
    rod(Kt.paint, [-0.5, 0.86, 0], [0.2, 0.86, 0], 0.15, 0.15, mul(c, 1.05), { seg: 10, us: 1.6 });
    box(Kt.dark, 0.62, 0.55, 0.15, 0.06, 0.2, 0.16, COL.gun);
    rod(Kt.metal, [-0.55, 0.6, -0.2], [-0.62, 1.15, -0.2], 0.03, 0.03, mul(COL.gun, 1.2), { seg: 6 });
    const lx = o.lightAt ? o.lightAt[0] : 1.9, lz = o.lightAt ? o.lightAt[1] : -1.2;
    const lyG = meshY(L, ...Pp(lx, lz)) - y0;
    rod(Kt.rubber, [0.65, 0.4, 0.2], [lx * 0.5, 0.02, lz * 0.5], 0.012, 0.012, COL.gun, { seg: 3, caps: false, us: 4 });
    rod(Kt.rubber, [lx * 0.5, 0.02, lz * 0.5], [lx, lyG + 0.1, lz], 0.012, 0.012, COL.gun, { seg: 3, caps: false, us: 4 });
    for (let k = 0; k < 3; k++) { const a = k * TAU / 3; rod(Kt.metal, [lx, lyG + 1.5, lz], [lx + Math.cos(a) * 0.5, lyG, lz + Math.sin(a) * 0.5], 0.015, 0.015, COL.gun, { seg: 4 }); }
    rod(Kt.metal, [lx, lyG + 1.5, lz], [lx, lyG + 2.1, lz], 0.02, 0.02, COL.gun, { seg: 5 });
    box(Kt.paint, lx, lyG + 2.15, lz, 0.3, 0.24, 0.14, mul(COL.gun, 1.3), { us: 1.6, skip: 0, rx: 0.25 });
    box(Kt.glow, lx, lyG + 2.13, lz - 0.075, 0.24, 0.18, 0.01, C(0xfff2d8), { skip: 0, rx: 0.25 });
    noFrame();
    col(L, x, z, y0 - 0.1, 1.4, 1.1, 0.7, rot, WALL, 'metal');
    const lp = Pp(lx, lz);
    col(L, lp[0], lp[1], y0 + lyG, 0.2, 2.0, 0.2, rot, POST, 'metal');
    const fp = Pp(lx, lz - 0.6);
    L.lamps.push({ x: fp[0], y: y0 + lyG + 2.05, z: fp[1], r: o.r ?? 13, i: o.i ?? 1.1, color: 0xfff0d8 });
  });
}
/** A road wheel: tyre with tread, painted hub. Axis along local x. */
function wheel(Kt, x, y, z, r, wdt, rng) {
  rod(Kt.rubber, [x - wdt / 2, y, z], [x + wdt / 2, y, z], r, r, C(0x2c2c2a), { seg: 16, swap: true, us: wdt / 0.5, uvW: 3, capUV: [0.75, 0.5, 0.2] });
  const sx = Math.sign(x) || 1, o = x + sx * wdt / 2;
  rod(Kt.paint, [o - sx * 0.01, y, z], [o + sx * 0.03, y, z], r * 0.58, r * 0.5, jit(COL.olive, rng, 0.1), { seg: 12, us: 1.6 });
  rod(Kt.metal, [o + sx * 0.03, y, z], [o + sx * 0.09, y, z], r * 0.18, r * 0.13, COL.steel, { seg: 8 });
}
/** Two-wheeled trailer chassis, shared by the field kitchen and the water bowser. */
function trailer(Kt, rng, len, c) {
  for (const sx of [-0.45, 0.45]) box(Kt.metal, sx, 0.55, 0, 0.08, 0.12, len, COL.gun, { us: 2 });
  bar(Kt.metal, [-0.4, 0.55, -len / 2], [0, 0.42, -len / 2 - 1.2], 0.07, 0.07, COL.gun);
  bar(Kt.metal, [0.4, 0.55, -len / 2], [0, 0.42, -len / 2 - 1.2], 0.07, 0.07, COL.gun);
  rod(Kt.metal, [0, 0.42, -len / 2 - 1.2], [0, 0.42, -len / 2 - 1.32], 0.05, 0.05, COL.gun, { seg: 6 });
  rod(Kt.metal, [0, 0.42, -len / 2 - 1.0], [0, 0.0, -len / 2 - 1.0], 0.03, 0.04, COL.gun, { seg: 5 });
  for (const sx of [-1, 1]) { wheel(Kt, sx * 0.92, 0.42, 0.1, 0.42, 0.24, rng); box(Kt.paint, sx * 0.92, 0.88, 0.1, 0.32, 0.05, 0.95, c, { us: 1.6, skip: 0 }); }
  rod(Kt.metal, [-0.9, 0.42, 0.1], [0.9, 0.42, 0.1], 0.04, 0.04, COL.gun, { seg: 6 });
}
/** Field kitchen: a two-wheeled trailer with cauldrons, firebox doors and a stove pipe. */
export function fieldKitchen(L, x, z, rot = 0) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 26)), y0 = L.gy(x, z);
    at(x, y0, z, rot);
    const c = jit(COL.olive, rng, 0.12);
    trailer(Kt, rng, 2.2, c);
    box(Kt.paint, 0, 0.98, 0.05, 1.3, 0.75, 2.0, c, { us: 1.6 });
    for (const [cz, r] of [[-0.45, 0.42], [0.55, 0.36]]) {
      rod(Kt.metal, [0, 1.35, cz], [0, 1.5, cz], r, r, mul(COL.steel, 1.1), { seg: 14 });
      rod(Kt.metal, [0, 1.5, cz], [0, 1.56, cz], r * 0.92, r * 0.3, mul(COL.steel, 1.2), { seg: 14 });
      rod(Kt.metal, [0, 1.56, cz], [0, 1.62, cz], 0.05, 0.05, COL.gun, { seg: 6 });
    }
    rod(Kt.metal, [0.45, 1.3, 0.95], [0.45, 2.9, 0.95], 0.08, 0.07, mul(COL.gun, 1.3), { seg: 8 });
    rod(Kt.metal, [0.45, 2.9, 0.95], [0.45, 3.0, 0.95], 0.13, 0.13, mul(COL.gun, 1.2), { seg: 8 });
    for (const cz of [-0.45, 0.55]) box(Kt.dark, 0.66, 0.85, cz, 0.02, 0.28, 0.32, COL.ash, { skip: 0 });
    noFrame();
    col(L, x, z, y0 - 0.1, 1.9, 1.75, 2.3, rot, WALL, 'metal');
  });
}
/** Water bowser: an oval tank on a two-wheeled trailer, a tap at the back. */
export function bowser(L, x, z, rot = 0) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 27)), y0 = L.gy(x, z);
    at(x, y0, z, rot);
    const c = jit(COL.olive, rng, 0.12);
    trailer(Kt, rng, 2.6, c);
    rod(Kt.paint, [0, 1.25, -1.35], [0, 1.25, 1.35], 0.62, 0.62, c, { seg: 16, us: 1.6, capCol: mul(c, 0.9) });
    for (const cz of [-1.0, 0, 1.0]) rod(Kt.paint, [0, 1.25, cz - 0.03], [0, 1.25, cz + 0.03], 0.64, 0.64, mul(c, 0.85), { seg: 16, caps: false });
    rod(Kt.paint, [0, 1.85, 0.2], [0, 1.95, 0.2], 0.22, 0.22, mul(c, 0.9), { seg: 12 });
    rod(Kt.metal, [0.3, 0.8, 1.38], [0.3, 0.8, 1.55], 0.03, 0.03, COL.brass, { seg: 6 });
    box(Kt.dark, 0.3, 0.02, 1.6, 0.4, 0.01, 0.5, COL.mud, { skip: 0 });
    noFrame();
    col(L, x, z, y0 - 0.1, 1.9, 2.0, 2.9, rot, WALL, 'metal');
  });
}
/** Sectional radio mast with guy wires and a dipole at the top; a cable drum at the foot. */
export function radioMast(L, x, z, h = 8) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 28)), y0 = L.gy(x, z);
    at(x, 0, z, 0);
    const c = mix(COL.olive, COL.steel, 0.4);
    rod(Kt.metal, [0, y0 - 0.1, 0], [0, y0 + h, 0], 0.045, 0.025, c, { seg: 6, us: 2 });
    for (let k = 1; k < 4; k++) rod(Kt.metal, [0, y0 + h * k / 4 - 0.05, 0], [0, y0 + h * k / 4 + 0.05, 0], 0.055, 0.05, mul(c, 0.8), { seg: 6 });
    for (const sx of [-1, 1]) rod(Kt.metal, [0, y0 + h - 0.3, 0], [sx * 0.9, y0 + h - 0.35, 0], 0.01, 0.01, c, { seg: 3 });
    for (let k = 0; k < 3; k++) {
      const a = k * TAU / 3 + rng() * 0.3, ax = Math.cos(a) * h * 0.55, az = Math.sin(a) * h * 0.55, ay = meshY(L, x + ax, z + az);
      for (const f of [0.5, 0.95]) rod(Kt.metal, [0, y0 + h * f, 0], [ax, ay + 0.1, az], 0.005, 0.005, COL.gun, { seg: 3, caps: false });
      rod(Kt.metal, [ax, ay - 0.2, az], [ax * 1.01, ay + 0.15, az * 1.01], 0.02, 0.015, COL.steel, { seg: 4 });
    }
    rod(Kt.wood, [0.5, y0 + 0.25, 0.3], [0.5, y0 + 0.25, 0.6], 0.25, 0.25, COL.plankDk, { seg: 10 });
    rod(Kt.rubber, [0.5, y0 + 0.25, 0.45], [0.06, y0 + 0.6, 0], 0.012, 0.012, COL.gun, { seg: 3, caps: false, us: 4 });
    noFrame();
    col(L, x, z, y0, 0.14, h, 0.14, 0, POST, 'metal');
  });
}
/** A canvas stretcher on the ground (no collider). */
export function stretcher(L, x, z, rot = 0) {
  return timed(L, () => {
    const Kt = K(L), y0 = L.gy(x, z);
    at(x, y0, z, rot);
    for (const sx of [-0.27, 0.27]) rod(Kt.wood, [sx, 0.16, -1.1], [sx, 0.16, 1.1], 0.022, 0.022, COL.plankDk, { seg: 6 });
    box(Kt.cloth, 0, 0.165, 0, 0.54, 0.01, 1.8, COL.canvas, { skip: 0 });
    for (const sz of [-0.75, 0.75]) for (const sx of [-0.27, 0.27]) rod(Kt.metal, [sx, 0.0, sz], [sx, 0.15, sz], 0.012, 0.012, COL.steel, { seg: 4 });
    noFrame();
  });
}
/** A duckboard walk over the mud from (x1,z1) to (x2,z2) (no collider: you walk on the ground under it). */
export function duckboards(L, x1, z1, x2, z2) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x1, z1, 29)), len = Math.hypot(x2 - x1, z2 - z1), rot = Math.atan2(-(z2 - z1), x2 - x1);
    at(x1, 0, z1, rot);
    const yA = (u) => meshY(L, x1 + (x2 - x1) * (u / len), z1 + (z2 - z1) * (u / len));
    for (const v of [-0.3, 0.3]) for (let k = 0; k < Math.ceil(len / 2); k++) { const a = k * 2, b = Math.min(len, a + 2); rod(Kt.bark, [a, yA(a) + 0.04, v], [b, yA(b) + 0.04, v], 0.04, 0.04, COL.logDk, { seg: 4 }); }
    for (let u = 0.1; u < len; u += 0.24) if (rng() > 0.05) box(Kt.wood, u, yA(u) + 0.09, (rng() - 0.5) * 0.04, 0.12, 0.03, 0.8, jit(rng() < 0.5 ? COL.plankDk : COL.plank, rng, 0.3), { us: 1.8, ry: (rng() - 0.5) * 0.06, kb: 0.6 });
    noFrame();
  });
}
/** A latrine screen: canvas on four poles round a plank seat, open at the back (local +Z). */
export function latrine(L, x, z, rot = 0) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 30)), Pp = frameP(x, z, rot), y0 = L.gy(x, z);
    at(x, 0, z, rot);
    const hw = 0.7, hd = 0.6, H = 1.75;
    for (const [lx, lz] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) rod(Kt.bark, [lx, y0 - 0.1, lz], [lx, y0 + H + 0.1, lz], 0.04, 0.035, COL.log, { seg: 5 });
    const panel = (ax, az, bx, bz) => sheet(Kt.cloth, 3, 2, (i, j) => [lerp(ax, bx, i / 3), y0 + 0.15 + (j / 2) * (H - 0.2) + (i % 3 ? -0.03 : 0), lerp(az, bz, i / 3)], COL.canvas, { colAt: () => [jit(COL.canvas, rng, 0.12), 1], uv: (i, j) => [i, j] });
    panel(-hw, -hd, hw, -hd); panel(hw, -hd, hw, hd); panel(-hw, hd, -hw, -hd);
    box(Kt.wood, 0, y0 + 0.42, 0.1, 1.2, 0.06, 0.5, COL.plank, { us: 1.8, skip: 0 });
    box(Kt.dark, 0, y0 + 0.02, 0.1, 1.0, 0.01, 0.6, COL.mud, { skip: 0 });
    noFrame();
    for (const [lx, lz, w, d] of [[0, -hd, 2 * hw, 0.06], [hw, 0, 0.06, 2 * hd], [-hw, 0, 0.06, 2 * hd]]) { const p = Pp(lx, lz); col(L, p[0], p[1], y0, w, H, d, rot, THIN, 'dirt'); }
  });
}
/** A signpost with blank weathered boards pointing different ways (no text). */
export function signpost(L, x, z, rot = 0) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 31)), y0 = L.gy(x, z);
    at(x, 0, z, rot);
    rod(Kt.bark, [0, y0 - 0.2, 0], [0, y0 + 2.3, 0], 0.06, 0.05, COL.log, { seg: 6, capCol: COL.cut });
    for (let k = 0; k < 3; k++) {
      const a = rng() * TAU, y = y0 + 1.5 + k * 0.28, c = jit(k % 2 ? COL.plank : mix(COL.plank, COL.olive, 0.5), rng, 0.2);
      at(x, 0, z, rot + a);
      box(Kt.wood, 0.45, y, 0.07, 0.8, 0.2, 0.03, c, { us: 1.8, skip: 0 });
      tri(Kt.wood, [0.85, y - 0.1, 0.085], [0.98, y, 0.085], [0.85, y + 0.1, 0.085], c);
      tri(Kt.wood, [0.85, y + 0.1, 0.055], [0.98, y, 0.055], [0.85, y - 0.1, 0.055], c);
    }
    noFrame();
    col(L, x, z, y0, 0.14, 2.3, 0.14, 0, POST, 'wood');
  });
}

// ═════════════════════════════ soft-skin trucks ═════════════════════════════
/**
 * A military truck with a canvas tilt, no markings: kind '6x6' (long bonnet,
 * three axles, Ural type) or '4x4' (cab over the engine, GAZ-66 type). Front at local −Z.
 */
export function truck(L, x, z, rot = 0, kind = '6x6', o = {}) {
  return timed(L, () => {
    const Kt = K(L), rng = makeRng(seedOf(x, z, 32)), Pp = frameP(x, z, rot), big = kind !== '4x4';
    const len2 = big ? 3.7 : 2.95;
    const y0 = Math.min(...[[-1, -len2 + 0.8], [1, -len2 + 0.8], [-1, len2 - 0.8], [1, len2 - 0.8], [0, 0]].map(([a, b]) => { const p = Pp(a, b); return L.gy(p[0], p[1]); }));
    at(x, y0, z, rot);
    const paint = jit(o.color ? C(o.color) : COL.olive, rng, 0.1), dk = mul(paint, 0.75), mud = mix(paint, COL.mud, 0.5), us = 1.6;
    const R = big ? 0.56 : 0.5, TW = big ? 0.38 : 0.34, track = big ? 1.0 : 0.95;
    const axles = big ? [-2.5, 0.95, 2.35] : [-1.95, 1.4];
    const front = -len2, rear = len2;
    const cabZ0 = big ? -2.0 : -2.95, cabZ1 = big ? -0.45 : -1.35, cabY0 = big ? 1.1 : 1.0, cabY1 = big ? 2.55 : 2.42, cw = big ? 1.12 : 1.1;
    const bedZ0 = cabZ1 + 0.12, deckY = big ? 1.38 : 1.25, tiltTop = big ? 2.95 : 2.62, bw = big ? 1.22 : 1.15;
    for (const sx of [-0.45, 0.45]) box(Kt.metal, sx, 0.88, (front + rear) / 2 + 0.15, 0.12, 0.24, rear - front - 0.5, COL.gun, { us: 2, skip: 0 });
    for (const az of axles) {
      for (const sx of [-1, 1]) wheel(Kt, sx * track, R, az, R, TW, rng);
      rod(Kt.metal, [-track + 0.2, R, az], [track - 0.2, R, az], 0.07, 0.07, COL.gun, { seg: 6 });
      box(Kt.metal, 0, R + 0.02, az, 0.34, 0.3, 0.3, COL.gun);
    }
    box(Kt.paint, 0, 0.85, front + 0.12, 2.15, 0.22, 0.2, mul(COL.gun, 1.3), { us, skip: 0 });
    for (const sx of [-0.62, 0.62]) rod(Kt.metal, [sx, 0.8, front + 0.02], [sx, 0.8, front - 0.12], 0.04, 0.04, COL.gun, { seg: 6 });
    box(Kt.metal, 0, 0.9, rear - 0.08, 2.2, 0.16, 0.14, COL.gun, { skip: 0 });
    const tz0 = big ? -0.3 : -1.1, tz1 = big ? 0.55 : -0.1;
    rod(Kt.paint, [-1.0, 0.95, tz0], [-1.0, 0.95, tz1], 0.26, 0.26, mud, { seg: 12, us });
    box(Kt.paint, 1.0, 0.95, (tz0 + tz1) / 2, 0.4, 0.42, 0.7, mud, { us });
    if (big) {
      box(Kt.paint, 0, 1.45, (front + 0.2 + cabZ0) / 2, 1.24, 0.72, cabZ0 - front - 0.2, paint, { us });
      box(Kt.paint, 0, 1.83, (front + 0.25 + cabZ0) / 2, 1.1, 0.06, cabZ0 - front - 0.3, mul(paint, 1.05), { us, skip: 0 });
      box(Kt.dark, 0, 1.42, front + 0.19, 0.95, 0.6, 0.02, mul(COL.gun, 0.9), { skip: 0 });
      for (let k = 0; k < 9; k++) box(Kt.paint, -0.4 + k * 0.1, 1.42, front + 0.17, 0.03, 0.58, 0.03, dk, { us });
      for (const sx of [-1, 1]) {
        box(Kt.paint, sx * 1.0, 1.28, -2.55, 0.5, 0.1, 1.5, mud, { us, skip: 0 });
        box(Kt.paint, sx * 1.0, 1.05, -3.36, 0.5, 0.45, 0.1, mud, { us, rx: 0.35, skip: 0 });
        rod(Kt.paint, [sx * 0.95, 1.5, -3.25], [sx * 0.95, 1.5, -3.4], 0.11, 0.12, dk, { seg: 10 });
        rod(Kt.glass, [sx * 0.95, 1.5, -3.4], [sx * 0.95, 1.5, -3.41], 0.1, 0.1, C(0x9aa0a0), { seg: 10 });
      }
    } else {
      box(Kt.dark, 0, 1.3, front + 0.02, 1.0, 0.45, 0.02, mul(COL.gun, 0.9), { skip: 0 });
      for (let k = 0; k < 8; k++) box(Kt.paint, -0.35 + k * 0.1, 1.3, front, 0.03, 0.44, 0.03, dk, { us });
      for (const sx of [-1, 1]) {
        box(Kt.paint, sx * 0.98, 1.15, -1.95, 0.42, 0.1, 1.25, mud, { us, skip: 0 });
        rod(Kt.paint, [sx * 0.8, 1.35, front + 0.04], [sx * 0.8, 1.35, front - 0.06], 0.1, 0.11, dk, { seg: 10 });
        rod(Kt.glass, [sx * 0.8, 1.35, front - 0.06], [sx * 0.8, 1.35, front - 0.07], 0.09, 0.09, C(0x9aa0a0), { seg: 10 });
      }
    }
    box(Kt.paint, 0, (cabY0 + cabY1) / 2, (cabZ0 + cabZ1) / 2, cw * 2, cabY1 - cabY0, cabZ1 - cabZ0, paint, { us, skip: 0 });
    box(Kt.paint, 0, cabY1 + 0.03, (cabZ0 + cabZ1) / 2, cw * 2 - 0.12, 0.06, cabZ1 - cabZ0 - 0.1, mul(paint, 1.05), { us, skip: 0 });
    const wy0 = cabY1 - 0.62, wy1 = cabY1 - 0.1;
    for (const sx of [-1, 1]) {
      box(Kt.glass, sx * cw * 0.48, (wy0 + wy1) / 2, cabZ0 - 0.005, cw * 0.86, wy1 - wy0, 0.02, C(0x6a7478), { skip: 0 });
      box(Kt.glass, sx * (cw + 0.005), (wy0 + wy1) / 2, cabZ0 + (cabZ1 - cabZ0) * 0.35, 0.02, wy1 - wy0 - 0.05, (cabZ1 - cabZ0) * 0.5, C(0x6a7478), { skip: 0 });
      box(Kt.dark, sx * (cw + 0.006), (cabY0 + cabY1) / 2, cabZ0 + (cabZ1 - cabZ0) * 0.78, 0.01, cabY1 - cabY0 - 0.1, 0.02, COL.gun, { skip: 0 });
      box(Kt.metal, sx * (cw + 0.02), cabY0 + 0.75, cabZ0 + (cabZ1 - cabZ0) * 0.6, 0.03, 0.03, 0.14, COL.steel, { skip: 0 });
      rod(Kt.metal, [sx * cw, wy1 - 0.1, cabZ0 + 0.05], [sx * (cw + 0.3), wy1 - 0.05, cabZ0 + 0.05], 0.012, 0.012, COL.gun, { seg: 4 });
      box(Kt.metal, sx * (cw + 0.32), wy1 - 0.15, cabZ0 + 0.05, 0.04, 0.3, 0.18, COL.gun, { skip: 0 });
      box(Kt.metal, sx * (cw - 0.1), cabY0 - 0.25, (cabZ0 + cabZ1) / 2, 0.3, 0.04, 0.5, COL.gun, { skip: 0 });
    }
    box(Kt.dark, 0, (wy0 + wy1) / 2, cabZ0 - 0.012, 0.06, wy1 - wy0, 0.02, mul(paint, 0.7), { skip: 0 });
    if (big) rod(Kt.rubber, [0, 1.85, cabZ1 + 0.02], [0, 1.85, cabZ1 + 0.3], R, R, C(0x2c2c2a), { seg: 16, swap: true, us: 0.6, uvW: 3, capUV: [0.75, 0.5, 0.2] });
    box(Kt.pwood, 0, deckY, (bedZ0 + rear) / 2, bw * 2, 0.08, rear - bedZ0, mul(paint, 0.9), { us: 0.9, skip: 0 });
    for (const sx of [-1, 1]) {
      box(Kt.paint, sx * bw, deckY + 0.3, (bedZ0 + rear) / 2, 0.05, 0.55, rear - bedZ0, paint, { us, skip: 0 });
      for (let k = 0; k < 5; k++) box(Kt.paint, sx * (bw + 0.03), deckY + 0.3, bedZ0 + 0.2 + k * (rear - bedZ0 - 0.4) / 4, 0.04, 0.55, 0.06, dk, { us });
    }
    box(Kt.paint, 0, deckY + 0.3, rear - 0.03, bw * 2, 0.55, 0.05, paint, { us, skip: 0 });
    box(Kt.paint, 0, deckY + 0.3, bedZ0 + 0.03, bw * 2, 0.55, 0.05, paint, { us, skip: 0 });
    const ty0 = deckY + 0.55, side = tiltTop - 0.45;
    const prof = [];
    for (let j = 0; j <= 8; j++) { const t = j / 8; if (t <= 0.2) prof.push([-bw, lerp(ty0, side, t / 0.2)]); else if (t >= 0.8) prof.push([bw, lerp(side, ty0, (t - 0.8) / 0.2)]); else { const a = PI * (t - 0.2) / 0.6; prof.push([-Math.cos(a) * bw, side + Math.sin(a) * (tiltTop - side)]); } }
    const nz = 6, tz = (i) => bedZ0 + 0.05 + (i / nz) * (rear - bedZ0 - 0.1);
    const canvas = jit(COL.canvas, rng, 0.08);
    sheet(Kt.cloth, nz, 8, (i, j) => { const sag = i % 2 ? 0.035 : 0; const [px, py] = prof[j]; return [px - Math.sign(px) * sag * (py <= side ? 1 : 0.3), py - (py > side ? sag : 0), tz(i)]; }, canvas,
      { flip: true, colAt: (i, j) => [mix(jit(canvas, rng, 0.06), COL.mud, j === 0 || j === 8 ? 0.25 : 0), i % 2 ? 0.95 : 1.03], uv: (i, j) => [i * 0.8, j * 0.4] });
    sheet(Kt.cloth, 8, 1, (i, j) => [prof[i][0] * (j ? 0.02 : 1), j ? ty0 : prof[i][1], tz(0)], canvas, { colAt: () => [mul(canvas, 0.92), 1], uv: (i, j) => [i * 0.3, j] });
    rod(Kt.cloth, [-bw, tiltTop - 0.2, tz(nz) + 0.02], [bw, tiltTop - 0.2, tz(nz) + 0.02], 0.1, 0.1, mul(canvas, 0.9), { seg: 8 });
    box(Kt.dark, 0, (ty0 + tiltTop - 0.3) / 2, tz(nz) - 0.35, bw * 2 - 0.1, tiltTop - ty0 - 0.3, 0.02, mul(COL.ash, 0.6), { skip: 0 });
    for (let k = 0; k < 3; k++) ammoBox(Kt, -0.6 + k * 0.62, deckY + 0.04, tz(nz) - 0.6, 0, rng);
    noFrame();
    const cz = (front + cabZ1) / 2, bz = (bedZ0 + rear) / 2;
    let p = Pp(0, cz); col(L, p[0], p[1], y0 + 0.45, 2.3, cabY1 - 0.45, cabZ1 - front, rot, WALL, 'metal');
    p = Pp(0, bz); col(L, p[0], p[1], y0 + 0.45, bw * 2 + 0.1, tiltTop - 0.45, rear - bedZ0, rot, WALL, 'metal');
    return { x, z, rot };
  });
}

export const MILITARY_VERSION = 1;
void clamp01;
