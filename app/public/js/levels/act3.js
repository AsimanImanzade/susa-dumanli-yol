/**
 * Act 3 — The Streets of Shusha. Before dawn, light rain. Three sectors to
 * clear, each with several ways through: rooftops (ladders to flat roofs) for
 * sniping, alleys with bushes and dumpsters for stealth, the main street for
 * a direct assault. The player moves north (towards −Z).
 */
import { vnoise } from '../ctx.js';
import { F } from '../physics.js';

const height = (x, z) => (50 - z) * 0.022 + vnoise(x * 0.2, z * 0.2) * 0.12;
const THIN = F.SOLID | F.VISION | F.BULLET | F.THIN;

export function build(L) {
  L.envName = 'streets';
  L.terrain({
    bounds: { minX: -52, maxX: 52, minZ: -152, maxZ: 64 }, height, tex: 'cobble', step: 3,
    surface: () => 'stone', tint: (x, z) => (Math.abs(x) < 5 ? 0xd8d8d0 : 0xc0c0b8),
  });
  const tints = [0xffffff, 0xe6dfd0, 0xd6d6d0, 0xf0e4cc, 0xcfc8bc];
  let hi = 0;
  const H = (x, z, w, d, o = {}) => L.house(x, z, w, d, { wall: hi % 3 === 1 ? 'plaster' : 'stone', tint: tints[hi++ % tints.length], lit: hi % 4 === 0, floors: 2, ...o });
  // enterable houses take the same place in the street (and in the run of wall finishes)
  const TH = (x, z, w, d, o = {}) => L.townhouse(x, z, w, d, { wall: hi % 3 === 1 ? 'plaster' : 'stone', tint: tints[hi++ % tints.length], floors: 2, ...o });

  // ── city edge: the breach in the fortress wall where the climb ended
  L.rampart(-52, 60, -4, 60); L.rampart(4, 60, 52, 60);
  L.box(-5.2, 60, 2.6, 9, 3, 'stone', { tint: 0xc9c2b0 }); L.box(5.2, 60, 2.6, 9, 3, 'stone', { tint: 0xc9c2b0 });
  L.spawn = { x: 0, z: 56, yaw: 0 };
  L.trigger(0, 55, 0, { line: true, radio: 'r_city' });
  L.crate(-7, 50, 1.1, 0.3); L.crate(8, 47, 1, 0.8); L.bush(-12, 52, 2); L.bush(14, 51, 2.2); L.bush(-30, 48, 2.4); L.bush(32, 46, 2.2);
  L.pickup('ammo', -8.2, 48.6); L.pickup('bandage', 9.4, 48.4);

  // ════════════════ SECTOR 1 — Lower Quarter (z 44 … −20) ════════════════
  L.sector(1, 'sec1', { minX: -52, maxX: 52, minZ: -20, maxZ: 64 });
  // row 1
  const a1 = H(-37.5, 28, 25, 24, { roof: 'flat', ladder: 'e', ladderAt: 6, door: 's' });
  const t1 = TH(-12.5, 28, 15, 24, { door: 'e', back: 'w', low: true });
  const t2 = TH(12.5, 28, 15, 24, { door: 'w', back: 'e', garrison: true });
  L.building(37.5, 28, 25, 24, { doors: [{ side: 'w', at: 0.5 }, { side: 's', at: -0.4 }, { side: 'n', at: 0.3 }], tint: 0xd8d0c0 });
  // row 2
  H(-37.5, -4.5, 25, 27, { door: 'n' });
  const a2 = H(-12.5, -4.5, 15, 27, { roof: 'flat', ladder: 'w', ladderAt: -8 });
  const t3 = TH(12.5, -4.5, 15, 27, { door: 'w', back: 'e' });
  H(37.5, -4.5, 25, 27, { door: 'n' });
  // street furniture: cover on the main street, hiding places in the alleys
  L.car(-2.6, 30, 0.1, 0x55584f); L.car(2.8, 2, -0.08, 0x4a4d52);
  L.sandbags(-2.5, 12.5, 4.5, 0.05); L.sandbags(3.2, 12.2, 3.5, -0.08);
  L.crate(-4, 20, 1); L.crate(4.2, -8, 1.1, 0.5); L.barrel(4.4, 21);
  L.dumpster(-22.4, 24, Math.PI / 2); L.dumpster(22.6, -2, Math.PI / 2);
  L.bush(-22.6, 34, 1.7); L.bush(-22.4, 2, 1.8); L.bush(22.5, 30, 1.8); L.bush(22.4, -14, 1.7); L.bush(-30, 12.5, 2); L.bush(31, 12.5, 2);
  L.fence(-25, 13.5, -20.2, 13.5, 1.9);                                            // thin wood: bullets pass
  L.lamp(-5.4, 12.5, { r: 12 }); L.lamp(5.4, -14, { r: 11 }); L.lamp(22.5, 12.5, { h: 3.5, r: 8, i: 0.8 });
  L.pickup('ammo', 36, 30); L.pickup('medkit', 44, 22); L.pickup('flash', 30, 34); L.pickup('battery', 40, 36);
  L.pickup('ammo', a1.x + 4, a1.z, { y: a1.top }); L.pickup('bandage', -22.5, -10);
  L.enemy({ x: 0, z: 34, sector: 1, torch: true, patrol: [[1.5, 36, 3], [1.5, 16, 1], [-1.5, -14, 3], [-1.5, 16, 1]] });
  L.enemy({ x: 1, z: -10, sector: 1, patrol: [[2.5, -16, 3], [2.5, 6, 2], [-2.5, 20, 3], [-2.5, 0, 1]] });
  L.enemy({ x: -22.5, z: 20, sector: 1, patrol: [[-22.5, 38, 3], [-22.5, 16, 2], [-12, 12.5, 2], [-22.5, -14, 3]] });
  L.enemy({ x: 22.5, z: 8, sector: 1, radio: true, patrol: [[22.5, 36, 3], [22.5, 12.5, 2], [22.5, -16, 3]] });
  L.enemy({ x: -1.2, z: 11, sector: 1, face: 0 }); L.enemy({ x: 2.6, z: 10.8, sector: 1, face: 0.3 });
  L.enemy({ x: a2.x + 2, z: a2.z + 6, y: a2.top, type: 'sniper', fixed: true, face: Math.PI * 0.9, sector: 1 });
  L.enemy({ x: 0.5, z: -17, type: 'officer', sector: 1, face: Math.PI });
  L.enemy({ x: 36, z: 26, sector: 1, patrol: [[32, 22, 4], [43, 32, 4]] });                 // inside the dark building
  L.reinforceFrom(1, -22.5, -18, 'N', 3);
  L.checkpoint('a3_0', 0, 44, 0, 3);
  L.wall(-25, -20, -20, -20, 4.5, 0.7, 'stone'); L.wall(20, -20, 25, -20, 4.5, 0.7, 'stone');
  L.barrier('g1', -5, -20, 5, -20);

  // ════════════════ SECTOR 2 — Market Square (z −20 … −88) ════════════════
  L.sector(2, 'sec2', { minX: -52, maxX: 52, minZ: -88, maxZ: -20 });
  L.checkpoint('a3_1', 0, -23, 0, 1);
  L.trigger(0, -25, 0, { line: true, radio: 'r_c4' });
  H(-37.5, -29, 25, 14); const t4 = TH(-12.5, -29, 15, 14, { door: 'e', floors: 3, garrison: true }); H(12.5, -29, 15, 14, { door: 'w' }); H(37.5, -29, 25, 14);
  // west side: a warehouse you can cut through, and a flat roof over the square
  L.building(-38, -48, 24, 16, { doors: [{ side: 'e', at: 0 }, { side: 'n', at: -0.5 }], tint: 0xd2cabb });
  const b1 = H(-38, -66.5, 24, 15, { roof: 'flat', ladder: 'n', ladderAt: 8 });
  // east side: the walled yard with the comms relay
  L.wall(27, -46, 50, -46, 3.2, 0.6, 'stone'); L.wall(27, -72, 50, -72, 3.2, 0.6, 'stone');
  L.wall(27, -46, 27, -55, 3.2, 0.6, 'stone'); L.wall(27, -61, 27, -72, 3.2, 0.6, 'stone');   // gate gap at z −55…−61
  L.relay(41, -59);
  L.crate(33, -50, 1.1); L.crate(34.2, -50.3, 1); L.barrel(45, -68); L.tent(43, -50, 0);
  L.lamp(30, -58, { h: 3.4, r: 9, i: 0.9 });
  H(38, -38.5, 22, 7, { floors: 1 });
  // north side
  const b2 = H(-27.5, -81, 45, 10, { roof: 'flat', ladder: 's', ladderAt: 14 });
  H(27.5, -81, 45, 10);
  // the square itself
  L._batch('stone').cyl(0, height(0, -56) + 0.45, -56, 2.4, 2.6, 0.9, 0xc8c2b4, { seg: 14, uvScale: 2.6 });
  L.world.addBox({ x: 0, y: height(0, -56) + 0.45, z: -56, hx: 2.3, hy: 0.45, hz: 2.3, mat: 'stone' });
  for (const [sx, sz, r] of [[-11, -46, 0.1], [-13, -62, -0.2], [10, -44, 0.3], [12, -66, 0], [-4, -68, 0.5]]) {       // market stalls: thin wood
    L.box(sx, sz, 3.4, 1.0, 1.6, 'wood', { rot: r, flags: THIN, mat: 'woodThin', tint: 0xb8a58a });
    L.box(sx, sz, 3.8, 0.08, 2.2, 'cloth', { rot: r, y: height(sx, sz) + 2.3, noCollide: true, tint: 0x9a6a5a });
    for (const k of [-1.7, 1.7]) L.box(sx + Math.cos(r) * k, sz - Math.sin(r) * k, 0.08, 2.3, 0.08, 'wood', { noCollide: true });
  }
  L.car(15, -55, 1.3, 0x5a5348); L.crate(-16, -54, 1.1, 0.2); L.crate(-17.2, -54.6, 0.9, 0.7); L.barrel(6, -40); L.sandbags(0, -72.5, 5, 0);
  L.dumpster(-23.2, -42, Math.PI / 2); L.dumpster(-23.2, -70, Math.PI / 2);
  L.bush(-18.5, -39.5, 1.8); L.bush(18.5, -39.5, 1.8); L.bush(-18.5, -73, 1.8); L.bush(19, -73.5, 1.9); L.bush(-23, -56, 1.6); L.bush(23, -76, 1.7);
  L.lamp(-8, -50, { r: 12 }); L.lamp(9, -62, { r: 12 });
  L.pickup('akmsup', -40, -50); L.pickup('ammo', -32, -44, { amount: 2 }); L.pickup('c4', 33.4, -51.6); L.pickup('medkit', b1.x, b1.z, { y: b1.top });
  L.pickup('frag', 14, -42.6); L.pickup('plate', -44, -46); L.pickup('repair', -16.4, -52.6);
  L.enemy({ x: -14, z: -42, sector: 2, torch: true, patrol: [[-16, -41, 3], [16, -41, 3], [16, -72, 3], [-16, -72, 3]] });
  L.enemy({ x: 14, z: -70, sector: 2, patrol: [[16, -72, 3], [-16, -72, 3], [-16, -41, 3], [16, -41, 3]] });
  L.enemy({ x: 3, z: -52, sector: 2, patrol: [[4, -50, 4], [-5, -60, 4], [4, -62, 3]] });
  L.enemy({ x: -10.5, z: -44.4, sector: 2, face: 2.6 }); L.enemy({ x: 11.5, z: -64.4, sector: 2, face: -0.6 });
  L.enemy({ x: b2.x + 10, z: b2.z + 2, y: b2.top, type: 'sniper', fixed: true, face: Math.PI, sector: 2 });
  L.enemy({ x: 38, z: -62, type: 'officer', radio: true, sector: 2, face: -1.5 });
  L.enemy({ x: 31, z: -58, sector: 2, face: -1.57 }); L.enemy({ x: 44, z: -54, sector: 2, patrol: [[45, -50, 3], [45, -68, 3], [34, -66, 2]] });
  L.enemy({ x: -23, z: -50, sector: 2, patrol: [[-23, -38, 3], [-23, -74, 3]] });
  L.reinforceFrom(2, 23, -84, 'N', 3); L.reinforceFrom(2, -23, -38, 'W', 3);
  L.wall(-5, -88, -50, -88, 4.5, 0.7, 'stone'); L.wall(5, -88, 50, -88, 4.5, 0.7, 'stone');
  L.barrier('g2', -5, -88, 5, -88);

  // ════════════════ SECTOR 3 — Fortress Road (z −88 … −150) ════════════════
  L.sector(3, 'sec3', { minX: -52, maxX: 52, minZ: -152, maxZ: -88 });
  L.checkpoint('a3_2', 0, -91, 0, 1);
  H(-38, -104, 24, 22); const c1 = H(-13, -104, 14, 22, { roof: 'flat', ladder: 'w', ladderAt: 6 }); const t5 = TH(13, -104, 14, 22, { door: 'w', back: 'e', garrison: true });
  L.building(38, -104, 24, 22, { doors: [{ side: 'w', at: -0.4 }, { side: 'n', at: 0.4 }], tint: 0xcfc6b6 });
  H(-38, -133, 24, 20, { door: 'e' }); H(-13, -133, 14, 20); const c2 = H(13, -133, 14, 20, { roof: 'flat', ladder: 'e', ladderAt: -4 }); H(38, -133, 24, 20);
  L.sandbags(-2.5, -100, 5, 0.08); L.sandbags(3, -108, 5, -0.06); L.sandbags(0, -126, 6, 0);
  L.car(-3.2, -114, 0.6, 0x4c4f4a); L.car(3.4, -131, -0.4, 0x5b5850); L.crate(4.6, -96, 1.1); L.crate(-4.6, -121, 1, 0.4); L.barrel(-4.8, -106);
  L.dumpster(-23, -110, Math.PI / 2); L.dumpster(23, -128, Math.PI / 2);
  L.bush(-23, -96, 1.7); L.bush(23, -98, 1.7); L.bush(-23, -138, 1.8); L.bush(23, -116, 1.7); L.bush(-30, -119, 2); L.bush(30, -119, 2);
  L.lamp(-5.5, -119, { r: 12 }); L.lamp(5.5, -140, { r: 11 });
  L.pickup('ammo', 36, -100, { amount: 2 }); L.pickup('medkit', 44, -108); L.pickup('smoke', 30, -98); L.pickup('frag', c2.x, c2.z, { y: c2.top });
  L.pickup('ammo', c1.x, c1.z + 4, { y: c1.top }); L.pickup('bandage', -23, -124, { amount: 2 }); L.pickup('tourniquet', 23, -106);
  L.pickup('svdsup', c1.x + 2.5, c1.z - 5.5, { y: c1.top });
  L.enemy({ x: -1.5, z: -98.5, sector: 3, face: 0 }); L.enemy({ x: 2, z: -98.6, sector: 3, face: 0.2 });
  L.enemy({ x: 2.5, z: -106.5, sector: 3, face: 0 });
  L.enemy({ x: 0, z: -124.5, sector: 3, face: 0 }); L.enemy({ x: -2, z: -124.4, type: 'officer', radio: true, sector: 3, face: 0.1 });
  L.enemy({ x: 0, z: -112, sector: 3, torch: true, patrol: [[2, -93, 3], [2, -118, 2], [-2, -142, 3], [-2, -118, 2]] });
  L.enemy({ x: -23, z: -119, sector: 3, patrol: [[-23, -92, 3], [-23, -119, 2], [-8, -119, 2], [-23, -144, 3]] });
  L.enemy({ x: 23, z: -119, sector: 3, patrol: [[23, -144, 3], [23, -119, 2], [8, -119, 2], [23, -92, 3]] });
  L.enemy({ x: c1.x, z: c1.z - 4, y: c1.top, type: 'sniper', fixed: true, face: 0, sector: 3 });
  L.enemy({ x: 38, z: -102, sector: 3, patrol: [[32, -98, 4], [44, -110, 4]] });
  L.reinforceFrom(3, 0, -146, 'N', 4);
  L.rampart(-52, -150, -5, -150); L.rampart(5, -150, 52, -150);
  L.exit = { x: 0, z: -147, r: 5, kind: 'next', locked: true };
  L.lamp(0, -146, { h: 1, r: 5, i: 0.5, post: false, color: 0xffb648 });

  // ── armour: a tank patrols the market square (optional objective). While it lives it
  // answers every alarm in the square; its engine covers footsteps, so it can be stalked.
  // A figure of eight round the stalls and the fountain, checked clear of every prop both ways
  // round (vehicles.checkRoute); it pauses in the street at the south gate and at two corners.
  L.tank({ sectors: [2], route: [[0, -27, 6], [0, -39.5], [-13.5, -39.5], [-19.8, -47.5, 3], [-20, -58], [-5.6, -58], [-5.6, -45], [0.5, -41],
    [3.6, -49.6], [20.3, -49.6], [20.3, -61, 4], [20.3, -71.6], [5, -71.8], [5, -52], [0.5, -41]] });
  L.trigger(0, -8, 0, { line: true, radio: 'r_tank' });
  L.pickup('c4', 21.4, -3.8); L.pickup('c4', -15.0, -52.6);
  // ── enterable houses (interiors.js): who holds them and what is in them; appended so earlier pickups keep their order
  const atPost = (q, o) => q && L.enemy({ x: q.x, z: q.z, y: q.y, face: q.face, fixed: true, ...o });
  const stash = (type, q, amount = 1) => q && L.pickup(type, q.x, q.z, { y: q.y, amount });
  atPost(t2.postToward(1, 0, 22), { sector: 1 });                                    // rifleman over the main street
  L.enemy({ x: t3.hallFront.x, z: t3.hallFront.z, sector: 1, patrol: [[t3.front.x, t3.front.z, 3], [t3.stand(0).x, t3.stand(0).z, 3], [t3.back.x, t3.back.z, 3], [t3.stand(3).x, t3.stand(3).z, 3]] });
  atPost(t4.postToward(2, 0, -56), { sector: 2, type: 'sniper' });                   // top floor over the square
  atPost(t5.radio(1) || t5.post(1, 0), { sector: 3, radio: true });                  // radio operator upstairs
  stash('ammo', t1.loot(0, 0)); stash('bandage', t1.loot(1, 1));
  stash('plate', t2.loot(1, 0)); stash('ammo', t2.loot(1, 2), 2);
  stash('medkit', t3.loot(1, 0)); stash('frag', t3.loot(0, 2));
  stash('suppressor', t4.loot(2, 0)); stash('ammo', t4.loot(1, 1), 2);
  stash('plate', t5.loot(1, 1)); stash('flash', t5.loot(0, 1));
  // ── field fortifications (military.js): a checkpoint at the lower-quarter crossroads, a supply
  //    dump in the walled yard, a net over the square's car (beside the tank lanes), and on the
  //    fortress road a machine-gun nest covering the street, hedgehogs and a vehicle park
  L.roadBarrier(2.5, 19.2, Math.PI, 3.6, { open: true });
  L.hedgehog(-3.9, 22.5, 0.3); L.hedgehog(3.9, 25, 1.1);
  L.concreteBlock(-6.6, 10.9, Math.PI / 2); L.concreteBlock(-6.6, 14.1, Math.PI / 2);
  L.truck(11.5, 11.4, -Math.PI / 2, '4x4');
  L.wire(8.2, 14.6, 15, 14.6);
  L.ammoStack(47, -55, Math.PI / 2, 9); L.generator(36, -70, 0, { lightAt: [1.6, 0.9] }); L.jerrycans(40.5, -70.6, 0, 5);
  L.camoNet(12.5, -53.8, 0, 5, 3, 2.4, { urban: true });
  const mg3 = L.mgNest(3.0, -144.2, Math.PI, { urban: true });
  L.hedgehog(4.2, -113.5, 0.5); L.hedgehog(-4.3, -123.5, 1.2);
  L.truck(38, -119, Math.PI / 2, '6x6'); L.camoNet(38, -119, 0, 8.6, 4.2, 3.3, { urban: true, poles: 'corners' });
  L.ammoStack(46.5, -117.2, 0, 8); L.ammoStack(46.5, -121, 0.1, 6); L.jerrycans(43.6, -121.8, 0.1, 4);
  L.enemy({ x: mg3.seat[0], z: mg3.seat[1], face: Math.PI, sector: 3 });
  L.enemy({ x: 44.5, z: -119, face: Math.PI / 2, sector: 3 });
  L.pickup('ammo', 45.2, -120.2); L.pickup('bandage', 39.2, -69.6);
  L.objective = 'obj_a3'; L.objectiveOpt = 'obj_a3_opt';
  L.gates = { 1: 'g1', 2: 'g2' };
}
