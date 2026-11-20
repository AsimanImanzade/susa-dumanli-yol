/**
 * structures.js — the town's architecture and objects, built in code.
 *
 * The level kit (level.js) keeps every collider, lamp, ladder, interaction
 * and other gameplay record exactly where it always was and asks this module
 * for the visuals only: houses with real window openings, doors, cornices,
 * eaves, gutters and balconies; enterable buildings with door frames and
 * interior trim; Soviet-era cars; and the street props.
 *
 * Geometry goes into merged batches. Surfaces that a tiling wall texture
 * suits use the kit's shared batches (stone, plaster, wood, roof, concrete,
 * cloth, dark, glow). Everything else goes into this module's own batches,
 * one MeshStandardMaterial each, built into meshes by finalizeStructures():
 *
 *   st_paint   painted metal: car bodies, dumpsters, drums, pipes, cabinets
 *   st_pwood   painted wood: window frames, shutters, doors, galleries
 *   st_metal   bare and chromed steel: bumpers, rims, ladders, masts
 *   st_rubber  tyres (tread normal map), seals, dark plastic, car interiors
 *   st_glass   window glass (opaque: houses have no interiors)
 *   st_cglass  car glass (transparent, so the seats show through)
 *
 * Every primitive writes into a models.js Geo through V(), optionally through
 * the current frame matrix (setFrame / frameAt), so composite objects are
 * written in their own local space.
 */
import * as THREE from 'three';
import { hash2, makeRng, clamp01, smoothstep, lerp } from './ctx.js';
import { Geo } from './models.js';
import { TEX_SCALE } from './textures.js';

const PI = Math.PI, TAU = PI * 2;
/** Dev-viewer overrides (e.g. force a car body type). */
export const structureDebug = { carType: null };

// ───────────────────────────── colours ─────────────────────────────
const _col = new THREE.Color();
const _cc = new Map();
/** sRGB hex → cached linear [r,g,b] */
export function C(hex) {
  let c = _cc.get(hex);
  if (!c) { _col.set(hex); c = [_col.r, _col.g, _col.b]; _cc.set(hex, c); }
  return c;
}
const mixC = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mulC = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const jitC = (a, rng, amt) => { const k = 1 + (rng() - 0.5) * amt; return [a[0] * k * (1 + (rng() - 0.5) * amt * 0.3), a[1] * k, a[2] * k * (1 + (rng() - 0.5) * amt * 0.3)]; };

// ───────────────────────────── frame + vertex ─────────────────────────────
const _F = new THREE.Matrix4(), _R = new THREE.Matrix4(), _eu = new THREE.Euler(), _v3 = new THREE.Vector3();
let FE = null;
/** Make m the current frame: everything emitted next is transformed by it (rotation + translation only). */
export function setFrame(m) { if (!m) { FE = null; return; } _F.copy(m); FE = _F.elements; }
/** Frame at (x,y,z) with yaw ry (same convention as the kit's P()) and optional pitch/roll. */
export function frameAt(x, y, z, ry = 0, rx = 0, rz = 0) {
  _F.makeRotationFromEuler(_eu.set(rx, ry, rz, 'YXZ')); _F.setPosition(x, y, z); FE = _F.elements;
  return _F.clone();
}
const mat4At = (x, y, z, ry = 0, rx = 0, rz = 0) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')).setPosition(x, y, z);

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
const QUV = [0, 0, 1, 0, 1, 1, 0, 1];
/** Quad a,b,c,d (counter-clockwise seen from the front). uv: flat [u0,v0..u3,v3]; ks: per-corner shade. */
function quad(g, a, b, c, d, col, k = 1, uv = null, ks = null, nrm = null) {
  let nx, ny, nz;
  if (nrm) { nx = nrm[0]; ny = nrm[1]; nz = nrm[2]; } else {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    nx = uy * vz - uz * vy; ny = uz * vx - ux * vz; nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  }
  const U = uv || QUV, i = g.count;
  V(g, a[0], a[1], a[2], nx, ny, nz, col, ks ? ks[0] * k : k, U[0], U[1]);
  V(g, b[0], b[1], b[2], nx, ny, nz, col, ks ? ks[1] * k : k, U[2], U[3]);
  V(g, c[0], c[1], c[2], nx, ny, nz, col, ks ? ks[2] * k : k, U[4], U[5]);
  V(g, d[0], d[1], d[2], nx, ny, nz, col, ks ? ks[3] * k : k, U[6], U[7]);
  g.i.push(i, i + 1, i + 2, i, i + 2, i + 3);
}
function tri(g, a, b, c, col, k = 1, uv = null) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  const U = uv || QUV, i = g.count;
  V(g, a[0], a[1], a[2], nx, ny, nz, col, k, U[0], U[1]);
  V(g, b[0], b[1], b[2], nx, ny, nz, col, k, U[2], U[3]);
  V(g, c[0], c[1], c[2], nx, ny, nz, col, k, U[4], U[5]);
  g.i.push(i, i + 1, i + 2);
}
/** Rectangle in the plane z = zf of the current frame, facing +z (dir 1) or −z (dir −1). k0/k1 = shade at bottom/top. */
function rectZ(g, x0, y0, x1, y1, zf, dir, col, k0 = 1, k1 = k0, us = 1, uo = 0, vo = 0) {
  const uv = [(x0 + uo) / us, (y0 + vo) / us, (x1 + uo) / us, (y0 + vo) / us, (x1 + uo) / us, (y1 + vo) / us, (x0 + uo) / us, (y1 + vo) / us];
  if (dir > 0) quad(g, [x0, y0, zf], [x1, y0, zf], [x1, y1, zf], [x0, y1, zf], col, 1, uv, [k0, k0, k1, k1], [0, 0, 1]);
  else quad(g, [x1, y0, zf], [x0, y0, zf], [x0, y1, zf], [x1, y1, zf], col, 1, [uv[2], uv[3], uv[0], uv[1], uv[6], uv[7], uv[4], uv[5]], [k0, k0, k1, k1], [0, 0, -1]);
}
/** Rectangle in the plane x = xf (spanning z0..z1, y0..y1), facing +x (dir 1) or −x. */
function rectX(g, z0, y0, z1, y1, xf, dir, col, k0 = 1, k1 = k0, us = 1) {
  if (dir > 0) quad(g, [xf, y0, z1], [xf, y0, z0], [xf, y1, z0], [xf, y1, z1], col, 1, [z1 / us, y0 / us, z0 / us, y0 / us, z0 / us, y1 / us, z1 / us, y1 / us], [k0, k0, k1, k1], [1, 0, 0]);
  else quad(g, [xf, y0, z0], [xf, y0, z1], [xf, y1, z1], [xf, y1, z0], col, 1, [z0 / us, y0 / us, z1 / us, y0 / us, z1 / us, y1 / us, z0 / us, y1 / us], [k0, k0, k1, k1], [-1, 0, 0]);
}
/** Rectangle in the plane y = yf, facing up (dir 1) or down. */
function rectY(g, x0, z0, x1, z1, yf, dir, col, k = 1, us = 1) {
  if (dir > 0) quad(g, [x0, yf, z1], [x1, yf, z1], [x1, yf, z0], [x0, yf, z0], col, k, [x0 / us, z1 / us, x1 / us, z1 / us, x1 / us, z0 / us, x0 / us, z0 / us], null, [0, 1, 0]);
  else quad(g, [x0, yf, z0], [x1, yf, z0], [x1, yf, z1], [x0, yf, z1], col, k, [x0 / us, z0 / us, x1 / us, z0 / us, x1 / us, z1 / us, x0 / us, z1 / us], null, [0, -1, 0]);
}

// box faces: 1 +x, 2 −x, 4 +y, 8 −y, 16 +z, 32 −z (skip mask)
const BOX_F = [
  [1, 0, 0, [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], 2, 1],
  [-1, 0, 0, [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], 2, 1],
  [0, 1, 0, [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], 0, 2],
  [0, -1, 0, [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], 0, 2],
  [0, 0, 1, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], 0, 1],
  [0, 0, -1, [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], 0, 1],
];
/**
 * Box centred at (cx,cy,cz) with full size (sx,sy,sz) in the current frame.
 * o: { ry, rx, rz, us (metres per uv repeat), skip (mask), k (shade), kb (extra shade on the lower corners), kt }
 */
function box(g, cx, cy, cz, sx, sy, sz, col, o = {}) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2, us = o.us || 1, skip = o.skip || 0, k = o.k ?? 1, kb = o.kb ?? 1, kt = o.kt ?? 1;
  const rot = o.ry || o.rx || o.rz;
  let e = null;
  if (rot) { _R.makeRotationFromEuler(_eu.set(o.rx || 0, o.ry || 0, o.rz || 0, 'YXZ')); e = _R.elements; }
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
      V(g, x + cx, y + cy, z + cz, nx, ny, nz, col, k * (l[1] < 0 ? kb : kt), u, v);
    }
    g.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/**
 * Lathe: profile [[r, y], ...] revolved around the axis through (cx,cy,cz).
 * Smooth normals; a repeated point makes a crease. o: { seg, axis 'y'|'x'|'z', a0, a1, us, colAt(i) → [col,k],
 * dr(i, s, a) → radius offset (dents), capTop, capBot, uv(i, s) → [u,v] }
 */
function lathe(g, cx, cy, cz, prof, col, o = {}) {
  const seg = o.seg || 12, axis = o.axis || 'y', a0 = o.a0 ?? 0, a1 = o.a1 ?? TAU, full = Math.abs(a1 - a0 - TAU) < 1e-6;
  const n = prof.length, us = o.us || 1;
  // profile normals (2-D: radial, axial)
  const pn = [];
  for (let i = 0; i < n; i++) {
    const p = prof[i], prev = i > 0 && !same(prof[i - 1], p) ? prof[i - 1] : null, next = i < n - 1 && !same(prof[i + 1], p) ? prof[i + 1] : null;
    let nr = 0, ny = 0;
    if (prev) { const dr = p[0] - prev[0], dy = p[1] - prev[1], l = Math.hypot(dr, dy) || 1; nr += dy / l; ny += -dr / l; }
    if (next && !(i > 0 && same(prof[i - 1], p))) { /* fallthrough */ }
    if (next) { const dr = next[0] - p[0], dy = next[1] - p[1], l = Math.hypot(dr, dy) || 1; nr += dy / l; ny += -dr / l; }
    if (i > 0 && same(prof[i - 1], p) && next) { const dr = next[0] - p[0], dy = next[1] - p[1], l = Math.hypot(dr, dy) || 1; nr = dy / l; ny = -dr / l; }
    if (i < n - 1 && same(prof[i + 1], p) && prev) { const dr = p[0] - prev[0], dy = p[1] - prev[1], l = Math.hypot(dr, dy) || 1; nr = dy / l; ny = -dr / l; }
    const l = Math.hypot(nr, ny) || 1; pn.push([nr / l, ny / l]);
  }
  const map = axis === 'y' ? (r, y, a) => [Math.cos(a) * r, y, Math.sin(a) * r]
    : axis === 'x' ? (r, y, a) => [y, Math.sin(a) * r, Math.cos(a) * r]
      : (r, y, a) => [Math.cos(a) * r, Math.sin(a) * r, y];
  const cols = seg + 1, base = g.count;
  for (let s = 0; s <= seg; s++) {
    const a = a0 + (a1 - a0) * (s / seg);
    for (let i = 0; i < n; i++) {
      const [r0, y] = prof[i], r = r0 + (o.dr ? o.dr(i, s % (full ? seg : seg + 1), a) : 0);
      const p = map(r, y, a), nm = map(pn[i][0], pn[i][1], a);
      const ck = o.colAt ? o.colAt(i, s) : null;
      const uv = o.uv ? o.uv(i, s) : [s / seg * (o.uRep || 2), y / us];
      V(g, p[0] + cx, p[1] + cy, p[2] + cz, nm[0], nm[1], nm[2], ck ? ck[0] : col, ck ? ck[1] : (prof[i][2] ?? 1), uv[0], uv[1]);
    }
  }
  for (let s = 0; s < seg; s++) for (let i = 0; i < n - 1; i++) {
    if (same(prof[i], prof[i + 1])) continue;
    const a = base + s * n + i, b = base + (s + 1) * n + i;
    if (axis !== 'z') g.i.push(a, a + 1, b + 1, a, b + 1, b); else g.i.push(a, b + 1, a + 1, a, b, b + 1);   // 'z' maps through a reflection
  }
  void cols;
  // caps (flat discs)
  for (const [on, idx, dir] of [[o.capTop, n - 1, 1], [o.capBot, 0, -1]]) {
    if (!on || prof[idx][0] < 1e-4) continue;
    const [r, y] = prof[idx], c0 = g.count, nm = map(0, dir, 0);
    V(g, ...addV(map(0, y, 0), cx, cy, cz), nm[0], nm[1], nm[2], col, prof[idx][2] ?? 1, 0.5, 0.5);
    for (let s = 0; s <= seg; s++) { const a = a0 + (a1 - a0) * (s / seg), p = map(r, y, a); V(g, p[0] + cx, p[1] + cy, p[2] + cz, nm[0], nm[1], nm[2], col, prof[idx][2] ?? 1, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5); }
    const flip = (dir > 0) === (axis !== 'z');
    for (let s = 0; s < seg; s++) if (flip) g.i.push(c0, c0 + s + 2, c0 + s + 1); else g.i.push(c0, c0 + s + 1, c0 + s + 2);
  }
}
const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
const addV = (p, x, y, z) => [p[0] + x, p[1] + y, p[2] + z];
/** Cylinder / frustum along an axis, smooth sides. */
function cyl(g, cx, cy, cz, rT, rB, h, col, o = {}) {
  lathe(g, cx, cy, cz, [[rB, -h / 2], [rT, h / 2]], col, { capTop: o.caps !== false && o.capTop !== false, capBot: o.caps !== false && o.capBot !== false, ...o });
}

/**
 * Lattice surface with smooth normals. pos(i, j) → [x,y,z] for i ∈ 0..nu, j ∈ 0..nv.
 * o: { colAt(i,j,p) → [col,k], uv(i,j,p) → [u,v], wrapU (last column joins the first), flip }
 */
function grid(g, nu, nv, pos, col, o = {}) {
  const cu = nu + 1, cv = nv + 1, P = new Array(cu * cv), N = new Float32Array(cu * cv * 3);
  for (let j = 0; j < cv; j++) for (let i = 0; i < cu; i++) P[j * cu + i] = pos(i, j);
  const sg = o.flip ? -1 : 1;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = P[j * cu + i], b = P[j * cu + i + 1], c = P[(j + 1) * cu + i + 1], d = P[(j + 1) * cu + i];
    const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], vx = d[0] - b[0], vy = d[1] - b[1], vz = d[2] - b[2];
    const nx = (uy * vz - uz * vy) * sg, ny = (uz * vx - ux * vz) * sg, nz = (ux * vy - uy * vx) * sg;
    for (const k of [j * cu + i, j * cu + i + 1, (j + 1) * cu + i + 1, (j + 1) * cu + i]) { N[k * 3] += nx; N[k * 3 + 1] += ny; N[k * 3 + 2] += nz; }
  }
  if (o.wrapU) for (let j = 0; j < cv; j++) {
    const a = j * cu, b = j * cu + nu;
    for (let q = 0; q < 3; q++) { const s = N[a * 3 + q] + N[b * 3 + q]; N[a * 3 + q] = s; N[b * 3 + q] = s; }
  }
  const base = g.count;
  for (let j = 0; j < cv; j++) for (let i = 0; i < cu; i++) {
    const k = j * cu + i, p = P[k];
    let nx = N[k * 3], ny = N[k * 3 + 1], nz = N[k * 3 + 2];
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const ck = o.colAt ? o.colAt(i, j, p) : null, uv = o.uv ? o.uv(i, j, p) : [i / nu, j / nv];
    V(g, p[0], p[1], p[2], nx, ny, nz, ck ? ck[0] : col, ck ? ck[1] : 1, uv[0], uv[1]);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = base + j * cu + i, b = a + 1, c = a + cu + 1, d = a + cu;
    if (o.flip) g.i.push(a, c, b, a, d, c); else g.i.push(a, b, c, a, c, d);
  }
}

/**
 * Prism: polygon pts [[a,b],...] in the plane spanned by two local axes, extruded along the third
 * from d0 to d1. plane: 'zy' (a→z, b→y, extrude x), 'xy' (extrude z), 'xz' (a→x, b→z, extrude y).
 * o: { k, us, caps (default true), sides (default true), capCol }
 */
function prism(g, pts, plane, d0, d1, col, o = {}) {
  const P3 = plane === 'zy' ? (a, b, d) => [d, b, a] : plane === 'xy' ? (a, b, d) => [a, b, d] : (a, b, d) => [a, d, b];
  // orientation: make pts CCW in (a,b)
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; area += p[0] * q[1] - q[0] * p[1]; }
  const ccw = area > 0, us = o.us || 1, k = o.k ?? 1;
  // in plane 'xy' the extrude axis is +z = a×b (right-handed); 'zy': a=z,b=y → a×b = z×y = −x; 'xz': x×z = −y
  const handed = plane === 'xy' ? 1 : -1;
  if (o.caps !== false) {
    const tris = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p[0], p[1])), []);
    for (const [d, sgn] of [[d1, 1], [d0, -1]]) {
      const nn = P3(0, 0, sgn), c0 = g.count;
      for (const p of pts) { const q = P3(p[0], p[1], d); V(g, q[0], q[1], q[2], nn[0], nn[1], nn[2], o.capCol || col, k, p[0] / us, p[1] / us); }
      const front = (sgn * handed > 0) === ccw;
      for (const t of tris) if (front) g.i.push(c0 + t[0], c0 + t[1], c0 + t[2]); else g.i.push(c0 + t[0], c0 + t[2], c0 + t[1]);
    }
  }
  if (o.sides !== false) {
    let run = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const A = P3(p[0], p[1], d0), B = P3(q[0], q[1], d0), Cq = P3(q[0], q[1], d1), D = P3(p[0], p[1], d1);
      const uv = [run / us, d0 / us, (run + len) / us, d0 / us, (run + len) / us, d1 / us, run / us, d1 / us];
      if ((ccw ? 1 : -1) * handed > 0) quad(g, A, B, Cq, D, col, k, uv); else quad(g, B, A, D, Cq, col, k, [uv[2], uv[3], uv[0], uv[1], uv[6], uv[7], uv[4], uv[5]]);
      run += len;
    }
  }
}

/**
 * Sweep a profile around an axis-aligned rectangle (half sizes hx, hz) with mitred corners.
 * prof: [[out, y, k?], ...] from the wall outwards. o: { sides: mask of 1 s(+z) 2 e(+x) 4 n(−z) 8 w(−x), us }
 */
function sweepRect(g, hx, hz, prof, col, o = {}) {
  const sides = o.sides ?? 15, us = o.us || 1;
  const S = [[1, hx, hz, 0, 0, 1], [2, hz, hx, 1, 0, 0], [4, hx, hz, 0, 0, -1], [8, hz, hx, -1, 0, 0]];
  for (const [bit, half, depth, nx, , nz] of S) {
    if (!(sides & bit)) continue;
    // tangent t = up × n
    const tx = nz, tz = -nx;
    let run = 0;
    for (let j = 0; j < prof.length - 1; j++) {
      const [o0, y0, k0 = 1] = prof[j], [o1, y1, k1 = 1] = prof[j + 1];
      const pt = (oo, y, s) => { const L = (half + oo) * s, D = depth + oo; return [nx * D + tx * L, y, nz * D + tz * L]; };
      const len = Math.hypot(o1 - o0, y1 - y0);
      const A = pt(o0, y0, -1), B = pt(o0, y0, 1), Cq = pt(o1, y1, 1), D = pt(o1, y1, -1);
      const L0 = half + o0, L1 = half + o1;
      quad(g, A, B, Cq, D, col, 1, [-L0 / us, run / us, L0 / us, run / us, L1 / us, (run + len) / us, -L1 / us, (run + len) / us], [k0, k0, k1, k1]);
      run += len;
    }
  }
}

/** Square-section bar from a to b (thickness t). o: { up, k, caps } */
function bar(g, a, b, t, col, o = {}) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], len = Math.hypot(dx, dy, dz) || 1e-6;
  const d = [dx / len, dy / len, dz / len];
  let up = o.up || [0, 1, 0];
  if (Math.abs(d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) > 0.95) up = [1, 0, 0];
  let s = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
  const sl = Math.hypot(...s); s = s.map((v) => v / sl);
  const u = [s[1] * d[2] - s[2] * d[1], s[2] * d[0] - s[0] * d[2], s[0] * d[1] - s[1] * d[0]];
  const h = t / 2, k = o.k ?? 1;
  const P = (p, i, j) => [p[0] + s[0] * i * h + u[0] * j * h, p[1] + s[1] * i * h + u[1] * j * h, p[2] + s[2] * i * h + u[2] * j * h];
  const ring = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let q = 0; q < 4; q++) {
    const [i0, j0] = ring[q], [i1, j1] = ring[(q + 1) % 4];
    quad(g, P(a, i0, j0), P(a, i1, j1), P(b, i1, j1), P(b, i0, j0), col, k, [0, 0, 0.1, 0, 0.1, len, 0, len]);
  }
  if (o.caps) { quad(g, P(b, 1, 1), P(b, -1, 1), P(b, -1, -1), P(b, 1, -1), col, k); quad(g, P(a, 1, -1), P(a, -1, -1), P(a, -1, 1), P(a, 1, 1), col, k); }
}

/** Rectangle with holes in the plane z = zf (facing +z): emits the solid parts as horizontal bands. */
function wallHoles(g, x0, x1, y0, y1, holes, zf, col, kf, us, uo = 0) {
  if (y1 - y0 < 1e-4 || x1 - x0 < 1e-4) return;
  const ys = [y0, y1];
  for (const h of holes) { for (const v of [h.v0, h.v1]) if (v > y0 + 1e-4 && v < y1 - 1e-4) ys.push(v); }
  ys.sort((a, b) => a - b);
  for (let b = 0; b < ys.length - 1; b++) {
    const ya = ys[b], yb = ys[b + 1];
    if (yb - ya < 1e-4) continue;
    const hs = holes.filter((h) => h.v0 <= ya + 1e-4 && h.v1 >= yb - 1e-4 && h.u1 > x0 && h.u0 < x1).sort((p, q) => p.u0 - q.u0);
    let u = x0;
    const ka = kf(ya), kb = kf(yb);
    for (const h of hs) { if (h.u0 > u + 1e-4) rectZ(g, u, ya, h.u0, yb, zf, 1, col, ka, kb, us, uo); u = Math.max(u, h.u1); }
    if (x1 > u + 1e-4) rectZ(g, u, ya, x1, yb, zf, 1, col, ka, kb, us, uo);
  }
}
/** The four inner faces of a rectangular opening from z = z0 back to z = z1 (z1 < z0). kIn = shade at the back. */
function reveal(g, u0, y0, u1, y1, z0, z1, col, kOut, kIn, us, o = {}) {
  const W = u1 - u0, H = y1 - y0, D = z0 - z1;
  if (!o.noSides) {
    quad(g, [u0, y0, z0], [u0, y0, z1], [u0, y1, z1], [u0, y1, z0], col, 1, [0, y0 / us, D / us, y0 / us, D / us, y1 / us, 0, y1 / us], [kOut, kIn, kIn, kOut], [1, 0, 0]);
    quad(g, [u1, y0, z1], [u1, y0, z0], [u1, y1, z0], [u1, y1, z1], col, 1, [0, y0 / us, D / us, y0 / us, D / us, y1 / us, 0, y1 / us], [kIn, kOut, kOut, kIn], [-1, 0, 0]);
  }
  if (!o.noTop) quad(g, [u0, y1, z1], [u1, y1, z1], [u1, y1, z0], [u0, y1, z0], col, 1, [u0 / us, 0, u1 / us, 0, u1 / us, D / us, u0 / us, D / us], [kIn, kIn, kOut, kOut], [0, -1, 0]);
  if (!o.noBot) quad(g, [u0, y0, z0], [u1, y0, z0], [u1, y0, z1], [u0, y0, z1], col, 1, [u0 / us, 0, u1 / us, 0, u1 / us, D / us, u0 / us, D / us], [kOut, kOut, kIn, kIn], [0, 1, 0]);
  void W; void H;
}

/** Append a prebuilt local mesh {p,n,i,uv} through matrix m (may scale), colour col × k(vertexIndex, localPos). */
function appendMesh(g, mesh, m, col, kf) {
  const e = m.elements, base = g.count, P = mesh.p, N = mesh.n, T = mesh.uv;
  for (let v = 0; v < P.length / 3; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    const X = e[0] * x + e[4] * y + e[8] * z + e[12], Y = e[1] * x + e[5] * y + e[9] * z + e[13], Z = e[2] * x + e[6] * y + e[10] * z + e[14];
    const nx0 = N[v * 3], ny0 = N[v * 3 + 1], nz0 = N[v * 3 + 2];
    let nx = e[0] * nx0 + e[4] * ny0 + e[8] * nz0, ny = e[1] * nx0 + e[5] * ny0 + e[9] * nz0, nz = e[2] * nx0 + e[6] * ny0 + e[10] * nz0;
    const l = Math.hypot(nx, ny, nz) || 1;
    V(g, X, Y, Z, nx / l, ny / l, nz / l, col, kf ? kf(v, x, y, z) : 1, T[v * 2], T[v * 2 + 1]);
  }
  for (const i of mesh.i) g.i.push(base + i);
}
/** Capture what a builder function emits into a standalone local mesh (for instancing by appendMesh). */
function capture(fn) {
  const g = new Geo({ uv: true }), keep = FE;
  FE = null; fn(g); FE = keep;
  return { p: g.p, n: g.n, i: g.i, uv: g.t, c: g.c };
}

