/**
 * models.js — procedural models.
 *
 *   Geo            a tiny geometry builder (boxes, cylinders, prisms) with
 *                  baked per-face shading, optional UVs and rigid skinning
 *   buildSoldier   re-exported from soldier-model.js (one SkinnedMesh per
 *                  soldier + SoldierRig, posed in code)
 *   view models    re-exported from weapon-models.js
 *   props          crates, barrels, vehicles, lamp posts, landmarks…
 */
import * as THREE from 'three';
import { clamp01, lerp, damp } from './ctx.js';
import { TEX } from './textures.js';
import { buildPickupModel, buildItemModel } from './pickup-models.js';

// palette derived from the style formula
export const PAL = {
  limestone: 0x8f8f88, beige: 0xb5a88c, pine: 0x2f4034, charcoal: 0x26282a,
  olive: 0x5b6140, oliveDark: 0x454a30, tan: 0xb89a6a, glove: 0x8a7350,
  enemy: 0x54463a, enemyDark: 0x3d342c, enemyVest: 0x3a3f35, skin: 0xb98c6c,
  gun: 0x2b2d2f, gunLight: 0x3c3f42, woodStock: 0x6b4a2c, amber: 0xffb648, boot: 0x1e1c1a,
};

const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const FACE_SHADE = [0.92, 0.84, 1.06, 0.68, 1.0, 0.8];   // +x −x +y −y +z −z

