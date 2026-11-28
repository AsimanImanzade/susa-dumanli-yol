/**
 * vm-items.js — first-person animations for everything that is not a gun:
 * medkit, bandage, tourniquet, armour plate, suppressor repair, the throwables
 * (pin, spoon, throw) and C4 (pressing a charge on, the firing device).
 *
 * Purely cosmetic. It reads equipment.js state — using { item, t, dur }, cook
 * { t, kind }, c4s, c4Hold / c4Placed and the event counters in equip.anim —
 * and never changes it (it only hides a freshly placed charge until the hand
 * gets there). weapons.frame() calls frame() every rendered frame after posing
 * the gun and reads back:
 *   active     an item animation owns the view model
 *   lower      0..1 how far to lower the gun
 *   dipY       camera-only pitch offset (looking down at a thigh, a plate carrier)
 *   gun        pose offsets for the gun (repair turns it to show the can)
 *   handLOut   0..1 the gun's support hand moves away (repair)
 *   showSup    keep the suppressor on screen (repair)
 * Everything is built once in init(); frame() allocates nothing.
 *
 * Arms: one Group per arm, origin at the wrist, fingers along −Z, back of the
 * hand +Y, the forearm along +Z (weapon-models.js buildItemKit). Rotations are
 * Euler 'YXZ' = [pitch, yaw, roll]: roll −π/2 turns a right palm to the left
 * (thumb up), +π/2 a left one to the right; π turns a palm up.
 */
import * as THREE from 'three';
import { G, clamp01 } from './ctx.js';
import { buildItemKit, KIT } from './weapon-models.js';
import { buildItemModel, buildPickupModel } from './pickup-models.js';
import { TEX } from './textures.js';
import { audio } from './audio.js';

const PI = Math.PI, TAU = PI * 2;
const lin = (a, b, x) => clamp01((x - a) / (b - a));
const ss = (a, b, x) => { const t = lin(a, b, x); return t * t * (3 - 2 * t); };
const bump = (a, b, x) => Math.sin(PI * lin(a, b, x));
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ'), _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _X = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3(), _UP = new THREE.Vector3(0, 1, 0);
const P6 = [0, 0, 0, 0, 0, 0], Q6 = [0, 0, 0, 0, 0, 0], P3 = [0, 0, 0], SEC = { c: [0, 0, 0], w: 0, h: 0, r: 0.05 };
const PROPS = [];                 // every prop that _clear() hides
/** What the camera and gun were doing when an animation was cut short, faded out over the drop. */
const HELD = { dip: 0, hl: 0, sup: false, g: [0, 0, 0, 0, 0, 0] };

// points in the right hand's frame (the left hand mirrors x)
const GRIP = new THREE.Vector3(-0.008, -0.042, -0.054), FIST = new THREE.Vector3(-0.004, -0.03, -0.056);
const PINCH = new THREE.Vector3(-0.026, -0.03, -0.1), PALM = new THREE.Vector3(0, -0.024, -0.054);
const mirror = (v) => new THREE.Vector3(-v.x, v.y, v.z);
const GRIP_L = mirror(GRIP), FIST_L = mirror(FIST), PINCH_L = mirror(PINCH), PALM_L = mirror(PALM);
const ROD_DIR = new THREE.Vector3(-1, 0, 0), ROD_TIP = FIST_L.clone().addScaledVector(ROD_DIR, 0.336);

/** Monotone cubic through keys [k, v0..v5]: flat segments hold exactly, nothing overshoots. */
function track(T, k, out) {
  const n = T.length, C = out.length;
  if (k <= T[0][0]) { for (let c = 0; c < C; c++) out[c] = T[0][c + 1]; return out; }
  if (k >= T[n - 1][0]) { for (let c = 0; c < C; c++) out[c] = T[n - 1][c + 1]; return out; }
  let i = 0;
  while (k > T[i + 1][0]) i++;
  const a = T[i], b = T[i + 1], p = T[i - 1], q = T[i + 2], h = b[0] - a[0], u = (k - a[0]) / h;
  const u2 = u * u, u3 = u2 * u, h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  for (let c = 1; c <= C; c++) {
    const d = (b[c] - a[c]) / h;
    let m0 = 0, m1 = 0;
    if (p && d !== 0) { const d0 = (a[c] - p[c]) / (a[0] - p[0]); if (d0 * d > 0) m0 = Math.sign(d) * Math.min(Math.abs((d0 + d) / 2), 3 * Math.min(Math.abs(d0), Math.abs(d))); }
    if (q && d !== 0) { const d1 = (q[c] - b[c]) / (q[0] - b[0]); if (d1 * d > 0) m1 = Math.sign(d) * Math.min(Math.abs((d1 + d) / 2), 3 * Math.min(Math.abs(d1), Math.abs(d))); }
    out[c - 1] = h00 * a[c] + h10 * h * m0 + h01 * b[c] + h11 * h * m1;
  }
  return out;
}
function mix6(a, b, t, out = a) { for (let i = 0; i < 6; i++) out[i] = a[i] + (b[i] - a[i]) * t; return out; }

// ───────────────────────────── arms ─────────────────────────────
function makeArm(hands, left) {
  const g = new THREE.Group(); g.rotation.order = 'YXZ';
  const h = {};
  for (const n in hands) { const m = left ? hands[n].clone() : hands[n]; if (left) m.scale.x = -1; m.visible = false; g.add(m); h[n] = m; }
  return { g, h, cur: null };
}
function hand(arm, name) { if (arm.cur === name) return; if (arm.cur) arm.h[arm.cur].visible = false; if (name) arm.h[name].visible = true; arm.cur = name; arm.g.visible = !!name; }
function put(arm, v) { arm.g.position.set(v[0], v[1], v[2]); arm.g.rotation.set(v[3], v[4], v[5]); }
/** Arm pose (into out) that puts the arm-local point P on the rig-space point T with orientation [pitch, yaw, roll]. */
function anchor(out, T, P, rx, ry, rz) {
  _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ'));
  _v3.copy(P).applyQuaternion(_q);
  out[0] = T.x - _v3.x; out[1] = T.y - _v3.y; out[2] = T.z - _v3.z; out[3] = rx; out[4] = ry; out[5] = rz;
  return out;
}