// ───────────────────────────── noise + textures ─────────────────────────────
function h3(x, y, s) { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
/** periodic value noise, period pu×pv cells over the unit square */
function pnoise(u, v, pu, pv, s) {
  const x = u * pu, y = v * pv, xi = Math.floor(x), yi = Math.floor(y);
  let xf = x - xi, yf = y - yi; xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % pu) + pu) % pu, y0 = ((yi % pv) + pv) % pv, x1 = (x0 + 1) % pu, y1 = (y0 + 1) % pv;
  const a = h3(x0, y0, s), b = h3(x1, y0, s), c = h3(x0, y1, s), d = h3(x1, y1, s);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
function pfbm(u, v, pu, pv, oct, s) { let t = 0, a = 0.5, n = 0; for (let i = 0; i < oct; i++) { t += a * pnoise(u, v, pu, pv, s + i * 17); n += a; a *= 0.5; pu *= 2; pv *= 2; } return t / n; }

function canvasPair(N, M, fn, normalFrom) {
  const mk = () => { const c = document.createElement('canvas'); c.width = N; c.height = M; return c; };
  const ca = mk(), cr = mk(), ga = ca.getContext('2d'), gr = cr.getContext('2d');
  const ia = ga.createImageData(N, M), ir = gr.createImageData(N, M), da = ia.data, dr = ir.data;
  const hgt = normalFrom ? new Float32Array(N * M) : null;
  const a = [1, 1, 1], o = [0.5, 0];
  for (let y = 0, i = 0; y < M; y++) for (let x = 0; x < N; x++, i += 4) {
    // canvas row 0 is the top of the texture: v = 1 − y/M so v runs up like the uv
    fn(x / N, 1 - (y + 0.5) / M, a, o);
    da[i] = clamp01(a[0]) * 255; da[i + 1] = clamp01(a[1]) * 255; da[i + 2] = clamp01(a[2]) * 255; da[i + 3] = 255;
    const r = clamp01(o[0]) * 255; dr[i] = r; dr[i + 1] = r; dr[i + 2] = r; dr[i + 3] = 255;
    if (hgt) hgt[y * N + x] = o[1];
  }
  ga.putImageData(ia, 0, 0); gr.putImageData(ir, 0, 0);
  let cn = null;
  if (hgt) {
    cn = mk(); const gn = cn.getContext('2d'), inn = gn.createImageData(N, M), dn = inn.data;
    for (let y = 0, i = 0; y < M; y++) for (let x = 0; x < N; x++, i += 4) {
      const hl = hgt[y * N + (x + N - 1) % N], hr = hgt[y * N + (x + 1) % N], hu = hgt[((y + M - 1) % M) * N + x], hd = hgt[((y + 1) % M) * N + x];
      let nx = (hl - hr) * normalFrom, ny = (hd - hu) * normalFrom, nz = 1; const l = Math.hypot(nx, ny, nz);
      dn[i] = (nx / l * 0.5 + 0.5) * 255; dn[i + 1] = (ny / l * 0.5 + 0.5) * 255; dn[i + 2] = (nz / l * 0.5 + 0.5) * 255; dn[i + 3] = 255;
    }
    gn.putImageData(inn, 0, 0);
  }
  return { a: ca, r: cr, n: cn };
}
function texOf(c, srgb, clampT) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = clampT ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

let TX = null;
function textures() {
  if (TX) return TX;
  const t0 = performance.now();
  // painted metal: u wraps along the object, v = height above the ground / 1.6 m (grime and rust at the bottom)
  const paint = canvasPair(256, 256, (u, v, a, o) => {
    const n = pfbm(u, v, 6, 6, 4, 3), f = pnoise(u, v, 64, 64, 9), streak = Math.pow(pnoise(u, v * 0.25, 48, 2, 21), 3);
    const dirt = smoothstep(0.55, 0.0, v) * (0.45 + 0.55 * pfbm(u, v, 5, 3, 3, 5));
    const rustN = pfbm(u, v, 8, 8, 4, 11), rust = smoothstep(0.66 + v * 0.12, 0.74 + v * 0.12, rustN);
    const scratch = pnoise(u, v, 200, 6, 13) > 0.93 ? 1 : 0;
    let k = 0.9 + (n - 0.5) * 0.14 + (f - 0.5) * 0.04 - streak * 0.1 * smoothstep(0.1, 0.8, v);
    a[0] = k; a[1] = k; a[2] = k;
    // dirt: warm brown-grey film
    a[0] = lerp(a[0], 0.62, dirt * 0.7); a[1] = lerp(a[1], 0.55, dirt * 0.7); a[2] = lerp(a[2], 0.46, dirt * 0.7);
    a[0] = lerp(a[0], 0.56, rust); a[1] = lerp(a[1], 0.34, rust); a[2] = lerp(a[2], 0.2, rust);
    if (scratch) { a[0] = Math.min(1, a[0] * 1.12); a[1] = Math.min(1, a[1] * 1.12); a[2] = Math.min(1, a[2] * 1.12); }
    o[0] = 0.42 + (n - 0.5) * 0.12 + dirt * 0.42 + rust * 0.45 + streak * 0.12;
  });
  // weathered painted planks, tile ≈ 0.9 m
  const pwood = canvasPair(256, 256, (u, v, a, o) => {
    const pl = 4, p = Math.floor(u * pl), fx = u * pl - p;
    const grain = Math.sin((v * 22 + pfbm(u, v, 4, 4, 3, p + 2) * 5 + p * 2.1) * TAU) * 0.5 + 0.5;
    const peel = pfbm(u, v, 5, 5, 4, 31 + p);
    const paintOn = smoothstep(0.30, 0.36, peel);
    const n = pfbm(u, v, 16, 16, 2, 7);
    const wood = 0.5 + grain * 0.12 + (n - 0.5) * 0.1;
    const pnt = 0.88 + (n - 0.5) * 0.1 - (1 - smoothstep(0.36, 0.5, peel)) * 0.08;
    let k = lerp(wood, pnt, paintOn);
    const seam = fx < 0.03 || fx > 0.985 ? 0.45 : 1;
    a[0] = k * seam * (paintOn ? 1 : 0.95); a[1] = k * seam * (paintOn ? 1 : 0.9); a[2] = k * seam * (paintOn ? 1 : 0.8);
    o[0] = lerp(0.88, 0.62, paintOn) + (n - 0.5) * 0.1;
  });
  // bare steel: brushed along u, faint rust specks
  const metal = canvasPair(128, 128, (u, v, a, o) => {
    const br = pnoise(u, v, 4, 64, 41) * 0.5 + pnoise(u, v, 8, 128, 43) * 0.5, n = pfbm(u, v, 4, 4, 3, 47);
    const rs = smoothstep(0.7, 0.8, pfbm(u, v, 8, 8, 3, 53));
    const k = 0.8 + br * 0.16 + (n - 0.5) * 0.12;
    a[0] = lerp(k, 0.5, rs); a[1] = lerp(k, 0.32, rs); a[2] = lerp(k, 0.2, rs);
    o[0] = 0.32 + (n - 0.5) * 0.2 + br * 0.08 + rs * 0.5;
  });
  // rubber: left half is tyre tread (repeats along v), right half plain rubber / plastic
  const rubber = canvasPair(256, 256, (u, v, a, o) => {
    const n = pfbm(u, v, 16, 16, 2, 61);
    let h = 0.5;
    if (u < 0.5) {
      const x = u * 2, y = v * 24;   // 24 tread blocks per repeat
      const row = Math.floor(y), fy = y - row, off = (row % 2) * 0.17;
      const bx = ((x + off) * 3) % 1;
      const groove = (fy < 0.12 || bx < 0.1) ? 1 : 0;
      const centre = Math.abs(x - 0.5) < 0.03 ? 1 : 0;
      h = groove || centre ? 0 : 1;
      const k = groove || centre ? 0.55 : 0.95 + (n - 0.5) * 0.1;
      a[0] = k; a[1] = k; a[2] = k;
    } else { const k = 0.9 + (n - 0.5) * 0.14; a[0] = k; a[1] = k; a[2] = k; h = n * 0.2; }
    o[0] = 0.86 + (n - 0.5) * 0.1; o[1] = h;
  }, 1.6);
  // glass: dust and drying streaks only change the roughness
  const glass = canvasPair(128, 128, (u, v, a, o) => {
    const d = pfbm(u, v, 4, 4, 4, 71), st = Math.pow(pnoise(u, v, 32, 2, 73), 4);
    const dust = smoothstep(0.45, 0.8, d) * 0.5 + smoothstep(0.35, 0.0, v) * 0.25;
    const k = 1 - dust * 0.25; a[0] = k; a[1] = k; a[2] = k;
    o[0] = 0.07 + dust * 0.45 + st * 0.25;
  });
  TX = {
    paint: { map: texOf(paint.a, true, true), rough: texOf(paint.r, false, true) },
    pwood: { map: texOf(pwood.a, true), rough: texOf(pwood.r, false) },
    metal: { map: texOf(metal.a, true), rough: texOf(metal.r, false) },
    rubber: { map: texOf(rubber.a, true), rough: texOf(rubber.r, false), normal: texOf(rubber.n, false) },
    glass: { map: texOf(glass.a, true), rough: texOf(glass.r, false) },
    ms: performance.now() - t0,
  };
  return TX;
}

/** One material per structure batch, per level (the level's dispose() frees them). */
function mats(L) {
  if (L._stMats) return L._stMats;
  const T = textures();
  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, ...o });
  L._stMats = {
    st_paint: std({ map: T.paint.map, roughnessMap: T.paint.rough, metalness: 0.25, envMapIntensity: 0.7 }),
    st_pwood: std({ map: T.pwood.map, roughnessMap: T.pwood.rough, metalness: 0, envMapIntensity: 0.5 }),
    st_metal: std({ map: T.metal.map, roughnessMap: T.metal.rough, metalness: 0.6, envMapIntensity: 1.0 }),
    st_rubber: std({ map: T.rubber.map, roughnessMap: T.rubber.rough, normalMap: T.rubber.normal, normalScale: new THREE.Vector2(0.8, 0.8), metalness: 0, envMapIntensity: 0.4 }),
    st_glass: std({ map: T.glass.map, roughnessMap: T.glass.rough, metalness: 0.1, envMapIntensity: 1.3 }),
    st_cglass: std({ map: T.glass.map, roughnessMap: T.glass.rough, metalness: 0.1, envMapIntensity: 1.3, transparent: true, opacity: 0.62, depthWrite: false }),
    led: new THREE.MeshBasicMaterial({ color: 0x57ff7a }),
  };
  return L._stMats;
}

function SB(L, name) {
  const m = L._stb || (L._stb = new Map());
  let g = m.get(name);
  if (!g) { g = new Geo({ uv: true }); m.set(name, g); }
  return g;
}
/** The batches one builder writes into. */
function kit(L, wallTex) {
  return {
    wall: L._batch(wallTex || 'stone'), stone: L._batch('stone'), plaster: L._batch('plaster'), roof: L._batch('roof'), wood: L._batch('wood'),
    conc: L._batch('concrete'), cloth: L._batch('cloth'), dark: L._batch('dark'), glow: L._batch('glow'),
    paint: SB(L, 'st_paint'), pwood: SB(L, 'st_pwood'), metal: SB(L, 'st_metal'), rubber: SB(L, 'st_rubber'), glass: SB(L, 'st_glass'), cglass: SB(L, 'st_cglass'),
  };
}
const timed = (L, fn) => { const t0 = performance.now(); try { return fn(); } finally { FE = null; L._stTime = (L._stTime || 0) + performance.now() - t0; } };
const seedOf = (x, z, salt = 0) => (Math.floor(x * 7.31 + 1000) * 73856093) ^ (Math.floor(z * 5.17 + 1000) * 19349663) ^ (salt * 83492791);

/** Build this level's structure batches into meshes (called once from Level.finalize). */
export function finalizeStructures(L) {
  const t0 = performance.now();
  const M = mats(L);
  if (L._stb) {
    for (const [name, g] of L._stb) {
      if (!g.count) continue;
      const mesh = new THREE.Mesh(g.build(), M[name]);
      mesh.castShadow = name !== 'st_cglass'; mesh.receiveShadow = true;
      if (name === 'st_cglass') mesh.renderOrder = 2;
      mesh.name = name;
      L.group.add(mesh);
    }
  }
  L._stTime = (L._stTime || 0) + performance.now() - t0;
  L.structureStats = { ms: L._stTime, texMs: TX ? TX.ms : 0 };
}

// ───────────────────────────── windows, doors ─────────────────────────────
const FRAME_COLS = [0xe9e5dc, 0xe9e5dc, 0xd9d2c2, 0xa9bfb2, 0x93a9bd, 0x7a5c44];
const SHUT_COLS = [0x5f7d6a, 0x5a7288, 0x6b5440, 0x7f8f84, 0x4f6b5a, 0x8a6a4a];
const DOOR_COLS = [0x5c4433, 0x6b4d36, 0x4e5a52, 0x5a5e66, 0x7a4a32, 0x3f4a44];
const GLASS_B = [0.016, 0.02, 0.024], GLASS_T = [0.07, 0.08, 0.092];
const LIT_T = C(0xffb860), LIT_B = C(0xffd49a), LIT_CURTAIN = C(0xb8642c);
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);

/** One glazed pane in the plane z: glass with a tilted normal (so panes catch light differently), or lit. */
function pane(K, x0, y0, x1, y1, z, lit, rng) {
  if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return;
  if (lit) {
    const g = K.glow, i = g.count, cur = rng() < 0.3;
    const cb = cur ? mixC(LIT_B, LIT_CURTAIN, 0.55) : LIT_B, ct = cur ? mixC(LIT_T, LIT_CURTAIN, 0.4) : LIT_T;
    V(g, x0, y0, z, 0, 0, 1, cb, 1, 0, 0); V(g, x1, y0, z, 0, 0, 1, LIT_B, 1, 1, 0); V(g, x1, y1, z, 0, 0, 1, LIT_T, 1, 1, 1); V(g, x0, y1, z, 0, 0, 1, ct, 1, 0, 1);
    g.i.push(i, i + 1, i + 2, i, i + 2, i + 3);
    return;
  }
  const g = K.glass, i = g.count;
  let nx = (rng() - 0.5) * 0.16, ny = (rng() - 0.5) * 0.16 + 0.03;
  const l = Math.hypot(nx, ny, 1); nx /= l; ny /= l; const nz = 1 / l;
  const k = 0.7 + rng() * 0.6;
  V(g, x0, y0, z, nx, ny, nz, GLASS_B, k, x0, y0); V(g, x1, y0, z, nx, ny, nz, GLASS_B, k, x1, y0);
  V(g, x1, y1, z, nx, ny, nz, GLASS_T, k, x1, y1); V(g, x0, y1, z, nx, ny, nz, GLASS_T, k, x0, y1);
  g.i.push(i, i + 1, i + 2, i, i + 2, i + 3);
}
/** A dark room stub behind an opening (seen through broken or missing glass). */
function roomStub(K, u0, y0, u1, y1, z0, depth, rng) {
  const z1 = z0 - depth, col = C(0x3a3836);
  rectZ(K.dark, u0 - 0.3, y0 - 0.3, u1 + 0.3, y1 + 0.3, z1, 1, col, 0.35, 0.5, 2);
  reveal(K.dark, u0 - 0.3, y0 - 0.3, u1 + 0.3, y1 + 0.3, z0, z1, col, 0.55, 0.3, 2);
  if (rng() < 0.45) {   // a curtain left hanging
    const cu = rng() < 0.5 ? u0 + 0.05 : u1 - 0.35;
    rectZ(K.cloth, cu, y0 + 0.2, cu + 0.3, y1 + 0.1, z0 - 0.12, 1, C(rng.pick([0x8a6a5a, 0x6a7a6a, 0x9a8a6a])), 0.45, 0.7, 1.2);
  }
}
/** Jagged shards left in a frame. */
function shards(K, x0, y0, x1, y1, z, rng) {
  const W = x1 - x0, H = y1 - y0;
  const n = 2 + Math.floor(rng() * 3);
  for (let s = 0; s < n; s++) {
    const side = Math.floor(rng() * 4), t = rng() * 0.7 + 0.15, a = rng() * 0.25 + 0.15;
    let A, B, Cc;
    if (side === 0) { A = [x0 + W * (t - a), y0, z]; B = [x0 + W * (t + a), y0, z]; Cc = [x0 + W * t, y0 + H * (0.15 + rng() * 0.45), z]; }
    else if (side === 1) { A = [x1 - W * (t + a), y1, z]; B = [x1 - W * (t - a), y1, z]; Cc = [x1 - W * t, y1 - H * (0.1 + rng() * 0.3), z]; A = [A[0], A[1], z]; [A, B] = [B, A]; }
    else if (side === 2) { A = [x0, y0 + H * (t + a), z]; B = [x0, y0 + H * (t - a), z]; Cc = [x0 + W * (0.15 + rng() * 0.4), y0 + H * t, z]; }
    else { A = [x1, y0 + H * (t - a), z]; B = [x1, y0 + H * (t + a), z]; Cc = [x1 - W * (0.15 + rng() * 0.4), y0 + H * t, z]; }
    A[0] = clampN(A[0], x0, x1); B[0] = clampN(B[0], x0, x1); A[1] = clampN(A[1], y0, y1); B[1] = clampN(B[1], y0, y1);
    tri(K.glass, A, B, Cc, mulC(GLASS_T, 1.3), 1);
    tri(K.glass, B, A, Cc, mulC(GLASS_T, 1.3), 1);
  }
}
/** Segmental arch head over [u0,u1] springing at yb: spandrel infill at z=0 and the soffit back to z=-dep. */
const SEG_ARCH = (t) => 1 - (2 * t - 1) * (2 * t - 1);
const POINTED = (t) => 1 - Math.pow(Math.abs(2 * t - 1), 1.45);
function archHead(g, u0, u1, yb, rise, dep, col, us, n = 6, shape = SEG_ARCH) {
  const pts = [];
  for (let k = 0; k <= n; k++) { const t = k / n; pts.push([u0 + (u1 - u0) * t, yb + rise * shape(t)]); }
  const top = yb + rise;
  for (let k = 0; k < n; k++) {
    const [xa, ya] = pts[k], [xb, yb2] = pts[k + 1];
    if (top - Math.min(ya, yb2) > 1e-3) quad(g, [xa, ya, 0], [xb, yb2, 0], [xb, top, 0], [xa, top, 0], col, 0.92, [xa / us, ya / us, xb / us, yb2 / us, xb / us, top / us, xa / us, top / us], null, [0, 0, 1]);
    quad(g, [xa, ya, -dep], [xb, yb2, -dep], [xb, yb2, 0], [xa, ya, 0], col, 1, [xa / us, 0, xb / us, 0, xb / us, dep / us, xa / us, dep / us], [0.5, 0.5, 0.85, 0.85]);
  }
  return pts;
}
/** Dressed-stone ring around a segmental arch, proud by pr, with a keystone. */
function archRing(g, u0, u1, yb, rise, bw, pr, col, us, key, n = 6, shape = SEG_ARCH) {
  const ww = u1 - u0, inner = [], outer = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n, f = shape(t);
    inner.push([u0 + ww * t, yb + rise * f]);
    outer.push([u0 - bw + (ww + 2 * bw) * t, yb + (rise + bw * 1.15) * f + bw * 0.15]);
  }
  for (let k = 0; k < n; k++) {
    const a = inner[k], b = inner[k + 1], c = outer[k + 1], d = outer[k];
    quad(g, [a[0], a[1], pr], [b[0], b[1], pr], [c[0], c[1], pr], [d[0], d[1], pr], col, 1, [a[0] / us, a[1] / us, b[0] / us, b[1] / us, c[0] / us, c[1] / us, d[0] / us, d[1] / us], null, [0, 0, 1]);
    quad(g, [d[0], d[1], pr], [c[0], c[1], pr], [c[0], c[1], 0], [d[0], d[1], 0], col, 0.9);   // outer edge
    quad(g, [b[0], b[1], pr], [a[0], a[1], pr], [a[0], a[1], 0], [b[0], b[1], 0], col, 0.75);   // inner edge
  }
  // springers down to the impost
  for (const [x, s] of [[u0 - bw / 2, -1], [u1 + bw / 2, 1]]) box(g, x, yb + 0.04, pr / 2, bw, 0.2, pr, col, { skip: 32, us, k: 0.95 }), void s;
  if (key) box(g, (u0 + u1) / 2, yb + rise + bw * 0.55, pr / 2 + 0.012, 0.17, bw * 1.5, pr + 0.024, col, { skip: 32, us, k: 1.04 });
}

/**
 * A window in the current façade frame (u right, y up, z out of the wall; the wall face is z=0).
 * W: { u, ya, yb, ww, dep, lit, kind: glass|broken|boarded|closed, shut, arch, grille, door (glazed door to the floor) }
 */
