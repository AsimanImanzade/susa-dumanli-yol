/**
 * Act 1 — The Forest Approach. Night, heavy fog, a wooded valley below the
 * city. Teaches crouching, the suppressed pistol, takedowns, hiding bodies,
 * distractions and radio check-ins on the way to the foot of the cliff.
 * The player walks north (towards −Z).
 */
import { fbm, smoothstep, makeRng, dist2D } from '../ctx.js';

const pathX = (z) => Math.sin(z * 0.045) * 16 + Math.sin(z * 0.11) * 4;
const CAMP = { x: pathX(-8) + 11, z: -8, r: 9 };
const POST = { x: pathX(-98) + 2, z: -98, r: 14 };
const FLATS = [CAMP, POST, { x: pathX(-119), z: -120, r: 7 }];

function height(x, z) {
  let flat = 0;
  for (const f of FLATS) flat = Math.max(flat, smoothstep(f.r + 9, f.r, dist2D(x, z, f.x, f.z)));
  const rough = fbm(x * 0.035 + 7, z * 0.035, 4) * 5 - 1.5;
  const valley = smoothstep(30, 58, Math.abs(x - pathX(z) * 0.4)) * 17;      // the valley walls
  return 2 + rough * (1 - flat) + valley * (1 - flat * 0.6);
}

