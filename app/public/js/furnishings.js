/**
 * furnishings.js — the household things inside the townhouses, drawn from the
 * plan interior-rules.js makes: an old Caucasus town house left in a hurry.
 * Kitchens (worktop and sink, gas cooker or iron stove, fridge, samovar and
 * pear-shaped tea glasses on a tray), bedrooms (beds with head- and footboards,
 * pillows, bedspreads, bedside tables, dressers, panelled wardrobes), living
 * rooms (sofa, armchairs, sideboard, glass cabinet with plates, a CRT on its
 * stand, books, plants), Qarabağ carpets on floors and walls, pictures,
 * clocks, curtains, radiators, ceiling lights, coats by the door.
 *
 * Everything is emitted into the house's batches (veneer, enamel, fabric,
 * carpet atlas) and the level's metal / glass / glow batches, so a street of
 * furnished houses stays a handful of draw calls. Shapes are built in each
 * piece's own frame: x along its width, y up, z out from the wall it stands at.
 */
import * as THREE from 'three';
import { C } from './structures.js';
import { CARPET_CELLS, PICTURE_CELLS } from './textures.js';

const PI = Math.PI;
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ───────────────────────────── emitter ─────────────────────────────
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
const mat = (x, y, z, ry = 0, rx = 0, rz = 0) => new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _one);
// box faces: normal, corners, the local axes giving u, v. bits: 1 +x, 2 −x, 4 +y, 8 −y, 16 +z, 32 −z
const FACES = [
  [1, 0, 0, [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], 2, 1],
  [-1, 0, 0, [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], 2, 1],
  [0, 1, 0, [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], 0, 2],
  [0, -1, 0, [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], 0, 2],
  [0, 0, 1, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], 0, 1],
  [0, 0, -1, [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], 0, 1],
];
const nrm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** Geometry in a local frame (THREE.Matrix4 local → the house's canonical a, y, b), written through the house Frame. */
export class Emit {
  constructor(fr, m, floorY = null) { this.fr = fr; this.m = m; this.e = m.elements; this.floorY = floorY; }
  static at(fr, a, y, b, ry = 0, floorY = null) { return new Emit(fr, mat(a, y, b, ry), floorY); }
  sub(x, y, z, ry = 0, rx = 0, rz = 0) { return new Emit(this.fr, this.m.clone().multiply(mat(x, y, z, ry, rx, rz)), this.floorY); }
  /** canonical (a, y, b) of a local point */
  P(x, y, z) { const e = this.e; return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]; }
  v(g, x, y, z, nx, ny, nz, col, k, u, w) {
    const e = this.e;
    return this.fr._v(g, e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14],
      e[0] * nx + e[4] * ny + e[8] * nz, e[1] * nx + e[5] * ny + e[9] * nz, e[2] * nx + e[6] * ny + e[10] * nz, col, k, u, w);
  }
  _rot(x, y, z, o) { return o.rx || o.ry || o.rz ? [this.sub(x, y, z, o.ry || 0, o.rx || 0, o.rz || 0), 0, 0, 0] : [this, x, y, z]; }
  /** Box centred at (x, y, z), size (sx, sy, sz). o: { rx, ry, rz, skip, us, k, kb (bottom), kt (top) } */
  box(g, x, y, z, sx, sy, sz, col, o = {}) {
    const [E, ox, oy, oz] = this._rot(x, y, z, o);
    const h = [sx / 2, sy / 2, sz / 2], us = o.us || 1, k = o.k ?? 1, kb = o.kb ?? 1, kt = o.kt ?? 1, skip = o.skip || 0, off = [x, y, z];
    for (let f = 0; f < 6; f++) {
      if (skip & (1 << f)) continue;
      const [n0, n1, n2, cs, ua, va] = FACES[f], base = g.count;
      for (const l of cs) E.v(g, ox + l[0] * h[0], oy + l[1] * h[1], oz + l[2] * h[2], n0, n1, n2, col, k * (l[1] < 0 ? kb : kt), (l[ua] * h[ua] + off[ua]) / us, (l[va] * h[va] + off[va]) / us);
      g.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  /** flat polygon (3–4 local points) with normal n; winding fixed to face n; planar uv */
  _face(g, pts, n, col, k, us, ylo, kb) {
    const [p0, p1, p2] = pts, ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2], bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    if ((ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2] < 0) pts = pts.slice().reverse();
    const an = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])], base = g.count;
    for (const p of pts) {
      const u = an[0] >= an[1] && an[0] >= an[2] ? p[2] : p[0], w = an[1] >= an[0] && an[1] >= an[2] ? p[2] : p[1];
      this.v(g, p[0], p[1], p[2], n[0], n[1], n[2], col, p[1] < ylo ? k * kb : k, u / us, w / us);
    }
    g.i.push(base, base + 1, base + 2);
    if (pts.length === 4) g.i.push(base, base + 2, base + 3);
  }
  /** Box with chamfered edges (bevel c): cushions, mattresses, appliances, worktops. Same options as box. */
  cbox(g, x, y, z, sx, sy, sz, c, col, o = {}) {
    const [E, ox, oy, oz] = this._rot(x, y, z, o);
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    c = Math.max(0.001, Math.min(c, hx * 0.95, hy * 0.95, hz * 0.95));
    const ix = hx - c, iy = hy - c, iz = hz - c, k = o.k ?? 1, kb = o.kb ?? 1, us = o.us || 1, skip = o.skip || 0, ylo = oy - hy + c * 0.6;
    const P = (a, b, d) => [ox + a, oy + b, oz + d], F = (pts, n) => E._face(g, pts, n, col, k, us, ylo, kb);
    if (!(skip & 1)) F([P(hx, -iy, -iz), P(hx, -iy, iz), P(hx, iy, iz), P(hx, iy, -iz)], [1, 0, 0]);
    if (!(skip & 2)) F([P(-hx, -iy, -iz), P(-hx, -iy, iz), P(-hx, iy, iz), P(-hx, iy, -iz)], [-1, 0, 0]);
    if (!(skip & 4)) F([P(-ix, hy, -iz), P(ix, hy, -iz), P(ix, hy, iz), P(-ix, hy, iz)], [0, 1, 0]);
    if (!(skip & 8)) F([P(-ix, -hy, -iz), P(ix, -hy, -iz), P(ix, -hy, iz), P(-ix, -hy, iz)], [0, -1, 0]);
    if (!(skip & 16)) F([P(-ix, -iy, hz), P(ix, -iy, hz), P(ix, iy, hz), P(-ix, iy, hz)], [0, 0, 1]);
    if (!(skip & 32)) F([P(-ix, -iy, -hz), P(ix, -iy, -hz), P(ix, iy, -hz), P(-ix, iy, -hz)], [0, 0, -1]);
    for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
      if (!(skip & (sb > 0 ? 16 : 32) && skip & (sa > 0 ? 1 : 2))) F([P(sa * hx, -iy, sb * iz), P(sa * hx, iy, sb * iz), P(sa * ix, iy, sb * hz), P(sa * ix, -iy, sb * hz)], nrm3([sa, 0, sb]));
      if (!(skip & (sb > 0 ? 4 : 8) && skip & (sa > 0 ? 1 : 2))) F([P(sa * hx, sb * iy, -iz), P(sa * ix, sb * hy, -iz), P(sa * ix, sb * hy, iz), P(sa * hx, sb * iy, iz)], nrm3([sa, sb, 0]));
      if (!(skip & (sa > 0 ? 4 : 8) && skip & (sb > 0 ? 16 : 32))) F([P(-ix, sa * hy, sb * iz), P(ix, sa * hy, sb * iz), P(ix, sa * iy, sb * hz), P(-ix, sa * iy, sb * hz)], nrm3([0, sa, sb]));
    }
    for (const sx2 of [-1, 1]) for (const sy2 of [-1, 1]) for (const sz2 of [-1, 1]) F([P(sx2 * hx, sy2 * iy, sz2 * iz), P(sx2 * ix, sy2 * hy, sz2 * iz), P(sx2 * ix, sy2 * iy, sz2 * hz)], nrm3([sx2, sy2, sz2]));
  }
  /** Solid of revolution about local y through (x, y, z): prof [[r, y], …] bottom to top, n sides. o: { k, kb, us, cap, capB, sx, sz, rx, ry, rz } */
  lathe(g, x, y, z, prof, n, col, o = {}) {
    const [E, ox, oy, oz] = this._rot(x, y, z, o);
    const k = o.k ?? 1, kb = o.kb ?? 1, us = o.us || 1, sx = o.sx || 1, sz = o.sz || 1, m = prof.length, base = g.count;
    for (let i = 0; i < m; i++) {
      const p0 = prof[Math.max(0, i - 1)], p1 = prof[Math.min(m - 1, i + 1)], tr = p1[0] - p0[0], ty = p1[1] - p0[1], l = Math.hypot(tr, ty) || 1, nr = ty / l, ny = -tr / l;
      for (let j = 0; j <= n; j++) {
        const t = j / n * 2 * PI, cs = Math.cos(t), sn = Math.sin(t), r = prof[i][0];
        E.v(g, ox + r * cs * sx, oy + prof[i][1], oz + r * sn * sz, nr * cs, ny, nr * sn, col, i === 0 ? k * kb : k, (j / n) * Math.max(0.05, r) * 6.28 / us, prof[i][1] / us);
      }
    }
    for (let i = 0; i < m - 1; i++) for (let j = 0; j < n; j++) { const a = base + i * (n + 1) + j, b = a + 1, c = a + n + 1, d = c + 1; g.i.push(a, c, b, b, c, d); }
    const cap = (i, up) => {
      const r = prof[i][0], yy = prof[i][1];
      if (r < 1e-4) return;
      const ctr = E.v(g, ox, oy + yy, oz, 0, up ? 1 : -1, 0, col, k, 0, 0), b0 = g.count;
      for (let j = 0; j <= n; j++) { const t = j / n * 2 * PI; E.v(g, ox + r * Math.cos(t) * sx, oy + yy, oz + r * Math.sin(t) * sz, 0, up ? 1 : -1, 0, col, k, Math.cos(t) * r / us, Math.sin(t) * r / us); }
      for (let j = 0; j < n; j++) up ? g.i.push(ctr, b0 + j + 1, b0 + j) : g.i.push(ctr, b0 + j, b0 + j + 1);
    };
    if (o.cap) cap(m - 1, true);
    if (o.capB) cap(0, false);
  }
  /** Quad from 4 local points, counter-clockwise seen from its front. uv: [[u, v] × 4] or planar. */
  quad(g, pts, col, o = {}) {
    const [p0, p1, p2] = pts, n = nrm3([(p1[1] - p0[1]) * (p2[2] - p0[2]) - (p1[2] - p0[2]) * (p2[1] - p0[1]), (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2]), (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0])]);
    const base = g.count, k = o.k ?? 1, us = o.us || 1;
    pts.forEach((p, i) => { const uv = o.uv ? o.uv[i] : [p[0] / us, p[1] / us]; this.v(g, p[0], p[1], p[2], n[0], n[1], n[2], col, (o.ks ? o.ks[i] : 1) * k, uv[0], uv[1]); });
    g.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** Quad lying on the floor (draped: each corner at the floor height there + h). pts: [[x, z] × 4] ccw from above. */
  floorQuad(g, pts, h, col, o = {}) {
    const base = g.count, k = o.k ?? 1;
    pts.forEach(([x, z], i) => {
      const p = this.P(x, 0, z), y = (this.floorY ? this.floorY(p[0], p[2]) : p[1]) + h, uv = o.uv ? o.uv[i] : [p[0] / (o.us || 1), p[2] / (o.us || 1)];
      this.fr._v(g, p[0], y, p[2], 0, 1, 0, col, (o.ks ? o.ks[i] : 1) * k, uv[0], uv[1]);
    });
    g.i.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
}

