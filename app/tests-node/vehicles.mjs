/**
 * Unit tests for the tank and artillery rules (vehicle-rules.js): where a
 * charge sits, what the crew can see, engine masking, steering, the route,
 * the main gun and the track belt. No browser, no Three.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VEHICLES, DIFFICULTY } from '../public/js/config.js';
import { sightRange, visibility } from '../public/js/stealth.js';
import {
  toLocal, toWorld, chargeZone, chargeEffect, chargePrompt, crewSight, crewDetectionRate, engineLoudness, stepMasked, shotCovered,
  driveStep, roundRoute, nearestPoint, stepToward, respawnIndex, mainGunReady, shellDamage, fireForbidden, footprintOverlap, beltPath,
} from '../public/js/vehicle-rules.js';

const T = VEHICLES.tank, Cg = VEHICLES.charge;

test('local and world frames are inverses (forward = −z at yaw 0)', () => {
  const o = {}, w = {};
  toLocal(3, -7, 1, 2, 0.8, o); toWorld(o.x, o.z, 1, 2, 0.8, w);
  assert.ok(Math.abs(w.x - 3) < 1e-9 && Math.abs(w.z + 7) < 1e-9);
  toLocal(0, -5, 0, 0, 0, o);
  assert.ok(Math.abs(o.x) < 1e-9 && Math.abs(o.z + 5) < 1e-9, 'a point ahead of a yaw-0 tank is at local −z');
});

test('only a charge on the rear (engine deck, rear plate, fuel drums) destroys the tank', () => {
  assert.equal(chargeZone(0, T.hullTop, 2.2), 'rear');            // engine deck behind the turret
  assert.equal(chargeZone(0.6, 1.0, 3.45), 'rear');               // rear plate
  assert.equal(chargeZone(-0.5, 1.3, 3.8), 'rear');               // fuel drum
  assert.equal(chargeZone(0, 1.2, -3.0), 'front');                // glacis
  assert.equal(chargeZone(-1.75, 0.8, 0), 'side');                // skirt over the tracks
  assert.equal(chargeZone(1.75, 1.0, 2.0), 'side');               // rear of the side: still the side
  assert.equal(chargeZone(0.3, 2.1, 0.2), 'turret');
  assert.equal(chargeEffect('rear'), 'destroy');
  for (const z of ['front', 'side', 'turret']) assert.equal(chargeEffect(z), 'immobilize');
});

test('the C4 prompt names the right spot', () => {
  assert.equal(chargePrompt('rear', Cg.deckY + 0.1), 'p_c4deck');
  assert.equal(chargePrompt('rear', 0.9), 'p_c4rear');
  assert.equal(chargePrompt('side', 0.9), 'p_c4track');
  assert.equal(chargePrompt('front', 1.2), 'p_c4track');
});

test('the crew sees ahead and where the turret points, never directly behind or close beside the hull', () => {
  assert.equal(crewSight(0, -20, 0), 0, 'dead ahead is the centre of the driver\'s arc');
  assert.equal(crewSight(0, 15, 0), -1, 'directly behind');
  assert.equal(crewSight(0, 15, Math.PI), -1, 'directly behind even with the turret turned round');
  assert.equal(crewSight(-T.hw - 1, 0, 0), -1, 'close beside the hull');
  assert.equal(crewSight(0.5, T.hlR + 1.5, 0), -1, 'close behind the hull');
  assert.equal(crewSight(-20, 0, 0), -1, 'a side target outside the driver\'s arc with the turret forward');
  assert.ok(crewSight(-20, 0, Math.PI / 2) >= 0, 'the same target once the turret swings onto it');
  assert.ok(crewSight(-20, 0, Math.PI / 2) < crewSight(-20, -12, 0.3) + 1, 'off-axis share stays within 0..1');
});

test('crew detection follows the soldiers\' model, slower, and scales with difficulty', () => {
  const base = { dist: 15, range: sightRange(0.5, 0.5), off: 0.1, vis: visibility(0, 0.5, 0.5, false), alert: 0 };
  const rate = (d, o = {}) => crewDetectionRate({ ...base, diffMult: DIFFICULTY[d].detectMult, ...o });
  assert.ok(rate('easy') < rate('normal') && rate('normal') < rate('hard'));
  assert.ok(rate('normal', { vis: visibility(1, 0, 0.5, false) }) < rate('normal'), 'crouched and still is harder to see');
  assert.ok(rate('normal', { dist: 25 }) < rate('normal'), 'further is harder to see');
  assert.equal(rate('normal', { off: -1 }), 0, 'a blind spot is a blind spot');
  assert.equal(rate('normal', { dist: base.range + 1 }), 0, 'beyond the fog and darkness range');
});

test('the engine masks footsteps for soldiers near the tank, not far from it', () => {
  const walk = (d) => 1 - d / 9;                                    // a standing walk on stone, heard d metres away
  assert.ok(stepMasked(walk(4), engineLoudness(5, 1)), 'next to a moving tank');
  assert.ok(!stepMasked(walk(4), engineLoudness(40, 1)), 'a street away from it');
  assert.ok(engineLoudness(20, 0) < engineLoudness(20, 1), 'idling is quieter than moving');
  assert.equal(engineLoudness(T.engine.moveRadius + 1, 1), 0);
  assert.ok(!stepMasked(0, 1), 'nothing to mask');
});

test('an artillery report covers a shot for a moment, except right beside the shooter', () => {
  const A = VEHICLES.artillery;
  assert.ok(shotCovered(0.5, 30));
  assert.ok(!shotCovered(0.5, A.coverNear - 1));
  assert.ok(!shotCovered(A.coverTime + 0.1, 30));
  assert.ok(!shotCovered(-1, 30));
});

test('steering: a big heading error is taken out on the spot, a small one on the move; it gets there', () => {
  const s = { x: 0, z: 0, yaw: 0, speed: 0, turn: 0 };
  // target directly to the right (+x): 90° off, so it pivots before rolling
  for (let i = 0; i < 30; i++) driveStep(s, 20, 0, 1 / 60, false, false);
  assert.ok(Math.abs(s.speed) < 0.2 && Math.hypot(s.x, s.z) < 0.1, 'pivoting, not rolling');
  let d = 99;
  for (let i = 0; i < 60 * 30 && d > T.arrive; i++) d = driveStep(s, 20, 0, 1 / 60, true, false);
  assert.ok(d <= T.arrive, 'reached the waypoint');
  // reversing: the hull keeps facing away from the target
  const r = { x: 0, z: 0, yaw: -Math.PI / 2, speed: 0, turn: 0 };      // facing +x
  for (let i = 0, dr = 99; i < 60 * 10 && dr > T.arrive; i++) dr = driveStep(r, -10, 0, 1 / 60, true, false, true);
  assert.ok(r.x < -5 && Math.abs(r.yaw + Math.PI / 2) < 0.05, 'backed up toward −x still facing +x');
  // stop brakes to a halt
  const b = { x: 0, z: 0, yaw: 0, speed: T.speed, turn: 0 };
  for (let i = 0; i < 60 * 3; i++) driveStep(b, 0, -50, 1 / 60, false, true);
  assert.equal(b.speed, 0);
});

test('routes: corners are rounded into arcs, waits and open ends are kept and braked for', () => {
  const pts = [{ x: 0, z: 0, wait: 5 }, { x: 0, z: -20, wait: 0 }, { x: 20, z: -20, wait: 0 }, { x: 20, z: 0, wait: 3 }];
  const loop = roundRoute(pts, 4, true);
  assert.ok(loop.length > pts.length, 'arc points added');
  assert.ok(loop.some((p) => p.x > 1 && p.x < 3.9 && p.z < -16 && p.z > -19.9), 'the corner at (0,-20) is cut by an arc');
  assert.ok(loop.filter((p) => p.wait > 0).length === 2 && loop.every((p) => p.wait === 0 || p.slow));
  const open = roundRoute([{ x: 0, z: 0, wait: 0 }, { x: 10, z: 0, wait: 0 }], 4, false);
  assert.ok(open[0].slow && open[1].slow, 'the ends of an open route are reversals');
  assert.equal(nearestPoint(pts, 19, -18), 2);
  assert.equal(stepToward(8, 1, 6, true), 0, 'the short way round a loop');
  assert.equal(stepToward(8, 1, 3, true), 2);
  assert.equal(stepToward(5, 3, 1, false), 2);
});

test('a live tank restored from a checkpoint starts clear of the player', () => {
  const route = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 30, z: 0 }, { x: 60, z: 0 }];
  const j = respawnIndex(route, 9, 0, 11, 0);
  assert.ok(Math.hypot(route[j].x - 11, route[j].z) >= T.respawnClear);
  assert.equal(respawnIndex(route, 30, 0, 100, 0), 2, 'where it was when the player is far away');
});

test('the main gun waits for a player who has gone to ground, and moving away beats it', () => {
  const G = T.gun;
  assert.ok(mainGunReady(G.coverTime, 5, 30, 0));
  assert.ok(!mainGunReady(G.coverTime - 0.5, 5, 30, 0), 'not hidden long enough');
  assert.ok(!mainGunReady(G.coverTime, G.memory + 1, 30, 0), 'lost track of him');
  assert.ok(!mainGunReady(G.coverTime, 5, 30, 1), 'still loading');
  assert.ok(!mainGunReady(G.coverTime, 5, G.minRange - 1, 0), 'too close');
  assert.equal(shellDamage(G.radius + 0.1, true, 1), 0, 'outside the blast');
  assert.ok(shellDamage(1.5, false, 1) < shellDamage(1.5, true, 1), 'cover cuts it');
  assert.ok(shellDamage(1.5, true, DIFFICULTY.easy.damageMult) < shellDamage(1.5, true, DIFFICULTY.hard.damageMult));
  assert.ok(shellDamage(1.5, true, 1) < 100, 'one shell does not kill a healthy player on Normal');
});

test('nothing is fired at, through or into the mosque grounds', () => {
  const sanct = { x: 44, z: -56, r: 22 };
  assert.ok(fireForbidden(sanct, 0, -29, 40, -40));
  assert.ok(fireForbidden(sanct, 0, -29, 60, -80), 'the line passes through');
  assert.ok(!fireForbidden(sanct, 0, -29, -20, 10));
  assert.ok(!fireForbidden(null, 0, 0, 1, 1));
});

test('contact with the hull: pushed out by the nearest face', () => {
  const o = {};
  assert.ok(footprintOverlap(0, -T.hlF - 0.1, 0.35, o) > 0 && o.face === 'front');
  assert.ok(footprintOverlap(T.hw + 0.1, 0.5, 0.35, o) > 0 && o.face === 'side' && o.nx === 1);
  assert.ok(footprintOverlap(0, T.hlR + 0.2, 0.35, o) > 0 && o.face === 'rear');
  assert.ok(footprintOverlap(T.hw + 1, 0, 0.35, o) <= 0);
});

test('the track belt is a closed loop that lies on the ground under the road wheels', () => {
  const p = beltPath([{ z: -2, y: 0.44, r: 0.4 }, { z: 2, y: 0.44, r: 0.4 }, { z: 3, y: 0.7, r: 0.33 }, { z: -3, y: 0.6, r: 0.32 }]);
  const first = p[0], last = p[p.length - 1];
  assert.ok(Math.hypot(first.z - last.z, first.y - last.y) < 1e-6, 'closed');
  for (let i = 1; i < p.length; i++) assert.ok(p[i].s > p[i - 1].s, 'arc length grows');
  const low = Math.min(...p.map((q) => q.y));
  assert.ok(Math.abs(low - 0.04) < 0.01, 'the bottom run is on the ground');
  assert.ok(Math.max(...p.map((q) => q.z)) > 3.2 && Math.min(...p.map((q) => q.z)) < -3.2, 'wraps the sprocket and the idler');
});
