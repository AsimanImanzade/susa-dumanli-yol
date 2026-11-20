/**
 * Unit tests for the pure gameplay rules (no browser, no Three.js).
 * Run with:  node --test tests-node/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTY, WEAPONS, NOISE, STEALTH, AI, THROW, computeScore } from '../public/js/config.js';
import { visibility, sightRange, detectionRate, stepMeter, meterBand, coneFactor } from '../public/js/stealth.js';
import { wearSuppressor, shotNoise, suppressedDamageMult, hitDamage, recoilAt, stepProjectile, dropAt, blastDamage, falloffMult,
  LETHAL, isLethalHit, thrownKnifeDamage, soldierToWorld, soldierHeadLocal, soldierHeadWorld, rayVsSoldier } from '../public/js/ballistics.js';
import { Object3D, Vector3 } from '../public/vendor/three.core.js';
import { hears, stepRadius, noise } from '../public/js/noise.js';
import { S, STIM, nextState, alertLevel, noiseStimulus } from '../public/js/ai-fsm.js';
import { sanitizeName, t, setLang, STRINGS } from '../public/js/loc.js';
import * as logic from '../src/logic.js';
import './suppressor.mjs';   // weapon-specific suppressors and the SVD can

// ── stealth ────────────────────────────────────────────────────────────
const rateFor = (diff, o = {}) => detectionRate({ dist: 9, range: sightRange(0.8, 0.2), angle: 0,
  vis: visibility(o.stance ?? 0, o.speed ?? 0, o.light ?? 0.2, o.foliage ?? false), diffMult: DIFFICULTY[diff].detectMult, alert: o.alert ?? 0 });

test('difficulty changes detection speed: easy < normal < hard', () => {
  assert.ok(rateFor('easy') < rateFor('normal'));
  assert.ok(rateFor('normal') < rateFor('hard'));
  assert.equal(+(rateFor('hard') / rateFor('easy')).toFixed(3), +(1.6 / 0.6).toFixed(3));
});
test('stance, movement, light and foliage each change how visible the player is', () => {
  assert.ok(rateFor('normal', { stance: 1 }) < rateFor('normal', { stance: 0 }));
  assert.ok(rateFor('normal', { stance: 2 }) < rateFor('normal', { stance: 1 }));
  assert.ok(rateFor('normal', { speed: 1 }) > rateFor('normal', { speed: 0 }));
  assert.ok(rateFor('normal', { light: 1 }) > rateFor('normal', { light: 0 }));
  assert.ok(rateFor('normal', { foliage: true }) < rateFor('normal'));
});
test('fog and darkness shorten sight range; nothing is seen beyond it or behind the enemy', () => {
  assert.ok(sightRange(1, 0.2) < sightRange(0, 0.2));
  assert.ok(sightRange(0.5, 0) < sightRange(0.5, 1));
  const range = sightRange(0.8, 0.2);
  assert.equal(detectionRate({ dist: range + 1, range, angle: 0, vis: 1, diffMult: 1, alert: 0 }), 0);
  assert.equal(coneFactor(Math.PI), 0);
  assert.equal(detectionRate({ dist: 5, range, angle: Math.PI * 0.9, vis: 1, diffMult: 1, alert: 0 }), 0);
});
test('alert enemies notice faster; the meter fills while seen and drains otherwise', () => {
  assert.ok(rateFor('normal', { alert: 1 }) > rateFor('normal', { alert: 0 }));
  assert.ok(rateFor('normal', { alert: 2 }) > rateFor('normal', { alert: 1 }));
  let m = 0;
  for (let i = 0; i < 10; i++) m = stepMeter(m, 0.5, true, 0.1);
  assert.equal(+m.toFixed(2), 0.5);
  assert.equal(meterBand(m), 1);
  for (let i = 0; i < 10; i++) m = stepMeter(m, 0.5, false, 0.1);
  assert.equal(+m.toFixed(2), +(0.5 - STEALTH.decay).toFixed(2));
  assert.equal(meterBand(0.1), 0); assert.equal(meterBand(0.9), 2);
});

// ── suppressor & ballistics ────────────────────────────────────────────
test('the suppressor lasts ~40 shots on Normal, longer on Easy, shorter on Hard, and breaks at 0', () => {
  const count = (diff) => { let d = 1, n = 0; while (d > 0) { d = wearSuppressor(d, WEAPONS.pistol.suppressorShots, DIFFICULTY[diff].wearMult); n++; } return n; };
  assert.equal(count('normal'), 40);
  assert.ok(count('easy') > 60 && count('easy') < 70);
  assert.equal(count('hard'), 25);
});
test('noise and damage rise as the suppressor wears; a broken one is as loud as none', () => {
  const p = WEAPONS.pistol;
  assert.equal(shotNoise(p, 1), p.noiseSuppressed);
  assert.ok(shotNoise(p, 0.5) > shotNoise(p, 1));
  assert.ok(shotNoise(p, 0.05) > shotNoise(p, 0.5));
  assert.equal(shotNoise(p, 0), p.noise);
  assert.equal(shotNoise(p, null), p.noise);
  assert.ok(suppressedDamageMult(0.1) > suppressedDamageMult(1));
});
test('the sniper rifle is by far the loudest weapon; even suppressed it is louder than a suppressed AKM', () => {
  assert.ok(WEAPONS.svd.noise > WEAPONS.akm.noise && WEAPONS.akm.noise > WEAPONS.pistol.noise);
  assert.ok(WEAPONS.svd.noise > 20 * WEAPONS.pistol.noiseSuppressed);
  assert.ok(WEAPONS.svd.noiseSuppressed > WEAPONS.akm.noiseSuppressed);   // see suppressor.mjs for the SVD can
});
test('range and thin-wood penetration reduce damage; a head hit through wood keeps the head multiplier', () => {
  const a = WEAPONS.akm;
  assert.equal(hitDamage(a, 10, 'head', null, true), a.damage * a.headMult * a.penetration);
  assert.ok(hitDamage(a, 200, 'body', null, false) < hitDamage(a, 10, 'body', null, false));
  assert.equal(hitDamage(a, 10, 'body', null, true), a.damage * a.penetration);
});
test('recoil follows the authored pattern, then keeps weaving', () => {
  const a = WEAPONS.akm;
  assert.deepEqual(recoilAt(a, 0), a.recoil[0]);
  assert.deepEqual(recoilAt(a, a.recoil.length), a.recoil[a.recoil.length - 4]);
  assert.ok(recoilAt(a, 200)[0] > 0);
});
test('the SVD round drops and takes time to arrive', () => {
  const v = WEAPONS.svd.muzzleVel;
  const p = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: -v, t: 0 };
  while (-p.z < 120) stepProjectile(p, 1 / 60, 9.81, 0);
  assert.ok(p.t > 0.3 && p.t < 0.4, `flight time ${p.t}`);
  assert.ok(Math.abs(-p.y - dropAt(v, 120)) < 0.06, `drop ${-p.y} vs ${dropAt(v, 120)}`);
  assert.ok(dropAt(v, 120) > 0.4);
});
test('blast damage is full near the centre and zero outside the radius', () => {
  assert.equal(blastDamage(1, 8, 260, 15), 260);
  assert.equal(blastDamage(9, 8, 260, 15), 0);
  assert.ok(blastDamage(6, 8, 260, 15) < blastDamage(3, 8, 260, 15));
});

// ── lethal headshots ───────────────────────────────────────────────────
const FIREARMS = ['pistol', 'akm', 'ak74', 'svd'];
const SUPPRESSOR = { none: null, fresh: 1, worn: 0.4, nearlyBroken: 0.03, broken: 0 };
const maxHp = Math.max(...Object.values(AI.hp));

test('a clean head hit kills every soldier kind with every firearm, at any range and suppressor state', () => {
  for (const id of FIREARMS) {
    const w = WEAPONS[id];
    for (const dist of id === 'svd' ? [5, 60, 300] : [5, 60]) {
      for (const [state, sup] of Object.entries(SUPPRESSOR)) {
        const dmg = hitDamage(w, dist, 'head', sup, false);
        assert.equal(dmg, LETHAL, `${id} ${dist} m ${state}`);
        for (const [kind, hp] of Object.entries(AI.hp)) assert.ok(hp - dmg <= 0, `${id} ${dist} m ${state} vs ${kind}`);
      }
    }
  }
  assert.equal(isLethalHit('head'), true);
  assert.equal(isLethalHit('body'), false);
  assert.equal(isLethalHit('limb'), false);
});
test('a thrown knife to the head kills anyone; to the body or a limb it does its usual damage', () => {
  const k = THROW.tknife.damage;
  assert.equal(thrownKnifeDamage(k, 'head'), LETHAL);
  assert.ok(maxHp - thrownKnifeDamage(k, 'head') <= 0);
  assert.equal(thrownKnifeDamage(k, 'body'), k);
  assert.equal(thrownKnifeDamage(k, 'limb'), k * 0.6);
});
test('a head hit through thin wood keeps the normal damage maths', () => {
  assert.equal(isLethalHit('head', true), false);
  for (const id of FIREARMS) {
    const w = WEAPONS[id];
    for (const dist of [5, 60, 300]) for (const sup of Object.values(SUPPRESSOR)) {
      let expect = w.damage * falloffMult(w, dist) * w.headMult;
      if (sup != null && sup > 0) expect *= suppressedDamageMult(sup);
      expect *= w.penetration;
      assert.ok(Number.isFinite(hitDamage(w, dist, 'head', sup, true)));
      assert.ok(Math.abs(hitDamage(w, dist, 'head', sup, true) - expect) < 1e-9, `${id} ${dist} m sup ${sup}`);
    }
  }
  // e.g. an AKM round through a plank does 38 × 2.6 × 0.7 = 69.2: a rifleman survives it
  assert.ok(hitDamage(WEAPONS.akm, 10, 'head', null, true) < AI.hp.rifle);
});
test('body and limb damage are unchanged', () => {
  // the formula as it was before the headshot rule
  const before = (w, dist, zone, sup, pen) => {
    let d = w.damage * falloffMult(w, dist);
    if (zone === 'limb') d *= w.limbMult;
    if (sup != null && sup > 0) d *= suppressedDamageMult(sup);
    if (pen) d *= w.penetration;
    return d;
  };
  for (const id of FIREARMS) for (const zone of ['body', 'limb']) for (const dist of [5, 30, 60, 150, 300])
    for (const sup of Object.values(SUPPRESSOR)) for (const pen of [false, true])
      assert.equal(hitDamage(WEAPONS[id], dist, zone, sup, pen), before(WEAPONS[id], dist, zone, sup, pen), `${id} ${zone} ${dist} ${sup} ${pen}`);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(hitDamage(WEAPONS.akm, 10, 'body', null, false), 38));
  assert.ok(near(hitDamage(WEAPONS.akm, 10, 'limb', null, false), 30.4));
  assert.ok(near(hitDamage(WEAPONS.pistol, 10, 'body', 1, false), 34.2));
  assert.ok(near(hitDamage(WEAPONS.svd, 300, 'body', null, false), 103.5));
  // body shots still take several rounds: AKM 3, AK-74 4, suppressed pistol 3 on a rifleman
  assert.equal(Math.ceil(AI.hp.rifle / hitDamage(WEAPONS.akm, 10, 'body', null, false)), 3);
  assert.equal(Math.ceil(AI.hp.rifle / hitDamage(WEAPONS.ak74, 10, 'body', null, false)), 4);
  assert.equal(Math.ceil(AI.hp.rifle / hitDamage(WEAPONS.pistol, 10, 'body', 1, false)), 3);
});

// ── soldier hit zones ──────────────────────────────────────────────────
test('soldier-local → world follows mesh.rotation.y = yaw exactly as Three.js does', () => {
  const o = new Object3D(), v = new Vector3(), out = { x: 0, y: 0, z: 0 };
  for (const yaw of [0, 0.7, Math.PI / 2, 2.4, Math.PI, -1.9]) {
    o.position.set(3, -1.5, 8); o.rotation.set(0, yaw, 0); o.updateMatrixWorld(true);
    for (const l of [{ x: 0, y: 1.62, z: 0 }, { x: 0, y: 1.55, z: -0.2 }, { x: 0.15, y: 1.2, z: 0.1 }]) {
      v.set(l.x, l.y, l.z).applyMatrix4(o.matrixWorld);
      soldierToWorld(3, -1.5, 8, yaw, l, out);
      assert.ok(Math.hypot(out.x - v.x, out.y - v.y, out.z - v.z) < 1e-9, `yaw ${yaw} local ${JSON.stringify(l)}`);
    }
  }
  // a head leaning 0.2 m forward ends up 0.2 m along his facing, which ai.js uses as (−sin yaw, −cos yaw)
  for (const yaw of [0, 1, -2.5]) {
    soldierToWorld(0, 0, 0, yaw, { x: 0, y: 1.6, z: -0.2 }, out);
    assert.ok(Math.abs(out.x - -Math.sin(yaw) * 0.2) < 1e-12 && Math.abs(out.z - -Math.cos(yaw) * 0.2) < 1e-12);
  }
  // in place: out may be the local point itself
  const p = { x: 1, y: 2, z: 0 };
  soldierToWorld(0, 0, 0, Math.PI / 2, p, p);
  assert.ok(Math.abs(p.x) < 1e-12 && p.y === 2 && Math.abs(p.z + 1) < 1e-12);
});

const DEG_ = Math.PI / 180;
const stubRig = (head) => ({ headLocal(o) { o.x = head[0]; o.y = head[1]; o.z = head[2]; return o; }, headHeight() { throw new Error('headLocal must win'); } });
const oldRig = (hh) => ({ headHeight: () => hh });
const POSES = {
  standing: [0, 1.62, 0],
  crouched: [0, 1.15, -0.14],            // in cover, shoulders forward
  leaningForward: [0, 1.55, -0.2],       // running: spine pitched forward
  flinchBack: [0, 1.58, 0.16],           // knocked back by a hit
  leaningSide: [0.14, 1.58, -0.04],
};
/** Fire a ray that passes through `target` coming from `elev` degrees above the horizon (negative: from below), from compass direction `az`. */
function shootAt(e, target, elev, az, dist) {
  const ce = Math.cos(elev * DEG_), se = Math.sin(elev * DEG_);
  const ux = ce * Math.sin(az), uy = se, uz = ce * Math.cos(az);           // unit vector from the target back to the shooter
  const out = {};
  const t = rayVsSoldier(target.x + ux * dist, target.y + uy * dist, target.z + uz * dist, -ux, -uy, -uz, 1000, e, out, AI);
  return { t, zone: out.zone, x: target.x + ux * (dist - t), y: target.y + uy * (dist - t), z: target.z + uz * (dist - t) };
}
function headCases(e, label) {
  const h = soldierHeadWorld(e, { x: 0, y: 0, z: 0 });
  let n = 0;
  for (const elev of [0, 40, -15, -25]) for (const az of [0, 0.8, Math.PI / 2, Math.PI, -2.0]) for (const dist of [4, 15, 300]) {
    const side = { x: Math.cos(az), z: -Math.sin(az) };                      // horizontal, across the line of fire
    const points = { upper: [0, 0.1, 0], middle: [0, 0, 0], lower: [0, -0.1, 0], left: [-side.x * 0.1, 0, -side.z * 0.1], right: [side.x * 0.1, 0, side.z * 0.1] };
    for (const [where, o] of Object.entries(points)) {
      const r = shootAt(e, { x: h.x + o[0], y: h.y + o[1], z: h.z + o[2] }, elev, az, dist);
      const msg = `${label}: ${where} head, elev ${elev}°, az ${az.toFixed(2)}, ${dist} m → ${r.zone}`;
      assert.equal(r.zone, 'head', msg);
      assert.ok(Math.hypot(r.x - h.x, r.y - h.y, r.z - h.z) <= AI.headRadius + 1e-6, msg + ' (impact not on the head)');
      n++;
    }
  }
  return n;
}

