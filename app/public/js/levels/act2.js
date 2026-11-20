/**
 * Act 2 — The Cliffs. A sheer rock face; the climb itself is scripted by
 * climb.js. This file only builds the scenery and the route data.
 */
import { makeRng } from '../ctx.js';

export const CLIFF_TOP = 46;
export const routeX = (y) => Math.sin(y * 0.21) * 3.2 + Math.sin(y * 0.07) * 1.5;

export function build(L) {
  const rng = makeRng(77);
  L.envName = 'cliffs';
  L.terrain({ bounds: { minX: -44, maxX: 44, minZ: -44, maxZ: 44 }, height: () => 0, tex: 'rock', step: 4, surface: () => 'rock', tint: () => 0x8f8f88 });
  // the face (z = 0 plane) and the plateau on top
  L.box(0, -22, 88, CLIFF_TOP, 44, 'rock', { y: 0, tint: 0xd2d2ca });
  // relief: slabs and overhangs standing proud of the face
  for (let i = 0; i < 70; i++) {
    const y = rng.range(1, CLIFF_TOP - 3), x = rng.range(-30, 30);
    if (Math.abs(x - routeX(y)) < 1.4) continue;                        // keep the route clear
    L.box(x, 0.2, rng.range(1.5, 5), rng.range(1, 4), rng.range(0.5, 1.4), 'rock', { y, rot: rng.range(-0.15, 0.15), tint: i % 2 ? 0xa2a29a : 0x9a9a92, noCollide: true });
  }
  // rest ledges with an overhang above them (cover from the patrol)
  const ledges = [11.5, 23, 34.5];
  for (const y of ledges) {
    L.box(routeX(y), 0.6, 3.2, 0.35, 1.3, 'rock', { y: y - 0.35, tint: 0xbcbcb4, noCollide: true });
    L.box(routeX(y), 0.5, 4, 0.6, 1.2, 'rock', { y: y + 2.5, tint: 0x8c8c84, noCollide: true });
  }
  // the fixed rope
  for (let y = 0.5; y < CLIFF_TOP; y += 1) {
    const x0 = routeX(y), x1 = routeX(y + 1);
    L._batch('glow0').box((x0 + x1) / 2, y + 0.5, 0.12, 0.035, 1.05, 0.035, 0x6b5a3c, { rz: Math.atan2(-(x1 - x0), 1) });
  }
  // a few boulders and scrub at the foot, a low wall on the plateau edge
  for (let i = 0; i < 9; i++) L.rock(rng.range(-26, 26), rng.range(4, 18), rng.range(0.8, 2));
  for (let i = 0; i < 6; i++) L.tree(rng.range(-34, 34), rng.range(10, 36), rng.range(0.9, 1.4), 1);
  L.spawn = { x: routeX(0), z: 1.0, yaw: 0, y: 0 };
  L.climb = { top: CLIFF_TOP - 1.2, ledges, x: routeX };
  L.sector(1, 'sec1', { minX: -44, maxX: 44, minZ: -44, maxZ: 44 });
  // ── an abandoned observation post on the plateau edge: a tarpaulin lean-to behind a low
  //    sandbag wall, a brushwood windbreak, wire along the edge (military.js; four batches only)
  L.atHeight(CLIFF_TOP, () => {
    L.leanTo(7, -4.6, Math.PI, { tarp: true });
    L.windbreak(-7, -3.4, 0, 3.5);
    L.wire(-19, -1.5, -10.5, -1.5); L.wire(12.5, -1.7, 21, -1.7);
    L.sandbags(7, -2.0, 3.4, 0, 0.75);
  });
  L.objective = 'obj_a2';
}