/**
 * Arm pose (into out) that points the arm-local unit direction r (perpendicular to the forearm, +Z)
 * along the rig-space direction D, turns the forearm toward F, and puts the local point P on T.
 */
const _Z0 = new THREE.Vector3(0, 0, 1), _rc = new THREE.Vector3(), _D = new THREE.Vector3(), _F = new THREE.Vector3();
function aim(out, T, P, r, D, F) {
  _D.copy(D).normalize(); _F.copy(F).addScaledVector(_D, -_F.dot(_D)).normalize();
  _m.makeBasis(_D, _F, _rc.crossVectors(_D, _F));
  _m2.makeBasis(r, _Z0, _v3.crossVectors(r, _Z0)).transpose();
  _m.multiply(_m2);
  _e.setFromRotationMatrix(_m, 'YXZ');
  return anchor(out, T, P, _e.x, _e.y, _e.z);
}

// ───────────────────────────── held throwables ─────────────────────────────
/**
 * An item model (pickup-models.js) with its fuze pieces split off so they can come
 * away: the fuze() call is the last thing a grenade adds, lever (10-station strap),
 * pin (lathe), ring (torus) in that order, and the welded geometry keeps triangle
 * order, so the pieces are draw ranges over the shared buffers. Checked against
 * the shapes; on any mismatch the grenade stays whole.
 */
function heldItem(kind) {
  const m = buildItemModel(kind), root = new THREE.Group();
  m.frustumCulled = false; root.add(m);
  const out = { root, body: m, pin: null, lever: null };
  if (kind !== 'frag' && kind !== 'smoke' && kind !== 'flash') return out;
  const g = m.geometry, I = g.index.array, P = g.attributes.position.array, n = g.index.count / 3;
  const nRing = KIT.torus(0.0115, 0.0012, 16, 5).p.length / 9;
  const nPin = KIT.lathe([[0, -0.015], [0.0011, -0.015], [0.0011, 0.016], [0, 0.0162]], { seg: 6, axis: 'z' }).p.length / 9;
  const st = []; for (let i = 0; i < 10; i++) st.push({ c: [0, -i * 0.01, 0], w: 0.0125, h: 0.0013, r: 0.0005 });
  const nLever = KIT.loft(st, { up: [1, 0, 0], cap0: 'flat', cap1: 'flat', cseg: 1, sseg: 0 }).p.length / 9;
  const r0 = n - nRing, p0 = r0 - nPin, l0 = p0 - nLever;
  const all = (a, b, f) => { for (let i = a * 3; i < b * 3; i++) { const v = I[i] * 3; if (!f(P[v], P[v + 1], P[v + 2])) return false; } return true; };
  if (l0 <= 0 || !all(r0, n, (x, y, z) => z < -0.012) || !all(p0, r0, (x) => Math.abs(x) < 0.0014) || !all(l0, p0, (x, y, z) => Math.abs(z) < 0.0068)) return out;
  let px = 0, py = 0, pz = 0, ly = -1;
  for (let i = p0 * 3; i < r0 * 3; i++) { const v = I[i] * 3; px += P[v]; py += P[v + 1]; pz += P[v + 2]; }
  px /= nPin * 3; py /= nPin * 3; pz /= nPin * 3;
  for (let i = l0 * 3; i < p0 * 3; i++) ly = Math.max(ly, P[I[i] * 3 + 1]);
  const sub = (a, b) => { const s = new THREE.BufferGeometry(); for (const k in g.attributes) s.setAttribute(k, g.attributes[k]); s.setIndex(g.index); s.setDrawRange(a * 3, (b - a) * 3); s.boundingSphere = g.boundingSphere; return s; };
  m.geometry = sub(0, l0);
  const piece = (geo, pv) => { const grp = new THREE.Group(), mm = new THREE.Mesh(geo, m.material); mm.frustumCulled = false; mm.position.set(-pv[0], -pv[1], -pv[2]); grp.add(mm); grp.position.fromArray(pv); root.add(grp); return grp; };
  out.pin = piece(sub(p0, n), [px, py, pz]);
  out.lever = piece(sub(l0, p0), [0.0128, ly - 0.005, 0]);
  return out;
}

// loose pieces flying off (pin and ring, spoon, injector cap): reparented to the rig, simple ballistics
function flyer(obj) { return { obj, home: obj.parent, p: obj.position.clone(), q: obj.quaternion.clone(), v: new THREE.Vector3(), w: new THREE.Vector3(), t: 0, on: false }; }
function rehome(f) { f.on = false; f.home.add(f.obj); f.obj.position.copy(f.p); f.obj.quaternion.copy(f.q); f.obj.visible = true; }

// ───────────────────────────── module state ─────────────────────────────
let rig = null, R = null, L = null, K = null;
const items = {};                  // held throwables by kind
const fly = [];
const leds = [];
const S = { mode: null, item: null, ref: null, k: 0, pk: 0, t: 0, pt: 0, kind: null, exitT: 0, swing: null, shot: -1, c4: null };
const seen = { use: 0, thrown: 0, placed: 0, det: 0 };
const SW = [[0, 0, 0, 0, 0, 0, 0], [0.07, 0, 0, 0, 0, 0, 0], [0.2, 0, 0, 0, 0, 0, 0], [0.36, 0, 0, 0, 0, 0, 0]];   // swing keys, filled per throw

