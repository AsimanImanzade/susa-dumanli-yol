/**
 * fortress.js — the Şuşa fortress pieces the level kit does not have: round
 * bastion towers and an arched gatehouse between two flanking towers (modelled on
 * the old city gate), plus a curtain-wall helper that strings Level.rampart()
 * segments between towers. Scenery only: visuals, no colliders.
 *
 * Everything is written into the level's static batches ('stone', 'concrete',
 * 'dark', 'wood', 'glow'), so a whole fortress adds no draw calls of its own.
 * Masonry follows structures.js buildRampart: limestone tint 0xc9c2b0, 2.6 m
 * per texture repeat, 0.86 m courses shaded alternately, the two lowest
 * courses darker, a string course under the battlements and merlons with a
 * thin cap.
 *
 * Local frame of a piece: +x right, +y up, +z out of the fortress (towards
 * the viewer); `rot` turns it about Y like the kit's other builders.
 */
import { C } from './structures.js';

const PI = Math.PI, TAU = PI * 2;
const STONE = 0xc9c2b0, TRIM = 0xd8d1bf, US = 2.6, COURSE = 0.86;
const mulC = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const POINTED = (t) => 1 - Math.pow(Math.abs(2 * t - 1), 1.45);

// ── frame: yaw + translation, applied to every vertex emitted next
let FX = 0, FZ = 0, FC = 1, FS = 0, FY = 0;
function frame(x, y, z, rot = 0) { FX = x; FY = y; FZ = z; FC = Math.cos(rot); FS = Math.sin(rot); }

function V(g, x, y, z, nx, ny, nz, c, k, u, v) {
  g.p.push(FX + x * FC + z * FS, FY + y, FZ - x * FS + z * FC);
  g.n.push(nx * FC + nz * FS, ny, -nx * FS + nz * FC);
  g.c.push(c[0] * k, c[1] * k, c[2] * k);
  g.t.push(u, v);
  return g.count++;
}
/** Quad a,b,c,d counter-clockwise seen from the front, normal n, per-corner shade ks, uvs [u0,v0..u3,v3]. */
function quad(g, a, b, c, d, n, col, ks, uv) {
  const i = g.count;
  V(g, a[0], a[1], a[2], n[0], n[1], n[2], col, ks[0], uv[0], uv[1]);
  V(g, b[0], b[1], b[2], n[0], n[1], n[2], col, ks[1], uv[2], uv[3]);
  V(g, c[0], c[1], c[2], n[0], n[1], n[2], col, ks[2], uv[4], uv[5]);
  V(g, d[0], d[1], d[2], n[0], n[1], n[2], col, ks[3], uv[6], uv[7]);
  g.i.push(i, i + 1, i + 2, i, i + 2, i + 3);
}
/** Front-facing (+z) rectangle in the plane z. */
function rectZ(g, x0, y0, x1, y1, z, col, k0, k1 = k0) {
  quad(g, [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [0, 0, 1], col, [k0, k0, k1, k1], [x0 / US, y0 / US, x1 / US, y0 / US, x1 / US, y1 / US, x0 / US, y1 / US]);
}
/** Axis-aligned box in the current frame; skip: faces to leave out ('+x','-x','+y','-y','+z','-z'). */
function box(g, cx, cy, cz, sx, sy, sz, col, k = 1, skip = '') {
  const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
  const uvXY = (a0, b0, a1, b1) => [a0 / US, b0 / US, a1 / US, b0 / US, a1 / US, b1 / US, a0 / US, b1 / US];
  if (!skip.includes('+z')) quad(g, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], col, [k, k, k, k], uvXY(x0, y0, x1, y1));
  if (!skip.includes('-z')) quad(g, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], col, [k * 0.8, k * 0.8, k * 0.8, k * 0.8], uvXY(x1, y0, x0, y1));
  if (!skip.includes('+x')) quad(g, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], col, [k * 0.92, k * 0.92, k * 0.92, k * 0.92], uvXY(z1, y0, z0, y1));
  if (!skip.includes('-x')) quad(g, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], col, [k * 0.86, k * 0.86, k * 0.86, k * 0.86], uvXY(z0, y0, z1, y1));
  if (!skip.includes('+y')) quad(g, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], col, [k * 1.04, k * 1.04, k * 1.04, k * 1.04], uvXY(x0, z1, x1, z0));
  if (!skip.includes('-y')) quad(g, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], col, [k * 0.6, k * 0.6, k * 0.6, k * 0.6], uvXY(x0, z0, x1, z1));
}

