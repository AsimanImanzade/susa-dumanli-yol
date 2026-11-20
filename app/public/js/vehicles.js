/**
 * vehicles.js — enemy armour and artillery: the patrolling main battle tank,
 * the towed howitzers, the mortar pit and the parked armoured vehicle.
 *
 *   models     built in code like the cars in structures.js: one armour
 *              material with mud, dust and wear baked into the vertex
 *              colours over a tiling paint-detail texture. A tank is seven
 *              draw calls (hull, turret, gun, instanced wheels, two tracks,
 *              lamp glow) and about 11k triangles.
 *   the tank   drives a waypoint route from the act file as a moving solid
 *              (its boxes are moved in the collision hash every step), sees
 *              with the soldiers' detection model through the driver's and
 *              the gunner's arcs, fires a coaxial machine gun and, at a
 *              player who has gone to ground, the main gun after a clear
 *              tell. Only C4 on the rear kills it; anywhere else a charge
 *              breaks a track. The wreck stays as cover and burns.
 *   artillery  static C4 targets like the relay: a charge within a few
 *              metres throws the barrel off and cooks off the ammunition.
 *              While crewed, a battery fires on a slow timer toward the
 *              distance; each report covers the player's shots for a moment.
 *
 * The pure rules (which part a charge hit, what the crew can see, engine
 * masking, steering, the track belt) are in vehicle-rules.js; every number
 * is in config.js → VEHICLES.
 */
import * as THREE from 'three';
import { G, bus, clamp, clamp01, lerp, angDelta, yawTo, dist2D, makeRng, vnoise, smoothstep, wrapPi } from './ctx.js';
import { VEHICLES, STEALTH, THROW, NOISE } from './config.js';
import { F } from './physics.js';
import { Geo, buildBeam } from './models.js';
import { C } from './structures.js';
import { visibility, sightRange, stepMeter } from './stealth.js';
import { noise } from './noise.js';
import { audio } from './audio.js';
import { fx } from './fx.js';
import { R } from './render.js';
import { ai } from './ai.js';
import { input } from './input.js';
import { interact } from './interact.js';
import { t, keyLabel } from './loc.js';
import { toLocal, chargeZone, chargeEffect, chargePrompt, crewSight, crewDetectionRate, engineLoudness, stepMasked, shotCovered,
  driveStep, roundRoute, nearestPoint, stepToward, respawnIndex, mainGunReady, shellDamage, fireForbidden, footprintOverlap, beltPath } from './vehicle-rules.js';

const TK = VEHICLES.tank, ART = VEHICLES.artillery, PI = Math.PI;
const ARMOR_FLAGS = F.SOLID | F.VISION | F.BULLET;

// ═════════════════════════════ textures and materials ═════════════════════════════
function h3(x, y, s) { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function pn(u, v, pu, pv, s) {
  const x = u * pu, y = v * pv, xi = Math.floor(x), yi = Math.floor(y);
  let xf = x - xi, yf = y - yi; xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % pu) + pu) % pu, y0 = ((yi % pv) + pv) % pv, x1 = (x0 + 1) % pu, y1 = (y0 + 1) % pv;
  const a = h3(x0, y0, s), b = h3(x1, y0, s), c = h3(x0, y1, s), d = h3(x1, y1, s);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
function pf(u, v, pu, pv, oct, s) { let t0 = 0, a = 0.5, n = 0; for (let i = 0; i < oct; i++) { t0 += a * pn(u, v, pu, pv, s + i * 17); n += a; a *= 0.5; pu *= 2; pv *= 2; } return t0 / n; }
function canvasTex(W, H, fn, srgb) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), img = g.createImageData(W, H), d = img.data, out = [0, 0, 0];
  for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i += 4) {
    fn(x / W, 1 - (y + 0.5) / H, out);
    d[i] = clamp01(out[0]) * 255; d[i + 1] = clamp01(out[1]) * 255; d[i + 2] = clamp01(out[2]) * 255; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t0 = new THREE.CanvasTexture(c);
  t0.wrapS = t0.wrapT = THREE.RepeatWrapping; t0.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t0.anisotropy = 4;
  return t0;
}
let TEXS = null;
function textures() {
  if (TEXS) return TEXS;
  // armour paint detail, tile 2 m: mottling, scratches, chipped paint, rust specks (the colour itself is in the vertex colours)
  const rough = [];
  const armor = canvasTex(256, 256, (u, v, o) => {
    const n = pf(u, v, 4, 4, 4, 3), f = pn(u, v, 48, 48, 7), sc = pn(u, v, 140, 5, 11), sc2 = pn(u, v, 6, 120, 19);
    const chip = smoothstep(0.74, 0.8, pf(u, v, 14, 14, 3, 13)), rust = smoothstep(0.7, 0.8, pf(u, v, 9, 9, 3, 17));
    let k = 0.88 + (n - 0.5) * 0.2 + (f - 0.5) * 0.06;
    if (sc > 0.93 || sc2 > 0.95) k *= 1.14;
    o[0] = lerp(k, 0.5, chip); o[1] = lerp(k, 0.48, chip); o[2] = lerp(k, 0.46, chip);
    o[0] = lerp(o[0], o[0] * 1.05, rust); o[1] = lerp(o[1], o[1] * 0.72, rust); o[2] = lerp(o[2], o[2] * 0.5, rust);
    rough.push(0.66 + (n - 0.5) * 0.16 - chip * 0.22 + rust * 0.18);
  }, true);
  let ri = 0;
  const armorR = canvasTex(256, 256, (u, v, o) => { const r = rough[ri++]; o[0] = o[1] = o[2] = r; });
  // track links, tile = 8 links (1.28 m) along v, the track width across u
  const track = canvasTex(64, 256, (u, v, o) => {
    const l = v * 8, fl = l - Math.floor(l), n = pf(u, v, 2, 8, 3, 31), mud = smoothstep(0.42, 0.7, pf(u, v, 3, 16, 3, 37));
    let k = 0.36 + (n - 0.5) * 0.1;
    if (fl < 0.09) k = 0.12;                                     // gap between links
    else if (fl > 0.34 && fl < 0.56) k = 0.58 + (n - 0.5) * 0.12; // worn grouser bar, polished by the road
    if ((u < 0.07 || u > 0.93) && fl < 0.24) k = 0.52;            // end connectors
    if (Math.abs(u - 0.5) < 0.05) k *= 0.7;                       // guide horn line
    o[0] = lerp(k, 0.3, mud * 0.7); o[1] = lerp(k, 0.25, mud * 0.7); o[2] = lerp(k, 0.19, mud * 0.7);
  }, true);
  TEXS = { armor, armorR, track };
  return TEXS;
}
/** Materials for one vehicle (each its own instance so a wreck can be darkened on its own). */
function vehicleMats() {
  const T = textures();
  const armor = new THREE.MeshStandardMaterial({ vertexColors: true, map: T.armor, roughnessMap: T.armorR, roughness: 1, metalness: 0.3, envMapIntensity: 0.6 });
  const track = () => { const m = T.track.clone(); m.needsUpdate = true; return new THREE.MeshStandardMaterial({ vertexColors: true, map: m, roughness: 0.75, metalness: 0.55, envMapIntensity: 0.6 }); };
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
  return { armor, trackL: track(), trackR: track(), glow };
}

// ═════════════════════════════ geometry kit ═════════════════════════════
// Writes into a models.js Geo (with UVs) through an optional frame matrix.
// Vertex colours: the part's base colour with mud low down, dust on top and
// a little wear, all from the vertex position (sub-divided faces resolve it).
const OLIVE = 0x4f5c38, MUD = C(0x5b4a36), DUST = C(0x8f8670);
const _rgb = [0, 0, 0];
class Kit {
  constructor(o = {}) {
    this.g = new Geo({ uv: true }); this.E = null; this.col = C(OLIVE); this.us = 2;
    this.yOff = o.yOff || 0; this.mudTop = o.mudTop ?? 1.0; this.grime = 1; this.seed = o.seed || 0; this.k = 1;
  }
  at(x, y, z, ry = 0, rx = 0, rz = 0) { this.E = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')).setPosition(x, y, z).elements; return this; }
  free() { this.E = null; return this; }
  paint(hex, grime = 1, k = 1) { this.col = C(hex); this.grime = grime; this.k = k; return this; }
  _c(x, y, z, ny) {
    const b = this.col, gr = this.grime, k = this.k;
    if (gr <= 0) { _rgb[0] = b[0] * k; _rgb[1] = b[1] * k; _rgb[2] = b[2] * k; return _rgb; }
    const yy = y + this.yOff, n1 = vnoise(x * 1.7 + yy * 0.9 + this.seed, z * 1.7 - yy * 0.6), n2 = vnoise(x * 5.3 + 11, z * 5.3 + yy * 3.1);
    let mud = smoothstep(this.mudTop, this.mudTop * 0.2, yy) * (0.45 + 0.55 * n1) + (n2 > 0.72 && yy < this.mudTop * 1.4 ? 0.35 : 0);
    mud = clamp01(mud) * 0.85 * gr;
    const dust = ny > 0.55 ? (0.18 + 0.3 * n1) * gr : 0;
    const wear = 0.92 + n2 * 0.14;
    for (let i = 0; i < 3; i++) _rgb[i] = lerp(lerp(b[i] * wear, MUD[i], mud), DUST[i], dust * 0.45) * k;
    return _rgb;
  }
  v(x, y, z, nx, ny, nz, u, v) {
    const e = this.E;
    if (e) {
      const X = e[0] * x + e[4] * y + e[8] * z + e[12], Y = e[1] * x + e[5] * y + e[9] * z + e[13], Z = e[2] * x + e[6] * y + e[10] * z + e[14];
      const NX = e[0] * nx + e[4] * ny + e[8] * nz, NY = e[1] * nx + e[5] * ny + e[9] * nz, NZ = e[2] * nx + e[6] * ny + e[10] * nz;
      x = X; y = Y; z = Z; nx = NX; ny = NY; nz = NZ;
    }
    const c = this._c(x, y, z, ny);
    return this.g._vert(x, y, z, nx, ny, nz, c[0], c[1], c[2], u, v, 0);
  }
  /** Flat quad from corner o along du, dv (du × dv faces out), cut into cells of about `div` metres. */
  plane(ox, oy, oz, ux, uy, uz, vx, vy, vz, div = 0) {
    const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const nu = div ? Math.max(1, Math.round(lu / div)) : 1, nv = div ? Math.max(1, Math.round(lv / div)) : 1;
    const base = this.g.count, us = this.us;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const a = i / nu, b = j / nv;
      this.v(ox + ux * a + vx * b, oy + uy * a + vy * b, oz + uz * a + vz * b, nx, ny, nz, a * lu / us, b * lv / us);
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const p = base + j * (nu + 1) + i, q = p + nu + 1;
      this.g.i.push(p, p + 1, q + 1, p, q + 1, q);
    }
  }
  /** Box centred at (cx,cy,cz), full size (sx,sy,sz). o: { div, skip (mask 1 +x 2 −x 4 +y 8 −y 16 +z 32 −z), ry, rx, rz } */
  box(cx, cy, cz, sx, sy, sz, o = {}) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2, skip = o.skip || 0, div = o.div ?? 0;
    let R = null;
    if (o.ry || o.rx || o.rz) R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(o.rx || 0, o.ry || 0, o.rz || 0, 'YXZ')).elements;
    const rot = (x, y, z) => R ? [R[0] * x + R[4] * y + R[8] * z, R[1] * x + R[5] * y + R[9] * z, R[2] * x + R[6] * y + R[10] * z] : [x, y, z];
    const F6 = [[[1, 0, 0], [0, 0, -1], [0, 1, 0], hx, hz, hy], [[-1, 0, 0], [0, 0, 1], [0, 1, 0], hx, hz, hy], [[0, 1, 0], [1, 0, 0], [0, 0, -1], hy, hx, hz],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1], hy, hx, hz], [[0, 0, 1], [1, 0, 0], [0, 1, 0], hz, hx, hy], [[0, 0, -1], [-1, 0, 0], [0, 1, 0], hz, hx, hy]];
    for (let f = 0; f < 6; f++) {
      if (skip & (1 << f)) continue;
      const [N, U, Vv, hn, hu, hv] = F6[f];
      const n = rot(N[0] * hn, N[1] * hn, N[2] * hn), u = rot(U[0] * hu, U[1] * hu, U[2] * hu), w = rot(Vv[0] * hv, Vv[1] * hv, Vv[2] * hv);
      this.plane(cx + n[0] - u[0] - w[0], cy + n[1] - u[1] - w[1], cz + n[2] - u[2] - w[2], u[0] * 2, u[1] * 2, u[2] * 2, w[0] * 2, w[1] * 2, w[2] * 2, div);
    }
  }
  /**
   * Surface of revolution: profile [[r, h], ...] (h up the axis, profile going "up"), seg segments.
   * o: { axis 'y'|'x'|'z', a0, a1, rs(angle) radius scale, capTop, capBot }. Axis x and z are proper rotations of y.
   */
  lathe(cx, cy, cz, prof, seg, o = {}) {
    const axis = o.axis || 'y', a0 = o.a0 ?? 0, a1 = o.a1 ?? PI * 2, n = prof.length;
    const map = axis === 'y' ? (x, y, z) => [x, y, z] : axis === 'x' ? (x, y, z) => [y, -x, z] : (x, y, z) => [x, -z, y];
    const pnr = [];
    for (let i = 0; i < n; i++) {
      const p = prof[Math.max(0, i - 1)], q = prof[Math.min(n - 1, i + 1)];
      const dr = q[0] - p[0], dh = q[1] - p[1], l = Math.hypot(dr, dh) || 1;
      pnr.push([dh / l, -dr / l]);
    }
    const base = this.g.count, cols = seg + 1;
    for (let i = 0; i < n; i++) for (let s = 0; s <= seg; s++) {
      const a = a0 + (a1 - a0) * s / seg, ca = Math.cos(a), sa = Math.sin(a), k = o.rs ? o.rs(a) : 1, r = prof[i][0] * k;
      const p = map(ca * r, prof[i][1], sa * r), nn = map(ca * pnr[i][0], pnr[i][1], sa * pnr[i][0]);
      this.v(cx + p[0], cy + p[1], cz + p[2], nn[0], nn[1], nn[2], s / seg * (r * (a1 - a0)) / this.us, prof[i][1] / this.us);
    }
    for (let i = 0; i < n - 1; i++) for (let s = 0; s < seg; s++) {
      const a = base + i * cols + s, b = a + cols;
      this.g.i.push(a, b, b + 1, a, b + 1, a + 1);
    }
    for (const [on, i, up] of [[o.capTop, n - 1, 1], [o.capBot, 0, -1]]) {
      if (!on || prof[i][0] < 1e-4) continue;
      const nn = map(0, up, 0), c0 = this.g.count, h = prof[i][1], cp = map(0, h, 0);
      this.v(cx + cp[0], cy + cp[1], cz + cp[2], nn[0], nn[1], nn[2], 0.5, 0.5);
      for (let s = 0; s <= seg; s++) {
        const a = a0 + (a1 - a0) * s / seg, k = o.rs ? o.rs(a) : 1, r = prof[i][0] * k, p = map(Math.cos(a) * r, h, Math.sin(a) * r);
        this.v(cx + p[0], cy + p[1], cz + p[2], nn[0], nn[1], nn[2], 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
      }
      for (let s = 0; s < seg; s++) if (up > 0) this.g.i.push(c0, c0 + s + 2, c0 + s + 1); else this.g.i.push(c0, c0 + s + 1, c0 + s + 2);
    }
  }
  /** Cylinder along an axis, centred at (cx,cy,cz). */
  cyl(cx, cy, cz, r0, r1, h, seg, axis = 'y', caps = true) { this.lathe(cx, cy, cz, [[r0, -h / 2], [r1, h / 2]], seg, { axis, capTop: caps, capBot: caps }); }
  /** Round rod between two points. */
  rod(a, b, r, seg = 6) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], len = Math.hypot(dx, dy, dz);
    const keep = this.E, m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
    m.compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(1, 1, 1));
    if (keep) m.premultiply(new THREE.Matrix4().fromArray(keep));
    this.E = m.elements;
    this.cyl(0, 0, 0, r, r, len, seg, 'y', true);
    this.E = keep;
  }
  /** Polygon pts [[z, y], ...] (side profile) extruded across x from x0 to x1. */
  prism(pts, x0, x1, div = 0) {
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; area += p[0] * q[1] - q[0] * p[1]; }
    if (area < 0) pts = pts.slice().reverse();                      // counter-clockwise in (z, y)
    const tris = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p[0], p[1])), []);
    for (const [x, nx] of [[x1, 1], [x0, -1]]) {
      const c0 = this.g.count;
      for (const p of pts) this.v(x, p[1], p[0], nx, 0, 0, p[0] / this.us, p[1] / this.us);
      for (const tr of tris) {
        const A = pts[tr[0]], B = pts[tr[1]], Cc = pts[tr[2]], ccw = (B[0] - A[0]) * (Cc[1] - A[1]) - (Cc[0] - A[0]) * (B[1] - A[1]) > 0;
        // a counter-clockwise (z, y) triangle faces −x
        if (ccw === (nx < 0)) this.g.i.push(c0 + tr[0], c0 + tr[1], c0 + tr[2]); else this.g.i.push(c0 + tr[0], c0 + tr[2], c0 + tr[1]);
      }
    }
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      this.plane(x0, p[1], p[0], x1 - x0, 0, 0, 0, q[1] - p[1], q[0] - p[0], div);
    }
  }
  /**
   * Hull loft: rings [{ z, pts: [[x, y], ...] }] each a half section from the bottom centre round to the top
   * centre (x ≥ 0), mirrored to the left. Front (first) and rear (last) rings are capped.
   */
  loft(rings, div = 0) {
    const n = rings[0].pts.length;
    for (const side of [1, -1]) for (let j = 0; j < rings.length - 1; j++) for (let i = 0; i < n - 1; i++) {
      const A = rings[j], B = rings[j + 1];
      const p00 = [A.pts[i][0] * side, A.pts[i][1], A.z], p10 = [A.pts[i + 1][0] * side, A.pts[i + 1][1], A.z];
      const p01 = [B.pts[i][0] * side, B.pts[i][1], B.z], p11 = [B.pts[i + 1][0] * side, B.pts[i + 1][1], B.z];
      this._quad4(side > 0 ? [p00, p10, p11, p01] : [p10, p00, p01, p11]);
    }
    for (const [ring, dir] of [[rings[0], -1], [rings[rings.length - 1], 1]]) {
      const poly = [];
      for (let i = 0; i < n; i++) poly.push([ring.pts[i][0], ring.pts[i][1]]);
      for (let i = n - 2; i > 0; i--) poly.push([-ring.pts[i][0], ring.pts[i][1]]);
      const tris = THREE.ShapeUtils.triangulateShape(poly.map((p) => new THREE.Vector2(p[0], p[1])), []), c0 = this.g.count;
      for (const p of poly) this.v(p[0], p[1], ring.z, 0, 0, dir, p[0] / this.us, p[1] / this.us);
      for (const tr of tris) {
        const A = poly[tr[0]], B = poly[tr[1]], Cc = poly[tr[2]], ccw = (B[0] - A[0]) * (Cc[1] - A[1]) - (Cc[0] - A[0]) * (B[1] - A[1]) > 0;
        if (ccw === (dir > 0)) this.g.i.push(c0 + tr[0], c0 + tr[1], c0 + tr[2]); else this.g.i.push(c0 + tr[0], c0 + tr[2], c0 + tr[1]);
      }
    }
    void div;
  }
  _quad4(q) {
    const [a, b, c, d] = q;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const i0 = this.g.count, us = this.us;
    for (const p of q) this.v(p[0], p[1], p[2], nx, ny, nz, (p[2] + p[0] * 0.3) / us, p[1] / us);
    this.g.i.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  }
  build() { return this.g.build(); }
}
const mesh = (kit, mat, shadow = true) => { const m = new THREE.Mesh(kit.build(), mat); m.castShadow = shadow; m.receiveShadow = true; return m; };