// ───────────────────────────── atlas pieces ─────────────────────────────
const atlasUV = (x, y) => [x / 1024, 1 - y / 1024];
/**
 * A carpet: nine pieces so the border keeps its width at any size; the runner's middle repeats.
 * On the floor (flat: { h }, draped) or on a wall (in the local x–y plane at z, bottom at y0).
 */
export function carpet(E, g, W, D, cell, col, o = {}) {
  const Cc = CARPET_CELLS[cell], bw = Math.min(0.3, Math.max(0.08, 0.15 * Math.min(W, D))), bfU = Cc.b / Cc.w, bfV = Cc.b / Cc.h;
  const us = [[0, bw, 0, bfU]], vs = [[0, bw, 0, bfV], [bw, D - bw, bfV, 1 - bfV], [D - bw, D, 1 - bfV, 1]];
  const nRep = cell === 3 ? Math.max(1, Math.round((W - 2 * bw) / Math.max(0.3, (D - 2 * bw) * 3.5))) : 1;
  for (let i = 0; i < nRep; i++) us.push([bw + (W - 2 * bw) * i / nRep, bw + (W - 2 * bw) * (i + 1) / nRep, bfU, 1 - bfU]);
  us.push([W - bw, W, 1 - bfU, 1]);
  const T = (tu, tv) => atlasUV(Cc.x + tu * Cc.w, Cc.y + tv * Cc.h);
  for (const [x0, x1, tu0, tu1] of us) for (const [z0, z1, tv0, tv1] of vs) {
    if (o.wall) {
      // z runs down the wall from the top edge; corners counter-clockwise seen from the room
      const P = (x, z) => [x - W / 2, o.y0 + D - z, o.z];
      E.quad(g, [P(x0, z1), P(x1, z1), P(x1, z0), P(x0, z0)], col, { uv: [T(tu0, tv1), T(tu1, tv1), T(tu1, tv0), T(tu0, tv0)], ks: o.ks });
    } else {
      // draped over the floor in pieces no bigger than 0.7 m, so it follows uneven ground floors
      const nx = Math.ceil((x1 - x0) / 0.7), nz = Math.ceil((z1 - z0) / 0.7);
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const xa = x0 + (x1 - x0) * i / nx, xb = x0 + (x1 - x0) * (i + 1) / nx, za = z0 + (z1 - z0) * j / nz, zb = z0 + (z1 - z0) * (j + 1) / nz;
        const ua = tu0 + (tu1 - tu0) * i / nx, ub = tu0 + (tu1 - tu0) * (i + 1) / nx, va = tv0 + (tv1 - tv0) * j / nz, vb = tv0 + (tv1 - tv0) * (j + 1) / nz;
        E.floorQuad(g, [[xa - W / 2, za - D / 2], [xb - W / 2, za - D / 2], [xb - W / 2, zb - D / 2], [xa - W / 2, zb - D / 2]], o.h || 0.012, col, { uv: [T(ua, va), T(ub, va), T(ub, vb), T(ua, vb)] });
      }
    }
  }
}
/** A picture in its frame, or a pinned map: the canvas quad faces +z. */
function picture(E, K, w, h, y0, cellIdx, frameCol, c, o = {}) {
  const Pc = PICTURE_CELLS[cellIdx], asp = w / h, ca = Pc.w / Pc.h;
  let cw = Pc.w, ch = Pc.h;
  if (asp > ca) ch = Pc.w / asp; else cw = Pc.h * asp;
  const x0 = Pc.x + (Pc.w - cw) / 2, y0p = Pc.y + (Pc.h - ch) / 2;
  const uv = [atlasUV(x0, y0p + ch), atlasUV(x0 + cw, y0p + ch), atlasUV(x0 + cw, y0p), atlasUV(x0, y0p)];
  const J = E.sub(0, y0, 0, 0, o.tilt || 0, 0), fw = o.frame ?? 0.035, z = o.frame === 0 ? 0.004 : 0.012;
  J.quad(K.car, [[-w / 2 + fw, fw, z], [w / 2 - fw, fw, z], [w / 2 - fw, h - fw, z], [-w / 2 + fw, h - fw, z]], mul([1, 1, 1], c.k * 1.1), { uv });
  if (fw > 0) {
    const fz = 0.024, g = K.ven;
    J.box(g, 0, h - fw / 2, fz / 2, w, fw, fz, frameCol, { k: c.k, skip: 32, us: 0.9 });
    J.box(g, 0, fw / 2, fz / 2, w, fw, fz, frameCol, { k: c.k, skip: 32, us: 0.9 });
    for (const sg of [-1, 1]) J.box(g, sg * (w / 2 - fw / 2), h / 2, fz / 2, fw, h - 2 * fw, fz, frameCol, { k: c.k, skip: 32 | 4 | 8, us: 0.9 });
  }
}

// ───────────────────────────── palettes ─────────────────────────────
const VEN = [0xc89a74, 0xb08060, 0xd4ae86, 0x9a6a4c, 0xe0c09a, 0x8a5a40];              // × the veneer texture
const PAINTED = [0xe8e2d0, 0xd8dcc8, 0xc8d8d0, 0xe4d8b8, 0xd0d8e0];                      // kitchen units, painted shelves
const UPH = [0x8a3a30, 0x5a6a52, 0x6a5a7a, 0x8a7a5a, 0x4a5a72, 0x9a6a3a, 0x7a4a4a, 0x3e5a5a];
const BEDSPREAD = [0x9a3a34, 0x6a4a6a, 0xb08a4a, 0x4a6a8a, 0x7a2a2a, 0x5a7a5a, 0xc8b89a];
const LINEN = [0xeae6dc, 0xe2e4e6, 0xe8e0d0];
const ENAMEL = [0xf0eee6, 0xe8e4d6, 0xf2f0ea];
const CHINA = [0xf4f2ec, 0xe8eef4, 0xf2ece2];
const BRASS = 0xc8a050, NICKEL = 0xb8bcc0;
const BOOKS = [0x7a2a24, 0x2a4a6a, 0x3a5a3a, 0x8a6a3a, 0x5a3a5a, 0x2a2a2a, 0xa0884a, 0x6a2a2a, 0x2e5a6a, 0xb8a888];
const JAM = [0x8a1a1a, 0xc06020, 0x6a7a2a, 0x4a1a3a, 0xd0a030];

const pick = (rng, a) => C(a[Math.floor(rng() * a.length)]);