/**
 * Revolved band between heights ya..yb, radius ra at ya → rb at yb, over the
 * arc a0..a1 (0 = local +z, counter-clockwise seen from above). inward: the
 * inner face of a shell. Masonry courses come from the caller's shade(y).
 */
function band(g, ya, yb, ra, rb, col, shade, o = {}) {
  const a0 = o.a0 ?? 0, a1 = o.a1 ?? TAU, seg = o.seg || 20, dir = o.inward ? -1 : 1;
  const slope = (ra - rb) / Math.max(1e-3, yb - ya);
  const ka = shade(ya), kb = shade(yb);
  for (let s = 0; s < seg; s++) {
    const t0 = a0 + (a1 - a0) * (s / seg), t1 = a0 + (a1 - a0) * ((s + 1) / seg), tm = (t0 + t1) / 2;
    const s0 = Math.sin(t0), c0 = Math.cos(t0), s1 = Math.sin(t1), c1 = Math.cos(t1);
    const nl = Math.hypot(1, slope), n = [dir * Math.sin(tm) / nl, dir * slope / nl, dir * Math.cos(tm) / nl];
    const u0 = (t0 * (ra + rb)) / 2 / US, u1 = (t1 * (ra + rb)) / 2 / US;
    const P = (sn, cs, r, y) => [sn * r, y, cs * r];
    const A = P(s0, c0, ra, ya), B = P(s1, c1, ra, ya), Cc = P(s1, c1, rb, yb), D = P(s0, c0, rb, yb);
    const uv = [u0, ya / US, u1, ya / US, u1, yb / US, u0, yb / US];
    if (dir > 0) quad(g, A, B, Cc, D, n, col, [ka, ka, kb, kb], uv);
    else quad(g, B, A, D, Cc, n, col, [ka, ka, kb, kb], [uv[2], uv[3], uv[0], uv[1], uv[6], uv[7], uv[4], uv[5]]);
  }
}
/** Flat ring (or disc when r0 = 0) at height y, facing up or down. */
function ring(g, y, r0, r1, col, k, up = true, seg = 20, a0 = 0, a1 = TAU) {
  for (let s = 0; s < seg; s++) {
    const t0 = a0 + (a1 - a0) * (s / seg), t1 = a0 + (a1 - a0) * ((s + 1) / seg);
    const p = (t, r) => [Math.sin(t) * r, y, Math.cos(t) * r];
    const A = p(t0, r1), B = p(t1, r1), Cc = p(t1, r0), D = p(t0, r0);
    const uv = [A[0] / US, A[2] / US, B[0] / US, B[2] / US, Cc[0] / US, Cc[2] / US, D[0] / US, D[2] / US];
    if (up) quad(g, A, B, Cc, D, [0, 1, 0], col, [k, k, k, k], uv);
    else quad(g, B, A, D, Cc, [0, -1, 0], col, [k, k, k, k], [uv[2], uv[3], uv[0], uv[1], uv[6], uv[7], uv[4], uv[5]]);
  }
}

/**
 * Masonry shade by height: darker footing courses, alternate courses a touch
 * lighter or darker, a little lift towards the top (as on the rampart).
 */
const courseShade = (y0) => (y) => {
  const k = Math.floor((y - y0) / COURSE);
  return (0.78 + 0.18 * smooth(y0, y0 + 2, y)) * (k % 2 ? 0.96 : 1.02) * (k < 2 ? 0.9 : 1);
};
/** Shells in 0.86 m courses so the alternate shading reads as coursed stone. */
function coursedBand(g, ya, yb, ra, rb, col, y0, o) {
  const sh = courseShade(y0);
  for (let y = ya; y < yb - 1e-3; y += COURSE) {
    const y1 = Math.min(yb, y + COURSE), f0 = (y - ya) / (yb - ya), f1 = (y1 - ya) / (yb - ya);
    const k = sh(y + 0.01);
    band(g, y, y1, ra + (rb - ra) * f0, ra + (rb - ra) * f1, col, () => k, o);
  }
}