function emitWindow(K, W, st, rng) {
  const { u, ya, ww, dep } = W, yb = W.yb, u0 = u - ww / 2, u1 = u + ww / 2, us = st.us;
  const rise = W.arch ? ww * 0.13 : 0;
  const trimG = st.isStone ? K.stone : K.plaster;
  reveal(K.wall, u0, ya, u1, yb, 0, -dep, st.wallCol, 0.86, 0.5, us, { noTop: W.arch });
  if (W.arch) archHead(K.wall, u0, u1, yb, rise, dep, st.wallCol, us);
  // sill: dressed stone, proud of the wall
  if (!W.door) box(K.stone, u, ya - 0.034, 0.018, ww + 0.16, 0.075, 0.115, st.trim, { skip: 32, us: 2.6, kb: 0.6 });
  else box(K.stone, u, ya - 0.03, -dep / 2 + 0.02, ww, 0.06, dep + 0.04, st.trim, { skip: 32 | 8, us: 2.6 });
  // head: arch ring + keystone, or flat lintel; plaster houses get a stucco surround
  if (W.arch) archRing(trimG, u0, u1, yb, rise, 0.16, 0.022, st.trim, 2.6, st.keystone);
  else {
    box(trimG, u, yb + 0.1, 0.012, ww + 0.26, 0.2, 0.024, st.trim, { skip: 32, us: 2.6 });
    if (st.keystone) box(trimG, u, yb + 0.12, 0.024, 0.17, 0.25, 0.048, st.trim, { skip: 32, us: 2.6, k: 1.05 });
  }
  if (st.surround) for (const x of [u0 - 0.06, u1 + 0.06]) box(K.plaster, x, (ya + yb) / 2, 0.01, 0.12, yb - ya, 0.02, st.trim, { skip: 32 | 4 | 8, us: 3.2 });
  const glassZ = -dep + 0.05, fw = 0.07, zc = -dep + 0.045;
  const kind = W.kind;
  if (kind === 'closed') {
    // shutters closed inside the reveal
    for (const [x0, x1] of [[u0, u], [u, u1]]) {
      box(K.pwood, (x0 + x1) / 2, (ya + yb) / 2, -0.07, x1 - x0 - 0.01, yb - ya, 0.03, st.shut, { skip: 32 });
      for (const fy of [0.18, 0.5, 0.82]) box(K.pwood, (x0 + x1) / 2, ya + (yb - ya) * fy, -0.05, x1 - x0 - 0.06, 0.07, 0.015, st.shut, { skip: 32 | 8, k: 0.92 });
    }
    if (W.arch) archFill(K, u0, u1, yb, rise, -0.08, st.shut, false, rng);
    return;
  }
  const missingAll = kind === 'boarded' || (kind === 'broken' && rng() < 0.3);
  if (kind === 'broken' || kind === 'boarded') roomStub(K, u0, ya, u1, yb + rise, -dep, 0.7, rng);
  // frame
  if (!(kind === 'boarded' && rng() < 0.4)) {
    box(K.pwood, u0 + fw / 2, (ya + yb) / 2, zc, fw, yb - ya, 0.09, st.frame, { skip: 32 | 2 });
    box(K.pwood, u1 - fw / 2, (ya + yb) / 2, zc, fw, yb - ya, 0.09, st.frame, { skip: 32 | 1 });
    box(K.pwood, u, yb - fw / 2, zc, ww - fw * 2, fw, 0.09, st.frame, { skip: 32 | 4 });
    box(K.pwood, u, ya + fw / 2, zc, ww - fw * 2, fw, 0.09, st.frame, { skip: 32 | 8 });
  }
  const ix0 = u0 + fw, ix1 = u1 - fw, iy0 = ya + fw, iy1 = yb - fw, ih = iy1 - iy0;
  const mw = 0.06, gb = 0.032;
  // glazing layout → bars and panes
  const bars = [], panes = [];
  if (W.door) {
    const ty = iy0 + ih * 0.34, fy = iy1 - ih * 0.18;
    bars.push([u - mw / 2, iy0, u + mw / 2, iy1], [ix0, ty - 0.04, ix1, ty + 0.04], [ix0, fy - mw / 2, ix1, fy + mw / 2], [ix0, (ty + fy) / 2 - gb / 2, ix1, (ty + fy) / 2 + gb / 2]);
    for (const [x0, x1] of [[ix0, u - mw / 2], [u + mw / 2, ix1]]) {
      box(K.pwood, (x0 + x1) / 2, (iy0 + ty) / 2, glassZ + 0.01, x1 - x0, ty - iy0, 0.04, st.frame, { skip: 32, k: 0.95 });   // lower panels
      panes.push([x0, ty + 0.04, x1, (ty + fy) / 2 - gb / 2], [x0, (ty + fy) / 2 + gb / 2, x1, fy - mw / 2]);
    }
    panes.push([ix0, fy + mw / 2, ix1, iy1]);
  } else if (st.panes === 'six') {
    const h3 = ih / 3;
    bars.push([u - mw / 2, iy0, u + mw / 2, iy1], [ix0, iy0 + h3 - gb / 2, ix1, iy0 + h3 + gb / 2], [ix0, iy0 + 2 * h3 - gb / 2, ix1, iy0 + 2 * h3 + gb / 2]);
    for (const [x0, x1] of [[ix0, u - mw / 2], [u + mw / 2, ix1]]) for (let r = 0; r < 3; r++) panes.push([x0, iy0 + r * h3 + (r ? gb / 2 : 0), x1, iy0 + (r + 1) * h3 - (r < 2 ? gb / 2 : 0)]);
  } else {
    const ty = iy1 - ih * (st.panes === 'T' ? 0.27 : 0.24);
    bars.push([ix0, ty - mw / 2, ix1, ty + mw / 2]);
    if (st.panes === 'T') {
      bars.push([u - mw / 2, iy0, u + mw / 2, ty - mw / 2]);
      panes.push([ix0, iy0, u - mw / 2, ty - mw / 2], [u + mw / 2, iy0, ix1, ty - mw / 2], [ix0, ty + mw / 2, ix1, iy1]);
    } else {
      bars.push([u - mw / 2, iy0, u + mw / 2, ty - mw / 2], [u - gb / 2, ty + mw / 2, u + gb / 2, iy1]);
      panes.push([ix0, iy0, u - mw / 2, ty - mw / 2], [u + mw / 2, iy0, ix1, ty - mw / 2], [ix0, ty + mw / 2, u - gb / 2, iy1], [u + gb / 2, ty + mw / 2, ix1, iy1]);
    }
  }
  if (!missingAll || kind === 'broken') for (const b of bars) box(K.pwood, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2, glassZ + 0.012, b[2] - b[0], b[3] - b[1], 0.05, st.frame, { skip: 32 });
  for (const p of panes) {
    if (missingAll) { if (kind === 'broken') shards(K, p[0], p[1], p[2], p[3], glassZ, rng); continue; }
    if (kind === 'broken' && rng() < 0.55) { shards(K, p[0], p[1], p[2], p[3], glassZ, rng); continue; }
    pane(K, p[0], p[1], p[2], p[3], glassZ, W.lit, rng);
  }
  if (W.arch) archFill(K, ix0 - fw, ix1 + fw, yb, rise, glassZ, st.frame, W.lit && !missingAll, rng, missingAll);
  // boards nailed across the opening
  if (kind === 'boarded') {
    const n = 3 + Math.floor(rng() * 2), plank = C(rng.pick([0x9a8a72, 0x8a7a64, 0xa89880]));
    for (let k = 0; k < n; k++) {
      const y = ya + (yb - ya) * ((k + 0.5) / n) + (rng() - 0.5) * 0.08;
      box(K.wood, u + (rng() - 0.5) * 0.06, y, 0.02, ww + 0.24, 0.17 + rng() * 0.06, 0.024, plank, { skip: 32, rz: (rng() - 0.5) * 0.22, us: 1.8 });
    }
  }
  // iron grille on some ground-floor windows
  if (W.grille && kind !== 'boarded') {
    const gc = C(0x2c2e2e), n = Math.max(3, Math.round(ww / 0.2));
    for (let k = 1; k < n; k++) box(K.paint, u0 + ww * (k / n), (ya + yb) / 2, -0.045, 0.018, yb - ya, 0.018, gc, { skip: 4 | 8 });
    for (const fy of [0.12, 0.88]) box(K.paint, u, ya + (yb - ya) * fy, -0.045, ww, 0.022, 0.012, gc, { skip: 1 | 2 });
  }
  // open shutters flat against the wall
  if (W.shut) {
    const lw = ww / 2 + 0.01, hh = yb - ya + 0.02, broken = rng() < 0.12;
    for (const s of [-1, 1]) {
      if (broken && s > 0) continue;
      const cx = s < 0 ? u0 - 0.03 - lw / 2 : u1 + 0.03 + lw / 2, rz = broken ? 0 : (rng() < 0.08 ? (rng() - 0.5) * 0.12 : 0);
      box(K.pwood, cx, (ya + yb) / 2, 0.016, lw, hh, 0.03, st.shut, { skip: 32, rz });
      for (const fy of [0.1, 0.5, 0.9]) box(K.pwood, cx, ya + hh * fy, 0.036, lw - 0.06, 0.06, 0.012, st.shut, { skip: 32 | 8, k: 0.9, rz });
    }
  }
}
/** Fanlight or infill under a segmental arch (between yb and the arch curve) at depth z. */
function archFill(K, u0, u1, yb, rise, z, frameCol, lit, rng, dark) {
  const n = 6, ww = u1 - u0, cx = (u0 + u1) / 2, g = lit ? K.glow : dark ? K.dark : K.glass;
  for (let k = 0; k < n; k++) {
    const t0 = k / n, t1 = (k + 1) / n;
    const a = [u0 + ww * t0, yb + rise * (1 - (2 * t0 - 1) ** 2), z], b = [u0 + ww * t1, yb + rise * (1 - (2 * t1 - 1) ** 2), z];
    const col = lit ? LIT_T : dark ? C(0x2a2826) : GLASS_T;
    tri(g, [cx, yb, z], b, a, col, lit ? 1 : 0.9);
  }
  void frameCol; void rng;
}

/** Door in the current façade frame. D: { u, dw, g (ground at the door), dh, fan, dep, kind, litFan, double } */
function emitDoor(K, D, st, rng) {
  const { u, dw, g, dep } = D, u0 = u - dw / 2, u1 = u + dw / 2, us = st.us;
  const yb = g + 0.16, yt = yb + D.dh, ytop = yt + D.fan;
  reveal(K.wall, u0, g - 0.12, u1, ytop, 0, -dep, st.wallCol, 0.86, 0.5, us, { noBot: true });
  // returns of the proud plinth
  rectX(K.stone, 0, g - 0.12, 0.04, st.pTop, u0, 1, st.plinthCol, 0.7, 0.8, 2.6);
  rectX(K.stone, 0, g - 0.12, 0.04, st.pTop, u1, -1, st.plinthCol, 0.7, 0.8, 2.6);
  // worn stone step filling the bottom of the recess
  box(K.stone, u, g + 0.02, -dep / 2 + 0.02, dw, 0.28, dep + 0.04, C(0xb8b2a6), { skip: 32 | 8, us: 2.6, kb: 0.7 });
  // stone surround + lintel
  const trimG = st.isStone ? K.stone : K.plaster;
  for (const x of [u0 - 0.08, u1 + 0.08]) box(trimG, x, (yb + ytop) / 2, 0.014, 0.16, ytop - yb, 0.028, st.trim, { skip: 32 | 8, us: 2.6 });
  box(trimG, u, ytop + 0.11, 0.02, dw + 0.42, 0.22, 0.04, st.trim, { skip: 32, us: 2.6 });
  box(trimG, u, ytop + 0.25, 0.05, dw + 0.56, 0.06, 0.1, st.trim, { skip: 32, us: 2.6, k: 1.05 });
  // frame, leaf, fanlight
  const fw = 0.075, zc = -dep + 0.05, frameCol = D.metal ? mulC(st.door, 0.8) : st.frame;
  const FG = D.metal ? K.paint : K.pwood;
  box(FG, u0 + fw / 2, (yb + ytop) / 2, zc, fw, ytop - yb, 0.1, frameCol, { skip: 32 | 2 });
  box(FG, u1 - fw / 2, (yb + ytop) / 2, zc, fw, ytop - yb, 0.1, frameCol, { skip: 32 | 1 });
  box(FG, u, ytop - fw / 2, zc, dw - 2 * fw, fw, 0.1, frameCol, { skip: 32 | 4 });
  if (D.fan > 0.05) {
    box(FG, u, yt + 0.03, zc, dw - 2 * fw, 0.06, 0.1, frameCol, { skip: 32 });
    pane(K, u0 + fw, yt + 0.06, u1 - fw, ytop - fw, -dep + 0.04, D.litFan, rng);
  }
  const lx0 = u0 + fw, lx1 = u1 - fw, lz = -dep + 0.035, ajar = !D.metal && !D.double && rng() < 0.18;
  const leaves = D.double ? [[lx0, u - 0.004], [u + 0.004, lx1]] : [[lx0, lx1]];
  if (ajar) rectZ(K.dark, lx0 - 0.1, yb, lx1 + 0.1, yt, -dep - 0.5, 1, C(0x2a2826), 0.35, 0.35, 2);   // dark hall behind
  const leafG = D.metal ? K.paint : K.pwood;
  for (const [x0, x1] of leaves) {
    const lw = x1 - x0;
    let cx = (x0 + x1) / 2, cz = lz;
    const keep = FE ? _F.clone() : null;
    if (ajar) { setFrame(keep.clone().multiply(new THREE.Matrix4().makeTranslation(x0, 0, lz).multiply(new THREE.Matrix4().makeRotationY(0.32)))); cx = lw / 2; cz = 0; }
    box(leafG, cx, (yb + yt) / 2, cz, lw, yt - yb, 0.045, st.door, { skip: ajar ? 0 : 32 });
    const zp = cz + 0.03;
    if (D.metal) {
      for (const fy of [0.25, 0.5, 0.75]) box(K.paint, cx, yb + (yt - yb) * fy, zp - 0.005, lw - 0.12, 0.05, 0.02, mulC(st.door, 0.9), { skip: 32 });
    } else {
      const pw = lw - 0.2, cols = lw > 0.7 ? 2 : 1, pcw = (pw - (cols - 1) * 0.1) / cols;
      for (let ci = 0; ci < cols; ci++) for (const [fy0, fy1] of [[0.08, 0.42], [0.5, 0.94]]) {
        box(K.pwood, cx - pw / 2 + pcw / 2 + ci * (pcw + 0.1), yb + (yt - yb) * (fy0 + fy1) / 2, zp - 0.008, pcw, (yt - yb) * (fy1 - fy0), 0.022, mulC(st.door, 1.08), { skip: 32 });
      }
    }
    const hx = ajar ? lw - 0.09 : (D.double ? (x0 < u ? x1 - 0.08 : x0 + 0.08) : x1 - 0.1);
    box(K.metal, hx, yb + 1.0, zp + 0.025, 0.03, 0.16, 0.03, C(0x8a8478));
    box(K.metal, hx, yb + 1.0, zp + 0.06, 0.12, 0.025, 0.025, C(0x8a8478));
    if (ajar) setFrame(keep);
  }
}

// ───────────────────────────── houses ─────────────────────────────
/**
 * Visuals for Level.house(). h: { x, z, w, d, rot, floors, fh, H, top, y0, flat, rh, tex, tint, roofTint,
 * door, ladder, ladderAt, isLit(i, f, side) } — isLit is the kit's own rule, so lit windows sit exactly
 * where the kit registers their lamps.
 */
export function buildHouse(L, h) { return timed(L, () => houseImpl(L, h)); }

function houseImpl(L, h) {
  const { x, z, w, d, rot, floors, fh, top, y0, flat } = h;
  const K = kit(L, h.tex), rng = makeRng(seedOf(x, z, 1));
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
  const gyL = (lx, lz) => { const p = P(lx, lz); return L.gy(p[0], p[1]); };
  const gMax = top - h.H, isStone = h.tex === 'stone';
  const st = {
    isStone, us: TEX_SCALE[h.tex] || 2.6, wallCol: C(h.tint ?? 0xffffff),
    frame: C(rng.pick(FRAME_COLS)), shut: C(rng.pick(SHUT_COLS)), door: C(rng.pick(DOOR_COLS)),
    panes: rng.pick(['T', 'six', 'two', 'T', 'six']), arch: rng.chance(isStone ? 0.55 : 0.3),
    shutters: rng.chance(0.6), quoins: rng.chance(isStone ? 0.7 : 0.8), plinthH: rng.range(0.42, 0.68),
    damage: rng() * rng(), grille: rng.chance(0.35), surround: !isStone && rng.chance(0.7), keystone: rng.chance(0.65),
    trim: C(isStone ? 0xe8e2d4 : 0xe4ddcf), plinthCol: C(isStone ? 0xa29c90 : 0xaaa496),
  };
  st.pTop = gMax + st.plinthH;
  const wallTop = flat ? top + 0.55 : top;
  const floorY = (f) => gMax + f * fh;
  const dep = rng.range(0.2, 0.25);
  const corniceBot = flat ? top - 0.3 : top - 0.34;
  const SIDES = [
    { key: 's', len: w, ox: 0, oz: d / 2, th: 0, sgn: 1, ns: true },
    { key: 'e', len: d, ox: w / 2, oz: 0, th: PI / 2, ns: false },
    { key: 'n', len: w, ox: 0, oz: -d / 2, th: PI, sgn: -1, ns: true },
    { key: 'w', len: d, ox: -w / 2, oz: 0, th: -PI / 2, ns: false },
  ];
  const nW = Math.max(1, Math.floor(w / 3.4)), nD = Math.max(1, Math.floor(d / 3.4));
  SIDES.forEach((S, si) => {
    const o = P(S.ox, S.oz);
    S.M = mat4At(o[0], 0, o[1], rot + S.th);
    const ux = Math.cos(S.th), uz = -Math.sin(S.th);
    S.toL = (u) => [S.ox + u * ux, S.oz + u * uz];
    S.g = (u) => { const l = S.toL(u); return gyL(l[0], l[1]); };
    S.n = S.ns ? nW : nD; S.sp = S.len / S.n; S.uo = si * 1.37;
    S.ww = clampN(S.sp * 0.34, 0.85, 1.2);
    S.cols = [];
    for (let i = 0; i < S.n; i++) {
      const lp = -S.len / 2 + (i + 0.5) * S.sp;
      S.cols.push({ i, u: S.key === 's' || S.key === 'w' ? lp : -lp });
    }
  });
  const byKey = Object.fromEntries(SIDES.map((S) => [S.key, S]));
  const ladSide = h.ladder || null, ladOff = h.ladderAt ?? 0;
  const ladU = !ladSide ? null : ladSide === 's' || ladSide === 'w' ? ladOff : -ladOff;
  // a balcony or glazed gallery on the top floor of some houses
  let bal = null;
  if (floors >= 2 && rng.chance(0.55)) {
    const cands = SIDES.filter((S) => S.key !== ladSide && S.n >= 2);
    if (cands.length) {
      const S = rng.pick(cands), gallery = S.n >= 3 && rng.chance(0.5);
      if (gallery) { const k = Math.min(S.n - 1, rng.int(2, 3)), i0 = Math.floor((S.n - k) / 2); bal = { S, kind: 'gallery', i0, i1: i0 + k - 1, lit: new Set() }; }
      else { const ib = Math.floor((S.n - 1) / 2) + (S.n % 2 ? 0 : rng.int(0, 1)); bal = { S, kind: 'open', i0: ib, i1: ib, lit: new Set() }; }
    }
  }
  const ft = floors - 1;
  const pipeSides = new Set();
  if (floors >= 2 && rng.chance(0.55)) { const opts = SIDES.filter((S) => !bal || bal.S !== S); pipeSides.add(rng.pick(opts).key); if (rng.chance(0.4)) pipeSides.add(rng.pick(opts).key); }

  for (const S of SIDES) {
    setFrame(S.M);
    const half = S.len / 2, holes = [], wins = [];
    let door = null;
    if (h.door === S.key) {
      const g = S.g(0), dbl = rng.chance(0.3);
      door = { u: 0, dw: dbl ? 1.5 : rng.range(1.1, 1.25), g, dh: 2.1, fan: 0.36, dep: dep + 0.06, double: dbl, metal: rng.chance(0.25), litFan: false };
      holes.push({ u0: -door.dw / 2, u1: door.dw / 2, v0: g - 0.12, v1: g + 0.16 + door.dh + door.fan });
    }
    for (let f = 0; f < floors; f++) {
      const ya = floorY(f) + 0.9;
      const lim = (f === ft ? corniceBot : floorY(f + 1) - 0.26) - 0.04;
      for (const col of S.cols) {
        const u = col.u, lit = S.ns ? !!h.isLit(col.i, f, S.sgn) : false;
        if (door && f === 0 && Math.abs(u) < S.ww / 2 + door.dw / 2 + 0.25) { if (lit) door.litFan = true; continue; }
        const inBal = bal && bal.S === S && f === ft && col.i >= bal.i0 && col.i <= bal.i1;
        if (inBal && bal.kind === 'gallery') { if (lit) bal.lit.add(col.i); continue; }
        const arch = st.arch;
        const ww = inBal ? 1.08 : S.ww;
        const extra = arch ? ww * 0.13 + 0.2 : 0.22;
        const wa = inBal ? floorY(f) + 0.06 : ya;
        const wb = Math.min(inBal ? floorY(f) + 2.42 : ya + (f === 0 ? 1.45 : 1.55), lim - extra);
        const nearEnd = half - Math.abs(u) < ww + 0.55, nearLad = ladU !== null && S.key === ladSide && Math.abs(u - ladU) < ww + 0.75;
        const nearDoor = door && f === 0 && Math.abs(u) < ww + door.dw / 2 + 0.3;
        let kind = 'glass';
        if (!lit && !inBal) {
          const r = rng();
          if (r < 0.03 + st.damage * 0.1) kind = 'boarded';
          else if (r < 0.08 + st.damage * 0.28) kind = 'broken';
          else if (st.shutters && r < 0.2 + st.damage * 0.1) kind = 'closed';
        }
        const W = { u, ya: wa, yb: wb, ww, dep, lit, kind, arch, door: inBal, grille: st.grille && f === 0 && !nearDoor,
          shut: st.shutters && !inBal && kind !== 'closed' && kind !== 'boarded' && !nearEnd && !nearLad && !nearDoor && rng.chance(0.8) };
        wins.push(W);
        holes.push({ u0: u - ww / 2, u1: u + ww / 2, v0: wa, v1: wb + (arch ? ww * 0.13 : 0) });
        if (inBal) bal.door = W;
      }
    }
    // plinth (proud), its chamfered top, then the wall with its openings
    const pHoles = holes.filter((q) => q.v0 < st.pTop);
    wallHoles(K.stone, -half - 0.04, half + 0.04, y0, st.pTop, pHoles, 0.04, st.plinthCol, (y) => 0.7 + 0.22 * smoothstep(y0 + 0.3, st.pTop, y), 2.6, S.uo);
    let a = -half - 0.04;
    const cuts = pHoles.filter((q) => q.v1 > st.pTop).sort((p, q) => p.u0 - q.u0);
    for (const q of [...cuts, { u0: half + 0.04, u1: half + 0.04 }]) {
      const b = q.u0;
      if (b > a + 1e-3) {
        const ea = a < -half ? -half : a, eb = b > half ? half : b;
        quad(K.stone, [a, st.pTop, 0.04], [b, st.pTop, 0.04], [eb, st.pTop + 0.035, 0], [ea, st.pTop + 0.035, 0], st.plinthCol, 0.95);
      }
      a = q.u1;
    }
    const kf = (y) => (0.8 + 0.2 * smoothstep(gMax - 0.4, gMax + 1.8, y)) * (1 - 0.16 * smoothstep(wallTop - 1.2, wallTop, y));
    wallHoles(K.wall, -half, half, st.pTop, wallTop, holes, 0, st.wallCol, kf, st.us, S.uo);
    for (const W of wins) emitWindow(K, W, st, rng);
    if (door) emitDoor(K, door, st, rng);
    if (bal && bal.S === S) emitBalcony(K, bal, S, st, floorY(ft), flat, top, rng);
    // gas pipe: the yellow line along Caucasus façades, with a riser at one end
    if (pipeSides.has(S.key)) {
      const py = floorY(1) + 0.2, pc = C(0xc9a63a), r = 0.028;
      cyl(K.paint, 0, py, 0.085, r, r, S.len - 0.7, pc, { axis: 'x', seg: 6, caps: false });
      for (let bu = -half + 0.6; bu < half - 0.4; bu += 2.1) box(K.paint, bu, py, 0.04, 0.04, 0.07, 0.08, C(0x3a3a38), { skip: 32 });
      const ru = -half + 0.4, rg = S.g(ru);
      cyl(K.paint, ru, (py + rg + 0.9) / 2, 0.085, r, r, py - rg - 0.9, pc, { seg: 6, caps: false });
      box(K.paint, ru, rg + 0.9, 0.05, 0.07, 0.07, 0.11, pc, { skip: 32 });
      box(K.paint, ru + 0.3, rg + 1.25, 0.06, 0.34, 0.42, 0.12, C(0x9a9e98), { skip: 32 });   // meter box
    }
  }
  // satellite dish on some houses
  if (rng.chance(0.3)) {
    const S = rng.pick(SIDES.filter((q) => q.n >= 2 && q.key !== ladSide && (!bal || bal.S !== q)));
    if (S) {
      setFrame(S.M);
      const i = rng.int(0, S.n - 2), u = (S.cols[i].u + S.cols[i + 1].u) / 2, y = floorY(ft) + 1.9;
      dish(K.paint, u, y, 0.34, 0.32, C(0xd8d8d2), rng);
    }
  }

  // ── corners, string courses, cornice (house-local frame)
  setFrame(mat4At(x, 0, z, rot));
  if (st.quoins) {
    const qc = st.trim, qh = 0.42, p = 0.025, qG = K.stone;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      let alt = 0;
      for (let y = st.pTop + 0.04; y + qh * 0.8 < corniceBot; y += qh) {
        const hh = Math.min(qh, corniceBot - y) - 0.025, la = alt ? 0.28 : 0.46, lb = alt ? 0.46 : 0.28;
        box(qG, sx * (w / 2 - la / 2 + p / 2), y + hh / 2, sz * (d / 2 - lb / 2 + p / 2), la + p, hh, lb + p, mulC(qc, 0.94 + ((alt + sx + sz) & 1) * 0.06),
          { skip: (sx > 0 ? 2 : 1) | (sz > 0 ? 32 : 16), us: 2.6 });
        alt ^= 1;
      }
    }
  }
  const trimG = isStone ? K.stone : K.plaster;
  for (let f = 1; f < floors; f++) {
    const y = floorY(f) - 0.24;
    sweepRect(trimG, w / 2, d / 2, [[0, y, 0.75], [0.045, y + 0.015, 0.8], [0.045, y + 0.13, 1], [0, y + 0.16, 1.05]], st.trim, { us: 2.6 });
  }
  if (flat) {
    const t = top;
    sweepRect(trimG, w / 2, d / 2, [[0, t - 0.3, 0.7], [0.04, t - 0.29, 0.75], [0.05, t - 0.2, 0.85], [0.13, t - 0.12, 0.8], [0.14, t - 0.04, 1], [0.0, t - 0.0, 1.05]], st.trim, { us: 2.6 });
    flatRoof(K, h, st, rng);
  } else {
    const t = top;
    sweepRect(trimG, w / 2, d / 2, [[0, t - 0.34, 0.7], [0.03, t - 0.32, 0.75], [0.03, t - 0.24, 0.85], [0.09, t - 0.18, 0.75], [0.11, t - 0.1, 0.9], [0.2, t - 0.05, 0.85], [0.2, t, 1], [0, t + 0.002, 1]], st.trim, { us: 2.6 });
    gableRoof(K, h, st, rng, gyL);
  }
  FE = null;
}

