/**
 * vehicle-rules.js — the pure rules behind the tank and the artillery
 * (no Three.js, no game state: unit-tested under Node, used by vehicles.js).
 *
 * Tank-local frame: origin on the ground under the hull centre, x to the
 * right, y up, forward = −z (the same convention as every other object in
 * the game: a yaw of `a` faces the world direction (−sin a, −cos a)).
 */
import { VEHICLES, STEALTH } from './config.js';
import { detectionRate } from './stealth.js';

const PI = Math.PI;
const wrap = (a) => { a = (a + PI) % (2 * PI); if (a < 0) a += 2 * PI; return a - PI; };

/** World point → tank-local x/z (the inverse of the yaw rotation used by meshes and colliders). */
export function toLocal(px, pz, tx, tz, yaw, out) {
  const dx = px - tx, dz = pz - tz, c = Math.cos(yaw), s = Math.sin(yaw);
  out.x = dx * c - dz * s; out.z = dx * s + dz * c;
  return out;
}
/** Tank-local x/z → world. */
export function toWorld(lx, lz, tx, tz, yaw, out) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out.x = tx + lx * c + lz * s; out.z = tz - lx * s + lz * c;
  return out;
}

// ───────────────────────── C4 on the tank ─────────────────────────
/**
 * Which part of the tank a charge at tank-local (lx, ly, lz) sits on:
 *   'rear'    engine deck (behind the turret, on top), rear plate, fuel drums
 *   'turret'  on the turret
 *   'side'    tracks, skirts, fenders
 *   'front'   glacis, nose, front fenders
 */
export function chargeZone(lx, ly, lz, C = VEHICLES.charge, T = VEHICLES.tank) {
  if (lz >= C.rearZ) return 'rear';
  if (lz >= C.deckZ && ly >= C.deckY && Math.hypot(lx, lz - T.turretZ) > T.turretR - 0.05) return 'rear';
  if (ly >= C.turretY && Math.hypot(lx, lz - T.turretZ) <= T.turretR + 0.15) return 'turret';
  if (Math.abs(lx) >= T.hw - 0.4 && ly < C.deckY) return 'side';
  return lz < -1.2 ? 'front' : 'side';
}
/** Only a charge on the rear kills the tank; anywhere else it breaks a track. */
export function chargeEffect(zone) { return zone === 'rear' ? 'destroy' : 'immobilize'; }
/** Which HUD prompt fits the spot the player is aiming at. */
export function chargePrompt(zone, ly, C = VEHICLES.charge) {
  if (zone === 'rear') return ly >= C.deckY ? 'p_c4deck' : 'p_c4rear';
  return 'p_c4track';
}

// ───────────────────────── crew sight ─────────────────────────
/**
 * Can the crew see a point at tank-local (lx, lz) with the turret turned
 * `turretRel` from the hull? Returns −1 in a blind spot (directly behind, or
 * the dead ground close beside and behind the hull), otherwise how far off
 * the nearest sight axis the point is, as a share of that arc (0 = dead
 * centre, 1 = the edge). Sight axes: the driver's forward arc and the
 * gunner's arc around the turret direction.
 */
export function crewSight(lx, lz, turretRel, T = VEHICLES.tank) {
  if (Math.abs(lx) < T.hw + T.nearSide && lz > -T.hlF && lz < T.hlR + T.nearRear) return -1;
  const a = Math.atan2(-lx, -lz);                     // 0 = straight ahead
  if (PI - Math.abs(a) < T.rearBlind) return -1;
  const off = Math.min(Math.abs(a) / T.hullArc, Math.abs(wrap(a - turretRel)) / T.turretArc);
  return off <= 1 ? off : -1;
}

/**
 * The crew's detection meter rate: the soldiers' model (stealth.detectionRate, so
 * distance, light, stance, movement, foliage, fog and difficulty all count), with
 * the off-axis share from crewSight mapped onto the soldiers' cone, and slower.
 * o: { dist, range, off, vis, diffMult, alert }
 */
