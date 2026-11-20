/**
 * dev/pose.js — in-game capture and check helpers for ?debug=1.
 * In the console: await import('/dev/pose.js'); await __start(act); __pose({ weapon: 'akm', ads: 1 })
 * Pauses the loop and renders one frame of the requested pose (hip / ADS / reload / fire / suppressor / NV).
 *
 * Soldier movement soak: __locoTest(act, seconds, combat) runs the simulation
 * headless and reports, per soldier, the longest time he was "moving" without
 * getting anywhere, how far he went, top speed, and every frame a soldier
 * stood on a blocked nav cell (other than a goal authored inside one).
 */
window.__locoTest = (act = 1, secs = 120, combat = true) => {
  const gm = g(), { G, ai, god, ghost, errors } = gm;
  const sim = (s) => gm.sim(s), tp = (x, z) => gm.tp(x, z);
  gm.quickStart('Test', 'normal', act, false); god(true); ghost(!combat);
  const p = G.player;
  sim(20);
  const e0 = G.enemies.find((e) => e.alive && e.patrol.length) || G.enemies[0];
  if (combat) { tp(e0.x + 12, e0.z + 4); for (const e of G.enemies) if (e.alive) ai.stim(e, 'spotted', p.x, p.z); }
  const S = new Map(); let offs = 0, maxSpd = 0, rigMs = 0, rigN = 0;
  const N = secs * 6;
  for (let k = 0; k < N; k++) {
    for (const e of G.enemies) { let s = S.get(e); if (!s) S.set(e, (s = { still: 0, max: 0, moved: 0 })); s.px = e.x; s.pz = e.z; }
    sim(1 / 6);
    if (combat && k === Math.floor(N / 2)) tp(e0.x - 15, e0.z - 10);
    for (const e of G.enemies) {
      const s = S.get(e); if (!s || !e.alive) continue;
      const d = Math.hypot(e.x - s.px, e.z - s.pz); s.moved += d;
      if (!e.fixed && !ai.canStand(e.x, e.z) && !e.goalBlocked) offs++;
      maxSpd = Math.max(maxSpd, e.loco.spd);
      if (e.moving && d < 0.02) { s.still += 1 / 6; s.max = Math.max(s.max, s.still); } else s.still = 0;
    }
  }
  // cost of one rig update, averaged over every living soldier
  for (let r = 0; r < 20; r++) for (const e of G.enemies) if (e.alive) { const t0 = performance.now(); e.rig.update(1 / 60); rigMs += performance.now() - t0; rigN++; }
  const st = {}; for (const e of G.enemies) if (e.alive) st[e.state] = (st[e.state] || 0) + 1;
  const arr = [...S.values()];
  return { act, n: G.enemies.length, alive: G.enemies.filter((e) => e.alive).length, st, offs, maxSpd: +maxSpd.toFixed(2),
    maxStill: arr.map((s) => s.max.toFixed(1)).join(' '), moved: arr.map((s) => s.moved.toFixed(0)).join(' '), rigUs: +(rigMs / Math.max(1, rigN) * 1000).toFixed(1), errors: errors.slice(0, 5) };
};
const g = () => window.__game;
window.__start = async (act = 1) => {
  while (!g() || !g().G.renderer) await new Promise((r) => setTimeout(r, 100));
  g().quickStart('Test', 'normal', act, true); g().god(true); g().ghost(true);
  document.getElementById('ui').style.visibility = 'hidden';
  return g().state();
};
window.__pose = (o = {}) => {
  const { G, R, weapons: W } = g(); const p = G.player;
  G.paused = true;
  if (o.weapon) {
    if (!Object.values(W.slots).some((s) => s && s.id === o.weapon)) { if (W.slots.p1 && W.slots.p2) W.slots.p2 = null; W.give(o.weapon); }
    W.cur = Object.keys(W.slots).find((k) => W.slots[k] && W.slots[k].id === o.weapon); W._clearActions();
  }
  const w = W.inst();
  if (o.sup !== undefined) w.sup = o.sup ? 1 : null;
  if (o.mag !== undefined) w.mag = o.mag;
  W.ads = o.ads ?? 0; W.kick = o.kick ?? 0;
  W.reloading = o.reload !== undefined ? { t: o.reload * w.def.reload.empty, dur: w.def.reload.empty, empty: !!o.empty } : null;
  W.supAnim = o.supAnim !== undefined ? { t: o.supAnim, attach: true, done: true } : null;
  W.melee = o.melee !== undefined ? { t: o.melee, hit: true } : null;
  W.lagX = W.lagY = 0; W.sprintK = o.sprint ? 1 : 0; W.lowerK = 0; p.bob = 0;
  if (o.nv !== undefined) R.post.nv = o.nv ? 1 : 0;
  if (o.zoom !== undefined) W.zoomI = o.zoom;
  if (o.pitch !== undefined) p.pitch = o.pitch;
  // weapons.update sets fovTarget / scoped from ads; run the parts of it that are pure state
  W.scoped = !!w.def.scope && W.ads > 0.92;
  const base = G.settings.fov, target = w.def.scope ? w.def.zoomFovs[W.zoomI] : w.def.adsFov;
  p.fovTarget = base + (target - base) * W.ads * W.ads; p.fov = p.fovTarget;
  const kick = W.kick;
  W.flashT = o.flash ? 0.04 : 0; W.frame(0, 0, 0); W.kick = kick;
  if (o.flash) R.vmFlashKick(1);
  p.applyCamera(0.016, W.swayX, W.swayY);
  if (o.sprint) { /* frame() damps sprintK from p.sprinting; force the pose */ }
  R.render(G.realTime);
  const i = R.info();
  return { weapon: w.id, ads: W.ads, scoped: W.scoped, calls: i.calls, tris: i.tris, env: +G.vmScene.environmentIntensity.toFixed(2), errors: g().errors.slice() };
};
