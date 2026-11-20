/**
 * interior-rules.js — the pure half of the enterable houses (no Three.js, so
 * the node tests can run it): the floor plan of a townhouse — rooms, interior
 * walls and doorways, stairs and stairwells, windows, balcony, furniture
 * footprints, lamps, loot and sentry spots — every collider that plan needs,
 * which floor a point is on, and the door rules (swing, when a door blocks,
 * how loud it is, how door state is saved).
 *
 * interiors.js draws what this module plans and runs the doors.
 *
 * Frames. The house frame is the kit's: centre (x, z), yaw `rot`, width w
 * along local x, depth d along local z, P(lx, lz) → world. The plan works in
 * a "canonical" frame turned so the front door is on the +b side: a runs
 * across the front (length A), b runs from the back to the front (length B).
 */
import { F, WALL } from './physics.js';
import { makeRng } from './ctx.js';

export const THIN_WOOD = F.SOLID | F.VISION | F.BULLET | F.THIN;
const SOFT = F.SOLID | F.VISION | F.WALK;           // beds, sofas: block sight, bullets pass
const RAIL = F.SOLID;                                // railings: stop walking only

/** Dimensions (metres). */
export const DIM = {
  fh: 3.1, slab: 0.3, T: 0.36, Tout: 0.12, ti: 0.16,
  rise: 0.27, run: 0.3, sw: 1.1,
  doorH: 2.15, extDoorW: 1.3, intDoorW: 1.2, wideDoorW: 2.2,
};
const SIDE_TH = { s: 0, e: Math.PI / 2, n: Math.PI, w: -Math.PI / 2 };
const OPP = { s: 'n', n: 's', e: 'w', w: 'e' };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ───────────────────────────── geometry helpers ─────────────────────────────
/**
 * Solid parts of the rectangle [u0,u1]×[y0,y1] once the holes are cut out, as
 * rectangles: the u axis is split at every hole edge, each strip keeps the
 * runs between its holes, and neighbouring strips with the same runs merge.
 */
export function solidRects(u0, u1, y0, y1, holes) {
  const hs = holes.map((h) => ({ u0: Math.max(u0, h.u0), u1: Math.min(u1, h.u1), y0: Math.max(y0, h.y0), y1: Math.min(y1, h.y1) }))
    .filter((h) => h.u1 - h.u0 > 1e-4 && h.y1 - h.y0 > 1e-4);
  const us = [u0, u1];
  for (const h of hs) us.push(h.u0, h.u1);
  us.sort((a, b) => a - b);
  const strips = [];
  for (let i = 0; i < us.length - 1; i++) {
    const a = us[i], b = us[i + 1];
    if (b - a < 1e-4) continue;
    const m = (a + b) / 2, cut = hs.filter((h) => h.u0 <= m && h.u1 >= m).sort((p, q) => p.y0 - q.y0);
    const runs = [];
    let y = y0;
    for (const h of cut) { if (h.y0 > y + 1e-4) runs.push([y, h.y0]); y = Math.max(y, h.y1); }
    if (y1 > y + 1e-4) runs.push([y, y1]);
    const key = runs.map((r) => r[0].toFixed(4) + ':' + r[1].toFixed(4)).join('|');
    const last = strips[strips.length - 1];
    if (last && last.key === key && Math.abs(last.u1 - a) < 1e-6) last.u1 = b;
    else strips.push({ u0: a, u1: b, runs, key });
  }
  const out = [];
  for (const s of strips) for (const r of s.runs) out.push({ u0: s.u0, u1: s.u1, y0: r[0], y1: r[1] });
  return out;
}

/** Which floor a height is on: the highest floor level at most half a metre above it. */
export function floorIndex(fy, y) {
  let f = 0;
  for (let i = 1; i < fy.length; i++) if (y >= fy[i] - 0.5) f = i;
  return f;
}

// ───────────────────────────── doors ─────────────────────────────
export const DOOR = { openAng: 1.75, speed: 2.4, quiet: 0.35, reach: 2.0, enemyReach: 1.35, noticeRange: 14 };
/** Swing one step towards open (target 1) or shut (0); returns the new angle (radians, ≥ 0). */
export function stepDoor(ang, target, dt) {
  const goal = target ? DOOR.openAng : 0, d = goal - ang, s = DOOR.speed * dt;
  return Math.abs(d) <= s ? goal : ang + Math.sign(d) * s;
}
/** A leaf this close to its frame blocks the doorway (collider in place). */
export function doorBlocks(ang) { return ang < 0.06; }
/** Noise radius of a door being worked: crouching opens it quietly. */
export function doorNoise(stance, base) { return base * (stance > 0 ? DOOR.quiet : 1); }
/** Door state for a checkpoint: '1' open, '0' shut, in door order. */
export function encodeDoors(doors) { return doors.map((d) => (d.target ? '1' : '0')).join(''); }
export function decodeDoors(s, n) { const out = []; for (let i = 0; i < n; i++) out.push(!!(s && s[i] === '1')); return out; }
/**
 * Hard only: a patrolling soldier who sees a door the player changed (and
 * nobody has noticed yet) turns suspicious.
 */
export function doorSuspicious(flank, door, state) { return !!flank && state === 'patrol' && !!door.byPlayer && !door.noticed; }

// ───────────────────────────── the plan ─────────────────────────────
/**
 * Plan a townhouse.
 * o: { x, z, w, d, rot, floors (1–3), fh, gy(x,z), door: 's'|'e'|'n'|'w', back: side|false, roof: 'flat'|'gable',
 *      seed, garrison (more military rooms), low (a ground-floor window low enough to climb through),
 *      balcony (true/false/undefined = random), lit (rooms lit: 0–2) }
 */