export function crewDetectionRate(o, T = VEHICLES.tank) {
  if (o.off < 0) return 0;
  return detectionRate({ dist: o.dist, range: o.range, angle: o.off * STEALTH.fovEdge * 0.999, vis: o.vis, diffMult: o.diffMult, alert: o.alert }) * T.detectMult;
}

// ───────────────────────── engine noise ─────────────────────────
/** 0..1 loudness of the engine at distance d (louder and further when moving). */
export function engineLoudness(d, speedFrac, E = VEHICLES.tank.engine) {
  const r = E.idleRadius + (E.moveRadius - E.idleRadius) * Math.min(1, Math.max(0, speedFrac));
  return d >= r ? 0 : 1 - d / r;
}
/** A footstep is lost under the engine when the engine is the louder sound at the listener. */
export function stepMasked(stepLoud, engineLoud, margin = VEHICLES.tank.engine.maskMargin) {
  return stepLoud > 0 && engineLoud > stepLoud + margin;
}
/** An artillery report covers a shot for a moment, except for soldiers right beside the shooter. */
export function shotCovered(sinceReport, listenerToShot, A = VEHICLES.artillery) {
  return sinceReport >= 0 && sinceReport < A.coverTime && listenerToShot > A.coverNear;
}

// ───────────────────────── driving ─────────────────────────
/**
 * One step of the tank's steering toward (tx, tz). s = { x, z, yaw, speed, turn }
 * is updated in place; `stop` makes it brake to a halt where it is; `back`
 * reverses to the target with the hull facing away from it.
 * Big heading errors are taken out on the spot (neutral steer), small ones
 * while rolling, and it slows for the waypoint when `slowAt` is set.
 * Returns the distance left to the target.
 */
export function driveStep(s, tx, tz, dt, slowAt, stop, back = false, T = VEHICLES.tank) {
  const dx = tx - s.x, dz = tz - s.z, d = Math.hypot(dx, dz);
  const want = back ? Math.atan2(dx, dz) : Math.atan2(-dx, -dz), err = wrap(want - s.yaw);
  let vT = 0;
  if (!stop && d > 0.05) {
    const pivot = Math.abs(err) > T.pivotAt;
    vT = pivot ? 0 : T.speed * (1 - Math.abs(err) / T.pivotAt * 0.6) * (back ? 0.7 : 1);
    if (slowAt) vT = Math.min(vT, Math.sqrt(2 * T.decel * 0.7 * d) + 0.25);
    if (back) vT = -vT;
    const rate = pivot && Math.abs(s.speed) < 0.4 ? T.pivotRate : T.turnRate;
    const turn = Math.max(-rate * dt, Math.min(rate * dt, err));
    s.yaw = wrap(s.yaw + turn); s.turn = turn / dt;
  } else s.turn = 0;
  const speeding = Math.abs(vT) > Math.abs(s.speed) && vT * s.speed >= 0;
  const a = speeding ? T.accel : T.decel;
  s.speed += Math.max(-a * dt, Math.min(a * dt, vT - s.speed));
  s.x += -Math.sin(s.yaw) * s.speed * dt; s.z += -Math.cos(s.yaw) * s.speed * dt;
  return d;
}

/**
 * Round the corners of a route so the tank rolls through them instead of
 * stopping to pivot: every corner without a wait (and not an end of an open
 * route) becomes an arc of radius ≤ r, sampled every `step` radians. Points
 * keep their wait; each gets `slow` (brake for it: a wait, a reversal or a
 * corner too sharp to roll through). pts: [{ x, z, wait, round? }].
 */