test('rays through the upper, middle and lower head are head hits from level, 40° above and from below, in every pose', () => {
  let n = 0;
  for (const [pose, head] of Object.entries(POSES)) for (const yaw of [0, 2.2, -1.1])
    n += headCases({ x: 5, y: 2, z: -7, yaw, rig: stubRig(head) }, `${pose} yaw ${yaw}`);
  assert.ok(n > 1000);
});
test('the head zone follows the animated head: a shot at where the head used to be misses when he leans', () => {
  const e = { x: 0, y: 0, z: 0, yaw: 0, rig: stubRig(POSES.leaningForward) };
  // level shot from the side at the old fixed head point (0, 1.6, 0): his head is 0.2 m forward of it now
  assert.notEqual(shootAt(e, { x: 0, y: 1.6, z: 0.05 }, 0, Math.PI / 2, 20).zone, 'head');
  assert.equal(shootAt(e, { x: 0, y: 1.55, z: -0.2 }, 0, Math.PI / 2, 20).zone, 'head');
});
test('without rig.headLocal the hit test falls back to the upright head column', () => {
  const l = soldierHeadLocal(oldRig(1.6), { x: 9, y: 9, z: 9 });
  assert.deepEqual(l, { x: 0, y: 1.6, z: 0 });
  const n = headCases({ x: -3, y: 0.5, z: 4, yaw: 1.3, rig: oldRig(1.6) }, 'fallback standing')
    + headCases({ x: -3, y: 0.5, z: 4, yaw: 1.3, rig: oldRig(1.12) }, 'fallback crouched');
  assert.ok(n > 400);
});
test('body and limb zones still work, and a ray that clearly struck the chest first from below is a body hit', () => {
  for (const [pose, head] of Object.entries(POSES)) {
    const e = { x: 0, y: 0, z: 0, yaw: 0.4, rig: stubRig(head) }, hh = head[1];
    const at = (y) => ({ x: 0, y, z: 0 });
    assert.equal(shootAt(e, at(hh * 0.62), 0, 0.3, 12).zone, 'body', pose + ' chest');
    assert.equal(shootAt(e, at(hh * 0.2), 0, 0.3, 12).zone, 'limb', pose + ' shin');
    assert.equal(shootAt(e, at(hh * 0.12), 30, 2.0, 12).zone, 'limb', pose + ' shin from above');
  }
  const e = { x: 0, y: 0, z: 0, yaw: 0, rig: stubRig(POSES.standing) };
  // 50° up from below through the lower head: it went into the chest 0.4 m lower first
  assert.equal(shootAt(e, { x: 0, y: 1.52, z: 0 }, -50, 0, 6).zone, 'body');
  assert.equal(shootAt(e, { x: 0, y: 1.52, z: 0 }, -50, Math.PI, 6).zone, 'body');
  // the neck below the head sphere is body; just past the side of the head is a miss
  assert.equal(shootAt(e, { x: 0, y: 1.44, z: 0 }, 0, 0, 10).zone, 'body');
  assert.equal(shootAt(e, { x: 0.3, y: 1.62, z: 0 }, 0, 0, 10).t, -1);
  // a steep shot from a roof onto the shoulder lands on the closed top of the body (it used to pass through him)
  assert.equal(shootAt(e, { x: 0.2, y: 1.4, z: 0 }, 50, 0, 10).zone, 'body');
  // limb line drops with a crouch (fallback rig, as before): 0.5 m is a leg standing but the body when crouched
  assert.equal(shootAt({ ...e, rig: oldRig(1.6) }, { x: 0, y: 0.5, z: 0 }, 0, 0, 10).zone, 'limb');
  assert.equal(shootAt({ ...e, rig: oldRig(1.12) }, { x: 0, y: 0.5, z: 0 }, 0, 0, 10).zone, 'body');
  // nothing is hit beyond maxDist (a wall in front of him)
  const out = {};
  assert.equal(rayVsSoldier(0, 1.62, 10, 0, 0, -1, 9.5, e, out, AI), -1);
  assert.ok(Math.abs(rayVsSoldier(0, 1.62, 10, 0, 0, -1, 10, e, out, AI) - (10 - AI.headRadius)) < 1e-9);
});

