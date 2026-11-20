/**
 * locomotion.js — how a soldier's legs carry him along a nav path.
 *
 *   speed    builds up and bleeds off over human times (a walk start takes
 *            about half a second, a run start and a hard stop about a second)
 *   corners  rounded by following a "carrot" a speed-dependent distance ahead
 *            on the path; the chord to it must stay inside the nav corridor
 *            (centre line and both shoulders on free cells), so the rounding
 *            never cuts through a wall
 *   braking  before a corner (turning radius = v² / sideways grip) and before
 *            the goal, so he arrives without overshooting or orbiting
 *
 * Pure maths: no Three.js, no game context. ai.js decides where to go and how
 * fast at most; steer() moves the point and reports the velocity it used.
 * Yaw convention as everywhere in the game: facing −Z at yaw 0, so a heading h
 * points along (−sin h, −cos h).
 */

const PI = Math.PI, TAU = PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
export function wrapAngle(a) {
  while (a > PI) a -= TAU;
  while (a < -PI) a += TAU;
  return a;
}
/** Heading (yaw) of the direction (dx, dz). */
export const headingOf = (dx, dz) => Math.atan2(-dx, -dz);

/**
 * Corridor test for a smoothed chord a→b: samples every 0.35 m keep the
 * centre and both shoulders (±hw across the line) on free nav cells. The
 * start sample is skipped (he is already standing there).
 */
export function clearLine(nav, ax, az, bx, bz, hw) {
  const dx = bx - ax, dz = bz - az, d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-6) return true;
  const n = Math.max(1, Math.ceil(d / 0.35));
  const px = -dz / d * hw, pz = dx / d * hw;
  for (let i = 1; i <= n; i++) {
    const t = i / n, x = ax + dx * t, z = az + dz * t;
    if (!nav.isFree(x, z) || !nav.isFree(x + px, z + pz) || !nav.isFree(x - px, z - pz)) return false;
  }
  return true;
}

/**
 * Point `dist` metres further along the path from the mover's projection on
 * his current segment (segment start m.sx/m.sz → path[m.pi]). Writes out.x/z.
 */
export function alongPath(m, path, dist, out) {
  const n = path.length;
  if (m.pi >= n) { out.x = m.x; out.z = m.z; return out; }
  const w = path[m.pi], ex = w.x - m.sx, ez = w.z - m.sz, L2 = ex * ex + ez * ez;
  const t = L2 > 1e-8 ? clamp(((m.x - m.sx) * ex + (m.z - m.sz) * ez) / L2, 0, 1) : 1;
  let px = m.sx + ex * t, pz = m.sz + ez * t, rem = dist;
  for (let k = m.pi; k < n; k++) {
    const q = path[k], dx = q.x - px, dz = q.z - pz, d = Math.sqrt(dx * dx + dz * dz);
    if (d >= rem) { out.x = px + dx / d * rem; out.z = pz + dz / d * rem; return out; }
    rem -= d; px = q.x; pz = q.z;
  }
  out.x = px; out.z = pz;
  return out;
}

/**
 * Acceleration and braking for a state whose top speed is `vmax`: blends the
 * walk and run numbers of P (AI.loco) by where vmax sits between them.
 * Writes acc/dec (m/s²), kAcc/kDec (1/s) into lim.
 */
export function moveLimits(vmax, P, lim) {
  const r = clamp((vmax - P.walkRef) / (P.runRef - P.walkRef), 0, 1);
  lim.vmax = vmax;
  lim.acc = lerp(P.accWalk, P.accRun, r); lim.kAcc = lerp(P.kAccWalk, P.kAccRun, r);
  lim.dec = lerp(P.decWalk, P.decRun, r); lim.kDec = lerp(P.kDecWalk, P.kDecRun, r);
  lim.ff = lim.dec * P.brakePlan;        // a braking curve planned at this rate is followed, not lagged
  return lim;
}

/**
 * Speed cap for moving in direction `rel` (travel relative to facing, rad)
 * while the body keeps facing elsewhere: full ahead, `strafe` sideways,
 * `back` straight backwards (nobody back-pedals at a run).
 */