export function roundRoute(pts, r, loop, step = 0.36, T = VEHICLES.tank) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], prev = loop ? pts[(i - 1 + n) % n] : pts[i - 1], next = loop ? pts[(i + 1) % n] : pts[i + 1];
    const rad = p.round ?? r;                                     // a point may ask for its own radius
    if (!prev || !next || p.wait > 0 || !(rad > 0)) { out.push({ x: p.x, z: p.z, wait: p.wait || 0 }); continue; }
    const la = Math.hypot(p.x - prev.x, p.z - prev.z), lb = Math.hypot(next.x - p.x, next.z - p.z);
    const ux = (p.x - prev.x) / la, uz = (p.z - prev.z) / la, vx = (next.x - p.x) / lb, vz = (next.z - p.z) / lb;
    const turn = Math.acos(Math.max(-1, Math.min(1, ux * vx + uz * vz)));
    if (turn < 0.25) { out.push({ x: p.x, z: p.z, wait: 0 }); continue; }
    const tl = Math.min(rad * Math.tan(turn / 2), la * 0.45, lb * 0.45), rr = tl / Math.tan(turn / 2);
    // inside of the turn: the part of v across u
    const d = vx * ux + vz * uz;
    let wx = vx - d * ux, wz = vz - d * uz; const wl = Math.hypot(wx, wz) || 1; wx /= wl; wz /= wl;
    const sx = p.x - ux * tl, sz = p.z - uz * tl, ex = p.x + vx * tl, ez = p.z + vz * tl;
    const cx = sx + wx * rr, cz = sz + wz * rr;
    const a0 = Math.atan2(sz - cz, sx - cx);
    let da = wrap(Math.atan2(ez - cz, ex - cx) - a0);
    const k = Math.max(1, Math.ceil(Math.abs(da) / step));
    for (let j = 0; j <= k; j++) { const a = a0 + da * j / k; out.push({ x: cx + Math.cos(a) * rr, z: cz + Math.sin(a) * rr, wait: 0 }); }
  }
  // which points to brake for
  const m = out.length;
  for (let i = 0; i < m; i++) {
    const p = out[i], prev = loop ? out[(i - 1 + m) % m] : out[i - 1], next = loop ? out[(i + 1) % m] : out[i + 1];
    let sharp = !prev || !next;
    if (!sharp) {
      const ax = p.x - prev.x, az = p.z - prev.z, bx = next.x - p.x, bz = next.z - p.z;
      const c = (ax * bx + az * bz) / ((Math.hypot(ax, az) * Math.hypot(bx, bz)) || 1);
      sharp = Math.acos(Math.max(-1, Math.min(1, c))) > T.pivotAt * 0.9;
    }
    p.slow = p.wait > 0 || sharp;
  }
  return out;
}

/** Index of the route point nearest (x, z). */
export function nearestPoint(route, x, z) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < route.length; i++) { const d = Math.hypot(route[i].x - x, route[i].z - z); if (d < bd) { bd = d; best = i; } }
  return best;
}
/** Next index on a looped route from `from` toward `to`, the shorter way round (or straight on for an open route). */
export function stepToward(n, from, to, loop) {
  if (from === to) return to;
  if (!loop) return from + (to > from ? 1 : -1);
  const fwd = (to - from + n) % n, back = (from - to + n) % n;
  return fwd <= back ? (from + 1) % n : (from - 1 + n) % n;
}
/**
 * Where a live tank restarts after a checkpoint load: the route point nearest
 * where it was, moved on along the route until it is at least `clear` metres
 * from the player.
 */
export function respawnIndex(route, x, z, px, pz, clear = VEHICLES.tank.respawnClear) {
  let i = nearestPoint(route, x, z);
  for (let k = 0; k < route.length; k++) {
    const j = (i + k) % route.length;
    if (Math.hypot(route[j].x - px, route[j].z - pz) >= clear) return j;
  }
  return i;
}

// ───────────────────────── weapons ─────────────────────────
/**
 * The main gun is kept for a player who has gone to ground: it fires when he
 * was seen recently (within `memory` s), has been out of sight behind hard
 * cover for at least `coverTime` s, the range is right and the gun is loaded.
 */