// ───────────────────────────── shared bits ─────────────────────────────
function legs4(E, g, w, d, h, t, col, inset, c, splay = 0) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) E.box(g, sx * (w / 2 - inset), h / 2, sz * (d / 2 - inset), t, h, t, col, { k: c.k, kb: 0.7, skip: 4, rz: -sx * splay, rx: sz * splay, us: 0.9 });
}
/** a panelled door or drawer front on the face z = zf: board, raised field, handle */
function front(E, K, x, y, w, h, zf, col, c, o = {}) {
  const g = o.g || K.ven, k = c.k;
  E.box(g, x, y, zf + 0.009, w - 0.006, h - 0.006, 0.018, col, { k, skip: 32, us: 0.9 });
  if (o.panel !== false && w > 0.2 && h > 0.2) E.box(g, x, y, zf + 0.021, w - 0.12, h - 0.12, 0.008, mul(col, 1.06), { k, skip: 32 | 8, us: 0.9 });
  if (o.glass) E.box(K.cglass, x, y, zf + 0.012, w - 0.1, h - 0.1, 0.006, [0.6, 0.65, 0.7], { k: 1, skip: 32 });
  const hx = o.hx ?? 0, hy = o.hy ?? 0, metal = mul(C(o.brass ? BRASS : NICKEL), k * 1.1);
  if (o.knob) E.box(K.metal, x + hx, y + hy, zf + 0.03, 0.024, 0.024, 0.024, metal, {});
  else if (o.bar) E.box(K.metal, x + hx, y + hy, zf + 0.034, o.bar, 0.014, 0.014, metal, { skip: 32 });
  else if (o.handle !== false) E.box(K.metal, x + hx, y + hy, zf + 0.03, 0.014, 0.1, 0.014, metal, { skip: 32 });
}
/** a carcass: sides, top, bottom and back as one box, open faces skipped */
function carcass(E, g, w, h, d, y0, col, c, skip = 8 | 32) { E.box(g, 0, y0 + h / 2, 0, w, h, d, col, { k: c.k, kb: 0.75, skip, us: 0.9 }); }
const plateStand = (E, K, x, y, z, r, col, c) => E.lathe(K.ena, x, y + r, z, [[r * 0.55, -0.003], [r, 0.006], [r * 0.97, 0.009]], 8, col, { k: c.k * 1.1, rx: -PI / 2 + 0.25, cap: true });
function glassCup(E, K, x, y, z, c, tea) {
  // armudu: the pear-shaped tea glass, on its saucer
  E.lathe(K.ena, x, y, z, [[0.05, 0.002], [0.056, 0.01]], 7, C(0xf2eee6), { k: c.k, cap: true });
  const pf = [[0.017, 0.012], [0.022, 0.02], [0.015, 0.05], [0.025, 0.09], [0.024, 0.104]];
  E.lathe(K.cglass, x, y, z, pf, 6, [0.75, 0.8, 0.82], {});
  if (tea) E.lathe(K.ena, x, y, z, pf.slice(0, 4).map(([r, yy]) => [r * 0.86, yy - 0.004]), 6, mul(C(0x6a1a0a), c.k), { cap: true });
}
function samovar(E, K, x, z, c, rng) {
  const g = K.metal, col = mul(C(rng() < 0.6 ? BRASS : NICKEL), c.k * 1.15);
  E.lathe(g, x, 0, z, [[0.075, 0], [0.08, 0.015], [0.05, 0.035], [0.045, 0.07], [0.1, 0.09], [0.135, 0.15], [0.135, 0.3], [0.115, 0.355], [0.06, 0.38], [0.05, 0.395], [0.065, 0.41], [0.045, 0.43]], 10, col, { cap: true });
  for (const sg of [-1, 1]) E.box(g, x + sg * 0.16, 0.3, z, 0.05, 0.02, 0.02, col, {});
  E.box(g, x, 0.13, z + 0.15, 0.025, 0.025, 0.05, col, {});
  E.box(g, x, 0.11, z + 0.17, 0.015, 0.03, 0.015, col, {});
  // the teapot that sits on the crown
  const tp = pick(rng, CHINA);
  E.lathe(K.ena, x, 0.43, z, [[0.03, 0], [0.055, 0.02], [0.062, 0.05], [0.05, 0.08], [0.025, 0.09], [0.03, 0.1], [0.012, 0.115]], 9, tp, { k: c.k * 1.1, cap: true });
  E.box(K.ena, x + 0.075, 0.48, z, 0.05, 0.014, 0.014, tp, { k: c.k * 1.1, rz: 0.6 });
  E.box(K.ena, x - 0.07, 0.48, z, 0.014, 0.05, 0.03, tp, { k: c.k * 1.1 });
}
function jar(E, K, x, y, z, r, h, rng, c) {
  E.lathe(K.ena, x, y, z, [[r, 0], [r, h * 0.85], [r * 0.75, h]], 6, mul(pick(rng, JAM), c.k), { cap: true });
  E.lathe(K.metal, x, y + h, z, [[r * 0.8, 0], [r * 0.8, 0.012]], 6, mul(C(0xb8a060), c.k), { cap: true });
}
function books(E, K, x0, x1, y, depth, rng, c, lean = true) {
  let x = x0;
  while (x < x1 - 0.03) {
    const bw = 0.022 + rng() * 0.035, bh = 0.17 + rng() * 0.11;
    if (x + bw > x1) break;
    if (rng() < 0.12) { x += 0.04 + rng() * 0.08; continue; }
    const col = mul(pick(rng, BOOKS), c.k * (0.85 + rng() * 0.3));
    if (lean && rng() < 0.06 && x + bh < x1) { E.box(K.fab, x + bh / 2, y + bw / 2, 0, bh, bw, depth * 0.8, col, { skip: 32 | 8, us: 1.2 }); x += bh + 0.01; continue; }
    E.box(K.fab, x + bw / 2, y + bh / 2, 0.01, bw, bh, depth * 0.8, col, { skip: 32 | 8 | (rng() < 0.7 ? 3 : 0), us: 1.2 });
    x += bw + 0.002;
  }
}

// ───────────────────────────── the pieces ─────────────────────────────
/**
 * Draw one planned piece. E: its emitter (local frame at its floor point), K: the batches,
 * c: { k (colour scale), rng (this piece's own), room (kind), lit, ceil (height to the ceiling), pl, it }.
 */