/** Wall-mounted satellite dish in the current façade frame. */
function dish(g, u, y, out, r, col, rng) {
  box(g, u, y - 0.25, 0.03, 0.08, 0.16, 0.06, mulC(col, 0.7), { skip: 32 });
  bar(g, [u, y - 0.25, 0.06], [u, y - 0.05, out - 0.08], 0.03, mulC(col, 0.7));
  const m = new THREE.Matrix4().makeTranslation(u, y, out).multiply(new THREE.Matrix4().makeRotationY((rng() - 0.5) * 0.9)).multiply(new THREE.Matrix4().makeRotationX(-0.35));
  const keep = FE ? _F.clone() : null;
  setFrame(keep ? keep.clone().multiply(m) : m);
  lathe(g, 0, 0, 0, [[0.001, -0.02], [r * 0.5, -0.005], [r, 0.04], [r, 0.04], [r * 0.96, 0.03], [0.001, -0.035]], col, { seg: 14, axis: 'z' });
  bar(g, [0, -r * 0.9, 0.04], [0, -0.02, 0.32], 0.02, mulC(col, 0.8));
  box(g, 0, -0.02, 0.33, 0.05, 0.06, 0.08, C(0x3a3a38));
  setFrame(keep);
}

/** Open wooden balcony or glazed gallery (shushebend) on the top floor, in the façade frame. */
function emitBalcony(K, bal, S, st, fy, flat, top, rng) {
  const wood = C(rng.pick([0x6a5240, 0x7a6048, 0x5e4a3a]));
  const sp = S.sp;
  if (bal.kind === 'open') {
    const u = S.cols[bal.i0].u, bw = 2.3, dz = 0.9;
    // slab and stone corbels
    box(K.stone, u, fy - 0.03, dz / 2, bw, 0.16, dz, st.trim, { skip: 32, us: 2.6, kb: 0.75 });
    for (const s of [-1, 1]) {
      const cx = u + s * (bw / 2 - 0.25);
      prism(K.stone, [[0, -0.11], [dz - 0.08, -0.11], [dz - 0.1, -0.2], [0.35, -0.42], [0.08, -0.62], [0, -0.62]].map(([a, b]) => [a, fy + b]), 'zy', cx - 0.08, cx + 0.08, st.trim, { us: 2.6, k: 0.9 });
    }
    // railing: wooden balusters, rails, corner posts
    const rail = st.frame, ry0 = fy + 0.05, ry1 = fy + 0.98;
    const ends = [[u - bw / 2 + 0.05, dz - 0.05], [u + bw / 2 - 0.05, dz - 0.05]];
    for (const [px] of ends) box(K.pwood, px, (ry0 + ry1) / 2, dz - 0.05, 0.08, ry1 - ry0, 0.08, rail, { skip: 8 });
    box(K.pwood, u, ry1 - 0.03, dz - 0.05, bw - 0.1, 0.07, 0.09, rail, { skip: 8 });
    box(K.pwood, u, ry0 + 0.1, dz - 0.05, bw - 0.1, 0.05, 0.06, rail);
    for (const s of [-1, 1]) {
      const px = u + s * (bw / 2 - 0.05);
      box(K.pwood, px, ry1 - 0.03, dz / 2, 0.07, 0.07, dz - 0.1, rail, { skip: 8 });
      box(K.pwood, px, ry0 + 0.1, dz / 2, 0.05, 0.05, dz - 0.1, rail);
      for (let zz = 0.15; zz < dz - 0.1; zz += 0.14) box(K.pwood, px, (ry0 + ry1) / 2 + 0.02, zz, 0.035, ry1 - ry0 - 0.1, 0.035, rail, { skip: 4 | 8 });
    }
    for (let xx = u - bw / 2 + 0.16; xx < u + bw / 2 - 0.1; xx += 0.13) box(K.pwood, xx, (ry0 + ry1) / 2 + 0.02, dz - 0.05, 0.035, ry1 - ry0 - 0.1, 0.035, rail, { skip: 4 | 8 });
    // a lean-to tin canopy on posts above some balconies
    if (rng.chance(0.5)) {
      const cy0 = Math.min(fy + 2.85, (flat ? top - 0.32 : top - 0.36)), cy1 = cy0 - 0.25;
      quad(K.roof, [u - bw / 2 - 0.1, cy1, dz + 0.12], [u + bw / 2 + 0.1, cy1, dz + 0.12], [u + bw / 2 + 0.1, cy0, 0], [u - bw / 2 - 0.1, cy0, 0], C(0xd8d0c8), 1, null);
      quad(K.roof, [u + bw / 2 + 0.1, cy1 - 0.02, dz + 0.12], [u - bw / 2 - 0.1, cy1 - 0.02, dz + 0.12], [u - bw / 2 - 0.1, cy0 - 0.02, 0], [u + bw / 2 + 0.1, cy0 - 0.02, 0], C(0x8a8478), 0.7, null);
      for (const [px] of ends) box(K.pwood, px, (ry1 + cy1) / 2, dz - 0.05, 0.07, cy1 - ry1, 0.07, rail, { skip: 4 | 8 });
    }
    return;
  }
  // glazed gallery spanning several bays
  const us0 = Math.min(...S.cols.filter((q) => q.i >= bal.i0 && q.i <= bal.i1).map((q) => q.u)), us1 = Math.max(...S.cols.filter((q) => q.i >= bal.i0 && q.i <= bal.i1).map((q) => q.u));
  const uA = us0 - sp / 2 + 0.22, uB = us1 + sp / 2 - 0.22, dz = 0.85, W = uB - uA, cx = (uA + uB) / 2;
  const fc = st.frame, ytop = Math.min(fy + 2.5, (flat ? top - 0.36 : top - 0.4));
  const litAt = (uu) => { let best = null, bd = 1e9; for (const q of S.cols) { const dd = Math.abs(q.u - uu); if (dd < bd) { bd = dd; best = q; } } return best && bal.lit.has(best.i); };
  box(K.wood, cx, fy - 0.12, dz / 2, W, 0.24, dz, wood, { skip: 32, us: 1.8, kb: 0.7 });
  for (let uu = uA + 0.3; uu <= uB - 0.25; uu += Math.max(0.9, (W - 0.6) / Math.max(1, Math.round((W - 0.6) / 1.2)))) bar(K.wood, [uu, fy - 0.95, 0.03], [uu, fy - 0.26, dz - 0.12], 0.09, mulC(wood, 0.9));
  // lower panelled apron (front + ends)
  box(K.pwood, cx, fy + 0.45, dz - 0.03, W, 0.86, 0.06, fc, { skip: 32 | 8 });
  for (const s of [-1, 1]) box(K.pwood, s < 0 ? uA + 0.03 : uB - 0.03, fy + 0.45, dz / 2, 0.06, 0.86, dz - 0.06, fc, { skip: 8 });
  const nP = Math.max(2, Math.round(W / 0.62));
  for (let k = 0; k < nP; k++) box(K.pwood, uA + (k + 0.5) * (W / nP), fy + 0.45, dz + 0.005, W / nP - 0.12, 0.6, 0.02, mulC(fc, 0.93), { skip: 32 });
  // glazing: mullions, transom, panes
  const gy0 = fy + 0.88, gy1 = ytop - 0.08, ty = gy1 - (gy1 - gy0) * 0.26, nC = Math.max(3, Math.round(W / 0.55)), cw = W / nC;
  for (let k = 0; k <= nC; k++) box(K.pwood, uA + k * cw, (gy0 + gy1) / 2, dz - 0.03, 0.06, gy1 - gy0, 0.08, fc, { skip: 32 });
  box(K.pwood, cx, ty, dz - 0.03, W, 0.05, 0.08, fc, { skip: 32 });
  box(K.pwood, cx, gy1 + 0.05, dz - 0.03, W + 0.08, 0.12, 0.1, fc, { skip: 32 });
  box(K.pwood, cx, gy0 - 0.02, dz - 0.02, W + 0.06, 0.06, 0.1, fc, { skip: 32 | 8 });
  for (let k = 0; k < nC; k++) {
    const x0 = uA + k * cw + 0.03, x1 = uA + (k + 1) * cw - 0.03, lit = litAt((x0 + x1) / 2);
    pane(K, x0, gy0 + 0.01, x1, ty - 0.025, dz - 0.035, lit, rng);
    pane(K, x0, ty + 0.025, x1, gy1, dz - 0.035, lit, rng);
  }
  // ends: two columns of panes across the depth (drawn in the end planes)
  for (const s of [-1, 1]) {
    const xe = s < 0 ? uA : uB;
    const keep = FE ? _F.clone() : null;
    const m = new THREE.Matrix4().makeTranslation(xe, 0, dz / 2).multiply(new THREE.Matrix4().makeRotationY(s * PI / 2));
    setFrame(keep ? keep.clone().multiply(m) : m);
    for (let k = 0; k <= 2; k++) box(K.pwood, -dz / 2 + 0.03 + k * (dz - 0.06) / 2, (gy0 + gy1) / 2, 0, 0.06, gy1 - gy0, 0.07, fc, { skip: 32 });
    for (let k = 0; k < 2; k++) {
      const x0 = -dz / 2 + 0.06 + k * (dz - 0.06) / 2, x1 = x0 + (dz - 0.06) / 2 - 0.06;
      pane(K, x0, gy0, x1, ty - 0.025, 0.0, false, rng); pane(K, x0, ty + 0.025, x1, gy1, 0.0, false, rng);
    }
    setFrame(keep);
  }
  // lean-to roof over the gallery
  const ry0 = gy1 + 0.4, ry1 = gy1 + 0.13;
  quad(K.roof, [uA - 0.12, ry1, dz + 0.14], [uB + 0.12, ry1, dz + 0.14], [uB + 0.12, ry0, 0], [uA - 0.12, ry0, 0], C(0xd0c8c0), 1, null);
  quad(K.roof, [uB + 0.12, ry1 - 0.03, dz + 0.14], [uA - 0.12, ry1 - 0.03, dz + 0.14], [uA - 0.12, ry0 - 0.03, 0], [uB + 0.12, ry0 - 0.03, 0], C(0x7a746a), 0.6, null);
  rectZ(K.pwood, uA - 0.12, ry1 - 0.1, uB + 0.12, ry1, dz + 0.14, 1, fc, 0.9, 0.9);
  for (const s of [-1, 1]) { const xe = s < 0 ? uA : uB; prism(K.pwood, [[0, gy1 + 0.11], [dz, gy1 + 0.11], [dz, ry1], [0, ry0]], 'zy', xe - 0.03, xe + 0.03, fc, { k: 0.9 }); }
}

/** Two-pitch gable roof whose break line runs along the edge of the kit's roof collider. */
function gableRoof(K, h, st, rng, gyL) {
  const { w, d, top } = h, rh = h.rh, hd = d / 2, ov = 0.42, vg = 0.32;
  const yW = top + 0.1, zb = 0.3 * d, yB = top + 0.6 * rh;
  const s1 = (yB - yW) / (hd - zb), ze = hd + ov, yE = yW - ov * s1;
  const s2 = clampN(s1 * 0.5, 0.12, 0.36), yR = yB + zb * s2;
  const X0 = -w / 2 - vg, X1 = w / 2 + vg, us = TEX_SCALE.roof || 2.4;
  const tints = [0xffffff, 0xf0e8e0, 0xe0d8d0, 0xc8c4c0, 0xd8c8b8];
  const rc = C(h.roofTint ?? rng.pick(tints));
  const l1 = Math.hypot(ze - zb, yB - yE), l2 = Math.hypot(zb, yR - yB);
  const segs = [[ze, yE, zb, yB, 0, l1], [zb, yB, 0, yR, l1, l1 + l2]];
  for (const sg of [1, -1]) for (const [za, ya, zc, yc, va, vc] of segs) {
    const uv = [X0 / us, va / us, X1 / us, va / us, X1 / us, vc / us, X0 / us, vc / us];
    const k = sg > 0 ? 1 : 0.94;
    if (sg > 0) quad(K.roof, [X0, ya, za], [X1, ya, za], [X1, yc, zc], [X0, yc, zc], rc, k, uv);
    else quad(K.roof, [X1, ya, -za], [X0, ya, -za], [X0, yc, -zc], [X1, yc, -zc], rc, k, [uv[2], uv[3], uv[0], uv[1], uv[6], uv[7], uv[4], uv[5]]);
    // underside of the verge overhang at both gable ends
    for (const sx of [1, -1]) {
      const xa = sx * w / 2, xb = sx * X1, off = 0.16;
      const A = [xa, ya - off, sg * za], B = [xb, ya - off, sg * za], Cq = [xb, yc - off, sg * zc], D = [xa, yc - off, sg * zc];
      if (sx * sg > 0) quad(K.wood, B, A, D, Cq, C(0x6a5a4a), 0.55); else quad(K.wood, A, B, Cq, D, C(0x6a5a4a), 0.55);
      // bargeboard
      const E = [xb, ya + 0.02, sg * za], Fp = [xb, yc + 0.02, sg * zc], G = [xb, yc - 0.2, sg * zc], Hh = [xb, ya - 0.2, sg * za];
      if (sx * sg > 0) quad(K.pwood, Hh, G, Fp, E, st.frame, 0.85); else quad(K.pwood, G, Hh, E, Fp, st.frame, 0.85);
    }
  }
  // fascia, soffit, gutter at both eaves
  const gutC = C(rng.pick([0x8c9090, 0x7a7e7c, 0x6a5a4a]));
  for (const sg of [1, -1]) {
    const zF = sg * ze;
    if (sg > 0) {
      quad(K.pwood, [X0, yE - 0.17, zF], [X1, yE - 0.17, zF], [X1, yE + 0.03, zF], [X0, yE + 0.03, zF], st.frame, 0.85);
      quad(K.wood, [X1, yE - 0.17, zF], [X0, yE - 0.17, zF], [X0, top + 0.002, hd + 0.2], [X1, top + 0.002, hd + 0.2], C(0x6a5a4a), 0.5);
    } else {
      quad(K.pwood, [X1, yE - 0.17, zF], [X0, yE - 0.17, zF], [X0, yE + 0.03, zF], [X1, yE + 0.03, zF], st.frame, 0.85);
      quad(K.wood, [X0, yE - 0.17, zF], [X1, yE - 0.17, zF], [X1, top + 0.002, -hd - 0.2], [X0, top + 0.002, -hd - 0.2], C(0x6a5a4a), 0.5);
    }
    box(K.paint, 0, yE - 0.1, sg * (ze + 0.07), X1 - X0 + 0.04, 0.11, 0.13, gutC, { us: 1.6 });
  }
  // downpipes at two diagonal corners
  for (const [sx, sg] of [[1, 1], [-1, -1]]) {
    const px = sx * (w / 2 - 0.3), zw = sg * (hd + 0.09), g0 = gyL(px, sg * hd);
    const yTop = top - 0.45;
    bar(K.paint, [px, yE - 0.12, sg * (ze + 0.07)], [px, yTop, zw], 0.09, gutC);
    cyl(K.paint, px, (yTop + g0 + 0.3) / 2, zw, 0.05, 0.05, yTop - g0 - 0.3, gutC, { seg: 6, caps: false });
    bar(K.paint, [px, g0 + 0.32, zw], [px, g0 + 0.08, sg * (hd + 0.32)], 0.1, gutC);
    for (let yy = g0 + 1.2; yy < yTop; yy += 1.6) box(K.paint, px, yy, sg * (hd + 0.04), 0.13, 0.04, 0.09, mulC(gutC, 0.8));
  }
  // gable walls under the verges, with a louvred attic vent
  for (const sx of [1, -1]) {
    const X = sx * w / 2, o = 0.17;
    const pts = [[hd, top], [-hd, top], [-zb, yB - o], [0, yR - o], [zb, yB - o]].map(([zz, y]) => [X, y, zz]);
    const uvOf = (p) => [p[2] / st.us, p[1] / st.us];
    const fan = sx > 0 ? pts : [pts[1], pts[0], pts[4], pts[3], pts[2]];
    for (let i = 1; i < 4; i++) tri(K.wall, fan[0], fan[i], fan[i + 1], st.wallCol, 0.82, [...uvOf(fan[0]), ...uvOf(fan[i]), ...uvOf(fan[i + 1])]);
    const vy = top + (yR - o - top) * 0.42, vh = Math.min(0.55, (yR - top) * 0.35);
    if (vh > 0.25) {
      const keep = FE ? _F.clone() : null;
      setFrame(keep.clone().multiply(new THREE.Matrix4().makeTranslation(X, 0, 0).multiply(new THREE.Matrix4().makeRotationY(sx * PI / 2))));
      box(K.dark, 0, vy, 0.01, 0.62, vh, 0.02, C(0x2a2826), { skip: 32 });
      for (let k = 0; k < 4; k++) box(K.pwood, 0, vy - vh / 2 + (k + 0.5) * vh / 4, 0.035, 0.56, 0.05, 0.04, st.frame, { rx: -0.5, skip: 32 });
      for (const e of [-1, 1]) box(K.pwood, e * 0.33, vy, 0.03, 0.06, vh + 0.08, 0.06, st.frame, { skip: 32 });
      box(K.pwood, 0, vy + vh / 2 + 0.03, 0.03, 0.72, 0.06, 0.06, st.frame, { skip: 32 });
      setFrame(keep);
    }
  }
  // ridge cap
  const rcap = mulC(rc, 0.8), cz = 0.18, cy = yR - cz * s2 + 0.025;
  quad(K.roof, [X0 - 0.02, cy, cz], [X1 + 0.02, cy, cz], [X1 + 0.02, yR + 0.06, 0], [X0 - 0.02, yR + 0.06, 0], rcap, 1);
  quad(K.roof, [X1 + 0.02, cy, -cz], [X0 - 0.02, cy, -cz], [X0 - 0.02, yR + 0.06, 0], [X1 + 0.02, yR + 0.06, 0], rcap, 0.92);
  // chimneys
  const nCh = rng.chance(0.75) ? 1 + (rng.chance(0.35) ? 1 : 0) : 0;
  for (let k = 0; k < nCh; k++) {
    const lx = (k ? -1 : 1) * rng.range(0.12, 0.38) * w, sgc = rng.chance(0.5) ? 1 : -1, lz = sgc * zb * rng.range(0.25, 0.6);
    const cw = rng.range(0.5, 0.66), cd = 0.48, yLow = yB + (zb - (Math.abs(lz) + cd / 2)) * s2 - 0.06, yTop = yR + rng.range(0.5, 0.9);
    box(st.isStone ? K.stone : K.wall, lx, (yLow + yTop) / 2, lz, cw, yTop - yLow, cd, st.isStone ? C(0xcfc8b8) : st.wallCol, { skip: 8, us: st.us, kb: 0.8 });
    box(K.conc, lx, yTop + 0.04, lz, cw + 0.1, 0.08, cd + 0.1, C(0x8a8a84), { us: 3 });
    box(K.dark, lx, yTop + 0.081, lz, cw - 0.16, 0.002, cd - 0.16, C(0x1a1a1a), { skip: 8 });
    if (rng.chance(0.5)) { box(K.paint, lx, yTop + 0.3, lz, cw + 0.14, 0.03, cd + 0.14, C(0x6a6a66)); for (const e of [-1, 1]) box(K.paint, lx + e * (cw / 2 - 0.03), yTop + 0.19, lz, 0.03, 0.22, 0.03, C(0x5a5a56)); }
  }
  // Soviet-era TV aerial on the ridge
  if (rng.chance(0.45)) tvAerial(K.metal, rng.range(-0.35, 0.35) * w, yR + 0.04, 0, rng);
}
function tvAerial(g, x, y, z, rng) {
  const col = C(0x9a9c9a), hgt = rng.range(1.4, 2.2), yaw = rng() * PI;
  bar(g, [x, y, z], [x, y + hgt, z], 0.035, col);
  const ca = Math.cos(yaw), sa = Math.sin(yaw), bl = 1.3;
  const A = [x - ca * bl * 0.3, y + hgt - 0.05, z + sa * bl * 0.3], B = [x + ca * bl * 0.7, y + hgt - 0.05, z - sa * bl * 0.7];
  bar(g, A, B, 0.022, col);
  for (let k = 0; k < 6; k++) {
    const t = k / 5, px = A[0] + (B[0] - A[0]) * t, pz = A[2] + (B[2] - A[2]) * t, l = 0.55 - t * 0.25;
    bar(g, [px - sa * l / 2, A[1], pz - ca * l / 2], [px + sa * l / 2, A[1], pz + ca * l / 2], 0.012, col);
  }
  bar(g, [x, y + hgt * 0.6, z], [x + 0.6, y, z + 0.4], 0.008, mulC(col, 0.6));
}

/** Flat roof: bitumen membrane, parapet inner faces, coping, spouts, a hatch and an aerial. */
function flatRoof(K, h, st, rng) {
  const { w, d, top } = h, pt = 0.3, ph = 0.55;
  const ix = w / 2 - pt, iz = d / 2 - pt;
  rectY(K.conc, -ix, -iz, ix, iz, top + 0.012, 1, C(0x5e5e5a), 1, 3);
  for (let k = 0; k < 3 + Math.floor(rng() * 3); k++) {
    const pw = rng.range(1, 3.5), pd = rng.range(0.8, 2.5), px = rng.range(-ix + pw / 2, ix - pw / 2), pz = rng.range(-iz + pd / 2, iz - pd / 2);
    rectY(K.conc, px - pw / 2, pz - pd / 2, px + pw / 2, pz + pd / 2, top + 0.018, 1, C(rng.pick([0x4a4a48, 0x6e6c66, 0x525250])), 1, 3);
  }
  // parapet inner faces
  const pc = st.wallCol, us = st.us;
  rectZ(K.wall, -ix, top, ix, top + ph, iz, -1, pc, 0.62, 0.8, us);
  rectZ(K.wall, -ix, top, ix, top + ph, -iz, 1, pc, 0.62, 0.8, us);
  rectX(K.wall, -iz, top, iz, top + ph, ix, -1, pc, 0.62, 0.8, us);
  rectX(K.wall, -iz, top, iz, top + ph, -ix, 1, pc, 0.62, 0.8, us);
  // coping
  const cc = C(0x9a9890), cy = top + ph + 0.03;
  box(K.conc, 0, cy, d / 2 - pt / 2, w + 0.06, 0.06, pt + 0.06, cc, { us: 3 });
  box(K.conc, 0, cy, -d / 2 + pt / 2, w + 0.06, 0.06, pt + 0.06, cc, { us: 3 });
  box(K.conc, w / 2 - pt / 2, cy, 0, pt + 0.06, 0.06, d - pt * 2 - 0.06, cc, { us: 3 });
  box(K.conc, -w / 2 + pt / 2, cy, 0, pt + 0.06, 0.06, d - pt * 2 - 0.06, cc, { us: 3 });
  // spouts through the parapet
  for (const sz of [1, -1]) { const sx = rng.range(-0.35, 0.35) * w; box(K.paint, sx, top + 0.06, sz * (d / 2 + 0.12), 0.12, 0.08, 0.3, C(0x6e726e), { us: 1.6 }); }
  // roof hatch
  const hx = rng.range(-0.3, 0.3) * w, hz = rng.range(-0.3, 0.3) * d;
  box(K.paint, hx, top + 0.03, hz, 0.8, 0.04, 0.8, C(0x5a5e58), { us: 1.6 });
  if (rng.chance(0.5)) { const s = rng.chance(0.5) ? 1 : -1; tvAerial(K.metal, s * (w / 2 - pt / 2), top + ph + 0.06, rng.range(-0.4, 0.4) * d, rng); }
}

// ───────────────────────────── cars ─────────────────────────────
// Local frame: x right, y up from the ground, z forward. Every body fits the kit's car collider
// (1.8 × 1.5 × 4.2 m) so what you see is what stops you and your bullets.
const CAR_TYPES = {
  // boxy Soviet saloon, rectangular headlamps (2105/2107 family)
  saloon: { zF: 2.06, zR: -2.06, hw: 0.81, rw: 0.29, tw: 0.175, axF: 1.24, axR: -1.18, sill: 0.3, crown: 0.03, lights: 'rect', chrome: true,
    top: [[2.06, 0.79], [1.97, 0.845], [0.68, 0.935], [0.6, 0.945], [-1.3, 0.945], [-1.38, 0.955], [-1.98, 0.945], [-2.06, 0.87]],
    cab: { belt: 0.945, roof: 1.42, zAb: 0.64, zAr: 0.16, zCr: -0.92, zCb: -1.34, hwb: 0.78, hwr: 0.65, wins: [[0.025, 0.47], [0.51, 0.975]] } },
  // older saloon with twin round headlamps and more chrome (2101/2106 family)
  saloon2: { zF: 2.0, zR: -2.0, hw: 0.8, rw: 0.29, tw: 0.17, axF: 1.2, axR: -1.2, sill: 0.3, crown: 0.035, lights: 'twin', chrome: true,
    top: [[2.0, 0.8], [1.92, 0.85], [0.66, 0.93], [0.58, 0.94], [-1.28, 0.94], [-1.36, 0.95], [-1.93, 0.935], [-2.0, 0.86]],
    cab: { belt: 0.94, roof: 1.41, zAb: 0.62, zAr: 0.12, zCr: -0.9, zCb: -1.3, hwb: 0.77, hwr: 0.64, wins: [[0.025, 0.47], [0.51, 0.975]] } },
  // estate: the saloon front with a long roof and a near-vertical tailgate
  estate: { zF: 2.06, zR: -2.06, hw: 0.81, rw: 0.29, tw: 0.175, axF: 1.24, axR: -1.18, sill: 0.3, crown: 0.03, lights: 'rect', chrome: true,
    top: [[2.06, 0.79], [1.97, 0.845], [0.68, 0.935], [0.6, 0.945], [-1.98, 0.95], [-2.06, 0.9]],
    cab: { belt: 0.945, roof: 1.43, zAb: 0.64, zAr: 0.16, zCr: -1.86, zCb: -2.0, hwb: 0.78, hwr: 0.68, wins: [[0.02, 0.33], [0.36, 0.64], [0.67, 0.97]] } },
  // short three-door 4×4 with round lamps, big wheels and black arch flares (Niva-type)
  niva: { zF: 1.87, zR: -1.87, hw: 0.84, rw: 0.33, tw: 0.19, axF: 1.1, axR: -1.1, sill: 0.42, crown: 0.02, lights: 'round', flares: true,
    top: [[1.87, 0.9], [1.8, 0.965], [0.62, 0.99], [0.55, 1.0], [-1.8, 1.0], [-1.87, 0.95]],
    cab: { belt: 1.0, roof: 1.5, zAb: 0.6, zAr: 0.1, zCr: -1.66, zCb: -1.84, hwb: 0.81, hwr: 0.71, wins: [[0.02, 0.5], [0.56, 0.97]] } },
  // open military 4×4 (UAZ-type), top off, windscreen up, canvas over the load
  uaz: { zF: 1.97, zR: -1.86, hw: 0.89, rw: 0.37, tw: 0.22, axF: 1.16, axR: -1.22, sill: 0.52, crown: 0.0, lights: 'uaz', open: true,
    top: [[1.97, 0.84], [1.93, 0.9], [0.84, 0.9], [0.8, 1.12], [-1.86, 1.12]], dip: [0.72, -1.0, 0.64] },
};
const CAR_KEYS = ['saloon', 'saloon2', 'estate', 'niva', 'uaz'];
const lerpKeys = (keys, z) => {
  if (z >= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) { const [z0, y0] = keys[i], [z1, y1] = keys[i + 1]; if (z <= z0 && z >= z1) return y0 + (y1 - y0) * (z0 - z) / (z0 - z1); }
  return keys[keys.length - 1][1];
};

