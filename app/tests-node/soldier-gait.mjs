/**
 * The soldier rig's gait, measured on the real rig under Node: planted feet do
 * not slide, cadence and stride are human, the old one-argument setMove still
 * works, heads stay where the hit zones expect them, deaths still play.
 * Run with:  node --test tests-node/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// soldier-model.js imports the bare specifier 'three' (an import map in the browser)
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'three') return next(new URL('../public/vendor/three.module.js', ${JSON.stringify(import.meta.url)}).href, ctx);
    return next(spec, ctx);
  }`));
// the texture atlas is painted on a canvas: a stub is enough here (nothing is drawn)
const ctx2d = new Proxy({}, { get: (o, k) => (k in o ? o[k] : k === 'createImageData' ? (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => ({ addColorStop() {} })), set: (o, k, v) => { o[k] = v; return true; } });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }) };

const { buildSoldier } = await import('../public/js/soldier-model.js');
const THREE = await import('../public/vendor/three.module.js');

const DT = 1 / 60;
const FOOT = [15, 18], K_SOLE = 0.085, HEEL = 0.055, BALL = 0.13;
const _p = new THREE.Vector3(), _q = new THREE.Quaternion();

/** world position of a point on the sole of foot si (from the rig's own forward kinematics) */
function solePoint(mesh, rig, si, along, out) {
  const k = rig.k, i = FOOT[si];
  out.set(0, -K_SOLE * k, along * k).applyQuaternion(rig.wq[i]).add(rig.wp[i]);       // mesh frame
  return out.applyAxisAngle(new THREE.Vector3(0, 1, 0), mesh.rotation.y).add(mesh.position);
}

/**
 * Walk a soldier for `secs` with `drive(t, mesh, rig)` moving the mesh, and
 * measure each stance: the heel may not move while it is down, the ball may not
 * move once the foot is flat. Returns drift (m), steps/min, stride (m), flight.
 */
function walkTest(drive, secs, seed = 3) {
  const { mesh, rig } = buildSoldier('rifle', { seed, variant: 0 });
  rig.update(DT);
  const st = [{}, {}], drifts = [], lands = [[], []];
  let t = 0, flight = 0;
  const fi = {};
  while (t < secs) {
    drive(t, mesh, rig);
    rig.update(DT); t += DT;
    let down = 0;
    for (let si = 0; si < 2; si++) {
      rig.footInfo(si, fi);
      const s = st[si];
      if (fi.planted) {
        down++;
        const h = solePoint(mesh, rig, si, HEEL, new THREE.Vector3()), b = solePoint(mesh, rig, si, -BALL, new THREE.Vector3());
        if (!s.on) { s.on = true; s.h0 = null; s.b0 = null; s.max = 0; lands[si].push({ t, x: fi.x, z: fi.z }); }
        if (fi.pitch > -0.01) { s.h0 ||= h; s.max = Math.max(s.max, Math.hypot(h.x - s.h0.x, h.z - s.h0.z)); }
        if (fi.pitch < 0.01) { s.b0 ||= b; s.max = Math.max(s.max, Math.hypot(b.x - s.b0.x, b.z - s.b0.z)); }
      } else if (s.on) { s.on = false; if (t > 1.5) drifts.push(s.max); }
    }
    if (down === 0 && t > 1.5) flight += DT;
  }
  const L = lands[0].filter((l) => l.t > 1.5);
  const stride = L.length > 1 ? Math.hypot(L.at(-1).x - L[0].x, L.at(-1).z - L[0].z) / (L.length - 1) : 0;
  const cycle = L.length > 1 ? (L.at(-1).t - L[0].t) / (L.length - 1) : Infinity;
  return { drift: Math.max(0, ...drifts), stances: drifts.length, spm: 120 / cycle, stride, flight, rig, mesh };
}
/** straight line at `v` m/s, facing the way he goes, travelling at `dir` from the facing */
const straight = (v, dir = 0, aim = false) => (t, mesh, rig) => {
  const lx = Math.sin(dir) * v, lz = -Math.cos(dir) * v, c = Math.cos(mesh.rotation.y), s = Math.sin(mesh.rotation.y);
  mesh.position.x += (lx * c + lz * s) * DT; mesh.position.z += (-lx * s + lz * c) * DT;
  rig.setMove(v, lx, lz, 0); rig.setAim(aim, 0);
};

