/**
 * Browser checks for the enterable houses, run against the live game:
 *   const c = await import('/dev/interiors-check.js'); c.walk(0); c.rays(0); c.nav(); c.patrols(60)
 * Each returns plain numbers so a run can be compared without screenshots.
 */
import { F } from '../js/physics.js';

const g = () => window.__game;
const face = (p, x, z) => { p.yaw = Math.atan2(-(x - p.x), -(z - p.z)); };

/** Walk the player to (x, z) with real input; returns the distance left. */
export function walkTo(x, z, max = 12, crouch = false) {
  const G = g().G, p = G.player, inp = g().input;
  inp.inject('forward', true);
  for (let n = 0; n < max * 60; n++) {
    face(p, x, z); g().game.step(1 / 60); inp.endStep();
    if (Math.hypot(x - p.x, z - p.z) < 0.25) break;
  }
  inp.inject('forward', false); g().game.step(1 / 60); inp.endStep();
  return +Math.hypot(x - p.x, z - p.z).toFixed(2);
}

/** In through the front door (opening it with F), up every flight and back down, out of the back. */
export function walk(i = 0) {
  const G = g().G, p = G.player, L = G.level, h = L.townhouses[i], pl = h.plan, log = {};
  g().tp(h.front.x, h.front.z); face(p, h.hallFront.x, h.hallFront.z); g().sim(0.1);
  const fd = L.doorSys.doors.find((d) => d.ext && Math.hypot(d.x - h.front.x, d.z - h.front.z) < 3);
  log.prompt = g().state().prompt; log.shutBlocks = !!fd.col;
  if (!fd.target) g().tap('interact');
  g().sim(1);
  log.opened = fd.target === 1 && !fd.col;
  log.hall = walkTo(h.hallFront.x, h.hallFront.z);
  log.indoor = L.isIndoor(p.x, p.y, p.z);
  log.flights = [];
  for (const fl of pl.flights) {
    const am = (fl.a0 + fl.a1) / 2, foot = pl.Pc(am, fl.bFoot - fl.dir * 0.7), top = pl.Pc(am, fl.bFoot + fl.dir * (fl.run + 0.7));
    const a = walkTo(foot[0], foot[1]), b = walkTo(top[0], top[1]);
    log.flights.push({ foot: a, top: b, y: +p.y.toFixed(2), want: +pl.fy[fl.f + 1].toFixed(2), indoor: L.isIndoor(p.x, p.y, p.z) });
  }
  // and down again
  for (const fl of [...pl.flights].reverse()) {
    const am = (fl.a0 + fl.a1) / 2, foot = pl.Pc(am, fl.bFoot - fl.dir * 0.7), top = pl.Pc(am, fl.bFoot + fl.dir * (fl.run + 0.5));
    const a = walkTo(top[0], top[1]), b = walkTo(foot[0], foot[1]);
    log.flights.push({ down: true, top: a, foot: b, y: +p.y.toFixed(2), want: +pl.fy[fl.f].toFixed(2) });
  }
  if (h.back) {
    // keep to the passage beside the stairs, then down the hall
    if (pl.flights.length) {
      const fl = pl.flights[0], pa = pl.ah - pl.hh + 0.6, w1 = pl.Pc(pa, fl.bFoot + 1.0), w2 = pl.Pc(pa, -pl.ib + 1.2);
      walkTo(w1[0], w1[1]); walkTo(w2[0], w2[1]);
    }
    log.hallBack = walkTo(h.hallBack.x, h.hallBack.z);
    log.yBack = +p.y.toFixed(2);
    const bd = L.doorSys.doors.find((d) => d.ext && Math.hypot(d.x - h.back.x, d.z - h.back.z) < 3);
    face(p, bd.x, bd.z); g().sim(0.05);
    if (!bd.target) { const pr = g().state().prompt; g().tap('interact'); g().sim(1); log.backPrompt = pr; }
    log.outBack = walkTo(h.back.x, h.back.z);
  }
  return log;
}

/** Sight and bullet rays: through a slab, a wall, a shut door; and through a window. */
export function rays(i = 0) {
  const G = g().G, L = G.level, w = L.world, h = L.townhouses[i], pl = h.plan, out = {};
  const c = pl.Pc(pl.ia * 0.5, pl.ib * 0.5);
  out.floorBlocksSight = !w.los(c[0], pl.fy[1] - 1.4, c[1], c[0] + 0.3, pl.fy[1] + 1.4, c[1] + 0.3);
  out.floorBlocksBullets = w.raycast(c[0], pl.fy[1] - 1.4, c[1], 0, 1, 0, 3, F.BULLET, {}, null);
  const sd = pl.sideByKey.left, mid = pl.Pc(sd.o[0] + 1.5, 0.3), outP = pl.Pc(sd.o[0] - 3, 0.3);
  out.wallBlocks = !w.los(mid[0], pl.fy[0] + 1.5, mid[1], outP[0], pl.fy[0] + 1.5, outP[1]);
  const win = pl.windows.find((W) => W.kind === 'open' && W.f === 1);
  if (win) {
    const S = pl.sideByKey[win.side], yy = (win.ya + win.yb) / 2;
    const a = pl.Pc(S.o[0] + S.t[0] * win.u - S.n[0] * 2, S.o[1] + S.t[1] * win.u - S.n[1] * 2), b = pl.Pc(S.o[0] + S.t[0] * win.u + S.n[0] * 6, S.o[1] + S.t[1] * win.u + S.n[1] * 6);
    out.windowSees = w.los(a[0], yy, a[1], b[0], yy, b[1]);
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    out.windowShoots = !w.raycast(a[0], yy, a[1], dx / len, 0, dz / len, len, F.BULLET, {}, null);
  }
  const dr = L.doorSys.doors.find((d) => d.col && L.townhouses[i].doors.includes(d));
  if (dr) {
    const nx = -dr.tz, nz = dr.tx, hit = {};
    out.shutDoorBlocksSight = !w.los(dr.x - nx, dr.y + 1.2, dr.z - nz, dr.x + nx, dr.y + 1.2, dr.z + nz);
    out.shutDoorBullet = w.raycast(dr.x - nx, dr.y + 1.2, dr.z - nz, nx, 0, nz, 2, F.BULLET, hit, null) ? { mat: hit.mat, thin: !!(hit.collider && hit.collider.flags & F.THIN) } : 'passes';
  }
  return out;
}

/** Nav paths from the street to every ground-floor room of every townhouse. */
export function nav() {
  const G = g().G, out = [];
  for (const h of G.level.townhouses) {
    const path = [], bad = [];
    for (const s of h.plan.spots.stands) if (!G.nav.findPath(h.front.x, h.front.z, s.x, s.z, path)) bad.push(s.room);
    out.push({ x: h.x, z: h.z, rooms: h.plan.spots.stands.length, unreachable: bad, back: h.back ? G.nav.findPath(h.front.x, h.front.z, h.back.x, h.back.z, path) : null });
  }
  return out;
}

/** Run the simulation; report patrolling soldiers that never reached their next waypoint. */
export function patrols(seconds = 90) {
  const G = g().G, track = new Map();
  for (const e of G.enemies) if (e.patrol.length > 1) track.set(e, { reached: 0, last: e.pIdx });
  for (let t = 0; t < seconds; t += 1) {
    g().sim(1);
    for (const [e, s] of track) if (e.pIdx !== s.last) { s.reached++; s.last = e.pIdx; }
  }
  return [...track].map(([e, s]) => ({ id: e.id, x: +e.x.toFixed(1), z: +e.z.toFixed(1), wp: s.reached, state: e.state })).filter((q) => q.wp < 2);
}
