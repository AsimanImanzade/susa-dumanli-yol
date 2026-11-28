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
import { F } from './physics.js';
import { R } from './render.js';

const tracers = [], puffs = [], decals = [], shells = [];
let ti = 0, pi = 0, di = 0, si = 0;
const _n = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1);

// ───────────────────────────── explosions ─────────────────────────────
// Frags and C4 (fx.blast) draw from pools of their own so a few charges going off
// together never evict the smoke grenades' puffs. Billboards are instanced (one draw
// call for all the fire, one for all the smoke and dust); sparks are one line set,
// debris one instanced mesh; shock rings and scorch marks are small mesh pools.
const FIRE_N = 160, SMOKE_N = 240, SPARK_N = 180, DEBRIS_N = 110, RING_N = 6, SCORCH_N = 10;
/** A particle pool: struct of arrays, a free-running ring (the oldest go first when it is full). */
function pool(n) {
  const f = (k) => new Float32Array(n * k);
  return { n, i: 0, p: f(3), v: f(3), s: f(2), life: f(1), max: f(1), c0: f(3), c1: f(3), a: f(1), rot: f(2), drag: f(1), buoy: f(1), mesh: null, aOff: null, aCol: null, aRot: null };
}
const FIRE = pool(FIRE_N), SMOKE = pool(SMOKE_N);
const BB_VS = `
attribute vec4 aOff; attribute vec4 aCol; attribute float aRot;
varying vec2 vUv; varying vec4 vCol;
#include <fog_pars_vertex>
void main() {
  vUv = position.xy + 0.5; vCol = aCol;
  vec4 mvPosition = modelViewMatrix * vec4(aOff.xyz, 1.0);
  float c = cos(aRot), s = sin(aRot);
  mvPosition.xy += vec2(c * position.x - s * position.y, s * position.x + c * position.y) * aOff.w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const BB_FS = `