export class Geo {
  constructor(o = {}) {
    this.uv = !!o.uv; this.skin = !!o.skin;
    this.p = []; this.n = []; this.c = []; this.t = []; this.si = []; this.i = [];
    this.count = 0;
  }
  _vert(x, y, z, nx, ny, nz, r, g, b, u, v, bone) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.c.push(r, g, b);
    if (this.uv) this.t.push(u, v);
    if (this.skin) this.si.push(bone, 0, 0, 0);
    return this.count++;
  }
  /**
   * Box centred at (cx,cy,cz) with full size (sx,sy,sz).
   * o: { rx, ry, rz (rotation about the centre), bone, uvScale (metres per repeat), shade }
   */
  box(cx, cy, cz, sx, sy, sz, color, o = {}) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    _e.set(o.rx || 0, o.ry || 0, o.rz || 0, 'YXZ');
    _m.makeRotationFromEuler(_e);
    _c.set(color);
    const k = o.shade ?? 1, us = o.uvScale || 1, bone = o.bone || 0;
    // face: normal, then 4 corners (ccw seen from outside), then which local axes map to u,v
    const faces = [
      [1, 0, 0, [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]], 2, 1],
      [-1, 0, 0, [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]], 2, 1],
      [0, 1, 0, [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]], 0, 2],
      [0, -1, 0, [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], 0, 2],
      [0, 0, 1, [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]], 0, 1],
      [0, 0, -1, [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], 0, 1],
    ];
    const off = [cx, cy, cz];
    for (let f = 0; f < 6; f++) {
      if (o.skip && o.skip.includes(f)) continue;
      const [nx, ny, nz, corners, ua, va] = faces[f];
      _v.set(nx, ny, nz).applyMatrix4(_m);
      const wnx = _v.x, wny = _v.y, wnz = _v.z;
      const s = FACE_SHADE[f] * k;
      const base = this.count;
      for (let q = 0; q < 4; q++) {
        const l = corners[q];
        _v.set(l[0], l[1], l[2]).applyMatrix4(_m);
        this._vert(_v.x + cx, _v.y + cy, _v.z + cz, wnx, wny, wnz, _c.r * s, _c.g * s, _c.b * s,
          (l[ua] + off[ua]) / us, (l[va] + off[va]) / us, bone);
      }
      this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return this;
  }
  /** Cylinder / cone frustum along an axis ('x' | 'y' | 'z'). */
  cyl(cx, cy, cz, rTop, rBot, h, color, o = {}) {
    const seg = o.seg || 8, axis = o.axis || 'y', bone = o.bone || 0, k = o.shade ?? 1;
    _c.set(color);
    // proper rotations (not reflections) so triangle winding stays outward-facing
    const map = (x, y, z) => axis === 'y' ? [x, y, z] : axis === 'x' ? [y, -x, z] : [x, z, -y];
    const ring = [];
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      ring.push([Math.cos(a), Math.sin(a)]);
    }
    for (let s = 0; s < seg; s++) {
      const [c0, s0] = ring[s], [c1, s1] = ring[s + 1];
      const shade = (0.72 + 0.34 * (0.5 + 0.5 * Math.cos((s + 0.5) / seg * Math.PI * 2 - 0.9))) * k;
      const nm = map((c0 + c1) / 2, (rBot - rTop) / h * 0.5, (s0 + s1) / 2);
      const pts = [[c0 * rBot, -h / 2, s0 * rBot], [c0 * rTop, h / 2, s0 * rTop], [c1 * rTop, h / 2, s1 * rTop], [c1 * rBot, -h / 2, s1 * rBot]];
      const base = this.count;
      for (let q = 0; q < 4; q++) {
        const m = map(pts[q][0], pts[q][1], pts[q][2]);
        this._vert(m[0] + cx, m[1] + cy, m[2] + cz, nm[0], nm[1], nm[2], _c.r * shade, _c.g * shade, _c.b * shade,
          (s + (q > 1 ? 1 : 0)) / seg * 2, pts[q][1] / (o.uvScale || 1), bone);
      }
      this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
      // caps
      for (const top of [1, 0]) {
        if (o.noCaps) break;
        const r = top ? rTop : rBot;
        if (r <= 0.001) continue;
        const y = top ? h / 2 : -h / 2, cs = (top ? 1.04 : 0.66) * k;
        const b2 = this.count, nn = map(0, top ? 1 : -1, 0);
        const tri = top ? [[0, 0], [c1 * r, s1 * r], [c0 * r, s0 * r]] : [[0, 0], [c0 * r, s0 * r], [c1 * r, s1 * r]];
        for (const pt of tri) {
          const m = map(pt[0], y, pt[1]);
          this._vert(m[0] + cx, m[1] + cy, m[2] + cz, nn[0], nn[1], nn[2], _c.r * cs, _c.g * cs, _c.b * cs, pt[0], pt[1], bone);
        }
        this.i.push(b2, b2 + 1, b2 + 2);
      }
    }
    return this;
  }
  /**
   * Gable roof: a triangular prism. Ridge runs along local X.
   * (cx,cy,cz) = centre of the base rectangle; w = length along the ridge,
   * d = span, h = ridge height; ry = yaw.
   */
  gable(cx, cy, cz, w, d, h, color, o = {}) {
    const hw = w / 2, hd = d / 2, us = o.uvScale || 1;
    _c.set(color);
    _m.makeRotationY(o.ry || 0);
    const P = (x, y, z) => { _v.set(x, y, z).applyMatrix4(_m); return [_v.x + cx, _v.y + cy, _v.z + cz]; };
    const quad = (a, b, c, d2, nx, ny, nz, shade, uv) => {
      _v.set(nx, ny, nz).normalize().applyMatrix4(_m);
      const n = [_v.x, _v.y, _v.z], base = this.count, pts = [a, b, c, d2];
      for (let q = 0; q < pts.length; q++) {
        this._vert(pts[q][0], pts[q][1], pts[q][2], n[0], n[1], n[2], _c.r * shade, _c.g * shade, _c.b * shade, uv[q][0] / us, uv[q][1] / us, 0);
      }
      this.i.push(base, base + 1, base + 2);
      if (pts.length === 4) this.i.push(base, base + 2, base + 3);
    };
    const sl = Math.hypot(hd, h);
    quad(P(-hw, 0, hd), P(hw, 0, hd), P(hw, h, 0), P(-hw, h, 0), 0, hd, h, 1.0, [[0, 0], [w, 0], [w, sl], [0, sl]]);
    quad(P(hw, 0, -hd), P(-hw, 0, -hd), P(-hw, h, 0), P(hw, h, 0), 0, hd, -h, 0.78, [[0, 0], [w, 0], [w, sl], [0, sl]]);
    // gable ends (triangles) in the wall colour
    _c.set(o.endColor ?? color);
    const tri = (a, b, c, nx) => {
      _v.set(nx, 0, 0).applyMatrix4(_m);
      const n = [_v.x, _v.y, _v.z], base = this.count, s = nx > 0 ? 0.92 : 0.84;
      for (const p of [a, b, c]) this._vert(p[0], p[1], p[2], n[0], n[1], n[2], _c.r * s, _c.g * s, _c.b * s, p[2] / us, p[1] / us, 0);
      this.i.push(base, base + 1, base + 2);
    };
    tri(P(hw, 0, hd), P(hw, 0, -hd), P(hw, h, 0), 1);
    tri(P(-hw, 0, -hd), P(-hw, 0, hd), P(-hw, h, 0), -1);
    return this;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    if (this.skin) {
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
      const w = new Float32Array(this.count * 4);
      for (let k = 0; k < this.count; k++) w[k * 4] = 1;
      g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    }
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    return g;
  }
}