// ── noise ──────────────────────────────────────────────────────────────
test('a noise is heard inside its radius, less far through walls', () => {
  const evt = { x: 0, y: 0, z: 0, radius: 60, kind: 'shot' };
  assert.ok(hears(evt, 50, 0, 0, false) > 0);
  assert.equal(hears(evt, 50, 0, 0, true), 0);
  assert.equal(hears(evt, 61, 0, 0, false), 0);
});
test('a sniper shot reaches guards a suppressed pistol never would', () => {
  const at = 48;
  assert.ok(hears({ x: 0, y: 0, z: 0, radius: shotNoise(WEAPONS.svd, null) }, at, 0, 0, true) > 0);
  assert.equal(hears({ x: 0, y: 0, z: 0, radius: shotNoise(WEAPONS.pistol, 1) }, at, 0, 0, false), 0);
});
test('footsteps: crouching and soft ground are quieter, sprinting is louder', () => {
  assert.ok(stepRadius('stone', 1, false) < stepRadius('stone', 0, false));
  assert.ok(stepRadius('grass', 0, false) < stepRadius('stone', 0, false));
  assert.ok(stepRadius('stone', 0, true) > stepRadius('stone', 0, false));
  assert.equal(stepRadius('wood', 2, false), NOISE.step.wood * NOISE.stanceMult[2]);
});
test('the noise bus delivers events to listeners', () => {
  let got = null;
  noise.listen((e) => { got = e; });
  noise.emit({ x: 1, y: 2, z: 3, radius: 5, kind: 'step' });
  assert.equal(got.kind, 'step');
  got = null; noise.emit({ x: 0, y: 0, z: 0, radius: 0, kind: 'step' });
  assert.equal(got, null);
});