/** Visuals for Level.car(): a wreck of one of four Soviet-era body types, chosen by position. */
export function buildCar(L, x, z, rot, color) { return timed(L, () => carImpl(L, x, z, rot, color)); }

function carImpl(L, x, z, rot, color) {
  const K = kit(L), rng = makeRng(seedOf(x, z, 7));
  const type = structureDebug.carType || CAR_KEYS[Math.floor(hash2(Math.floor(x * 13.7 + 500), Math.floor(z * 7.3 + 500)) * CAR_KEYS.length)];
  const T = CAR_TYPES[type];
  const c = Math.cos(rot), s = Math.sin(rot);
  const W = (lx, lz) => L.gy(x + lx * c + lz * s, z - lx * s + lz * c);
  const flat = rng.chance(0.4) ? rng.int(0, 3) : -1;            // 0 FR, 1 FL, 2 RR, 3 RL
  const track = T.hw - T.tw / 2 - 0.02, wb = T.axF - T.axR;
  let pitch = -Math.atan2(W(0, T.axF) - W(0, T.axR), wb), roll = Math.atan2(W(track, 0) - W(-track, 0), track * 2);
  if (flat >= 0) { pitch += (flat < 2 ? 1 : -1) * 0.028; roll += (flat % 2 === 0 ? -1 : 1) * 0.03; }
  const M = mat4At(x, L.gy(x, z) - (flat >= 0 ? 0.03 : 0), z, rot, pitch, roll);
  setFrame(M);
  const paint = mulC(C(color ?? 0x4f5650), 1.25), rust = rng() * 0.9, dark = C(0x141414);
  const P = { ...T, paint, rust, rng, dents: [] };
  for (let k = 0; k < (rng.chance(0.6) ? rng.int(1, 2) : 0); k++) P.dents.push({ side: rng.chance(0.5) ? 1 : -1, z: rng.range(T.zR + 0.4, T.zF - 0.4), y: rng.range(0.5, 0.85), d: rng.range(0.02, 0.05) });
  // contact shadow on the ground
  const gs = C(0x0c0c0c);
  quad(K.dark, [-T.hw + 0.1, 0.025, T.zF - 0.25], [T.hw - 0.1, 0.025, T.zF - 0.25], [T.hw - 0.1, 0.025, T.zR + 0.25], [-T.hw + 0.1, 0.025, T.zR + 0.25], gs, 0.5);
  carBody(K, P);
  if (type === 'uaz') uazParts(K, P, rng); else carCabin(K, P, rng, type);
  carFront(K, P, type, rng);
  carRear(K, P, type, rng);
  for (let k = 0; k < 4; k++) {
    const front = k < 2, sx = k % 2 === 0 ? 1 : -1;
    wheel(K, sx * track, T.rw - (flat === k ? 0.06 : 0), front ? T.axF : T.axR, T, sx, flat === k, type, rng, paint);
  }
  FE = null;
}

/** Ring of the lower body at station z (left bottom → over the top → right bottom). */
function carRing(P, z) {
  const yt = lerpKeys(P.top, z), endD = Math.min(P.zF - z, z - P.zR);
  let yb = P.sill + 0.05 * (1 - smoothstep(0, 0.35, endD));
  for (const zc of [P.axF, P.axR]) { const ra = P.rw + 0.075, dz = z - zc; if (Math.abs(dz) < ra) yb = Math.max(yb, P.rw + 0.03 + Math.sqrt(ra * ra - dz * dz)); }
  const hw = P.hw * (1 - 0.045 * (1 - smoothstep(0, 0.3, endD))), cr = P.crown;
  let R;
  const dip = P.dip && z <= P.dip[0] && z >= P.dip[1];
  if (dip) R = [[hw - 0.05, yb], [hw, yb + 0.06], [hw + 0.006, yb + (yt - yb) * 0.45], [hw, yt - 0.04], [hw - 0.025, yt], [hw - 0.05, yt - 0.015], [hw - 0.055, P.dip[2]], [0, P.dip[2]]];
  else R = [[hw - 0.05, yb], [hw, yb + 0.06], [hw + 0.012, yb + (yt - yb) * 0.45], [hw, yt - 0.06], [hw - 0.045, yt - 0.008], [hw * 0.75, yt + cr * 0.45], [hw * 0.4, yt + cr * 0.85], [0, yt + cr]];
  // dents push the side panels in
  const dent = (side, p) => { if (p[0] < hw - 0.06) return 0; let v = 0; for (const d of P.dents) if (d.side === side) v += d.d * Math.exp(-((z - d.z) ** 2) / 0.06 - ((p[1] - d.y) ** 2) / 0.02); return v; };
  const ring = [];
  for (let i = 0; i < R.length; i++) ring.push([-R[i][0] + dent(-1, R[i]), R[i][1]]);
  for (let i = R.length - 2; i >= 0; i--) ring.push([R[i][0] - dent(1, R[i]), R[i][1]]);
  return { ring, yb, yt, hw };
}

function carBody(K, P) {
  const zs = [];
  for (let zz = P.zF; zz > P.zR; zz -= 0.17) zs.push(zz);
  for (const zc of [P.axF, P.axR]) for (let k = 0; k <= 12; k++) zs.push(zc + (P.rw + 0.075) * Math.cos(k / 12 * PI) * 0.999);
  for (const [kz] of P.top) zs.push(kz);
  if (P.dip) zs.push(P.dip[0], P.dip[0] - 0.02, P.dip[1], P.dip[1] + 0.02);
  zs.push(P.zF - 0.03, P.zR + 0.03, P.zR);
  zs.sort((a, b) => b - a);
  const st = [];
  for (const zz of zs) if (zz <= P.zF + 1e-6 && zz >= P.zR - 1e-6 && (!st.length || st[st.length - 1] - zz > 0.012)) st.push(zz);
  const rings = st.map((zz) => carRing(P, zz));
  const n = rings[0].ring.length, rng = P.rng, rc = C(0x5a3420), mid = (n - 1) / 2;
  const nearArch = (zz) => Math.min(Math.abs(zz - P.axF), Math.abs(zz - P.axR)) < P.rw + 0.2;
  grid(K.paint, n - 1, st.length - 1, (i, j) => [rings[j].ring[i][0], rings[j].ring[i][1], st[j]], P.paint, {
    colAt: (i, j, p) => {
      const lo = Math.min(i, n - 1 - i);   // 0 = bottom edge
      const inner = P.dip && Math.abs(i - mid) < 2 && p[1] < rings[j].yt - 0.02;
      let col = inner ? mulC(P.paint, 0.55) : P.paint, k = lo === 0 ? 0.55 : lo === 1 ? 0.78 : 1;
      if ((lo <= 1 || (nearArch(p[2]) && p[1] < rings[j].yb + 0.12)) && P.rust > 0.3 && hash2(Math.floor(p[2] * 9) + i, j) < P.rust) col = mixC(col, rc, 0.4 + hash2(j, i) * 0.4);
      return [col, k];
    },
    uv: (i, j, p) => [p[2] / 1.2 + (p[0] < 0 ? 0.5 : 0), clamp01((p[1] - 0.15) / 1.6)],
  });
  // underside, dark
  for (let j = 0; j < st.length - 1; j++) {
    const a = rings[j].ring, b = rings[j + 1].ring;
    quad(K.rubber, [a[n - 1][0], a[n - 1][1], st[j]], [a[0][0], a[0][1], st[j]], [b[0][0], b[0][1], st[j + 1]], [b[n - 1][0], b[n - 1][1], st[j + 1]], C(0x1a1a1a), 1, [0.75, 0, 0.8, 0, 0.8, 0.1, 0.75, 0.1]);
  }
  // end caps: front (+z) and rear (−z), fans from the centre
  for (const [j, sg] of [[0, 1], [st.length - 1, -1]]) {
    const r = rings[j].ring, zz = st[j], cy = (rings[j].yb + rings[j].yt) / 2;
    for (let i = 0; i < n; i++) {
      const p = r[i], q = r[(i + 1) % n];
      const A = [p[0], p[1], zz], B = [q[0], q[1], zz], Cc = [0, cy, zz];
      if (sg > 0) tri(K.paint, Cc, B, A, P.paint, 0.9, [0, cy / 1.6, q[0] / 1.2, q[1] / 1.6, p[0] / 1.2, p[1] / 1.6]); else tri(K.paint, Cc, A, B, P.paint, 0.8, [0, cy / 1.6, p[0] / 1.2, p[1] / 1.6, q[0] / 1.2, q[1] / 1.6]);
    }
  }
  P.rings = rings; P.st = st;
  // side trim: rubber moulding, door shut lines, handles; black arch flares on the 4×4
  const trim = C(0x1c1c1c);
  for (const sx of [-1, 1]) {
    const zA = P.axF - P.rw - 0.12, zB = P.axR + P.rw + 0.12;
    if (!P.open) {
      const ym = lerp(P.sill, lerpKeys(P.top, 0), 0.5);
      box(K.rubber, sx * (P.hw + 0.016), ym, (zA + zB) / 2, 0.02, 0.035, zA - zB, trim, { skip: sx > 0 ? 2 : 1 });
      const cab = P.cab;
      if (cab) {
        const zDoor = [cab.zAb + 0.02, lerp(cab.zAb, cab.zCb, (cab.wins[0][1] + cab.wins[1][0]) / 2)];
        if (cab.wins.length > 2 || P.flares) zDoor.push(lerp(cab.zAb, cab.zCb, (cab.wins[1][1] + (cab.wins[2] ? cab.wins[2][0] : 1)) / 2));
        else zDoor.push(P.axR + P.rw + 0.1);
        for (const zd of zDoor) box(K.rubber, sx * (P.hw + 0.014), (P.sill + 0.08 + cab.belt) / 2, zd, 0.006, cab.belt - P.sill - 0.1, 0.007, trim, { skip: sx > 0 ? 2 : 1 });
        for (const zd of zDoor.slice(1)) box(K.metal, sx * (P.hw + 0.02), cab.belt - 0.09, zd + 0.12, 0.025, 0.03, 0.13, C(0x9a9a96), { skip: sx > 0 ? 2 : 1 });
      }
    }
    if (P.flares) for (const zc of [P.axF, P.axR]) {
      const ra = P.rw + 0.075;
      lathe(K.rubber, sx * (P.hw + 0.005), P.rw + 0.03, zc, [[ra, -0.03], [ra + 0.055, -0.03], [ra + 0.055, 0.03]], C(0x202020), { axis: 'x', seg: 10, a0: 0, a1: PI, uv: () => [0.75, 0.2] });
    }
  }
}

/** Glasshouse: pillars, glass, roof, drip rails, mirrors, wipers and a simple interior. */
function carCabin(K, P, rng, type) {
  const cb = P.cab, b = cb.belt, r = cb.roof, paint = P.paint, seal = C(0x161616);
  const Bz = (s) => lerp(cb.zAb, cb.zCb, s), Tz = (s) => lerp(cb.zAr, cb.zCr, s);
  const pt = (sg, s, t, inset = 0) => [sg * (lerp(cb.hwb, cb.hwr, t) - inset), lerp(b, r, t), lerp(Bz(s), Tz(s), t)];
  const patch = (g, sg, s0, s1, t0, t1, col, k = 1, inset = 0) => {
    const a = pt(sg, s0, t0, inset), bb = pt(sg, s1, t0, inset), c = pt(sg, s1, t1, inset), d = pt(sg, s0, t1, inset);
    const uv = [a[2] / 1.2, a[1] / 1.6, bb[2] / 1.2, bb[1] / 1.6, c[2] / 1.2, c[1] / 1.6, d[2] / 1.2, d[1] / 1.6];
    if (sg > 0) quad(g, a, bb, c, d, col, k, uv); else quad(g, bb, a, d, c, col, k, [uv[2], uv[3], uv[0], uv[1], uv[6], uv[7], uv[4], uv[5]]);
  };
  const broken = rng.chance(0.45) ? { sg: rng.chance(0.5) ? 1 : -1, w: rng.int(0, cb.wins.length - 1) } : null;
  const t0 = 0.07, t1 = 0.93;
  for (const sg of [-1, 1]) {
    patch(K.paint, sg, 0, 1, 0, t0, paint, 0.95);
    patch(K.paint, sg, 0, 1, t1, 1, paint, 1.02);
    let s = 0;
    cb.wins.forEach(([w0, w1], wi) => {
      if (w0 > s) patch(K.paint, sg, s, w0, t0, t1, paint, 0.97);
      const m = 0.012, mt = 0.03;
      patch(K.rubber, sg, w0, w1, t0, t0 + mt, seal, 1, 0.004); patch(K.rubber, sg, w0, w1, t1 - mt, t1, seal, 1, 0.004);
      patch(K.rubber, sg, w0, w0 + m, t0 + mt, t1 - mt, seal, 1, 0.004); patch(K.rubber, sg, w1 - m, w1, t0 + mt, t1 - mt, seal, 1, 0.004);
      if (broken && broken.sg === sg && broken.w === wi) {
        for (let k = 0; k < 3; k++) { const ss = lerp(w0 + m, w1 - m, rng()), a = pt(sg, ss - 0.04, t0 + mt, 0.01), bb = pt(sg, ss + 0.05, t0 + mt, 0.01), cc = pt(sg, ss, t0 + mt + 0.12 + rng() * 0.2, 0.01); tri(K.cglass, a, bb, cc, GLASS_T); tri(K.cglass, bb, a, cc, GLASS_T); }
      } else patch(K.cglass, sg, w0 + m, w1 - m, t0 + mt, t1 - mt, C(0x2a3438), 1, 0.008);
      s = w1;
    });
    if (s < 1) patch(K.paint, sg, s, 1, t0, t1, paint, 0.97);
  }
  // windscreen and rear window, curved slightly
  const screen = (sEnd, front) => {
    const BL = pt(-1, sEnd, 0), BR = pt(1, sEnd, 0), TL = pt(-1, sEnd, 1), TR = pt(1, sEnd, 1);
    const Wp = (a, t, inset = 0) => {
      const lo = [lerp(BL[0], BR[0], a), BL[1], lerp(BL[2], BR[2], a)], hi = [lerp(TL[0], TR[0], a), TL[1], lerp(TL[2], TR[2], a)];
      const p = [lerp(lo[0], hi[0], t), lerp(lo[1], hi[1], t), lerp(lo[2], hi[2], t)];
      p[2] += (front ? 1 : -1) * (0.035 * Math.sin(PI * a) - inset);
      return p;
    };
    const rect = (g, a0, a1, tt0, tt1, col, inset = 0) => {
      const A = Wp(a0, tt0, inset), B = Wp(a1, tt0, inset), Cc = Wp(a1, tt1, inset), D = Wp(a0, tt1, inset);
      if (front) quad(g, A, B, Cc, D, col); else quad(g, B, A, D, Cc, col);
    };
    const ap = 0.05, n = 4;
    rect(K.paint, 0, ap, 0, 1, paint); rect(K.paint, 1 - ap, 1, 0, 1, paint); rect(K.paint, ap, 1 - ap, 0, 0.06, paint, 0); rect(K.paint, ap, 1 - ap, 0.93, 1, paint);
    for (let k = 0; k < n; k++) rect(K.cglass, ap + (1 - 2 * ap) * k / n, ap + (1 - 2 * ap) * (k + 1) / n, 0.06, 0.93, C(0x2a3438), 0.004);
    if (front) for (const a of [0.3, 0.68]) bar(K.rubber, Wp(a, 0.08, -0.012), Wp(a - 0.2, 0.4, -0.012), 0.014, seal);
  };
  screen(0, true); screen(1, false);
  // roof with a gentle crown, drip rails along its edges
  const roofP = (i, j) => { const fx = i / 6 * 2 - 1, fz = j / 6; return [fx * cb.hwr, r + 0.035 * (1 - fx * fx) * Math.sin(PI * (0.1 + fz * 0.8)), lerp(cb.zAr, cb.zCr, fz)]; };
  grid(K.paint, 6, 6, roofP, paint, { uv: (i, j, p) => [p[2] / 1.2, 0.95] });
  for (const sg of [-1, 1]) bar(K.paint, [sg * (cb.hwr + 0.008), r - 0.005, cb.zAr - 0.02], [sg * (cb.hwr + 0.008), r - 0.005, cb.zCr + 0.02], 0.022, mulC(paint, 0.9));
  // mirrors
  for (const sg of [-1, 1]) {
    const base = pt(sg, 0.03, 0.08);
    bar(K.rubber, base, [base[0] + sg * 0.1, base[1] + 0.06, base[2] - 0.02], 0.025, seal);
    box(K.rubber, base[0] + sg * 0.14, base[1] + 0.07, base[2] - 0.03, 0.13, 0.09, 0.05, C(0x202020), { ry: sg * 0.15 });
  }
  // interior: seats with headrests, dashboard, steering wheel
  const tr = C(rng.pick([0x3a3430, 0x2e3236, 0x4a3a2e])), dashZ = cb.zAb - 0.18, front = lerp(cb.zAb, cb.zCb, 0.4);
  box(K.rubber, 0, b - 0.06, dashZ, cb.hwb * 2 - 0.08, 0.16, 0.36, C(0x1e1e1e), { skip: 8 });
  for (const sx of [-1, 1]) {
    box(K.rubber, sx * 0.36, 0.52, front, 0.48, 0.14, 0.5, tr);
    box(K.rubber, sx * 0.36, 0.88, front - 0.3, 0.48, 0.66, 0.12, tr, { rx: -0.18 });
    if (type !== 'saloon2') box(K.rubber, sx * 0.36, 1.27, front - 0.38, 0.26, 0.16, 0.1, tr, { rx: -0.18 });
  }
  const rearZ = lerp(cb.zAb, cb.zCb, type === 'niva' ? 0.85 : 0.78);
  box(K.rubber, 0, 0.5, rearZ, cb.hwb * 2 - 0.2, 0.14, 0.45, tr);
  box(K.rubber, 0, 0.84, rearZ - 0.28, cb.hwb * 2 - 0.2, 0.6, 0.12, tr, { rx: -0.2 });
  const keep = _F.clone();
  setFrame(keep.clone().multiply(new THREE.Matrix4().makeTranslation(-0.36, 0.98, dashZ - 0.28).multiply(new THREE.Matrix4().makeRotationX(-0.45))));
  lathe(K.rubber, 0, 0, 0, [[0.17, -0.016], [0.188, 0], [0.17, 0.016], [0.155, 0], [0.17, -0.016]], C(0x161616), { axis: 'z', seg: 14, uv: () => [0.75, 0.3] });
  bar(K.rubber, [-0.16, 0, 0], [0.16, 0, 0], 0.025, C(0x161616));
  setFrame(keep);
}

function lampLens(g, x, y, z, w, h, col, rng, dir = 1) {
  const i = g.count, nx = (rng() - 0.5) * 0.1, ny = (rng() - 0.5) * 0.1 + 0.05;
  for (const [px, py, k] of [[x - w / 2, y - h / 2, 0.8], [x + w / 2, y - h / 2, 0.8], [x + w / 2, y + h / 2, 1.1], [x - w / 2, y + h / 2, 1.1]]) V(g, px, py, z, nx, ny, dir, col, k, px, py);
  if (dir > 0) g.i.push(i, i + 1, i + 2, i, i + 2, i + 3); else g.i.push(i, i + 2, i + 1, i, i + 3, i + 2);
}
function roundLamp(K, x, y, z, r, dir, rng, lens = C(0x9aa0a0)) {
  lathe(K.metal, x, y, z, [[r + 0.022, -0.02 * dir], [r + 0.022, 0.012 * dir], [r, 0.016 * dir]], C(0xb8bab6), { axis: 'z', seg: 12, uv: () => [0.5, 0.5] });
  lathe(K.glass, x, y, z, [[r, 0.012 * dir], [r * 0.6, 0.022 * dir], [0.001, 0.026 * dir]], lens, { axis: 'z', seg: 12, uv: () => [0.5, 0.5] });
  void rng;
}