let _vcMat = null, _vcMatDS = null;
/** Shared vertex-colour material for everything built with Geo (no texture). */
export function vcMaterial(doubleSide) {
  if (doubleSide) return _vcMatDS || (_vcMatDS = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  return _vcMat || (_vcMat = new THREE.MeshLambertMaterial({ vertexColors: true }));
}
export function meshOf(geo, mat) { return new THREE.Mesh(geo.build(), mat || vcMaterial()); }

// ─────────────────────────────── soldier ─────────────────────────────────
// Built in soldier-model.js (smooth-skinned, IK-posed, textured); re-exported
// here so importers keep working. soldier-model.js imports only three: no cycle.
export { buildSoldier, SoldierRig } from './soldier-model.js';

// ─────────────────────────────── first-person view models ────────────────
// Built in weapon-models.js (PBR materials, modelled hands); re-exported here so
// importers keep working. weapon-models.js imports only three, so there is no cycle.
export { buildViewModel } from './weapon-models.js';

/**
 * Thrown / held equipment (frag, smoke, flash, stone, tknife, c4) and the
 * ejected shell: modelled in pickup-models.js, one mesh each, origin at the centre
 * (the C4's bottom face at y = −0.03).
 */
export function buildItem(kind) { return buildItemModel(kind); }

/**
 * Ground pickup, resting on y = 0: the real item, modelled in pickup-models.js,
 * with a faint glint sprite in userData.glow (level.js pulses its opacity).
 * o.sup: a gun pickup with its suppressor fitted.
 */
export function buildPickup(type, o) { return buildPickupModel(type, o); }

// ─────────────────────────────── props (static, added to batches by the kit) ──
/** Flag on a pole: returns { group, flag, setRaise(0..1), update(t) }. */
export function buildFlagpole(height = 9) {
  const group = new THREE.Group();
  const g = new Geo();
  g.cyl(0, height / 2, 0, 0.045, 0.07, height, 0x9a9c9e, { seg: 8 });
  g.cyl(0, 0.15, 0, 0.35, 0.45, 0.3, PAL.limestone, { seg: 10 });
  g.cyl(0, height + 0.06, 0, 0.0, 0.07, 0.14, PAL.amber, { seg: 8 });
  group.add(meshOf(g));
  const fw = 2.7, fh = 1.35, sx = 14, sy = 6;
  const geo = new THREE.PlaneGeometry(fw, fh, sx, sy);
  geo.translate(fw / 2 + 0.06, 0, 0);
  const base = geo.attributes.position.array.slice();
  const flag = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: TEX.flag, side: THREE.DoubleSide }));
  flag.visible = false;
  group.add(flag);
  let raise = 0;
  return {
    group, flag,
    setRaise(v) { raise = clamp01(v); flag.visible = raise > 0; flag.position.y = lerp(1.4, height - fh / 2 - 0.2, raise); },
    update(t) {
      if (!flag.visible) return;
      const p = geo.attributes.position.array;
      for (let i = 0; i < p.length; i += 3) {
        const x = base[i], k = x / fw;
        p[i + 2] = Math.sin(x * 2.4 - t * 4.2) * 0.17 * k + Math.sin(x * 5.1 - t * 6.3 + base[i + 1] * 2) * 0.05 * k;
        p[i + 1] = base[i + 1] - k * k * 0.12 + Math.sin(x * 1.7 - t * 3) * 0.03 * k;
      }
      geo.attributes.position.needsUpdate = true;
      geo.computeVertexNormals();
    },
  };
}

/** Additive torch-beam cone, pointing along −Z from the origin. */
export function buildBeam(length = 16, radius = 3.2) {
  const geo = new THREE.ConeGeometry(radius, length, 14, 1, true);
  geo.rotateX(Math.PI / 2); geo.translate(0, 0, -length / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xfff1c9, transparent: true, opacity: 0.045, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  return new THREE.Mesh(geo, mat);
}