export function build(L) {
  const rng = makeRng(20201104);
  L.envName = 'forest';
  L.terrain({
    bounds: { minX: -60, maxX: 60, minZ: -130, maxZ: 130 }, height, tex: 'forest', step: 2,
    surface: (x, z) => Math.abs(x - pathX(z)) < 2.2 ? 'dirt' : 'grass',
    tint: (x, z) => Math.abs(x - pathX(z)) < 2.4 ? 0xc4b79c : 0x9aa388,
  });

  // the cliff that closes the valley to the north
  L.box(0, -131, 124, 60, 9, 'rock', { y: -4, tint: 0xb4b4ac });
  L.box(-34, -126.5, 30, 22, 5, 'rock', { y: -2, rot: 0.12, tint: 0xa8a8a0 });
  L.box(36, -126.5, 34, 26, 5, 'rock', { y: -2, rot: -0.1, tint: 0xa8a8a0 });

  // forest
  const clear = (x, z, m) => Math.abs(x - pathX(z)) > m && !FLATS.some((f) => dist2D(x, z, f.x, f.z) < f.r + 1.5) && dist2D(x, z, pathX(118), 118) > 5;
  for (let i = 0; i < 520; i++) {
    const x = rng.range(-58, 58), z = rng.range(-124, 128);
    if (clear(x, z, 3.4)) L.tree(x, z, rng.range(0.8, 1.5), rng() < 0.3 ? 1 : 0);
  }
  for (let i = 0; i < 46; i++) { const x = rng.range(-50, 50), z = rng.range(-120, 124); if (clear(x, z, 4.5)) L.rock(x, z, rng.range(0.7, 1.8)); }
  for (let z = 122; z > -112; z -= 8) {
    for (const side of [-1, 1]) if (rng() < 0.75) { const x = pathX(z) + side * rng.range(4.2, 8); if (clear(x, z, 3.2)) L.bush(x, z + rng.range(-3, 3), rng.range(1.4, 2.3)); }
  }

  // ── start
  L.spawn = { x: pathX(118), z: 118, yaw: 0 };
  L.trigger(0, 119, 0, { line: true, radio: 'r_start' });
  L.trigger(0, 106, 0, { line: true, radio: 'r_crouch' });
  L.pickup('stone', pathX(108) + 1.5, 108, { amount: 2 });

  // ── a lone sentry with his back to the trail: the takedown lesson
  L.trigger(0, 90, 0, { line: true, radio: 'r_sentry' });
  L.enemy({ x: pathX(74) + 0.8, z: 74, face: 0.15, sector: 1 });
  L.bush(pathX(74) + 5, 76.5, 2.2); L.bush(pathX(70) - 5, 70, 2);
  L.trigger(0, 71, 0, { line: true, radio: 'r_body' });
  L.checkpoint('a1_1', 0, 62, 0, 2);

  // ── two men with torches walking the trail
  L.trigger(0, 58, 0, { line: true, radio: 'r_stone' });
  L.enemy({ x: pathX(48), z: 48, torch: true, sector: 1, patrol: [[pathX(48), 48, 2], [pathX(30), 30, 0], [pathX(12), 12, 3], [pathX(30), 30, 0]] });
  L.enemy({ x: pathX(44) + 1.6, z: 45, torch: true, sector: 1, patrol: [[pathX(45) + 1.6, 45, 2], [pathX(27) + 1.6, 27, 0], [pathX(9) + 1.6, 9, 3], [pathX(27) + 1.6, 27, 0]] });
  L.rock(pathX(30) - 6, 31, 2.2); L.bush(pathX(22) + 6, 22, 2.4);

  // ── campfire post with a radio operator
  L.trigger(0, 16, 0, { line: true, radio: 'r_radio' });
  const c = CAMP;
  L.campfire(c.x, c.z);
  L.tent(c.x + 5.5, c.z - 4.5, 0.5);
  L.crate(c.x - 4.5, c.z - 5, 1, 0.3); L.crate(c.x - 5.6, c.z - 4.2, 0.8, 0.9); L.barrel(c.x - 3.4, c.z - 5.8);
  L.bush(c.x - 8.5, c.z + 4, 2.3); L.bush(c.x + 3, c.z + 9.5, 2.1);
  L.enemy({ x: c.x - 1.9, z: c.z + 0.6, face: -1.3, sector: 1 });
  L.enemy({ x: c.x + 1.3, z: c.z + 1.8, face: 2.4, sector: 1 });
  L.enemy({ x: c.x - 6, z: c.z - 6, radio: true, sector: 1, patrol: [[c.x - 7, c.z - 7, 3], [c.x + 8, c.z - 7, 3], [c.x + 8, c.z + 7, 3], [c.x - 7, c.z + 7, 3]] });
  L.pickup('bandage', c.x + 4.2, c.z - 3, { amount: 2 });
  L.pickup('ammo', c.x - 4.4, c.z - 3.6);
  L.pickup('suppressor', c.x - 5.8, c.z - 2.8);
  L.checkpoint('a1_2', 0, -27, 0, 1);

  // ── a lookout on a rock, and a wanderer below him
  L.trigger(0, -30, 0, { line: true, radio: 'r_suppressor' });
  const lx = pathX(-52) - 11;
  const top = L.gy(lx, -52) + 2.4;
  L.box(lx, -52, 4.5, 2.4, 4.5, 'rock', { tint: 0xa8a8a0, rot: 0.3 });
  L.enemy({ x: lx, z: -52, y: top, type: 'sniper', fixed: true, face: Math.PI, sector: 1 });
  L.enemy({ x: pathX(-44) + 3, z: -44, sector: 1, patrol: [[pathX(-44) + 3, -44, 2.5], [pathX(-66) - 2, -66, 2.5]] });
  L.bush(pathX(-58) + 6, -58, 2.2); L.bush(pathX(-48) - 4.5, -47, 1.9);
  L.pickup('tknife', pathX(-60) + 2, -61, { amount: 1 });
  L.checkpoint('a1_3', 0, -74, 0, 3);

  // ── the outpost at the foot of the cliff
  const o = POST;
  L.sandbags(o.x - 6, o.z + 9, 6, 0.1); L.sandbags(o.x + 5, o.z + 9.5, 5, -0.15);
  L.tent(o.x - 7, o.z - 4, 1.2); L.tent(o.x + 8, o.z - 6, -0.3);
  L.crate(o.x + 2, o.z - 7, 1.1, 0.2); L.crate(o.x + 3.3, o.z - 7.2, 1, 0.6); L.crate(o.x + 2.6, o.z - 7.1, 0.8, 0.1, { y: L.gy(o.x + 2.6, o.z - 7.1) + 1.05 });
  L.barrel(o.x - 2, o.z - 8); L.barrel(o.x - 2.8, o.z - 7.4);
  L.lamp(o.x, o.z - 1, { h: 3.6, r: 12, i: 1 });
  L.bush(o.x - 12, o.z + 5, 2.4); L.bush(o.x + 13, o.z + 2, 2.4); L.bush(o.x + 11, o.z - 10, 2.2);
  L.enemy({ x: o.x - 9, z: o.z + 6, sector: 1, torch: true, patrol: [[o.x - 11, o.z + 7, 3], [o.x - 11, o.z - 9, 2], [o.x + 1, o.z - 11, 3], [o.x - 4, o.z + 3, 2]] });
  L.enemy({ x: o.x + 9, z: o.z + 5, sector: 1, patrol: [[o.x + 11, o.z + 6, 3], [o.x + 12, o.z - 9, 3], [o.x + 4, o.z - 2, 2]] });
  L.enemy({ x: o.x - 5.5, z: o.z - 2, type: 'officer', radio: true, face: 0.8, sector: 1 });
  L.pickup('weapon_svd', o.x + 2.2, o.z - 5.8);
  L.pickup('ammo', o.x + 4, o.z - 8.6, { amount: 2 });
  L.pickup('medkit', o.x - 7.5, o.z - 2.4);
  L.pickup('smoke', o.x + 7, o.z - 4.2);
  L.pickup('repair', o.x - 1.2, o.z - 6.8);
  L.pickup('svdsup', o.x + 1.2, o.z - 5.2);
  L.trigger(0, -106, 0, { line: true, radio: 'r_cliff' });

  // ── the climbing point
  L.exit = { x: pathX(-119), z: -121.5, r: 4.5, kind: 'climb' };
  L.lamp(pathX(-119) + 2, -123.5, { h: 1.0, r: 5, i: 0.5, post: false, color: 0xffb648 });
  L.sector(1, 'sec1', { minX: -60, maxX: 60, minZ: -130, maxZ: 130 });

  // ── the battery at the outpost (optional): two towed howitzers and a mortar pit firing south over
  // the forest, each crewed; a charge beside each silences it. A carrier is parked by the tents.
  const gun1 = { x: o.x - 9, z: o.z - 14, rot: Math.PI + 0.5 }, gun2 = { x: o.x + 4, z: o.z - 15, rot: Math.PI - 0.4 }, mort = { x: o.x + 10.5, z: o.z + 1.5, rot: Math.PI - 0.8 };
  L.gun(gun1.x, gun1.z, gun1.rot); L.gun(gun2.x, gun2.z, gun2.rot); L.mortar(mort.x, mort.z, mort.rot);
  L.apc(o.x - 12.5, o.z - 1, 0.1);
  L.enemy({ x: o.x - 8.2, z: o.z - 15.8, face: 2.2, sector: 1 });
  L.enemy({ x: o.x + 5.9, z: o.z - 15.5, face: -2.4, sector: 1 });
  L.enemy({ x: mort.x + 1.9, z: mort.z - 1.8, face: 2.6, sector: 1 });
  L.trigger(0, -62, 0, { line: true, radio: 'r_battery' });
  L.pickup('c4', o.x - 12.4, o.z - 12.2); L.pickup('c4', o.x + 2.6, o.z - 18.8); L.pickup('c4', mort.x + 2.6, mort.z - 0.5);
  // ── a stone hut off the west side of the outpost, west of the parked carrier (interiors.js): a door, a lit stove, a guard warming himself, loot
  const hut = L.townhouse(o.x - 20, o.z - 2, 6, 5, { floors: 1, door: 'e', back: false, wall: 'stone', tint: 0xd8d0c0, lit: 1 });
  const hs = hut.stand(0);
  L.enemy({ x: hs.x, z: hs.z, face: Math.PI / 2, sector: 1 });
  for (const [type, k] of [['ammo', 0], ['battery', 1]]) { const q = hut.loot(0, k); if (q) L.pickup(type, q.x, q.z, { y: q.y }); }
  // ── field fortifications (military.js): a trench line before the outpost, səngərs on the
  //    approach and by the camp, felt shelters and lean-tos in the clearings off the path
  const tr = L.trench([[17, -85.6], [20.5, -84.6], [24, -86], [27.5, -85], [31, -86.6]], Math.PI);
  L.sanger(21, -74, 1.86, { roof: true });
  L.sanger(14.5, -2, Math.PI);
  const al1 = L.alacig(0, -39, Math.PI / 2, { fire: true });
  const al2 = L.alacig(13.5, -18, 2.3, { lamp: true });
  const al3 = L.alacig(27, -51, 1.4, { fire: true });
  const lt1 = L.leanTo(-27, -57, -Math.PI / 2);
  L.windbreak(-24.5, -61.5, Math.PI * 0.85, 4.5);
  const lt2 = L.leanTo(14, -61, Math.PI / 2, { tarp: true });
  const tw = L.watchtower(26.5, -92.5, Math.PI);
  L.wire(17, -81.2, 24.3, -80.6); L.wire(37.5, -95, 37.5, -103);
  const dg = L.dugout(-4, -84, -Math.PI / 2);
  L.shellCases(5.5, -116, 0.3); L.ammoStack(31, -109.5, 0.4, 7);
  L.enemy({ x: tr.seats[1][0], z: tr.seats[1][1], face: Math.PI, sector: 1 });
  L.enemy({ x: tw.x, z: tw.z, y: tw.top, fixed: true, face: Math.PI, sector: 1 });          // the outpost guard, moved up the tower
  L.pickup('ammo', al1.inside[0][0], al1.inside[0][1], { amount: 2 }); L.pickup('bandage', al1.inside[1][0], al1.inside[1][1]);
  L.pickup('smoke', al2.inside[0][0], al2.inside[0][1]); L.pickup('medkit', al2.inside[2][0], al2.inside[2][1]);
  L.pickup('frag', al3.inside[0][0], al3.inside[0][1]); L.pickup('stone', al3.door[0], al3.door[1], { amount: 2 });
  L.pickup('battery', lt1.inside[0][0], lt1.inside[0][1]); L.pickup('repair', lt2.inside[1][0], lt2.inside[1][1]);
  L.pickup('ammo', dg.inside[0][0], dg.inside[0][1], { y: dg.tableY, amount: 2 }); L.pickup('frag', dg.inside[2][0], dg.inside[2][1]);
  L.objective = 'obj_a1'; L.objectiveOpt = 'obj_a1_opt';
}