// ── AI state machine ───────────────────────────────────────────────────
test('patrol → suspicious → searching → combat → searching → patrol', () => {
  let s = S.PATROL;
  s = nextState(s, STIM.GLIMPSE); assert.equal(s, S.SUSPICIOUS);
  s = nextState(s, STIM.NOISE_QUIET); assert.equal(s, S.SEARCHING);
  s = nextState(s, STIM.SPOTTED); assert.equal(s, S.COMBAT);
  s = nextState(s, STIM.LOST_SIGHT); assert.equal(s, S.SEARCHING);
  s = nextState(s, STIM.SEARCH_DONE); assert.equal(s, S.PATROL);
});
test('loud noises, found bodies and missed check-ins start a search; a look that finds nothing ends suspicion', () => {
  assert.equal(nextState(S.PATROL, noiseStimulus('shot')), S.SEARCHING);
  assert.equal(nextState(S.PATROL, noiseStimulus('shot_suppressed')), S.SUSPICIOUS);
  assert.equal(nextState(S.PATROL, STIM.BODY_FOUND), S.SEARCHING);
  assert.equal(nextState(S.PATROL, STIM.CHECKIN_MISSED), S.SEARCHING);
  assert.equal(nextState(S.SUSPICIOUS, STIM.INVESTIGATED), S.PATROL);
  assert.equal(nextState(S.PATROL, STIM.ALLY_CALL), S.COMBAT);
});
test('flashbangs stun, the dead stay dead, alert levels are ordered', () => {
  assert.equal(nextState(S.COMBAT, STIM.FLASHED), S.STUNNED);
  assert.equal(nextState(S.STUNNED, STIM.SPOTTED), S.STUNNED);
  assert.equal(nextState(S.STUNNED, STIM.RECOVERED), S.SEARCHING);
  assert.equal(nextState(S.COMBAT, STIM.KILLED), S.DEAD);
  assert.equal(nextState(S.DEAD, STIM.SPOTTED), S.DEAD);
  assert.deepEqual([S.PATROL, S.SUSPICIOUS, S.SEARCHING, S.COMBAT].map(alertLevel), [0, 1, 1, 2]);
});