test('a patrol walk: planted feet stay put (< 2 cm), ~105-118 steps/min, ~1.5 m strides', (t) => {
  const r = walkTest(straight(1.4), 12);
  t.diagnostic(`walk 1.4 m/s: drift ${(r.drift * 100).toFixed(2)} cm, ${r.spm.toFixed(1)} steps/min, stride ${r.stride.toFixed(2)} m`);
  assert.ok(r.stances > 15, 'enough steps');
  assert.ok(r.drift < 0.02, `drift ${(r.drift * 100).toFixed(2)} cm`);
  assert.ok(r.spm > 100 && r.spm < 120, `${r.spm.toFixed(1)} steps/min`);
  assert.ok(r.stride > 1.3 && r.stride < 1.8, `stride ${r.stride.toFixed(2)} m`);
  assert.equal(r.flight, 0, 'walking never leaves the ground with both feet');
});

test('a combat run: no sliding, ~160-185 steps/min, a flight phase', (t) => {
  const r = walkTest(straight(4.4), 10);
  t.diagnostic(`run 4.4 m/s: drift ${(r.drift * 100).toFixed(2)} cm, ${r.spm.toFixed(1)} steps/min, stride ${r.stride.toFixed(2)} m, airborne ${(r.flight / 8.5 * 100).toFixed(0)} % of the time`);
  assert.ok(r.drift < 0.02, `drift ${(r.drift * 100).toFixed(2)} cm`);
  assert.ok(r.spm > 158 && r.spm < 186, `${r.spm.toFixed(1)} steps/min`);
  assert.ok(r.flight > 1, `flight ${r.flight.toFixed(2)} s`);
});

test('strafing, back-pedalling and the aimed search walk keep the feet planted too', (t) => {
  for (const [v, dir, aim] of [[1.4, Math.PI / 2, false], [1.4, -Math.PI / 2, false], [1.4, Math.PI, false], [2.4, Math.PI, true], [3.4, Math.PI / 2, true], [2.5, 0, true]]) {
    const r = walkTest(straight(v, dir, aim), 8);
    t.diagnostic(`v ${v} dir ${Math.round(dir * 57.3)}°${aim ? ' aimed' : ''}: drift ${(r.drift * 100).toFixed(2)} cm, ${r.spm.toFixed(1)} steps/min, stride ${r.stride.toFixed(2)} m`);
    assert.ok(r.stances > 8, `v ${v} dir ${dir.toFixed(2)}: steps`);
    assert.ok(r.drift < 0.02, `v ${v} dir ${dir.toFixed(2)}: drift ${(r.drift * 100).toFixed(2)} cm`);
  }
});

test('starting, stopping and turning on the spot never slide a foot, and he steps to turn', () => {
  // accelerate / brake like the AI does, then turn 90° and 180° on the spot
  let spd = 0, yawT = 0;
  const r = walkTest((t, mesh, rig) => {
    const go = t % 6 < 3;
    spd += Math.max(-3.2 * DT, Math.min(3.6 * DT, (go ? 1.5 : 0) - spd));
    if (t > 12) { spd = 0; if (Math.floor(t / 2) !== Math.floor((t - DT) / 2)) yawT += t > 16 ? Math.PI : Math.PI / 2; }
    const py = mesh.rotation.y;
    mesh.rotation.y += (yawT - mesh.rotation.y) * (1 - Math.exp(-3.85 * DT));
    const c = Math.cos(mesh.rotation.y), s = Math.sin(mesh.rotation.y);
    mesh.position.x += -spd * s * DT; mesh.position.z += -spd * c * DT;
    rig.setMove(spd, 0, -spd, (mesh.rotation.y - py) / DT);
  }, 22);
  assert.ok(r.drift < 0.02, `drift ${(r.drift * 100).toFixed(2)} cm`);
  assert.ok(r.stances > 20);
});