export function drawPiece(E, K, it, c) {
  const rng = c.rng, k = c.k, w = it.w, d = it.d, h = it.h;
  switch (it.kind) {
    case 'table': case 'ktable': case 'coffee': return table(E, K, it, c);
    case 'tableDown': {
      const col = pick(rng, VEN);
      E.cbox(K.ven, 0, 0.4, 0, w, 0.8, 0.04, 0.008, col, { k, us: 0.9, rz: 0.04 });
      for (const sx of [-1, 1]) for (const yy of [0.08, 0.72]) E.box(K.ven, sx * (w / 2 - 0.07), yy, 0.38, 0.05, 0.05, 0.72, mul(col, 0.85), { k, us: 0.9 });
      E.box(K.ven, 0, 0.72, 0.1, w - 0.16, 0.07, 0.02, mul(col, 0.8), { k, us: 0.9 });
      return;
    }
    case 'chair': case 'chairDown': return chair(it.kind === 'chairDown' ? E.sub(0, 0.22, 0, 0, -PI / 2 + 0.1, 0) : E, K, c);
    case 'bed': return bed(E, K, it, c);
    case 'cot': {
      const steel = mul(C(0x4e5640), k);
      for (const sz of [-1, 1]) E.box(K.metal, 0, 0.36, sz * (d / 2 - 0.02), w, 0.03, 0.03, steel, {});
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) E.box(K.metal, sx * (w / 2 - 0.05), 0.18, sz * (d / 2 - 0.02), 0.03, 0.36, 0.03, steel, { skip: 4 });
      for (const sx of [-1, 1]) E.box(K.metal, sx * (w / 2 - 0.05), 0.36, 0, 0.03, 0.03, d, steel, {});
      E.cbox(K.fab, 0, 0.41, 0, w - 0.08, 0.08, d - 0.06, 0.02, mul(C(0x6a6a4a), k), { us: 1.2 });
      E.cbox(K.fab, 0.3, 0.465, 0, w * 0.5, 0.04, d - 0.04, 0.012, mul(C(rng() < 0.5 ? 0x5a5e48 : 0x6a5a48), k), { us: 1.2, ry: (rng() - 0.5) * 0.08 });
      E.cbox(K.fab, -w / 2 + 0.25, 0.48, 0, 0.32, 0.08, d * 0.6, 0.03, mul(C(0x9a9a8a), k), { us: 1.2 });
      return;
    }
    case 'wardrobe': return c.room === 'living' ? glassCabinet(E, K, it, c, false) : wardrobe(E, K, it, c);
    case 'hutch': return glassCabinet(E, K, it, c, true);
    case 'wardrobeDown': {
      const col = pick(rng, VEN), J = E.sub(0, 0, 0, 0.05);
      carcass(J, K.ven, w, h, d, 0, col, c, 8);
      for (const sx of [-1, 1]) {
        const fx = sx * w / 4;
        J.box(K.ven, fx, h + 0.009, 0, w / 2 - 0.01, 0.018, d - 0.06, mul(col, 1.04), { k, skip: 8, us: 0.9 });
        J.box(K.ven, fx, h + 0.022, 0, w / 2 - 0.14, 0.008, d - 0.2, mul(col, 1.1), { k, skip: 8, us: 0.9 });
      }
      J.box(K.metal, 0.05, h + 0.03, 0, 0.1, 0.014, 0.014, mul(C(NICKEL), k), {});
      return;
    }
    case 'shelf': case 'bookcase': return shelf(E, K, it, c);
    case 'cabinet': case 'counter': case 'sideboard':
      if (it.kind === 'counter' || (it.kind === 'cabinet' && c.room === 'kitchen')) return sinkRun(E, K, it, c);
      return sideboard(E, K, it, c);
    case 'sofa': case 'armchair': return sofa(E, K, it, c);
    case 'stove': return it.fire ? ironStove(E, K, it, c) : cooker(E, K, it, c);
    case 'fridge': {
      const col = mul(pick(rng, ENAMEL), k);
      E.cbox(K.ena, 0, h / 2 + 0.04, 0, w, h - 0.08, d - 0.04, 0.05, col, { kb: 0.8, skip: 32 });
      E.box(K.dark, 0, 0.04, 0.02, w - 0.06, 0.08, d - 0.1, mul(C(0x2a2a28), 1), {});
      E.box(K.ena, 0, h - 0.33, d / 2 - 0.018, w - 0.03, 0.006, 0.006, mul(col, 0.6), {});
      const ch = mul(C(NICKEL), k * 1.2), side = rng() < 0.5 ? -1 : 1;
      E.box(K.metal, side * (w / 2 - 0.08), h * 0.66, d / 2 + 0.01, 0.035, 0.24, 0.045, ch, { skip: 32 });
      E.box(K.metal, 0, h - 0.18, d / 2 - 0.01, 0.22, 0.03, 0.012, ch, { skip: 32 });
      return;
    }
    case 'gascyl': {
      E.lathe(K.ena, 0, 0, 0, [[0.13, 0], [0.15, 0.03], [0.15, 0.49], [0.12, 0.56], [0.05, 0.59]], 9, mul(C(0xa82a20), k), { cap: true, kb: 0.7 });
      E.lathe(K.metal, 0, 0.59, 0, [[0.06, 0], [0.06, 0.07], [0.02, 0.07]], 8, mul(C(NICKEL), k), {});
      E.box(K.metal, 0, 0.62, 0, 0.03, 0.06, 0.03, mul(C(BRASS), k), {});
      return;
    }
    case 'tv': return tvSet(E, K, it, c);
    case 'plant': return plant(E, K, c);
    case 'nightstand': {
      const col = pick(rng, VEN);
      carcass(E, K.ven, w, h - 0.08, d, 0.06, col, c);
      E.cbox(K.ven, 0, h - 0.01, 0.005, w + 0.02, 0.022, d + 0.015, 0.006, col, { k, us: 0.9 });
      legs4(E, K.ven, w, d, 0.06, 0.035, mul(col, 0.8), 0.04, c);
      front(E, K, 0, h - 0.13, w - 0.03, 0.1, d / 2, col, c, { knob: true, panel: false });
      E.box(K.dark, 0, 0.26, d / 2 - 0.005, w - 0.06, 0.2, 0.01, [0.03, 0.025, 0.02], {});
      // a small lamp, or a book and a glass of water
      if (rng() < 0.6) {
        E.lathe(K.ena, 0.04, h, -0.02, [[0.05, 0], [0.05, 0.015], [0.015, 0.03], [0.012, 0.2]], 8, mul(C(rng() < 0.5 ? 0xd8c8a8 : 0x8a6a4a), k), { cap: true });
        E.lathe(K.fab, 0.04, h + 0.16, -0.02, [[0.11, 0], [0.08, 0.15], [0.07, 0.15]], 9, mul(C(rng() < 0.5 ? 0xd8b880 : 0xb8d0c0), k * 1.1), { cap: true });
      } else {
        E.box(K.fab, -0.05, h + 0.015, 0, 0.16, 0.03, 0.22, mul(pick(rng, BOOKS), k), { ry: rng() - 0.5 });
        E.lathe(K.cglass, 0.12, h, 0.05, [[0.03, 0], [0.035, 0.11]], 7, [0.7, 0.75, 0.8], { cap: true });
      }
      return;
    }
    case 'dresser': {
      const col = pick(rng, VEN);
      carcass(E, K.ven, w, h - 0.1, d, 0.08, col, c);
      E.cbox(K.ven, 0, h - 0.012, 0.01, w + 0.03, 0.025, d + 0.02, 0.008, col, { k, us: 0.9 });
      E.box(K.ven, 0, 0.04, 0, w - 0.04, 0.08, d - 0.04, mul(col, 0.7), { k, skip: 8 | 32, us: 0.9 });
      const dh = (h - 0.14) / 3;
      for (let i = 0; i < 3; i++) for (const sg of w > 0.8 ? [-1, 1] : [0]) front(E, K, 0, 0.11 + dh * (i + 0.5), w - 0.03, dh - 0.01, d / 2, col, c, { knob: true, hx: sg * w * 0.28, panel: false });
      E.box(K.fab, 0, h + 0.002, 0.02, w * 0.6, 0.004, d * 0.6, mul(C(0xf0ece4), k * 1.2), { skip: 8 });
      for (let i = 0; i < 3; i++) E.lathe(K.cglass, w * 0.25 + i * 0.06, h, -0.08 + (i % 2) * 0.05, [[0.02, 0], [0.024, 0.06], [0.01, 0.075], [0.012, 0.09]], 6, [0.8, 0.75, 0.7], { cap: true });
      E.cbox(K.ven, -w * 0.28, h + 0.04, -0.05, 0.18, 0.08, 0.12, 0.01, mul(pick(rng, VEN), 0.8), { k, us: 0.9 });
      return;
    }
    case 'chest': {
      // the sandıq: a dowry chest with iron bands
      const col = mul(pick(rng, VEN), 0.85), iron = mul(C(0x3a3632), k);
      E.box(K.ven, 0, (h - 0.1) / 2, 0, w, h - 0.1, d, col, { k, kb: 0.7, skip: 8 | 32, us: 0.9 });
      E.cbox(K.ven, 0, h - 0.05, 0.005, w + 0.02, 0.1, d + 0.015, 0.02, col, { k, us: 0.9 });
      for (const sx of [-0.32, 0, 0.32]) { E.box(K.metal, sx * w, h / 2, d / 2 + 0.006, 0.04, h, 0.008, iron, { skip: 32 }); E.box(K.metal, sx * w, h + 0.003, 0, 0.04, 0.006, d + 0.02, iron, { skip: 8 }); }
      E.box(K.metal, 0, h - 0.14, d / 2 + 0.012, 0.08, 0.1, 0.008, mul(C(BRASS), k), { skip: 32 });
      if (rng() < 0.5) E.cbox(K.fab, 0, h + 0.05, 0, w * 0.8, 0.1, d * 0.85, 0.03, mul(pick(rng, BEDSPREAD), k), { us: 1.2, ry: (rng() - 0.5) * 0.1 });
      return;
    }
    case 'sacks': {
      for (let i = 0; i < 3; i++) {
        const sx = -w / 2 + 0.22 + i * (w - 0.44) / 2;
        E.cbox(K.fab, sx, 0.2 + (i % 2) * 0.02, (rng() - 0.5) * 0.08, 0.36, 0.4 + rng() * 0.06, 0.42, 0.1, mul(C(0xb0a07a), k * (0.85 + rng() * 0.2)), { us: 1.2, ry: (rng() - 0.5) * 0.4, kb: 0.7 });
      }
      return;
    }
    case 'cases': {
      let y = 0;
      for (let i = 0; i < 2; i++) {
        const cw = w - i * 0.1, chh = 0.2 + rng() * 0.06, cd = d - i * 0.06, col = mul(C([0x6a4a30, 0x4a5a4a, 0x7a3a2a, 0x8a7a5a][Math.floor(rng() * 4)]), k), ry = (rng() - 0.5) * 0.15;
        const J = E.sub(0, 0, 0, ry);
        J.cbox(K.fab, 0, y + chh / 2, 0, cw, chh, cd, 0.025, col, { us: 1.2, kb: 0.75 });
        J.box(K.metal, 0, y + chh / 2 + 0.02, cd / 2 + 0.012, 0.14, 0.022, 0.022, mul(C(0x3a3028), k), {});
        for (const sx of [-1, 1]) J.box(K.metal, sx * (cw / 2 - 0.06), y + chh * 0.7, cd / 2 + 0.003, 0.04, 0.03, 0.006, mul(C(BRASS), k), {});
        y += chh;
      }
      return;
    }
    case 'mattress': {
      E.cbox(K.fab, 0, 0.07, 0, w, 0.14, d, 0.04, mul(C(rng() < 0.5 ? 0xb8b0a0 : 0x8a9aa8), k), { us: 1.2, kb: 0.7 });
      E.cbox(K.fab, 0.2, 0.15, 0, w * 0.55, 0.04, d - 0.02, 0.015, mul(pick(rng, BEDSPREAD), k), { us: 1.2, ry: (rng() - 0.5) * 0.2 });
      E.cbox(K.fab, -w / 2 + 0.25, 0.17, 0, 0.32, 0.08, d * 0.6, 0.03, mul(pick(rng, LINEN), k), { us: 1.2 });
      return;
    }
    case 'rug': {
      carpet(E, K.car, w, d, Math.floor(rng() * 3), [k * 1.15, k * 1.15, k * 1.15], { h: it.f === 0 ? 0.018 : 0.012 });
      const fr = mul(C(0xe8dcc4), k);
      for (const sg of [-1, 1]) { const xa = sg > 0 ? w / 2 : -w / 2 - 0.05, xb = xa + 0.05; E.floorQuad(K.fab, [[xa, -d / 2], [xb, -d / 2], [xb, d / 2], [xa, d / 2]], 0.008, fr, { us: 0.3 }); }
      return;
    }
    // ── on the walls
    case 'picture': return picture(E, K, w, h, it.y0, it.var % 6, mul(C(rng() < 0.4 ? 0xb8963e : VEN[Math.floor(rng() * VEN.length)]), 1), c, { tilt: rng() < 0.15 ? 0.06 : 0.02 });
    case 'map': {
      picture(E, K, w, h, it.y0, 6, [1, 1, 1], c, { frame: 0 });
      for (const [px, py] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) E.box(K.metal, px * (w / 2 - 0.02), it.y0 + h / 2 + py * (h / 2 - 0.02), 0.01, 0.012, 0.012, 0.012, mul(C(0xb82a2a), k), {});
      return;
    }
    case 'clock': {
      const col = pick(rng, VEN), y0 = it.y0;
      E.cbox(K.ven, 0, y0 + 0.17, 0.03, 0.34, 0.34, 0.06, 0.012, col, { k, us: 0.9, skip: 32 });
      const Pc = PICTURE_CELLS[7], s = 0.27, uv = [atlasUV(Pc.x + 4, Pc.y + 140), atlasUV(Pc.x + 124, Pc.y + 140), atlasUV(Pc.x + 124, Pc.y + 20), atlasUV(Pc.x + 4, Pc.y + 20)];
      E.quad(K.car, [[-s / 2, y0 + 0.17 - s / 2, 0.062], [s / 2, y0 + 0.17 - s / 2, 0.062], [s / 2, y0 + 0.17 + s / 2, 0.062], [-s / 2, y0 + 0.17 + s / 2, 0.062]], [k * 1.15, k * 1.15, k * 1.15], { uv });
      const hh = rng() * 2 * PI, mm = rng() * 2 * PI, dark = [0.03, 0.03, 0.03];
      E.box(K.dark, Math.sin(hh) * 0.035, y0 + 0.17 + Math.cos(hh) * 0.035, 0.066, 0.008, 0.075, 0.003, dark, { rz: -hh });
      E.box(K.dark, Math.sin(mm) * 0.05, y0 + 0.17 + Math.cos(mm) * 0.05, 0.068, 0.006, 0.105, 0.003, dark, { rz: -mm });
      return;
    }
    case 'wallCarpet': {
      carpet(E, K.car, w, h, it.var % 3, [k * 1.15, k * 1.15, k * 1.15], { wall: true, y0: it.y0, z: 0.012 });
      E.box(K.metal, 0, it.y0 + h + 0.01, 0.02, w + 0.08, 0.016, 0.016, mul(C(BRASS), k), {});
      return;
    }
    case 'mirror': {
      const col = pick(rng, VEN), y0 = it.y0;
      E.box(K.glass, 0, y0 + h / 2, 0.018, w - 0.06, h - 0.06, 0.006, [0.55, 0.6, 0.62], { skip: 32 });
      for (const sg of [-1, 1]) { E.box(K.ven, 0, y0 + (sg > 0 ? h - 0.03 : 0.03), 0.015, w, 0.06, 0.03, col, { k, skip: 32, us: 0.9 }); E.box(K.ven, sg * (w / 2 - 0.03), y0 + h / 2, 0.015, 0.06, h - 0.12, 0.03, col, { k, skip: 32 | 4 | 8, us: 0.9 }); }
      return;
    }
    case 'wallcab': {
      const col = mul(c.unit || pick(rng, PAINTED), 1), y0 = it.y0, g = c.unitG || K.ena, n = w > 1.0 ? 3 : 2;
      E.box(g, 0, y0 + h / 2, d / 2, w, h, d, col, { k, skip: 32, us: 0.9 });
      for (let i = 0; i < n; i++) front(E, K, -w / 2 + w * (i + 0.5) / n, y0 + h / 2, w / n, h, d, col, c, { g, hx: (i % 2 ? -1 : 1) * (w / n / 2 - 0.05), hy: -h * 0.35 });
      return;
    }
    case 'jarshelf': {
      const col = pick(rng, VEN), y0 = it.y0;
      E.box(K.ven, 0, y0 + 0.012, d / 2, w, 0.024, d, col, { k, skip: 32, us: 0.9 });
      for (const sg of [-1, 1]) E.box(K.ven, sg * (w / 2 - 0.06), y0 - 0.06, 0.06, 0.02, 0.12, 0.12, mul(col, 0.85), { k, skip: 32, us: 0.9 });
      let x = -w / 2 + 0.07;
      while (x < w / 2 - 0.06) { const r = 0.035 + rng() * 0.02, hj = 0.1 + rng() * 0.08; jar(E, K, x + r, y0 + 0.024, d / 2, r, hj, rng, c); x += 2 * r + 0.02 + rng() * 0.05; }
      return;
    }
    case 'coats': {
      const col = pick(rng, VEN), y0 = it.y0;
      E.box(K.ven, 0, y0 + 0.16, 0.012, w, 0.1, 0.024, col, { k, skip: 32, us: 0.9 });
      const n = 4, hooks = [];
      for (let i = 0; i < n; i++) { const x = -w / 2 + w * (i + 0.5) / n; hooks.push(x); E.box(K.metal, x, y0 + 0.17, 0.05, 0.012, 0.012, 0.06, mul(C(BRASS), k), {}); }
      const nc = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < nc; i++) {
        const x = hooks[(i * 2 + Math.floor(rng() * 2)) % n], col2 = mul(C([0x3a3a3e, 0x5a4a3a, 0x4a5a5a, 0x6a5a4a, 0x2a2e36][Math.floor(rng() * 5)]), k), ry = (rng() - 0.5) * 0.3;
        const J = E.sub(x, y0 + 0.15, 0.13, ry);
        J.cbox(K.fab, 0, -0.1, 0, 0.42, 0.2, 0.16, 0.06, col2, { us: 1.2 });
        J.cbox(K.fab, 0, -0.5, 0.01, 0.46, 0.66, 0.15, 0.05, mul(col2, 0.95), { us: 1.2, kb: 0.8 });
        for (const sg of [-1, 1]) J.cbox(K.fab, sg * 0.22, -0.42, 0.01, 0.09, 0.6, 0.11, 0.04, mul(col2, 0.9), { us: 1.2, rz: sg * 0.06 });
      }
      if (rng() < 0.5) {
        // a sheepskin papakha on the last hook
        const x = hooks[n - 1];
        E.lathe(K.fab, x, y0 + 0.08, 0.12, [[0.1, 0], [0.11, 0.04], [0.105, 0.16], [0.0, 0.17]], 9, mul(C(0x3a3430), k), { cap: true, kb: 0.7 });
      }
      return;
    }
    case 'shoes': {
      const pairs = 2 + (it.var % 2);
      for (let p = 0; p < pairs; p++) {
        const col = mul(C([0x2a1e18, 0x5a3a24, 0x3a2a22, 0x7a2a2a][(p + it.var) % 4]), k), x0 = -w / 2 + 0.12 + p * (w - 0.24) / Math.max(1, pairs - 1);
        for (const sg of [-1, 1]) {
          const J = E.sub(x0 + sg * 0.05, 0, 0.14 + (rng() - 0.5) * 0.04, (rng() - 0.5) * 0.4);
          J.box(K.fab, 0, 0.012, 0, 0.09, 0.024, 0.26, mul(col, 0.6), { us: 1.2, skip: 8 });
          J.cbox(K.fab, 0, 0.05, -0.02, 0.085, 0.06, 0.2, 0.025, col, { us: 1.2, skip: 8 });
        }
      }
      return;
    }
    case 'papers': {
      for (let i = 0; i < 7; i++) {
        const a = rng() * 2 * PI, r = rng() * 0.4, x = Math.cos(a) * r, z = Math.sin(a) * r, ry = rng() * PI, pw = 0.21, pd = 0.29;
        const cs = Math.cos(ry), sn = Math.sin(ry), pts = [[-pw / 2, -pd / 2], [pw / 2, -pd / 2], [pw / 2, pd / 2], [-pw / 2, pd / 2]].map(([u, v]) => [x + u * cs - v * sn, z + u * sn + v * cs]);
        E.floorQuad(K.plaster, pts, 0.01 + i * 0.0015, mul(C(rng() < 0.7 ? 0xeee8d8 : 0xd8ccaa), k * 1.1), { us: 3.2 });
      }
      return;
    }
    case 'shards': {
      for (let i = 0; i < 9; i++) {
        const a = rng() * 2 * PI, r = 0.05 + rng() * 0.25, x = Math.cos(a) * r, z = Math.sin(a) * r, s = 0.03 + rng() * 0.05, t = rng() * 2 * PI;
        const pts = [0, 2.1, 4.2, 4.2].map((q, j) => [x + Math.cos(t + q) * s * (j === 3 ? 0.4 : 1), z + Math.sin(t + q) * s * (j === 3 ? 0.4 : 1)]);
        E.floorQuad(K.ena, pts, 0.013, mul(C(i % 3 ? 0xf2f0ea : 0x6a8ab8), k * 1.1), {});
      }
      return;
    }
  }
}

