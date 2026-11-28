/**
 * menu-scene.js — the live backdrop behind the front-end screens: the Şuşa
 * fortress on its cliff at first light above a misty forested gorge, two
 * friendly soldiers on a ledge in the foreground, a slow drifting camera with
 * mouse parallax and one camera shot per screen.
 *
 * Built with the game's own renderer and level kit (no image files). It never
 * sets G.level / G.world / G.nav, so the HUD, the AI and the mission do not
 * see it; it draws through G.overrideCamera, which also skips the view model.
 *
 *   menuScene.build()        build it into G.scene (no-op when already built); false if it failed
 *   menuScene.dispose()      remove it and free its geometry, materials and textures
 *   menuScene.shot(name)     ease the camera to the shot for a screen
 *   menuScene.frame(dtReal)  per-frame update while no mission is loaded
 *   menuScene.active         true while it is built
 *
 * World layout (metres, the camera looks roughly along −z): the ledge with the
 * soldiers at y ≈ 0, z > 8; the gorge floor at y ≈ −48 around z = −45; the far
 * cliff rises to the fortress plateau (y ≈ 24) at z ≈ −86 ± 10.
 */
import * as THREE from 'three';
import { G, hash2 } from './ctx.js';
import { R, ENV } from './render.js';
import { Level } from './level.js';
import { TEX_SCALE } from './textures.js';
import { worldMaterial } from './materials.js';
import { vcMaterial } from './models.js';
import { buildNature, natureKit } from './nature.js';
import { finalizeStructures } from './structures.js';
import { buildSoldier, soldierMaterial } from './soldier-model.js';
import { gatehouse, curtain, roundTower } from './fortress.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const PLATEAU = 24, FLOOR = -48;

/** The top edge (z) of the far cliff: it runs diagonally, near on the right, receding into the haze on the left. */
const edgeZ = (x) => -88 + 0.2 * x + 6 * Math.sin(x * 0.021 + 0.6) + 3 * Math.sin(x * 0.057 + 1.3);
/**
 * Terrain height: the ledge, a drop into the gorge, then the far side: a
 * forested slope and, under the walls, a band of bare limestone.
 */
function height(x, z) {
  const e = edgeZ(x);
  const relief = Math.sin(x * 0.11) * Math.cos(z * 0.09) * 0.7 + Math.sin(x * 0.31 + z * 0.17) * 0.3 + Math.sin(x * 0.043 - z * 0.05) * 1.6;
  let y = FLOOR * smooth(9, -30, z) + 54 * smooth(e + 64, e + 12, z);
  // the crown: buttresses and gullies so its edge is not a ruler line
  const crown = smooth(e + 10, e + 1.5, z);
  y += (PLATEAU - 6) * crown + crown * (1 - crown) * 4 * (2.2 * Math.sin(x * 0.19) + 1.2 * Math.sin(x * 0.53 + 1.7));
  y += relief * (0.35 + 1.5 * smooth(8, -20, z) * (1 - smooth(e + 2, e - 6, z) * 0.7));
  // hills rising far behind the fortress, a shoulder on the left of the ledge
  y += 26 * smooth(-170, -320, z) * (0.7 + 0.3 * Math.sin(x * 0.013));
  y += 9 * smooth(-12, -48, x) * smooth(-2, 14, z);
  // a wooded rise behind the ledge (the backdrop of the close shots)
  y += 16 * smooth(27, 72, z) * (0.8 + 0.2 * Math.sin(x * 0.05));
  return y;
}
const slopeAt = (x, z) => Math.hypot(height(x + 1.5, z) - height(x - 1.5, z), height(x, z + 1.5) - height(x, z - 1.5)) / 3;