uniform sampler2D map; uniform float uLight;
varying vec2 vUv; varying vec4 vCol;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(vCol.rgb * t.rgb * uLight, vCol.a * t.a);
  #include <fog_fragment>
}`;
function billboards(P, tex, additive) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  P.aOff = new THREE.InstancedBufferAttribute(new Float32Array(P.n * 4), 4).setUsage(THREE.DynamicDrawUsage);
  P.aCol = new THREE.InstancedBufferAttribute(new Float32Array(P.n * 4), 4).setUsage(THREE.DynamicDrawUsage);
  P.aRot = new THREE.InstancedBufferAttribute(new Float32Array(P.n), 1).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aOff', P.aOff); g.setAttribute('aCol', P.aCol); g.setAttribute('aRot', P.aRot);
  g.instanceCount = 0;
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: tex }, uLight: { value: 1 } }]),
    vertexShader: BB_VS, fragmentShader: BB_FS, transparent: true, depthWrite: false, fog: !additive,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  m.uniforms.map.value = tex;
  P.mesh = new THREE.Mesh(g, m); P.mesh.frustumCulled = false; P.mesh.renderOrder = additive ? 3 : 2;
  G.scene.add(P.mesh);
}
const _c = new THREE.Color();
/** Emit one particle. Sizes s0 → s1 (eased out), colours c0 → c1 as linear hex pairs. */
function emit(P, x, y, z, vx, vy, vz, s0, s1, life, h0, h1, a, drag, buoy) {
  const i = P.i = (P.i + 1) % P.n, i3 = i * 3;
  P.p[i3] = x; P.p[i3 + 1] = y; P.p[i3 + 2] = z; P.v[i3] = vx; P.v[i3 + 1] = vy; P.v[i3 + 2] = vz;
  P.s[i * 2] = s0; P.s[i * 2 + 1] = s1; P.life[i] = P.max[i] = life; P.a[i] = a; P.drag[i] = drag; P.buoy[i] = buoy;
  _c.set(h0); P.c0[i3] = _c.r; P.c0[i3 + 1] = _c.g; P.c0[i3 + 2] = _c.b;
  _c.set(h1); P.c1[i3] = _c.r; P.c1[i3 + 1] = _c.g; P.c1[i3 + 2] = _c.b;
  P.rot[i * 2] = Math.random() * 6.283; P.rot[i * 2 + 1] = (Math.random() - 0.5) * 1.2;
}
const WIND = { x: 0.45, z: 0.2 };
/** Step a pool and pack the live particles into its instance buffers. fire: hot colours, brighter early. */
function stepPool(P, dt, fire) {
  const O = P.aOff.array, C = P.aCol.array, Ro = P.aRot.array;
  let n = 0;
  for (let i = 0; i < P.n; i++) {
    if (P.life[i] <= 0) continue;
    P.life[i] -= dt;
    if (P.life[i] <= 0) continue;
    const i3 = i * 3, t = 1 - P.life[i] / P.max[i], d = Math.exp(-P.drag[i] * dt);
    P.v[i3] *= d; P.v[i3 + 1] = P.v[i3 + 1] * d + P.buoy[i] * dt; P.v[i3 + 2] *= d;
    P.p[i3] += (P.v[i3] + (fire ? 0 : WIND.x * t)) * dt; P.p[i3 + 1] += P.v[i3 + 1] * dt; P.p[i3 + 2] += (P.v[i3 + 2] + (fire ? 0 : WIND.z * t)) * dt;
    P.rot[i * 2] += P.rot[i * 2 + 1] * dt;
    const g = 1 - (1 - t) * (1 - t) * (1 - t), size = P.s[i * 2] + (P.s[i * 2 + 1] - P.s[i * 2]) * g;
    const ct = fire ? Math.min(1, t * 1.6) : t;
    const fade = fire ? (1 - t) * (1 - t) : Math.min(1, t * 8) * (1 - t * t);
    O[n * 4] = P.p[i3]; O[n * 4 + 1] = P.p[i3 + 1]; O[n * 4 + 2] = P.p[i3 + 2]; O[n * 4 + 3] = size;
    C[n * 4] = P.c0[i3] + (P.c1[i3] - P.c0[i3]) * ct; C[n * 4 + 1] = P.c0[i3 + 1] + (P.c1[i3 + 1] - P.c0[i3 + 1]) * ct; C[n * 4 + 2] = P.c0[i3 + 2] + (P.c1[i3 + 2] - P.c0[i3 + 2]) * ct;
    C[n * 4 + 3] = P.a[i] * fade;
    Ro[n] = P.rot[i * 2];
    n++;
  }
  P.mesh.geometry.instanceCount = n;
  P.mesh.visible = n > 0;
  if (n) { P.aOff.needsUpdate = true; P.aCol.needsUpdate = true; P.aRot.needsUpdate = true; }
}
// sparks: short streaks along their velocity, one LineSegments
const SPK = { p: new Float32Array(SPARK_N * 3), v: new Float32Array(SPARK_N * 3), life: new Float32Array(SPARK_N), max: new Float32Array(SPARK_N), i: 0, line: null };
// debris: dirt clods or stone chips on arcs, bounce once, lie a while, shrink away
const DEB = { p: new Float32Array(DEBRIS_N * 3), v: new Float32Array(DEBRIS_N * 3), c: new Float32Array(DEBRIS_N * 3), r: new Float32Array(DEBRIS_N * 3), w: new Float32Array(DEBRIS_N * 3), s: new Float32Array(DEBRIS_N),
  life: new Float32Array(DEBRIS_N), hits: new Uint8Array(DEBRIS_N), i: 0, mesh: null };
const rings = [], scorches = [];
let ri = 0, sci = 0;
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler(), _m = new THREE.Matrix4(), _dc = new THREE.Color();
const _hit = {};
const SOIL = { dirt: 1, grass: 1, mud: 1, sand: 1 };
/** Soft billowing blob (smoke) or a denser one (fire), white with alpha. */
function blobTex(seed, dense) {
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < (dense ? 10 : 16); i++) {
    const a = rnd() * 6.283, d = rnd() * S * (dense ? 0.14 : 0.2), x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d, rr = S * (dense ? 0.22 : 0.16 + rnd() * 0.14);
    const gr = g.createRadialGradient(x, y, 0, x, y, rr);
    gr.addColorStop(0, `rgba(255,255,255,${dense ? 0.55 : 0.32})`); gr.addColorStop(0.6, `rgba(255,255,255,${dense ? 0.22 : 0.12})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }
  // fade the square's edge out completely
  g.globalCompositeOperation = 'destination-in';
  const m = g.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S / 2);
  m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = m; g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(cv);
}
/** Scorch: a burnt patch, darkest in the middle, ragged rays at the rim. */
function scorchTex() {
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d'), c = S / 2;
  for (let i = 0; i < 70; i++) {
    const a = Math.random() * 6.283, len = S * (0.22 + Math.random() * 0.26), w = 0.05 + Math.random() * 0.12;
    g.fillStyle = `rgba(14,12,10,${0.05 + Math.random() * 0.08})`;
    g.beginPath(); g.moveTo(c, c); g.lineTo(c + Math.cos(a - w) * len, c + Math.sin(a - w) * len); g.lineTo(c + Math.cos(a + w) * len * 0.8, c + Math.sin(a + w) * len * 0.8); g.fill();
  }
  const gr = g.createRadialGradient(c, c, 0, c, c, S * 0.34);
  gr.addColorStop(0, 'rgba(8,7,6,0.95)'); gr.addColorStop(0.45, 'rgba(18,15,12,0.75)'); gr.addColorStop(1, 'rgba(30,26,20,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '60,52,40'},${Math.random() * 0.25})`; const a = Math.random() * 6.283, d = Math.random() * S * 0.3; g.fillRect(c + Math.cos(a) * d, c + Math.sin(a) * d, 2 + Math.random() * 5, 2 + Math.random() * 5); }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function initBlasts() {
  billboards(FIRE, blobTex(7, true), true);
  billboards(SMOKE, blobTex(3, false), false);
  // sparks
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARK_N * 6), 3).setUsage(THREE.DynamicDrawUsage));
  sg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(SPARK_N * 6), 3).setUsage(THREE.DynamicDrawUsage));
  SPK.line = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  SPK.line.frustumCulled = false; SPK.line.visible = false; G.scene.add(SPK.line);
  // debris: a lumpy low-poly stone, tinted per instance
  const dg = new THREE.IcosahedronGeometry(1, 0), dp = dg.attributes.position;
  for (let i = 0; i < dp.count; i++) { const k = 0.7 + ((i * 7919) % 13) / 13 * 0.6; dp.setXYZ(i, dp.getX(i) * k, dp.getY(i) * k * 0.75, dp.getZ(i) * k); }
  dg.computeVertexNormals();
  DEB.mesh = new THREE.InstancedMesh(dg, new THREE.MeshLambertMaterial({ color: 0xffffff }), DEBRIS_N);
  DEB.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  DEB.mesh.setColorAt(0, _dc.set(0x5a4a38)); DEB.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  DEB.mesh.count = 0; DEB.mesh.frustumCulled = false; G.scene.add(DEB.mesh);
  // shock rings flat on the ground, scorch marks
  const rg = new THREE.RingGeometry(0.72, 1, 48); rg.rotateX(-Math.PI / 2);
  for (let i = 0; i < RING_N; i++) {
    const m = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xa89a84, transparent: true, opacity: 0, depthWrite: false }));
    m.visible = false; m.userData = { t: 0, r: 1 }; G.scene.add(m); rings.push(m);
  }
  const st = scorchTex(), sg2 = new THREE.PlaneGeometry(1, 1);
  for (let i = 0; i < SCORCH_N; i++) {
    const m = new THREE.Mesh(sg2, new THREE.MeshBasicMaterial({ map: st, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    m.visible = false; m.renderOrder = 1; m.userData = { t: 0 }; G.scene.add(m); scorches.push(m);
  }
}
function resetBlasts() {
  FIRE.life.fill(0); SMOKE.life.fill(0); SPK.life.fill(0); DEB.life.fill(0);
  if (FIRE.mesh) { FIRE.mesh.visible = false; SMOKE.mesh.visible = false; SPK.line.visible = false; DEB.mesh.count = 0; }
  for (const m of rings) m.visible = false;
  for (const m of scorches) m.visible = false;
}
function stepBlasts(dt) {
  if (!FIRE.mesh) return;
  stepPool(FIRE, dt, true);
  SMOKE.mesh.material.uniforms.uLight.value = 0.18 + 0.82 * Math.min(1, R.lightLevel ?? 1);
  stepPool(SMOKE, dt, false);
  // sparks
  const sp = SPK.line.geometry.attributes.position.array, sc = SPK.line.geometry.attributes.color.array;
  let n = 0;
  for (let i = 0; i < SPARK_N; i++) {
    if (SPK.life[i] <= 0) continue;
    SPK.life[i] -= dt;
    if (SPK.life[i] <= 0) continue;
    const i3 = i * 3, d = Math.exp(-1.6 * dt);
    SPK.v[i3] *= d; SPK.v[i3 + 1] = SPK.v[i3 + 1] * d - 9 * dt; SPK.v[i3 + 2] *= d;
    SPK.p[i3] += SPK.v[i3] * dt; SPK.p[i3 + 1] += SPK.v[i3 + 1] * dt; SPK.p[i3 + 2] += SPK.v[i3 + 2] * dt;
    const k = SPK.life[i] / SPK.max[i], L = 0.03, o = n * 6;
    sp[o] = SPK.p[i3]; sp[o + 1] = SPK.p[i3 + 1]; sp[o + 2] = SPK.p[i3 + 2];
    sp[o + 3] = SPK.p[i3] - SPK.v[i3] * L; sp[o + 4] = SPK.p[i3 + 1] - SPK.v[i3 + 1] * L; sp[o + 5] = SPK.p[i3 + 2] - SPK.v[i3 + 2] * L;
    sc[o] = 3 * k; sc[o + 1] = 1.9 * k * k; sc[o + 2] = 0.6 * k * k * k; sc[o + 3] = 1.2 * k; sc[o + 4] = 0.4 * k * k; sc[o + 5] = 0.05 * k;
    n++;
  }
  SPK.line.visible = n > 0;
  if (n) { SPK.line.geometry.setDrawRange(0, n * 2); SPK.line.geometry.attributes.position.needsUpdate = true; SPK.line.geometry.attributes.color.needsUpdate = true; }
  // debris
  const w = G.world;
  let m = 0;
  for (let i = 0; i < DEBRIS_N; i++) {
    if (DEB.life[i] <= 0) continue;
    DEB.life[i] -= dt;
    if (DEB.life[i] <= 0) continue;
    const i3 = i * 3;
    if (DEB.hits[i] < 2) {
      DEB.v[i3 + 1] -= 9.8 * dt;
      DEB.p[i3] += DEB.v[i3] * dt; DEB.p[i3 + 1] += DEB.v[i3 + 1] * dt; DEB.p[i3 + 2] += DEB.v[i3 + 2] * dt;
      DEB.r[i3] += DEB.w[i3] * dt; DEB.r[i3 + 1] += DEB.w[i3 + 1] * dt; DEB.r[i3 + 2] += DEB.w[i3 + 2] * dt;
      const gy = w ? w.h(DEB.p[i3], DEB.p[i3 + 2]) : -1e9;
      if (DEB.p[i3 + 1] < gy + DEB.s[i] * 0.5 && DEB.v[i3 + 1] < 0) {
        DEB.p[i3 + 1] = gy + DEB.s[i] * 0.5;
        if (++DEB.hits[i] < 2) { DEB.v[i3 + 1] *= -0.28; DEB.v[i3] *= 0.45; DEB.v[i3 + 2] *= 0.45; DEB.w[i3] *= 0.5; DEB.w[i3 + 2] *= 0.5; }
        else DEB.life[i] = Math.min(DEB.life[i], 2.5 + Math.random() * 2);
      }
    }
    const sh = Math.min(1, DEB.life[i] / 0.8) * DEB.s[i];
    _p.set(DEB.p[i3], DEB.p[i3 + 1], DEB.p[i3 + 2]); _q.setFromEuler(_e.set(DEB.r[i3], DEB.r[i3 + 1], DEB.r[i3 + 2])); _s.set(sh, sh, sh);
    DEB.mesh.setMatrixAt(m, _m.compose(_p, _q, _s));
    DEB.mesh.setColorAt(m, _dc.setRGB(DEB.c[i3], DEB.c[i3 + 1], DEB.c[i3 + 2]));
    m++;
  }
  DEB.mesh.count = m;
  if (m) { DEB.mesh.instanceMatrix.needsUpdate = true; DEB.mesh.instanceColor.needsUpdate = true; }
  // rings and scorch marks
  for (const r of rings) {
    if (!r.visible) continue;
    const u = r.userData; u.t += dt;
    const k = u.t / 0.45;
    if (k >= 1) { r.visible = false; continue; }
    const s = u.r * (0.15 + 0.85 * (1 - (1 - k) * (1 - k)));
    r.scale.set(s, 1, s); r.material.opacity = 0.42 * (1 - k) * (1 - k);
  }
  for (const s of scorches) {
    if (!s.visible) continue;
    const u = s.userData; u.t += dt;
    s.material.opacity = u.t < 0.15 ? u.t / 0.15 * 0.9 : u.t < 40 ? 0.9 : Math.max(0, 0.9 * (1 - (u.t - 40) / 25));
    if (u.t > 65) s.visible = false;
  }
}

export const fx = {
  init() {
    initBlasts();
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
    resetBlasts();
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

  /**
   * A grenade or C4 going off (equipment.js _explode; the vehicles keep explosion()).
   * A white-hot core, a fireball, sparks and clods or chips thrown on arcs, a dust ring
   * racing out over the ground, a dark column that drifts with the wind, a scorch mark,
   * and a harder shake the closer the player is. kind: 'frag' | 'c4'.
   */
  blast(x, y, z, r, kind = 'frag') {
    const big = kind === 'c4', K = big ? 1.45 : 1, rnd = Math.random;
    // the ground under it: decal, ring, what flies
    const w = G.world;
    let gy = w ? w.h(x, z) : y - 0.1, nx = 0, ny = 1, nz = 0, mat = w ? w.surfaceAt(x, z) : 'dirt', onGround = y - gy < 1.4;
    if (w && w.raycast(x, y + 0.3, z, 0, -1, 0, 2.2, F.SOLID, _hit, null)) { gy = _hit.y; nx = _hit.nx; ny = _hit.ny; nz = _hit.nz; mat = _hit.mat || mat; onGround = ny > 0.55 && !(_hit.collider && _hit.collider.veh); }   // not on a hull
    const soil = !!SOIL[mat], stone = !soil && mat !== 'metal' && mat !== 'armor' && mat !== 'wood' && mat !== 'woodThin';
    const dust = soil ? (mat === 'grass' ? 0x6a6450 : 0x76664f) : stone ? 0x9a978e : 0x857a68;
    const cy = Math.max(y, gy + 0.15);
    // core flash and fireball
    emit(FIRE, x, cy + 0.3, z, 0, 0.5, 0, r * 0.32 * K, r * 0.62 * K, 0.13, 0xfff4d8, 0xffb060, 3.2, 0, 0);
    for (let i = 0; i < (big ? 16 : 11); i++) {
      const a = rnd() * 6.283, up = 0.25 + rnd() * 0.75, sp = (3 + rnd() * 6) * K, h = Math.sqrt(1 - up * up);
      emit(FIRE, x + Math.cos(a) * 0.3, cy + 0.2 + rnd() * 0.4, z + Math.sin(a) * 0.3, Math.cos(a) * h * sp, up * sp * 0.9, Math.sin(a) * h * sp,
        (0.7 + rnd() * 0.6) * K, (2.2 + rnd() * 1.6) * K, 0.32 + rnd() * 0.32, rnd() < 0.5 ? 0xffd27a : 0xffb44e, 0x8a2a08, 1.4 + rnd() * 0.8, 5.5, 2.5);
    }
    // sparks / fragments
    for (let i = 0; i < (big ? 70 : 48); i++) {
      const k = SPK.i = (SPK.i + 1) % SPARK_N, k3 = k * 3, a = rnd() * 6.283, up = -0.1 + rnd() * 0.9, h = Math.sqrt(1 - up * up), sp = 14 + rnd() * 26;
      SPK.p[k3] = x; SPK.p[k3 + 1] = cy + 0.25; SPK.p[k3 + 2] = z; SPK.v[k3] = Math.cos(a) * h * sp; SPK.v[k3 + 1] = up * sp; SPK.v[k3 + 2] = Math.sin(a) * h * sp;
      SPK.life[k] = SPK.max[k] = 0.25 + rnd() * 0.55;
    }
    // dirt clods or stone chips
    if (onGround) {
      _dc.set(soil ? 0x4a3c2c : stone ? 0x77746c : 0x5e4a34);
      for (let i = 0; i < (big ? 34 : 22); i++) {
        const k = DEB.i = (DEB.i + 1) % DEBRIS_N, k3 = k * 3, a = rnd() * 6.283, up = 0.45 + rnd() * 0.55, h = Math.sqrt(1 - up * up), sp = (4 + rnd() * 9) * (big ? 1.25 : 1);
        DEB.p[k3] = x + Math.cos(a) * 0.4; DEB.p[k3 + 1] = gy + 0.15; DEB.p[k3 + 2] = z + Math.sin(a) * 0.4;
        DEB.v[k3] = Math.cos(a) * h * sp; DEB.v[k3 + 1] = up * sp; DEB.v[k3 + 2] = Math.sin(a) * h * sp;
        DEB.w[k3] = (rnd() - 0.5) * 18; DEB.w[k3 + 1] = (rnd() - 0.5) * 18; DEB.w[k3 + 2] = (rnd() - 0.5) * 18;
        DEB.s[k] = (soil ? 0.05 : 0.035) + rnd() * (soil ? 0.09 : 0.06); DEB.life[k] = 9; DEB.hits[k] = 0;
        const t = 0.75 + rnd() * 0.5; DEB.c[k3] = _dc.r * t; DEB.c[k3 + 1] = _dc.g * t; DEB.c[k3 + 2] = _dc.b * t;
      }
      // dust ring racing out over the ground, the shock ring, the scorch
      for (let i = 0; i < (big ? 16 : 12); i++) {
        const a = i / (big ? 16 : 12) * 6.283 + rnd() * 0.3, sp = (7 + rnd() * 4) * K;
        emit(SMOKE, x + Math.cos(a) * 0.6, gy + 0.35, z + Math.sin(a) * 0.6, Math.cos(a) * sp, 0.4 + rnd() * 0.6, Math.sin(a) * sp, 0.9 * K, (3.2 + rnd() * 1.5) * K, 1.6 + rnd() * 1.2, dust, dust, 0.34, 2.6, 0.15);
      }
      const ring = rings[ri = (ri + 1) % RING_N];
      ring.position.set(x, gy + 0.06, z); ring.userData.t = 0; ring.userData.r = r * 0.9 * K; ring.material.color.set(dust); ring.visible = true; ring.scale.set(0.01, 1, 0.01);
      const sc = scorches[sci = (sci + 1) % SCORCH_N];
      sc.position.set(x + nx * 0.03, gy + ny * 0.03, z + nz * 0.03);
      sc.quaternion.setFromUnitVectors(_z, _n.set(nx, ny, nz)); sc.rotateZ(rnd() * 6.283);
      const ss = r * (big ? 0.62 : 0.42) * (0.9 + rnd() * 0.2); sc.scale.set(ss, ss, 1);
      sc.userData.t = 0; sc.material.opacity = 0; sc.visible = true;
    }
    // the dark column: billows up hot, cools to grey and drifts off
    for (let i = 0; i < (big ? 14 : 10); i++) {
      const a = rnd() * 6.283, d = rnd() * 0.8;
      emit(SMOKE, x + Math.cos(a) * d, cy + 0.4 + rnd() * 1.2, z + Math.sin(a) * d, Math.cos(a) * 0.6, 1.2 + rnd() * 2.6 * K, Math.sin(a) * 0.6,
        (1.6 + rnd()) * K, (4.5 + rnd() * 3) * K, 6 + rnd() * 5 * K, i % 3 ? 0x1c1a18 : 0x2a2622, 0x5a5650, 0.62, 0.9, 0.12);
    }
    for (let i = 0; i < 5; i++) emit(SMOKE, x + (rnd() - 0.5) * 2, gy + 0.6, z + (rnd() - 0.5) * 2, (rnd() - 0.5) * 1.5, 0.3, (rnd() - 0.5) * 1.5, 1.5 * K, 5 * K, 7 + rnd() * 4, dust, 0x6c6860, 0.35, 0.7, 0.05);
    // close by: shake harder and hear the dirt come down
    const p = G.player;
    if (p) {
      const dd = Math.hypot(p.x - x, p.y + 1 - y, p.z - z), reach = r * (big ? 4 : 3), k = 1 - dd / reach;
      if (k > 0) p.shake = Math.max(p.shake, Math.pow(k, 1.3) * (big ? 1.6 : 1.25));
      if (onGround && dd < r * 2.5) audio.play('debris', { x, y, z, vol: 0.7, ref: 6, low: true });
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
    stepBlasts(dt);
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