function chair(E, K, c) {
  const rng = c.rng, k = c.k, col = pick(rng, VEN), up = rng() < 0.4;
  if (up) E.cbox(K.fab, 0, 0.47, 0.01, 0.42, 0.05, 0.4, 0.015, mul(pick(rng, UPH), k), { us: 1.2 });
  else E.cbox(K.ven, 0, 0.455, 0, 0.42, 0.03, 0.42, 0.008, col, { k, us: 0.9 });
  for (const sx of [-1, 1]) {
    E.box(K.ven, sx * 0.18, 0.22, 0.18, 0.034, 0.44, 0.034, mul(col, 0.85), { k, skip: 4, kb: 0.7, us: 0.9, rx: 0.03 });
    E.box(K.ven, sx * 0.18, 0.46, -0.19, 0.034, 0.92, 0.034, mul(col, 0.85), { k, kb: 0.7, us: 0.9, rx: -0.06 });
  }
  E.box(K.ven, 0, 0.84, -0.215, 0.4, 0.1, 0.022, col, { k, us: 0.9, rx: -0.06 });
  E.box(K.ven, 0, 0.66, -0.205, 0.36, 0.04, 0.018, col, { k, us: 0.9, rx: -0.06 });
  for (const sz of [-1, 1]) E.box(K.ven, 0, 0.14, sz * 0.18, 0.33, 0.02, 0.02, mul(col, 0.8), { k, us: 0.9 });
}

function table(E, K, it, c) {
  const rng = c.rng, k = c.k, w = it.w, d = it.d, h = it.h, room = c.room, col = pick(rng, VEN), coffee = it.kind === 'coffee';
  E.cbox(K.ven, 0, h - 0.018, 0, w, 0.036, d, 0.01, col, { k, us: 0.9 });
  legs4(E, K.ven, w, d, h - 0.036, coffee ? 0.04 : 0.05, mul(col, 0.85), 0.07, c, coffee ? 0.08 : 0);
  for (const sz of [-1, 1]) E.box(K.ven, 0, h - 0.08, sz * (d / 2 - 0.07), w - 0.2, 0.08, 0.02, mul(col, 0.8), { k, skip: 4, us: 0.9 });
  for (const sx of [-1, 1]) E.box(K.ven, sx * (w / 2 - 0.07), h - 0.08, 0, 0.02, 0.08, d - 0.2, mul(col, 0.8), { k, skip: 4, us: 0.9 });
  if (coffee) E.box(K.ven, 0, 0.12, 0, w - 0.16, 0.02, d - 0.16, mul(col, 0.9), { k, us: 0.9 });
  // the cloth: oilcloth in the kitchen, a tablecloth with a drop in the living room
  const kitchen = room === 'kitchen' || it.kind === 'ktable', top = h + 0.004;
  if (kitchen || (room === 'living' && rng() < 0.75) || room === 'bedroom') {
    const cl = mul(C(kitchen ? [0xd8e4e8, 0xe8dcc0, 0xc8d8c0, 0xe8e0e0][Math.floor(rng() * 4)] : [0xf0ece0, 0x8a2a2a, 0xe8e0c8, 0x4a5a3a][Math.floor(rng() * 4)]), k * 1.05);
    const drop = kitchen ? 0.08 : 0.24, g = kitchen ? K.ena : K.fab;
    E.box(g, 0, top, 0, w + 0.06, 0.006, d + 0.06, cl, { skip: 8, us: 1.2 });
    for (const sz of [-1, 1]) E.box(g, 0, top - drop / 2, sz * (d / 2 + 0.03), w + 0.06, drop, 0.005, cl, { us: 1.2, kb: 0.85 });
    for (const sx of [-1, 1]) E.box(g, sx * (w / 2 + 0.03), top - drop / 2, 0, 0.005, drop, d + 0.06, cl, { us: 1.2, kb: 0.85 });
  }
  const yT = top + 0.004;
  if (it.radio) {
    // a field set: case, dials, a lit pilot lamp, the whip, a handset
    E.cbox(K.paint, -0.25, yT + 0.13, -0.1, 0.42, 0.26, 0.26, 0.012, mul(C(0x4e5638), k), { us: 1.6 });
    E.box(K.dark, -0.25, yT + 0.15, 0.031, 0.32, 0.12, 0.004, [0.02, 0.02, 0.02], {});
    for (let i = 0; i < 3; i++) E.lathe(K.metal, -0.36 + i * 0.1, yT + 0.06, 0.03, [[0.016, 0], [0.016, 0.02]], 7, mul(C(0x2a2a28), k), { rx: PI / 2, cap: true });
    E.box(K.glow, -0.1, yT + 0.21, 0.032, 0.02, 0.02, 0.004, C(0x57ff7a), {});
    E.box(K.metal, -0.42, yT + 0.6, -0.16, 0.012, 0.7, 0.012, mul(C(0x3a3a36), k), {});
    E.cbox(K.paint, 0.25, yT + 0.03, 0.08, 0.2, 0.06, 0.08, 0.02, mul(C(0x2a2a28), k), {});
    E.box(K.plaster, 0.3, yT + 0.002, -0.12, 0.21, 0.004, 0.29, mul(C(0xe8e2d0), k), { skip: 8, us: 3.2, ry: 0.2 });
    return;
  }
  // the middle stays clear: the lamp and the loot spot are there
  const ends = [-1, 1];
  if (rng() < 0.5) ends.reverse();
  const xe = (sg, m) => sg * Math.max(0.32, w / 2 - m);
  if (kitchen) {
    if (w > 0.9 && rng() < 0.75) {
      samovar(E.sub(0, yT, 0), K, xe(ends[0], 0.2), -0.05, c, rng);
      // the tray of tea glasses
      const tx = xe(ends[1], 0.25), tz = 0.02;
      E.lathe(K.metal, tx, yT, tz, [[0.16, 0], [0.17, 0.012], [0.172, 0.018]], 10, mul(C(rng() < 0.5 ? BRASS : NICKEL), k * 1.1), { cap: true, sz: 0.7 });
      const n = 3 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) glassCup(E, K, tx - 0.08 + (i % 2) * 0.12 + (i > 1 ? 0.03 : 0), yT + 0.014, tz - 0.05 + Math.floor(i / 2) * 0.09, c, rng() < 0.7);
      E.lathe(K.ena, tx + 0.11, yT + 0.014, tz + 0.05, [[0.03, 0], [0.04, 0.04], [0.035, 0.05]], 8, mul(pick(rng, CHINA), k * 1.1), { cap: true });
    } else {
      const bx = xe(ends[0], 0.25);
      E.cbox(K.ven, bx, yT + 0.01, 0, 0.36, 0.02, 0.24, 0.005, mul(C(0xd8b888), 1), { k, us: 0.9 });
      E.lathe(K.fab, bx, yT + 0.02, 0, [[0.11, 0], [0.12, 0.02], [0.1, 0.05], [0.0, 0.06]], 9, mul(C(0xc89a5a), k), { cap: true, sz: 0.8 });
      E.lathe(K.ena, xe(ends[1], 0.2), yT, 0.05, [[0.1, 0], [0.12, 0.05], [0.13, 0.06]], 9, mul(pick(rng, CHINA), k * 1.1), { cap: true });
    }
  } else if (room === 'living' || room === 'bedroom' || coffee) {
    const x = coffee ? 0 : xe(ends[0], 0.22);
    if (rng() < 0.5) {
      E.lathe(K.ena, x, yT, 0, [[0.04, 0], [0.07, 0.08], [0.05, 0.18], [0.03, 0.22], [0.04, 0.25]], 8, mul(C(rng() < 0.5 ? 0x3a5a8a : 0xe8e4dc), k * 1.1), { cap: true });
      for (let i = 0; i < 5; i++) { const a = i * 1.26; E.cbox(K.fab, x + Math.cos(a) * 0.05, yT + 0.3 + (i % 2) * 0.04, Math.sin(a) * 0.05, 0.05, 0.04, 0.05, 0.02, mul(C(i % 2 ? 0xb8202a : 0xe0a040), k), {}); }
    } else {
      E.lathe(K.ena, x, yT, 0, [[0.05, 0], [0.13, 0.05], [0.14, 0.06]], 9, mul(pick(rng, CHINA), k * 1.1), { cap: true });
      for (let i = 0; i < 4; i++) E.lathe(K.ena, x + Math.cos(i * 1.6) * 0.06, yT + 0.05, Math.sin(i * 1.6) * 0.06, [[0.0, 0], [0.04, 0.02], [0.042, 0.04], [0.03, 0.065], [0.0, 0.07]], 7, mul(C(i % 3 ? 0x8e1e1c : 0xc8a030), k), {});
    }
  } else if (room === 'guard' || room === 'post') {
    E.box(K.plaster, xe(ends[0], 0.3), yT + 0.002, 0, 0.5, 0.004, 0.38, mul(C(0xd8d0b0), k), { skip: 8, us: 3.2, ry: rng() - 0.5 });
    E.cbox(K.paint, xe(ends[1], 0.2), yT + 0.09, 0, 0.3, 0.18, 0.15, 0.01, mul(C(0x4a5236), k), { ry: rng() - 0.5 });
  }
}