// ═════════════════════════════ the tank (T-72 type) ═════════════════════════════
// Local frame: origin on the ground under the hull centre, forward = −z.
const TANKG = {
  wheelsZ: [-2.2, -1.37, -0.55, 0.28, 1.1, 1.93], wheelR: 0.37, wheelY: 0.44, trackX: 1.4, trackW: 0.58, trackT: 0.07,
  idler: { z: -3.05, y: 0.6, r: 0.29 }, sprocket: { z: 2.95, y: 0.66, r: 0.31 },
  pivot: [0, 1.45, TK.turretZ], trunnion: [0, 0.38, -1.0], barrel: 5.3, coax: [0.34, 0.36, -1.32],
  lamp: [0, 1.12, -3.32], exhaust: [-1.78, 1.12, 2.3],
};
function wheelGeo(R0) {
  const k = new Kit({ mudTop: 0.9 });
  const disc = (flip) => {
    if (flip) k.at(0, 0, 0, PI); else k.free();
    k.paint(0x262622, 0.6).lathe(0, 0, 0, [[0.30 * R0, 0.035], [0.37 * R0, 0.045], [0.37 * R0, 0.115], [0.3 * R0, 0.13]], 12, { axis: 'x' });
    k.paint(OLIVE, 1).lathe(0, 0, 0, [[0.3 * R0, 0.13], [0.17 * R0, 0.115], [0.08 * R0, 0.15], [0.0, 0.155]], 12, { axis: 'x' });
    k.paint(OLIVE, 1, 0.8).lathe(0, 0, 0, [[0.1 * R0, 0.0], [0.3 * R0, 0.035]], 12, { axis: 'x' });
  };
  disc(false); disc(true);
  k.free().paint(0x3a4030, 0.5).cyl(0, 0, 0, 0.1, 0.1, 0.06, 8, 'x', false);
  return k.build();
}
function sprocketGeo() {
  const k = new Kit({ mudTop: 1.2 });
  for (const sx of [1, -1]) {
    k.at(0, 0, 0, sx > 0 ? 0 : PI);
    k.paint(OLIVE, 1).lathe(0, 0, 0, [[0.06, 0.03], [0.24, 0.05], [0.26, 0.09], [0.12, 0.13], [0, 0.13]], 12, { axis: 'x', capBot: false });
    for (let i = 0; i < 12; i++) { const a = i / 12 * PI * 2; k.paint(0x3c3d36, 0.6).box(0.07, Math.sin(a) * 0.3, Math.cos(a) * 0.3, 0.05, 0.07, 0.07, { rx: -a }); }
  }
  return k.build();
}
function trackGeo(path, side) {
  const g = new Geo({ uv: true }), w = TANKG.trackW / 2, th = TANKG.trackT / 2, x0 = TANKG.trackX * side, tile = 1.28;
  const col = C(0x8a857c), colIn = C(0x5a5650);
  const n = path.length;
  const P = (i) => path[(i + n) % n];
  // per point: centre, outward normal in (z, y)
  const pts = [];
  for (let i = 0; i < n - 1; i++) {
    const a = P(i - 1 < 0 ? n - 2 : i - 1), b = P(i + 1);
    let tz = b.z - a.z, ty = b.y - a.y; const l = Math.hypot(tz, ty) || 1; tz /= l; ty /= l;
    pts.push({ z: path[i].z, y: path[i].y, s: path[i].s, nz: ty, ny: -tz });
  }
  pts.push({ ...pts[0], s: path[n - 1].s });
  const faces = [[1, 0, 1], [-1, 1, 0], [0, 2, 0], [0, 3, 0]];
  void faces;
  const ring = (p, o, sideX, uu) => [x0 + sideX, p.y + p.ny * o, p.z + p.nz * o, uu];
  // four strips: outer (o=+th), inner (o=−th), and the two edges
  const strips = [
    { a: (p) => ring(p, th, -w, 0), b: (p) => ring(p, th, w, 1), n: (p) => [0, p.ny, p.nz], c: col },
    { a: (p) => ring(p, -th, w, 0), b: (p) => ring(p, -th, -w, 1), n: (p) => [0, -p.ny, -p.nz], c: colIn },
    { a: (p) => ring(p, -th, w, 0), b: (p) => ring(p, th, w, 0.12), n: () => [1, 0, 0], c: colIn },
    { a: (p) => ring(p, th, -w, 0), b: (p) => ring(p, -th, -w, 0.12), n: () => [-1, 0, 0], c: colIn },
  ];
  for (const st of strips) {
    const base = g.count;
    for (const p of pts) {
      const A = st.a(p), B = st.b(p), N = st.n(p), v = p.s / tile;
      g._vert(A[0], A[1], A[2], N[0], N[1], N[2], st.c[0], st.c[1], st.c[2], A[3], v, 0);
      g._vert(B[0], B[1], B[2], N[0], N[1], N[2], st.c[0], st.c[1], st.c[2], B[3], v, 0);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = base + i * 2, b = a + 2;
      // the path runs counter-clockwise in (z, y); seen from +x that is clockwise, so the order flips with the side
      if (side > 0) g.i.push(a, a + 1, b + 1, a, b + 1, b); else g.i.push(a, b + 1, a + 1, a, b, b + 1);
    }
  }
  return g;
}
const BELT = (() => {
  const T = TANKG, h = T.trackT / 2, wz = T.wheelsZ;
  return beltPath([{ z: wz[0], y: T.wheelY, r: T.wheelR + h }, { z: wz[wz.length - 1], y: T.wheelY, r: T.wheelR + h },
    { z: T.sprocket.z, y: T.sprocket.y, r: T.sprocket.r + h }, { z: T.idler.z, y: T.idler.y, r: T.idler.r + h }], 0.32);
})();