/** Merlons round a circle: n teeth on the parapet top, a thin cap on each. */
function merlonRing(g, y, r, col, n, depth = 0.7, a0 = 0, a1 = TAU) {
  const full = Math.abs(a1 - a0 - TAU) < 1e-6, cnt = full ? n : n + 1;
  for (let i = 0; i < cnt; i++) {
    const t = full ? a0 + (i / n) * TAU : a0 + ((a1 - a0) * i) / n, w = ((TAU * r) / (full ? n : n * TAU / (a1 - a0))) * 0.52;
    const save = [FX, FY, FZ, FC, FS];
    // a merlon is a box in a sub-frame turned to face out along t
    const wx = FX + (Math.sin(t) * r) * FC + (Math.cos(t) * r) * FS, wz = FZ - (Math.sin(t) * r) * FS + (Math.cos(t) * r) * FC;
    const rot = Math.atan2(FS, FC) + t;
    frame(wx, FY, wz, rot);
    const k = 0.94 + ((i * 37) % 11) / 100;
    box(g, 0, y + 0.35, 0, w, 0.7, depth, col, k, '-y');
    box(g, 0, y + 0.73, 0, w + 0.08, 0.06, depth + 0.08, mulC(col, 1.06), 1, '-y');
    [FX, FY, FZ, FC, FS] = save;
  }
}

/**
 * Round bastion tower. (x, z) centre, y0 ground level, o: { r, h, rot, seg,
 * slits (bool), back (draw the side away from the viewer, default true) }.
 * Battered footing, coursed shaft, string course, corbelled parapet with
 * merlons, arrow slits on the outer half.
 */
export function roundTower(L, x, z, y0, o = {}) {
  const r = o.r ?? 4.5, h = o.h ?? 11, seg = o.seg ?? 22, rot = o.rot ?? 0;
  const S = L._batch('stone'), D = L._batch('dark'), Cn = L._batch('concrete');
  const col = C(STONE), dk = mulC(col, 0.86), top = y0 + h;
  frame(x, 0, z, rot);
  const arc = o.back === false ? { a0: -PI * 0.62, a1: PI * 0.62 } : {};
  const segA = o.back === false ? Math.ceil(seg * 0.62) : seg;
  // battered footing, sunk into the slope
  band(S, y0 - 2.2, y0 + 2.4, r + 0.55, r, dk, (yy) => (yy < y0 ? 0.62 : 0.8), { seg: segA, ...arc });
  coursedBand(S, y0 + 2.4, top - 1.55, r, r, col, y0, { seg: segA, ...arc });
  // string course, then the shaft up to the corbels
  band(S, top - 1.55, top - 1.35, r + 0.14, r + 0.14, mulC(col, 1.06), () => 1, { seg: segA, ...arc });
  ring(S, top - 1.55, r, r + 0.14, mulC(col, 0.7), 1, false, segA, arc.a0, arc.a1);
  ring(S, top - 1.35, r, r + 0.14, mulC(col, 1.05), 1, true, segA, arc.a0, arc.a1);
  coursedBand(S, top - 1.35, top - 0.3, r, r, col, y0, { seg: segA, ...arc });
  // corbel table and parapet
  band(S, top - 0.3, top, r, r + 0.22, mulC(col, 0.92), (yy) => (yy < top - 0.2 ? 0.8 : 1), { seg: segA, ...arc });
  ring(S, top - 0.3, r, r + 0.22, mulC(col, 0.55), 1, false, segA, arc.a0, arc.a1);
  band(S, top, top + 1.0, r + 0.22, r + 0.22, col, () => 1, { seg: segA, ...arc });
  band(S, top, top + 1.0, r - 0.45, r - 0.45, mulC(col, 0.9), () => 0.85, { seg: segA, inward: true, ...arc });
  ring(S, top + 1.0, r - 0.45, r + 0.22, mulC(col, 1.04), 1, true, segA, arc.a0, arc.a1);
  ring(Cn, top + 0.02, 0, r - 0.45, C(0xa8a296), 1, true, segA, arc.a0, arc.a1);
  merlonRing(S, top + 1.0, r - 0.12, col, Math.max(8, Math.round((TAU * r) / 2.3)), 0.62, arc.a0 ?? 0, arc.a1 ?? TAU);
  // arrow slits: two tiers on the outer half
  if (o.slits !== false) {
    const n = Math.max(3, Math.round(r * 0.9));
    for (const [yy, off] of [[y0 + 3.6, 0], [y0 + 6.8, 0.5]]) {
      if (yy + 1.1 > top - 1.6) continue;
      for (let i = 0; i < n; i++) {
        const t = -PI * 0.5 + (PI * (i + 0.5 + off)) / n;
        if (t > PI * 0.5) continue;
        const sx = Math.sin(t), cz = Math.cos(t), rr = r + 0.015, w = 0.08;
        const a = [sx * rr - cz * w, yy, cz * rr + sx * w], b = [sx * rr + cz * w, yy, cz * rr - sx * w];
        quad(D, a, b, [b[0], yy + 1.05, b[2]], [a[0], yy + 1.05, a[2]], [sx, 0, cz], C(0x1a1a1a), [1, 1, 1, 1], [0, 0, 1, 0, 1, 1, 0, 1]);
      }
    }
  }
}

