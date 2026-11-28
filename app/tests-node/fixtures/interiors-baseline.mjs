/**
 * The townhouse plans the act files were laid out against: for each house
 * below, a digest of every spot (loot, posts, stands, doorways out), every
 * collider and every piece of first-pass furniture. tests-node/interiors.mjs
 * checks the planner still makes exactly these, so the furnishing pass can
 * only ever add to a house, never move what the levels index.
 *
 *   node tests-node/fixtures/interiors-baseline.mjs --write   regenerate (only after a deliberate layout change)
 */
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planTownhouse } from '../../public/js/interior-rules.js';

export const slope = (x, z) => (50 - z) * 0.022 + Math.sin(x * 0.3) * 0.05;
export const BASE_HOUSES = [
  // tests-node/interiors.mjs
  { x: -12.5, z: 28, w: 15, d: 24, door: 'e', back: 'w', floors: 2, low: true },
  { x: 12.5, z: -4.5, w: 15, d: 27, door: 'w', floors: 2, garrison: true },
  { x: -12.5, z: -29, w: 15, d: 14, door: 'e', floors: 3, garrison: true },
  { x: 22, z: 42, w: 30, d: 28, door: 'w', floors: 2, roof: 'flat' },
  { x: 3.3, z: -10.2, w: 14, d: 20, door: 's', back: 'e', floors: 2, rot: 0.4 },
  { x: 5.2, z: -100, w: 6, d: 5, door: 'e', back: false, floors: 1 },
  // the acts' houses
  { x: 12.5, z: 28, w: 15, d: 24, door: 'w', back: 'e', floors: 2, garrison: true },
  { x: 12.5, z: -4.5, w: 15, d: 27, door: 'w', back: 'e', floors: 2 },
  { x: 13, z: -104, w: 14, d: 22, door: 'w', back: 'e', floors: 2, garrison: true },
  { x: -22, z: 42, w: 30, d: 28, door: 'e', back: 'w', floors: 2, garrison: true },
  { x: 22, z: 42, w: 30, d: 28, door: 'w', back: 'e', floors: 2, low: true },
  { x: -20, z: -2, w: 6, d: 5, floors: 1, door: 'e', back: false, lit: 1 },
  // explicit seeds
  { x: -12.5, z: 0, w: 15, d: 24, door: 'e', back: 'w', floors: 2, seed: 1 },
  { x: 12.5, z: 0, w: 15, d: 24, door: 'w', back: 'e', floors: 2, roof: 'flat', seed: 7, garrison: true },
  { x: 0, z: 0, w: 15, d: 14, door: 'e', floors: 3, seed: 42 },
];

const R6 = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
const canon = (v) => JSON.stringify(v, (k, x) => (typeof x === 'number' ? R6(x) : x));
const H = (v) => createHash('sha1').update(canon(v)).digest('hex').slice(0, 16);

/** The parts of a plan the levels depend on, digested. nBoxes: how many colliders the first pass makes. */
export function digest(pl, nBoxes = pl.boxes.length) {
  const furn = pl.furn.map((it) => ({ kind: it.kind, f: it.f, room: it.room, a: it.a, b: it.b, ry: it.ry, w: it.w, d: it.d, h: it.h, y: it.y, nocol: !!it.nocol, lamp: !!it.lamp, fire: !!it.fire, radio: !!it.radio }));
  const boxes = pl.boxes.slice(0, nBoxes).map((b) => [b.x, b.y, b.z, b.hx, b.hy, b.hz, b.rot, b.flags, b.mat || '', b.tag || '']);
  const sp = pl.spots;
  return {
    spots: H({ loot: sp.loot, posts: sp.posts, stands: sp.stands, front: sp.front, back: sp.back || null, hallFront: sp.hallFront, hallBack: sp.hallBack }),
    boxes: H(boxes), nBoxes, furn: H(furn), nFurn: furn.length,
    doors: H(pl.doors.map((d) => [d.f, d.ext, d.axis, d.at, d.c, d.w, d.swing, d.hinge, d.open])),
    lamps: H(pl.lamps.map((l) => [l.f, l.a, l.b, l.y, l.r, l.i])),
    windows: H(pl.windows.map((W) => [W.side, W.f, W.u, W.ww, W.ya, W.yb, W.kind])),
  };
}

export const BASE_FILE = fileURLToPath(new URL('./interiors-baseline.json', import.meta.url));
export const readBaseline = () => JSON.parse(readFileSync(BASE_FILE, 'utf8'));

if (process.argv.includes('--write')) {
  const out = BASE_HOUSES.map((o) => digest(planTownhouse({ ...o, gy: slope })));
  writeFileSync(BASE_FILE, JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote ${out.length} house digests to ${BASE_FILE}`);
}