export function buildTank(seed = 1) {
  const mats = vehicleMats(), root = new THREE.Group();
  root.rotation.order = 'YXZ';
  // ── hull
  const H = new Kit({ seed });
  // lower hull between the tracks, upper hull with the glacis over the full width
  H.paint(OLIVE).prism([[-3.15, 0.48], [2.95, 0.48], [3.42, 0.66], [3.42, 1.0], [-3.45, 1.0], [-3.45, 0.84]], -1.08, 1.08, 0.5);
  H.prism([[-3.45, 0.98], [-1.95, 1.45], [3.3, 1.45], [3.42, 1.32], [3.42, 1.0]], -1.73, 1.73, 0.45);
  // glacis splash board, driver's hatch and periscope, dozer blade under the nose, tow hooks
  H.paint(OLIVE, 1, 0.9).box(0, 1.25, -2.75, 2.6, 0.12, 0.05, { rx: -0.33 });
  H.paint(OLIVE, 1, 0.95).cyl(0, 1.47, -1.95, 0.27, 0.27, 0.05, 12);
  H.paint(0x2c2e28, 0.4).box(0, 1.52, -2.16, 0.3, 0.07, 0.1);
  H.paint(OLIVE, 1, 0.85).box(0, 0.68, -3.55, 2.2, 0.32, 0.07, { rx: 0.35, div: 0.5 });
  for (const sx of [-0.75, 0.75]) H.paint(0x30322c, 0.6).box(sx, 0.86, -3.5, 0.16, 0.1, 0.14);
  // front mudguards and the rubber side skirts
  for (const sx of [-1, 1]) {
    H.paint(OLIVE, 1).box(sx * 1.4, 0.98, -3.5, 0.64, 0.04, 0.24, { rx: 0.4 });
    for (let i = 0; i < 6; i++) {
      const z0 = -2.95 + i * 0.98;
      H.paint(0x2b2b27, 0.9).box(sx * 1.765, 0.82, z0 + 0.48, 0.025, 0.42, 0.95, { rz: sx * 0.05 });
    }
    H.paint(OLIVE, 1, 0.9).box(sx * 1.745, 1.03, -0.05, 0.05, 0.07, 5.9);
  }
  // headlamps with guards on the glacis
  for (const sx of [-1.28, 1.28]) {
    H.paint(0x3a3c36, 0.4).cyl(sx, 1.19, -3.18, 0.085, 0.085, 0.14, 10, 'z');
    H.paint(OLIVE, 1, 0.9).rod([sx - 0.12, 1.1, -3.3], [sx - 0.12, 1.32, -3.25], 0.012, 4); H.rod([sx + 0.12, 1.1, -3.3], [sx + 0.12, 1.32, -3.25], 0.012, 4);
  }
  // stowage boxes and the external tanks along the fenders
  for (const [sx, z, l] of [[1, 0.9, 1.5], [1, 2.4, 1.0], [-1, 0.6, 1.2]]) H.paint(OLIVE, 1, 0.93).box(sx * 1.48, 1.58, z, 0.42, 0.26, l, { div: 0.4 });
  // exhaust grille on the left side, engine deck louvres, rear plate, fuel drums and the unditching beam
  H.paint(0x24241f, 0.3).box(-1.74, 1.18, 2.3, 0.04, 0.2, 0.62);
  H.paint(OLIVE, 1, 0.95).box(0, 1.48, 2.15, 2.3, 0.06, 2.0, { div: 0.5 });
  for (let i = 0; i < 9; i++) H.paint(0x2a2b25, 0.5).box(0, 1.52, 1.35 + i * 0.2, 2.0, 0.03, 0.06);
  for (const sx of [-0.52, 0.52]) {
    H.paint(0x56603c, 1).cyl(sx, 1.31, 3.58, 0.26, 0.26, 0.86, 14, 'x');
    for (const r of [-0.28, 0.28]) H.paint(0x484f33, 1).cyl(sx + r, 1.31, 3.58, 0.272, 0.272, 0.03, 14, 'x', false);
    H.paint(0x30322c, 0.6).box(sx, 1.02, 3.5, 0.06, 0.1, 0.22);
  }
  H.paint(0x6b5338, 0.4).cyl(0, 1.63, 3.47, 0.12, 0.12, 2.7, 8, 'x');
  for (const sx of [-1.05, 1.05]) H.paint(0x30322c, 0.5).box(sx, 1.55, 3.45, 0.06, 0.2, 0.26);
  for (const sx of [-0.85, 0.85]) H.paint(0x30322c, 0.5).box(sx, 0.76, 3.46, 0.18, 0.12, 0.1);
  // under the hull: the dark belly and suspension arms
  H.paint(0x1e1f1b, 0).box(0, 0.47, 0, 2.1, 0.02, 6.1, { skip: 4 });
  for (const z of TANKG.wheelsZ) for (const sx of [-1, 1]) H.paint(0x30322c, 0.5).box(sx * 1.08, 0.5, z + 0.15, 0.1, 0.1, 0.4);
  const hull = mesh(H, mats.armor);
  root.add(hull);

  // ── turret (pivot on the hull roof) and gun
  const turret = new THREE.Group();
  turret.position.set(...TANKG.pivot);
  const T = new Kit({ seed: seed + 3, yOff: TANKG.pivot[1] });
  const front = (a) => { const cf = -Math.sin(a); return 1 + 0.2 * Math.max(0, cf) ** 2 - 0.05 * Math.max(0, -cf) ** 2; };
  T.paint(OLIVE).lathe(0, 0, 0, [[1.12, -0.02], [1.2, 0.07], [1.21, 0.2], [1.14, 0.36], [0.98, 0.5], [0.72, 0.6], [0.4, 0.65], [0, 0.66]], 24, { rs: front });
  T.paint(0x2a2b25, 0.3).cyl(0, 0.0, 0, 1.02, 1.02, 0.06, 20, 'y', false);
  T.paint(OLIVE, 1, 0.92).box(0, 0.36, -1.22, 0.62, 0.46, 0.34, { div: 0.3 });          // gun mask
  T.paint(0x23241f, 0.2).cyl(0.34, 0.36, -1.4, 0.035, 0.035, 0.08, 6, 'z');              // coaxial MG port
  // commander's cupola with the heavy MG, gunner's hatch and sight, searchlight, smoke dischargers, snorkel, antenna
  T.paint(OLIVE, 1, 0.95).cyl(0.45, 0.72, 0.2, 0.4, 0.42, 0.18, 16);
  T.paint(OLIVE, 1, 0.9).cyl(0.45, 0.83, 0.2, 0.32, 0.32, 0.05, 14);
  T.paint(0x2c2d28, 0.3).box(0.45, 0.95, -0.05, 0.12, 0.13, 0.62); T.cyl(0.45, 0.97, -0.75, 0.025, 0.025, 0.9, 6, 'z'); T.box(0.62, 0.92, 0.0, 0.16, 0.14, 0.22);
  T.paint(OLIVE, 1, 0.9).cyl(-0.45, 0.71, 0.25, 0.3, 0.3, 0.06, 14);
  T.paint(OLIVE, 1, 0.93).box(-0.62, 0.66, -0.6, 0.26, 0.24, 0.36); T.paint(0x1a1c1e, 0).box(-0.62, 0.7, -0.79, 0.18, 0.1, 0.02);
  T.paint(OLIVE, 1, 0.93).box(0.66, 0.6, -0.95, 0.34, 0.34, 0.24); T.paint(0x15171a, 0).cyl(0.66, 0.6, -1.08, 0.14, 0.14, 0.02, 12, 'z');
  for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) {
    const a = -PI / 2 + sx * (0.62 + i * 0.13);
    T.paint(0x3c4430, 0.6).cyl(Math.cos(a) * 1.12, 0.36, Math.sin(a) * 1.12 * 1.12, 0.04, 0.04, 0.26, 6, 'z');
  }
  T.paint(0x4a523a, 0.8).cyl(0, 0.3, 1.17, 0.1, 0.1, 1.5, 8, 'x');
  T.paint(OLIVE, 1, 0.9).box(-0.55, 0.32, 0.98, 0.7, 0.3, 0.3, { div: 0.35 });
  T.paint(0x2c2d28, 0.2).rod([-0.5, 0.7, 0.75], [-0.53, 2.6, 0.82], 0.008, 4);
  turret.add(mesh(T, mats.armor));
  const gun = new THREE.Group();
  gun.position.set(...TANKG.trunnion);
  const Gk = new Kit({ seed: seed + 5, yOff: TANKG.pivot[1] + TANKG.trunnion[1] });
  Gk.at(0, 0, 0, PI).paint(OLIVE, 0.4).lathe(0, 0, 0, [[0.16, 0.2], [0.13, 0.42], [0.105, 0.5], [0.105, 1.95], [0.118, 1.97], [0.118, 2.08], [0.105, 2.1], [0.105, 2.85],
    [0.15, 3.0], [0.162, 3.2], [0.15, 3.42], [0.098, 3.56], [0.095, 5.18], [0.102, 5.2], [0.102, 5.3], [0.06, 5.3]], 14, { axis: 'z' });
  Gk.paint(0x0c0c0c, 0).cyl(0, 0, 5.29, 0.06, 0.06, 0.01, 10, 'z');
  gun.add(mesh(Gk, mats.armor));
  turret.add(gun);
  root.add(turret);

  // ── running gear: road wheels, idler and sprocket instanced; the two tracks
  const wg = wheelGeo(1), sg = sprocketGeo();
  const wheels = new THREE.InstancedMesh(wg, mats.armor, 14);
  const sprockets = new THREE.InstancedMesh(sg, mats.armor, 2);
  wheels.castShadow = sprockets.castShadow = true; wheels.receiveShadow = sprockets.receiveShadow = true;
  wheels.frustumCulled = sprockets.frustumCulled = false;
  const wheelSlots = [];
  for (const side of [-1, 1]) {
    for (const z of TANKG.wheelsZ) wheelSlots.push({ m: wheels, side, x: side * TANKG.trackX, y: TANKG.wheelY, z, k: 1, r: TANKG.wheelR });
    wheelSlots.push({ m: wheels, side, x: side * TANKG.trackX, y: TANKG.idler.y, z: TANKG.idler.z, k: TANKG.idler.r / TANKG.wheelR, r: TANKG.idler.r });
    wheelSlots.push({ m: sprockets, side, x: side * TANKG.trackX, y: TANKG.sprocket.y, z: TANKG.sprocket.z, k: 1.18, r: TANKG.sprocket.r });
  }
  let wi = 0, si = 0;
  for (const s of wheelSlots) s.i = s.m === wheels ? wi++ : si++;
  root.add(wheels, sprockets);
  const tracks = [];
  for (const side of [-1, 1]) {
    const m = new THREE.Mesh(trackGeo(BELT, side).build(), side < 0 ? mats.trackL : mats.trackR);
    m.castShadow = true; m.receiveShadow = true; root.add(m); tracks.push(m);
  }
  // ── lamp glow (on at night), the headlamp beam and its light
  const L = new Kit();
  for (const sx of [-1.28, 1.28]) L.paint(0xfff1c9, 0).cyl(sx, 1.19, -3.26, 0.07, 0.07, 0.01, 10, 'z');
  for (const sx of [-1.62, 1.62]) L.paint(0xb02818, 0).box(sx, 1.3, 3.43, 0.08, 0.05, 0.01);
  const glow = new THREE.Mesh(L.build(), mats.glow);
  root.add(glow);
  const beam = buildBeam(15, 3.4);
  beam.position.set(TANKG.lamp[0], TANKG.lamp[1], TANKG.lamp[2]); beam.rotation.x = -0.12; beam.material.opacity = 0.035;
  root.add(beam);
  const spot = new THREE.SpotLight(0xfff0d4, 0, 34, 0.5, 0.55, 1.3);
  spot.position.set(TANKG.lamp[0], TANKG.lamp[1] + 0.1, TANKG.lamp[2]);
  spot.target.position.set(0, -0.4, -16);
  root.add(spot, spot.target);

  const model = { kind: 'tank', root, hull, turret, gun, wheels, sprockets, wheelSlots, tracks, glow, beam, spot, mats, phase: [0, 0], scroll: [0, 0], recoil: 0 };
  poseTank(model, 0, 0, 0, 0, 0);
  return model;
}
const _wm = new Float32Array(16);
/** Advance the running gear: vL / vR are the track speeds (m/s, forward positive). */
export function poseTank(m, dt, vL, vR, turretRel, gunElev) {
  const len = BELT[BELT.length - 1].s;
  for (let side = 0; side < 2; side++) {
    const v = side === 0 ? vL : vR;
    m.phase[side] -= v / TANKG.wheelR * dt;
    m.scroll[side] = (m.scroll[side] + v * dt / len) % 1;
    m.tracks[side].material.map.offset.y = m.scroll[side] * len / 1.28;
  }
  for (const s of m.wheelSlots) {
    const ph = m.phase[s.side < 0 ? 0 : 1] * (TANKG.wheelR / s.r), c = Math.cos(ph) * s.k, sn = Math.sin(ph) * s.k;
    _wm[0] = s.k; _wm[1] = 0; _wm[2] = 0; _wm[3] = 0;
    _wm[4] = 0; _wm[5] = c; _wm[6] = sn; _wm[7] = 0;
    _wm[8] = 0; _wm[9] = -sn; _wm[10] = c; _wm[11] = 0;
    _wm[12] = s.x; _wm[13] = s.y; _wm[14] = s.z; _wm[15] = 1;
    s.m.instanceMatrix.array.set(_wm, s.i * 16);
  }
  m.wheels.instanceMatrix.needsUpdate = true; m.sprockets.instanceMatrix.needsUpdate = true;
  m.turret.rotation.y = turretRel;
  m.gun.rotation.x = gunElev;
  m.gun.position.z = TANKG.trunnion[2] + m.recoil * 0.4;
}