export function mainGunReady(hiddenFor, sinceSeen, range, cooldown, G = VEHICLES.tank.gun) {
  return cooldown <= 0 && hiddenFor >= G.coverTime && sinceSeen <= G.memory && range >= G.minRange && range <= G.maxRange;
}
/** Shell blast on the player: full in the open, cut by the cover he hides behind. */
export function shellDamage(d, los, diffMult, G = VEHICLES.tank.gun) {
  if (d >= G.radius) return 0;
  const k = 1 - d / G.radius;
  return G.damage * k * k * diffMult * (los ? 1 : G.coverMult);
}
/** Distance from point (px, pz) to the segment a→b (XZ). */
export function segDist(ax, az, bx, bz, px, pz) {
  const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
  let t = l2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + vx * t - px, az + vz * t - pz);
}
/** Nothing is ever fired at, through or into the mosque grounds. */
export function fireForbidden(sanct, ax, az, bx, bz, margin = 6) {
  if (!sanct) return false;
  return segDist(ax, az, bx, bz, sanct.x, sanct.z) < sanct.r + margin;
}

// ───────────────────────── contact ─────────────────────────
/**
 * Circle (radius r) at tank-local (lx, lz) against the hull footprint.
 * Returns the depth of the overlap (≤ 0 when clear) and fills out.nx/nz with
 * the local direction that pushes it out by the shortest way, out.face with
 * 'front' | 'rear' | 'side'.
 */
export function footprintOverlap(lx, lz, r, out, T = VEHICLES.tank) {
  const ex = T.hw + r - Math.abs(lx), ef = lz + T.hlF + r, er = T.hlR + r - lz;
  const depth = Math.min(ex, ef, er);
  if (depth === ex) { out.nx = lx < 0 ? -1 : 1; out.nz = 0; out.face = 'side'; }
  else if (depth === ef) { out.nx = 0; out.nz = -1; out.face = 'front'; }
  else { out.nx = 0; out.nz = 1; out.face = 'rear'; }
  out.depth = depth;
  return depth;
}

// ───────────────────────── track belt ─────────────────────────
/**
 * The closed belt around a convex chain of wheels, as seen from the side.
 * circles: [{ z, y, r }] in order around the loop, counter-clockwise with z
 * to the right and y up (bottom run toward +z, top run back toward −z).
 * Returns points [{ z, y, s }] along the belt centre line with arc length s,
 * arcs sampled every `step` radians.
 */
export function beltPath(circles, step = 0.3) {
  const n = circles.length, tan = [];
  // outer tangent from circle i to circle i+1 (belt on the outside, loop counter-clockwise)
  for (let i = 0; i < n; i++) {
    const a = circles[i], b = circles[(i + 1) % n];
    const dz = b.z - a.z, dy = b.y - a.y, L = Math.hypot(dz, dy);
    const th = Math.atan2(dy, dz), al = Math.acos(Math.max(-1, Math.min(1, (a.r - b.r) / L)));
    const ang = th - al;                                 // normal direction of the tangent line (pointing out)
    tan.push({ a0: ang, p: [a.z + Math.cos(ang) * a.r, a.y + Math.sin(ang) * a.r], q: [b.z + Math.cos(ang) * b.r, b.y + Math.sin(ang) * b.r] });
  }
  const pts = [];
  let s = 0, last = null;
  const push = (z, y) => {
    if (last) { const d = Math.hypot(z - last[0], y - last[1]); if (d < 1e-4) return; s += d; }
    pts.push({ z, y, s }); last = [z, y];
  };
  for (let i = 0; i < n; i++) {
    const c = circles[(i + 1) % n], tIn = tan[i], tOut = tan[(i + 1) % n];
    push(tIn.p[0], tIn.p[1]);
    // arc around circle i+1 from the incoming tangent's normal to the outgoing one (angle grows on a counter-clockwise loop)
    let a0 = tIn.a0, a1 = tOut.a0;
    while (a1 < a0) a1 += 2 * PI;
    const steps = Math.max(1, Math.ceil((a1 - a0) / step));
    for (let k = 0; k <= steps; k++) { const a = a0 + (a1 - a0) * (k / steps); push(c.z + Math.cos(a) * c.r, c.y + Math.sin(a) * c.r); }
  }
  // close the loop
  push(pts[0].z, pts[0].y);
  return pts;
}