// ── difficulty table ───────────────────────────────────────────────────
test('the difficulty table matches the design brief', () => {
  const { easy: e, normal: n, hard: h } = DIFFICULTY;
  assert.ok(e.accuracy < n.accuracy && n.accuracy < h.accuracy);
  assert.ok(e.damageMult < n.damageMult && n.damageMult < h.damageMult);
  assert.ok(e.regen && !n.regen && !h.regen);
  assert.ok(e.pickupMult > n.pickupMult && n.pickupMult > h.pickupMult);
  assert.deepEqual(e.hud, { markers: true, arrows: true, minimap: true, tag: true });
  assert.deepEqual(n.hud, { markers: false, arrows: true, minimap: false, tag: true });
  assert.deepEqual(h.hud, { markers: false, arrows: false, minimap: false, tag: false });
  assert.ok(e.cpTier > n.cpTier && n.cpTier > h.cpTier);
  assert.ok(e.searchTime < n.searchTime && n.searchTime < h.searchTime);
  assert.ok(h.flank && !e.flank);
});

// ── names & localization ───────────────────────────────────────────────
test('soldier names keep Azerbaijani letters, lose markup, and are 2–20 characters', () => {
  assert.equal(sanitizeName('  Əli   Şükürov '), 'Əli Şükürov');
  assert.equal(sanitizeName('ĞIİÖÜÇŞƏ ğıiöüçşə'), 'ĞIİÖÜÇŞƏ ğıiöüçşə');
  assert.equal(sanitizeName('<script>x</script>'), 'scriptxscript');
  assert.equal(sanitizeName('A'), '');
  assert.equal(sanitizeName('   '), '');
  assert.equal(Array.from(sanitizeName('a'.repeat(40))).length, 20);
});
test('both languages define every string, and radio lines carry the name', () => {
  const az = Object.keys(STRINGS.az).sort(), en = Object.keys(STRINGS.en).sort();
  assert.deepEqual(az, en);
  setLang('az'); assert.equal(t('r_final', { name: 'Əli' }), 'Komandir: Əli, irəli! Şəhərin mərkəzi qarşındadır. Dan yeri sökülür.');
  setLang('en'); assert.ok(t('r_start', { name: 'Əli' }).includes('Əli'));
  setLang('az');
});