/**
 * Gatehouse modelled on the old city gate: a pointed-arch gateway with wooden leaves in
 * a deep recess, a lighter arch ring and panel above, battlements, between two
 * round flanking towers. (x, z) is the centre of the gate face; rot turns it
 * (0 = gate faces +z). o: { w (block width, tower centre to centre), h, towerR, towerH, lamps }
 */
export function gatehouse(L, x, z, y0, rot = 0, o = {}) {
  const W = o.w ?? 12.4, H = o.h ?? 9.6, DEP = 7, tr = o.towerR ?? 4.3, th = o.towerH ?? 12.2;
  const S = L._batch('stone'), Dk = L._batch('dark'), Wd = L._batch('wood'), Cn = L._batch('concrete'), Gl = L._batch('glow');
  const col = C(STONE), trim = C(TRIM), sh = courseShade(y0), top = y0 + H;
  // flanking towers first (they reset the frame)
  const c = Math.cos(rot), s = Math.sin(rot);
  for (const sx of [-1, 1]) {
    const lx = sx * (W / 2), lz = -0.6;
    roundTower(L, x + lx * c + lz * s, z - lx * s + lz * c, y0, { r: tr, h: th, rot, seg: 24 });
  }
  frame(x, 0, z, rot);
  const aw = 4.2, ys = y0 + 4.5, rise = 2.2, recess = 1.5;
  const archTop = (u) => (Math.abs(u) >= aw / 2 ? -1e9 : ys + rise * POINTED((u + aw / 2) / aw));
  // ── face, coursed, with the arch cut out (columns across the arch so its curve stays smooth)
  const cols = [-W / 2, -aw / 2 - 0.0001];
  const NA = 14;
  for (let i = 0; i <= NA; i++) cols.push(-aw / 2 + (aw * i) / NA);
  cols.push(aw / 2 + 0.0001, W / 2);
  const holeTop = (u) => (Math.abs(u) <= aw / 2 + 1e-6 ? ys + rise * POINTED(Math.min(1, Math.max(0, (u + aw / 2) / aw))) : null);
  for (let y = y0 - 1.2; y < top - 1e-3; y += COURSE) {
    const ya = y, yb = Math.min(top, y + COURSE), ka = sh(ya + 0.01), kb = ka;
    for (let j = 0; j < cols.length - 1; j++) {
      const ua = cols[j], ub = cols[j + 1];
      if (ub - ua < 1e-3) continue;
      const inA = holeTop((ua + ub) / 2) !== null;
      if (!inA) { rectZ(S, ua, ya, ub, yb, 0, col, ka, kb); continue; }
      const ha = Math.min(yb, Math.max(ya, holeTop(ua) ?? ya)), hb = Math.min(yb, Math.max(ya, holeTop(ub) ?? ya));
      if (ha >= yb - 1e-4 && hb >= yb - 1e-4) continue;
      quad(S, [ua, ha, 0], [ub, hb, 0], [ub, yb, 0], [ua, yb, 0], [0, 0, 1], col, [ka, ka, kb, kb], [ua / US, ha / US, ub / US, hb / US, ub / US, yb / US, ua / US, yb / US]);
    }
  }
  // arch soffit, jambs and the leaves in the recess
  for (let i = 0; i < NA; i++) {
    const ua = -aw / 2 + (aw * i) / NA, ub = -aw / 2 + (aw * (i + 1)) / NA, ha = archTop(ua + 1e-6), hb = archTop(ub - 1e-6);
    quad(S, [ub, hb, 0], [ua, ha, 0], [ua, ha, -recess], [ub, hb, -recess], [0, -1, 0], col, [0.7, 0.7, 0.45, 0.45], [ub / US, 0, ua / US, 0, ua / US, recess / US, ub / US, recess / US]);
    // arch ring of lighter voussoirs, standing a little proud of the face
    const bw = 0.42, ra = ha + bw * (1 - 0.6 * Math.abs(ua) / aw), rb = hb + bw * (1 - 0.6 * Math.abs(ub) / aw);
    quad(S, [ua, ha, 0.05], [ub, hb, 0.05], [ub, rb, 0.05], [ua, ra, 0.05], [0, 0, 1], trim, [1.02, 1.02, 1.08, 1.08], [ua / US, ha / US, ub / US, hb / US, ub / US, rb / US, ua / US, ra / US]);
    // leaves: dark oak planks, the joint down the middle a shade darker
    const kd = Math.abs((ua + ub) / 2) < aw / NA ? 0.55 : 0.8 + ((i * 7) % 5) * 0.04;
    quad(Wd, [ua, y0, -recess], [ub, y0, -recess], [ub, hb, -recess], [ua, ha, -recess], [0, 0, 1], C(0x5a4030), [kd, kd, kd, kd], [ua, 0, ub, 0, ub, hb - y0, ua, ha - y0]);
  }
  for (const sx of [-1, 1]) {
    const u = sx * aw / 2;
    const A = [u, y0, 0], B = [u, y0, -recess], Cc = [u, ys, -recess], D = [u, ys, 0];
    if (sx < 0) quad(S, A, B, Cc, D, [1, 0, 0], col, [0.75, 0.5, 0.5, 0.75], [0, y0 / US, recess / US, y0 / US, recess / US, ys / US, 0, ys / US]);
    else quad(S, B, A, D, Cc, [-1, 0, 0], col, [0.5, 0.75, 0.75, 0.5], [0, y0 / US, recess / US, y0 / US, recess / US, ys / US, 0, ys / US]);
    // jamb trims of the arch ring
    box(S, sx * (aw / 2 + 0.21), (y0 + ys) / 2, 0.03, 0.42, ys - y0, 0.1, trim, 1.02, '-y+y-z');
    // iron lanterns either side of the arch: a warm point of light at first light
    if (o.lamps !== false) {
      box(Dk, sx * (aw / 2 + 0.95), ys - 0.2, 0.25, 0.1, 0.5, 0.1, C(0x1a1a1a), 1);
      box(Gl, sx * (aw / 2 + 0.95), ys - 0.55, 0.32, 0.26, 0.34, 0.26, C(0xffb860), 1.6);
    }
  }
  // inscription panel and the string course over the arch
  box(S, 0, ys + rise + 1.35, 0.06, 2.6, 1.2, 0.12, trim, 1.05, '-z');
  box(Dk, 0, ys + rise + 1.35, 0.125, 2.2, 0.85, 0.02, C(0x6d675a), 1, '-z');
  box(S, 0, top - 1.45, 0.07, W, 0.2, 0.14, mulC(col, 1.06), 1, '-z');
  // sides, top and battlements of the block
  box(S, 0, (y0 - 1.2 + top) / 2, -DEP / 2, W, top - y0 + 1.2, DEP, col, 0.95, '+z');
  box(Cn, 0, top + 0.01, -DEP / 2, W - 0.4, 0.02, DEP - 0.4, C(0xa8a296), 1, '-y');
  box(S, 0, top + 0.12, -0.4, W, 0.24, 0.8, col, 1, '-y');
  const n = Math.floor(W / 2.4);
  for (let i = 0; i < n; i += 2) {
    const u = -W / 2 + ((i + 0.5) / n) * W + 1.2;
    box(S, u, top + 0.24 + 0.35, -0.4, 1.2, 0.7, 0.8, col, 0.96 + ((i * 13) % 9) / 100, '-y');
    box(S, u, top + 0.97, -0.4, 1.28, 0.06, 0.88, mulC(col, 1.06), 1, '-y');
  }
}

