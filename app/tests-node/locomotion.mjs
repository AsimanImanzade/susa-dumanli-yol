/**
 * Soldier path steering (locomotion.js) against a real nav grid.
 * Run with:  node --test tests-node/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AI } from '../public/js/config.js';
import { World } from '../public/js/physics.js';
import { NavGrid } from '../public/js/nav.js';
import { steer, coast, moveLimits, approachSpeed, directionCap, clearLine, paceFor, wrapAngle, headingOf } from '../public/js/locomotion.js';

const P = AI.loco;
const DT = 1 / 60;

/** A walled courtyard: a long wall with a gap forces an L or U shaped path. */
function yard() {
  const w = new World({ minX: -20, maxX: 20, minZ: -20, maxZ: 20 }, () => 0);
  w.addBox({ x: 0, y: 1.5, z: 0, hx: 0.3, hy: 1.5, hz: 8 });          // wall along z at x = 0, from z −8 to 8
  w.addBox({ x: -6, y: 1.5, z: -10, hx: 6, hy: 1.5, hz: 0.3 });       // wall along x at z = −10
  return new NavGrid(w);
}
function mover(x, z, yaw = 0) { return { x, z, spd: 0, hd: yaw, sx: x, sz: z, pi: 0, face: yaw, faceFollows: true }; }

/** Walk a path to its end like ai._move does (the body yaw follows the path). Returns stats. */
function walk(nav, m, path, vmax, maxT = 60) {
  const lim = moveLimits(vmax, P, {}), out = {};
  let t = 0, top = 0, blocked = 0, minCorner = Infinity;
  const corners = path.slice(0, -1);
  while (t < maxT) {
    m.face = m.face + wrapAngle((out.want ?? m.face) - m.face) * (1 - Math.exp(-AI.turnRate * DT));
    const ox = m.x, oz = m.z;
    const going = steer(m, path, P, lim, DT, nav, out);
    if (!nav.isFree(m.x, m.z) && nav.isFree(ox, oz)) blocked++;
    top = Math.max(top, m.spd);
    for (const c of corners) minCorner = Math.min(minCorner, Math.hypot(m.x - c.x, m.z - c.z));
    t += DT;
    if (!going) break;
  }
  return { t, top, blocked, minCorner, done: m.pi >= path.length };
}

test('a walk start takes about half a second, a run start and a hard stop about a second', () => {
  const tTo = (vmax, frac) => { const lim = moveLimits(vmax, P, {}); let s = 0, t = 0; while (s < vmax * frac && t < 5) { s = approachSpeed(s, vmax, lim, DT); t += DT; } return t; };
  const walk95 = tTo(AI.walkSpeed, 0.95), run95 = tTo(AI.runSpeed, 0.95);
  assert.ok(walk95 > 0.35 && walk95 < 0.75, `walk start ${walk95.toFixed(2)} s`);
  assert.ok(run95 > 1.0 && run95 < 1.8, `run start ${run95.toFixed(2)} s`);
  const lim = moveLimits(AI.runSpeed, P, {});
  let s = AI.runSpeed, t = 0, d = 0;
  while (s > 0.05 && t < 5) { s = approachSpeed(s, 0, lim, DT); d += s * DT; t += DT; }
  assert.ok(t > 0.7 && t < 1.5, `hard stop ${t.toFixed(2)} s`);
  assert.ok(d > 1 && d < 3, `stopping distance ${d.toFixed(2)} m`);
});

test('speed never jumps: no frame changes it by more than the peak acceleration allows', () => {
  const lim = moveLimits(AI.runSpeed, P, {});
  let s = 0;
  for (let i = 0; i < 300; i++) {
    const target = i < 150 ? AI.runSpeed : 0, ns = approachSpeed(s, target, lim, DT);
    assert.ok(Math.abs(ns - s) <= Math.max(lim.acc, lim.dec) * DT + 1e-9);
    s = ns;
  }
});

test('round a wall: reaches the goal, never steps onto a blocked cell, rounds the corner, keeps under top speed', () => {
  const nav = yard();
  for (const vmax of [AI.walkSpeed, AI.searchSpeed, AI.runSpeed]) {
    const path = [];
    assert.ok(nav.findPath(-4, 4, 4, 4, path), 'path found');
    assert.ok(path.length >= 2, 'the wall forces a corner');
    const m = mover(-4, 4, headingOf(0, -1));
    const r = walk(nav, m, path, vmax);
    assert.ok(r.done, `vmax ${vmax}: reached the goal (t ${r.t.toFixed(1)})`);
    assert.equal(r.blocked, 0, `vmax ${vmax}: walked onto a blocked cell`);
    assert.ok(r.top <= vmax + 1e-9, `vmax ${vmax}: top ${r.top}`);
    assert.ok(Math.hypot(m.x - 4, m.z - 4) < P.arriveR * 3, `vmax ${vmax}: ends at the goal`);
    // the straight-line time at top speed is a lower bound; a sane walk is not much slower
    let len = Math.hypot(path[0].x + 4, path[0].z - 4);
    for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    assert.ok(r.t < len / vmax * 1.6 + 2, `vmax ${vmax}: took ${r.t.toFixed(1)} s for ${len.toFixed(1)} m`);
  }
});

