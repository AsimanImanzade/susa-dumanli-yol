/**
 * Act 4 — The Final Push. Dawn breaks through the fog over the central
 * square. Clear the defenders (two reinforcement waves join in), then raise
 * the flag. The mosque in the north-east is scenery only: it is solid, the
 * ground around it is excluded from navigation, and nothing spawns near it.
 */
import { vnoise } from '../ctx.js';

const height = (x, z) => 4.5 + (22 - z) * 0.012 + vnoise(x * 0.2, z * 0.2) * 0.1;

export function build(L) {
  L.envName = 'dawnStart';
  L.terrain({
    bounds: { minX: -64, maxX: 64, minZ: -74, maxZ: 64 }, height, tex: 'cobble', step: 3,
    surface: () => 'stone', tint: (x, z) => (Math.abs(x) < 28 && z < 22 && z > -34 ? 0xdcdcd4 : 0xc2c2ba),
  });
  const tints = [0xffffff, 0xe6dfd0, 0xd6d6d0, 0xf0e4cc];
  let hi = 0;
  const H = (x, z, w, d, o = {}) => L.house(x, z, w, d, { wall: hi % 2 ? 'plaster' : 'stone', tint: tints[hi++ % tints.length], lit: hi % 3 === 0, ...o });
  // enterable houses take the same place in the street (and in the run of wall finishes)
  const TH = (x, z, w, d, o = {}) => L.townhouse(x, z, w, d, { wall: hi % 2 ? 'plaster' : 'stone', tint: tints[hi++ % tints.length], ...o });

  // approach street from the south
  L.rampart(-64, 62, -5, 62); L.rampart(5, 62, 64, 62);
  L.spawn = { x: 0, z: 57, yaw: 0 };
  L.trigger(0, 56, 0, { line: true, radio: 'r_final' });
  const a4w = TH(-22, 42, 30, 28, { door: 'e', back: 'w', garrison: true }); const a4e = TH(22, 42, 30, 28, { door: 'w', back: 'e', low: true });
  H(-51, 42, 22, 28); H(51, 42, 22, 28);
  L.car(-2.4, 44, 0.2, 0x55584f); L.crate(3.6, 36, 1.1); L.sandbags(0, 27, 6, 0); L.bush(-5.6, 52, 1.6); L.bush(5.4, 30, 1.6);
  L.pickup('ammo', 4.8, 37.4, { amount: 2 }); L.pickup('medkit', -4.6, 50); L.pickup('frag', 4.4, 51);
  L.checkpoint('a4_0', 0, 30, 0, 2);

  // the square: buildings on three sides, the terrace and flag on the north
  const w1 = H(-46, 6, 30, 22, { roof: 'flat', ladder: 'e', ladderAt: -6 });
  H(-46, -20, 30, 24, { door: 'e' });
  const e1 = H(46, 8, 30, 20, { roof: 'flat', ladder: 'w', ladderAt: 5 });
  L.building(44, -16, 26, 20, { doors: [{ side: 'w', at: 0.3 }, { side: 's', at: -0.5 }], tint: 0xd2cabb });
  // administrative building behind the terrace
  const hall = H(0, -52, 40, 16, { floors: 3, roof: 'flat', wall: 'stone', tint: 0xe8e0cc, lit: true });
  H(-44, -52, 32, 16);
  // terrace with steps: the flag stands here
  const ty = height(0, -36);
  L.box(0, -37, 24, 1.2, 12, 'stone', { y: ty - 0.1, tint: 0xd8d2c2 });
  L.stairs(0, -30.9, 0, 8, 1.1, 2.2);
  L.flagpole(0, -37.5);
  L.box(-10.5, -32.2, 2.2, 1.0, 0.6, 'stone', { y: ty + 1.1, tint: 0xd8d2c2 }); L.box(10.5, -32.2, 2.2, 1.0, 0.6, 'stone', { y: ty + 1.1, tint: 0xd8d2c2 });
  // cover in the open
  L._batch('stone').cyl(0, height(0, -6) + 0.5, -6, 3, 3.2, 1.0, 0xc8c2b4, { seg: 16, uvScale: 2.6 });
  L.world.addBox({ x: 0, y: height(0, -6) + 0.5, z: -6, hx: 2.9, hy: 0.5, hz: 2.9, mat: 'stone' });
  L.sandbags(-12, 4, 5, 0.3); L.sandbags(13, 2, 5, -0.3); L.sandbags(-9, -20, 5, 0.1); L.sandbags(10, -22, 5, -0.1); L.sandbags(0, -26.5, 6, 0);
  L.car(-18, -8, 1.2, 0x4c4f4a); L.car(19, -12, -0.9, 0x5b5850); L.car(8, 14, 0.2, 0x505348);
  L.crate(-20, 12, 1.2); L.crate(-21.3, 11.5, 1, 0.5); L.crate(22, 14, 1.1, 0.3); L.barrel(-6, 16); L.barrel(16, -26);
  L.bush(-26, 20, 2); L.bush(26, 19, 2); L.bush(-27, -30, 2); L.bush(-29, -6, 1.8); L.bush(28, -2, 1.8);
  L.dumpster(-29.5, 16, Math.PI / 2); L.dumpster(29.6, -28, Math.PI / 2);
  L.lamp(-14, -4, { r: 11 }); L.lamp(14, 6, { r: 11 });
  L.pickup('ammo', -20.6, 13.4, { amount: 2 }); L.pickup('medkit', 22.8, 15.4); L.pickup('plate', 44, -12); L.pickup('ammo', 38, -20, { amount: 2 });
  L.pickup('smoke', w1.x + 6, w1.z, { y: w1.top }); L.pickup('ammo', e1.x - 6, e1.z, { y: e1.top }); L.pickup('bandage', 0, -22, { amount: 2 });

  // the mosque — scenery only
  L.mosque(44, -56, -0.25);

  L.sector(4, 'sec4', { minX: -64, maxX: 64, minZ: -74, maxZ: 64 });
  // defenders
  L.enemy({ x: -11, z: 5.4, sector: 4, face: 0 }); L.enemy({ x: 12.4, z: 3.4, sector: 4, face: 0.1 });
  L.enemy({ x: -8, z: -18.6, sector: 4, face: 0 }); L.enemy({ x: 9.6, z: -20.6, sector: 4, face: 0 });
  L.enemy({ x: 0.5, z: -25, type: 'officer', radio: true, sector: 4, face: 0 });
  L.enemy({ x: -4, z: 8, sector: 4, torch: true, patrol: [[-22, 18, 3], [22, 18, 3], [22, -24, 3], [-22, -24, 3]] });
  L.enemy({ x: 6, z: -14, sector: 4, patrol: [[6, -10, 4], [-8, -2, 4], [4, 6, 3]] });
  L.enemy({ x: w1.x + 8, z: w1.z, y: w1.top, type: 'sniper', fixed: true, face: -1.2, sector: 4 });
  L.enemy({ x: hall.x - 6, z: hall.z + 5, y: hall.top, type: 'sniper', fixed: true, face: Math.PI, sector: 4 });
  // wave 2 comes down the west lane, wave 3 from the east side street
  for (let i = 0; i < 5; i++) L.enemy({ x: -30 + (i % 2) * 1.6, z: -36 - i * 1.6, sector: 4, wave: 'w2' });
  for (let i = 0; i < 4; i++) L.enemy({ x: 30 - (i % 2) * 1.6, z: 24 + i * 1.6, sector: 4, wave: 'w3', type: i === 0 ? 'officer' : 'rifle' });
  L.waveRules = [{ wave: 'w2', alive: 5, dir: 'W' }, { wave: 'w3', alive: 3, dir: 'E', after: 'w2' }];

  // ── a tank holds the approach to the flag: a short beat along the foot of the terrace, reversing
  // back, turret scanning the square. Destroy it or slip past it; raising the flag stays the goal.
  L.tank({ sectors: [4], loop: false, reverse: true, yaw: -Math.PI / 2, scanYaw: Math.PI, route: [[-14, -28.8, 8], [14, -28.8, 8]] });
  L.trigger(0, 30, 0, { line: true, radio: 'r_tank4' });
  L.pickup('c4', -3.6, 47.8); L.pickup('c4', -27.2, 14.6);
  // ── enterable houses on the approach (interiors.js); appended so earlier pickups keep their order
  const atPost = (q, o) => q && L.enemy({ x: q.x, z: q.z, y: q.y, face: q.face, fixed: true, ...o });
  const stash = (type, q, amount = 1) => q && L.pickup(type, q.x, q.z, { y: q.y, amount });
  atPost(a4w.postToward(1, -10, 0), { sector: 4 }); atPost(a4e.postToward(1, 10, 0), { sector: 4 });   // upstairs, watching the square
  stash('plate', a4w.loot(1, 0)); stash('ammo', a4w.loot(0, 1), 2); stash('medkit', a4e.loot(1, 0)); stash('frag', a4e.loot(0, 2));
  // ── field fortifications (military.js): obstacles on the approach, two breastworks facing it,
  //    a command dugout under the west houses, a truck under a net and supply stacks;
  //    the flag terrace and the tank's lane in front of it stay clear
  L.logBarricade(4.2, 40.5, 0.05, 4); L.hedgehog(-5, 38.5, 0.4);
  const sg1 = L.sanger(14, -4, Math.PI), sg2 = L.sanger(-12, -13, Math.PI);
  const dg4 = L.dugout(-26, -14, -Math.PI / 2);
  L.truck(26.5, -20, 0, '6x6'); L.camoNet(26.5, -20, 0, 4.6, 8.6, 3.3, { urban: true, poles: 'corners' });
  L.ammoStack(-26, -2, Math.PI / 2, 8); L.jerrycans(-24.5, 1.5, 0.2, 4);
  L.enemy({ x: sg1.seats[0][0], z: sg1.seats[0][1], face: Math.PI, sector: 4 });
  L.enemy({ x: sg2.seats[1][0], z: sg2.seats[1][1], face: Math.PI, sector: 4 });
  L.pickup('ammo', dg4.inside[0][0], dg4.inside[0][1], { y: dg4.tableY, amount: 2 });
  L.objective = 'obj_a4';
  L.dawn = true;
}