/**
 * Curtain wall along a polyline: Level.rampart() between consecutive points,
 * a round tower at every inner vertex (and at the ends unless o.ends === false).
 * pts: [[x, z], ...]; o: { h, towerR, towerH, gy(x, z) → ground height }
 */
export function curtain(L, pts, o = {}) {
  const h = o.h ?? 7.5;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[i + 1], len = Math.hypot(x2 - x1, z2 - z1);
    // stop each segment short of the towers so the parapets do not cut through them
    const tr = (o.towerR ?? 4.2) * 0.7, ux = (x2 - x1) / len, uz = (z2 - z1) / len;
    const a0 = i === 0 && o.ends === false ? 0 : tr, a1 = i === pts.length - 2 && o.ends === false ? 0 : tr;
    L.rampart(x1 + ux * a0, z1 + uz * a0, x2 - ux * a1, z2 - uz * a1, h);
  }
  for (let i = 0; i < pts.length; i++) {
    if (o.ends === false && (i === 0 || i === pts.length - 1)) continue;
    if (o.skip && o.skip.includes(i)) continue;
    const [x, z] = pts[i];
    roundTower(L, x, z, L.gy(x, z), { r: o.towerR ?? 4.2, h: (o.towerH ?? h + 3) + ((i * 7) % 3) * 0.6, seg: 20 });
  }
}