test('hairpin and zig-zag paths finish without orbiting a waypoint', () => {
  const nav = yard();
  const open = { isFree: () => true };
  const cases = [
    [{ x: 5, z: 0 }, { x: 0, z: 0.4 }],                                   // a U-turn
    [{ x: 2, z: -2 }, { x: 0, z: -4 }, { x: 2, z: -6 }, { x: 0, z: -8 }],   // zig-zag
    [{ x: 0.3, z: 0 }],                                                   // a goal right next to him
    [{ x: 0, z: 3 }],                                                     // a goal behind him
  ];
  for (const vmax of [AI.walkSpeed, AI.runSpeed]) for (const path of cases) {
    const m = mover(0, 0, 0);
    const r = walk(open, m, path, vmax, 20);
    assert.ok(r.done, `vmax ${vmax} path ${JSON.stringify(path)} unfinished after ${r.t.toFixed(1)} s`);
  }
  void nav;
});

test('braking: arrives slow; sharp corners are taken slower than gentle ones', () => {
  const open = { isFree: () => true }, lim = moveLimits(AI.runSpeed, P, {}), out = {};
  // straight run to a goal 12 m away: speed when the goal is reached
  const m = mover(0, 0, 0), path = [{ x: 0, z: -12 }];
  let last = 0;
  while (steer(m, path, P, lim, DT, open, out)) last = m.spd;
  assert.ok(last < 1.2, `arrival speed ${last.toFixed(2)}`);
  // speed at the apex of a 30° and a 150° corner
  const apex = (turnDeg) => {
    const a = turnDeg * Math.PI / 180, c = { x: 0, z: -10 }, end = { x: Math.sin(a) * -10, z: -10 - Math.cos(a) * 10 };
    const mm = mover(0, 0, 0), pth = [c, end];
    let v = Infinity;
    for (let i = 0; i < 2000 && steer(mm, pth, P, lim, DT, open, out); i++) if (Math.hypot(mm.x - c.x, mm.z - c.z) < 1.2) v = Math.min(v, mm.spd);
    return v;
  };
  const gentle = apex(30), sharp = apex(150);
  assert.ok(gentle > sharp + 1, `30° corner ${gentle.toFixed(2)} m/s vs 150° ${sharp.toFixed(2)} m/s`);
});

test('the carrot never cuts through a wall: every chord it walks keeps the corridor clear', () => {
  const nav = yard();
  const path = [];
  nav.findPath(-3, -6, -3, -14, path);              // round the end of the z = −10 wall
  const m = mover(-3, -6, 0), lim = moveLimits(AI.runSpeed, P, {}), out = {};
  for (let i = 0; i < 3000; i++) {
    const ox = m.x, oz = m.z;
    if (!steer(m, path, P, lim, DT, nav, out)) break;
    assert.ok(nav.isFree(m.x, m.z) || !nav.isFree(ox, oz), `stepped into a wall at ${m.x.toFixed(2)}, ${m.z.toFixed(2)}`);
  }
  assert.ok(m.pi >= path.length, 'arrived');
  assert.ok(clearLine({ isFree: () => true }, 0, 0, 3, 3, 0.3));
});

test('facing elsewhere caps the speed: strafing slower than running ahead, back-pedalling slower still', () => {
  const v = AI.runSpeed;
  assert.equal(directionCap(0, v, P.strafeSpeed, P.backSpeed), v);
  assert.equal(directionCap(Math.PI / 2, v, P.strafeSpeed, P.backSpeed), P.strafeSpeed);
  assert.equal(directionCap(Math.PI, v, P.strafeSpeed, P.backSpeed), P.backSpeed);
  assert.equal(directionCap(Math.PI, AI.walkSpeed, P.strafeSpeed, P.backSpeed), AI.walkSpeed);   // a walk is never capped
});

test('top speeds stay the state speeds; each soldier gets his own steady pace', () => {
  const seen = new Set();
  for (let id = 1; id < 60; id++) {
    const p = paceFor(id, P.pace[0], P.pace[1]);
    assert.ok(p >= P.pace[0] && p <= P.pace[1]);
    assert.equal(p, paceFor(id, P.pace[0], P.pace[1]));
    seen.add(p.toFixed(3));
  }
  assert.ok(seen.size > 30);
  assert.ok(P.pace[1] <= 1);
  // coasting bleeds the speed off without moving through anything
  const m = mover(0, 0, 0); m.spd = 2;
  const lim = moveLimits(AI.searchSpeed, P, {}), out = {};
  let t = 0;
  while (coast(m, lim, DT, out) && t < 3) t += DT;
  assert.ok(t < 1.2 && m.spd === 0);
});