/** Camera shots per screen: p = position, t = target, h = horizontal field of view (deg). */
export const SHOTS = {
  splash: { p: [-1, 1.6, 30], t: [-2, 20, -100], h: 60 },
  menu: { p: [-1.6, 1.05, 19], t: [-3.5, 19, -100], h: 64 },
  squad: { p: [6.6, 1.6, 18.6], t: [-0.6, 0.7, 12.6], h: 50 },
  gate: { p: [1, 1.9, 22], t: [5, 29, -88], h: 24 },
  vista: { p: [-5, 3.4, 25], t: [9, 14, -100], h: 76 },
  side: { p: [-4, 1.6, 24], t: [-12, 17, -100], h: 66 },
};
/** Soldier spots: x, z, facing yaw (0 = towards −z), look offset. a kneels, b stands. */
/** Where the gatehouse stands on the wall line (x). */
const GATE = [18];
export const SQUAD = { a: [0.4, 14.6, -1.05, 0.35], b: [2.4, 12.8, -0.05, 0.12] };
const SHOT_OF = { splash: 'splash', menu: 'menu', name: 'squad', diff: 'squad', brief: 'gate', credits: 'vista', settings: 'side', controls: 'side' };

let S = null;           // everything built: { group, cam, soldiers, mist, ... }
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
if (typeof window !== 'undefined') {
  window.addEventListener('mousemove', (e) => { mouse.x = (e.clientX / Math.max(1, innerWidth)) * 2 - 1; mouse.y = (e.clientY / Math.max(1, innerHeight)) * 2 - 1; }, { passive: true });
}