export const vmItems = {
  active: false, lower: 0, dipY: 0, handLOut: 0, showSup: false,
  gun: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
  /** Dev: { kind: 'medkit' | 'frag' | …, k } freezes an animation at k (0..1, or seconds for throws). */
  freeze: null,

  init() {
    const kit = buildItemKit();
    K = kit.props; K.section = kit.section;
    rig = new THREE.Group(); rig.name = 'vmItems'; rig.visible = false;
    R = makeArm(kit.hands, false); L = makeArm(kit.hands, true);
    rig.add(R.g, L.g);
    G.vmScene.add(rig);
    rig.traverse((o) => { o.frustumCulled = false; });
    // ── right hand
    for (const kind of ['frag', 'smoke', 'flash', 'stone', 'tknife']) {
      const it = heldItem(kind); items[kind] = it;
      it.root.visible = false; R.g.add(it.root);
      if (kind === 'tknife') {         // pinched by the blade near the tip, the handle out past the thumb
        it.root.rotation.set(0.25, -PI / 2 + 0.2, 0.3); it.root.position.copy(PINCH).add(_v.set(0, 0, -0.105).applyEuler(it.root.rotation).negate());
      } else if (kind === 'stone') { it.root.position.copy(GRIP); it.root.rotation.set(0.3, 0.4, 0); }
      else { it.root.position.copy(GRIP).add(_v.set(0.004, -0.004, 0)); it.root.rotation.set(0, PI, PI / 2, 'ZYX'); }  // fuze to the thumb, lever in the palm
      if (it.pin) { it.pinF = flyer(it.pin); it.leverF = flyer(it.lever); fly.push(it.pinF, it.leverF); }
    }
    K.injR = K.injector.root; K.injR.visible = false; R.g.add(K.injR);
    K.injR.position.copy(FIST); K.injR.rotation.set(0, -PI / 2, 0);            // needle out of the little-finger side
    K.capF = flyer(K.injector.cap); fly.push(K.capF);
    K.dressing.visible = false; R.g.add(K.dressing); K.dressing.position.copy(PALM).add(_v.set(0, -0.008, 0));
    K.roll.visible = false; R.g.add(K.roll); K.roll.position.copy(GRIP).add(_v.set(0.004, 0.006, 0));
    // ── left hand
    const pouch = K.pouch.root; pouch.visible = false; L.g.add(pouch);
    pouch.position.set(0, -0.05, -0.058); pouch.rotation.set(PI, 0, 0);       // lid up when the palm is turned up, hinge away from the camera
    K.injP = K.injector.root.clone();                                           // the one still in the pouch
    K.injP.scale.setScalar(0.85); K.injP.position.set(0.004, K.pouch.size[1] / 2 - 0.006, 0.012); K.injP.rotation.set(0, PI / 2, 0); pouch.add(K.injP);
    K.c4 = buildItemModel('c4'); K.c4.visible = false; K.c4.frustumCulled = false; L.g.add(K.c4);
    K.c4.position.copy(PALM_L).add(_v.set(0, -0.03, -0.012)); K.c4.rotation.set(0, PI / 2, PI, 'ZYX');   // on the upturned palm, along the fingers
    const clk = K.clacker.root; clk.visible = false; L.g.add(clk);
    clk.position.copy(GRIP_L).add(_v.set(0, 0.004, 0)); clk.rotation.set(0, -PI / 2, PI);
    const rod = K.rod; rod.visible = false; L.g.add(rod);
    rod.position.copy(FIST_L); rod.rotation.set(0, PI / 2, 0);               // rod out of the little-finger side
    for (const w of K.wraps) { w.visible = false; L.g.add(w); }
    K.tourniquet.root.visible = false; L.g.add(K.tourniquet.root);
    K.strip.visible = false; L.g.add(K.strip);
    // ── on the body: the plate carrier with the plate that goes into it
    K.carrier.visible = false; rig.add(K.carrier);
    K.plate = buildPickupModel('plate');
    for (const c of [...K.plate.children]) if (c.isSprite) K.plate.remove(c);
    K.plate.rotation.order = 'YXZ'; K.plate.frustumCulled = false; K.plate.visible = false; K.carrier.add(K.plate);
    // ── LEDs on the placed charges (world scene)
    const lm = new THREE.SpriteMaterial({ map: TEX.puff, color: 0xff3020, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    for (let i = 0; i < 8; i++) { const s = new THREE.Sprite(lm); s.scale.setScalar(0.035); s.position.set(-0.006, 0.033, -0.006); s.visible = false; leds.push({ s, mesh: null, ph: i * 0.37 }); }
    PROPS.push(K.injR, K.injP, K.dressing, K.roll, K.pouch.root, K.c4, K.clacker.root, K.rod, K.tourniquet.root, K.strip, K.carrier, K.plate, ...K.wraps);
    this.items = items;
    this.kitMs = kit.ms;
    this.reset();
  },

  reset() {
    if (!rig) return;
    this._stop();
    const A = G.equip && G.equip.anim;
    if (A) { seen.use = A.use; seen.thrown = A.thrown; seen.placed = A.placed; seen.det = A.det; }
    for (const l of leds) { if (l.mesh) l.mesh.remove(l.s); l.mesh = null; }
  },

  // ───────────────────────── per frame ─────────────────────────
  /** vm: the gun view model on screen (posed this frame), or null when the view model is hidden. */
  frame(dt, vm) {
    if (!rig) return;
    const e = G.equip, w = G.weapons;
    if (!e) return;
    this.dipY = 0; this.handLOut = 0; this.showSup = false;
    const gn = this.gun; gn.x = gn.y = gn.z = gn.rx = gn.ry = gn.rz = 0;
    this._leds(dt);
    this._fly(dt);
    const A = e.anim;
    const used = A.use !== seen.use, thrown = A.thrown !== seen.thrown, placed = A.placed !== seen.placed, det = A.det !== seen.det;
    seen.use = A.use; seen.thrown = A.thrown; seen.placed = A.placed; seen.det = A.det;
    const fz = this.freeze;

    // ── what is going on
    if (fz) { if (S.mode !== 'frozen' || S.item !== fz.kind) this._start('frozen', fz.kind); }
    else if (S.mode === 'frozen') this._stop();
    else if (e.using) {
      if (S.mode !== 'use' || S.ref !== e.using) this._start('use', e.using.item, e.using);
      S.k = e.using.t / e.using.dur;
    } else if (S.mode === 'use') {
      if (used && (A.item === 'medkit' || A.item === 'bandage') && G.player) G.player.relief = 1;
      this._exit();
    }
    if (!fz && e.cook) {
      if (S.mode !== 'cook' || S.ref !== e.cook) this._start('cook', e.cook.kind, e.cook);
      S.t = e.cook.t;
    } else if (S.mode === 'cook') {
      if (thrown) this._startSwing(); else this._exit();
    }
    const blocked = w.reloading || w.switching || w.melee || w.takedown || w.ads > 0.2;
    if (!fz && placed && !e.using && !e.cook && !blocked) { this._start('place', 'c4'); const c = e.c4s[e.c4s.length - 1]; S.c4 = c || null; if (c) c.mesh.visible = false; this._led(c); }
    const holding = e.c4Hold > 0.06 && !e.c4Placed && e.c4s.length > 0;
    if (!fz && holding && S.mode !== 'det' && !e.using && !e.cook && !blocked && w.lastShot === S.lastShot) this._start('det', 'clacker');
    S.lastShot = w.lastShot;
    if (S.mode === 'det') {
      if (det) { S.fired = true; S.t = 0; audio.play('clack', { vol: 0.6 }); }
      else if (!S.fired && !holding) this._exit();
    }
    if (S.mode && S.mode !== 'use' && S.mode !== 'cook' && S.mode !== 'frozen' && !(S.mode === 'det' && !S.fired)) S.t += dt;
    // a tail (throw follow-through, C4 push, clacker after the blast, a drop) gives way to the gun at once
    const tail = S.mode === 'swing' || S.mode === 'place' || S.mode === 'exit' || S.mode === 'det';
    if (tail && (w.lastShot !== S.shot || w.reloading || w.switching || w.melee || w.takedown || w.ads > 0.2)) this._stop();
    if (S.mode === 'exit' && S.exitT >= 0.26) this._stop();

    this.active = !!S.mode;
    rig.visible = this.active && !!vm;
    if (!S.mode) { this.lower = 0; return; }
    if (S.mode === 'exit') {
      S.exitT += dt; rig.position.y = -0.42 * ss(0, 0.26, S.exitT); this.lower = 0;
      // the camera glance, a turned gun, a moved support hand: eased back, not snapped
      const f = 1 - ss(0, 0.26, S.exitT), H = HELD;
      this.dipY = H.dip * f; this.handLOut = H.hl * f; this.showSup = H.sup && f > 0.3;
      gn.x = H.g[0] * f; gn.y = H.g[1] * f; gn.z = H.g[2] * f; gn.rx = H.g[3] * f; gn.ry = H.g[4] * f; gn.rz = H.g[5] * f;
      return;
    }

    // ── pose
    const kind = S.mode === 'frozen' ? fz.kind : S.item;
    const k = S.mode === 'frozen' ? fz.k : S.mode === 'use' ? S.k : S.t;
    switch (kind) {
      case 'medkit': this._medkit(k); break;
      case 'bandage': this._bandage(k); break;
      case 'tourniquet': this._tourniquet(k); break;
      case 'plate': this._plate(k); break;
      case 'repair': this._repair(k, vm); break;
      case 'frag': case 'smoke': case 'flash': case 'stone': case 'tknife': this._throwable(kind, k); break;
      case 'c4': this._place(k); break;
      case 'clacker': if (fz) this._clacker(fz.k > 0.5 ? fz.k - 0.5 : -1, Math.min(0.5, fz.k)); else this._clacker(S.fired ? S.t : -1, e.c4Hold); break;
    }
    S.pk = k;
    HELD.dip = this.dipY; HELD.hl = this.handLOut; HELD.sup = this.showSup;
    HELD.g[0] = gn.x; HELD.g[1] = gn.y; HELD.g[2] = gn.z; HELD.g[3] = gn.rx; HELD.g[4] = gn.ry; HELD.g[5] = gn.rz;
  },

  // ───────────────────────── state helpers ─────────────────────────
  _start(mode, item, ref = null) {
    this._clear();
    S.mode = mode; S.item = item; S.ref = ref; S.k = S.pk = 0; S.t = S.pt = 0; S.exitT = 0; S.fired = false; S.c4 = null;
    S.pk = -1;
    S.shot = G.weapons ? G.weapons.lastShot : -1;
    rig.position.y = 0;
    if (items[item]) { const it = items[item]; it.root.visible = true; if (it.pinF) { if (it.pinF.on || it.pin.parent !== it.root) rehome(it.pinF); if (it.leverF.on || it.lever.parent !== it.root) rehome(it.leverF); } }
    if (K.capF.on || K.injector.cap.parent !== K.injR) rehome(K.capF);
  },
  _startSwing() {
    const it = items[S.item];
    // the swing starts from wherever the arm is
    const g = R.g; SW[0][1] = g.position.x; SW[0][2] = g.position.y; SW[0][3] = g.position.z; SW[0][4] = g.rotation.x; SW[0][5] = g.rotation.y; SW[0][6] = g.rotation.z;
    const under = S.item === 'stone';
    const K1 = under ? [0.06, -0.02, -0.44, 0.75, 0.2, 2.8] : [0.12, 0.03, -0.42, 0.45, 0.25, -1.3];
    const K2 = under ? [0.03, -0.24, -0.42, 0.45, 0.2, 2.8] : [0.0, -0.22, -0.42, -0.35, 0.45, -1.2];
    const K3 = under ? [0.02, -0.44, -0.38, 0.3, 0.2, 2.8] : [-0.02, -0.44, -0.34, -0.6, 0.5, -1.2];
    for (let i = 0; i < 6; i++) { SW[1][i + 1] = K1[i]; SW[2][i + 1] = K2[i]; SW[3][i + 1] = K3[i]; }
    S.mode = 'swing'; S.t = 0; S.pk = -1;
    if (it) {
      it.root.visible = false;     // the world item is already in the air
      if (it.leverF && !it.leverF.on && it.lever.parent === it.root) {   // canisters (and a frag thrown at once): the spoon goes on release
        this._launch(it.leverF, 0.8, 0.7, -0.5, 14, 4, 18); audio.play('spoon', { vol: 0.3, rate: 0.9 });
      }
    }
    hand(L, null);
  },
  _exit() { if (!S.mode) return; S.mode = 'exit'; S.exitT = 0; },
  _stop() {
    this._clear();
    S.mode = null; S.item = null; S.ref = null;
    if (rig) { rig.visible = false; rig.position.y = 0; }
    this.active = false; this.lower = 0;
  },
  /** Hide every prop and release a hidden charge. */
  _clear() {
    hand(R, null); hand(L, null);
    for (const k in items) items[k].root.visible = false;
    for (const o of PROPS) o.visible = false;
    if (S.c4 && S.c4.mesh) S.c4.mesh.visible = true;
    S.c4 = null;
  },
  _cue(at, name, vol = 0.5, rate = 1) { if (S.pk < at && (S.mode === 'use' ? S.k : S.t) >= at && S.mode !== 'frozen') audio.play(name, { vol, rate }); },
  _launch(f, vx, vy, vz, wx, wy, wz) {
    rig.attach(f.obj); f.v.set(vx, vy, vz); f.w.set(wx, wy, wz); f.t = 0.8; f.on = true; f.obj.visible = true;
  },
  _fly(dt) {
    for (const f of fly) {
      if (!f.on) continue;
      f.t -= dt;
      f.v.y -= 7 * dt;
      f.obj.position.addScaledVector(f.v, dt);
      f.obj.rotation.x += f.w.x * dt; f.obj.rotation.y += f.w.y * dt; f.obj.rotation.z += f.w.z * dt;
      if (f.t <= 0) { f.obj.visible = false; f.on = false; }
    }
  },
  /** Rig-space position of a point given in obj's local frame. */
  _at(obj, x, y, z, out) {
    rig.updateMatrixWorld(true);
    out.set(x, y, z); obj.localToWorld(out); return rig.worldToLocal(out);
  },

  // ───────────────────────── C4: the LED on placed charges ─────────────────────────
  _led(c) {
    if (!c) return;
    const l = leds.find((x) => !x.mesh);
    if (!l) return;
    l.mesh = c.mesh; c.mesh.add(l.s); l.ph = G.realTime % 1.1;
  },
  _leds() {
    const t = G.realTime;
    for (const l of leds) {
      if (!l.mesh) continue;
      if (!l.mesh.parent) { l.mesh.remove(l.s); l.mesh = null; continue; }     // detonated or cleared
      l.s.visible = ((t - l.ph) % 1.1 + 1.1) % 1.1 < 0.07;
    }
  },

  // ───────────────────────── medical ─────────────────────────
  _medkit(k) {
    const pouch = K.pouch.root, lid = K.pouch.lid;
    hand(L, 'hold'); pouch.visible = true;
    put(L, track(T_MED_L, k, P6));
    lid.rotation.x = 2.15 * ss(0.12, 0.22, k) * (1 - ss(0.8, 0.9, k));
    // right hand: track, pulled onto the zip pull, the injector, the dressing
    track(T_MED_R, k, P6);
    const wPull = ss(0.08, 0.12, k) * (1 - ss(0.21, 0.24, k)), wGrab = ss(0.22, 0.25, k) * (1 - ss(0.27, 0.31, k)), wGrab2 = ss(0.56, 0.6, k) * (1 - ss(0.63, 0.67, k));
    if (wPull > 0) mix6(P6, anchor(Q6, this._at(lid, -0.076, 0.006, -0.112, _v), PINCH, 0.2 + 0.35 * ss(0.12, 0.22, k), 0.9, -0.6), wPull);
    if (wGrab > 0) mix6(P6, anchor(Q6, this._at(pouch, 0.026, 0.02, 0.012, _v), FIST, 0.15, 0.6, -1.2), wGrab);
    if (wGrab2 > 0) mix6(P6, anchor(Q6, this._at(pouch, -0.028, 0.03, -0.006, _v), PINCH, 0.15, 0.45, -0.4), wGrab2);
    put(R, P6);
    hand(R, k < 0.235 ? 'pinch' : k < 0.58 ? 'fist' : k < 0.645 ? 'pinch' : 'flat');
    K.injP.visible = k < 0.26;
    K.injR.visible = k >= 0.26 && k < 0.56;
    if (S.pk < 0.345 && k >= 0.345 && K.injector.cap.parent === K.injR && S.mode !== 'frozen') this._launch(K.capF, 0.5, 1.1, -0.35, 12, 3, 9);
    if (S.mode === 'frozen') K.injector.cap.visible = k < 0.345;
    K.dressing.visible = k >= 0.62 && k < 0.84;
    this.dipY = -0.1 * bump(0.4, 0.6, k) - 0.07 * bump(0.66, 0.86, k);
    this.lower = k < 0.9 ? 1 : 0;
    this._cue(0.03, 'velcro', 0.35); this._cue(0.12, 'zip', 0.55); this._cue(0.3, 'wrap', 0.3, 1.3); this._cue(0.345, 'cap_pop', 0.6);
    this._cue(0.455, 'inject', 0.7); this._cue(0.63, 'rip', 0.45); this._cue(0.72, 'thunk', 0.25, 1.6); this._cue(0.79, 'thunk', 0.22, 1.7); this._cue(0.84, 'zip', 0.35, 1.2);
  },

  _bandage(k) {
    hand(L, 'fist'); hand(R, 'grip');
    put(L, track(T_BAN_L, k, P6));
    const wp = lin(0.14, 0.74, k), th = -0.6 + wp * 2.5 * TAU, zc = 0.055 + wp * 0.12;
    const sec = K.section(zc, 0, SEC), rx = sec.w / 2 + 0.02, ry = sec.h / 2 + 0.02;
    const tug = ss(0.74, 0.84, k);
    // the roll's centre on its orbit round the forearm (left arm frame), pulled off it for the tug
    _v.set(Math.cos(th) * (rx + tug * 0.03) + tug * 0.05, sec.c[1] + Math.sin(th) * (ry + tug * 0.03), zc + tug * 0.04);
    _v2.copy(_v);
    L.g.updateMatrixWorld(true); L.g.localToWorld(_v); rig.worldToLocal(_v);
    track(T_BAN_R, k, P6);
    const wOn = ss(0.1, 0.15, k) * (1 - ss(0.84, 0.9, k));
    if (wOn > 0) mix6(P6, anchor(Q6, _v, GRIP, 0.5 + 0.2 * Math.sin(th), 0.57, 0.3 * Math.cos(th)), wOn);
    put(R, P6);
    K.roll.visible = k < 0.86;
    K.roll.rotation.set(0, 0, 0); K.roll.rotation.x = th * 2;       // the roll turns as it pays out
    for (let i = 0; i < K.wraps.length; i++) K.wraps[i].visible = wp > i / K.wraps.length + 0.02;
    // strip from the roll to where it leaves the arm (a little behind it on the orbit)
    const sOn = k > 0.14 && k < 0.86;
    K.strip.visible = sOn;
    if (sOn) {
      const ta = th - 0.9;
      _v3.set(Math.cos(ta) * sec.w / 2 * 0.98, sec.c[1] + Math.sin(ta) * sec.h / 2 * 0.98, zc);
      this._strip(_v2, _v3);
    }
    this.lower = k < 0.9 ? 1 : 0;
    this._cue(0.02, 'rip', 0.35, 1.2);
    for (let i = 0; i < 3; i++) this._cue(0.16 + i * 0.24, 'wrap', 0.4, 0.9 + i * 0.1);
    this._cue(0.8, 'rip', 0.5);
  },
  /** Point the 1 m strip (left-arm frame) from a to b: width along the forearm. */
  _strip(a, b) {
    _Z.copy(a).sub(b); const len = _Z.length(); _Z.multiplyScalar(1 / Math.max(1e-5, len));
    _X.set(0, 0, 1).addScaledVector(_Z, -_Z.z).normalize();
    _Y.crossVectors(_Z, _X);
    _m.makeBasis(_X, _Y, _Z);
    K.strip.quaternion.setFromRotationMatrix(_m);
    K.strip.position.copy(a); K.strip.scale.set(1, 1, len);
  },

  _tourniquet(k) {
    const tq = K.tourniquet, rod = tq.rod;
    hand(L, 'fist'); tq.root.visible = true;
    put(L, track(T_TQ_L, k, P6));
    const slide = 1 - ss(0.14, 0.36, k), loose = 1 - ss(0.3, 0.42, k);
    tq.root.position.set(0, -0.004 * slide, -0.13 * slide);
    tq.root.scale.set(1 + 0.16 * loose, 1 + 0.16 * loose, 1);
    const twist = -TAU * ss(0.42, 0.74, k);          // one full turn, back into the clip
    rod.rotation.set(0, twist, 0);
    track(T_TQ_R, k, P6);
    const wStrap = ss(0.1, 0.15, k) * (1 - ss(0.36, 0.41, k)), wRod = ss(0.38, 0.43, k) * (1 - ss(0.8, 0.86, k));
    if (wStrap > 0) mix6(P6, anchor(Q6, this._at(tq.root, tq.side[0] + 0.004, tq.side[1], tq.side[2], _v), PINCH, 0.4, 0.9, -1.2), wStrap);
    if (wRod > 0) mix6(P6, anchor(Q6, this._at(rod, 0.044, 0.004, 0, _v), PINCH, 0.55, 0.6, -0.7 + Math.sin(twist) * 0.3), wRod);
    put(R, P6);
    hand(R, 'pinch');
    this.lower = k < 0.9 ? 1 : 0;
    this._cue(0.18, 'velcro', 0.45); for (let i = 0; i < 3; i++) this._cue(0.48 + i * 0.09, 'ratchet', 0.4, 1 + i * 0.06); this._cue(0.78, 'clip', 0.6);
  },

  _plate(k) {
    const c = K.carrier, pl = K.plate;
    c.visible = true; pl.visible = k > 0.03;
    const up = ss(0.0, 0.12, k) * (1 - ss(0.88, 1.0, k));
    c.position.set(0, -0.42 + up * 0.27, -0.48); c.rotation.set(0.45, 0, 0);
    track(T_PLATE, k, P3);
    const slap1 = ss(0.635, 0.655, k), slap2 = ss(0.725, 0.745, k);
    pl.position.set(0, P3[0] - slap1 * 0.04 - slap2 * 0.03, P3[1]); pl.rotation.set(PI / 2 - P3[2], PI, 0);   // strike face out, shooter's cut up
    // both hands on the side edges while it goes in
    const wHold = ss(0.02, 0.07, k) * (1 - ss(0.53, 0.58, k));
    track(T_PLATE_L, k, P6);
    if (wHold > 0) mix6(P6, anchor(Q6, this._at(pl, 0.118, 0.012, -0.08, _v), GRIP_L, 0.6, -0.3, PI / 2), wHold);
    put(L, P6); hand(L, wHold > 0.02 || k < 0.1 ? 'grip' : 'flat');
    track(T_PLATE_R, k, P6);
    if (wHold > 0) mix6(P6, anchor(Q6, this._at(pl, -0.118, 0.012, -0.08, _v), GRIP, 0.6, 0.3, -PI / 2), wHold);
    // then the right hand slaps it home twice and smooths the flap
    const wSlap = ss(0.56, 0.6, k) * (1 - ss(0.86, 0.92, k));
    if (wSlap > 0) {
      const lift = 0.07 * (bump(0.585, 0.645, k) + bump(0.665, 0.735, k)) + 0.015 * ss(0.76, 0.86, k);
      this._at(c, 0.03, 0.0, 0.0, _v); _v.y += lift + 0.02; _v.z += 0.01;
      mix6(P6, anchor(Q6, _v, PALM, 0.45, 0.25, 0), wSlap);
    }
    put(R, P6); hand(R, wSlap > 0.5 ? 'flat' : 'grip');
    this.dipY = -0.2 * up;
    this.lower = k < 0.9 ? 1 : 0;
    this._cue(0.24, 'slide', 0.5); this._cue(0.65, 'thunk', 0.7); this._cue(0.74, 'thunk', 0.6, 0.9); this._cue(0.8, 'velcro', 0.35);
  },

  _repair(k, vm) {
    const kp = ss(0, 0.14, k) * (1 - ss(0.86, 0.98, k)), gn = this.gun;
    gn.x = -0.035 * kp; gn.y = 0.02 * kp; gn.z = -0.02 * kp; gn.rx = 0.1 * kp; gn.ry = 0.5 * kp; gn.rz = -0.28 * kp;
    this.handLOut = ss(0.0, 0.12, k) * (1 - ss(0.86, 0.97, k));
    this.showSup = true;
    this.lower = 0;
    hand(L, 'fist'); K.rod.visible = true;
    track(T_REP_L, k, P6);
    const wOn = ss(0.1, 0.2, k) * (1 - ss(0.82, 0.9, k));
    if (wOn > 0 && vm && vm.supMuzzle && vm.muzzle) {
      const root = vm.root, q = root.quaternion;
      const stroke = 0.03 * Math.sin(TAU * 4 * lin(0.2, 0.84, k));
      _v.copy(vm.muzzle.position).add(vm.supMuzzle.position).multiplyScalar(0.5);
      _v2.set(0, 0, -1).applyQuaternion(q);                           // bore axis, forward
      _v.applyQuaternion(q).add(root.position).addScaledVector(_v2, stroke);
      _v3.set(0, 1, 0).applyQuaternion(q);
      _v.addScaledVector(_v3, 0.024);                                  // on top of the can
      // the rod comes down along the can from up-left behind it, the forearm from the bottom left
      _X.copy(_v2).add(_Y.set(0.1, -0.24, 0));
      aim(Q6, _v, ROD_TIP, ROD_DIR, _X, _Z.set(-0.5, -0.65, 0.5));
      mix6(P6, Q6, wOn);
    }
    put(L, P6);
    for (let i = 0; i < 4; i++) this._cue(0.2 + (i + 0.25) * 0.16, 'brush', 0.4, 0.95 + i * 0.05);
  },

  // ───────────────────────── throwables ─────────────────────────
  _throwable(kind, t) {
    const it = items[kind], swing = S.mode === 'swing';
    if (swing) {
      track(SW, t, P6); put(R, P6); hand(R, t < 0.05 ? 'grip' : 'flat');
      this.lower = t < 0.24 ? 1 : 0;
      if (t > 0.36) this._stop();
      return;
    }
    const under = kind === 'stone';
    put(R, track(under ? T_UNDER : T_OVER, t, P6));
    hand(R, kind === 'tknife' ? 'pinch' : 'grip');
    it.root.visible = true;
    this.lower = 1;
    // left hand pulls the ring, then flicks the pin away
    if (it.pin) {
      track(T_PULL, t, Q6);
      const wRing = ss(0.04, 0.1, t) * (1 - ss(0.13, 0.2, t));
      if (wRing > 0 && it.pin.parent === it.root) { anchor(P6, this._at(it.pin, -0.004, -0.007, -0.03, _v), PINCH_L, 0.4, -0.5, 1.1); mix6(Q6, P6, wRing); }
      put(L, Q6); hand(L, t < 0.34 ? 'pinch' : null);
      if (S.mode !== 'frozen') {
        if (S.pk < 0.1 && t >= 0.1 && it.pin.parent === it.root) { L.g.attach(it.pin); }
        if (S.pk < 0.24 && t >= 0.24 && it.pin.parent === L.g) this._launch(it.pinF, -0.7, 0.45, -0.35, 10, 16, 6);
        if (kind === 'frag' && S.pk < 0.3 && t >= 0.3 && it.lever.parent === it.root) { this._launch(it.leverF, 0.9, 0.75, -0.45, 16, 5, 20); audio.play('spoon', { vol: 0.45 }); }
      } else { it.pin.visible = t < 0.24; it.lever.visible = !(kind === 'frag' && t >= 0.3); }
    } else hand(L, null);
  },

  // ───────────────────────── C4 ─────────────────────────
  _place(t) {
    hand(L, 'hold'); K.c4.visible = t < 0.24;
    put(L, track(T_C4, t, P6));
    if (t >= 0.24 && S.c4) { S.c4.mesh.visible = true; S.c4 = null; if (S.mode !== 'frozen') audio.play('stick', { vol: 0.5 }); }
    this.lower = t < 0.4 ? 0.55 : 0;
    if (t > 0.56) this._stop();
  },
  /** after: seconds since the blast (−1 before it); hold: how long T has been held (0.5 fires). */
  _clacker(after, hold) {
    const clk = K.clacker;
    hand(L, 'grip'); clk.root.visible = true;
    put(L, track(T_CLK, after < 0 ? Math.min(hold, 0.5) : 0.5 + after, P6));
    const sq = after < 0 ? ss(0.08, 0.5, hold) : 1;
    clk.lever.rotation.x = -0.38 * (1 - sq);
    if (after >= 0) { const kick = Math.exp(-after * 14) * Math.min(1, after * 60); L.g.position.y += kick * 0.03; L.g.position.z += kick * 0.03; L.g.rotation.x += kick * 0.15; }
    this.lower = after < 0.3 ? 0.6 : 0;
    if (after > 0.65) this._stop();
  },
};

// ───────────────────────────── key poses ─────────────────────────────
// [k, x, y, z, pitch, yaw, roll]; k is the use fraction for items, seconds for throws and C4
const T_MED_L = [
  [0.0, -0.17, -0.44, -0.3, 0.25, -0.5, PI], [0.09, -0.065, -0.168, -0.32, 0.55, -0.5, PI], [0.45, -0.06, -0.17, -0.32, 0.5, -0.48, PI],
  [0.84, -0.065, -0.168, -0.32, 0.55, -0.5, PI], [0.95, -0.18, -0.45, -0.3, 0.2, -0.5, PI]];
const T_MED_R = [
  [0.0, 0.26, -0.44, -0.3, 0.2, 0.8, -0.6], [0.1, 0.13, -0.11, -0.3, 0.2, 0.9, -0.6], [0.22, 0.1, -0.03, -0.36, 0.55, 0.85, -0.6],
  [0.25, 0.07, -0.08, -0.32, 0.15, 0.6, -1.2], [0.32, 0.12, -0.04, -0.3, 0.45, 0.35, -1.5], [0.37, 0.12, -0.05, -0.3, 0.45, 0.35, -1.5],
  [0.45, 0.1, -0.44, -0.27, 0.2, 0.35, -1.5], [0.54, 0.1, -0.44, -0.27, 0.2, 0.35, -1.5], [0.6, 0.07, -0.07, -0.32, 0.15, 0.45, -0.4],
  [0.67, 0.1, -0.06, -0.32, 0.3, 0.3, 0], [0.73, 0.08, -0.42, -0.29, 0.1, 0.3, 0], [0.76, 0.08, -0.35, -0.29, 0.15, 0.3, 0],
  [0.79, 0.08, -0.43, -0.29, 0.1, 0.3, 0], [0.84, 0.08, -0.42, -0.29, 0.1, 0.3, 0], [0.92, 0.26, -0.46, -0.28, 0.1, 0.5, -0.4]];
const T_BAN_L = [
  [0.0, -0.12, -0.42, -0.3, 0.2, -1.0, 0], [0.12, 0.05, -0.055, -0.36, 0.38, -1.0, 0.2], [0.5, 0.045, -0.05, -0.36, 0.4, -0.98, 0.2],
  [0.86, 0.05, -0.055, -0.36, 0.38, -1.0, 0.2], [0.97, -0.08, -0.44, -0.32, 0.15, -1.0, 0]];
const T_BAN_R = [
  [0.0, 0.26, -0.44, -0.3, 0.3, 0.55, 0], [0.12, 0.14, -0.06, -0.32, 0.5, 0.55, 0.2], [0.86, 0.17, -0.06, -0.3, 0.5, 0.55, 0.2], [0.97, 0.26, -0.46, -0.28, 0.3, 0.55, 0]];
const T_TQ_L = [
  [0.0, -0.14, -0.46, -0.36, 0.3, 0.3, 0], [0.14, -0.09, 0.02, -0.5, 0.64, 0.3, 0], [0.86, -0.09, 0.02, -0.5, 0.64, 0.3, 0], [0.98, -0.14, -0.42, -0.38, 0.4, 0.3, 0]];
const T_TQ_R = [
  [0.0, 0.26, -0.45, -0.3, 0.2, 0.8, -1.0], [0.12, 0.08, -0.12, -0.3, 0.4, 0.9, -1.2], [0.4, 0.06, -0.1, -0.3, 0.3, 0.7, -0.6],
  [0.8, 0.04, -0.09, -0.3, 0.2, 0.5, -0.4], [0.86, 0.06, -0.1, -0.3, 0.1, 0.5, -0.6], [0.96, 0.26, -0.46, -0.28, 0.0, 0.6, -0.6]];
// plate in the carrier's frame: [k, y, z, tilt]
const T_PLATE = [[0.03, -0.12, 0.3, 0.6], [0.16, 0.22, 0.08, 0.16], [0.24, 0.235, 0.012, 0.0], [0.55, -0.095, 0.012, 0.0], [1.0, -0.095, 0.012, 0.0]];
const T_PLATE_L = [[0.0, -0.2, -0.44, -0.3, 0.3, -0.3, PI / 2], [0.07, -0.13, -0.2, -0.36, 0.35, -0.35, PI / 2], [0.58, -0.13, -0.26, -0.4, 0.35, -0.35, PI / 2], [0.7, -0.22, -0.46, -0.3, 0.2, -0.3, PI / 2]];
const T_PLATE_R = [[0.0, 0.2, -0.44, -0.3, 0.3, 0.3, -PI / 2], [0.07, 0.13, -0.2, -0.36, 0.35, 0.35, -PI / 2], [0.58, 0.12, -0.22, -0.38, 0.4, 0.3, -0.5], [0.86, 0.1, -0.22, -0.38, 0.45, 0.25, 0], [0.97, 0.24, -0.46, -0.3, 0.3, 0.3, 0]];
const T_REP_L = [[0.0, -0.18, -0.44, -0.3, 0.3, -0.3, 0.3], [0.12, -0.08, -0.08, -0.32, 0.3, -0.3, 0.3], [0.9, -0.08, -0.08, -0.32, 0.3, -0.3, 0.3], [1.0, -0.18, -0.45, -0.3, 0.3, -0.3, 0.3]];
// throws: seconds since the press (the hold keeps the last pose)
const T_OVER = [[0.0, 0.22, -0.36, -0.3, 0.3, 0.25, -1.8], [0.14, 0.13, -0.1, -0.33, 0.55, 0.35, -2.1], [0.32, 0.14, -0.1, -0.33, 0.55, 0.35, -2.1], [0.62, 0.17, -0.07, -0.3, 0.8, 0.3, -2.3]];
const T_UNDER = [[0.0, 0.22, -0.36, -0.3, 0.0, 0.3, 3.0], [0.14, 0.12, -0.14, -0.32, 0.2, 0.3, 2.9], [0.62, 0.15, -0.19, -0.27, -0.1, 0.25, 2.9]];
const T_PULL = [[0.0, -0.2, -0.4, -0.32, 0.4, -0.5, 1.1], [0.1, 0.06, -0.08, -0.33, 0.4, -0.5, 1.1], [0.2, -0.02, -0.12, -0.33, 0.4, -0.6, 1.2], [0.26, -0.06, -0.1, -0.32, 0.6, -0.7, 1.2], [0.42, -0.2, -0.44, -0.3, 0.3, -0.5, 1.0]];
const T_C4 = [[0.0, -0.14, -0.38, -0.3, 0.1, 0.1, PI], [0.16, -0.05, -0.12, -0.38, 0.25, 0.0, PI], [0.24, -0.04, -0.1, -0.46, 0.3, 0.0, PI], [0.32, -0.05, -0.12, -0.41, 0.25, 0.05, PI], [0.56, -0.18, -0.4, -0.32, 0.1, 0.1, PI]];
// clacker: 0..0.5 while T is held (squeeze), then seconds after the blast
const T_CLK = [[0.0, -0.16, -0.42, -0.3, 0.1, -0.4, PI], [0.16, -0.07, -0.12, -0.31, 0.3, -0.4, PI], [0.5, -0.065, -0.115, -0.31, 0.32, -0.38, PI], [0.85, -0.065, -0.12, -0.31, 0.3, -0.4, PI], [1.15, -0.17, -0.44, -0.3, 0.1, -0.4, PI]];