function bed(E, K, it, c) {
  const rng = c.rng, k = c.k, w = it.w, d = it.d, col = pick(rng, VEN), hd = it.head || -1;
  // frame, legs, head- and footboard
  for (const sz of [-1, 1]) E.box(K.ven, 0, 0.3, sz * (d / 2 - 0.015), w - 0.08, 0.16, 0.03, col, { k, us: 0.9 });
  for (const sx of [-1, 1]) {
    const head = sx === hd, hh = head ? 1.02 : 0.72, x = sx * (w / 2 - 0.02);
    E.box(K.ven, x, hh / 2, 0, 0.04, hh, d, col, { k, kb: 0.7, us: 0.9 });
    E.box(K.ven, x, hh + 0.02, 0, 0.06, 0.04, d + 0.04, mul(col, 0.9), { k, us: 0.9, skip: 8 });
    E.box(K.ven, x - sx * 0.024, hh * 0.62, 0, 0.008, hh * 0.5, d - 0.16, mul(col, 1.08), { k, us: 0.9, skip: sx > 0 ? 1 : 2 });
  }
  // mattress, sheet, bedspread with a drop, pillow
  E.cbox(K.fab, 0, 0.45, 0, w - 0.1, 0.18, d - 0.05, 0.04, mul(C(0xd8d0bc), k), { us: 1.2, skip: 8 });
  const spread = mul(pick(rng, BEDSPREAD), k), neat = rng() < 0.55, linen = mul(pick(rng, LINEN), k * 1.1);
  if (neat) {
    E.cbox(K.fab, -hd * 0.12, 0.545, 0.0, w - 0.38, 0.03, d + 0.02, 0.012, spread, { us: 1.2 });
    E.box(K.fab, -hd * 0.12, 0.43, d / 2 + 0.008, w - 0.38, 0.22, 0.012, spread, { us: 1.2, kb: 0.8 });
    E.cbox(K.fab, hd * (w / 2 - 0.36), 0.55, 0, 0.16, 0.05, d - 0.04, 0.02, linen, { us: 1.2 });
  } else {
    for (let i = 0; i < 2; i++) E.cbox(K.fab, -hd * (0.12 + i * 0.3) + (rng() - 0.5) * 0.1, 0.56 + (i % 2) * 0.03, (rng() - 0.5) * 0.12, 0.7, 0.07, d * (0.7 + rng() * 0.25), 0.03, mul(spread, 0.9 + i * 0.08), { us: 1.2, ry: (rng() - 0.5) * 0.5, skip: 8 });
  }
  // the big square pillow, stood on its edge against the headboard, under lace
  const px = hd * (w / 2 - 0.16);
  E.cbox(K.fab, px, 0.78, 0, 0.14, 0.5, 0.56, 0.06, linen, { us: 1.2, rz: hd * 0.18 });
  if (rng() < 0.6) E.box(K.fab, px - hd * 0.075, 0.84, 0, 0.008, 0.38, 0.5, mul(C(0xf4f2ec), k * 1.15), { us: 0.4, rz: hd * 0.18 });
  legs4(E, K.ven, w - 0.04, d - 0.03, 0.22, 0.05, mul(col, 0.8), 0.03, c);
}

function wardrobe(E, K, it, c) {
  const rng = c.rng, k = c.k, w = it.w, d = it.d, h = it.h, col = pick(rng, VEN);
  carcass(E, K.ven, w, h - 0.1, d, 0.08, col, c);
  E.box(K.ven, 0, 0.04, -0.01, w - 0.04, 0.08, d - 0.04, mul(col, 0.65), { k, skip: 8 | 32, us: 0.9 });
  E.cbox(K.ven, 0, h - 0.01, 0.01, w + 0.05, 0.05, d + 0.04, 0.012, mul(col, 0.92), { k, us: 0.9 });
  const n = w > 1.3 ? 3 : 2, dw = w / n, mirror = rng() < 0.45 ? Math.floor(rng() * n) : -1;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + dw * (i + 0.5), side = i < n / 2 ? 1 : -1;
    front(E, K, x, 0.08 + (h - 0.18) / 2, dw, h - 0.18, d / 2, col, c, { panel: mirror !== i, hx: side * (dw / 2 - 0.05), brass: true });
    if (mirror === i) E.box(K.glass, x, 0.08 + (h - 0.18) * 0.55, d / 2 + 0.02, dw - 0.14, (h - 0.18) * 0.6, 0.004, [0.55, 0.6, 0.62], {});
  }
}

function glassCabinet(E, K, it, c, kitchen) {
  const rng = c.rng, k = c.k, w = it.w, d = it.d, h = it.h;
  const painted = kitchen && rng() < 0.6, col = painted ? pick(rng, PAINTED) : pick(rng, VEN), g = painted ? K.ena : K.ven;
  const lowH = kitchen ? 0.9 : 0.85, upY = kitchen ? 1.3 : lowH;
  carcass(E, g, w, lowH - 0.08, d, 0.08, col, c);
  E.box(g, 0, 0.04, -0.01, w - 0.04, 0.08, d - 0.04, mul(col, 0.65), { k, skip: 8 | 32, us: 0.9 });
  E.cbox(g, 0, lowH, 0.01, w + 0.02, 0.03, d + 0.02, 0.008, col, { k, us: 0.9 });
  for (const sg of [-1, 1]) front(E, K, sg * w / 4, 0.08 + (lowH - 0.2) / 2, w / 2, lowH - 0.2, d / 2, col, c, { g, hx: -sg * (w / 4 - 0.05) });
  front(E, K, 0, lowH - 0.07, w - 0.02, 0.1, d / 2, col, c, { g, panel: false, bar: 0.12 });
  // the glazed upper part: back, shelves of plates and glasses, glass doors in thin frames
  const ud = d * 0.7, z0 = -d / 2 + ud / 2, top = h;
  if (kitchen) for (const sg of [-1, 1]) E.box(g, sg * (w / 2 - 0.02), (lowH + upY) / 2, -d / 2 + 0.1, 0.04, upY - lowH, 0.2, col, { k, us: 0.9 });
  E.box(g, 0, (upY + top) / 2, -d / 2 + 0.01, w - 0.04, top - upY, 0.02, mul(col, 0.9), { k, us: 0.9, skip: 32 });
  for (const sg of [-1, 1]) E.box(g, sg * (w / 2 - 0.015), (upY + top) / 2, z0, 0.03, top - upY, ud, col, { k, us: 0.9 });
  E.cbox(g, 0, top, z0 + 0.01, w + 0.04, 0.05, ud + 0.04, 0.012, col, { k, us: 0.9 });
  const nS = 3, sh = (top - upY - 0.05) / nS;
  for (let s = 0; s < nS; s++) {
    const y = upY + s * sh;
    E.box(g, 0, y + 0.01, z0, w - 0.04, 0.02, ud - 0.02, col, { k, us: 0.9 });
    if (s === nS - 1 && !kitchen) { for (let x = -w / 2 + 0.12; x < w / 2 - 0.1; x += 0.13) E.lathe(K.cglass, x, y + 0.02, z0 + 0.02, [[0.025, 0], [0.006, 0.02], [0.006, 0.07], [0.032, 0.13]], 5, [0.8, 0.82, 0.85], {}); continue; }
    const china = pick(rng, CHINA), np = Math.max(2, Math.floor((w - 0.1) / 0.24));
    for (let i = 0; i < np; i++) plateStand(E, K, -w / 2 + 0.1 + (w - 0.2) * (i + 0.5) / np, y + 0.02, z0 - ud / 2 + 0.06, 0.1, china, c);
    if (s === 0) for (let i = 0; i < 3; i++) { const x = -w / 2 + 0.15 + i * (w - 0.3) / 2; E.lathe(K.ena, x, y + 0.02, z0 + ud / 2 - 0.08, [[0.03, 0], [0.045, 0.06]], 7, china, { k: k * 1.1, cap: true }); }
  }
  for (const sg of [-1, 1]) {
    const x = sg * w / 4, y = (upY + top - 0.03) / 2, dh = top - upY - 0.05, dw = w / 2 - 0.02, zf = z0 + ud / 2;
    E.box(K.cglass, x, y, zf + 0.005, dw - 0.05, dh - 0.05, 0.004, [0.62, 0.66, 0.7], {});
    for (const yy of [y - dh / 2 + 0.015, y + dh / 2 - 0.015]) E.box(g, x, yy, zf + 0.01, dw, 0.03, 0.02, col, { k, us: 0.9 });
    for (const xx of [x - dw / 2 + 0.015, x + dw / 2 - 0.015]) E.box(g, xx, y, zf + 0.01, 0.03, dh - 0.06, 0.02, col, { k, us: 0.9, skip: 4 | 8 });
    E.box(K.metal, x - sg * (dw / 2 - 0.05), y, zf + 0.03, 0.012, 0.06, 0.012, mul(C(BRASS), k), {});
  }
}