export function directionCap(rel, vmax, strafe, back) {
  const c = Math.cos(rel), side = Math.min(vmax, strafe);
  return c >= 0 ? lerp(side, vmax, c) : lerp(side, Math.min(vmax, back), -c);
}

/**
 * Integrate speed towards a target: rate-limited, easing in near the target
 * when speeding up; when slowing, the planned braking rate is fed forward so
 * the speed follows a braking curve instead of trailing it.
 */
export function approachSpeed(s, target, lim, dt) {
  const d = target - s;
  const rate = d > 0 ? Math.min(lim.acc, d * lim.kAcc) : Math.max(-lim.dec, d * lim.kDec - (lim.ff || 0));
  const ns = s + rate * dt;
  return d > 0 ? Math.min(ns, target) : Math.max(ns, target, 0);
}

const _c = { x: 0, z: 0 }, _q = { x: 0, z: 0 };

/**
 * One steering step along `path` (array of {x, z}).
 *   m    mover: { x, z, spd, hd (travel heading), sx, sz (segment start), pi (next waypoint),
 *               face (body yaw), faceFollows (the body turns to where he walks) }
 *   P    AI.loco tuning; lim: moveLimits() for this state's top speed
 *   nav  { isFree(x, z) }
 *   out  receives: vx, vz (velocity used), want (heading to the carrot),
 *        lookX/lookZ (a point further along the path, where his eyes go),
 *        done (path finished this step or before)
 * Returns true while still following the path.
 */