export function planTownhouse(o) {
  const { x, z, w, d } = o, rot = o.rot || 0, floors = clamp(o.floors || 2, 1, 3), fh = o.fh || DIM.fh;
  const front = o.door || 's', back = o.back === false ? null : (o.back || OPP[front]);
  const rng = makeRng(o.seed ?? ((Math.floor(x * 7.31 + 1000) * 73856093) ^ (Math.floor(z * 5.17 + 1000) * 19349663) ^ 0x5eed));
  const gy = o.gy, flat = o.roof === 'flat';
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
  const corners = [P(-w / 2, -d / 2), P(w / 2, -d / 2), P(-w / 2, d / 2), P(w / 2, d / 2)];
  const H = floors * fh;
  const y0 = Math.min(...corners.map((p) => gy(p[0], p[1]))) - 0.5;
  const top = Math.max(...corners.map((p) => gy(p[0], p[1]))) + H;
  const gMax = top - H;
  const fy = []; for (let f = 0; f <= floors; f++) fy.push(gMax + f * fh);
  const rh = flat ? 0 : Math.min(3.2, d * 0.32);

  // canonical frame
  const R = rot + SIDE_TH[front], cR = Math.cos(R), sR = Math.sin(R);
  const ns = front === 's' || front === 'n';
  const A = ns ? w : d, B = ns ? d : w;
  const Pc = (a, b) => [x + a * cR + b * sR, z - a * sR + b * cR];
  const aligned = Math.abs(Math.sin(2 * R)) < 1e-6;
  const T = DIM.T, ti = DIM.ti, slab = DIM.slab, sw = DIM.sw;
  const ia = A / 2 - T, ib = B / 2 - T;
  const dW = aligned ? DIM.extDoorW : DIM.wideDoorW, idW = aligned ? DIM.intDoorW : DIM.wideDoorW;
  // move a coordinate along a canonical axis until its world coordinate sits on a nav cell centre (x.5)
  const snap = (a, b, axis) => {
    const v = axis === 'a' ? a : b;
    if (!aligned) return v;
    const p = Pc(a, b), dir = axis === 'a' ? [cR, -sR] : [sR, cR];
    const useX = Math.abs(dir[0]) > 0.5, wv = useX ? p[0] : p[1], sg = useX ? Math.sign(dir[0]) : Math.sign(dir[1]);
    const t0 = Math.floor(wv) + 0.5;
    let best = Infinity;
    for (const t of [t0 - 1, t0, t0 + 1]) { const dd = (t - wv) * sg; if (Math.abs(dd) < Math.abs(best)) best = dd; }
    return v + best;
  };
  const gyC = (a, b) => { const p = Pc(a, b); return gy(p[0], p[1]); };

  // ── hall and blocks
  const narrow = A < 9.5;
  const Wh = (floors >= 3 ? 3.4 : 3.0) + (aligned ? 0 : 0.9), hh = Wh / 2;      // off the grid, passages need more room to stay on the nav grid
  const ah = narrow ? snap(rng.range(-0.4, 0.4), 0, 'a') : snap(rng.range(-0.5, 0.5), 0, 'a');
  const aHL = ah - hh - ti / 2, aHR = ah + hh + ti / 2;
  const walls = [];        // { axis:'a'|'b' (direction it runs), at, from, to, gaps:[{c,w,door}] }
  const rooms = [];        // canonical clear rects
  const addWall = (axis, at, from, to) => { const wl = { axis, at, from, to, gaps: [] }; walls.push(wl); return wl; };
  let hallL = null, hallR = null;
  const blocks = [];
  if (narrow) blocks.push({ side: 0, lo: -ia, hi: ia });
  else {
    hallL = addWall('b', aHL, -ib, ib); hallR = addWall('b', aHR, -ib, ib);
    blocks.push({ side: -1, lo: -ia, hi: aHL - ti / 2 }, { side: 1, lo: aHR + ti / 2, hi: ia });
  }

  // ── stairs (planned before the doorways so these keep clear of them)
  const flights = [], holes = [], rails = [];
  let stairEx = null;
  if (floors >= 2 && !narrow) {
    const footA = ah + hh - sw / 2;
    const riseFoot = (bb) => fy[1] - gyC(footA, bb);
    let bA0 = 0, nA = 0, LA = 0;
    for (let k = 0; k < 2; k++) {        // the run depends on the ground at the foot, which depends on where the foot is
      nA = Math.ceil(riseFoot(bA0) / DIM.rise - 1e-6); LA = nA * DIM.run;
      bA0 = clamp(LA / 2 + rng.range(-0.8, 0.8), -ib + LA + 1.8, ib - 2.0);
    }
    const baseA = Math.min(gyC(footA, bA0), gyC(footA, bA0 - LA)) - 0.15;
    flights.push({ f: 0, a0: ah + hh - sw, a1: ah + hh, bFoot: bA0, dir: -1, n: nA, run: LA, yFoot: fy[1] - nA * ((fy[1] - gyC(footA, bA0)) / nA), yTop: fy[1], base: baseA, sh: (fy[1] - gyC(footA, bA0)) / nA });
    holes.push({ f: 1, a0: ah + hh - sw - 0.05, a1: ah + hh, b0: bA0 - LA, b1: bA0 });
    rails.push({ f: 1, axis: 'b', at: ah + hh - sw - 0.05, from: bA0 - LA + 0.35, to: bA0 }, { f: 1, axis: 'a', at: bA0, from: ah + hh - sw - 0.05, to: ah + hh });
    let exLo = bA0 - LA, exHi = bA0;
    if (floors >= 3) {
      const nB = Math.ceil(fh / DIM.rise - 1e-6), LB = nB * DIM.run, bB0 = bA0 - LA;
      flights.push({ f: 1, a0: ah - hh, a1: ah - hh + sw, bFoot: bB0, dir: 1, n: nB, run: LB, yFoot: fy[1], yTop: fy[2], base: fy[1] - 0.02, sh: fh / nB });
      holes.push({ f: 2, a0: ah - hh, a1: ah - hh + sw + 0.05, b0: bB0, b1: bB0 + LB });
      rails.push({ f: 2, axis: 'b', at: ah - hh + sw + 0.05, from: bB0, to: bB0 + LB - 0.35 }, { f: 2, axis: 'a', at: bB0, from: ah - hh, to: ah - hh + sw + 0.05 });
      exLo = Math.min(exLo, bB0); exHi = Math.max(exHi, bB0 + LB);
    }
    stairEx = { lo: exLo - idW / 2 - 0.35, hi: exHi + idW / 2 + 0.35, left: floors >= 3, right: true };
  }

  // ── rooms
  const target = 5.6;
  for (const bk of blocks) {
    const bw = bk.hi - bk.lo;
    const cols = [];
    if (bw > 8.5 && !narrow) {
      const mid = (bk.lo + bk.hi) / 2 + rng.range(-0.6, 0.6);
      const inner = bk.side < 0 ? [mid + ti / 2, bk.hi] : [bk.lo, mid - ti / 2], outer = bk.side < 0 ? [bk.lo, mid - ti / 2] : [mid + ti / 2, bk.hi];
      cols.push({ i: 0, a0: inner[0], a1: inner[1] }, { i: 1, a0: outer[0], a1: outer[1], wall: addWall('b', mid, -ib, ib) });
    } else cols.push({ i: 0, a0: bk.lo, a1: bk.hi });
    const nrow = clamp(Math.round(2 * ib / target) + (bk.side > 0 && rng.chance(0.4) ? -1 : 0), 1, 6);
    const bounds = [-ib];
    for (let k = 1; k < nrow; k++) bounds.push(-ib + (2 * ib) * (k / nrow) + rng.range(-0.35, 0.35));
    bounds.push(ib);
    for (const col of cols) {
      let prev = null;
      for (let k = 0; k < nrow; k++) {
        const b0 = k === 0 ? -ib : bounds[k] + ti / 2, b1 = k === nrow - 1 ? ib : bounds[k + 1] - ti / 2;
        const rm = { id: rooms.length, blk: bk.side, col: col.i, row: k, a0: col.a0, a1: col.a1, b0, b1, links: [] };
        if (prev) rm.rowWall = addWall('a', bounds[k], col.a0, col.a1), rm.prev = prev;
        rooms.push(rm); prev = rm;
      }
      col.rooms = rooms.slice(rooms.length - nrow);
    }
    bk.cols = cols;
  }
  const byId = (i) => rooms[i];

  // ── doorways
  const pickOn = (lo, hi, axis, at, ex) => {
    // a gap centre within [lo,hi] (along the wall), outside the stair exclusion, snapped to the nav grid
    const ranges = [];
    if (ex && hi > ex.lo && lo < ex.hi) { if (ex.lo > lo) ranges.push([lo, Math.min(hi, ex.lo)]); if (ex.hi < hi) ranges.push([Math.max(lo, ex.hi), hi]); }
    else ranges.push([lo, hi]);
    const ok = ranges.filter((r) => r[1] - r[0] > 0.05);
    if (!ok.length) return null;
    const r = rng.pick(ok);
    let cpos = rng.range(r[0], r[1]);
    const sn = axis === 'b' ? snap(at, cpos, 'b') : snap(cpos, at, 'a');
    if (sn >= r[0] - 0.5 && sn <= r[1] + 0.5 && sn >= lo - 0.2 && sn <= hi + 0.2 && !(ex && sn > ex.lo && sn < ex.hi)) cpos = sn;
    else {
      // try the neighbouring cell centres
      let found = null;
      for (const k of [-1, 1, -2, 2]) { const v = sn + k; if (v >= lo && v <= hi && !(ex && v > ex.lo && v < ex.hi)) { found = v; break; } }
      if (found === null) { if (aligned) return null; } else cpos = found;
    }
    return cpos;
  };
  const m = idW / 2 + 0.55;
  const gap = (wl, cpos, a, b, door) => { const g = { c: cpos, w: idW, door, rooms: [a, b] }; wl.gaps.push(g); return g; };
  for (const bk of blocks) {
    for (const col of bk.cols) {
      for (const rm of col.rooms) {
        if (narrow) continue;
        if (col.i === 0) {
          const wl = bk.side < 0 ? hallL : hallR, ex = stairEx && (bk.side < 0 ? stairEx.left : stairEx.right) ? stairEx : null;
          const cp = pickOn(rm.b0 + m, rm.b1 - m, 'b', wl.at, ex);
          if (cp !== null) { gap(wl, cp, rm.id, -1, rng.chance(0.45)); rm.links.push(-1); }
        } else {
          const inner = bk.cols[0].rooms.find((q) => q.row === rm.row) || bk.cols[0].rooms[0];
          // the opening must face the inner room it leads to
          const lo = Math.max(rm.b0, inner.b0) + m, hi = Math.min(rm.b1, inner.b1) - m;
          const cp = pickOn(lo, hi, 'b', col.wall.at, null);
          if (cp !== null) { gap(col.wall, cp, rm.id, inner.id, rng.chance(0.5)); rm.links.push(inner.id); inner.links.push(rm.id); }
        }
      }
    }
  }
  // row doorways: always where a room has no way in yet, sometimes for a second way round
  const reach = () => {
    const seen = new Set(), q = [];
    for (const rm of rooms) if (rm.links.includes(-1)) { seen.add(rm.id); q.push(rm.id); }
    if (narrow && rooms.length) { seen.add(rooms[rooms.length - 1].id); q.push(rooms[rooms.length - 1].id); }
    while (q.length) { const i = q.shift(); for (const j of byId(i).links) if (j >= 0 && !seen.has(j)) { seen.add(j); q.push(j); } }
    return seen;
  };
  const rowGap = (rm) => {
    const lo = rm.a0 + m, hi = rm.a1 - m;
    const cp = pickOn(lo, hi, 'a', rm.rowWall.at, null);
    if (cp === null) return false;
    gap(rm.rowWall, cp, rm.id, rm.prev.id, narrow ? true : rng.chance(0.45)); rm.links.push(rm.prev.id); rm.prev.links.push(rm.id);
    return true;
  };
  for (const rm of rooms) if (rm.prev && (narrow || rng.chance(0.3))) rowGap(rm);
  for (let guard = 0; guard < 12; guard++) {
    const seen = reach();
    const lost = rooms.filter((r) => !seen.has(r.id));
    if (!lost.length) break;
    let fixed = false;
    for (const rm of lost) {
      if (rm.prev && seen.has(rm.prev.id) && !rm.links.includes(rm.prev.id)) { if (rowGap(rm)) { fixed = true; break; } }
      const next = rooms.find((q) => q.prev === rm);
      if (next && seen.has(next.id) && !next.links.includes(rm.id)) { if (rowGap(next)) { fixed = true; break; } }
    }
    if (!fixed) for (const rm of lost) if (rm.prev && !rm.links.includes(rm.prev.id) && rowGap(rm)) { fixed = true; break; }
    if (!fixed) break;
  }

  // ── exterior: sides, doors, windows
  const SIDES = [
    { key: 'front', len: A, o: [0, B / 2], t: [1, 0], n: [0, 1] },
    { key: 'back', len: A, o: [0, -B / 2], t: [-1, 0], n: [0, -1] },
    { key: 'right', len: B, o: [A / 2, 0], t: [0, -1], n: [1, 0] },
    { key: 'left', len: B, o: [-A / 2, 0], t: [0, 1], n: [-1, 0] },
  ];
  const sideByKey = Object.fromEntries(SIDES.map((S) => [S.key, S]));
  // which canonical side a house-frame side name is
  const keyOf = (hs) => {
    const th = SIDE_TH[hs] - SIDE_TH[front];
    const k = Math.round(((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (Math.PI / 2)) % 4;
    return ['front', 'right', 'back', 'left'][k];
  };
  const uOf = (S, a, b) => (a - S.o[0]) * S.t[0] + (b - S.o[1]) * S.t[1];
  const doors = [];
  const extDoor = (S, aC) => {
    const u = uOf(S, aC, S.o[1] + (S.key === 'front' ? 0 : 0));
    const g = gyC(...(S.key === 'front' || S.key === 'back' ? [aC, S.o[1]] : [S.o[0], aC]));
    S.door = { u, w: dW, g };
    return { u, g };
  };
  const frontD = extDoor(sideByKey.front, ah);
  doors.push({ f: 0, ext: true, side: 'front', axis: 'a', at: B / 2 - T + 0.09, c: ah, w: dW, y: frontD.g, swing: -1, hinge: rng.chance(0.5) ? 1 : -1, open: false });
  let backKey = null;
  if (back) {
    backKey = keyOf(back);
    const S = sideByKey[backKey];
    if (backKey === 'back') {
      const bd = extDoor(S, ah);
      doors.push({ f: 0, ext: true, side: 'back', axis: 'a', at: -B / 2 + T - 0.09, c: ah, w: dW, y: bd.g, swing: 1, hinge: rng.chance(0.5) ? 1 : -1, open: false });
    } else {
      // a side door into the middle room of that side's block
      const bk = blocks.find((q) => q.side === (backKey === 'right' ? 1 : -1)) || blocks[0];
      const outer = bk.cols[bk.cols.length - 1].rooms, rm = outer[Math.floor(outer.length / 2)];
      const bc = snap(S.o[0], (rm.b0 + rm.b1) / 2, 'b');
      const u = uOf(S, S.o[0], bc), g = gyC(S.o[0], bc);
      S.door = { u, w: dW, g };
      doors.push({ f: 0, ext: true, side: backKey, axis: 'b', at: S.o[0] - S.n[0] * (T - 0.09), c: bc, w: dW, y: g, swing: -S.n[0], hinge: 1, open: false, room: rm.id });
    }
  }
  // interior doors with leaves
  for (const wl of walls) for (const g of wl.gaps) {
    if (!g.door) continue;
    // swing into the room away from the hall (rooms[0] of the gap is the far one)
    const rm = byId(g.rooms[0]);
    const mid = wl.axis === 'b' ? (rm.a0 + rm.a1) / 2 : (rm.b0 + rm.b1) / 2;
    const swing = Math.sign(mid - wl.at) || 1;
    for (let f = 0; f < floors; f++) {
      if (f > 0 && rng.chance(0.35)) continue;     // some upper doorways lost their doors
      doors.push({ f, ext: false, axis: wl.axis, at: wl.at, c: g.c, w: g.w, y: null, swing, hinge: rng.chance(0.5) ? 1 : -1, open: rng.chance(0.5), room: rm.id });
    }
  }

  // junctions where interior walls meet each side (windows keep clear of them)
  const junctions = { front: [], back: [], right: [], left: [] };
  for (const wl of walls) {
    if (wl.axis === 'b') { junctions.front.push(wl.at); junctions.back.push(-wl.at); }
    else {
      const sideKey = wl.to > ah ? (wl.from > ah ? 'right' : null) : 'left';
      if (narrow) { junctions.right.push(-wl.at); junctions.left.push(wl.at); }
      else if (sideKey === 'right') junctions.right.push(-wl.at); else if (sideKey === 'left') junctions.left.push(wl.at);
    }
  }
  const windows = [];
  const ft = floors - 1;
  let lowDone = !o.low, balWin = null;
  const wantBal = floors >= 2 && (o.balcony ?? rng.chance(0.6));
  for (const S of SIDES) {
    const n = Math.max(1, Math.floor(S.len / 3.4)), sp = S.len / n, ww = clamp(sp * 0.34, 0.85, 1.2);
    const J = junctions[S.key];
    const cols = [];
    for (let i = 0; i < n; i++) {
      let u = -S.len / 2 + (i + 0.5) * sp;
      const clear = (uu) => J.every((j) => Math.abs(uu - j) > ww / 2 + ti / 2 + 0.22) && Math.abs(uu) < S.len / 2 - T - ww / 2 - 0.3;
      if (!clear(u)) {
        const j = J.reduce((p, q) => (Math.abs(q - u) < Math.abs(p - u) ? q : p), J[0]);
        const sh = ww / 2 + ti / 2 + 0.3;
        const alt = [j + sh, j - sh].sort((p, q) => Math.abs(p - u) - Math.abs(q - u)).find(clear);
        if (alt === undefined) continue;
        u = alt;
      }
      cols.push(u);
    }
    for (let f = 0; f < floors; f++) {
      const sill = fy[f] + 0.9, lim = (f === ft ? top - (flat ? 0.45 : 0.5) : fy[f + 1] - 0.55);
      for (const u of cols) {
        if (f === 0 && S.door && Math.abs(u - S.door.u) < S.door.w / 2 + ww / 2 + 0.45) continue;
        let kind = 'open', ya = sill, yb = Math.min(sill + (f ? 1.55 : 1.45), lim);
        const r = rng();
        if (r < 0.12) kind = 'shut'; else if (r < 0.2) kind = 'boarded';
        if (!lowDone && f === 0 && (S.key === 'back' || S.key === backKey || S.key === 'left') && kind !== 'shut') { kind = 'low'; ya = fy[0] + 0.55; yb = Math.min(ya + 1.95, lim); lowDone = true; }
        const W = { side: S.key, f, u, ww, ya, yb, kind };
        if (wantBal && !balWin && f === ft && S.key === 'front' && Math.abs(u - S.door.u) > 0.5 && kind !== 'low') { W.kind = 'french'; W.ya = fy[f] + 0.02; W.yb = Math.min(fy[f] + 2.35, lim); balWin = W; }
        windows.push(W);
      }
    }
  }
  const balcony = balWin ? { side: 'front', u: balWin.u, f: ft, y: fy[ft], w: 2.3, dz: 0.9 } : null;

  // ── furniture, lamps, loot and sentry spots
  const furn = [], lamps = [], loot = [], posts = [], stands = [];
  for (let f = 0; f < floors; f++) { loot.push([]); posts.push([]); }
  const floorAt = (f, a, b) => (f === 0 ? gyC(a, b) : fy[f]);
  const roomsF = [];
  for (let f = 0; f < floors; f++) for (const rm of rooms) roomsF.push({ ...rm, f, kind: null, lit: false });
  // kinds: a kitchen at the back of the ground floor, bedrooms upstairs, military rooms in garrisoned houses
  const groundRooms = roomsF.filter((r) => r.f === 0), upRooms = roomsF.filter((r) => r.f > 0);
  groundRooms.sort((p, q) => p.b0 - q.b0);
  if (groundRooms.length) groundRooms[0].kind = 'kitchen';
  for (const r of groundRooms) if (!r.kind) r.kind = rng.pick(o.garrison ? ['guard', 'store', 'living', 'living'] : ['living', 'living', 'store', 'bedroom']);
  for (const r of upRooms) r.kind = rng.pick(o.garrison ? ['bedroom', 'post', 'post', 'living', 'radio'] : ['bedroom', 'bedroom', 'living', 'store']);
  if (o.garrison && floors >= 2) { const pr = upRooms.filter((r) => r.f === ft); if (pr.length) { pr[0].kind = 'post'; if (pr[1]) pr[1].kind = 'radio'; } }
  const nLit = o.lit ?? (rng.chance(0.6) ? 2 : 1);
  const litCands = roomsF.filter((r) => r.kind === 'kitchen' || r.kind === 'radio' || r.kind === 'guard' || r.kind === 'living');
  for (let i = 0; i < nLit && litCands.length; i++) { const k = rng.int(0, litCands.length - 1); litCands[k].lit = true; litCands.splice(k, 1); }

  // openings around a room: gaps on its walls (doorways), windows on exterior faces
  const gapsNear = (rm) => {
    const out = [];
    for (const wl of walls) for (const g of wl.gaps) {
      if (wl.axis === 'b') { if (wl.at >= rm.a0 - ti && wl.at <= rm.a1 + ti && g.c >= rm.b0 - 0.2 && g.c <= rm.b1 + 0.2) out.push({ a: wl.at, b: g.c, w: g.w }); }
      else if (wl.at >= rm.b0 - ti && wl.at <= rm.b1 + ti && g.c >= rm.a0 - 0.2 && g.c <= rm.a1 + 0.2) out.push({ a: g.c, b: wl.at, w: g.w });
    }
    for (const S of SIDES) if (S.door) {
      const p = [S.o[0] + S.t[0] * S.door.u, S.o[1] + S.t[1] * S.door.u];
      if (p[0] >= rm.a0 - T - 0.1 && p[0] <= rm.a1 + T + 0.1 && p[1] >= rm.b0 - T - 0.1 && p[1] <= rm.b1 + T + 0.1) out.push({ a: p[0], b: p[1], w: S.door.w });
    }
    return out;
  };
  const winsOf = (rm) => windows.filter((W) => W.f === rm.f).map((W) => {
    const S = sideByKey[W.side];
    const p = [S.o[0] + S.t[0] * W.u - S.n[0] * T, S.o[1] + S.t[1] * W.u - S.n[1] * T];
    return { W, S, a: p[0], b: p[1] };
  }).filter((q) => q.a >= rm.a0 - 0.05 && q.a <= rm.a1 + 0.05 && q.b >= rm.b0 - 0.05 && q.b <= rm.b1 + 0.05);
  const inRect = (r, a, b, pad) => a > r.a0 - pad && a < r.a1 + pad && b > r.b0 - pad && b < r.b1 + pad;
  for (const rm of roomsF) {
    const placed = [];
    const ops = gapsNear(rm), wins = winsOf(rm);
    // walking lines that stay clear: from every opening to the middle of the room
    const ca0 = (rm.a0 + rm.a1) / 2, cb0 = (rm.b0 + rm.b1) / 2;
    const lanes = ops.map((g) => [g.a, g.b, ca0, cb0]);
    // soldiers walk the ground floor on a 1 m grid padded by 0.42 m: keep a full cell clear along lanes and inside doorways
    const laneW = rm.f === 0 ? 0.95 : 0.62, doorR = rm.f === 0 ? 1.3 : 0.75;
    const onLane = (a0, a1, b0, b1) => lanes.some(([pa, pb, qa, qb]) => {
      const n = Math.max(2, Math.ceil(Math.hypot(qa - pa, qb - pb) / 0.25));
      for (let i = 0; i <= n; i++) { const t = i / n, a = pa + (qa - pa) * t, b = pb + (qb - pb) * t; if (a > a0 - laneW && a < a1 + laneW && b > b0 - laneW && b < b1 + laneW) return true; }
      return false;
    });
    const fits = (a0, a1, b0, b1, tall) => {
      if (a0 < rm.a0 - 1e-3 || a1 > rm.a1 + 1e-3 || b0 < rm.b0 - 1e-3 || b1 > rm.b1 + 1e-3) return false;
      if (onLane(a0, a1, b0, b1)) return false;
      for (const p of placed) if (a1 > p.a0 - 0.12 && a0 < p.a1 + 0.12 && b1 > p.b0 - 0.12 && b0 < p.b1 + 0.12) return false;
      for (const g of ops) { const r = g.w / 2 + doorR; if (g.a > a0 - r && g.a < a1 + r && g.b > b0 - r && g.b < b1 + r) return false; }
      if (tall) for (const q of wins) { const r = q.W.ww / 2 + 0.2; if (q.a > a0 - r && q.a < a1 + r && q.b > b0 - r && q.b < b1 + r) return false; }
      for (const h of holes) if (h.f === rm.f && a1 > h.a0 - 0.3 && a0 < h.a1 + 0.3 && b1 > h.b0 - 0.3 && b0 < h.b1 + 0.3) return false;
      for (const fl of flights) if (fl.f === rm.f && a1 > fl.a0 - 0.3 && a0 < fl.a1 + 0.3 && b1 > Math.min(fl.bFoot, fl.bFoot + fl.dir * fl.run) - 0.5 && b0 < Math.max(fl.bFoot, fl.bFoot + fl.dir * fl.run) + 0.5) return false;
      return true;
    };
    // put an item of size (iw along the wall, idp out from it) against a wall of the room; returns it or null
    const againstWall = (kind, iw, idp, h, extra = {}) => {
      for (let tries = 0; tries < 14; tries++) {
        const side = rng.int(0, 3);    // 0 −a, 1 +a, 2 −b, 3 +b
        const alongA = side >= 2, len = alongA ? rm.a1 - rm.a0 : rm.b1 - rm.b0;
        if (len < iw + 0.2) continue;
        const t = rng.range(-len / 2 + iw / 2 + 0.05, len / 2 - iw / 2 - 0.05);
        let a, b, ry, sa, sb;
        if (alongA) { a = (rm.a0 + rm.a1) / 2 + t; b = side === 2 ? rm.b0 + idp / 2 + 0.02 : rm.b1 - idp / 2 - 0.02; ry = side === 2 ? 0 : Math.PI; sa = iw; sb = idp; }
        else { b = (rm.b0 + rm.b1) / 2 + t; a = side === 0 ? rm.a0 + idp / 2 + 0.02 : rm.a1 - idp / 2 - 0.02; ry = side === 0 ? Math.PI / 2 : -Math.PI / 2; sa = idp; sb = iw; }
        if (!fits(a - sa / 2, a + sa / 2, b - sb / 2, b + sb / 2, h > 1.0)) continue;
        const it = { kind, f: rm.f, room: rm.id, a, b, ry, w: iw, d: idp, h, a0: a - sa / 2, a1: a + sa / 2, b0: b - sb / 2, b1: b + sb / 2, ...extra };
        placed.push(it); furn.push(it);
        return it;
      }
      return null;
    };
    const free = (kind, iw, idp, h, ry, extra = {}) => {
      for (let tries = 0; tries < 10; tries++) {
        const a = rng.range(rm.a0 + 1.0, rm.a1 - 1.0), b = rng.range(rm.b0 + 1.0, rm.b1 - 1.0);
        const r = ry ?? (rng.chance(0.5) ? 0 : Math.PI / 2) + rng.range(-0.15, 0.15);
        const ca = Math.abs(Math.cos(r)), sa2 = Math.abs(Math.sin(r));
        const ha = (iw * ca + idp * sa2) / 2, hb = (iw * sa2 + idp * ca) / 2;
        if (rm.a1 - rm.a0 < 2.4 || rm.b1 - rm.b0 < 2.4) return null;
        if (!fits(a - ha, a + ha, b - hb, b + hb, false)) continue;
        const it = { kind, f: rm.f, room: rm.id, a, b, ry: r, w: iw, d: idp, h, a0: a - ha, a1: a + ha, b0: b - hb, b1: b + hb, ...extra };
        placed.push(it); furn.push(it);
        return it;
      }
      return null;
    };
    const centreOk = rm.f > 0 || (rm.a1 - rm.a0 > 4.6 && rm.b1 - rm.b0 > 4.6);
    const tableSet = (wantLamp) => {
      const t = (centreOk && free('table', 1.4, 0.8, 0.76)) || againstWall('table', 1.4, 0.8, 0.76);
      if (!t) return null;
      const zd = [Math.sin(t.ry), Math.cos(t.ry)];      // the table's depth axis; chairs face it from both long sides
      for (const side of [-1, 1]) if (rng.chance(0.7)) {
        const it = { kind: rng.chance(0.25) ? 'chairDown' : 'chair', f: rm.f, room: rm.id, a: t.a + zd[0] * side * 0.75, b: t.b + zd[1] * side * 0.75, ry: t.ry + (side > 0 ? Math.PI : 0) + rng.range(-0.4, 0.4), w: 0.45, d: 0.45, h: 0.9, nocol: true };
        if (inRect(rm, it.a, it.b, -0.25)) furn.push(it);
      }
      loot[rm.f].push({ a: t.a, b: t.b, top: t.h, room: rm.id, kind: rm.kind });
      if (wantLamp) t.lamp = true;
      return t;
    };
    if (rm.f === 0 && rm.kind !== 'store' && rng.chance(0.65)) furn.push({ kind: 'rug', f: 0, room: rm.id, a: (rm.a0 + rm.a1) / 2, b: (rm.b0 + rm.b1) / 2, ry: 0, w: Math.min(2.6, rm.a1 - rm.a0 - 1.2), d: Math.min(1.8, rm.b1 - rm.b0 - 1.2), h: 0.01, nocol: true });
    else if (rm.f > 0 && rm.kind !== 'store' && rng.chance(0.5)) furn.push({ kind: 'rug', f: rm.f, room: rm.id, a: (rm.a0 + rm.a1) / 2, b: (rm.b0 + rm.b1) / 2, ry: Math.PI / 2, w: Math.min(2.4, rm.b1 - rm.b0 - 1.2), d: Math.min(1.6, rm.a1 - rm.a0 - 1.2), h: 0.01, nocol: true });
    switch (rm.kind) {
      case 'kitchen': {
        const st = againstWall('stove', 0.62, 0.62, 0.92, { lit: rm.lit }); if (st && rm.lit) st.fire = true;
        againstWall('cabinet', 1.4, 0.5, 0.9); if (rng.chance(0.6)) againstWall('shelf', 1.0, 0.35, 1.9);
        tableSet(false); break;
      }
      case 'living': {
        if (rng.chance(0.6)) againstWall('sofa', 1.9, 0.85, 0.85);
        againstWall(rng.chance(0.5) ? 'wardrobe' : 'shelf', 1.1, 0.5, 1.95);
        if (rng.chance(0.5)) againstWall('cabinet', 1.4, 0.5, 0.9);
        const t = tableSet(rm.lit);
        if (!t && rm.lit) againstWall('cabinet', 1.2, 0.5, 0.9, { lamp: true });
        if (rng.chance(0.35)) free('tableDown', 1.4, 0.8, 0.76);
        break;
      }
      case 'bedroom': {
        againstWall('bed', 2.0, 0.95, 0.55); if (rng.chance(0.5)) againstWall('bed', 2.0, 0.95, 0.55);
        againstWall('wardrobe', 1.1, 0.6, 2.0);
        if (rng.chance(0.4)) againstWall('chair', 0.45, 0.45, 0.9, { nocol: true });
        if (rng.chance(0.3)) againstWall('wardrobeDown', 1.95, 0.6, 0.6);
        break;
      }
      case 'store': {
        for (let k = 0; k < 3; k++) againstWall('crate', 1.0, 1.0, 1.0);
        againstWall('shelf', 1.0, 0.35, 1.9);
        if (rng.chance(0.5)) againstWall('barrel', 0.6, 0.6, 0.9);
        break;
      }
      case 'guard': {
        tableSet(rm.lit);
        againstWall('crate', 1.0, 1.0, 1.0); againstWall('cot', 1.9, 0.75, 0.45);
        break;
      }
      case 'radio': {
        const t = againstWall('table', 1.4, 0.8, 0.76, { radio: true, lamp: rm.lit });
        if (t) {
          // the operator sits in front of his set, facing the wall
          const zd = [Math.sin(t.ry), Math.cos(t.ry)], ca = t.a + zd[0] * 0.75, cb = t.b + zd[1] * 0.75;
          furn.push({ kind: 'chair', f: rm.f, room: rm.id, a: ca, b: cb, ry: t.ry + Math.PI, w: 0.45, d: 0.45, h: 0.9, nocol: true });
          loot[rm.f].push({ a: t.a, b: t.b, top: t.h, room: rm.id, kind: 'radio' });
          posts[rm.f].unshift({ a: ca, b: cb, face: [-zd[0], -zd[1]], room: rm.id, radio: true });
        }
        againstWall('crate', 1.0, 1.0, 1.0); againstWall('cot', 1.9, 0.75, 0.45);
        break;
      }
      case 'post': {
        againstWall('crate', 1.0, 1.0, 1.0); if (rng.chance(0.5)) againstWall('cot', 1.9, 0.75, 0.45);
        if (rng.chance(0.5)) free('tableDown', 1.4, 0.8, 0.76);
        break;
      }
    }
    // floor loot spot: a free point next to a wall
    for (let k = 0; k < 6; k++) {
      const a = rng.range(rm.a0 + 0.5, rm.a1 - 0.5), b = rng.range(rm.b0 + 0.5, rm.b1 - 0.5);
      if (!fits(a - 0.3, a + 0.3, b - 0.3, b + 0.3, false)) continue;
      loot[rm.f].push({ a, b, top: 0, room: rm.id, kind: rm.kind });
      break;
    }
    // where a soldier can stand in this room (ground floor patrols)
    if (rm.f === 0) {
      let best = null;
      for (let k = 0; k < 16; k++) {
        const a = k === 0 ? (rm.a0 + rm.a1) / 2 : rng.range(rm.a0 + 0.9, rm.a1 - 0.9), b = k === 0 ? (rm.b0 + rm.b1) / 2 : rng.range(rm.b0 + 0.9, rm.b1 - 0.9);
        if (placed.some((p) => !p.nocol && a > p.a0 - 0.8 && a < p.a1 + 0.8 && b > p.b0 - 0.8 && b < p.b1 + 0.8)) continue;
        best = { a, b }; break;
      }
      if (best) stands.push({ room: rm.id, ...best });
    }
    // sentry spots at the windows (upper floors): sandbags in military rooms
    if (rm.f > 0) for (const q of wins) {
      if (q.W.kind === 'shut' || q.W.kind === 'french') continue;
      const inA = -q.S.n[0], inB = -q.S.n[1];
      const bag = (rm.kind === 'post' || (o.garrison && rng.chance(0.3))) && !q.W.bagged;
      const depth = bag ? 1.05 : 0.75;
      const pa = q.a + inA * depth, pb = q.b + inB * depth;
      if (bag) {
        const bw2 = q.W.ww + 0.5;
        const ba = q.a + inA * 0.33, bb = q.b + inB * 0.33, ry = Math.atan2(q.S.t[1], q.S.t[0]) * 0;
        const sa = Math.abs(q.S.t[0]) > 0.5 ? bw2 : 0.6, sb = Math.abs(q.S.t[0]) > 0.5 ? 0.6 : bw2;
        if (fits(ba - sa / 2, ba + sa / 2, bb - sb / 2, bb + sb / 2, false)) {
          const it = { kind: 'sandbags', f: rm.f, room: rm.id, a: ba, b: bb, ry: Math.abs(q.S.t[0]) > 0.5 ? 0 : Math.PI / 2, w: bw2, d: 0.6, h: 1.05, a0: ba - sa / 2, a1: ba + sa / 2, b0: bb - sb / 2, b1: bb + sb / 2 };
          placed.push(it); furn.push(it); q.W.bagged = true; void ry;
        }
      }
      posts[rm.f].push({ a: pa, b: pb, face: [q.S.n[0], q.S.n[1]], room: rm.id, bagged: !!q.W.bagged, side: q.S.key });
    }
    // lit rooms: a lamp on the table (or the stove's fire)
    if (rm.lit) {
      const fire = placed.find((p) => p.fire), lampOn = placed.find((p) => p.lamp);
      if (fire) lamps.push({ f: rm.f, a: fire.a, b: fire.b, y: 0.55, r: 6, i: 0.8, color: 0xff9a4a, flicker: true, room: rm.id });
      else if (lampOn) lamps.push({ f: rm.f, a: lampOn.a, b: lampOn.b, y: lampOn.h + 0.35, r: 6.5, i: 0.85, color: 0xffc27a, room: rm.id, onTop: lampOn });
      else { const t = againstWall('cabinet', 1.2, 0.5, 0.9, { lamp: true }); if (t) lamps.push({ f: rm.f, a: t.a, b: t.b, y: t.h + 0.35, r: 6.5, i: 0.85, color: 0xffc27a, room: rm.id, onTop: t }); }
    }
  }
  for (const it of furn) it.y = floorAt(it.f, it.a, it.b);
  for (const L of lamps) L.y += floorAt(L.f, L.a, L.b);

  // ── colliders (canonical boxes → world)
  const boxes = [];
  const cbox = (a, b, ya, yb, ha, hb, flags, mat, ry = 0, tag) => {
    if (yb - ya < 1e-3 || ha < 1e-3 || hb < 1e-3) return;
    const p = Pc(a, b);
    boxes.push({ x: p[0], y: (ya + yb) / 2, z: p[1], hx: ha, hy: (yb - ya) / 2, hz: hb, rot: R + ry, flags, mat, tag });
  };
  const hbox = (lx, lz, ya, yb, hx, hz, flags, mat) => { const p = P(lx, lz); boxes.push({ x: p[0], y: (ya + yb) / 2, z: p[1], hx, hy: (yb - ya) / 2, hz, rot, flags, mat }); };
  const wallTop = flat ? top + 0.55 : top;
  // exterior walls: full thickness, with the openings cut out
  const extHoles = (S) => {
    const hs = [];
    if (S.door) hs.push({ u0: S.door.u - S.door.w / 2, u1: S.door.u + S.door.w / 2, y0: y0 - 1, y1: S.door.g + DIM.doorH + 0.05, door: true });
    for (const W of windows) if (W.side === S.key) hs.push({ u0: W.u - W.ww / 2, u1: W.u + W.ww / 2, y0: W.ya, y1: W.yb });
    return hs;
  };
  for (const S of SIDES) {
    const span = S.key === 'front' || S.key === 'back' ? [-S.len / 2, S.len / 2] : [-S.len / 2 + T, S.len / 2 - T];
    for (const r of solidRects(span[0], span[1], y0, wallTop, extHoles(S))) {
      const um = (r.u0 + r.u1) / 2, a = S.o[0] + S.t[0] * um - S.n[0] * T / 2, b = S.o[1] + S.t[1] * um - S.n[1] * T / 2;
      const along = (r.u1 - r.u0) / 2;
      if (Math.abs(S.t[0]) > 0.5) cbox(a, b, r.y0, r.y1, along, T / 2, WALL, 'stone'); else cbox(a, b, r.y0, r.y1, T / 2, along, WALL, 'stone');
    }
    // closed shutters stop sight; thin wood lets rounds through
    for (const W of windows) if (W.side === S.key && W.kind === 'shut') {
      const a = S.o[0] + S.t[0] * W.u - S.n[0] * 0.08, b = S.o[1] + S.t[1] * W.u - S.n[1] * 0.08;
      if (Math.abs(S.t[0]) > 0.5) cbox(a, b, W.ya, W.yb, W.ww / 2, 0.03, THIN_WOOD, 'woodThin'); else cbox(a, b, W.ya, W.yb, 0.03, W.ww / 2, THIN_WOOD, 'woodThin');
    }
  }
  // interior walls with their doorways (and lintels over them)
  for (let f = 0; f < floors; f++) {
    const yTopF = (f + 1 < floors ? fy[f + 1] : top) - slab;
    for (const wl of walls) {
      const yb0 = f === 0 ? Math.min(gyC(wl.axis === 'b' ? wl.at : wl.from, wl.axis === 'b' ? wl.from : wl.at), gyC(wl.axis === 'b' ? wl.at : wl.to, wl.axis === 'b' ? wl.to : wl.at)) - 0.25 : fy[f];
      const gs = wl.gaps.slice().sort((p, q) => p.c - q.c);
      let from = wl.from;
      const seg = (s0, s1, ya, yb) => {
        if (s1 - s0 < 1e-3) return;
        const mid = (s0 + s1) / 2;
        if (wl.axis === 'b') cbox(wl.at, mid, ya, yb, ti / 2, (s1 - s0) / 2, WALL, 'stone');
        else cbox(mid, wl.at, ya, yb, (s1 - s0) / 2, ti / 2, WALL, 'stone');
      };
      for (const g of gs) {
        const gb = f === 0 ? (wl.axis === 'b' ? gyC(wl.at, g.c) : gyC(g.c, wl.at)) : fy[f];
        seg(from, g.c - g.w / 2, yb0, yTopF);
        seg(g.c - g.w / 2, g.c + g.w / 2, gb + DIM.doorH, yTopF);
        from = g.c + g.w / 2;
      }
      seg(from, wl.to, yb0, yTopF);
    }
  }
  // floor slabs (the stairwell cut out of each), ceiling / roof
  for (let f = 1; f < floors; f++) {
    const h = holes.find((q) => q.f === f), ya = fy[f] - slab, yb = fy[f];
    if (!h) { cbox(0, 0, ya, yb, ia, ib, WALL, 'stone'); continue; }
    cbox((-ia + h.a0) / 2, 0, ya, yb, (h.a0 + ia) / 2, ib, WALL, 'stone');
    cbox((h.a1 + ia) / 2, 0, ya, yb, (ia - h.a1) / 2, ib, WALL, 'stone');
    cbox((h.a0 + h.a1) / 2, (h.b1 + ib) / 2, ya, yb, (h.a1 - h.a0) / 2, (ib - h.b1) / 2, WALL, 'stone');
    cbox((h.a0 + h.a1) / 2, (-ib + h.b0) / 2, ya, yb, (h.a1 - h.a0) / 2, (h.b0 + ib) / 2, WALL, 'stone');
  }
  cbox(0, 0, top - slab, top, ia, ib, flat ? WALL : (F.SOLID | F.VISION | F.BULLET), 'stone');
  if (!flat) hbox(0, 0, top, top + rh * 0.6, w / 2, d * 0.3, F.SOLID | F.VISION | F.BULLET, 'metal');
  // stairs: one solid block per step
  for (const fl of flights) {
    for (let i = 0; i < fl.n; i++) {
      const bc = fl.bFoot + fl.dir * (i + 0.5) * DIM.run;
      cbox((fl.a0 + fl.a1) / 2, bc, fl.base, fl.yTop - (fl.n - 1 - i) * fl.sh, (fl.a1 - fl.a0) / 2, DIM.run / 2 + 0.01, WALL, 'wood');
    }
  }
  for (const rl of rails) {
    const ya = fy[rl.f], yb = fy[rl.f] + 1.0;
    if (rl.axis === 'b') cbox(rl.at, (rl.from + rl.to) / 2, ya, yb, 0.04, (rl.to - rl.from) / 2, RAIL, 'wood');
    else cbox((rl.from + rl.to) / 2, rl.at, ya, yb, (rl.to - rl.from) / 2, 0.04, RAIL, 'wood');
  }
  // balcony: slab you can walk out onto, railing that stops you falling off
  if (balcony) {
    const S = sideByKey.front, u = balcony.u, bw = balcony.w, dz = balcony.dz;
    cbox(S.o[0] + u, S.o[1] + dz / 2, balcony.y - 0.18, balcony.y, bw / 2, dz / 2, WALL, 'stone');
    cbox(S.o[0] + u, S.o[1] + dz - 0.04, balcony.y, balcony.y + 1.0, bw / 2, 0.04, RAIL, 'wood');
    for (const sg of [-1, 1]) cbox(S.o[0] + u + sg * (bw / 2 - 0.04), S.o[1] + dz / 2, balcony.y, balcony.y + 1.0, 0.04, dz / 2, RAIL, 'wood');
  }
  // furniture
  for (const it of furn) {
    if (it.nocol) continue;
    const spec = FURN_COL[it.kind];
    if (!spec) continue;
    const [flags, mat, hh2] = spec;
    const hgt = hh2 ?? it.h;
    if (it.kind === 'tableDown') { cbox(it.a, it.b, it.y, it.y + 0.82, it.w / 2, 0.08, flags, mat, it.ry); continue; }
    cbox(it.a, it.b, it.y, it.y + hgt, it.w / 2, it.d / 2, flags, mat, it.ry);
  }

  // ── world-space records: indoor volumes, lamps, doors, spots
  const indoor = [];
  for (let f = 0; f < floors; f++) indoor.push({ x, z, hx: w / 2 - T + 0.02, hz: d / 2 - T + 0.02, c, s, y0: f === 0 ? y0 + 0.2 : fy[f], y1: (f + 1 < floors ? fy[f + 1] : top) - slab, f });
  const toW = (a, b) => Pc(a, b);
  const outN = (S) => [S.n[0] * cR + S.n[1] * sR, -S.n[0] * sR + S.n[1] * cR];   // canonical normal → world
  const yawOf = (vx, vz) => Math.atan2(-vx, -vz);
  const spots = {
    loot: loot.map((list, f) => list.map((q) => { const p = toW(q.a, q.b); return { x: p[0], z: p[1], y: (f === 0 ? gyC(q.a, q.b) : fy[f]) + q.top, f, room: q.room, kind: q.kind }; })),
    posts: posts.map((list, f) => list.map((q) => {
      const p = toW(q.a, q.b), n = [q.face[0] * cR + q.face[1] * sR, -q.face[0] * sR + q.face[1] * cR];
      return { x: p[0], z: p[1], y: fy[f], face: yawOf(n[0], n[1]), f, bagged: !!q.bagged, radio: !!q.radio, room: q.room, side: q.side };
    })),
    stands: stands.map((q) => { const p = toW(q.a, q.b); return { x: p[0], z: p[1], room: q.room }; }),
  };
  {
    const Sf = sideByKey.front, nf = outN(Sf);
    const pIn = toW(ah, ib - 1.2), pOut = toW(ah, B / 2 + 1.6);
    spots.front = { x: pOut[0], z: pOut[1] }; spots.hallFront = { x: pIn[0], z: pIn[1] };
    const pBackIn = toW(ah, -ib + 1.2); spots.hallBack = { x: pBackIn[0], z: pBackIn[1] };
    if (backKey) {
      const S = sideByKey[backKey], n = outN(S), dr = doors.find((q) => q.ext && q.side === backKey);
      const pa = dr.axis === 'a' ? [dr.c, S.o[1]] : [S.o[0], dr.c];
      const po = toW(pa[0], pa[1]);
      spots.back = { x: po[0] + n[0] * 1.6, z: po[1] + n[1] * 1.6 };
    }
    void nf;
  }

  return {
    x, z, w, d, rot, c, s, P, R, cR, sR, A, B, Pc, aligned, floors, fh, fy, gMax, top, y0, flat, rh, wallTop,
    ia, ib, ah, hh, hallL, hallR, walls, rooms, roomsF, flights, holes, rails, windows, balcony, doors, furn, lamps,
    boxes, indoor, spots, SIDES, sideByKey, front, backKey, ti, T, slab, gyC,
  };
}

/** Collider per furniture kind: [flags, material, height override]. */
const FURN_COL = {
  table: [THIN_WOOD, 'woodThin'], tableDown: [THIN_WOOD, 'woodThin'], cabinet: [THIN_WOOD, 'woodThin'], shelf: [THIN_WOOD, 'woodThin'],
  wardrobe: [THIN_WOOD, 'woodThin'], wardrobeDown: [THIN_WOOD, 'woodThin'], bed: [SOFT, 'dirt'], cot: [SOFT, 'dirt'], sofa: [SOFT, 'dirt'],
  stove: [WALL, 'metal'], crate: [WALL, 'wood'], barrel: [WALL, 'metal'], sandbags: [WALL, 'dirt'],
};