// ═════════════════════════════ BTR-type armoured personnel carrier ═════════════════════════════
const APCG = { axles: [-2.15, -0.75, 0.85, 2.25], wheelR: 0.56, wheelX: 1.2 };
export function buildApc(seed = 2) {
  const mats = vehicleMats(), root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const H = new Kit({ seed, mudTop: 1.2 });
  const sec = (k, top, bot) => [[0, bot], [1.02 * k, bot], [1.42 * k, 0.95], [1.45 * k, 1.3], [1.12 * k, top - 0.02], [0.9 * k, top], [0, top]];
  H.paint(0x535d3c).loft([
    { z: -3.78, pts: sec(0.72, 1.32, 0.72) }, { z: -3.2, pts: sec(0.9, 1.6, 0.56) }, { z: -2.55, pts: sec(1, 1.98, 0.5) },
    { z: 0, pts: sec(1, 2.0, 0.5) }, { z: 2.9, pts: sec(1, 1.98, 0.5) }, { z: 3.55, pts: sec(0.95, 1.82, 0.6) }, { z: 3.78, pts: sec(0.9, 1.7, 0.78) },
  ]);
  // trim vane on the nose, headlamps, vision blocks, side hatch, firing ports, exhaust boxes, roof hatches
  H.paint(0x535d3c, 1, 0.92).box(0, 1.2, -3.84, 1.6, 0.42, 0.04, { rx: 0.5, div: 0.4 });
  for (const sx of [-0.9, 0.9]) { H.paint(0x30322c, 0.3).cyl(sx, 1.52, -3.36, 0.08, 0.08, 0.1, 8, 'z'); }
  for (const sx of [-1, 1]) {
    H.paint(0x2b2c27, 0.4).box(sx * 1.43, 1.12, 0.05, 0.03, 0.62, 0.8, { rz: sx * 0.07 });
    for (const z of [-1.6, -0.6, 0.9, 1.9]) H.paint(0x1c1d1a, 0).cyl(sx * 1.3, 1.62, z, 0.05, 0.05, 0.05, 6, 'x');
    H.paint(0x30322c, 0.5).box(sx * 1.3, 1.62, 3.3, 0.35, 0.22, 0.5);
    H.paint(0x535d3c, 1, 0.9).box(sx * 1.43, 0.98, 0, 0.06, 0.06, 6.6);
    for (const az of APCG.axles) H.paint(0x535d3c, 1, 0.85).lathe(sx * 1.45, APCG.wheelR + 0.02, az, [[0.66, -0.12], [0.66, 0.12]], 10, { axis: 'x', a0: 0, a1: PI });
  }
  for (const [x, z] of [[-0.6, -2.4], [0.6, -2.4], [-0.5, 1.4], [0.5, 1.4], [0, 2.6]]) H.paint(0x535d3c, 1, 0.9).cyl(x, 2.01, z, 0.3, 0.3, 0.04, 12);
  H.paint(0x1e1f1b, 0).box(0, 0.5, 0, 2.0, 0.02, 7, { skip: 4 });
  // eight wheels: tyre with tread blocks, hub
  for (const az of APCG.axles) for (const sx of [-1, 1]) {
    const x = sx * APCG.wheelX;
    H.at(x, APCG.wheelR, az, sx > 0 ? 0 : PI).paint(0x22221f, 0.7).lathe(0, 0, 0, [[0.3, -0.18], [0.5, -0.19], [0.56, -0.13], [0.56, 0.13], [0.5, 0.19], [0.3, 0.19]], 16, { axis: 'x' });
    H.paint(0x535d3c, 1, 0.9).lathe(0, 0, 0, [[0.3, 0.19], [0.18, 0.2], [0.08, 0.24], [0, 0.24]], 10, { axis: 'x' });
  }
  H.free();
  const hull = mesh(H, mats.armor);
  root.add(hull);
  const turret = new THREE.Group();
  turret.position.set(0, 2.0, -1.05);
  const T = new Kit({ seed: seed + 3, yOff: 2.0, mudTop: 1.2 });
  T.paint(0x535d3c).lathe(0, 0, 0, [[0.62, 0], [0.58, 0.2], [0.45, 0.42], [0.2, 0.47], [0, 0.48]], 14);
  T.paint(0x2c2d28, 0.3).cyl(0.0, 0.2, -1.2, 0.05, 0.05, 1.7, 8, 'z'); T.cyl(0.0, 0.2, -0.42, 0.1, 0.1, 0.25, 8, 'z'); T.cyl(0.18, 0.2, -0.7, 0.025, 0.025, 0.5, 6, 'z');
  T.paint(0x1a1c1e, 0).box(0.25, 0.4, -0.38, 0.12, 0.08, 0.06);
  turret.add(mesh(T, mats.armor));
  root.add(turret);
  return { kind: 'apc', root, hull, turret, mats };
}

// ═════════════════════════════ D-30-type towed howitzer and the mortar ═════════════════════════════
const GUNG = { trunnion: [0, 1.12, 0.1], barrel: 4.6, elev: 0.36 };
export function buildHowitzer(seed = 3) {
  const mats = vehicleMats(), root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const K = new Kit({ seed, mudTop: 0.5 });
  const COL = 0x55603e;
  // three trails splayed at 120°, ending in spades; the base jack under the carriage
  for (const a of [PI / 3, PI, -PI / 3]) {
    const ex = -Math.sin(a) * 3.4, ez = -Math.cos(a) * 3.4;
    K.paint(COL).at(ex / 2, 0.32, ez / 2, a, -0.12).box(0, 0, 0, 0.2, 0.18, 3.3, { div: 0.6 });
    K.at(ex, 0.12, ez, a).box(0, 0, 0, 0.42, 0.3, 0.05);
  }
  K.free().paint(COL, 1, 0.85).cyl(0, 0.14, 0, 0.55, 0.62, 0.28, 16);
  K.paint(COL).cyl(0, 0.5, 0, 0.32, 0.4, 0.5, 14);
  // top carriage, cradle, shield and the raised wheels
  K.paint(COL, 1, 0.95).box(0, 0.88, 0.1, 0.9, 0.34, 1.1, { div: 0.4 });
  for (const sx of [-1, 1]) {
    K.paint(COL, 1, 0.9).box(sx * 0.7, 1.35, -0.42, 0.95, 0.85, 0.04, { ry: sx * 0.35, div: 0.4 });
    K.at(sx * 1.08, 0.72, 0.25, sx > 0 ? 0 : PI).paint(0x22221f, 0.7).lathe(0, 0, 0, [[0.3, -0.12], [0.48, -0.13], [0.54, -0.08], [0.54, 0.08], [0.48, 0.13], [0.3, 0.13]], 14, { axis: 'x' });
    K.paint(COL, 1, 0.9).lathe(0, 0, 0, [[0.3, 0.13], [0.12, 0.15], [0, 0.17]], 10, { axis: 'x' });
    K.free();
  }
  K.paint(COL, 1, 0.9).box(0, 1.78, -0.5, 0.5, 0.06, 0.4, { rx: 0.4 });
  const carriage = mesh(K, mats.armor);
  root.add(carriage);
  // barrel group: elevated, with recoil cylinders over it and the double-baffle muzzle brake
  const barrel = new THREE.Group();
  barrel.position.set(...GUNG.trunnion); barrel.rotation.order = 'YXZ'; barrel.rotation.x = GUNG.elev;
  const B = new Kit({ seed: seed + 2, yOff: 1.1, mudTop: 0.3 });
  B.at(0, 0, 0, PI).paint(COL, 0.3).lathe(0, 0, 0, [[0.14, -0.9], [0.14, -0.3], [0.1, -0.22], [0.085, 0.0], [0.08, 3.9], [0.075, 3.95], [0.075, 4.05]], 12, { axis: 'z', capBot: true });
  B.paint(0x4e583a, 0.3).lathe(0, 0, 4.05, [[0.15, 0], [0.15, 0.18], [0.1, 0.18], [0.1, 0.26], [0.15, 0.26], [0.15, 0.5], [0.07, 0.5]], 12, { axis: 'z', capBot: true });
  B.paint(0x0c0c0c, 0).box(0, 0, 4.17, 0.32, 0.12, 0.07); B.box(0, 0, 4.42, 0.32, 0.12, 0.07);
  B.paint(COL, 0.3).cyl(0, 0.2, 0.6, 0.07, 0.07, 2.2, 8, 'z'); B.cyl(0, -0.17, 0.4, 0.06, 0.06, 1.6, 8, 'z');
  B.paint(COL, 0.3, 0.9).box(0, 0, -0.55, 0.36, 0.34, 0.6);
  barrel.add(mesh(B, mats.armor));
  root.add(barrel);
  // ammunition crates beside the gun (painted wood)
  const crates = new THREE.Group();
  const Cr = new Kit({ seed: seed + 9, mudTop: 0.3 });
  for (const [x, y, z, ry] of [[2.3, 0.16, 1.1, 0.1], [2.3, 0.48, 1.12, 0.06], [2.38, 0.16, 1.62, -0.05], [2.9, 0.16, 1.32, 0.2]]) {
    Cr.paint(0x5a6040, 0.6).box(x, y, z, 1.1, 0.32, 0.45, { ry, div: 0.4 });
    Cr.paint(0x3a3a30, 0.3).box(x, y + 0.165, z, 1.12, 0.012, 0.08, { ry });
  }
  crates.add(mesh(Cr, mats.armor));
  root.add(crates);
  return { kind: 'gun', root, carriage, barrel, crates, mats, muzzle: [0, 0, -4.55], cratePos: [[2.3, 1.1], [2.4, 1.6], [2.9, 1.3]] };
}
export function buildMortar(seed = 4) {
  const mats = vehicleMats(), root = new THREE.Group();
  const K = new Kit({ seed, mudTop: 0.3 });
  const COL = 0x4d5638;
  K.paint(COL, 0.6, 0.9).cyl(0, 0.04, 0.35, 0.3, 0.32, 0.08, 14);
  const tube = new THREE.Group();
  tube.position.set(0, 0.12, 0.35); tube.rotation.order = 'YXZ'; tube.rotation.x = 1.0;     // 57° up toward −z
  const Tb = new Kit({ seed: seed + 1, mudTop: 0.2 });
  Tb.at(0, 0, 0, PI).paint(COL, 0.3).lathe(0, 0, 0, [[0.06, 0], [0.055, 1.2], [0.065, 1.22], [0.065, 1.28], [0.045, 1.28]], 10, { axis: 'z', capBot: true });
  Tb.paint(0x0c0c0c, 0).cyl(0, 0, 1.275, 0.045, 0.045, 0.01, 8, 'z');
  tube.add(mesh(Tb, mats.armor));
  root.add(tube);
  // bipod and sight
  K.paint(0x3a3f2e, 0.4).rod([-0.28, 0.0, -0.35], [0, 0.68, -0.25], 0.018); K.rod([0.28, 0.0, -0.35], [0, 0.68, -0.25], 0.018);
  K.paint(0x2c2d28, 0.2).box(-0.1, 0.72, -0.2, 0.08, 0.12, 0.1);
  root.add(mesh(K, mats.armor));
  const crates = new THREE.Group();
  const Cr = new Kit({ seed: seed + 9, mudTop: 0.3 });
  for (const [x, y, z, ry] of [[0.95, 0.12, 0.9, 0.4], [1.2, 0.12, 0.4, 0.2], [1.08, 0.36, 0.7, 0.3]]) Cr.paint(0x5a6040, 0.6).box(x, y, z, 0.6, 0.24, 0.35, { ry });
  crates.add(mesh(Cr, mats.armor));
  root.add(crates);
  return { kind: 'mortar', root, barrel: tube, crates, mats, muzzle: [0, 0, -1.28], cratePos: [[1.0, 0.7]] };
}

/** Static collision boxes of the parked kinds, in local coordinates (x, y centre above the ground, z). */
export function staticColliders(kind) {
  if (kind === 'apc') return [{ x: 0, y: 0.75, z: 0, hx: 1.45, hy: 0.72, hz: 3.8 }, { x: 0, y: 1.75, z: 0.1, hx: 1.2, hy: 0.28, hz: 3.4 }, { x: 0, y: 2.25, z: -1.05, hx: 0.6, hy: 0.24, hz: 0.6 }];
  if (kind === 'gun') return [{ x: 0, y: 0.8, z: 0.05, hx: 0.85, hy: 0.8, hz: 0.75 }, { x: 0, y: 1.25, z: -1.3, hx: 0.22, hy: 0.3, hz: 0.9 }, { x: 2.5, y: 0.32, z: 1.3, hx: 0.75, hy: 0.32, hz: 0.5, flags: F.SOLID | F.VISION | F.BULLET | F.WALK }];
  if (kind === 'mortar') return [{ x: 0, y: 0.45, z: 0.0, hx: 0.3, hy: 0.45, hz: 0.45 }];
  return [];
}

// ═════════════════════════════ runtime ═════════════════════════════
const _l = { x: 0, z: 0 }, _w = { x: 0, z: 0 }, _ov = { depth: 0, nx: 0, nz: 0, face: '' };
const _hit = {}, _v3 = new THREE.Vector3();
const CELL = 4;      // physics.js spatial hash cell size

/** Key of the block of hash cells a collider centred at (cx, cz) covers (same clamping as World._each). */
function cellKey(w, c, cx, cz) {
  const b = w.bounds;
  let ix0 = Math.floor((cx - c.r - b.minX) / CELL), ix1 = Math.floor((cx + c.r - b.minX) / CELL);
  let iz0 = Math.floor((cz - c.r - b.minZ) / CELL), iz1 = Math.floor((cz + c.r - b.minZ) / CELL);
  if (ix0 < 0) ix0 = 0; if (iz0 < 0) iz0 = 0; if (ix1 >= w.nx) ix1 = w.nx - 1; if (iz1 >= w.nz) iz1 = w.nz - 1;
  return ((ix0 * 977 + ix1) * 977 + iz0) * 977 + iz1;
}
/** Move a collider and keep the world's spatial hash in step (only re-filed when it changes cells). */
function moveCollider(w, c, x, y, z, rot) {
  const before = c._cells ?? cellKey(w, c, c.x, c.z), after = cellKey(w, c, x, z);
  if (before !== after && !c.dead) {
    w.removeCollider(c); c.dead = false;          // out of the old cells…
    c.x = x; c.z = z;
    w._insert(c);                                  // …into the new ones
  }
  c._cells = after;
  c.x = x; c.y = y; c.z = z;
  if (c.rot !== rot) { c.rot = rot; c.cos = Math.cos(rot); c.sin = Math.sin(rot); }
}