export function steer(m, path, P, lim, dt, nav, out) {
  const n = path.length;
  // ── reached / passed waypoints
  while (m.pi < n) {
    const w = path[m.pi], dx = w.x - m.x, dz = w.z - m.z, d = Math.sqrt(dx * dx + dz * dz);
    const ex = w.x - m.sx, ez = w.z - m.sz, L2 = ex * ex + ez * ez;
    const t = L2 > 1e-8 ? ((m.x - m.sx) * ex + (m.z - m.sz) * ez) / L2 : 1;
    if (m.pi === n - 1) {
      // the goal: inside the arrival radius, or just past it (never circle back round it)
      if (d < P.arriveR || (t >= 1 && d < P.arriveR * 3)) { m.pi = n; m.sx = w.x; m.sz = w.z; }
      break;
    }
    if (d < P.passR + 0.15 * m.spd || t >= 1) { m.sx = w.x; m.sz = w.z; m.pi++; continue; }
    break;
  }
  if (m.pi >= n) { coast(m, lim, dt, out); out.done = true; return false; }
  out.done = false;

  // ── carrot: a point ahead on the path that he can walk to in a straight line
  const look = P.look0 + P.lookK * m.spd;
  alongPath(m, path, look, _c);
  let tx = _c.x, tz = _c.z;
  if (m.direct) { tx = path[m.pi].x; tz = path[m.pi].z; }   // fallback after a stall: straight at the waypoint, as the old code did
  else if (!clearLine(nav, m.x, m.z, tx, tz, P.corridor)) {
    alongPath(m, path, look * 0.45, _c);
    if (clearLine(nav, m.x, m.z, _c.x, _c.z, P.corridor)) { tx = _c.x; tz = _c.z; }
    else {
      tx = path[m.pi].x; tz = path[m.pi].z;              // as before: straight at the waypoint …
      if (!clearLine(nav, m.x, m.z, tx, tz, 0)) {
        // … unless that crosses a blocked cell (he was shoved off the line): back onto the segment first
        if (clearLine(nav, m.x, m.z, alongPath(m, path, 0.3, _c).x, _c.z, 0)) { tx = _c.x; tz = _c.z; }
        else if (clearLine(nav, m.x, m.z, alongPath(m, path, 0, _c).x, _c.z, 0)) { tx = _c.x; tz = _c.z; }
        else if (clearLine(nav, m.x, m.z, m.sx, m.sz, 0)) { tx = m.sx; tz = m.sz; }
      }
    }
  }
  alongPath(m, path, look + P.lookEyes, _q);
  out.lookX = _q.x; out.lookZ = _q.z;
  const dxT = tx - m.x, dzT = tz - m.z;
  const want = dxT * dxT + dzT * dzT > 1e-8 ? headingOf(dxT, dzT) : m.hd;
  out.want = want;

  // ── how fast he may go here
  const vmax = lim.vmax, brake = lim.dec * P.brakePlan;
  const w = path[m.pi];
  const dCorner = Math.hypot(w.x - m.x, w.z - m.z);
  let rem = dCorner;
  for (let k = m.pi + 1; k < n; k++) rem += Math.hypot(path[k].x - path[k - 1].x, path[k].z - path[k - 1].z);
  let target = vmax;
  // arrive: a braking curve (constant deceleration) that reaches a creep at the arrival radius
  target = Math.min(target, Math.sqrt(P.creep * P.creep + 2 * brake * Math.max(0, rem - P.arriveR)));
  // next corner: the turning radius he gets from the carrot rounding is about
  // look·tan((π − turn)/2); the speed that radius allows is √(grip · r)
  if (m.pi < n - 1) {
    const b = path[m.pi + 1];
    const turn = Math.abs(wrapAngle(headingOf(b.x - w.x, b.z - w.z) - headingOf(w.x - m.sx, w.z - m.sz)));
    const lc = P.look0 + P.lookK * vmax * 0.75;
    const r = lc * Math.tan(Math.max(0, PI - turn) * 0.5);
    const vc = clamp(Math.sqrt(P.latAcc * r), P.cornerMin, vmax);
    target = Math.min(target, Math.sqrt(vc * vc + 2 * brake * Math.max(0, dCorner - lc * 0.5)));
  }
  // pointing the wrong way: slow down and turn rather than orbit
  if (m.spd > 0.2) target = Math.min(target, vmax * clamp((Math.cos(wrapAngle(want - m.hd)) - 0.1) / 0.7, 0.15, 1));
  // the body: either it turns to the path first, or it faces elsewhere (strafe / back-pedal caps)
  const rel = wrapAngle(want - m.face);
  if (m.faceFollows) target = Math.min(target, vmax * clamp(Math.cos(rel) / 0.7, 0.08, 1));
  else target = Math.min(target, directionCap(rel, vmax, P.strafeSpeed, P.backSpeed));

  // ── speed and heading
  m.spd = approachSpeed(m.spd, target, lim, dt);
  if (m.spd < 0.15) m.hd = want;                       // from a standstill he can set off any way
  else {
    const wmax = Math.min(P.turnCap, P.latAcc / m.spd), dh = wrapAngle(want - m.hd);
    const step = clamp(dh * P.kTurn * dt, -wmax * dt, wmax * dt);
    m.hd = wrapAngle(m.hd + (Math.abs(step) > Math.abs(dh) ? dh : step));
  }
  const vx = -Math.sin(m.hd) * m.spd, vz = -Math.cos(m.hd) * m.spd;
  m.x += vx * dt; m.z += vz * dt;
  out.vx = vx; out.vz = vz;
  return true;
}

/** No path: bleed the speed off along the current heading. */
export function coast(m, lim, dt, out) {
  m.spd = approachSpeed(m.spd, 0, lim, dt);
  if (m.spd < 0.02) m.spd = 0;
  const vx = -Math.sin(m.hd) * m.spd, vz = -Math.cos(m.hd) * m.spd;
  m.x += vx * dt; m.z += vz * dt;
  out.vx = vx; out.vz = vz; out.want = m.hd; out.lookX = m.x + vx; out.lookZ = m.z + vz;
  return m.spd > 0;
}

/** A per-soldier share of the top speed in [lo, hi], from his id (no RNG draw). */
export function paceFor(id, lo, hi) {
  let h = Math.imul((id | 0) + 0x9e37, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return lo + (hi - lo) * (((h ^ (h >>> 16)) >>> 0) / 4294967296);
}