function shelf(E, K, it, c) {
  const rng = c.rng, k = c.k, w = it.w, d = it.d, h = it.h, room = c.room;
  const painted = room === 'kitchen' || room === 'store', col = painted ? pick(rng, PAINTED) : pick(rng, VEN), g = painted ? K.ena : K.ven;
  for (const sx of [-1, 1]) E.box(g, sx * (w / 2 - 0.015), h / 2, 0, 0.03, h, d, col, { k, kb: 0.75, us: 0.9 });
  E.box(g, 0, h / 2, -d / 2 + 0.008, w - 0.06, h, 0.016, mul(col, 0.85), { k, us: 0.9, skip: 32 });
  const n = 5;
  for (let s = 0; s < n; s++) {
    const y = 0.06 + s * (h - 0.08) / (n - 1);
    E.box(g, 0, y, 0, w - 0.06, 0.022, d, col, { k, us: 0.9 });
    if (s === n - 1) break;
    const yT = y + 0.011, x0 = -w / 2 + 0.05, x1 = w / 2 - 0.05;
    if (room === 'kitchen') {
      // plates stood up, a stack of bowls, jars, a pot
      const kind = (s + Math.floor(rng() * 2)) % 3;
      if (kind === 0) { const china = pick(rng, CHINA); for (let x = x0 + 0.1; x < x1 - 0.08; x += 0.22) plateStand(E, K, x, yT, -d / 2 + 0.06, 0.1, china, c); }
      else if (kind === 1) { let x = x0 + 0.05; while (x < x1 - 0.06) { const r = 0.035 + rng() * 0.015, hj = 0.1 + rng() * 0.07; jar(E, K, x + r, yT, 0, r, hj, rng, c); x += 2 * r + 0.03; } }
      else { E.lathe(K.metal, x0 + 0.15, yT, 0, [[0.11, 0], [0.12, 0.015], [0.12, 0.14], [0.125, 0.15]], 10, mul(C(0xb8bcc0), k), { capB: true }); for (let i = 0; i < 4; i++) E.lathe(K.ena, x1 - 0.14, yT + i * 0.035, 0, [[0.05, 0], [0.08, 0.03], [0.085, 0.035]], 9, mul(C(0xf2eee6), k * 1.1), { cap: true }); }
    } else if (room === 'store') {
      let x = x0;
      while (x < x1 - 0.08) { if (rng() < 0.65) { const r = 0.045 + rng() * 0.02; jar(E, K, x + r, yT, 0, r, 0.12 + rng() * 0.1, rng, c); x += 2 * r + 0.02; } else { const bw = 0.12 + rng() * 0.15; E.cbox(K.paint, x + bw / 2, yT + 0.08, 0, bw, 0.16, d * 0.7, 0.008, mul(C(0x8a7a5a), k), {}); x += bw + 0.03; } }
    } else books(E, K, x0, x1, yT, d, rng, c);
  }
}

function sinkRun(E, K, it, c) {
  const rng = c.rng, k = c.k, w = it.w, d = it.d, h = it.h, col = c.unit || pick(rng, PAINTED), g = c.unitG || K.ena;
  carcass(E, g, w, h - 0.12, d - 0.04, 0.1, col, c);
  E.box(g, 0, 0.05, -0.02, w - 0.04, 0.1, d - 0.08, mul(col, 0.55), { k, skip: 8 | 32, us: 0.9 });
  const top = mul(C(rng() < 0.5 ? 0xb8b4aa : 0xd8d0c0), k);
  E.cbox(K.ena, 0, h - 0.015, 0.01, w + 0.02, 0.03, d + 0.01, 0.006, top, { us: 0.9 });
  const n = w > 1.0 ? 3 : 2, dw = w / n, sinkAt = rng() < 0.5 ? 0 : n - 1;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + dw * (i + 0.5);
    front(E, K, x, h - 0.1, dw, 0.12, d / 2 - 0.02, col, c, { g, panel: false, bar: 0.1 });
    front(E, K, x, 0.1 + (h - 0.32) / 2, dw, h - 0.32, d / 2 - 0.02, col, c, { g, hx: (i % 2 ? -1 : 1) * (dw / 2 - 0.05), hy: (h - 0.32) * 0.3 });
  }
  // the enamel sink let into the top, a tap on the wall
  const sx = -w / 2 + dw * (sinkAt + 0.5), sw = Math.min(0.52, dw - 0.06);
  E.box(K.ena, sx, h + 0.008, 0.02, sw, 0.016, d - 0.14, mul(C(0xf0eee6), k * 1.1), { skip: 8 });
  E.box(K.dark, sx, h + 0.0165, 0.02, sw - 0.06, 0.002, d - 0.2, [0.12, 0.12, 0.12], {});
  const chrome = mul(C(NICKEL), k * 1.2);
  E.box(K.metal, sx, h + 0.14, -d / 2 + 0.05, 0.03, 0.26, 0.03, chrome, {});
  E.box(K.metal, sx, h + 0.26, -d / 2 + 0.12, 0.025, 0.025, 0.16, chrome, {});
  for (const sg of [-1, 1]) E.box(K.metal, sx + sg * 0.07, h + 0.2, -d / 2 + 0.06, 0.04, 0.025, 0.04, chrome, {});
  // tiles behind it (not where it stands under a window)
  if (!c.behind) {
    E.box(K.ena, 0, h + 0.3, -d / 2 + 0.004, w, 0.56, 0.008, mul(C(0xe8eef0), k), { skip: 32 });
    for (let i = 1; i < 4; i++) E.box(K.dark, 0, h + 0.02 + i * 0.14, -d / 2 + 0.0085, w, 0.004, 0.002, [0.35, 0.36, 0.36], {});
  }
  // a kettle or a dish rack
  if (rng() < 0.5) E.lathe(K.ena, sx + (sinkAt === 0 ? 1 : -1) * dw * 0.9, h + 0.03, 0.02, [[0.08, 0], [0.1, 0.06], [0.09, 0.15], [0.05, 0.18], [0.02, 0.2]], 9, mul(C([0x2a5a9a, 0xb83a2a, 0xe8e4d8, 0x3a7a5a][Math.floor(rng() * 4)]), k * 1.1), { cap: true });
}

function sideboard(E, K, it, c) {
  const rng = c.rng, k = c.k, w = it.w, d = it.d, h = it.h, col = pick(rng, VEN);
  carcass(E, K.ven, w, h - 0.16, d, 0.14, col, c);
  E.cbox(K.ven, 0, h - 0.012, 0.01, w + 0.03, 0.025, d + 0.02, 0.008, col, { k, us: 0.9 });
  legs4(E, K.ven, w - 0.06, d - 0.06, 0.14, 0.04, mul(col, 0.8), 0.04, c, 0.06);
  const n = w > 1.25 ? 3 : 2, dw = w / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + dw * (i + 0.5);
    front(E, K, x, h - 0.1, dw, 0.12, d / 2, col, c, { panel: false, bar: 0.1, brass: true });
    front(E, K, x, 0.14 + (h - 0.32) / 2, dw, h - 0.32, d / 2, col, c, { hx: (i % 2 ? -1 : 1) * (dw / 2 - 0.05), brass: true, glass: c.room === 'living' && i === 1 && n === 3 });
  }
  E.box(K.fab, 0, h + 0.002, 0.02, w * 0.55, 0.004, d * 0.7, mul(C(0xf4f0e6), k * 1.2), { skip: 8, us: 0.4 });
  if (!it.lamp && rng() < 0.7) E.lathe(K.ena, w * 0.3, h, 0, [[0.04, 0], [0.07, 0.1], [0.05, 0.2], [0.03, 0.24], [0.045, 0.27]], 8, mul(C(rng() < 0.5 ? 0x3a5a8a : 0xe8e4dc), k * 1.1), { cap: true });
}