test('the old one-argument setMove still walks (on a treadmill, as the viewers and cinematics use it)', () => {
  const { rig } = buildSoldier('rifle', { seed: 1 });
  rig.treadmill = true;
  let lifts = 0, was = true;
  for (let i = 0; i < 300; i++) { rig.setMove(1.5); rig.update(DT); const pl = rig.sw[0] < 0; if (was && !pl) lifts++; was = pl; }
  assert.ok(lifts >= 3, `left foot stepped ${lifts} times`);
  // and a soldier with no mesh at all does not crash
  const { rig: r2 } = buildSoldier('officer', { seed: 2 });
  r2.mesh = null; for (let i = 0; i < 60; i++) { r2.setMove(2); r2.update(DT); }
  assert.ok(Number.isFinite(r2.headHeight()));
});

test('the head stays where the hit zones expect it in every stance (within 3 cm of the old rig)', () => {
  // mean head height of the previous rig per stance (dev viewer measurement)
  const OLD = { idle: 1.613, walk: 1.582, search: 1.539, run: 1.515, aim: 1.586, kneel: 1.195, kneelaim: 1.188, stun: 1.524 };
  const pose = {
    idle: [0, false, false, false], walk: [1.4, false, false, false], search: [2.5, true, false, false], run: [4.4, false, false, false],
    aim: [0, true, false, false], kneel: [0, false, true, false], kneelaim: [0, true, true, false], stun: [0, false, false, true],
  };
  const h = {};
  for (const [name, [v, aim, crouch, stun]] of Object.entries(pose)) {
    const { mesh, rig } = buildSoldier('rifle', { seed: 5, variant: 0 });
    let sum = 0, n = 0;
    for (let i = 0; i < 600; i++) {
      mesh.position.z -= v * DT;
      rig.setMove(v, 0, -v, 0); rig.setAim(aim, 0); rig.setCrouch(crouch); rig.setStun(stun);
      rig.update(DT);
      if (i >= 300) { rig.headLocal(h); sum += h.y; n++; assert.ok(Math.abs(h.x) < 0.12 && h.z < 0.1 && h.z > -0.25, `${name}: head ${h.x.toFixed(3)}, ${h.z.toFixed(3)}`); }
    }
    const mean = sum / n;
    assert.ok(Math.abs(mean - OLD[name]) < 0.03, `${name}: head ${mean.toFixed(3)} m vs ${OLD[name]}`);
    assert.ok(Math.abs(rig.headHeight() - h.y) < 1e-9, 'headHeight is the head centre');
  }
});

test('flinch, shooting and the three death falls still play and settle on the ground', () => {
  for (const v of [0, 1, 2]) {
    const { mesh, rig } = buildSoldier('rifle', { seed: 9 + v });
    for (let i = 0; i < 60; i++) { mesh.position.z -= 1.5 * DT; rig.setMove(1.5, 0, -1.5, 0); if (i === 20) { rig.hit(); rig.shoot(); } rig.update(DT); }
    rig.die(v === 1 ? -1 : 1, v);
    for (let i = 0; i < 150; i++) rig.update(DT);
    assert.ok(rig.settled, `fall ${v} settled`);
    assert.ok(rig.headHeight() < 0.45, `fall ${v}: head ${rig.headHeight().toFixed(2)} m above the ground`);
  }
});

test('each soldier walks in his own rhythm (a patrol does not march in step)', () => {
  const spm = [1, 2, 3, 4, 5, 6].map((seed) => walkTest(straight(1.4), 8, seed).spm);
  const lo = Math.min(...spm), hi = Math.max(...spm);
  assert.ok(hi - lo > 2, `cadences ${spm.map((s) => s.toFixed(1)).join(', ')}`);
});

test('no personal style or direction makes the feet stutter (12 soldiers × 6 directions × walk and run)', () => {
  for (let seed = 0; seed < 12; seed++) for (const dir of [0, 0.8, Math.PI / 2, 2.4, Math.PI, -Math.PI / 2]) for (const v of [1.4, 3.4]) {
    const r = walkTest(straight(v, dir, v > 2), 5, seed);
    assert.ok(r.spm > 70 && r.spm < 215, `seed ${seed} dir ${dir.toFixed(2)} v ${v}: ${r.spm.toFixed(0)} steps/min`);
    assert.ok(r.drift < 0.02, `seed ${seed} dir ${dir.toFixed(2)} v ${v}: drift ${(r.drift * 100).toFixed(2)} cm`);
  }
});
