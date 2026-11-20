/**
 * fx.js — pooled visual effects: tracers, puffs (dust, smoke, muzzle flash),
 * bullet-hole decals and ejected shells. Everything is pre-allocated so the
 * frame loop creates no garbage.
 */
import * as THREE from 'three';
import { G } from './ctx.js';
import { TEX } from './textures.js';
import { buildItem } from './models.js';
import { audio } from './audio.js';

const tracers = [], puffs = [], decals = [], shells = [];
let ti = 0, pi = 0, di = 0, si = 0;
const _n = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1);

export const fx = {
  init() {
    for (let i = 0; i < 28; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffe2a8, transparent: true, opacity: 0, depthWrite: false, fog: false }));
      l.frustumCulled = false; l.visible = false; l.userData.life = 0;
      G.scene.add(l); tracers.push(l);
    }
    for (let i = 0; i < 150; i++) {          // 110 before the vehicles: wreck smoke and exhaust need a few more
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.puff, transparent: true, opacity: 0, depthWrite: false }));
      s.visible = false; s.userData = { life: 0, max: 1, grow: 0, rise: 0, op: 1, vx: 0, vz: 0 };
      G.scene.add(s); puffs.push(s);
    }
    const dg = new THREE.CircleGeometry(0.045, 8);
    const dm = new THREE.MeshBasicMaterial({ color: 0x0c0c0c, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    for (let i = 0; i < 48; i++) { const m = new THREE.Mesh(dg, dm); m.visible = false; G.scene.add(m); decals.push(m); }
    for (let i = 0; i < 14; i++) { const m = buildItem('shell'); m.visible = false; m.userData = { life: 0, v: new THREE.Vector3(), w: new THREE.Vector3() }; G.vmScene.add(m); shells.push(m); }
  },

  reset() {
    for (const t of tracers) t.visible = false;
    for (const p of puffs) { p.visible = false; p.userData.life = 0; }
    for (const d of decals) d.visible = false;
    for (const s of shells) s.visible = false;
  },

  tracer(ax, ay, az, bx, by, bz, color = 0xffe2a8, life = 0.07) {
    const l = tracers[ti = (ti + 1) % tracers.length], p = l.geometry.attributes.position.array;
    p[0] = ax; p[1] = ay; p[2] = az; p[3] = bx; p[4] = by; p[5] = bz;
    l.geometry.attributes.position.needsUpdate = true;
    l.material.color.set(color); l.material.opacity = 0.75;
    l.userData.life = life; l.userData.max = life; l.visible = true;
  },

  /** o: { size, color, life, grow, rise, opacity, vx, vz, add } */
  puff(x, y, z, o = {}) {
    const s = puffs[pi = (pi + 1) % puffs.length], u = s.userData;
    s.position.set(x, y, z);
    const size = o.size ?? 0.4;
    s.scale.set(size, size, 1);
    s.material.color.set(o.color ?? 0x9a958a);
    s.material.blending = o.add ? THREE.AdditiveBlending : THREE.NormalBlending;
    s.material.fog = !o.add;
    u.life = u.max = o.life ?? 0.6; u.grow = o.grow ?? 1.2; u.rise = o.rise ?? 0.4; u.op = o.opacity ?? 0.6;
    u.vx = o.vx || 0; u.vz = o.vz || 0;
    s.material.opacity = u.op; s.visible = true;
    return s;
  },

  /** Bullet hit on world geometry: dust + a hole decal. Armour (vehicles) only sparks and rings. */
  impact(x, y, z, nx, ny, nz, mat) {
    if (mat === 'armor') { this.sparks(x, y, z, nx, ny, nz); return; }
    const c = mat === 'wood' || mat === 'woodThin' ? 0x8a6f4c : mat === 'grass' ? 0x4c5338 : mat === 'metal' ? 0xd0d0c8 : 0xa39e92;
    this.puff(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, { size: 0.22, color: c, life: 0.45, grow: 2.2, rise: 0.5, opacity: 0.7 });
    const d = decals[di = (di + 1) % decals.length];
    d.position.set(x + nx * 0.012, y + ny * 0.012, z + nz * 0.012);
    d.quaternion.setFromUnitVectors(_z, _n.set(nx, ny, nz));
    d.visible = true;
  },

  /** A round glancing off armour: a spray of sparks, a grey scuff and the ricochet's whine. */
  sparks(x, y, z, nx, ny, nz) {
    this.puff(x + nx * 0.04, y + ny * 0.04, z + nz * 0.04, { size: 0.35, color: 0xffe0a0, life: 0.07, grow: 3, rise: 0, opacity: 1, add: true });
    for (let i = 0; i < 3; i++) {
      const k = 1.5 + Math.random() * 2.5;
      this.puff(x + nx * 0.06, y + ny * 0.06, z + nz * 0.06, { size: 0.07, color: 0xffb860, life: 0.18 + Math.random() * 0.12, grow: 0.2, rise: 1 + Math.random() * 2, opacity: 1, add: true,
        vx: (nx + (Math.random() - 0.5) * 1.6) * k, vz: (nz + (Math.random() - 0.5) * 1.6) * k });
    }
    this.puff(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, { size: 0.16, color: 0xbdbab2, life: 0.35, grow: 2, rise: 0.4, opacity: 0.5 });
    if (Math.random() < 0.6) audio.play('ricochet', { x, y, z, vol: 0.55, ref: 4, rate: 0.85 + Math.random() * 0.35, low: true });
  },

  /** Modest hit effect on a soldier (a dark puff, nothing more). */
  hit(x, y, z) { this.puff(x, y, z, { size: 0.18, color: 0x4a1f1c, life: 0.3, grow: 1.6, rise: 0.1, opacity: 0.6 }); },

  explosion(x, y, z, r) {
    this.puff(x, y + 0.5, z, { size: r * 0.5, color: 0xffc27a, life: 0.18, grow: 6, rise: 0, opacity: 1, add: true });
    for (let i = 0; i < 9; i++) {
      const a = i * 0.7, d = r * 0.18;
      this.puff(x + Math.cos(a) * d, y + 0.4 + (i % 3) * 0.5, z + Math.sin(a) * d, { size: r * 0.3, color: i % 2 ? 0x3a3835 : 0x5a554e, life: 1.6 + (i % 4) * 0.3, grow: 0.9, rise: 1.0, opacity: 0.75, vx: Math.cos(a) * 1.2, vz: Math.sin(a) * 1.2 });
    }
  },

  /** Shell casing flicked out of the view model (view-model space). */
  shell(pos) {
    const m = shells[si = (si + 1) % shells.length], u = m.userData;
    m.position.copy(pos);
    u.v.set(0.9 + Math.random() * 0.5, 1.1 + Math.random() * 0.5, 0.2 * (Math.random() - 0.5));
    u.w.set(Math.random() * 20, Math.random() * 20, Math.random() * 20);
    u.life = 0.7; m.visible = true;
  },

  update(dt) {
    for (let i = 0; i < tracers.length; i++) {
      const l = tracers[i];
      if (!l.visible) continue;
      l.userData.life -= dt;
      if (l.userData.life <= 0) l.visible = false; else l.material.opacity = 0.75 * l.userData.life / l.userData.max;
    }
    for (let i = 0; i < puffs.length; i++) {
      const s = puffs[i], u = s.userData;
      if (!s.visible) continue;
      u.life -= dt;
      if (u.life <= 0) { s.visible = false; continue; }
      const k = 1 + u.grow * dt;
      s.scale.x *= k; s.scale.y *= k;
      s.position.y += u.rise * dt; s.position.x += u.vx * dt; s.position.z += u.vz * dt;
      u.vx *= 1 - dt * 1.5; u.vz *= 1 - dt * 1.5;
      const t = u.life / u.max;
      s.material.opacity = u.op * (t < 0.7 ? t / 0.7 : 1);
    }
    for (let i = 0; i < shells.length; i++) {
      const m = shells[i], u = m.userData;
      if (!m.visible) continue;
      u.life -= dt;
      if (u.life <= 0) { m.visible = false; continue; }
      u.v.y -= 6 * dt;
      m.position.addScaledVector(u.v, dt);
      m.rotation.x += u.w.x * dt; m.rotation.y += u.w.y * dt;
    }
  },
};