function carFront(K, P, type, rng) {
  const zF = P.zF, chrome = C(0xc8cac6), black = C(0x161616), lens = C(0xa8aeae), amber = C(0xc8782a);
  const yt = lerpKeys(P.top, zF), z = zF + 0.004;
  if (type === 'uaz') {
    for (let k = 0; k < 7; k++) box(K.rubber, -0.27 + k * 0.09, 0.8, z, 0.045, 0.3, 0.01, black, { skip: 32 });
    for (const sx of [-1, 1]) { roundLamp(K, sx * 0.47, 0.75, z, 0.09, 1, rng, lens); lampLens(K.glass, sx * 0.66, 0.62, z + 0.012, 0.08, 0.05, amber, rng); }
    box(K.paint, 0, 0.5, zF + 0.06, P.hw * 2 + 0.06, 0.13, 0.11, mulC(P.paint, 0.7), { us: 1.2 });
    for (const sx of [-0.55, 0.55]) box(K.metal, sx, 0.42, zF + 0.14, 0.05, 0.1, 0.1, C(0x4a4a48));
    return;
  }
  const ly = yt - 0.13;
  if (type === 'saloon' || type === 'estate') {
    for (const sx of [-1, 1]) {
      box(K.metal, sx * 0.53, ly, z + 0.01, 0.36, 0.17, 0.03, chrome, { skip: 32 });
      lampLens(K.glass, sx * 0.53, ly, z + 0.027, 0.33, 0.14, lens, rng);
      lampLens(K.glass, sx * 0.53, ly - 0.15, z + 0.006, 0.26, 0.05, amber, rng);
    }
    box(K.metal, 0, ly, z + 0.008, 0.66, 0.17, 0.02, chrome, { skip: 32 });
    box(K.rubber, 0, ly, z + 0.02, 0.6, 0.13, 0.01, black, { skip: 32 });
    for (let k = -4; k <= 4; k++) box(K.metal, k * 0.065, ly, z + 0.028, 0.012, 0.13, 0.012, chrome, { skip: 32 });
  } else if (type === 'saloon2') {
    for (const sx of [-1, 1]) for (const ox of [0.42, 0.62]) roundLamp(K, sx * ox, ly, z, 0.072, 1, rng, lens);
    box(K.rubber, 0, ly, z + 0.006, 0.6, 0.12, 0.01, black, { skip: 32 });
    for (let k = -3; k <= 3; k++) box(K.metal, 0, ly - 0.045 + (k + 3) * 0.015, z + 0.014, 0.6, 0.006, 0.01, chrome, { skip: 32 });
    for (const sx of [-1, 1]) lampLens(K.glass, sx * 0.52, ly - 0.15, z + 0.006, 0.18, 0.05, amber, rng);
  } else {
    for (const sx of [-1, 1]) { roundLamp(K, sx * 0.58, ly, z, 0.085, 1, rng, lens); lampLens(K.glass, sx * 0.58, ly - 0.15, z + 0.006, 0.16, 0.05, amber, rng); }
    box(K.rubber, 0, ly, z + 0.006, 0.82, 0.16, 0.012, black, { skip: 32 });
    for (let k = 0; k < 4; k++) box(K.metal, 0, ly - 0.055 + k * 0.037, z + 0.016, 0.8, 0.012, 0.01, C(0x9a9c98), { skip: 32 });
  }
  bumper(K, P, zF, 1, rng);
}
function carRear(K, P, type, rng) {
  const zR = P.zR, z = zR - 0.004, red = C(0x8a1410), amber = C(0xc8782a), white = C(0xd8d8d0);
  if (type === 'uaz') {
    // spare wheel on the tail
    const keep = _F.clone();
    setFrame(keep.clone().multiply(new THREE.Matrix4().makeTranslation(0.32, 0.86, zR - 0.13).multiply(new THREE.Matrix4().makeRotationY(PI / 2))));
    wheelLocal(K, P, false, 'uaz', rng, P.paint, 1);
    setFrame(keep);
    for (const sx of [-1, 1]) lampLens(K.glass, sx * 0.72, 0.78, z - 0.006, 0.09, 0.14, red, rng, -1);
    box(K.paint, 0, 0.52, zR - 0.05, P.hw * 2 + 0.04, 0.12, 0.1, mulC(P.paint, 0.7), { us: 1.2 });
    return;
  }
  const yt = lerpKeys(P.top, zR), ly = yt - 0.14;
  for (const sx of [-1, 1]) {
    box(K.metal, sx * 0.55, ly, z - 0.008, 0.38, 0.17, 0.016, C(0x9a9c98), { skip: 16 });
    lampLens(K.glass, sx * 0.62, ly, z - 0.018, 0.2, 0.13, red, rng, -1);
    lampLens(K.glass, sx * 0.46, ly + 0.035, z - 0.018, 0.09, 0.06, amber, rng, -1);
    lampLens(K.glass, sx * 0.46, ly - 0.035, z - 0.018, 0.09, 0.06, white, rng, -1);
  }
  bumper(K, P, zR, -1, rng);
  cyl(K.metal, -0.45, 0.24, zR + 0.05, 0.025, 0.025, 0.3, C(0x5a5650), { axis: 'z', seg: 6 });
}
function bumper(K, P, zEnd, dir, rng) {
  const chrome = P.chrome, col = chrome ? C(0xc8cac6) : C(0x1e1e1e), g = chrome ? K.metal : K.rubber;
  const y = P.sill + 0.12, w = P.hw * 2 + 0.03, zc = zEnd + dir * 0.045;
  const sag = rng.chance(0.2) ? (rng() - 0.5) * 0.12 : 0;
  box(g, 0, y, zc, w - 0.16, 0.11, 0.07, col, { rz: sag * 0.3 });
  for (const sx of [-1, 1]) box(g, sx * (w / 2 - 0.1), y - sx * sag * 0.05, zEnd + dir * 0.0, 0.07, 0.11, 0.2, col, { ry: sx * dir * 0.5 });
  if (chrome) box(K.rubber, 0, y, zc + dir * 0.038, w - 0.3, 0.035, 0.012, C(0x161616));
}
/** One wheel at (x, y, z) in the car frame; sx = +1 right side (outer face looks +x). */
function wheel(K, x, y, z, T, sx, flat, type, rng, paint) {
  const keep = _F.clone();
  const m = new THREE.Matrix4().makeTranslation(x, y, z);
  if (sx < 0) m.multiply(new THREE.Matrix4().makeRotationY(PI));
  setFrame(keep.clone().multiply(m));
  wheelLocal(K, T, flat, type, rng, paint, 0);
  setFrame(keep);
}
/** Wheel in its own frame: axle along x, outer face at +x, centre at the origin. */
function wheelLocal(K, T, flat, type, rng, paint, spare) {
  const rw = T.rw, tw = T.tw, rr = rw * 0.6, rubber = C(0x1a1a1a);
  const fl = rw - 0.075;
  const prof = [[rr, -tw / 2 + 0.01], [rw - 0.04, -tw / 2 - 0.006], [rw - 0.01, -tw / 2 + 0.016], [rw, -tw / 2 + 0.04], [rw, tw / 2 - 0.04], [rw - 0.01, tw / 2 - 0.016], [rw - 0.04, tw / 2 + 0.006], [rr, tw / 2 - 0.01]];
  lathe(K.rubber, 0, 0, 0, prof, rubber, {
    axis: 'x', seg: 18, uv: (i, s) => (i === 3 || i === 4) ? [i === 3 ? 0.03 : 0.47, s / 18 * 3] : [0.75, s / 18],
    dr: flat ? (i, s, a) => { const r = prof[i][0], sy = Math.sin(a) * r; return sy < -fl ? (-fl / Math.sin(a)) - r + (i === 3 || i === 4 ? 0 : 0) : 0; } : null,
  });
  if (flat) { box(K.rubber, 0, -fl - 0.01, 0, tw + 0.05, 0.03, 0.34, rubber); }
  // steel wheel: dished disc, rim lip, hub
  const steel = type === 'uaz' ? mulC(paint, 0.8) : rng.chance(0.5) ? C(0x2a2c2c) : C(0x7a7c78), o = tw / 2 - 0.035;
  lathe(K.paint, 0, 0, 0, [[rr + 0.01, o + 0.004], [rr - 0.005, o - 0.012], [rr * 0.82, o - 0.03], [rr * 0.55, o - 0.01], [rr * 0.3, o + 0.002], [0.001, o + 0.004]], steel, { axis: 'x', seg: 14, uv: () => [0.5, 0.4] });
  lathe(K.rubber, 0, 0, 0, [[rr, -tw / 2 + 0.02], [0.001, -tw / 2 + 0.02]], C(0x0e0e0e), { axis: 'x', seg: 10, uv: () => [0.75, 0.5] });
  if (type === 'saloon' || type === 'saloon2' || type === 'estate') {
    if (!rng.chance(0.3)) lathe(K.metal, 0, 0, 0, [[rr * 0.62, o], [rr * 0.5, o + 0.025], [rr * 0.2, o + 0.035], [0.001, o + 0.037]], C(0xb8bab6), { axis: 'x', seg: 14, uv: () => [0.5, 0.5] });
  } else {
    const nN = type === 'uaz' ? 5 : 5;
    for (let k = 0; k < nN; k++) { const a = k / nN * TAU; box(K.metal, o + 0.012, Math.sin(a) * rr * 0.32, Math.cos(a) * rr * 0.32, 0.025, 0.03, 0.03, C(0x6a6a66)); }
    lathe(K.metal, 0, 0, 0, [[0.06, o + 0.005], [0.045, o + 0.03], [0.001, o + 0.032]], C(0x5a5a56), { axis: 'x', seg: 8, uv: () => [0.5, 0.5] });
  }
  void spare;
}

/** The open UAZ-type body: bonnet, windscreen, seats in the open tub, canvas over the load. */
function uazParts(K, P, rng) {
  const paint = P.paint, black = C(0x161616);
  // bonnet between the wings
  const bonnet = { open: true, zF: 1.95, zR: 0.8, hw: 0.6, rw: 9, sill: 0.84, crown: 0.02, axF: 99, axR: -99, top: [[1.95, 0.99], [1.88, 1.045], [0.8, 1.055]], paint, rust: P.rust, rng, dents: [] };
  carBody(K, bonnet);
  // windscreen frame raked back a little
  const zW = 0.8, yb = 1.06, yt = 1.48, hw = 0.8, rake = 0.1;
  const fr = mulC(paint, 0.9);
  for (const sx of [-1, 1]) bar(K.paint, [sx * hw, yb, zW], [sx * hw, yt, zW - rake], 0.045, fr);
  bar(K.paint, [-hw, yt, zW - rake], [hw, yt, zW - rake], 0.045, fr);
  bar(K.paint, [-hw, yb + 0.02, zW], [hw, yb + 0.02, zW], 0.05, fr);
  for (const [x0, x1] of [[-hw + 0.03, -0.02], [0.02, hw - 0.03]]) quad(K.cglass, [x0, yb + 0.05, zW - 0.01], [x1, yb + 0.05, zW - 0.01], [x1, yt - 0.03, zW - rake - 0.01], [x0, yt - 0.03, zW - rake - 0.01], C(0x2a3438));
  bar(K.paint, [0, yb, zW], [0, yt, zW - rake], 0.035, fr);
  // dashboard, seats, steering wheel, gear levers
  box(K.paint, 0, 1.0, 0.68, 1.64, 0.2, 0.16, mulC(paint, 0.7));
  const seat = C(0x2e2a24);
  for (const sx of [-1, 1]) {
    box(K.rubber, sx * 0.4, 0.78, 0.1, 0.5, 0.12, 0.5, seat);
    box(K.rubber, sx * 0.4, 1.06, -0.18, 0.5, 0.56, 0.1, seat, { rx: -0.15 });
  }
  box(K.rubber, 0, 0.78, -0.62, 1.5, 0.12, 0.45, seat);
  box(K.rubber, 0, 1.04, -0.86, 1.5, 0.5, 0.1, seat, { rx: -0.1 });
  const keep = _F.clone();
  setFrame(keep.clone().multiply(new THREE.Matrix4().makeTranslation(-0.4, 1.12, 0.42).multiply(new THREE.Matrix4().makeRotationX(-0.6))));
  lathe(K.rubber, 0, 0, 0, [[0.19, -0.018], [0.21, 0], [0.19, 0.018], [0.172, 0], [0.19, -0.018]], black, { axis: 'z', seg: 14, uv: () => [0.75, 0.3] });
  bar(K.rubber, [-0.18, 0, 0], [0.18, 0, 0], 0.025, black);
  setFrame(keep);
  bar(K.rubber, [0, 0.66, 0.45], [0.04, 1.0, 0.36], 0.025, black);
  // canvas over the load behind the seats, lashed down
  const cl = C(rng.pick([0x5e5a44, 0x6a6448, 0x54523e]));
  grid(K.cloth, 8, 6, (i, j) => {
    const fx = i / 8 * 2 - 1, fz = j / 6;
    const bump = 0.08 * Math.sin(fx * 5 + fz * 4) * Math.sin(PI * fz) + 0.05 * Math.cos(fx * 9);
    const yy = 1.12 + (0.26 + bump) * Math.pow(1 - fx * fx, 0.35) * Math.pow(Math.sin(PI * Math.min(1, fz * 1.1 + 0.05)), 0.4);
    return [fx * (P.hw - 0.04), yy, lerp(-0.98, P.zR + 0.04, fz)];
  }, cl, { uv: (i, j, p) => [p[0] / 1.2, p[2] / 1.2] });
  for (const zz of [-1.25, -1.6]) bar(K.rubber, [-P.hw + 0.03, 1.12, zz], [P.hw - 0.03, 1.12, zz].map((v, i) => v), 0.02, C(0x3a3428));
  // folded hood bows behind the rear seat
  for (const zz of [-0.95, -0.92]) bar(K.paint, [-P.hw + 0.05, 1.14, zz], [P.hw - 0.05, 1.14, zz], 0.035, fr);
}

// ───────────────────────────── enterable buildings ─────────────────────────────
/**
 * Visuals for Level.building(): b = { x, z, w, d, rot, H, t, y0, tex, tint, gaps: { n|s|e|w: [{ c, w }] } }.
 * Walls t thick from y0−0.4 to y0+H with door gaps up to y0+2.2, a 0.25 m walkable slab on top.
 */
export function buildBuilding(L, b) { return timed(L, () => buildingImpl(L, b)); }

function buildingImpl(L, b) {
  const { x, z, w, d, rot, H, t, y0 } = b;
  const K = kit(L, b.tex), rng = makeRng(seedOf(x, z, 3));
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
  const gyL = (lx, lz) => { const p = P(lx, lz); return L.gy(p[0], p[1]); };
  const isStone = b.tex === 'stone', us = TEX_SCALE[b.tex] || 2.6;
  const wallCol = C(b.tint ?? 0xffffff), trim = C(isStone ? 0xe8e2d4 : 0xe4ddcf), plinthCol = C(0xa29c90);
  const yTop = y0 + H, pTop = y0 + 0.45;
  const lowCol = C(rng.pick([0x7f9888, 0x8696a4, 0x9a8a72])), highCol = C(0xd8d2c4), wood = C(0x6a5440), frameC = C(rng.pick(FRAME_COLS));
  const SIDES = [
    { key: 's', len: w, ox: 0, oz: d / 2, th: 0 }, { key: 'e', len: d, ox: w / 2, oz: 0, th: PI / 2 },
    { key: 'n', len: w, ox: 0, oz: -d / 2, th: PI }, { key: 'w', len: d, ox: -w / 2, oz: 0, th: -PI / 2 },
  ];
  SIDES.forEach((S, si) => {
    const o = P(S.ox, S.oz);
    const M = mat4At(o[0], 0, o[1], rot + S.th);
    const ux = Math.cos(S.th), uz = -Math.sin(S.th);
    const g = (u) => gyL(S.ox + u * ux, S.oz + u * uz);
    const half = S.len / 2, sgnU = S.key === 's' || S.key === 'w' ? 1 : -1;
    const gaps = (b.gaps[S.key] || []).map((q) => ({ u0: sgnU * q.c - q.w / 2, u1: sgnU * q.c + q.w / 2 }));
    // boarded windows between the doors
    const wins = [];
    const nW = Math.max(0, Math.floor((S.len - 2) / 3.6));
    for (let i = 0; i < nW; i++) {
      const u = -half + 1 + (i + 0.5) * ((S.len - 2) / nW);
      if (gaps.some((q) => u > q.u0 - 1.2 && u < q.u1 + 1.2)) continue;
      wins.push({ u0: u - 0.55, u1: u + 0.55, v0: y0 + 0.9, v1: y0 + 2.3, steel: rng.chance(0.35) });
    }
    const doorHoles = gaps.map((q) => ({ u0: q.u0, u1: q.u1, v0: y0 - 0.4, v1: y0 + 2.2 }));
    // ── outside
    setFrame(M);
    const holes = [...doorHoles, ...wins];
    wallHoles(K.stone, -half - 0.04, half + 0.04, y0 - 0.4, pTop, doorHoles, 0.04, plinthCol, (y) => 0.7 + 0.22 * smoothstep(y0 - 0.2, pTop, y), 2.6, si);
    let a = -half - 0.04;
    for (const q of [...doorHoles.sort((p, r) => p.u0 - r.u0), { u0: half + 0.04, u1: half + 0.04 }]) {
      if (q.u0 > a + 1e-3) quad(K.stone, [a, pTop, 0.04], [q.u0, pTop, 0.04], [Math.min(q.u0, half), pTop + 0.035, 0], [Math.max(a, -half), pTop + 0.035, 0], plinthCol, 0.95);
      a = q.u1;
    }
    const kf = (y) => (0.8 + 0.2 * smoothstep(y0 - 0.4, y0 + 1.6, y)) * (1 - 0.14 * smoothstep(yTop - 1, yTop, y));
    wallHoles(K.wall, -half, half, pTop, yTop - 0.24, holes, 0, wallCol, kf, us, si * 1.37);
    // slab edge with a drip flashing, and a cornice under it
    rectZ(K.conc, -half, yTop, half, yTop + 0.25, 0.0, 1, C(0x9a9a94), 0.85, 1, 3);
    box(K.paint, 0, yTop + 0.24, 0.02, S.len + 0.04, 0.035, 0.04, C(0x7a7e7a), { skip: 32 });
    for (const q of wins) {
      reveal(K.wall, q.u0, q.v0, q.u1, q.v1, 0, -0.14, wallCol, 0.86, 0.55, us);
      rectZ(K.dark, q.u0, q.v0, q.u1, q.v1, -0.14, 1, C(0x302e2c), 0.5, 0.6, 2);
      box(K.stone, (q.u0 + q.u1) / 2, q.v0 - 0.035, 0.02, 1.26, 0.07, 0.12, trim, { skip: 32, us: 2.6 });
      box(isStone ? K.stone : K.plaster, (q.u0 + q.u1) / 2, q.v1 + 0.1, 0.012, 1.36, 0.2, 0.024, trim, { skip: 32, us: 2.6 });
      if (q.steel) {
        box(K.paint, (q.u0 + q.u1) / 2, (q.v0 + q.v1) / 2, -0.1, 1.08, 1.38, 0.025, C(0x5a5e5a), { skip: 32 });
        for (let k = 0; k < 5; k++) box(K.paint, (q.u0 + q.u1) / 2, q.v0 + 0.15 + k * 0.27, -0.085, 1.0, 0.04, 0.012, C(0x4e524e), { skip: 32 });
      } else boards(K, (q.u0 + q.u1) / 2, q.v0, q.v1, 1.1, -0.11, rng);
    }
    for (const q of gaps) {
      const gg = g((q.u0 + q.u1) / 2), uc = (q.u0 + q.u1) / 2;
      reveal(K.wall, q.u0, y0 - 0.4, q.u1, y0 + 2.2, 0, -t, wallCol, 0.85, 0.6, us, { noBot: true });
      rectX(K.stone, 0, y0 - 0.4, 0.04, pTop, q.u0, 1, plinthCol, 0.7, 0.8, 2.6); rectX(K.stone, 0, y0 - 0.4, 0.04, pTop, q.u1, -1, plinthCol, 0.7, 0.8, 2.6);
      // lining, architraves both sides, threshold, lintel stone
      box(K.pwood, q.u0 + 0.012, (gg + y0 + 2.2) / 2, -t / 2, 0.024, y0 + 2.2 - gg, t, frameC, { skip: 2 });
      box(K.pwood, q.u1 - 0.012, (gg + y0 + 2.2) / 2, -t / 2, 0.024, y0 + 2.2 - gg, t, frameC, { skip: 1 });
      box(K.pwood, uc, y0 + 2.188, -t / 2, q.u1 - q.u0, 0.024, t, frameC, { skip: 4 });
      for (const zz of [0.012, -t - 0.012]) {
        for (const ex of [q.u0 - 0.05, q.u1 + 0.05]) box(K.pwood, ex, (gg + y0 + 2.28) / 2, zz, 0.1, y0 + 2.28 - gg, 0.024, frameC);
        box(K.pwood, uc, y0 + 2.25, zz, q.u1 - q.u0 + 0.2, 0.1, 0.024, frameC);
      }
      box(K.stone, uc, gg - 0.01, -t / 2, q.u1 - q.u0, 0.07, t + 0.1, C(0xa8a296), { us: 2.6 });
      box(isStone ? K.stone : K.plaster, uc, y0 + 2.42, 0.014, q.u1 - q.u0 + 0.5, 0.24, 0.028, trim, { skip: 32, us: 2.6 });
    }
    // ── inside (mirrored frame on the inner face: u' = −u)
    setFrame(M.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -t).multiply(new THREE.Matrix4().makeRotationY(PI))));
    const ih = half - t, ihl = gaps.map((q) => ({ u0: -q.u1, u1: -q.u0, v0: y0 - 0.4, v1: y0 + 2.2 }));
    const dado = y0 + 1.2;
    wallHoles(K.plaster, -ih, ih, y0 - 0.2, dado, ihl, 0, lowCol, (y) => 0.75 + 0.2 * smoothstep(y0, dado, y), 3.2);
    wallHoles(K.plaster, -ih, ih, dado, yTop, ihl, 0, highCol, (y) => 0.95 - 0.25 * smoothstep(yTop - 0.8, yTop, y), 3.2);
    // a painted line at the dado, skirting boards between the doors
    let ua = -ih;
    for (const q of [...ihl.sort((p, r) => p.u0 - r.u0), { u0: ih, u1: ih }]) {
      if (q.u0 > ua + 0.05) {
        box(K.paint, (ua + q.u0) / 2, dado, 0.004, q.u0 - ua, 0.025, 0.008, mulC(lowCol, 0.6), { skip: 32 });
        box(K.pwood, (ua + q.u0) / 2, g(-(ua + q.u0) / 2) + 0.06, 0.012, q.u0 - ua, 0.14, 0.024, C(0x4a3a2c), { skip: 32 });
      }
      ua = q.u1;
    }
    // the same windows boarded up from inside
    for (const q of wins) {
      const uc = -(q.u0 + q.u1) / 2;
      rectZ(K.dark, uc - 0.55, q.v0, uc + 0.55, q.v1, 0.004, 1, C(0x2a2826), 0.5, 0.5, 2);
      for (const ex of [uc - 0.6, uc + 0.6]) box(K.pwood, ex, (q.v0 + q.v1) / 2, 0.012, 0.1, q.v1 - q.v0 + 0.1, 0.024, frameC);
      for (const ey of [q.v0 - 0.05, q.v1 + 0.05]) box(K.pwood, uc, ey, 0.012, 1.3, 0.1, 0.024, frameC);
      if (!q.steel) boards(K, uc, q.v0, q.v1, 1.1, 0.03, rng);
      else box(K.paint, uc, (q.v0 + q.v1) / 2, 0.02, 1.08, 1.38, 0.02, C(0x5a5e5a));
    }
    // an old door leaf swung back against the wall beside some doorways
    for (const q of ihl) if (rng.chance(0.55)) {
      const lw = q.u1 - q.u0 - 0.1, side = rng.chance(0.5) ? 1 : -1, u0 = side > 0 ? q.u1 + 0.06 : q.u0 - 0.06 - lw;
      if (u0 < -ih + 0.1 || u0 + lw > ih - 0.1 || ihl.some((r) => r !== q && u0 + lw > r.u0 - 0.1 && u0 < r.u1 + 0.1) || wins.some((r) => { const c0 = -(r.u0 + r.u1) / 2; return Math.abs(c0 - (u0 + lw / 2)) < lw / 2 + 0.7; })) continue;
      const gg = g(-(u0 + lw / 2));
      box(K.pwood, u0 + lw / 2, gg + 1.08, 0.07, lw, 2.05, 0.045, C(rng.pick(DOOR_COLS)));
      for (const fy of [0.3, 0.75]) box(K.pwood, u0 + lw / 2, gg + 0.1 + 2 * fy, 0.1, lw - 0.16, 0.6, 0.015, C(rng.pick(DOOR_COLS)), { skip: 32 });
    }
  });
  // ── corners, cornice, roof surface, ceiling, beams, floor (building-local frame)
  setFrame(mat4At(x, 0, z, rot));
  const qG = K.stone;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    let alt = 0;
    for (let y = pTop + 0.04; y + 0.42 < yTop - 0.3; y += 0.42) {
      const la = alt ? 0.28 : 0.46, lb = alt ? 0.46 : 0.28;
      box(qG, sx * (w / 2 - la / 2 + 0.0125), y + 0.2, sz * (d / 2 - lb / 2 + 0.0125), la + 0.025, 0.395, lb + 0.025, mulC(trim, 0.95 + alt * 0.05), { skip: (sx > 0 ? 2 : 1) | (sz > 0 ? 32 : 16), us: 2.6 });
      alt ^= 1;
    }
  }
  sweepRect(isStone ? K.stone : K.plaster, w / 2, d / 2, [[0, yTop - 0.26, 0.7], [0.04, yTop - 0.24, 0.75], [0.05, yTop - 0.16, 0.85], [0.1, yTop - 0.1, 0.8], [0.1, yTop - 0.02, 1], [0, yTop, 1]], trim, { us: 2.6 });
  rectY(K.conc, -w / 2, -d / 2, w / 2, d / 2, yTop + 0.255, 1, C(0x5e5e5a), 1, 3);
  for (let k = 0; k < 4; k++) {
    const pw = rng.range(1, 3), pd = rng.range(0.8, 2.4), px = rng.range(-w / 2 + pw / 2 + 0.2, w / 2 - pw / 2 - 0.2), pz = rng.range(-d / 2 + pd / 2 + 0.2, d / 2 - pd / 2 - 0.2);
    rectY(K.conc, px - pw / 2, pz - pd / 2, px + pw / 2, pz + pd / 2, yTop + 0.26, 1, C(rng.pick([0x4a4a48, 0x6e6c66])), 1, 3);
  }
  const iw = w / 2 - t, id = d / 2 - t;
  rectY(K.conc, -iw, -id, iw, id, yTop - 0.002, -1, C(0xc8c4b8), 0.8, 3);
  const across = w < d, span = across ? iw : id, run = across ? id : iw, nB = Math.max(2, Math.round(run * 2 / 2.4));
  for (let k = 0; k < nB; k++) {
    const p = -run + (k + 0.5) * (2 * run / nB);
    if (across) box(K.wood, 0, yTop - 0.09, p, span * 2, 0.17, 0.14, wood, { skip: 4, us: 1.8 }); else box(K.wood, p, yTop - 0.09, 0, 0.14, 0.17, span * 2, wood, { skip: 4, us: 1.8 });
  }
  const nx = Math.max(2, Math.round(iw * 2 / 1.5)), nz = Math.max(2, Math.round(id * 2 / 1.5));
  grid(K.wood, nx, nz, (i, j) => { const lx = -iw + (i / nx) * 2 * iw, lz = id - (j / nz) * 2 * id; return [lx, gyL(lx, lz) + 0.06, lz]; }, C(0x8a7a66), {
    uv: (i, j, p) => [p[0] / 1.8, p[2] / 1.8], colAt: (i, j) => [C(0x8a7a66), 0.75 + 0.25 * (Math.min(i, nx - i, j, nz - j) > 0 ? 1 : 0.6)],
  });
  FE = null;
}
/** Planks nailed across an opening (centre u, from v0 to v1, width ww) at depth z. */
function boards(K, u, v0, v1, ww, z, rng) {
  const n = 3 + Math.floor(rng() * 2), plank = C(rng.pick([0x9a8a72, 0x8a7a64, 0xa89880]));
  for (let k = 0; k < n; k++) {
    const y = v0 + (v1 - v0) * ((k + 0.5) / n) + (rng() - 0.5) * 0.08;
    box(K.wood, u + (rng() - 0.5) * 0.06, y, z, ww + 0.12, 0.17 + rng() * 0.06, 0.024, plank, { skip: 32, rz: (rng() - 0.5) * 0.2, us: 1.8 });
  }
}