export const vehicles = {
  list: [], tanks: [], guns: [], apcs: [],
  reportT: -99, reportX: 0, reportZ: 0,
  pending: [],             // delayed events: distant impacts, cook-off bangs
  fires: [],               // burning wrecks
  flying: [],              // barrels thrown by a blast
  promptT: 0,

  // ───────────────────────── build / reset ─────────────────────────
  /** Build the act's vehicles from the kit records (called after Level.finalize). */
  build(L) {
    this.reset();
    const defs = L.vehicles || [];
    let id = 0;
    for (const d of defs) {
      const v = d.kind === 'tank' ? this._makeTank(d, L) : this._makeStatic(d, L);
      v.id = id++; v.def = d;
      this.list.push(v);
    }
    L.vehicleObjs = this.list;
  },
  reset() {
    for (const v of this.list) { if (v.snd) { for (const k in v.snd) if (v.snd[k]) v.snd[k].stop(); } }
    this.list = []; this.tanks = []; this.guns = []; this.apcs = []; this.pending = []; this.fires = []; this.flying = [];
    this.reportT = -99;
  },

  _makeTank(d, L) {
    const m = buildTank(7 + this.tanks.length);
    const r0 = roundRoute(d.route.map((p) => ({ x: p[0], z: p[1], wait: p[2] ?? 0, round: p[3] })), d.round ?? 4.5, d.loop !== false);
    const k = {
      kind: 'tank', model: m, alive: true, immobile: false, route: r0, loop: d.loop !== false, reverse: !!d.reverse,
      x: r0[0].x, z: r0[0].z, y: 0, yaw: d.yaw ?? yawTo(r0[0].x, r0[0].z, r0[1].x, r0[1].z), speed: 0, turn: 0, pitch: 0, roll: 0,
      wi: 1, dir: 1, waitT: r0[0].wait, turretRel: 0, gunElev: 0.02, scanYaw: d.scanYaw ?? null, sweepT: 0,
      state: 'patrol', stateT: 0, meter: 0, seen: false, lastSeenT: -99, knowT: -99, lkx: 0, lkz: 0, hiddenT: 0, coverPt: null, glimpse: false,
      respond: -1, holding: false, backward: false, world: L.world, thinkT: 0, mg: { aimT: 0, burst: 0, shotT: 0, pauseT: 0 }, gunCd: 4, tellT: 0, tellX: 0, tellY: 0, tellZ: 0, recoilT: 0,
      sectors: d.sectors || [], exhaustT: 0, sndT: 0, snd: null, toastT: -99, tellToastT: -99, immSide: 0,
      beamObj: { x: 0, y: 0, z: 0, yaw: 0, torchOn: false, dead: false },
    };
    k.y = L.gy(k.x, k.z);
    // three moving boxes: lower hull with the tracks, upper hull with the fuel drums, turret
    const w = L.world;
    k.cols = {
      lower: w.addBox({ x: k.x, y: k.y + 0.525, z: k.z, hx: TK.hw, hy: 0.475, hz: TK.hlF, rot: k.yaw, flags: ARMOR_FLAGS, mat: 'armor', tag: 'tank' }),
      upper: w.addBox({ x: k.x, y: k.y + 1.225, z: k.z, hx: TK.hw - 0.05, hy: 0.225, hz: (2.6 + TK.hlR) / 2, rot: k.yaw, flags: ARMOR_FLAGS, mat: 'armor', tag: 'tank' }),
      turret: w.addBox({ x: k.x, y: k.y + 1.8, z: k.z, hx: TK.turretR, hy: 0.35, hz: TK.turretR + 0.1, rot: k.yaw, flags: ARMOR_FLAGS, mat: 'armor', tag: 'tank' }),
    };
    for (const c in k.cols) k.cols[c].veh = k;
    L.group.add(m.root);
    L.beams.push(k.beamObj);
    this.tanks.push(k);
    this._placeTank(k, 0);
    return k;
  },
  _makeStatic(d, L) {
    const m = d.kind === 'apc' ? buildApc(11 + this.apcs.length) : d.kind === 'gun' ? buildHowitzer(13 + this.guns.length) : buildMortar(17 + this.guns.length);
    m.root.position.set(d.x, d.y, d.z); m.root.rotation.y = d.rot;
    // sit on the slope
    const c = Math.cos(d.rot), s = Math.sin(d.rot), gy = (lx, lz) => L.gy(d.x + lx * c + lz * s, d.z - lx * s + lz * c);
    const a = d.kind === 'apc' ? 2.6 : 1.4, b = d.kind === 'apc' ? 1.2 : 1.0;
    m.root.rotation.x = Math.atan2(gy(0, -a) - gy(0, a), 2 * a); m.root.rotation.z = Math.atan2(gy(b, 0) - gy(-b, 0), 2 * b);
    m.root.updateMatrixWorld(true);
    L.group.add(m.root);
    const v = { kind: d.kind, model: m, alive: true, x: d.x, z: d.z, y: d.y, yaw: d.rot, cols: d.cols || [], fireT: 0, recoil: 0, snd: null };
    for (const col of v.cols) col.veh = v;
    if (d.kind === 'apc') this.apcs.push(v);
    else {
      const per = d.kind === 'mortar' ? ART.mortarPeriod : ART.period;
      v.fireT = per[0] * 0.3 + (per[1] - per[0]) * ((this.guns.length * 0.37) % 1);
      this.guns.push(v);
    }
    return v;
  },

  // ───────────────────────── checkpoints ─────────────────────────
  snapshot() { return this.list.map((v) => ({ a: v.alive ? 1 : 0, im: v.immobile ? 1 : 0, x: +(v.x || 0).toFixed(1), z: +(v.z || 0).toFixed(1) })); },
  /** Destroyed stays destroyed; a live tank restarts at a route point clear of the player. */
  restore(arr, player) {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < this.list.length && i < arr.length; i++) {
      const v = this.list[i], s = arr[i];
      if (!s) continue;
      if (!s.a) { this._destroy(v, { silent: true }); continue; }
      if (v.kind !== 'tank') continue;
      const n = v.route.length, j = respawnIndex(v.route, s.x, s.z, player.x, player.z);
      v.x = v.route[j].x; v.z = v.route[j].z;
      if (v.loop) { v.wi = (j + 1) % n; v.dir = 1; } else { v.dir = j < n - 1 ? 1 : -1; v.wi = j + v.dir; }
      const nx = v.route[v.wi];
      v.yaw = v.reverse && v.dir < 0 ? yawTo(nx.x, nx.z, v.x, v.z) : yawTo(v.x, v.z, nx.x, nx.z);
      v.speed = 0; v.waitT = 2;
      if (s.im) this._immobilize(v, { silent: true });
      this._placeTank(v, 0);
    }
  },

  // ───────────────────────── per step ─────────────────────────
  update(dt) {
    if (!this.list.length) return;
    for (const k of this.tanks) this._tank(k, dt);
    for (const a of this.apcs) if (a.pop) this._settleTurret(a, dt);
    for (const g of this.guns) this._gun(g, dt);
    this._pending(dt);
    this._burn(dt);
    this._fly(dt);
    this._prompt();
  },

  _tank(k, dt) {
    const m = k.model;
    if (!k.alive) { this._settleTurret(k, dt); return; }
    k.stateT += dt;
    k.thinkT -= dt;
    if (k.thinkT <= 0) { k.thinkT += 1 / TK.thinkHz; this._think(k, 1 / TK.thinkHz); }
    // ── drive
    let stop = k.immobile || k.tellT > 0, back = false;
    if (!stop) {
      if (k.state === 'patrol') {
        if (k.waitT > 0) { k.waitT -= dt; stop = true; }
        back = k.reverse && k.dir < 0;
      } else {
        // alerted: hold still while it has the player in its sights, else move along the route to the point nearest the trouble
        if (k.seen || (k.glimpse && k.state === 'alert') || k.holding) stop = true;
        back = k.backward;
      }
    }
    const target = k.route[k.wi];
    const ox = k.x, oz = k.z, oyaw = k.yaw;
    const d = driveStep(k, target.x, target.z, dt, target.slow || k.state !== 'patrol', stop, back);
    if (target && !stop && d < TK.arrive) this._arrived(k);
    // track speeds for the running gear (pivot turns spin the tracks against each other)
    const v = Math.hypot(k.x - ox, k.z - oz) / dt * (k.speed < 0 ? -1 : 1), w = angDelta(oyaw, k.yaw) / dt;
    this._placeTank(k, dt, v - w * TANKG.trackX, v + w * TANKG.trackX);
    this._contact(k, dt);
    this._turret(k, dt);
    this._weapons(k, dt);
    this._effects(k, dt);
  },

  _arrived(k) {
    const n = k.route.length;
    if (k.state === 'patrol') {
      const here = k.route[k.wi];
      k.waitT = here.wait || 0;
      if (k.loop) k.wi = (k.wi + 1) % n;
      else {
        if (k.wi + k.dir >= n || k.wi + k.dir < 0) k.dir = -k.dir;
        k.wi += k.dir;
      }
      return;
    }
    if (k.wi === k.respond) { k.holding = true; return; }          // there: hold and fight
    this._stepTo(k, k.respond);
  },
  /** Head for the next route point toward index `to` (reversing along an open route when it can). */
  _stepTo(k, to) {
    const nx = stepToward(k.route.length, k.wi, to, k.loop);
    k.backward = k.reverse && nx < k.wi;
    k.wi = nx;
  },
  /** Respond to trouble near (lkx, lkz): drive along the route to the point nearest it, the short way round. */
  _retarget(k) {
    const n = k.route.length, target = nearestPoint(k.route, k.lkx, k.lkz);
    if (target === k.respond) return;
    k.respond = target;
    if (k.holding) { k.holding = false; if (k.wi === target) { k.holding = true; return; } this._stepTo(k, target); return; }
    // on a segment: carry on to its end, or turn back to its start if that is nearer the trouble
    const prevI = k.loop ? (k.wi - 1 + n) % n : clamp(k.wi - (k.dir || 1), 0, n - 1);
    const dist = (i) => k.loop ? Math.min((target - i + n) % n, (i - target + n) % n) : Math.abs(target - i);
    if (dist(prevI) < dist(k.wi)) { k.backward = k.reverse && prevI < k.wi; k.wi = prevI; }
    else k.backward = k.reverse && k.wi < prevI;
    k.waitT = 0;
  },

  /** Root transform, colliders, beam proxy and the running gear for the current position. */
  _placeTank(k, dt, vL = 0, vR = 0) {
    const w = k.world, m = k.model;
    k.y = w.h(k.x, k.z);
    const hf = groundAt(w, k, 0, -2.6), hr = groundAt(w, k, 0, 2.6), hl = groundAt(w, k, -1.4, 0), hrt = groundAt(w, k, 1.4, 0);
    k.pitch = Math.atan2(hf - hr, 5.2); k.roll = Math.atan2(hrt - hl, 2.8) + (k.immobile ? k.immSide * 0.035 : 0);
    k.y = Math.max(k.y, (hf + hr + hl + hrt) / 4);
    m.root.position.set(k.x, k.y, k.z);
    m.root.rotation.set(k.pitch, k.yaw, k.roll);
    const c = Math.cos(k.yaw), s = Math.sin(k.yaw);
    const zu = (TK.hlR - 2.6) / 2;
    moveCollider(w, k.cols.lower, k.x, k.y + 0.525, k.z, k.yaw);
    moveCollider(w, k.cols.upper, k.x + zu * s, k.y + 1.225, k.z + zu * c, k.yaw);
    const tz = TK.turretZ;
    moveCollider(w, k.cols.turret, k.x + tz * s, k.y + 1.8, k.z + tz * c, k.yaw + k.turretRel);
    const lz = TANKG.lamp[2] - 0.3, b = k.beamObj;
    b.x = k.x + lz * s; b.z = k.z + lz * c; b.y = k.y - 0.3; b.yaw = k.yaw;
    if (dt > 0) poseTank(m, dt, k.immobile && k.immSide < 0 ? 0 : vL, k.immobile && k.immSide > 0 ? 0 : vR, k.turretRel, k.gunElev);
    else poseTank(m, 0, 0, 0, k.turretRel, k.gunElev);
  },

  /** The tank as a moving solid: shove the player and soldiers out of its way; the player can be run over. */
  _contact(k, dt) {
    const p = G.player, pb = p.body, C2 = TK.crush;
    if (!p.dead && pb.y < k.y + TK.hullTop + 0.2) {
      toLocal(pb.x, pb.z, k.x, k.z, k.yaw, _l);
      const r = pb.radius;
      if (footprintOverlap(_l.x, _l.z, r, _ov) > 0) {
        const lead = (k.speed > C2.minSpeed && _ov.face === 'front') || (k.speed < -C2.minSpeed && _ov.face === 'rear');
        G.world.move(pb, 0, 0);                                       // the physics pushes him out of the hull
        toLocal(pb.x, pb.z, k.x, k.z, k.yaw, _l);
        const pinned = footprintOverlap(_l.x, _l.z, r - 0.1, _ov) > 0;
        const dm = G.mission.diff.damageMult;
        if (pinned || (lead && p.stance === 2)) p.takeDamage(C2.crushDps * dt, k.x, k.z, 'crush');
        else if (lead) { p.takeDamage(C2.contactDps * dm * dt, k.x, k.z, 'crush'); p.shake = Math.max(p.shake, 0.5); }
      }
    }
    for (const e of G.enemies) {
      if (e.gone || e.dragged || e.fixed) continue;
      toLocal(e.x, e.z, k.x, k.z, k.yaw, _l);
      if (Math.abs(_l.x) > TK.hw + 1 || _l.z < -TK.hlF - 1 || _l.z > TK.hlR + 1) continue;
      const depth = footprintOverlap(_l.x, _l.z, 0.32, _ov);
      if (depth <= 0) continue;
      // aside, off the side the soldier is on, rather than ahead of the tank
      const nx = _ov.face === 'side' ? _ov.nx : (_l.x < 0 ? -1 : 1), push = _ov.face === 'side' ? depth : Math.min(depth, TK.hw + 0.32 - Math.abs(_l.x));
      const c = Math.cos(k.yaw), s = Math.sin(k.yaw), wx = nx * push * c, wz = -nx * push * s;
      e.x += wx; e.z += wz; if (e.loco) { e.loco.x = e.x; e.loco.z = e.z; }
      if (!e.alive) e.y = G.world.h(e.x, e.z);
    }
  },

  // ───────────────────────── perception and state ─────────────────────────
  _think(k, dt) {
    const p = G.player, T = TK, diff = G.mission.diff, now = G.simTime, w = G.world;
    // ── what the crew sees
    let rate = 0, seen = false;
    const d = dist2D(k.x, k.z, p.x, p.z);
    if (!p.dead && !G.noDetect) {
      toLocal(p.x, p.z, k.x, k.z, k.yaw, _l);
      const off = crewSight(_l.x, _l.z, k.turretRel);
      if (off >= 0) {
        const al = k.state === 'combat' ? 2 : k.state === 'alert' ? 1 : 0;
        const range = sightRange(R.fogFactor(), p.light) * T.rangeMult * (al === 2 ? 1.6 : al === 1 ? 1.3 : 1);
        const ey = k.y + T.eyeY, ex = k.x + Math.sin(k.yaw) * T.turretZ, ez = k.z + Math.cos(k.yaw) * T.turretZ;
        if (d < range && (w.los(ex, ey, ez, p.x, p.eyeY(), p.z) || w.los(ex, ey, ez, p.x, p.y + p.eye * 0.55, p.z))) {
          const vis = visibility(p.stance, p.speedFrac, p.light, p.inFoliage);
          rate = crewDetectionRate({ dist: d, range, off, vis, diffMult: diff.detectMult, alert: al });
          seen = rate > 0;
        }
      }
    }
    k.seen = seen;
    k.meter = stepMeter(k.meter, rate, seen, dt);
    if (seen && k.meter >= STEALTH.suspiciousAt) { k.lkx = p.x; k.lkz = p.z; k.knowT = now; }
    if (k.state !== 'combat') {
      if (k.meter >= STEALTH.spottedAt) { this._enter(k, 'combat'); k.lastSeenT = now; ai.alertFrom(k.x, k.z, p.x, p.z, this._sectorOf(k)); }
      else if (seen && k.meter >= STEALTH.suspiciousAt && k.state === 'patrol') { this._enter(k, 'alert'); k.glimpse = true; if (now - k.toastT > 25) { k.toastT = now; bus.emit('toast', t('tankNotice'), 'warn'); } }
    } else if (seen) { k.lastSeenT = now; }
    // ── what the soldiers around it know (sector link), and the reverse
    let fight = null, search = null;
    for (const e of G.enemies) {
      if (!e.alive) continue;
      if (!(k.sectors.includes(e.sector) || dist2D(e.x, e.z, k.x, k.z) < T.linkRadius)) continue;
      if (e.state === 'combat') { fight = e; break; }
      if (e.state === 'searching' && !search) search = e;
    }
    if (fight) {
      if (k.state !== 'combat') this._enter(k, 'combat');
      if (now - k.knowT > 1.5) { k.lkx = fight.lkx; k.lkz = fight.lkz; if (fight.seen) k.knowT = now; }
      k.calmT = 0;
    } else if (search && k.state === 'patrol') { k.lkx = search.lkx; k.lkz = search.lkz; this._enter(k, 'alert'); k.glimpse = false; }
    // ── winding down
    if (k.state === 'combat' && !fight && now - k.lastSeenT > diff.loseSight * 2 && now - k.knowT > diff.loseSight) this._enter(k, 'alert');
    else if (k.state === 'alert' && !search && !fight && k.stateT > (k.glimpse ? T.alertLook : diff.searchTime)) this._enter(k, 'patrol');
    if (k.state !== 'patrol' && !seen && !k.immobile) this._retarget(k);
    // ── a known hiding place: the line from the turret to where he was seen ends in hard cover next to it
    if (k.state === 'combat' && !seen && now - k.lastSeenT < T.gun.memory) {
      const ey = k.y + T.eyeY, ex = k.x, ez = k.z, ty = w.h(k.lkx, k.lkz) + 1.0;
      const dx = k.lkx - ex, dy = ty - ey, dz = k.lkz - ez, L = Math.hypot(dx, dy, dz);
      if (L > 1 && w.raycast(ex, ey, ez, dx / L, dy / L, dz / L, L + 1, F.VISION, _hit, k.cols.turret) && dist2D(_hit.x, _hit.z, k.lkx, k.lkz) < 6 && !(_hit.collider && _hit.collider.veh === k)) {
        // the shell is laid to burst on the top of that cover, over where he went to ground
        k.hiddenT += dt; k.coverPt = k.coverPt || {}; k.coverPt.x = k.lkx; k.coverPt.y = ty + 1.0; k.coverPt.z = k.lkz;
      } else k.hiddenT = 0;
    } else k.hiddenT = 0;
  },
  _enter(k, st) {
    const prev = k.state;
    k.state = st; k.stateT = 0;
    if (st === 'patrol') {
      k.meter = Math.min(k.meter, 0.2); k.respond = -1; k.holding = false; k.glimpse = false;
      // carry on with the patrol from where it is
      const n = k.route.length, i = nearestPoint(k.route, k.x, k.z);
      if (Math.hypot(k.route[i].x - k.x, k.route[i].z - k.z) > TK.arrive * 2) k.wi = i;
      else if (k.loop) k.wi = (i + 1) % n;
      else { if (i + k.dir >= n || i + k.dir < 0) k.dir = -k.dir; k.wi = i + k.dir; }
      k.backward = false;
      return;
    }
    if (prev === 'patrol') { k.respond = -1; k.holding = false; this._retarget(k); }
    if (st === 'combat' && prev !== 'combat') k.mg.aimT = TK.mg.aimTime;
  },
  _sectorOf(k) { const s = G.level && G.level.sectorAt(k.x, k.z); return s ? s.id : (k.sectors[0] ?? 0); },

  /** Noise the crew can hear over its own engine: shots, explosions, rounds pinging off the armour. */
  onNoise(evt) {
    if (evt.byEnemy || !this.tanks.length) return;
    for (const k of this.tanks) {
      if (!k.alive) continue;
      const d = dist2D(k.x, k.z, evt.x, evt.z);
      let heard = false, ex = evt.x, ez = evt.z;
      if (evt.kind === 'impact' && d < TK.hw + 2.5) { heard = true; ex = G.player.x + (G.rng() - 0.5) * 12; ez = G.player.z + (G.rng() - 0.5) * 12; }
      else if ((evt.kind === 'shot' || evt.kind === 'explosion' || evt.kind === 'flash') && d < evt.radius * 0.7) { heard = true; ex += (G.rng() - 0.5) * d * 0.25; ez += (G.rng() - 0.5) * d * 0.25; }
      if (!heard) continue;
      if (k.state === 'patrol') { k.lkx = ex; k.lkz = ez; this._enter(k, 'alert'); k.glimpse = evt.kind === 'impact'; }
      else if (k.state === 'alert' && now() - k.knowT > 2) { k.lkx = ex; k.lkz = ez; k.stateT = 0; }
    }
  },

  /**
   * ai.js asks this for every noise a soldier would hear: true when the sound is
   * lost to him — a footstep under the tank's engine, or the player's shot under
   * an artillery report.
   */
  masks(evt, lx, lz, loud) {
    if (evt.kind === 'step' || evt.kind === 'land') {
      for (const k of this.tanks) {
        if (!k.alive) continue;
        if (stepMasked(loud, engineLoudness(dist2D(lx, lz, k.x, k.z), Math.abs(k.speed) / TK.speed))) return true;
      }
      return false;
    }
    if ((evt.kind === 'shot' || evt.kind === 'shot_suppressed') && evt.byPlayer && this.reportT > -50) {
      return dist2D(evt.x, evt.z, this.reportX, this.reportZ) < ART.coverRadius && shotCovered(G.simTime - this.reportT, dist2D(lx, lz, evt.x, evt.z));
    }
    return false;
  },

  // ───────────────────────── turret and weapons ─────────────────────────
  _turret(k, dt) {
    const p = G.player, T = TK;
    let want, rate;
    if (k.tellT > 0) { want = k.turretRel; rate = 0; }
    else if (k.state === 'patrol') {
      k.sweepT += dt;
      const centre = k.scanYaw === null ? 0 : angDelta(k.yaw, k.scanYaw);
      want = centre + Math.sin(k.sweepT * PI * 2 / T.sweepPeriod) * T.sweepArc; rate = T.sweepRate;
    } else {
      const tx = k.seen ? p.x : k.lkx, tz = k.seen ? p.z : k.lkz;
      want = angDelta(k.yaw, yawTo(k.x, k.z, tx, tz));
      if (k.state === 'alert' && !k.seen) want += Math.sin(k.stateT * 0.5) * 0.35;
      rate = T.trackRate;
    }
    const err = angDelta(k.turretRel, want);
    k.turretRel = wrapPi(k.turretRel + clamp(err, -rate * dt, rate * dt));
    // gun elevation toward the target
    let el = 0.02;
    if (k.state !== 'patrol') {
      const tx = k.seen ? p.x : k.lkx, tz = k.seen ? p.z : k.lkz, ty = (k.seen ? p.y : G.world.h(tx, tz)) + 0.9;
      el = clamp(Math.atan2(ty - (k.y + TANKG.pivot[1] + TANKG.trunnion[1]), Math.max(2, dist2D(k.x, k.z, tx, tz))), T.elevMin, T.elevMax);
    }
    k.gunElev += clamp(el - k.gunElev, -0.3 * dt, 0.3 * dt);
    k.model.turret.rotation.y = k.turretRel;
    k.model.gun.rotation.x = k.gunElev;
    k.turretErr = Math.abs(err);
  },

  _weapons(k, dt) {
    const p = G.player, now = G.simTime, M = TK.mg, GN = TK.gun, sanct = G.level.sanctuary;
    k.gunCd -= dt;
    if (k.recoilT > 0) { k.recoilT = Math.max(0, k.recoilT - dt); k.model.recoil = k.recoilT > 0.6 ? (0.8 - k.recoilT) / 0.2 : k.recoilT / 0.6; }
    if (k.state !== 'combat' || p.dead) { k.tellT = 0; return; }
    // ── main gun: the tell, then the shell
    if (k.tellT > 0) {
      k.tellT -= dt;
      if (k.tellT <= 0) this._fireMain(k);
      return;
    }
    if (k.coverPt && mainGunReady(k.hiddenT, now - k.lastSeenT, dist2D(k.x, k.z, k.coverPt.x, k.coverPt.z), k.gunCd) && k.turretErr < 0.05
      && !fireForbidden(sanct, k.x, k.z, k.coverPt.x, k.coverPt.z)) {
      k.tellT = GN.tell; k.tellX = k.coverPt.x; k.tellY = k.coverPt.y; k.tellZ = k.coverPt.z;
      this._muzzle(k, 'main', _v3);
      audio.play('tank_tell', { x: _v3.x, y: _v3.y, z: _v3.z, vol: 1, ref: 12 });
      if (now - k.tellToastT > 8) { k.tellToastT = now; bus.emit('toast', t('tankAim'), 'warn'); }
      return;
    }
    // ── coaxial machine gun
    const mg = k.mg, blind = now - k.lastSeenT;
    const canFire = k.seen || blind < M.suppress;
    if (!canFire) { mg.aimT = Math.max(mg.aimT, 0.4); return; }
    if (k.turretErr > M.aimTol) return;
    if (mg.aimT > 0) { mg.aimT -= dt; return; }
    if (mg.pauseT > 0) { mg.pauseT -= dt; return; }
    mg.shotT -= dt;
    if (mg.shotT > 0) return;
    const tx0 = k.seen ? p.x : k.lkx, tz0 = k.seen ? p.z : k.lkz, d = dist2D(k.x, k.z, tx0, tz0);
    if (d > M.range || fireForbidden(sanct, k.x, k.z, tx0, tz0)) return;
    if (mg.burst <= 0) mg.burst = M.burst[0] + Math.floor(G.rng() * (M.burst[1] - M.burst[0] + 1));
    mg.shotT = M.interval; mg.burst--;
    if (mg.burst <= 0) mg.pauseT = M.pause[0] + G.rng() * (M.pause[1] - M.pause[0]);
    this._muzzle(k, 'coax', _v3);
    const mx = _v3.x, my = _v3.y, mz = _v3.z;
    audio.play('mg_tank', { x: mx, y: my, z: mz, vol: 0.95, ref: 10, rate: 0.95 + G.rng() * 0.08, low: true });
    R.flashAt(mx, my, mz, 3, 8, 0.04);
    let tx = tx0, ty = (k.seen ? p.y : G.world.h(tx0, tz0)) + 1.0, tz = tz0;
    const hitP = k.seen && G.rng() < this._hitChance(k, d);
    if (!hitP) { tx += (G.rng() - 0.5) * 2.6; ty += (G.rng() - 0.35) * 1.6; tz += (G.rng() - 0.5) * 2.6; }
    let dx = tx - mx, dy = ty - my, dz = tz - mz;
    const len = Math.hypot(dx, dy, dz); dx /= len; dy /= len; dz /= len;
    if (G.world.raycast(mx, my, mz, dx, dy, dz, len, F.BULLET, _hit, k.cols.turret)) {
      fx.tracer(mx, my, mz, _hit.x, _hit.y, _hit.z, 0xffc890);
      fx.impact(_hit.x, _hit.y, _hit.z, _hit.nx, _hit.ny, _hit.nz, _hit.mat);
      if (dist2D(_hit.x, _hit.z, p.x, p.z) < 4) audio.play('impact', { x: _hit.x, y: _hit.y, z: _hit.z, vol: 0.6, low: true });
      return;
    }
    fx.tracer(mx, my, mz, tx, ty, tz, 0xffc890);
    if (hitP) p.takeDamage(M.damage * G.mission.diff.damageMult * (0.85 + G.rng() * 0.3), k.x, k.z, 'bullet');
    else if (k.seen) audio.play('whiz', { x: tx, y: ty, z: tz, vol: 0.5, low: true });
  },
  _hitChance(k, d) {
    const p = G.player;
    let c = G.mission.diff.accuracy * TK.mg.accuracy / (1 + Math.pow(d / 70, 2));
    c *= p.stance === 2 ? 0.55 : p.stance === 1 ? 0.8 : 1;
    if (p.sprinting) c *= 0.7;
    if (p.inFoliage) c *= 0.75;
    if (G.world.inSmoke(p.x, p.y + 1, p.z)) c *= 0.2;
    return clamp01(c * 0.55);
  },
  /** World position of the coaxial MG or the main gun's muzzle. */
  _muzzle(k, which, out) {
    const ty = k.yaw + k.turretRel, c = Math.cos(ty), s = Math.sin(ty), pv = TANKG.pivot;
    const px = k.x + Math.sin(k.yaw) * pv[2], pz = k.z + Math.cos(k.yaw) * pv[2], py = k.y + pv[1];
    let lx, ly, lz;
    if (which === 'coax') { lx = TANKG.coax[0]; ly = TANKG.coax[1]; lz = TANKG.coax[2]; }
    else { const tr = TANKG.trunnion, L = TANKG.barrel; lx = 0; ly = tr[1] + Math.sin(k.gunElev) * L; lz = tr[2] - Math.cos(k.gunElev) * L; }
    out.set(px + lx * c + lz * s, py + ly, pz - lx * s + lz * c);
    return out;
  },
  _fireMain(k) {
    const p = G.player, GN = TK.gun;
    this._muzzle(k, 'main', _v3);
    const mx = _v3.x, my = _v3.y, mz = _v3.z;
    let tx = k.tellX, ty = k.tellY, tz = k.tellZ;
    let dx = tx - mx, dy = ty - my, dz = tz - mz;
    const len = Math.hypot(dx, dy, dz); dx /= len; dy /= len; dz /= len;
    if (G.world.raycast(mx, my, mz, dx, dy, dz, len + 1.5, F.BULLET, _hit, k.cols.turret)) { tx = _hit.x - dx * 0.2; ty = _hit.y - dy * 0.2; tz = _hit.z - dz * 0.2; }
    audio.play('tank_gun', { x: mx, y: my, z: mz, vol: 1, ref: 24 });
    for (let i = 0; i < 6; i++) fx.puff(mx + dx * i * 0.5, my + dy * i * 0.5, mz + dz * i * 0.5, { size: 1.4 + i * 0.4, color: 0x9a968c, life: 2.4, grow: 0.8, rise: 0.4, opacity: 0.6, vx: dx * 2, vz: dz * 2 });
    fx.puff(mx, my, mz, { size: 2.2, color: 0xffc27a, life: 0.12, grow: 4, rise: 0, opacity: 1, add: true });
    for (let i = 0; i < 5; i++) { const a = i * 1.26; fx.puff(k.x + Math.cos(a) * 2.6, k.y + 0.3, k.z + Math.sin(a) * 2.6, { size: 1.8, color: 0x9a8f7a, life: 1.8, grow: 1.2, rise: 0.3, opacity: 0.45, vx: Math.cos(a) * 2, vz: Math.sin(a) * 2 }); }
    fx.tracer(mx, my, mz, tx, ty, tz, 0xfff0c0, 0.06);
    k.recoilT = 0.8; k.gunCd = GN.cooldown; k.hiddenT = 0;
    // the shell: blast at the impact, nothing in the level is destroyed
    fx.explosion(tx, ty - 0.4, tz, GN.radius);
    R.flashAt(tx, ty, tz, 16, GN.radius * 3, 0.16);
    audio.play('explosion', { x: tx, y: ty, z: tz, vol: 1, ref: 16 });
    noise.emit({ x: tx, y: ty, z: tz, radius: NOISE.explosion, kind: 'explosion', byEnemy: true, time: G.simTime });
    const dd = Math.hypot(p.x - tx, p.y + 0.9 - ty, p.z - tz);
    if (dd < GN.radius * 2) p.shake = Math.max(p.shake, GN.shake * (1 - dd / (GN.radius * 2)));
    const dmg = shellDamage(dd, G.world.los(tx, ty + 0.2, tz, p.x, p.y + 1, p.z), G.mission.diff.damageMult);
    if (dmg > 0) p.takeDamage(dmg, k.x, k.z, 'blast');
  },

  // ───────────────────────── looks and sound ─────────────────────────
  _effects(k, dt) {
    const m = k.model, cam = G.camera ? G.camera.position : null;
    const night = R.lightLevel < 0.45, lit = night && k.alive;
    m.glow.visible = lit; m.beam.visible = lit && !k.immobile;
    m.spot.intensity = lit ? 55 : 0;
    k.beamObj.torchOn = lit; k.beamObj.dead = !k.alive;
    const near = cam ? dist2D(cam.x, cam.z, k.x, k.z) : 0;
    // exhaust
    k.exhaustT -= dt;
    if (k.exhaustT <= 0 && near < 70) {
      const moving = Math.abs(k.speed) > 0.3;
      k.exhaustT = moving ? TK.exhaust.moving : TK.exhaust.idle;
      const e = TANKG.exhaust, c = Math.cos(k.yaw), s = Math.sin(k.yaw);
      const ex = k.x + e[0] * c + e[2] * s, ez = k.z - e[0] * s + e[2] * c;
      fx.puff(ex, k.y + e[1], ez, puffOpts(0.5 + G.rng() * 0.3, moving ? 0x4a4844 : 0x6a6864, 1.4, 1.6, 0.6, moving ? 0.45 : 0.3, -c * 1.4, s * 1.4, false));
    }
    // engine and tracks, positioned in 3D, loud enough to carry a street away
    k.sndT -= dt;
    if (k.sndT <= 0) {
      k.sndT = 0.1;
      if (!k.snd && audio.ready) k.snd = { engine: audio.loop3d('tank_engine', { ref: 9, roll: 0.9 }), tracks: audio.loop3d('tank_tracks', { ref: 7, roll: 1 }) };
      if (k.snd) {
        const sp = Math.min(1, Math.abs(k.speed) / TK.speed), turning = Math.min(1, Math.abs(k.turn) * 2);
        const ex = k.x + Math.sin(k.yaw) * 2, ez = k.z + Math.cos(k.yaw) * 2;
        if (k.snd.engine) k.snd.engine.set(ex, k.y + 1.2, ez, k.alive ? 0.75 + sp * 0.25 : 0, 0.85 + sp * 0.3 + turning * 0.1);
        if (k.snd.tracks) k.snd.tracks.set(k.x, k.y + 0.4, k.z, k.alive ? Math.max(sp, turning * 0.6) * 0.95 : 0, 0.65 + Math.max(sp, turning * 0.5) * 0.6);
      }
    }
  },

  // ───────────────────────── damage ─────────────────────────
  /** A C4 charge rides with the vehicle it was stuck to: re-parent it in the vehicle's frame. */
  attachCharge(veh, c) {
    veh.model.root.updateMatrixWorld(true);
    veh.model.root.attach(c.mesh);
    c.veh = veh;
  },
  /** Every explosion (equipment._explode). Only C4 matters to armour. */
  onBlast(o) {
    if (o.kind !== 'c4') return;
    for (const k of this.tanks) {
      if (!k.alive) continue;
      if (o.veh === k) {
        const zone = chargeZone(o.lx, o.ly, o.lz);
        if (chargeEffect(zone) === 'destroy') this._destroy(k); else this._immobilize(k, { side: o.lx < 0 ? -1 : 1 });
        continue;
      }
      // a charge on the ground under the tracks
      toLocal(o.x, o.z, k.x, k.z, k.yaw, _l);
      if (o.y < k.y + 1.0 && footprintOverlap(_l.x, _l.z, 0.5, _ov) > 0) this._immobilize(k, { side: _l.x < 0 ? -1 : 1 });
    }
    for (const g of this.guns) if (g.alive && (o.veh === g || dist2D(o.x, o.z, g.x, g.z) < ART.destroyRadius)) this._destroy(g);
    for (const a of this.apcs) if (a.alive && (o.veh === a || dist2D(o.x, o.z, a.x, a.z) < VEHICLES.apc.destroyRadius)) this._destroy(a);
  },
  _immobilize(k, o = {}) {
    if (!k.alive || k.immobile) return;
    k.immobile = true; k.immSide = o.side || 1; k.speed = 0;
    k.model.tracks[k.immSide < 0 ? 0 : 1].position.y = -0.06;
    if (o.silent) return;
    const c = Math.cos(k.yaw);
    fx.puff(k.x + k.immSide * 1.8 * c, k.y + 0.5, k.z - k.immSide * 1.8 * Math.sin(k.yaw), { size: 2.4, color: 0x5a554e, life: 3, grow: 0.8, rise: 0.6, opacity: 0.7 });
    audio.play('track_snap', { x: k.x, y: k.y + 0.5, z: k.z, vol: 1, ref: 8 });
    bus.emit('toast', t('tankTrack'), 'warn');
    bus.emit('radio', 'r_tankTrack');
    // the crew knows exactly where that came from
    const p = G.player; k.lkx = p.x; k.lkz = p.z; k.knowT = G.simTime;
    if (k.state !== 'combat') this._enter(k, 'combat');
  },
  /** Destroy a vehicle or gun: the big bang, the wreck, the fire; o.silent for a checkpoint restore. */
  _destroy(v, o = {}) {
    if (!v.alive) return;
    v.alive = false;
    const m = v.model, silent = !!o.silent;
    m.mats.armor.color.setHex(0x3a3631); m.mats.armor.roughness = 1; m.mats.armor.metalness = 0.1;
    if (m.mats.trackL) { m.mats.trackL.color.setHex(0x4a4642); m.mats.trackR.color.setHex(0x4a4642); }
    if (m.glow) m.glow.visible = false;
    if (m.beam) m.beam.visible = false;
    if (m.spot) m.spot.intensity = 0;
    if (v.snd) { for (const s in v.snd) if (v.snd[s]) v.snd[s].stop(); v.snd = null; }
    if (v.beamObj) { v.beamObj.dead = true; v.beamObj.torchOn = false; }
    if (v.kind === 'tank' || v.kind === 'apc') {
      // the turret lifts off and drops back askew
      v.pop = silent ? null : { t: 0, y: 0, vy: v.kind === 'tank' ? 8.5 : 6, rx: 0, rz: 0, wx: (G.rng() - 0.5) * 1.6, wz: (G.rng() - 0.5) * 1.6, spin: (G.rng() - 0.5) * 2.4 };
      if (silent) { m.turret.position.y += 0.06; m.turret.rotation.x = 0.12; m.turret.rotation.z = -0.18; m.turret.rotation.y += 0.7; }
      v.speed = 0;
    } else if (!silent) {
      // the barrel is thrown off the carriage
      const b = m.barrel; b.updateMatrixWorld(true);
      G.level.group.attach(b);
      this.flying.push({ obj: b, vx: (G.rng() - 0.5) * 5, vy: 6 + G.rng() * 2, vz: (G.rng() - 0.5) * 5, wx: (G.rng() - 0.5) * 5, wz: (G.rng() - 0.5) * 5, t: 0 });
      for (let i = 0; i < ART.cookoff.length; i++) {
        const cp = m.cratePos[i % m.cratePos.length], c = Math.cos(v.yaw), s = Math.sin(v.yaw);
        this.pending.push({ t: ART.cookoff[i], kind: 'cook', x: v.x + cp[0] * c + cp[1] * s + (G.rng() - 0.5), z: v.z - cp[0] * s + cp[1] * c + (G.rng() - 0.5), y: v.y + 0.4, v });
      }
    } else {
      m.barrel.rotation.x = -0.25; m.barrel.position.y = 0.3; m.barrel.position.x = 1.2; m.barrel.rotation.y = 0.6;
      m.crates.visible = false;
    }
    // fire and smoke from the wreck
    const L = G.level, fy = v.y + (v.kind === 'tank' ? 1.7 : v.kind === 'apc' ? 2.0 : 0.8);
    const lamp = { x: v.x, y: fy + 0.6, z: v.z, r: VEHICLES.wreck.fireR, i: VEHICLES.wreck.fireI * (v.kind === 'mortar' ? 0.6 : 1), flicker: true, color: 0xff8a3a };
    L.lamps.push(lamp); if (R.lamps !== L.lamps) R.lamps.push(lamp); R._lampTimer = 0;
    const fire = { x: v.x, y: fy, z: v.z };
    L.fires.push(fire);
    this.fires.push({ v, lamp, fire, t: 0, puffT: 0, flameT: 0, big: v.kind === 'tank' || v.kind === 'apc' });
    if (silent) return;
    // the explosion (the charge's own blast already did the damage)
    const r = v.kind === 'tank' ? 9 : v.kind === 'apc' ? 8 : 5;
    fx.explosion(v.x, v.y + 1.2, v.z, r);
    fx.puff(v.x, v.y + 2, v.z, { size: r * 0.9, color: 0xff9a4a, life: 0.35, grow: 4, rise: 1, opacity: 1, add: true });
    for (let i = 0; i < 6; i++) { const a = i * 1.05; fx.puff(v.x + Math.cos(a), v.y + 2.5 + i * 0.3, v.z + Math.sin(a), { size: 3, color: 0x2a2826, life: 4, grow: 0.6, rise: 2.2, opacity: 0.8, vx: Math.cos(a) * 0.8, vz: Math.sin(a) * 0.8 }); }
    R.flashAt(v.x, v.y + 2, v.z, 22, r * 4, 0.3);
    audio.play('explosion', { x: v.x, y: v.y + 1, z: v.z, vol: 1, ref: 18, rate: 0.8 });
    audio.play('tank_gun', { x: v.x, y: v.y + 1, z: v.z, vol: 0.8, ref: 18, rate: 0.7 });
    const p = G.player, d = dist2D(p.x, p.z, v.x, v.z);
    if (d < 30) p.shake = Math.max(p.shake, 1 - d / 30);
    G.mission.stats.vehicles = (G.mission.stats.vehicles || 0) + 1;
    const key = v.kind === 'tank' ? 'tankDown' : v.kind === 'apc' ? 'apcDown' : 'gunDown';
    bus.emit('toast', t(key), 'good');
    if (v.kind === 'tank') bus.emit('radio', 'r_tankDown');
    if ((v.kind === 'gun' || v.kind === 'mortar') && this.guns.every((g) => !g.alive)) { bus.emit('toast', t('batteryDown'), 'good'); bus.emit('radio', 'r_batteryDown'); }
    bus.emit('vehicleDown', v);
  },
  _settleTurret(k, dt) {
    const pop = k.pop;
    if (!pop) return;
    pop.t += dt;
    pop.vy -= 14 * dt; pop.y += pop.vy * dt;
    const tr = k.model.turret;
    tr.rotation.x += pop.wx * dt; tr.rotation.z += pop.wz * dt; tr.rotation.y += pop.spin * dt;
    if (pop.y <= 0.06 && pop.vy < 0) {
      pop.y = 0.06; tr.rotation.x = clamp(tr.rotation.x, -0.2, 0.2); tr.rotation.z = clamp(tr.rotation.z, -0.25, 0.25);
      audio.play('body', { x: k.x, y: k.y + 1.5, z: k.z, vol: 1, rate: 0.4, ref: 10 });
      fx.puff(k.x, k.y + 1.5, k.z, { size: 3, color: 0x6a645a, life: 1.6, grow: 1.4, rise: 0.4, opacity: 0.6 });
      k.pop = null;
    }
    tr.position.y = (k.kind === 'apc' ? 2.0 : TANKG.pivot[1]) + pop.y;
  },

  // ───────────────────────── artillery ─────────────────────────
  _gun(g, dt) {
    const m = g.model;
    if (g.recoil > 0) {
      g.recoil = Math.max(0, g.recoil - dt);
      const k = g.recoil > 0.8 ? (1 - g.recoil) / 0.2 : g.recoil / 0.8;
      if (g.kind === 'gun') m.barrel.position.z = GUNG.trunnion[2] + k * 0.55;
    }
    if (!g.alive) return;
    g.fireT -= dt;
    if (g.fireT > 0) return;
    const per = g.kind === 'mortar' ? ART.mortarPeriod : ART.period;
    g.fireT = per[0] + G.rng() * (per[1] - per[0]);
    // only a crewed gun fires, and never with the player in front of its muzzle
    if (!G.enemies.some((e) => e.alive && dist2D(e.x, e.z, g.x, g.z) < ART.crewRadius)) return;
    const p = G.player, dp = dist2D(p.x, p.z, g.x, g.z);
    if (dp < ART.safeRange && Math.abs(angDelta(g.yaw, yawTo(g.x, g.z, p.x, p.z))) < ART.safeCone) { g.fireT = 4; return; }
    m.barrel.updateMatrixWorld(true);
    _v3.set(m.muzzle[0], m.muzzle[1], m.muzzle[2]); m.barrel.localToWorld(_v3);
    const mx = _v3.x, my = _v3.y, mz = _v3.z, big = g.kind === 'gun';
    audio.play(big ? 'artillery' : 'mortar', { x: mx, y: my, z: mz, vol: 1, ref: big ? 30 : 14 });
    R.flashAt(mx, my, mz, big ? 26 : 10, big ? 40 : 18, 0.12);
    fx.puff(mx, my, mz, { size: big ? 3 : 1.2, color: 0xffd08a, life: 0.12, grow: 5, rise: 0, opacity: 1, add: true });
    const fx_ = -Math.sin(g.yaw), fz_ = -Math.cos(g.yaw);
    for (let i = 0; i < (big ? 7 : 3); i++) fx.puff(mx + fx_ * i * 0.6, my + i * 0.25, mz + fz_ * i * 0.6, { size: (big ? 1.8 : 0.8) + i * 0.3, color: 0xa8a49a, life: 3 + i * 0.3, grow: 0.7, rise: 0.5, opacity: 0.6, vx: fx_ * 1.5, vz: fz_ * 1.5 });
    if (big) for (let i = 0; i < 6; i++) { const a = i * 1.05; fx.puff(g.x + Math.cos(a) * 2, g.y + 0.3, g.z + Math.sin(a) * 2, { size: 1.6, color: 0x8a8270, life: 2, grow: 1.2, rise: 0.2, opacity: 0.4, vx: Math.cos(a) * 2.5, vz: Math.sin(a) * 2.5 }); }
    g.recoil = 1;
    this.reportT = G.simTime; this.reportX = g.x; this.reportZ = g.z;
    noise.emit({ x: g.x, y: g.y + 1, z: g.z, radius: 200, kind: 'explosion', byEnemy: true, time: G.simTime });
    this.pending.push({ t: 5 + G.rng() * 4, kind: 'far', vol: big ? 0.5 : 0.3 });
    const d = dist2D(p.x, p.z, g.x, g.z);
    if (d < 25) p.shake = Math.max(p.shake, (1 - d / 25) * (big ? 0.6 : 0.25));
  },
  _pending(dt) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const e = this.pending[i];
      e.t -= dt;
      if (e.t > 0) continue;
      this.pending.splice(i, 1);
      if (e.kind === 'far') audio.play('distant_boom', { vol: e.vol, ui: false });
      else if (e.kind === 'cook') this._cookoff(e);
    }
  },
  /** One of the ammunition crates going up after its gun was destroyed. */
  _cookoff(e) {
    const p = G.player;
    fx.explosion(e.x, e.y, e.z, 3.5);
    R.flashAt(e.x, e.y + 0.5, e.z, 10, 12, 0.1);
    audio.play('explosion', { x: e.x, y: e.y, z: e.z, vol: 0.75, ref: 10, rate: 1.25 + G.rng() * 0.2 });
    noise.emit({ x: e.x, y: e.y, z: e.z, radius: NOISE.explosion * 0.6, kind: 'explosion', time: G.simTime });
    if (e.v && e.v.model.crates.visible) { e.v.model.crates.visible = false; }
    ai.blast(e.x, e.y, e.z, ART.cookRadius, ART.cookDamage, 5);
    const d = Math.hypot(p.x - e.x, p.y + 0.9 - e.y, p.z - e.z);
    if (d < ART.cookRadius * 2) p.shake = Math.max(p.shake, 0.5 * (1 - d / (ART.cookRadius * 2)));
    if (d < ART.cookRadius && G.world.los(e.x, e.y + 0.3, e.z, p.x, p.y + 1, p.z)) p.takeDamage(ART.cookDamage * (1 - d / ART.cookRadius), e.x, e.z, 'blast');
  },
  _burn(dt) {
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.t += dt;
      const life = VEHICLES.wreck.burnTime, k = f.t < life ? 1 : clamp01(1 - (f.t - life) / 20);
      f.lamp.i = VEHICLES.wreck.fireI * k * (f.big ? 1 : 0.6);
      if (k <= 0) { f.lamp.off = true; const j = G.level.fires.indexOf(f.fire); if (j >= 0) G.level.fires.splice(j, 1); this.fires.splice(i, 1); continue; }
      const cam = G.camera ? G.camera.position : null;
      if (cam && dist2D(cam.x, cam.z, f.fire.x, f.fire.z) > 90) continue;
      f.puffT -= dt; f.flameT -= dt;
      if (f.puffT <= 0) {
        f.puffT = f.big ? 0.4 : 0.6;
        fx.puff(f.fire.x + (G.rng() - 0.5) * 1.2, f.fire.y + 0.4, f.fire.z + (G.rng() - 0.5) * 1.2, puffOpts((f.big ? 1.8 : 1) * (0.8 + G.rng() * 0.4), 0x262422, 6, 0.45, 1.4, 0.55 * k, 0.3, 0.15, false));
      }
      if (f.flameT <= 0 && k > 0.3) {
        f.flameT = 0.22;
        fx.puff(f.fire.x + (G.rng() - 0.5) * (f.big ? 1.4 : 0.6), f.fire.y + G.rng() * 0.3, f.fire.z + (G.rng() - 0.5) * (f.big ? 1.4 : 0.6), puffOpts((f.big ? 0.9 : 0.5) + G.rng() * 0.4, G.rng() < 0.5 ? 0xff8a30 : 0xffb24a, 0.6, 0.6, 1.6, 0.9, 0, 0, true));
      }
    }
  },
  _fly(dt) {
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const b = this.flying[i], o = b.obj;
      b.t += dt; b.vy -= 12 * dt;
      o.position.x += b.vx * dt; o.position.y += b.vy * dt; o.position.z += b.vz * dt;
      o.rotation.x += b.wx * dt; o.rotation.z += b.wz * dt;
      const gy = G.world.h(o.position.x, o.position.z) + 0.15;
      if (o.position.y <= gy && b.vy < 0) {
        o.position.y = gy; o.rotation.x = clamp(o.rotation.x % (PI * 2), -0.3, 0.3) + (o.rotation.x > 0 ? 0 : 0); o.rotation.z = 0.15;
        audio.play('body', { x: o.position.x, y: gy, z: o.position.z, vol: 0.9, rate: 0.6, ref: 8 });
        fx.puff(o.position.x, gy, o.position.z, { size: 1.6, color: 0x8a8270, life: 1.4, grow: 1.4, rise: 0.3, opacity: 0.5 });
        this.flying.splice(i, 1);
      }
    }
  },

  // ───────────────────────── HUD prompt ─────────────────────────
  /** Aiming at armour with a charge in hand: say whether this spot will do the job. */
  _prompt() {
    const p = G.player, eq = G.equip;
    if (p.dead || !eq || !(eq.inv.c4 > 0) || interact.prompt || G.weapons.busy()) return;
    const cam = p.eyePos(_v3), fwd = p.forward(_fwd);
    if (!G.world.raycast(cam.x, cam.y, cam.z, fwd.x, fwd.y, fwd.z, THROW.c4.placeRange, F.SOLID, _hit, null)) return;
    const v = _hit.collider && _hit.collider.veh;
    if (!v || !v.alive) return;
    const key = keyLabel(input.bindOf('c4'));
    if (v.kind === 'tank') {
      v.model.root.updateMatrixWorld(true);
      _v3.set(_hit.x, _hit.y, _hit.z); v.model.root.worldToLocal(_v3);
      interact.prompt = t(chargePrompt(chargeZone(_v3.x, _v3.y, _v3.z), _v3.y), { key });
    } else interact.prompt = t(v.kind === 'apc' ? 'p_c4apc' : 'p_c4gun', { key });
  },

  // ───────────────────────── objectives / tools ─────────────────────────
  alive(kind) { return this.list.some((v) => v.alive && (kind === 'gun' ? v.kind === 'gun' || v.kind === 'mortar' : v.kind === kind)); },
  has(kind) { return this.list.some((v) => (kind === 'gun' ? v.kind === 'gun' || v.kind === 'mortar' : v.kind === kind)); },
  /**
   * Dev check: drive a route with the real steering, both ways round, and list every
   * place the hull would overlap a solid static box, a no-walk zone or a nav-blocked cell.
   */
  checkRoute(k, laps = 1, spec = null) {
    const loop = spec ? spec.loop !== false : k.loop, reverse = spec ? !!spec.reverse : k.reverse;
    const route = spec ? roundRoute(spec.route.map((p) => ({ x: p[0], z: p[1], wait: p[2] ?? 0, round: p[3] })), spec.round ?? 4.5, loop) : k.route;
    const w = G.world, out = new Map(), n = route.length;
    const s = { x: route[0].x, z: route[0].z, yaw: spec && spec.yaw !== undefined ? spec.yaw : yawTo(route[0].x, route[0].z, route[1].x, route[1].z), speed: 0, turn: 0 };
    let wi = 1, dir = 1, steps = 0;
    const mine = new Set(Object.values(k.cols));
    const test = () => {
      const c = Math.cos(s.yaw), sn = Math.sin(s.yaw), y = w.h(s.x, s.z);
      for (let lz = -TK.hlF; lz <= TK.hlR; lz += 0.4) for (let lx = -TK.hw; lx <= TK.hw; lx += 0.4) {
        const x = s.x + lx * c + lz * sn, z = s.z - lx * sn + lz * c;
        if (G.level.noWalkFns.some((fn) => fn(x, z))) { out.set('nowalk', (out.get('nowalk') || 0) + 1); return; }
        const ix = Math.floor((x - w.bounds.minX) / CELL), iz = Math.floor((z - w.bounds.minZ) / CELL), cell = w.cells[iz * w.nx + ix] || [];
        for (const col of cell) {
          if (mine.has(col) || !(col.flags & F.SOLID) || col.y + col.hy < y + 0.25 || col.y - col.hy > y + 2.1) continue;
          const dx = x - col.x, dz = z - col.z, ax = dx * col.cos - dz * col.sin, az = dx * col.sin + dz * col.cos;
          if (Math.abs(ax) < col.hx && Math.abs(az) < col.hz) {
            const key = `${col.tag || col.mat}@${col.x.toFixed(1)},${col.z.toFixed(1)}`, e = out.get(key) || { n: 0, at: [] };
            e.n++; if (e.at.length < 3) e.at.push([+s.x.toFixed(1), +s.z.toFixed(1)]); out.set(key, e); return;
          }
        }
      }
    };
    const total = laps * (loop ? n : 2 * (n - 1));
    for (let leg = 0; leg < total && steps < 60 * 600; ) {
      const tg = route[wi], back = reverse && dir < 0;
      const d = driveStep(s, tg.x, tg.z, 1 / 60, tg.slow, false, back);
      steps++;
      if (steps % 6 === 0) test();
      if (d < TK.arrive) {
        leg++;
        if (loop) wi = (wi + 1) % n; else { if (wi + dir >= n || wi + dir < 0) dir = -dir; wi += dir; }
      }
    }
    return { seconds: +(steps / 60).toFixed(1), points: n, hits: Object.fromEntries(out) };
  },
};
const _fwd = { x: 0, y: 0, z: 0 };
const now = () => G.simTime;
/** One reusable options object for the frequent puffs (exhaust, wreck smoke and flames): fx.puff reads it at once. */
const _po = { size: 0, color: 0, life: 0, grow: 0, rise: 0, opacity: 0, vx: 0, vz: 0, add: false };
function puffOpts(size, color, life, grow, rise, opacity, vx, vz, add) {
  _po.size = size; _po.color = color; _po.life = life; _po.grow = grow; _po.rise = rise; _po.opacity = opacity; _po.vx = vx; _po.vz = vz; _po.add = add;
  return _po;
}
function groundAt(w, k, lx, lz) { const c = Math.cos(k.yaw), s = Math.sin(k.yaw); return w.h(k.x + lx * c + lz * s, k.z - lx * s + lz * c); }

G.vehicles = vehicles;
noise.listen((evt) => vehicles.onNoise(evt));
void makeRng;
