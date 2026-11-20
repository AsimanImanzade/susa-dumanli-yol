/**
 * Unit tests for the enterable houses (interior-rules.js): the wall cutter,
 * which floor a point is on, the door rules, and the townhouse plan checked
 * against the real physics and nav grid — every room reachable from the
 * street, the player walking up every flight to the floor above, floors and
 * shut doors blocking sight.  node --test tests-node/interiors.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, F } from '../public/js/physics.js';
import { NavGrid } from '../public/js/nav.js';
import { NOISE } from '../public/js/config.js';
import { planTownhouse, solidRects, floorIndex, DOOR, stepDoor, doorBlocks, doorNoise, encodeDoors, decodeDoors, doorSuspicious, THIN_WOOD } from '../public/js/interior-rules.js';

const slope = (x, z) => (50 - z) * 0.022 + Math.sin(x * 0.3) * 0.05;
const HOUSES = [
  { x: -12.5, z: 28, w: 15, d: 24, door: 'e', back: 'w', floors: 2, low: true },
  { x: 12.5, z: -4.5, w: 15, d: 27, door: 'w', floors: 2, garrison: true },
  { x: -12.5, z: -29, w: 15, d: 14, door: 'e', floors: 3, garrison: true },
  { x: 22, z: 42, w: 30, d: 28, door: 'w', floors: 2, roof: 'flat' },
  { x: 3.3, z: -10.2, w: 14, d: 20, door: 's', back: 'e', floors: 2, rot: 0.4 },     // turned off the grid
  { x: 5.2, z: -100, w: 6, d: 5, door: 'e', back: false, floors: 1 },
];
const build = (o) => {
  const pl = planTownhouse({ ...o, gy: slope });
  const world = new World({ minX: -64, maxX: 64, minZ: -120, maxZ: 64 }, slope, () => 'stone');
  for (const b of pl.boxes) world.addBox(b);
  return { pl, world };
};

test('solidRects covers the wall minus its openings, without overlaps', () => {
  const holes = [{ u0: -2, u1: -1, y0: 1, y1: 2.4 }, { u0: 1, u1: 2.2, y0: 0, y1: 2.2 }, { u0: 1, u1: 2.2, y0: 4, y1: 5.4 }];
  const rs = solidRects(-5, 5, 0, 6, holes);
  const area = rs.reduce((s, r) => s + (r.u1 - r.u0) * (r.y1 - r.y0), 0);
  const holeArea = holes.reduce((s, h) => s + (h.u1 - h.u0) * (h.y1 - h.y0), 0);
  assert.ok(Math.abs(area - (60 - holeArea)) < 1e-9, `area ${area}`);
  for (const r of rs) for (const h of holes) assert.ok(!(r.u0 < h.u1 - 1e-9 && r.u1 > h.u0 + 1e-9 && r.y0 < h.y1 - 1e-9 && r.y1 > h.y0 + 1e-9), 'a piece overlaps a hole');
  // two windows stacked in one column share the strips beside them: few pieces
  assert.ok(rs.length <= 9, `pieces ${rs.length}`);
});

test('floorIndex: which floor a height belongs to', () => {
  const fy = [1, 4.1, 7.2, 10.3];
  assert.equal(floorIndex(fy, 0.6), 0);
  assert.equal(floorIndex(fy, 3.7), 1);       // half a metre below a floor counts as on it (stair top)
  assert.equal(floorIndex(fy, 4.1), 1);
  assert.equal(floorIndex(fy, 8), 2);
  assert.equal(floorIndex(fy, 10.3), 3);       // the roof
});

test('doors: swing, block only when shut, quieter crouched, saved as a bit string', () => {
  let a = 0, t = 0;
  while (a < DOOR.openAng && t < 5) { a = stepDoor(a, 1, 1 / 60); t += 1 / 60; }
  assert.ok(t > 0.5 && t < 1.0, `opens in ${t.toFixed(2)} s`);
  assert.ok(!doorBlocks(a));
  while (a > 0) a = stepDoor(a, 0, 1 / 60);
  assert.equal(a, 0); assert.ok(doorBlocks(a));
  assert.ok(doorNoise(1, NOISE.door) < doorNoise(0, NOISE.door) * 0.5);
  assert.equal(doorNoise(0, NOISE.door), NOISE.door);
  const doors = [{ target: 1 }, { target: 0 }, { target: 0 }, { target: 1 }];
  assert.equal(encodeDoors(doors), '1001');
  assert.deepEqual(decodeDoors('1001', 4), [true, false, false, true]);
  assert.deepEqual(decodeDoors(undefined, 2), [false, false]);
});

test('doors: only a Hard patrol notices one the player changed, and only once', () => {
  const d = { byPlayer: true, noticed: false };
  assert.ok(doorSuspicious(true, d, 'patrol'));
  assert.ok(!doorSuspicious(false, d, 'patrol'));        // Easy / Normal
  assert.ok(!doorSuspicious(true, d, 'busy'));           // already searching or fighting
  assert.ok(!doorSuspicious(true, { byPlayer: false }, 'patrol'));
  assert.ok(!doorSuspicious(true, { byPlayer: true, noticed: true }, 'patrol'));
});

for (const o of HOUSES) {
  test(`townhouse ${o.w}×${o.d}, ${o.floors} floor(s) at ${o.x},${o.z}: every room reachable, stairs climbable`, () => {
    const { pl, world } = build(o);
    // a shut door on every doorway must not cut the nav grid
    for (const dr of pl.doors) {
      const along = dr.axis === 'a', ca = along ? dr.c : dr.at, cb = along ? dr.at : dr.c, p = pl.Pc(ca, cb);
      const y = dr.f === 0 ? slope(p[0], p[1]) : pl.fy[dr.f];
      world.addBox({ x: p[0], y: y + 1.06, z: p[1], hx: dr.w / 2, hy: 1.06, hz: 0.035, rot: pl.R + (along ? 0 : -Math.PI / 2), flags: THIN_WOOD, tag: 'door' });
    }
    const nav = new NavGrid(world, null), path = [];
    for (const s of pl.spots.stands) assert.ok(nav.findPath(pl.spots.front.x, pl.spots.front.z, s.x, s.z, path), `room ${s.room} unreachable`);
    assert.equal(pl.spots.stands.length, pl.rooms.length, 'every ground-floor room has a free spot');
    if (pl.spots.back) assert.ok(nav.findPath(pl.spots.front.x, pl.spots.front.z, pl.spots.back.x, pl.spots.back.z, path), 'no way out the back');
    // the player: in at the front, up every flight, standing on the next floor
    const body = { x: pl.spots.hallFront.x, y: slope(pl.spots.hallFront.x, pl.spots.hallFront.z), z: pl.spots.hallFront.z, vx: 0, vy: 0, vz: 0, radius: 0.35, height: 1.8, grounded: true, step: 0.5 };
    const go = (tx, tz) => { for (let i = 0; i < 600; i++) { const dx = tx - body.x, dz = tz - body.z, d = Math.hypot(dx, dz); if (d < 0.15) break; body.vx = dx / d * 3; body.vz = dz / d * 3; world.move(body, 1 / 60, 14); } return Math.hypot(tx - body.x, tz - body.z); };
    for (const fl of pl.flights) {
      const am = (fl.a0 + fl.a1) / 2, foot = pl.Pc(am, fl.bFoot - fl.dir * 0.7), top = pl.Pc(am, fl.bFoot + fl.dir * (fl.run + 0.7));
      assert.ok(go(foot[0], foot[1]) < 0.3, 'could not reach the foot of the stairs');
      assert.ok(go(top[0], top[1]) < 0.3, 'stuck on the stairs');
      assert.ok(Math.abs(body.y - pl.fy[fl.f + 1]) < 0.02, `floor ${fl.f + 1}: feet at ${body.y.toFixed(2)}, floor at ${pl.fy[fl.f + 1].toFixed(2)}`);
      assert.ok(world.canFit(body.x, body.y, body.z, 0.35, 1.8), 'no head room upstairs');
    }
    // floors and the roof stop sight and bullets
    for (let f = 1; f <= pl.floors; f++) {
      const c = pl.Pc(pl.ia * 0.4, pl.ib * 0.4);
      assert.ok(!world.los(c[0], pl.fy[f] - 1.2, c[1], c[0] + 0.2, pl.fy[f] + 1.2, c[1] + 0.2), `seen through floor ${f}`);
      assert.ok(world.raycast(c[0], pl.fy[f] - 1.2, c[1], 0, 1, 0, 2.4, F.BULLET, {}, null), `shot through floor ${f}`);
    }
    // indoor volumes: one per floor, inside the walls
    assert.equal(pl.indoor.length, pl.floors);
    // rooms do not overlap the hall or each other
    for (const a of pl.rooms) for (const b of pl.rooms) if (a !== b) assert.ok(!(a.a0 < b.a1 - 1e-6 && a.a1 > b.a0 + 1e-6 && a.b0 < b.b1 - 1e-6 && a.b1 > b.b0 + 1e-6), 'rooms overlap');
  });
}

test('doorways on a grid-aligned house sit on nav cell centres', () => {
  const pl = planTownhouse({ ...HOUSES[0], gy: slope });
  for (const wl of pl.walls) for (const g of wl.gaps) {
    const p = wl.axis === 'b' ? pl.Pc(wl.at, g.c) : pl.Pc(g.c, wl.at);
    const along = wl.axis === 'b' ? [pl.sR, pl.cR] : [pl.cR, -pl.sR], v = Math.abs(along[0]) > 0.5 ? p[0] : p[1];
    assert.ok(Math.abs(v - Math.floor(v) - 0.5) < 1e-6, `gap at ${v}`);
  }
});