function sofa(E, K, it, c) {
  const rng = c.rng, k = c.k, w = it.w, d = it.d, arm = it.kind === 'armchair', col = mul(pick(rng, UPH), k), wood = pick(rng, VEN);
  legs4(E, K.ven, w - 0.08, d - 0.12, 0.1, 0.045, mul(wood, 0.8), 0.04, c, 0.08);
  E.cbox(K.fab, 0, 0.21, 0.02, w - 0.04, 0.22, d - 0.08, 0.03, mul(col, 0.85), { us: 1.2, kb: 0.7 });
  const n = arm ? 1 : 2, aw = 0.16, sw = (w - 2 * aw) / n;
  for (let i = 0; i < n; i++) E.cbox(K.fab, -w / 2 + aw + sw * (i + 0.5), 0.37, 0.07, sw - 0.01, 0.13, d - 0.24, 0.045, col, { us: 1.2 });
  E.cbox(K.fab, 0, 0.6, -d / 2 + 0.13, w - 0.06, 0.5, 0.2, 0.06, col, { us: 1.2, rx: -0.12 });
  for (const sg of [-1, 1]) {
    E.cbox(K.fab, sg * (w / 2 - aw / 2), 0.42, 0.0, aw, 0.36, d - 0.1, 0.05, mul(col, 0.95), { us: 1.2 });
    E.cbox(K.ven, sg * (w / 2 - aw / 2), 0.615, 0.02, aw + 0.02, 0.03, d - 0.12, 0.01, wood, { k, us: 0.9 });
  }
  if (!arm && rng() < 0.7) for (let i = 0; i < 1 + Math.floor(rng() * 2); i++) {
    const x = (i ? 1 : -1) * (w / 2 - aw - 0.22);
    E.cbox(K.fab, x, 0.56, -d / 2 + 0.3, 0.38, 0.36, 0.12, 0.06, mul(pick(rng, BEDSPREAD), k), { us: 1.2, rx: -0.3, rz: (rng() - 0.5) * 0.3 });
  }
}

function ironStove(E, K, it, c) {
  const k = c.k, w = it.w, d = it.d, iron = C(0x2e2e2c), dull = mul(iron, 1.25);
  E.cbox(K.paint, 0, 0.5, 0, w, 0.7, d, 0.02, iron, { us: 1.6, k: 0.9 });
  E.cbox(K.paint, 0, 0.87, 0, w + 0.06, 0.04, d + 0.06, 0.01, dull, { us: 1.6 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) E.box(K.paint, sx * (w / 2 - 0.05), 0.075, sz * (d / 2 - 0.05), 0.06, 0.15, 0.06, iron, { skip: 4 });
  E.box(K.paint, 0, 0.48, d / 2 + 0.01, 0.32, 0.24, 0.02, dull, {});
  E.box(K.glow, 0, 0.47, d / 2 + 0.022, 0.24, 0.025, 0.004, C(0xff8a30), {});
  E.box(K.glow, 0, 0.43, d / 2 + 0.022, 0.2, 0.02, 0.004, C(0xffb050), {});
  E.box(K.paint, 0, 0.24, d / 2 + 0.01, 0.26, 0.1, 0.02, dull, {});
  E.box(K.metal, 0.12, 0.5, d / 2 + 0.03, 0.04, 0.02, 0.02, mul(C(BRASS), k), {});
  for (const sx of [-0.14, 0.14]) E.lathe(K.paint, sx, 0.89, 0.04, [[0.09, 0], [0.09, 0.006]], 10, mul(iron, 1.4), { cap: true });
  // flue to the ceiling, a kettle on the plate
  const ceil = c.ceil;
  E.lathe(K.paint, 0, 0.89, -d / 2 + 0.12, [[0.08, 0], [0.065, 0.06], [0.065, ceil - 0.89]], 8, mul(iron, 1.1), {});
  E.lathe(K.ena, 0.14, 0.896, 0.04, [[0.07, 0], [0.09, 0.05], [0.085, 0.13], [0.04, 0.16], [0.03, 0.18]], 9, mul(C(0x2a4a7a), k), { cap: true });
}

function cooker(E, K, it, c) {
  const rng = c.rng, k = c.k, w = it.w, d = it.d, col = mul(pick(rng, ENAMEL), k), h = 0.86;
  E.cbox(K.ena, 0, h / 2, 0, w, h, d, 0.015, col, { kb: 0.8, skip: 32 });
  E.box(K.ena, 0, h + 0.002, 0, w - 0.04, 0.004, d - 0.04, mul(col, 0.35), { skip: 8 });
  for (const [x, z] of [[-0.14, -0.13], [0.14, -0.13], [-0.14, 0.12], [0.14, 0.12]]) {
    E.lathe(K.ena, x, h + 0.004, z, [[0.07, 0], [0.065, 0.012], [0.045, 0.016]], 9, [0.03, 0.03, 0.03], { cap: true });
    E.box(K.metal, x, h + 0.022, z, 0.16, 0.008, 0.012, [0.04, 0.04, 0.04], {});
    E.box(K.metal, x, h + 0.022, z, 0.012, 0.008, 0.16, [0.04, 0.04, 0.04], {});
  }
  E.cbox(K.ena, 0, h + 0.16, -d / 2 + 0.02, w, 0.32, 0.03, 0.01, col, {});
  E.box(K.ena, 0, h - 0.07, d / 2 + 0.004, w - 0.04, 0.09, 0.008, mul(col, 0.9), {});
  for (let i = 0; i < 4; i++) E.lathe(K.ena, -0.2 + i * 0.133, h - 0.07, d / 2 + 0.008, [[0.022, 0], [0.02, 0.025]], 8, [0.05, 0.05, 0.05], { rx: PI / 2, cap: true });
  E.box(K.ena, 0, 0.42, d / 2 + 0.008, w - 0.06, 0.52, 0.016, col, {});
  E.box(K.glass, 0, 0.45, d / 2 + 0.017, w - 0.22, 0.24, 0.004, [0.08, 0.08, 0.09], {});
  E.box(K.metal, 0, 0.71, d / 2 + 0.045, w - 0.14, 0.02, 0.02, mul(C(NICKEL), k * 1.2), {});
  E.box(K.dark, 0, 0.06, d / 2 - 0.02, w - 0.04, 0.1, 0.02, [0.04, 0.04, 0.04], {});
  if (rng() < 0.7) E.lathe(K.ena, 0.14, h + 0.03, 0.12, [[0.08, 0], [0.1, 0.06], [0.09, 0.15], [0.05, 0.18], [0.02, 0.2]], 9, mul(C([0x2a5a9a, 0xb83a2a, 0xe8e4d8, 0x3a7a5a][Math.floor(rng() * 4)]), k * 1.1), { cap: true });
  if (rng() < 0.5) E.lathe(K.metal, -0.14, h + 0.03, -0.13, [[0.11, 0], [0.12, 0.015], [0.12, 0.12], [0.125, 0.13]], 10, mul(C(0xb8bcc0), k), { capB: true });
}

function tvSet(E, K, it, c) {
  const rng = c.rng, k = c.k, w = it.w, d = it.d, col = pick(rng, VEN), sh = 0.5;
  // the stand: a low cabinet on splayed legs with a shelf
  E.cbox(K.ven, 0, sh - 0.015, 0, w, 0.03, d, 0.006, col, { k, us: 0.9 });
  E.box(K.ven, 0, sh - 0.2, 0, w - 0.04, 0.25, d - 0.04, col, { k, skip: 8 | 32, us: 0.9 });
  for (const sg of [-1, 1]) front(E, K, sg * w / 4, sh - 0.2, w / 2 - 0.02, 0.24, d / 2 - 0.02, col, c, { hx: -sg * 0.12, brass: true });
  legs4(E, K.ven, w - 0.06, d - 0.06, sh - 0.33, 0.035, mul(col, 0.8), 0.04, c, 0.1);
  // the set: wooden case, the bulging tube, a strip of knobs, the rabbit ears, lace on top
  const tw = Math.min(0.62, w - 0.1), th = 0.46, td = 0.42, case_ = rng() < 0.5 ? col : C(0x3a3634);
  E.cbox(K.ven, 0, sh + th / 2, 0.0, tw, th, td, 0.025, case_, { k, us: 0.9 });
  E.box(K.ven, 0, sh + th / 2, -td / 2 - 0.07, tw * 0.6, th * 0.65, 0.14, mul(case_, 0.8), { k, skip: 16, us: 0.9 });
  E.cbox(K.glass, -0.05, sh + th / 2 + 0.01, td / 2 + 0.004, tw * 0.68, th * 0.68, 0.02, 0.03, [0.03, 0.035, 0.035], {});
  E.box(K.dark, tw / 2 - 0.07, sh + th / 2, td / 2 + 0.003, 0.09, th * 0.7, 0.006, [0.05, 0.05, 0.05], {});
  for (let i = 0; i < 3; i++) E.lathe(K.metal, tw / 2 - 0.07, sh + th * 0.7 - i * 0.08, td / 2 + 0.006, [[0.016, 0], [0.014, 0.018]], 7, mul(C(NICKEL), k), { rx: PI / 2, cap: true });
  E.box(K.fab, 0, sh + th + 0.003, 0.02, tw * 0.7, 0.004, td * 0.6, mul(C(0xf4f0e6), k * 1.2), { skip: 8, us: 0.4 });
  for (const sg of [-1, 1]) E.box(K.metal, sg * 0.1, sh + th + 0.22, -0.06, 0.008, 0.48, 0.008, mul(C(NICKEL), k), { rz: -sg * 0.45 });
  E.lathe(K.metal, 0, sh + th, -0.06, [[0.05, 0], [0.04, 0.03]], 8, [0.05, 0.05, 0.05], { cap: true });
}

function plant(E, K, c) {
  const rng = c.rng, k = c.k;
  // a rubber plant in a clay pot on a little stool
  E.lathe(K.ena, 0, 0, 0, [[0.12, 0], [0.155, 0.3], [0.17, 0.31], [0.17, 0.34]], 8, mul(C(0xa85a3a), k), { kb: 0.7 });
  E.lathe(K.ena, 0, 0.32, 0, [[0.165, 0], [0.0, 0.005]], 8, mul(C(0x2a2018), k), {});
  E.box(K.ven, 0.01, 0.65, 0, 0.022, 0.7, 0.022, mul(C(0x6a5a3a), k), { rz: 0.04 });
  const leaf = mul(C(0x2e5a2a), k);
  for (let i = 0; i < 12; i++) {
    const y = 0.42 + i * 0.058, a = i * 2.4, L2 = 0.18 + (i < 9 ? 0.04 : -0.04);
    E.box(K.ena, Math.cos(a) * L2 * 0.5, y, Math.sin(a) * L2 * 0.5, L2, 0.008, 0.085, mul(leaf, 0.85 + rng() * 0.3), { ry: -a, rz: 0.35 + rng() * 0.3 });
  }
}