// ── score parity with the room ─────────────────────────────────────────
test('the client score formula and the room score formula agree', () => {
  const cases = [
    { kills: 47, headshots: 12, stealthKills: 20, spotted: 2, shots: 200, hits: 120, time: 1800, deaths: 1 },
    { kills: 0, headshots: 0, stealthKills: 0, spotted: 0, shots: 0, hits: 0, time: 0, deaths: 0 },
    { kills: 60, headshots: 40, stealthKills: 55, spotted: 0, shots: 90, hits: 80, time: 900, deaths: 0 },
    { kills: 30, headshots: 2, stealthKills: 1, spotted: 14, shots: 900, hits: 150, time: 5000, deaths: 9 },
  ];
  for (const difficulty of ['easy', 'normal', 'hard']) for (const stats of cases) {
    let st = logic.setup(['p']);
    st = logic.applyAction(st, 'p', { type: 'start', difficulty });
    for (const act of [2, 3, 4]) st = logic.applyAction(st, 'p', { type: 'checkpoint', act, cp: 0, stats });
    assert.deepEqual(logic.validateAction(st, 'p', { type: 'finish', stats }), { ok: true });
    st = logic.applyAction(st, 'p', { type: 'finish', stats });
    const c = computeScore(stats, difficulty);
    assert.equal(st.score, c.score); assert.equal(st.rank, c.rank); assert.equal(st.accuracy, c.accuracy);
    assert.equal(logic.isGameOver(st).over, true);
  }
});
test('the room rejects another player, backwards progress and nonsense stats', () => {
  let st = logic.applyAction(logic.setup(['p']), 'p', { type: 'start', difficulty: 'normal' });
  const stats = { kills: 1, headshots: 0, stealthKills: 1, spotted: 0, shots: 2, hits: 1, time: 50, deaths: 0 };
  assert.equal(logic.validateAction(st, 'q', { type: 'start', difficulty: 'normal' }).ok, false);
  assert.equal(logic.validateAction(st, 'p', { type: 'start', difficulty: 'nightmare' }).ok, false);
  assert.equal(logic.validateAction(st, 'p', { type: 'checkpoint', act: 3, cp: 0, stats }).ok, false);
  assert.equal(logic.validateAction(st, 'p', { type: 'checkpoint', act: 1, cp: 1, stats: { ...stats, hits: 9 } }).ok, false);
  assert.equal(logic.validateAction(st, 'p', { type: 'checkpoint', act: 1, cp: 1, stats: { ...stats, kills: -1 } }).ok, false);
  assert.equal(logic.validateAction(st, 'p', { type: 'finish', stats }).ok, false);
  st = logic.applyAction(st, 'p', { type: 'checkpoint', act: 1, cp: 2, stats });
  assert.equal(logic.validateAction(st, 'p', { type: 'checkpoint', act: 1, cp: 1, stats }).ok, false);
  assert.equal(logic.validateAction(st, 'p', { type: 'checkpoint', act: 1, cp: 3, stats: { ...stats, time: 10 } }).ok, false);
  assert.equal(logic.viewFor(st, 'q').stats, undefined);
});