// ───────────────────────────── props ─────────────────────────────
/** Round section between two points (logs, posts, pipes). */
const _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
function cylBetween(g, a, b, r0, r1, col, o = {}) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), len = d.length();
  _q.setFromUnitVectors(_up, d.normalize());
  const keep = FE ? _F.clone() : null;
  const m = new THREE.Matrix4().makeRotationFromQuaternion(_q).setPosition((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  setFrame(keep ? keep.clone().multiply(m) : m);
  cyl(g, 0, 0, 0, r1, r0, len, col, { seg: o.seg || 7, caps: o.caps !== false, uv: o.uv, colAt: o.colAt });
  setFrame(keep);
}
/** A soft sandbag, unit size (x length, y height, z width), captured once and instanced by appendMesh. */
let BAG = null;
function bagMesh() {
  if (BAG) return BAG;
  BAG = capture((g) => {
    const nu = 8, nv = 5;
    grid(g, nu, nv, (i, j) => {
      const a = (i / nu) * TAU, s = j / nv;
      const ca = Math.cos(a), sa = Math.sin(a);
      let y = 0.5 * Math.sign(sa) * Math.pow(Math.abs(sa), 0.55), z = 0.5 * Math.sign(ca) * Math.pow(Math.abs(ca), 0.55);
      const f = Math.max(0.16, Math.pow(Math.sin(PI * s), 0.32));
      y = Math.max(y * f, -0.46) + (y > 0 ? 0.04 * Math.sin(PI * s) : 0); z *= f * (1 + 0.05 * Math.sin(PI * s));
      return [s - 0.5, y, z];
    }, C(0xffffff), { wrapU: true, uv: (i, j, p) => [p[0] * 0.5, (i / nu) * 1.0] });
  });
  return BAG;
}
const BARREL_COLS = [0x4a5a52, 0x2e4a6a, 0x7a2a22, 0x4a5236, 0x5a4030, 0x3a4a5a];
const BAG_COLS = [0xc2b48e, 0xb4a47c, 0xa89a74, 0xbcae88, 0x9c9070];

/** Visuals for the kit's props. kind: crate | barrel | sandbags | dumpster | lamp | campfire | tent | ladder | stairs */
export function buildProp(L, kind, a) { return timed(L, () => propImpl(L, kind, a)); }

function propImpl(L, kind, a) {
  const K = kit(L), rng = makeRng(seedOf(a.x, a.z, 17 + kind.length));
  switch (kind) {
    case 'crate': {
      setFrame(mat4At(a.x, a.y, a.z, a.rot || 0));
      const s = a.s, h = s / 2, olive = rng.chance(0.3);
      const g = olive ? K.pwood : K.wood, col = olive ? C(rng.pick([0x5a6040, 0x4e5638])) : C(a.tint ?? 0xb8a58a), us = 1.8;
      box(K.dark, 0, h, 0, s - 0.05, s - 0.05, s - 0.05, C(0x2a2622), { us: 2 });
      const nP = s > 0.9 ? 4 : 3, ph = (s - 0.02) / nP;
      for (let f = 0; f < 4; f++) {
        const keep = _F.clone();
        setFrame(keep.clone().multiply(new THREE.Matrix4().makeRotationY(f * PI / 2)));
        for (let k = 0; k < nP; k++) box(g, 0, 0.01 + ph * (k + 0.5), h - 0.012, s - 0.1, ph - 0.012, 0.024, jitC(col, rng, 0.15), { skip: 32, us, rz: (rng() - 0.5) * 0.01 });
        box(g, -h + 0.035, h, h - 0.006, 0.07, s, 0.03, mulC(col, 0.85), { skip: 32 | 2, us });
        for (const yy of [0.04, s - 0.04]) box(g, 0, yy, h + 0.004, s - 0.14, 0.07, 0.02, mulC(col, 0.9), { skip: 32, us });
        if (f === 0 || (f === 2 && rng.chance(0.5))) {
          const sc = C(0x1a1a18);
          for (let k = 0; k < 4; k++) box(K.paint, -0.18 + k * 0.1, h + 0.08, h + 0.016, 0.06, 0.09, 0.004, sc, { skip: 32 });
          box(K.paint, 0.18, h - 0.1, h + 0.016, 0.2, 0.03, 0.004, sc, { skip: 32 });
        }
        setFrame(keep);
      }
      for (let k = 0; k < nP; k++) box(g, -h + 0.01 + (s - 0.02) / nP * (k + 0.5), s - 0.012, 0, (s - 0.02) / nP - 0.012, 0.024, s - 0.02, jitC(col, rng, 0.15), { skip: 8, us });
      break;
    }
    case 'barrel': {
      setFrame(mat4At(a.x, a.y, a.z, rng() * TAU));
      const col = C(rng.pick(BARREL_COLS)), rc = C(0x5a3420), rust = rng() * 0.8;
      const prof = [[0.272, 0], [0.285, 0.012], [0.285, 0.03], [0.278, 0.042], [0.278, 0.28], [0.29, 0.29], [0.29, 0.305], [0.278, 0.315], [0.278, 0.57], [0.29, 0.58], [0.29, 0.595], [0.278, 0.605], [0.278, 0.85], [0.285, 0.862], [0.285, 0.88], [0.26, 0.876], [0.26, 0.862]];
      const dents = [0, 1].map(() => ({ a: rng() * TAU, y: rng.range(0.15, 0.75), d: rng() < 0.6 ? rng.range(0.01, 0.035) : 0 }));
      lathe(K.paint, 0, 0, 0, prof, col, {
        seg: 18, capTop: true,
        dr: (i, s, ang) => { let v = 0; for (const d of dents) { const da = Math.atan2(Math.sin(ang - d.a), Math.cos(ang - d.a)); v -= d.d * Math.exp(-(da * da) / 0.12 - ((prof[i][1] - d.y) ** 2) / 0.02); } return v; },
        colAt: (i, s) => { const y = prof[i][1]; return [hash2(s * 7, i) < rust * (1 - y) ? mixC(col, rc, 0.55) : col, i % 4 === 1 ? 0.92 : 1]; },
        uv: (i, s) => [s / 18 * 1.6, prof[i][1] / 1.6],
      });
      for (const [bx, br] of [[0.13, 0.03], [-0.15, 0.022]]) cyl(K.paint, bx, 0.872, 0.08, br, br, 0.02, mulC(col, 0.8), { seg: 6 });
      break;
    }
    case 'sandbags': {
      const bag = bagMesh(), n = Math.max(1, Math.round(a.h / 0.15)), bh = a.h / n, base = a.y - 0.04;
      const W = mat4At(a.x, 0, a.z, a.rot || 0);
      const put = (lx, ly, lz, sx, sy, sz, ry) => {
        const m = W.clone().multiply(new THREE.Matrix4().makeTranslation(lx, ly, lz)).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler((rng() - 0.5) * 0.06, ry + (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.06, 'YXZ'))).multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
        const col = jitC(C(rng.pick(BAG_COLS)), rng, 0.12);
        appendMesh(K.cloth, bag, m, col, (v, x, y) => 0.72 + 0.28 * clamp01(y + 0.5));
      };
      for (let k = 0; k < n; k++) {
        const y = base + bh * (k + 0.5) + 0.02, top = k === n - 1, sq = top ? 0.92 : 1;
        if (k % 2 === 0) {
          const cnt = Math.max(1, Math.round(a.len / 0.5)), sp = a.len / cnt;
          for (const lz of [0.15, -0.15]) for (let i = 0; i < cnt; i++) put(-a.len / 2 + sp * (i + 0.5) + (k % 4 ? sp * 0.25 : 0) * (i < cnt - 1 ? 1 : 0), y, lz, sp * 1.08, bh * 1.25 * sq, 0.31, 0);
        } else {
          const cnt = Math.max(1, Math.round(a.len / 0.3)), sp = a.len / cnt;
          for (let i = 0; i < cnt; i++) put(-a.len / 2 + sp * (i + 0.5), y, 0, 0.6, bh * 1.25 * sq, sp * 1.1, PI / 2);
        }
      }
      break;
    }
    case 'dumpster': {
      setFrame(mat4At(a.x, a.y, a.z, a.rot || 0));
      const col = C(rng.pick([0x3f4f46, 0x46525a, 0x4e4a3a, 0x3a4652])), dk = mulC(col, 0.7);
      const y0 = 0.2, y1 = 1.1, b0 = [0.8, 0.4], b1 = [0.93, 0.49];
      const corners = (y, h) => [[-h[0], y, -h[1]], [h[0], y, -h[1]], [h[0], y, h[1]], [-h[0], y, h[1]]];
      const lo = corners(y0, b0), hi = corners(y1, b1);
      for (let k = 0; k < 4; k++) { const n = (k + 1) % 4; quad(K.paint, lo[k], lo[n], hi[n], hi[k], col, 1, [k * 0.5, y0 / 1.6, k * 0.5 + 0.5, y0 / 1.6, k * 0.5 + 0.5, y1 / 1.6, k * 0.5, y1 / 1.6]); }
      quad(K.paint, lo[3], lo[2], lo[1], lo[0], dk, 0.5);
      box(K.paint, 0, y1 + 0.03, 0, b1[0] * 2 + 0.04, 0.06, b1[1] * 2 + 0.04, dk, { us: 1.6 });
      // ribs following the taper
      const tilt = Math.atan2(b1[1] - b0[1], y1 - y0), tiltX = Math.atan2(b1[0] - b0[0], y1 - y0);
      for (const sz of [-1, 1]) for (const fx of [-0.55, 0, 0.55]) box(K.paint, fx * (b0[0] + b1[0]) / 2, (y0 + y1) / 2, sz * ((b0[1] + b1[1]) / 2 + 0.02), 0.06, y1 - y0, 0.04, dk, { rx: sz * tilt, us: 1.6 });
      for (const sx of [-1, 1]) {
        box(K.paint, sx * ((b0[0] + b1[0]) / 2 + 0.02), (y0 + y1) / 2, 0, 0.04, y1 - y0, 0.06, dk, { rz: -sx * tiltX, us: 1.6 });
        cyl(K.metal, sx * (b1[0] + 0.06), 0.9, 0, 0.05, 0.05, 0.14, C(0x5a5a56), { axis: 'x', seg: 8 });
      }
      // two lids hinged at the back, one left a little open
      const lidC = mulC(col, 0.85), ajar = rng.chance(0.5) ? 0.07 : 0;
      for (const sx of [-1, 1]) {
        const keep = _F.clone();
        setFrame(keep.clone().multiply(new THREE.Matrix4().makeTranslation(sx * 0.47, y1 + 0.07, -b1[1] - 0.02).multiply(new THREE.Matrix4().makeRotationX(sx > 0 ? -ajar : 0))));
        box(K.paint, 0, 0.02, b1[1] + 0.02, 0.93, 0.04, b1[1] * 2 + 0.06, lidC, { us: 1.6 });
        box(K.paint, 0, 0.0, b1[1] * 2 + 0.05, 0.93, 0.06, 0.03, lidC, { us: 1.6 });
        setFrame(keep);
      }
      // castors
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        box(K.metal, sx * (b0[0] - 0.1), 0.15, sz * (b0[1] - 0.08), 0.1, 0.08, 0.1, C(0x3a3a38));
        cyl(K.rubber, sx * (b0[0] - 0.1), 0.075, sz * (b0[1] - 0.08), 0.075, 0.075, 0.05, C(0x1a1a1a), { axis: 'x', seg: 10, uv: () => [0.75, 0.5] });
      }
      break;
    }
    case 'lamp': {
      const h = a.h;
      if (!a.post) {
        // hurricane lantern hanging from a stake
        setFrame(mat4At(a.x, a.y, a.z, rng() * TAU));
        bar(K.wood, [0, -0.1, 0], [0, h + 0.15, 0], 0.05, C(0x5a4636));
        bar(K.metal, [0, h + 0.12, 0], [0.2, h + 0.12, 0], 0.012, C(0x3a3a38));
        const lx = 0.2, ly = h - 0.15;
        cyl(K.glow, lx, ly, 0, 0.055, 0.06, 0.14, C(a.color), { seg: 8 });
        for (const yy of [ly - 0.09, ly + 0.085]) cyl(K.metal, lx, yy, 0, 0.07, 0.075, 0.035, C(0x6a5a3a), { seg: 8 });
        for (let k = 0; k < 3; k++) { const an = k * TAU / 3; bar(K.metal, [lx + Math.cos(an) * 0.068, ly - 0.08, Math.sin(an) * 0.068], [lx + Math.cos(an) * 0.068, ly + 0.08, Math.sin(an) * 0.068], 0.008, C(0x5a4a2a)); }
        bar(K.metal, [lx, ly + 0.1, 0], [lx, h + 0.12, 0], 0.008, C(0x3a3a38));
        break;
      }
      // Soviet street lamp: tapered steel post on a footing, curved arm, lantern head; the arm reaches toward the street
      const dx = Math.abs(a.x) > 1.5 ? -Math.sign(a.x) : 0, dz = dx ? 0 : 1;
      setFrame(mat4At(a.x, a.y, a.z, Math.atan2(-dz, dx)));
      const col = C(0x2c3032);
      cyl(K.conc, 0, 0.1, 0, 0.1, 0.12, 0.3, C(0x8a8a84), { seg: 8, capBot: false, us: 3 });
      lathe(K.paint, 0, 0, 0, [[0.085, 0.2], [0.085, 0.45], [0.07, 0.5], [0.055, h - 0.4], [0.045, h - 0.32]], col, { seg: 8, capTop: true, uv: (i, s) => [s / 8, [0.2, 0.45, 0.5, h - 0.4, h - 0.32][i] / 1.6] });
      const arm = [];
      for (let k = 0; k <= 6; k++) { const an = (k / 6) * PI / 2; arm.push([0.55 * (1 - Math.cos(an)), h - 0.36 + 0.3 * Math.sin(an), 0]); }
      for (let k = 0; k < 6; k++) cylBetween(K.paint, arm[k], arm[k + 1], 0.034, 0.034, col, { seg: 6, caps: false });
      // lantern head: rounded housing with a glowing bowl underneath
      lathe(K.paint, 0, 0, 0, [[0.03, 0.5], [0.09, 0.55], [0.12, 0.66], [0.1, 0.8], [0.04, 0.86], [0.001, 0.87]].map(([r, x]) => [r, x]), mulC(col, 1.2), { axis: 'x', seg: 10, uv: () => [0.5, 0.9] });
      const keep = _F.clone();
      setFrame(keep.clone().multiply(new THREE.Matrix4().makeTranslation(0, h - 0.07, 0)));
      lathe(K.paint, 0, 0, 0, [[0.03, 0.5], [0.09, 0.55], [0.12, 0.66], [0.1, 0.8], [0.04, 0.86], [0.001, 0.87]], mulC(col, 1.2), { axis: 'x', seg: 10, uv: () => [0.5, 0.9], a0: 0, a1: PI });
      lathe(K.glow, 0, -0.005, 0, [[0.04, 0.54], [0.1, 0.62], [0.1, 0.74], [0.04, 0.82]], C(a.color), { axis: 'x', seg: 10, a0: PI, a1: TAU });
      setFrame(keep);
      break;
    }
    case 'campfire': {
      setFrame(mat4At(a.x, a.y, a.z, rng() * TAU));
      lathe(K.dark, 0, 0.012, 0, [[0.5, 0], [0.001, 0.01]], C(0x3a3632), { seg: 12 });
      for (let k = 0; k < 10; k++) {
        const an = k / 10 * TAU + rng() * 0.2, r = 0.52 + rng() * 0.05, sz = rng.range(0.13, 0.2);
        box(K.stone, Math.cos(an) * r, sz * 0.25, Math.sin(an) * r, sz, sz * 0.7, sz * 0.85, C(rng.pick([0x9a968c, 0x8a867e, 0x7a766e])), { ry: rng() * TAU, rx: (rng() - 0.5) * 0.4, rz: (rng() - 0.5) * 0.4, us: 2.6, kb: 0.6 });
      }
      const bark = C(0x4a3a2a), charC = C(0x1c1816), ember = C(0xff8a3c);
      for (let k = 0; k < 5; k++) {
        const an = k / 5 * TAU + 0.3, A = [Math.cos(an) * 0.42, 0.05, Math.sin(an) * 0.42], B = [Math.cos(an) * 0.05, 0.42, Math.sin(an) * 0.05];
        cylBetween(K.wood, A, B, 0.06, 0.045, bark, { seg: 7, colAt: null });
        cylBetween(K.glow, [B[0] * 1.6, B[1] - 0.06, B[2] * 1.6], B, 0.05, 0.04, ember, { seg: 6 });
        cylBetween(K.wood, [A[0] * 0.6 + B[0] * 0.4, A[1] * 0.6 + B[1] * 0.4, A[2] * 0.6 + B[2] * 0.4], [B[0] * 1.6, B[1] - 0.06, B[2] * 1.6], 0.058, 0.05, charC, { seg: 7 });
      }
      for (let k = 0; k < 8; k++) box(K.glow, (rng() - 0.5) * 0.4, 0.03, (rng() - 0.5) * 0.4, 0.06, 0.03, 0.05, C(rng.pick([0xff6a20, 0xffa040, 0xc84a18])), { ry: rng() * 3 });
      for (let k = 0; k < 5; k++) {
        const an = k * 1.3, r = k ? 0.08 : 0, hh = k ? rng.range(0.35, 0.55) : 0.7;
        cyl(K.glow, Math.cos(an) * r, 0.12 + hh / 2, Math.sin(an) * r, 0, k ? 0.1 : 0.14, hh, C(k % 2 ? 0xff9a3c : 0xffc45a), { seg: 5, capBot: false });
      }
      break;
    }
    case 'tent': {
      // Soviet army tent: canvas walls on the collider's footprint, pitched roof on poles, guy lines
      setFrame(mat4At(a.x, a.y, a.z, a.rot || 0));
      const hx = 1.8, hz = 1.1, wh = 1.42, ry = 1.95, ez = 1.24, ey = 1.36;
      const cl = C(rng.pick([0x7a7a5a, 0x6e7052, 0x84805e])), dkc = mulC(cl, 0.8), rope = C(0x8a7e62);
      for (const sg of [1, -1]) {
        grid(K.cloth, 10, 4, (i, j) => {
          const x = -hx - 0.1 + (i / 10) * (2 * hx + 0.2), t = j / 4, fx = ((x + hx) / hx) % 1;
          const sag = 0.05 * Math.sin(PI * Math.min(1, Math.abs(fx))) * Math.sin(PI * t) + 0.02 * Math.sin(PI * t);
          return [x, lerp(ey, ry, t) - sag, sg * lerp(ez, 0, t)];
        }, cl, { flip: sg < 0, uv: (i, j, p) => [p[0] / 1.2, j / 4 * 1.1], colAt: (i, j) => [cl, 0.9 + 0.1 * (j / 4)] });
        grid(K.cloth, 8, 2, (i, j) => { const x = -hx + (i / 8) * 2 * hx, t = j / 2, bulge = 0.04 * Math.sin(PI * i / 8) * (1 - t); return [x, t * wh, sg * (hz + bulge)]; }, cl, { flip: sg < 0, uv: (i, j, p) => [p[0] / 1.2, p[1] / 1.2], colAt: (i, j) => [cl, 0.7 + 0.3 * (j / 2)] });
        // eave line hem
        bar(K.cloth, [-hx - 0.1, ey - 0.01, sg * ez], [hx + 0.1, ey - 0.01, sg * ez], 0.03, dkc);
      }
      for (const sx of [-1, 1]) {
        const pts = [[-hz, 0], [hz, 0], [hz, wh], [0, ry], [-hz, wh]];
        const fan = (sx > 0 ? pts : pts.slice().reverse()).map(([zz, y]) => [sx * hx, y, zz]);
        for (let i = 1; i < 4; i++) tri(K.cloth, fan[0], fan[i], fan[i + 1], cl, 0.85, [fan[0][2], fan[0][1], fan[i][2], fan[i][1], fan[i + 1][2], fan[i + 1][1]]);
        bar(K.wood, [sx * (hx + 0.02), 0, 0], [sx * (hx + 0.02), ry + 0.15, 0], 0.05, C(0x5a4a38));
        bar(K.wood, [sx * (hx + 0.12), ry + 0.02, 0], [sx * (hx - 0.3), ry + 0.02, 0], 0.045, C(0x5a4a38));
        // guy line from the pole top
        bar(K.cloth, [sx * (hx + 0.02), ry + 0.1, 0], [sx * (hx + 0.9), 0.02, 0], 0.012, rope);
        bar(K.wood, [sx * (hx + 0.9), -0.05, 0], [sx * (hx + 0.9), 0.15, 0], 0.03, C(0x5a4a38));
      }
      // the door end: a closed flap and a rolled canvas over it
      const keep = _F.clone();
      setFrame(keep.clone().multiply(new THREE.Matrix4().makeTranslation(hx + 0.012, 0, 0).multiply(new THREE.Matrix4().makeRotationY(PI / 2))));
      rectZ(K.cloth, -0.5, 0, 0.5, 1.5, 0, 1, dkc, 0.7, 0.9, 1.2);
      bar(K.cloth, [0, 0, 0.012], [0, 1.5, 0.012], 0.02, mulC(cl, 0.5));
      cyl(K.cloth, 0, 1.56, 0.04, 0.07, 0.07, 1.1, mulC(cl, 0.9), { axis: 'x', seg: 7 });
      setFrame(keep);
      // guy lines from the eaves to pegs
      for (const sg of [1, -1]) for (const x of [-hx + 0.1, 0, hx - 0.1]) {
        bar(K.cloth, [x, ey, sg * ez], [x, 0.02, sg * (hz + 0.85)], 0.01, rope);
        bar(K.wood, [x, -0.05, sg * (hz + 0.85)], [x, 0.12, sg * (hz + 0.88)], 0.025, C(0x5a4a38));
      }
      break;
    }
    case 'ladder': {
      setFrame(mat4At(a.x, a.y, a.z, a.rot));
      const h = a.h, col = C(0x3a3c3a);
      for (const sx of [-0.25, 0.25]) {
        box(K.paint, sx, (h + 0.95) / 2, 0, 0.012, h + 0.95, 0.06, col, { us: 1.6 });
        bar(K.paint, [sx, h + 0.95, 0], [sx, h + 0.95, -0.55], 0.04, col);
        for (let y = 0.9; y < h - 0.2; y += 1.6) bar(K.paint, [sx, y, 0], [sx, y, -0.25], 0.035, mulC(col, 0.9));
      }
      for (let y = 0.3; y < h + 0.6; y += 0.3) cyl(K.metal, 0, y, 0, 0.013, 0.013, 0.5, C(0x6a6c68), { axis: 'x', seg: 6, caps: false });
      break;
    }
    case 'stairs': {
      setFrame(mat4At(a.x, a.y, a.z, a.rot));
      const n = Math.max(1, Math.round(a.rise / 0.26)), sh = a.rise / n, sd = a.run / n, col = C(0xc8c4b8);
      for (let i = 0; i < n; i++) {
        const hh = sh * (i + 1);
        box(K.stone, 0, hh / 2, -(i + 0.5) * sd, a.w, hh, sd + 0.02, mulC(col, 0.96 + (i % 2) * 0.04), { skip: 8 | (i < n - 1 ? 32 : 0), us: 2.6, kb: 0.75 });
        box(K.stone, 0, hh - 0.025, -i * sd + 0.02, a.w + 0.01, 0.05, 0.05, mulC(col, 1.04), { skip: 32 | 8, us: 2.6 });
        rectY(K.stone, -a.w / 2 + 0.25, -(i + 1) * sd + 0.05, a.w / 2 - 0.25, -i * sd - 0.04, hh + 0.002, 1, mulC(col, 0.88), 1, 2.6);
      }
      break;
    }
  }
  FE = null;
}