// ───────────────────────────── mist ─────────────────────────────
/** Tileable value-noise fbm in a small texture (the mist sheets scroll two copies of it). */
function noiseTexture(N = 128) {
  const data = new Uint8Array(N * N * 4);
  const vn = (u, v, s, per) => {
    const x = u * per, y = v * per, i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const w = (a) => a * a * (3 - 2 * a), L = (a, b) => hash2(((a % per) + per) % per + s * 131, ((b % per) + per) % per + s * 71);
    const a = L(i, j), b = L(i + 1, j), c = L(i, j + 1), d = L(i + 1, j + 1);
    return a + (b - a) * w(fx) + (c - a) * w(fy) + (a - b - c + d) * w(fx) * w(fy);
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N;
    let f = 0, amp = 0.55, tot = 0;
    for (let o = 0; o < 4; o++) { f += amp * vn(u, v, o + 1, 4 << o); tot += amp; amp *= 0.5; }
    const k = (y * N + x) * 4, val = Math.round((f / tot) * 255);
    data[k] = data[k + 1] = data[k + 2] = val; data[k + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
const MIST_VS = `varying vec2 vUv; varying float vDepth;
void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`;
const MIST_FS = `precision highp float;
uniform sampler2D uNoise; uniform float uTime, uOpacity, uFogDensity; uniform vec3 uColor, uFogColor; uniform vec2 uScale, uSpeed;
varying vec2 vUv; varying float vDepth;
void main(){
  vec2 p = vUv * uScale;
  float n = texture2D(uNoise, p + uSpeed * uTime).r;
  float m = texture2D(uNoise, p * 1.9 - uSpeed * uTime * 0.6 + 0.37).r;
  float d = smoothstep(0.3, 0.82, n * 0.62 + m * 0.5);
  float edge = smoothstep(0.0, 0.2, vUv.x) * smoothstep(1.0, 0.8, vUv.x) * smoothstep(0.0, 0.4, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
  float a = d * edge * uOpacity * smoothstep(3.0, 16.0, vDepth);
  float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
  gl_FragColor = vec4(mix(uColor, uFogColor, f * 0.6), a);
}`;
function mistSheet(noise, w, h, o) {
  const mat = new THREE.ShaderMaterial({ vertexShader: MIST_VS, fragmentShader: MIST_FS, transparent: true, depthWrite: false, fog: false,
    uniforms: { uNoise: { value: noise }, uTime: { value: 0 }, uOpacity: { value: o.opacity }, uFogDensity: { value: 0.006 },
      uColor: { value: new THREE.Color(o.color ?? 0xb9b4ae) }, uFogColor: { value: new THREE.Color(0x7d8288) },
      uScale: { value: new THREE.Vector2(o.su ?? 3, o.sv ?? 1) }, uSpeed: { value: new THREE.Vector2(o.speed ?? 0.004, 0.0015) } } });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.position.set(o.x ?? 0, o.y, o.z);
  if (o.flat) m.rotation.x = -Math.PI / 2;
  if (o.ry) m.rotation.y = o.ry;
  m.renderOrder = 5; m.frustumCulled = false; m.name = 'mist';
  return m;
}

// ───────────────────────────── build ─────────────────────────────
function buildTerrain(L) {
  const b = L.bounds, step = 3, nx = Math.ceil((b.maxX - b.minX) / step), nz = Math.ceil((b.maxZ - b.minZ) / step);
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3), col = new Float32Array((nx + 1) * (nz + 1) * 3), uv = new Float32Array((nx + 1) * (nz + 1) * 2);
  const grass = new THREE.Color(0x6d7552), litter = new THREE.Color(0x4a4a36), cliff = new THREE.Color(0xd2c9b6), tc = new THREE.Color(), us = TEX_SCALE.rock || 5;
  for (let iz = 0; iz <= nz; iz++) for (let ix = 0; ix <= nx; ix++) {
    const x = b.minX + ix * step, z = b.minZ + iz * step, k = iz * (nx + 1) + ix, y = height(x, z);
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
    // pale limestone in bedded courses where it is steep, leaf litter under the forest, grass on the ledge
    const s = slopeAt(x, z), v = 0.86 + hash2(ix, iz) * 0.22, e = edgeZ(x);
    tc.copy(grass).lerp(litter, smooth(4, -14, z) * (1 - smooth(e - 2, e - 10, z)));
    const rock = smooth(0.6, 1.25, s);
    tc.lerp(cliff, rock);
    const strata = 1 + rock * (0.16 * Math.sin(y * 1.9 + Math.sin(x * 0.27) * 1.6) - 0.12 * Math.max(0, Math.sin(x * 0.9 + y * 0.15)));
    tc.multiplyScalar(strata);
    col[k * 3] = tc.r * v; col[k * 3 + 1] = tc.g * v; col[k * 3 + 2] = tc.b * v;
    // project the texture along the steeper axis so cliffs are not smeared
    uv[k * 2] = x / us; uv[k * 2 + 1] = (z + y * 0.9) / us;
  }
  const idx = new Uint32Array(nx * nz * 6);
  let q = 0;
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const a = iz * (nx + 1) + ix, c = a + nx + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = a + 1; idx[q++] = a + 1; idx[q++] = c; idx[q++] = c + 1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, worldMaterial('rock'));
  m.receiveShadow = true; m.name = 'terrain';
  return m;
}

/** True when a tree at (x, z) would throw its shadow over the squad in the low dawn sun. */
function shadesSquad(x, z) {
  const dx = x - 1.4, dz = z - 13.7, d = Math.hypot(dx, dz), sd = ENV.menu.sunDir, sl = Math.hypot(sd[0], sd[2]);
  return d < 110 && (dx * sd[0] + dz * sd[2]) / (d * sl) > 0.96;
}

function buildWorld(L) {
  const tier = R.quality;
  // ── fortress: curtain wall along the plateau edge, the gatehouse facing the gorge
  // the wall follows the diagonal edge 8 m back from it; the gate sits square to it
  const wz = (x) => edgeZ(x) - 8, rot = -Math.atan(0.2), gx = GATE[0], gz = wz(gx) - 2;
  const gc = Math.cos(rot), gs = Math.sin(rot), half = 9.6;
  const left = [[-215, wz(-215) - 4], [-160, wz(-160)], [-108, wz(-108) + 2], [-62, wz(-62)], [-24, wz(-24) + 1]];
  const right = [[54, wz(54)], [96, wz(96) + 1.5], [140, wz(140)], [196, wz(196) - 6]];
  curtain(L, [...left, [gx - half * gc, gz + half * gs]], { h: 9, towerR: 4.4, towerH: 12.5, skip: [left.length] });
  curtain(L, [[gx + half * gc, gz - half * gs], ...right], { h: 9, towerR: 4.6, towerH: 12.5, skip: [0] });
  gatehouse(L, gx, gz, height(gx, gz + 3), rot, { w: 13.4, h: 11, towerR: 5, towerH: 14.5 });
  // a keep rising behind the wall (the town itself is out of sight from the ledge)
  roundTower(L, -44, wz(-44) - 30, height(-44, wz(-44) - 30), { r: 5.6, h: 19, seg: 26 });
  // ── trees: the gorge slopes, the shoulders of the ledge, a few on the plateau
  const n = tier === 'low' ? 120 : tier === 'medium' ? 190 : 260;
  let placed = 0;
  for (let i = 0; placed < n && i < n * 8; i++) {
    // the far slope, thickest just under the crown where it is seen from the ledge
    const x = -230 + hash2(i * 13 + 1, 7) * 470, e = edgeZ(x), z = e + 11 + Math.pow(hash2(i * 7 + 3, 19), 1.4) * 46;
    if (z > -6) continue;
    if (slopeAt(x, z) > 1.15 && hash2(i, 5) > 0.2) continue;    // only a few cling to the rock
    const s = 0.95 + hash2(i, 11) * 0.8;
    L.tree(x, z, s, z < e + 30 && hash2(i, 23) > 0.6 ? 1 : 0); placed++;     // broadleaves only high up, out of the mist
  }
  // the shoulders of the ledge, framing the view across
  for (let i = 0; i < 26; i++) {
    const side = i % 2 ? 1 : -1, x = side * (24 + hash2(i, 71) * 46), z = 10 + hash2(i, 73) * 34;
    if (!shadesSquad(x, z)) L.tree(x, z, 1.0 + hash2(i, 79) * 0.5, 0);
  }
  // the wood on the rise behind the ledge
  for (let i = 0; i < 46; i++) {
    const x = -70 + hash2(i, 87) * 150, z = 27 + hash2(i, 89) * 42;
    if (Object.values(SHOTS).some((s) => Math.hypot(x - s.p[0], z - s.p[2]) < 12)) continue;     // never right in front of a camera
    if (!shadesSquad(x, z)) L.tree(x, z, 1.0 + hash2(i, 97) * 0.6, hash2(i, 101) < 0.8 ? 0 : 1);
  }
  // boulders on the ledge lip and the crown (the rock kit has no far LOD, and the cliff foot is under the mist anyway)
  for (let i = 0; i < 22; i++) {
    const x = -150 + hash2(i * 5, 41) * 300, lip = i % 2 === 0;
    const z = lip ? 5 + hash2(i, 43) * 5 : edgeZ(x) + 6 + hash2(i, 53) * 10;
    if (lip && Math.abs(x - 1) < 12) continue;
    L.rock(x, z, lip ? 1.2 + hash2(i, 59) * 1.6 : 3 + hash2(i, 61) * 4);
  }
  // the squad's rock and a little cover round it
  for (const [x, z, s] of [[1.5, 13.4, 0.5], [5.6, 15.8, 0.6], [-8, 9.5, 1.0], [10, 9.2, 0.9]]) L.rock(x, z, s);
  for (const [x, z, r] of [[-9, 16, 1.7], [11, 17.5, 1.8], [-15, 12, 2.1], [15, 10.5, 1.5]]) L.bush(x, z, r);
}

function finalize(L, group) {
  group.add(buildTerrain(L));
  for (const [tex, geo] of L.batches) {
    if (!geo.count) continue;
    let mat;
    if (tex === 'glow') mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    else if (tex === 'glow0') mat = worldMaterial(null);
    else mat = worldMaterial(tex, { side: tex === 'roof' || tex === 'cloth' ? THREE.DoubleSide : THREE.FrontSide });
    const m = new THREE.Mesh(geo.build(), mat);
    m.castShadow = tex !== 'glow'; m.receiveShadow = tex !== 'glow';
    group.add(m);
  }
  // ground cover only on the ledge round the soldiers: nature scatters over L.bounds, so narrow it for the call
  const full = L.bounds;
  L.bounds = { minX: -16, maxX: 26, minZ: 7, maxZ: 27 };
  L.terrainOpts.surface = (x, z) => (z > 5 && slopeAt(x, z) < 0.5 ? 'grass' : 'rock');
  L.nature = buildNature(L, { group, maxDist: 240, lodDist: 30 });
  L.bounds = full;
  finalizeStructures(L);
  for (const c of [...L.group.children]) group.add(c);
}

function buildSoldiers(group) {
  const a = buildSoldier('friendly', { variant: 0 }), b = buildSoldier('friendly', { variant: 1 });
  // kneeling with his rifle, watching the gorge; standing beside him, looking up at the walls
  const place = (s, x, z, yaw) => { s.mesh.position.set(x, height(x, z), z); s.mesh.rotation.y = yaw; s.mesh.castShadow = true; s.mesh.receiveShadow = true; s.rig.setGround(height); group.add(s.mesh); };
  place(a, SQUAD.a[0], SQUAD.a[1], SQUAD.a[2]); a.rig.setCrouch(true); a.rig.setLook(SQUAD.a[3]);
  place(b, SQUAD.b[0], SQUAD.b[1], SQUAD.b[2]); b.rig.setLook(SQUAD.b[3]);
  for (let i = 0; i < 45; i++) { a.rig.update(1 / 30); b.rig.update(1 / 30); }
  return [a, b];
}

/** Vertical field of view for a horizontal one at this aspect, kept within sane limits. */
const vfov = (h, aspect) => Math.min(74, Math.max(18, (2 * Math.atan(Math.tan((h * Math.PI) / 360) / aspect) * 180) / Math.PI));

export const menuScene = {
  active: false,
  /** Build time in ms and the object count, for the debug overlay and tests. */
  stats: null,

  build() {
    if (this.active) return true;
    if (this.failed) return false;          // one failed build is enough: the screens fall back to the plain gradient
    const t0 = performance.now(), vmWas = G.vmVisible, postWas = { ...R.post };
    let cam = null;
    const group = new THREE.Group();
    group.name = 'menuBackdrop';
    try {
      const L = new Level(0);
      L.terrain({ bounds: { minX: -260, maxX: 260, minZ: -340, maxZ: 72 }, height, tex: 'rock', step: 4, surface: () => 'rock' });
      buildWorld(L);
      finalize(L, group);
      const soldiers = buildSoldiers(group);
      const noise = noiseTexture();
      // mist banks along the far slope (turned with the cliff), one over the gorge floor, a wisp below the ledge lip
      const ry = -Math.atan(0.2), z0 = edgeZ(0);
      const mist = [
        mistSheet(noise, 600, 30, { y: -5, z: z0 + 30, ry, opacity: 0.55, su: 4.5, sv: 0.6 }),
        mistSheet(noise, 600, 16, { y: 5, z: z0 + 15, ry, opacity: 0.32, su: 5, sv: 0.5, speed: -0.003 }),
        mistSheet(noise, 600, 26, { y: -12, z: z0 + 50, ry, opacity: 0.42, su: 4, sv: 0.6, speed: 0.005 }),
        mistSheet(noise, 600, 120, { y: -24, z: -30, flat: true, opacity: 0.55, su: 4, sv: 1 }),
      ];
      if (R.quality !== 'low') mist.push(mistSheet(noise, 160, 11, { x: 4, y: -3, z: 4, opacity: 0.26, su: 1.8, sv: 0.5, speed: 0.006 }));
      for (const m of mist) group.add(m);
      cam = new THREE.PerspectiveCamera(50, 1, 0.1, 700);
      cam.rotation.order = 'YXZ';
      G.scene.add(group);
      S = { group, L, soldiers, mist, noise, cam, time: 0, shot: 'menu', vmWas, postWas,
        p: new THREE.Vector3(), t: new THREE.Vector3(), fov: 50, vp: new THREE.Vector3(), vt: new THREE.Vector3(), vf: 0, snapped: false, aspect: 0 };
      G.overrideCamera = cam;
      G.vmVisible = false;
      R.setDprCap(1.5);
      R.setEnv('menu');
      R.setLamps([]);
      Object.assign(R.post, { nv: 0, blur: 0, flash: 0, damage: 0, motion: 0, desat: 0, scope: 0, vignette: 0.42 });
      this.active = true;
      this.stats = { ms: Math.round(performance.now() - t0), objects: group.children.length };
      this.shot('menu', true);
      return true;
    } catch (err) {
      console.warn('menu backdrop unavailable:', err);
      disposeGroup(group);
      if (cam && G.overrideCamera === cam) G.overrideCamera = null;
      G.vmVisible = vmWas; Object.assign(R.post, postWas); R.setDprCap(0);
      S = null; this.failed = true;
      return false;
    }
  },

  dispose() {
    if (!S) { this.active = false; return; }
    G.scene.remove(S.group);
    disposeGroup(S.group);
    S.noise.dispose();
    if (G.overrideCamera === S.cam) G.overrideCamera = null;
    G.vmVisible = S.vmWas;
    Object.assign(R.post, S.postWas);       // the mission keeps its own vignette
    R.setLamps([]);
    R.setDprCap(0);
    S = null;
    this.active = false;
  },

  /** Ease to a screen's shot (snap: jump there, used on build and with reduced motion). */
  shot(name, snap = false) {
    if (!S) return;
    const key = SHOT_OF[name] || (SHOTS[name] ? name : 'menu');
    if (key === S.shot && !snap) return;
    S.shot = key;
    if (snap || reduced()) S.snapped = false;
  },

  frame(dt) {
    if (!S) return;
    const cam = S.cam, sh = SHOTS[S.shot], aspect = R.width / Math.max(1, R.height), rm = reduced();
    S.time += dt;
    const tgtFov = vfov(sh.h, aspect);
    if (!S.snapped) {
      S.p.fromArray(sh.p); S.t.fromArray(sh.t); S.fov = tgtFov; S.vp.set(0, 0, 0); S.vt.set(0, 0, 0); S.vf = 0; S.snapped = true;
    } else {
      // critically damped spring: eases out of the old shot and into the new one
      const w = 1.9, h = Math.min(dt, 0.05);
      const spring = (cur, vel, goal) => {
        const ax = w * w * (goal.x - cur.x) - 2 * w * vel.x, ay = w * w * (goal.y - cur.y) - 2 * w * vel.y, az = w * w * (goal.z - cur.z) - 2 * w * vel.z;
        vel.x += ax * h; vel.y += ay * h; vel.z += az * h; cur.x += vel.x * h; cur.y += vel.y * h; cur.z += vel.z * h;
      };
      spring(S.p, S.vp, _g.fromArray(sh.p));
      spring(S.t, S.vt, _g.fromArray(sh.t));
      const af = w * w * (tgtFov - S.fov) - 2 * w * S.vf; S.vf += af * h; S.fov += S.vf * h;
    }
    // slow handheld drift and mouse parallax (none with reduced motion)
    const k = rm ? 0 : 1, t = S.time;
    mouse.sx += (mouse.x - mouse.sx) * Math.min(1, dt * 2.5); mouse.sy += (mouse.y - mouse.sy) * Math.min(1, dt * 2.5);
    cam.position.set(S.p.x + k * (Math.sin(t * 0.071) * 0.5 + mouse.sx * 0.55), S.p.y + k * (Math.sin(t * 0.053 + 1) * 0.18 - mouse.sy * 0.22), S.p.z + k * Math.sin(t * 0.061 + 2) * 0.35);
    _g.set(S.t.x + k * (Math.sin(t * 0.043) * 0.9 - mouse.sx * 0.8), S.t.y + k * (Math.sin(t * 0.037 + 0.5) * 0.4 + mouse.sy * 0.35), S.t.z);
    cam.lookAt(_g);
    if (cam.fov !== S.fov || aspect !== S.aspect) { cam.fov = S.fov; cam.aspect = aspect; S.aspect = aspect; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    // soldiers breathe and shift; the mist drifts
    for (const s of S.soldiers) s.rig.update(Math.min(dt, 0.05));
    for (const m of S.mist) { m.material.uniforms.uTime.value = t; m.material.uniforms.uFogDensity.value = G.scene.fog.density; m.material.uniforms.uFogColor.value.copy(G.scene.fog.color); }
    R.update(dt, G.realTime, cam);
  },
};
const _g = new THREE.Vector3();

/** Free a backdrop group: own geometry, materials and batch textures; the shared soldier and nature assets stay. */
function disposeGroup(group) {
  const keep = new Set([soldierMaterial(), vcMaterial(), vcMaterial(true)]);
  try { for (const m of Object.values(natureKit().mats)) keep.add(m); } catch { /* kit not built */ }
  group.traverse((o) => {
    if (o.isBatchedMesh) { o.dispose(); }
    else if (o.isSkinnedMesh) { if (o.skeleton) o.skeleton.dispose(); }      // its bone texture; the geometry is cached per variant
    else if (o.geometry) o.geometry.dispose();
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (!keep.has(m)) m.dispose();
    }
  });
  if (group.parent) group.parent.remove(group);
}