/** The removable barricade: one mesh (shared paint material), local space, length len along x, 0.5 deep. */
export function buildBarrier(L, len) {
  return timed(L, () => {
    const g = new Geo({ uv: true }), rng = makeRng(Math.floor(len * 1000) + 5);
    FE = null;
    const post = C(0x4a3e34), wood = C(0x6a5442), wire = C(0x7a7a76);
    // I-beam posts
    const nPost = Math.max(2, Math.round(len / 1.25) + 1);
    for (let k = 0; k < nPost; k++) {
      const x = -len / 2 + 0.08 + (len - 0.16) * k / (nPost - 1);
      for (const z of [-0.16, -0.04]) box(g, x, 1.22, z, 0.13, 2.44, 0.014, post, { us: 1.6 });
      box(g, x, 1.22, -0.1, 0.014, 2.44, 0.11, post, { us: 1.6 });
    }
    // corrugated sheets on the face, overlapping and a little crooked
    const nS = Math.max(1, Math.ceil(len / 0.95));
    for (let k = 0; k < nS; k++) {
      const x0 = -len / 2 + k * (len / nS) - 0.03, x1 = x0 + len / nS + 0.06, y0 = rng.range(0.0, 0.12), y1 = rng.range(2.18, 2.34), zc = 0.15 + (k % 2) * 0.02;
      const col = mixC(C(0x8a8c88), C(0x7a4a2a), rng() * 0.8), nr = 9;
      for (let r = 0; r < nr * 2; r++) {
        const xa = lerp(x0, x1, r / (nr * 2)), xb = lerp(x0, x1, (r + 1) / (nr * 2)), za = zc + (r % 2 ? 0.025 : 0), zb = zc + (r % 2 ? 0 : 0.025);
        quad(g, [xa, y0, za], [xb, y0, zb], [xb, y1, zb], [xa, y1, za], col, 1, [xa / 1.2, y0 / 1.6, xb / 1.2, y0 / 1.6, xb / 1.2, y1 / 1.6, xa / 1.2, y1 / 1.6]);
      }
    }
    for (const y of [0.6, 1.85]) box(g, 0, y, 0.11, len - 0.1, 0.1, 0.04, post, { us: 1.6 });
    // planks on the back
    for (let y = 0.15; y < 2.35; y += 0.24) box(g, (rng() - 0.5) * 0.1, y + 0.1, -0.2, len - 0.06 - rng() * 0.2, 0.2, 0.03, mixC(wood, C(0x8a7a64), rng() * 0.5), { rz: (rng() - 0.5) * 0.02, us: 1.6 });
    // concertina wire along the top
    for (let x = -len / 2 + 0.12; x < len / 2 - 0.1; x += 0.22) {
      const pts = [];
      for (let k = 0; k <= 8; k++) { const an = k / 8 * TAU; pts.push([x + Math.sin(an) * 0.03, 2.33 + Math.cos(an) * 0.11, Math.sin(an) * 0.12]); }
      for (let k = 0; k < 8; k++) bar(g, pts[k], pts[k + 1], 0.008, wire);
    }
    const mesh = new THREE.Mesh(g.build(), mats(L).st_paint);
    mesh.castShadow = true; mesh.receiveShadow = true;
    return mesh;
  });
}

/** The comms relay: equipment cabinet, telescopic mast, whips and a dish, guy wires; a Group whose visible flag the game toggles. */
export function buildRelay(L) {
  return timed(L, () => {
    const g = new Geo({ uv: true }), led = new Geo({ uv: true });
    FE = null;
    const ol = C(0x4a5248), dk = C(0x2a2e2a), st = C(0x8a8c8e);
    for (const z of [-0.35, 0.35]) box(g, 0, 0.04, z, 1.42, 0.08, 0.08, dk, { us: 1.6 });
    box(g, 0, 0.64, 0, 1.36, 1.1, 0.86, ol, { us: 1.6 });
    box(g, 0, 1.205, 0, 1.42, 0.03, 0.92, mulC(ol, 0.9), { us: 1.6 });
    // two doors, handles and hinges on the front
    for (const sx of [-1, 1]) {
      box(g, sx * 0.34, 0.64, 0.435, 0.64, 1.0, 0.012, mulC(ol, 1.05), { skip: 32, us: 1.6 });
      box(g, sx * 0.08, 0.66, 0.45, 0.03, 0.18, 0.025, C(0x6a6c68), { skip: 32 });
      for (const y of [0.3, 1.0]) box(g, sx * 0.665, y, 0.44, 0.03, 0.08, 0.025, dk, { skip: 32 });
    }
    // louvres on the ends
    for (const sx of [-1, 1]) {
      box(g, sx * 0.685, 0.82, 0, 0.012, 0.42, 0.5, dk, { skip: sx > 0 ? 2 : 1 });
      for (let k = 0; k < 6; k++) box(g, sx * 0.695, 0.65 + k * 0.065, 0, 0.012, 0.05, 0.48, ol, { rz: sx * 0.5, skip: sx > 0 ? 2 : 1 });
    }
    // cable out of a gland, along the ground
    const cab = [[0.5, 0.15, -0.43], [0.55, 0.03, -0.6], [0.9, 0.02, -1.2], [1.6, 0.02, -1.5]];
    for (let k = 0; k < cab.length - 1; k++) bar(g, cab[k], cab[k + 1], 0.025, dk);
    // telescopic mast with clamps
    for (const [y0, y1, r] of [[1.21, 3.2, 0.05], [3.2, 4.6, 0.04], [4.6, 5.8, 0.03]]) {
      cyl(g, 0, (y0 + y1) / 2, 0, r, r, y1 - y0, st, { seg: 8, caps: false });
      cyl(g, 0, y0 + 0.04, 0, r + 0.015, r + 0.015, 0.08, mulC(st, 0.7), { seg: 8 });
    }
    box(g, 0, 5.6, 0, 1.2, 0.04, 0.04, st); box(g, 0, 4.1, 0, 0.8, 0.04, 0.04, st);
    for (const sx of [-0.58, 0.58]) bar(g, [sx, 5.6, 0], [sx, 6.9, 0], 0.012, dk);
    bar(g, [0, 5.8, 0], [0, 6.6, 0], 0.01, dk);
    const keep = null;
    setFrame(new THREE.Matrix4().makeTranslation(0.4, 4.1, 0.06).multiply(new THREE.Matrix4().makeRotationY(0.3)));
    lathe(g, 0, 0, 0, [[0.001, -0.02], [0.15, -0.005], [0.3, 0.06], [0.3, 0.06], [0.29, 0.05], [0.001, -0.03]], C(0x9a9e98), { seg: 14, axis: 'z' });
    bar(g, [0, -0.27, 0.06], [0, -0.02, 0.32], 0.015, dk);
    setFrame(keep);
    // guy wires to three pegs
    for (let k = 0; k < 3; k++) { const an = PI / 2 + k * TAU / 3, gx = Math.cos(an) * 2.6, gz = Math.sin(an) * 2.6; bar(g, [0, 4.5, 0], [gx, 0.02, gz], 0.008, C(0x6a6a66)); bar(g, [gx, -0.1, gz], [gx, 0.12, gz], 0.03, dk); }
    box(led, 0.42, 1.08, 0.445, 0.05, 0.05, 0.02, C(0x57ff7a));
    const M = mats(L), group = new THREE.Group();
    const main = new THREE.Mesh(g.build(), M.st_paint); main.castShadow = true; main.receiveShadow = true;
    group.add(main, new THREE.Mesh(led.build(), M.led));
    return group;
  });
}

/** Square stone pedestal at the foot of the flagpole (inside its collider). */
export function buildFlagBase(L, x, y, z) {
  timed(L, () => {
    const K = kit(L), col = C(0xd8d2c2);
    setFrame(mat4At(x, y, z, 0));
    box(K.stone, 0, 0.62, 0, 0.5, 1.65, 0.5, col, { us: 2.6, kb: 0.8 });
    box(K.stone, 0, 1.47, 0, 0.56, 0.06, 0.56, mulC(col, 1.04), { us: 2.6 });
    cyl(K.metal, 0, 1.54, 0, 0.08, 0.09, 0.08, C(0x8a7a5a), { seg: 10 });
  });
}
// ───────────────────────────── fortress rampart ─────────────────────────────
/**
 * Visuals for Level.rampart(): the kit's wall box (2.2 m thick, from the lowest ground −0.4 to h above it)
 * dressed in coursed masonry with a string course, loopholes, a paved wall-walk with an inner curb and
 * battlements on the side facing away from the level (the battlements were never solid, and still aren't).
 */
export function buildRampart(L, x1, z1, x2, z2, h) {
  timed(L, () => {
    const K = kit(L), rng = makeRng(seedOf(x1 + x2, z1 + z2, 23));
    const len = Math.hypot(x2 - x1, z2 - z1), rot = Math.atan2(-(z2 - z1), x2 - x1), cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;
    const y0 = Math.min(L.gy(x1, z1), L.gy(x2, z2), L.gy(cx, cz)) - 0.4, top = y0 + h + 0.4, t = 1.1, half = len / 2;
    const b = L.bounds, s = Math.sin(rot), c = Math.cos(rot);
    const out = (s * (cx - (b.minX + b.maxX) / 2) + c * (cz - (b.minZ + b.maxZ) / 2)) >= 0 ? 1 : -1;   // local +z points away from the level centre?
    const col = C(0xc9c2b0), dk = mulC(col, 0.86), us = 2.6;
    const M = mat4At(cx, 0, cz, rot);
    const slits = [];
    for (let u = -half + 3; u < half - 2; u += 6) slits.push({ u0: u - 0.08, u1: u + 0.08, v0: y0 + 3.0, v1: y0 + 4.0 });
    for (const sg of [1, -1]) {
      setFrame(M.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, sg * t)).multiply(new THREE.Matrix4().makeRotationY(sg > 0 ? 0 : PI)));
      const holes = sg === out ? slits : [];
      let k = 0;
      for (let y = y0; y < top - 0.01; y += 0.86, k++) {
        const ya = y, yb = Math.min(top, y + 0.86), shade = (yy) => (0.78 + 0.18 * smoothstep(y0, y0 + 2, yy)) * (k % 2 ? 0.96 : 1.02);
        wallHoles(K.stone, -half, half, ya, yb, holes, 0, k < 2 ? dk : col, shade, us, sg * 0.7);
      }
      for (const q of holes) { reveal(K.stone, q.u0, q.v0, q.u1, q.v1, 0, -0.45, col, 0.8, 0.4, us); rectZ(K.dark, q.u0, q.v0, q.u1, q.v1, -0.45, 1, C(0x1a1a1a), 1, 1, 2); }
      // string course below the battlements, and a weathered plinth course
      box(K.stone, 0, top - 1.5, 0.03, len, 0.2, 0.06, mulC(col, 1.06), { skip: 32, us, kb: 0.7 });
      box(K.stone, 0, y0 + 1.6, 0.02, len, 0.14, 0.04, dk, { skip: 32, us, kb: 0.7 });
    }
    setFrame(M);
    for (const e of [-1, 1]) rectX(K.stone, -t, y0, t, top, e * half, e, col, 0.8, 1, us);
    // wall-walk paving, inner curb, battlements on the outer edge
    rectY(K.conc, -half, -t, half, t, top + 0.004, 1, C(0xa8a296), 1, 3);
    box(K.stone, 0, top + 0.12, -out * (t - 0.15), len, 0.24, 0.3, mulC(col, 1.02), { us, skip: 8 });
    const n = Math.floor(len / 2.4);
    box(K.stone, 0, top + 0.1, out * (t - 0.4), len, 0.2, 0.8, col, { us, skip: 8 });
    for (let i = 0; i < n; i += 2) {
      const u = -half + ((i + 0.5) / n) * len;
      box(K.stone, u, top + 0.2 + 0.35, out * (t - 0.4), 1.2, 0.7, 0.8, mulC(col, 0.96 + rng() * 0.08), { us, skip: 8, kb: 0.85 });
      box(K.stone, u, top + 0.93, out * (t - 0.4), 1.28, 0.06, 0.88, mulC(col, 1.06), { us });
    }
  });
}

// ───────────────────────────── mosque (scenery, treated with care) ─────────────────────────────
/**
 * Visuals for Level.mosque(): the prayer hall on the kit's 18 × 14 m box (front = local +z), a raised
 * portal with a pointed arch, arcaded windows, a dome on an octagonal drum, and two minarets with
 * corbelled balconies on the kit's minaret colliders. Solid, clean and undamaged: a landmark only.
 */
export function buildMosque(L, x, y, z, rot) {
  timed(L, () => {
    const K = kit(L), wall = C(0xd6cfbd), trim = C(0xece6d6), dark = C(0x1c1e20), wood = C(0x4e3a2a), us = 2.6;
    const dome = C(0x7d8c84), brick = C(0xc8a488), bronze = C(0x8a7a5a);
    const hx = 9, hz = 7, yb = y - 0.5, yt = y + 8.5;
    const base = mat4At(x, 0, z, rot);
    const FACES = [{ th: 0, len: 2 * hx, d: hz, front: true }, { th: PI / 2, len: 2 * hz, d: hx }, { th: PI, len: 2 * hx, d: hz }, { th: -PI / 2, len: 2 * hz, d: hx }];
    for (const Fc of FACES) {
      const M = base.clone().multiply(new THREE.Matrix4().makeRotationY(Fc.th)).multiply(new THREE.Matrix4().makeTranslation(0, 0, Fc.d));
      setFrame(M);
      const half = Fc.len / 2, holes = [], arches = [];
      if (Fc.front) {
        // three pointed arches into a shallow porch; the middle one, the portal, is taller
        for (const [u, w, hh] of [[-6, 2.4, 4.6], [0, 3.2, 5.6], [6, 2.4, 4.6]]) arches.push({ u0: u - w / 2, u1: u + w / 2, ya: y, yb: y + hh - w * 0.45, rise: w * 0.45, dep: 0.8, door: true });
      } else {
        const n = Math.round(Fc.len / 3.2);
        for (let i = 0; i < n; i++) { const u = -half + (i + 0.5) * (Fc.len / n); arches.push({ u0: u - 0.6, u1: u + 0.6, ya: y + 2.2, yb: y + 5.6, rise: 0.75, dep: 0.35 }); }
      }
      for (const a of arches) holes.push({ u0: a.u0, u1: a.u1, v0: a.ya, v1: a.yb + a.rise });
      wallHoles(K.stone, -half - 0.05, half + 0.05, yb, y + 0.6, holes.filter((q) => q.v0 < y + 0.6), 0.05, mulC(wall, 0.85), () => 0.85, us);
      wallHoles(K.stone, -half, half, y + 0.6, yt, holes, 0, wall, (yy) => 0.86 + 0.14 * smoothstep(y, y + 3, yy), us);
      for (const a of arches) {
        reveal(K.stone, a.u0, a.ya, a.u1, a.yb, 0, -a.dep, wall, 0.86, 0.55, us, { noTop: true, noBot: !!a.door });
        archHead(K.stone, a.u0, a.u1, a.yb, a.rise, a.dep, wall, us, 8, POINTED);
        archRing(K.stone, a.u0, a.u1, a.yb, a.rise, 0.2, 0.03, trim, us, false, 8, POINTED);
        const zb = -a.dep;
        if (a.door) {
          // porch: dark recess, carved double door, a lattice window over it
          const dw = Math.min(1.6, a.u1 - a.u0 - 0.6), uc = (a.u0 + a.u1) / 2;
          rectZ(K.stone, a.u0, a.ya, a.u1, a.yb, zb, 1, mulC(wall, 0.7), 0.55, 0.7, us);
          archFill(K, a.u0, a.u1, a.yb, a.rise, zb, null, false, null, true);
          for (const s2 of [-1, 1]) {
            box(K.pwood, uc + s2 * dw / 4, a.ya + 1.3, zb + 0.04, dw / 2 - 0.02, 2.6, 0.06, wood, { skip: 32 });
            for (const fy of [0.6, 1.4, 2.1]) box(K.pwood, uc + s2 * dw / 4, a.ya + fy, zb + 0.08, dw / 2 - 0.2, 0.5, 0.02, mulC(wood, 1.15), { skip: 32 });
          }
          box(K.stone, uc, a.ya + 2.7, zb + 0.06, dw + 0.3, 0.16, 0.12, trim, { skip: 32 });
          const wy = a.ya + 3.1;
          if (a.yb + a.rise * 0.6 > wy + 0.5) {
            archFill(K, uc - dw / 2 + 0.1, uc + dw / 2 - 0.1, Math.min(a.yb, wy + 0.6), 0.3, zb + 0.03, null, false, null, true);
            rectZ(K.dark, uc - dw / 2 + 0.1, wy, uc + dw / 2 - 0.1, Math.min(a.yb, wy + 0.6), zb + 0.03, 1, dark, 1, 1, 2);
            for (let k = 1; k < 4; k++) box(K.stone, uc - dw / 2 + 0.1 + k * (dw - 0.2) / 4, (wy + a.yb) / 2, zb + 0.06, 0.04, a.yb - wy, 0.04, trim);
          }
        } else {
          rectZ(K.dark, a.u0, a.ya, a.u1, a.yb, zb, 1, dark, 1, 1, 2);
          archFill(K, a.u0, a.u1, a.yb, a.rise, zb, null, false, null, true);
          for (const fu of [0.33, 0.67]) box(K.stone, a.u0 + (a.u1 - a.u0) * fu, (a.ya + a.yb + a.rise * 0.6) / 2, zb + 0.03, 0.04, a.yb - a.ya + a.rise * 0.6, 0.04, trim);
          box(K.stone, (a.u0 + a.u1) / 2, (a.ya + a.yb) / 2 + 0.3, zb + 0.03, a.u1 - a.u0, 0.04, 0.04, trim);
          box(K.stone, (a.u0 + a.u1) / 2, a.ya - 0.04, 0.03, a.u1 - a.u0 + 0.2, 0.08, 0.1, trim, { skip: 32 });
        }
      }
      // pilasters between bays
      if (!Fc.front) for (let i = 0; i <= Math.round(Fc.len / 3.2); i++) { const u = -half + i * (Fc.len / Math.round(Fc.len / 3.2)); if (Math.abs(u) < half - 0.2) box(K.stone, u, (y + 0.6 + yt) / 2, 0.025, 0.42, yt - y - 0.6, 0.05, mulC(trim, 0.97), { skip: 32, us }); }
      if (Fc.front) {
        // the portal frame (pishtaq) rising above the roofline, with a calligraphy-free plain border band
        const pw = 4.4, pTop = y + 10.4;
        for (const s2 of [-1, 1]) box(K.stone, s2 * (pw / 2 - 0.25), (y + 0.6 + pTop) / 2, 0.0, 0.5, pTop - y - 0.6, 0.56, trim, { us });
        box(K.stone, 0, pTop - 0.8, 0.0, pw, 1.6, 0.56, trim, { us });
        for (const s2 of [-1, 1]) box(K.stone, s2 * (pw / 2 - 0.55), (y + 6 + pTop - 1.6) / 2, 0.12, 0.1, pTop - 1.6 - y - 6 + 0.02, 0.24, mulC(trim, 0.9), { skip: 32 });
        box(K.stone, 0, pTop + 0.08, 0.16, pw + 0.2, 0.16, 0.36, mulC(trim, 1.04), { us });
        box(K.stone, 0, (yt + pTop - 1.6) / 2, -0.1, pw - 1.0, pTop - 1.6 - yt, 0.2, wall, { us, skip: 8 });
      }
    }
    // cornice, parapet and the roof
    setFrame(base);
    sweepRect(K.stone, hx, hz, [[0, yt - 0.45, 0.75], [0.06, yt - 0.42, 0.8], [0.06, yt - 0.3, 0.9], [0.18, yt - 0.2, 0.85], [0.2, yt - 0.06, 1], [0, yt - 0.04, 1]], trim, { us });
    sweepRect(K.stone, hx, hz, [[0, yt - 0.04, 0.9], [0, yt + 0.55, 1], [0.04, yt + 0.57, 1.05], [0.04, yt + 0.63, 1.05], [-0.34, yt + 0.63, 1], [-0.34, yt, 0.8]], trim, { us });
    rectY(K.conc, -hx + 0.3, -hz + 0.3, hx - 0.3, hz - 0.3, yt + 0.01, 1, C(0x8a8680), 1, 3);
    // octagonal drum with small arched windows, then the dome and its finial
    const dz = -0.5, dr = 4.0, d0 = yt, d1 = yt + 1.7;
    for (let k = 0; k < 8; k++) {
      const a0 = (k / 8) * TAU + PI / 8, a1 = ((k + 1) / 8) * TAU + PI / 8;
      const A = [Math.cos(a0) * dr, d0, dz + Math.sin(a0) * dr], B = [Math.cos(a1) * dr, d0, dz + Math.sin(a1) * dr];
      quad(K.stone, B, A, [A[0], d1, A[2]], [B[0], d1, B[2]], wall, 0.95, [0, d0 / us, 3.06 / us, d0 / us, 3.06 / us, d1 / us, 0, d1 / us]);
      const am = (a0 + a1) / 2, mx = Math.cos(am) * (dr * 0.925 + 0.02), mz = dz + Math.sin(am) * (dr * 0.925 + 0.02);
      const keep = _F.clone();
      setFrame(keep.clone().multiply(new THREE.Matrix4().makeTranslation(mx, 0, mz).multiply(new THREE.Matrix4().makeRotationY(PI / 2 - am))));
      rectZ(K.dark, -0.32, d0 + 0.35, 0.32, d0 + 1.05, 0.0, 1, dark, 1, 1, 2);
      archFill(K, -0.32, 0.32, d0 + 1.05, 0.3, 0.0, null, false, null, true);
      archRing(K.stone, -0.32, 0.32, d0 + 1.05, 0.3, 0.1, 0.03, trim, us, false, 6, POINTED);
      setFrame(keep);
    }
    lathe(K.stone, 0, 0, dz, [[dr + 0.12, d1], [dr + 0.12, d1 + 0.18], [dr, d1 + 0.2]], trim, { seg: 8, us, a0: PI / 8, a1: PI / 8 + TAU });
    const dp = [];
    for (let k = 0; k <= 10; k++) { const th = (k / 10) * PI / 2; dp.push([Math.max(0.02, (dr - 0.15) * Math.cos(th) * (1 - 0.12 * Math.pow(k / 10, 3))), d1 + 0.2 + 3.3 * Math.sin(th) + 0.5 * Math.pow(k / 10, 6)]); }
    lathe(K.paint, 0, 0, dz, dp, dome, { seg: 24, uv: (i, s) => [s / 24 * 6, 0.98] });
    const fy = dp[dp.length - 1][1];
    lathe(K.metal, 0, fy, dz, [[0.12, 0], [0.18, 0.1], [0.18, 0.25], [0.08, 0.36], [0.05, 0.4], [0.05, 0.8], [0.12, 0.9], [0.001, 1.25]], bronze, { seg: 10, uv: () => [0.5, 0.5] });
    // two minarets on the kit's colliders (round, so the rotation never takes them outside their boxes)
    for (const lx of [-10.5, 10.5]) {
      const mx = lx, mz = 6;
      setFrame(base);
      lathe(K.stone, mx, 0, mz, [[1.18, y - 1], [1.18, y + 2.6], [1.12, y + 2.7], [1.12, y + 2.85], [1.02, y + 3.0]], wall, { seg: 8, us, a0: PI / 8, a1: PI / 8 + TAU });
      const prof = [];
      for (let k = 0; k <= 5; k++) {
        const yy = y + 3 + k * 2.3, r = 1.0 - k * 0.022;
        if (k > 0) prof.push([r, yy - 0.12], [r + 0.035, yy - 0.1], [r + 0.035, yy + 0.06], [r, yy + 0.08]);
        else prof.push([r, yy]);
      }
      lathe(K.stone, mx, 0, mz, prof, brick, { seg: 16, us, colAt: (i) => [i % 4 === 1 || i % 4 === 2 ? trim : brick, 1] });
      // corbelled balcony, balustrade, upper shaft, cornice, cap and finial
      const by = y + 14.6;
      lathe(K.stone, mx, 0, mz, [[0.89, by], [1.0, by + 0.2], [1.2, by + 0.38], [1.42, by + 0.55], [1.62, by + 0.7], [1.62, by + 0.82], [0.8, by + 0.82]], trim, { seg: 16, us });
      lathe(K.stone, mx, 0, mz, [[1.6, by + 0.82], [1.6, by + 1.7], [1.66, by + 1.72], [1.66, by + 1.8], [1.5, by + 1.8], [1.5, by + 0.85]], wall, { seg: 16, us });
      lathe(K.stone, mx, 0, mz, [[0.76, by + 0.82], [0.76, by + 4.0], [0.92, by + 4.15], [0.92, by + 4.3], [0.8, by + 4.35]], brick, { seg: 14, us });
      lathe(K.paint, mx, 0, mz, [[1.02, by + 4.35], [0.95, by + 4.55], [0.6, by + 5.6], [0.25, by + 6.6], [0.02, by + 7.3]], dome, { seg: 14, uv: (i, s) => [s / 14 * 3, 0.98] });
      lathe(K.metal, mx, by + 7.25, mz, [[0.06, 0], [0.12, 0.1], [0.12, 0.2], [0.04, 0.3], [0.035, 0.7], [0.001, 0.9]], bronze, { seg: 8, uv: () => [0.5, 0.5] });
      // door at the foot, facing the front
      box(K.pwood, mx, y + 1.1, mz + 1.17, 0.8, 2.2, 0.04, wood, { skip: 32 });
      box(K.stone, mx, y + 2.3, mz + 1.18, 1.1, 0.2, 0.06, trim, { skip: 32 });
    }
  });
}
