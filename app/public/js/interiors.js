/**
 * interiors.js — enterable multi-storey houses: what you see of the plan that
 * interior-rules.js makes (walls with real openings, floors, stairs, rooms,
 * furniture, lamps, the roof) and the hinged doors at run time.
 *
 * Geometry goes into the level's existing batches (wall textures, plaster,
 * wood, roof, cloth, glow and the structure batches st_pwood / st_paint /
 * st_metal / st_glass), so a whole street of houses costs no extra draw calls.
 * The door leaves are one InstancedMesh for the level (one draw call), each
 * instance swung about its hinge.
 *
 * Doors: F opens and shuts (interact.js), a shut door is a thin-wood collider
 * (blocks walking and sight, rounds go through weakened, like fences), every
 * swing creaks (a 'door' noise; crouching is quieter), soldiers open doors on
 * their way and leave them open, and on Hard a patrolling soldier who sees a
 * door the player changed comes to look. The nav grid ignores door colliders,
 * so paths run through shut doors. Door state is saved with checkpoints.
 */
import * as THREE from 'three';
import { G, makeRng, dist2D, angDelta, yawTo } from './ctx.js';
import { Geo } from './models.js';
import { C, buildProp } from './structures.js';
import { TEX_SCALE, TEX, TEX_NORMAL, TEX_ORM, interiorTextures } from './textures.js';
import { worldMaterial } from './materials.js';
import { Emit, drawPiece, carpet } from './furnishings.js';
import { NOISE, STEALTH } from './config.js';
import { noise } from './noise.js';
import { audio } from './audio.js';
import { ai } from './ai.js';
import { STIM, S as AIS } from './ai-fsm.js';
import { planTownhouse, DIM, DOOR, stepDoor, doorBlocks, doorNoise, encodeDoors, decodeDoors, doorSuspicious, solidRects, THIN_WOOD } from './interior-rules.js';

export const INTERIORS_VERSION = 1;
const PI = Math.PI;
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const FRAME_COLS = [0xe9e5dc, 0xe9e5dc, 0xd9d2c2, 0xa9bfb2, 0x93a9bd, 0x7a5c44];
const SHUT_COLS = [0x5f7d6a, 0x5a7288, 0x6b5440, 0x7f8f84, 0x4f6b5a, 0x8a6a4a];
const DOOR_COLS = [0x5c4433, 0x6b4d36, 0x4e5a52, 0x5a5e66, 0x7a4a32, 0x3f4a44, 0x8a8478, 0x6a6458];
const ROOM_COLS = [0xd9d2c0, 0xc9d2c4, 0xc4ccd4, 0xd8c8a8, 0xd6cfc6, 0xbfc8be];
const WOOD_COLS = [0x8a6a4c, 0x7a5a3e, 0x9a7a58, 0x6a4e38, 0xa48a6a];
const BAG_COLS = [0xc2b48e, 0xb4a47c, 0xa89a74, 0xbcae88, 0x9c9070];
const CLOTH_COLS = [0x8a4a3a, 0x5a6a7a, 0x7a6a4a, 0x6a5a6a, 0x9a8a6a, 0x4e5e4a, 0xa06a4a];
const KIN = 0.66;          // interior surfaces get less bounce light than the street

// ───────────────────────────── emitter ─────────────────────────────
const _eu = new THREE.Euler(), _rm = new THREE.Matrix4();
// box faces: normal, corner signs, then which local axes give u, v. bits: 1 +a, 2 −a, 4 +y, 8 −y, 16 +b, 32 −b
const FACES = [
  [1, 0, 0, [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], 2, 1],
  [-1, 0, 0, [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], 2, 1],
  [0, 1, 0, [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], 0, 2],
  [0, -1, 0, [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], 0, 2],
  [0, 0, 1, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], 0, 1],
  [0, 0, -1, [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], 0, 1],
];
/** A yaw frame: local (a, y, b) → world, P(a, b) = [x + a·cos + b·sin, z − a·sin + b·cos] like the kit. */
class Frame {
  constructor(x, z, R) { this.x = x; this.z = z; this.c = Math.cos(R); this.s = Math.sin(R); }
  W(a, b) { return [this.x + a * this.c + b * this.s, this.z - a * this.s + b * this.c]; }
  _v(g, a, y, b, na, ny, nb, col, k, u, v) {
    g.p.push(this.x + a * this.c + b * this.s, y, this.z - a * this.s + b * this.c);
    g.n.push(na * this.c + nb * this.s, ny, -na * this.s + nb * this.c);
    g.c.push(col[0] * k, col[1] * k, col[2] * k); g.t.push(u, v);
    return g.count++;
  }
  /** Box centred at local (a, y, b), size (sa, sy, sb). o: { ry, rx, rz, skip, us, k, kb } */
  box(g, a, y, b, sa, sy, sb, col, o = {}) {
    const h = [sa / 2, sy / 2, sb / 2], us = o.us || 1, k = o.k ?? 1, kb = o.kb ?? 1, skip = o.skip || 0;
    let e = null;
    if (o.ry || o.rx || o.rz) { _rm.makeRotationFromEuler(_eu.set(o.rx || 0, o.ry || 0, o.rz || 0, 'YXZ')); e = _rm.elements; }
    const off = [a, y, b];
    for (let f = 0; f < 6; f++) {
      if (skip & (1 << f)) continue;
      const [n0, n1, n2, cs, ua, va] = FACES[f];
      let na = n0, ny = n1, nb = n2;
      if (e) { na = e[0] * n0 + e[4] * n1 + e[8] * n2; ny = e[1] * n0 + e[5] * n1 + e[9] * n2; nb = e[2] * n0 + e[6] * n1 + e[10] * n2; }
      const base = g.count;
      for (let q = 0; q < 4; q++) {
        const l = cs[q];
        let px = l[0] * h[0], py = l[1] * h[1], pz = l[2] * h[2];
        const u = (l[ua] * h[ua] + off[ua]) / us, v = (l[va] * h[va] + off[va]) / us;
        if (e) { const X = e[0] * px + e[4] * py + e[8] * pz, Y = e[1] * px + e[5] * py + e[9] * pz, Z = e[2] * px + e[6] * py + e[10] * pz; px = X; py = Y; pz = Z; }
        this._v(g, a + px, y + py, b + pz, na, ny, nb, col, l[1] < 0 ? k * kb : k, u, v);
      }
      g.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  /** Flat polygon (3 or 4 local points [a,y,b], counter-clockwise from the front). */
  poly(g, pts, col, k = 1, us = 1, uvAxis = 'auto') {
    const [p0, p1, p2] = pts;
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let na = uy * vz - uz * vy, ny = uz * vx - ux * vz, nb = ux * vy - uy * vx;
    const l = Math.hypot(na, ny, nb) || 1; na /= l; ny /= l; nb /= l;
    const base = g.count;
    for (const p of pts) {
      let u, v;
      if (uvAxis === 'xz' || (uvAxis === 'auto' && Math.abs(ny) > 0.7)) { u = p[0]; v = p[2]; }
      else if (Math.abs(na) > Math.abs(nb)) { u = p[2]; v = p[1]; } else { u = p[0]; v = p[1]; }
      this._v(g, p[0], p[1], p[2], na, ny, nb, col, k, u / us, v / us);
    }
    g.i.push(base, base + 1, base + 2);
    if (pts.length === 4) g.i.push(base, base + 2, base + 3);
  }
}
/** An item's own frame inside a canonical frame: local (x along its width, y up, z out from the wall). */
function itemFrame(fr, it, rx = 0, rz = 0) {
  _rm.makeRotationFromEuler(_eu.set(rx, it.ry, rz, 'YXZ'));
  const e = _rm.elements.slice();
  return {
    box(g, lx, ly, lz, sx, sy, sz, col, o = {}) {
      const X = e[0] * lx + e[4] * ly + e[8] * lz, Y = e[1] * lx + e[5] * ly + e[9] * lz, Z = e[2] * lx + e[6] * ly + e[10] * lz;
      fr.box(g, it.a + X, it.y + Y, it.b + Z, sx, sy, sz, col, { ...o, ry: it.ry + (o.ry || 0), rx: rx + (o.rx || 0), rz: rz + (o.rz || 0) });
    },
  };
}

function SB(L, name) {
  const m = L._stb || (L._stb = new Map());
  let g = m.get(name);
  if (!g) { g = new Geo({ uv: true }); m.set(name, g); }
  return g;
}
/** One of a house's own interior batches (finalizeInteriors makes them a group per house, culled with distance). */
function IB(H, name) {
  let g = H.map.get(name);
  if (!g) { g = new Geo({ uv: true }); H.map.set(name, g); }
  return g;
}

// ───────────────────────────── interior batches ─────────────────────────────
/** Furnishings are hidden beyond this distance (you cannot make them out from further off anyway). */
const IN_CULL = 60;
/**
 * Build every house's interior batches into meshes (called from Level.finalize): wallpaper, floorboards,
 * carpets and pictures, veneer, enamel and upholstery, one group per house. They cast no shadows.
 */
export function finalizeInteriors(L) {
  if (!L._inHouses || !L._inHouses.length) return;
  // floors and wallpaper are the rooms' surfaces (the walls' own room faces are not drawn): one batch each
  // for the level, never hidden, and wallpapered walls keep the sun out
  const T = interiorTextures(), t0 = performance.now();
  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, ...o });
  const cloth = TEX.cloth && !TEX.cloth.userData.file;
  const M = {
    in_floor: std({ map: T.floor.map, normalMap: T.floor.normal, roughnessMap: T.floor.rough, normalScale: new THREE.Vector2(0.8, 0.8), envMapIntensity: 0.5 }),
    in_paper: std({ map: T.paper.map, normalMap: T.paper.normal, roughnessMap: T.paper.rough, normalScale: new THREE.Vector2(0.6, 0.6), envMapIntensity: 0.3 }),
    in_carpet: std({ map: T.carpet, roughness: 1, envMapIntensity: 0.2 }),
    in_veneer: std({ map: T.veneer.map, normalMap: T.veneer.normal, roughnessMap: T.veneer.rough, normalScale: new THREE.Vector2(0.5, 0.5), envMapIntensity: 0.7 }),
    in_enamel: std({ roughness: 0.34, envMapIntensity: 0.8 }),
    // upholstery keeps the cloth weave's relief but not its khaki colour: the pieces carry their own colours
    in_fabric: std({ normalMap: cloth ? TEX_NORMAL.cloth : null, roughnessMap: cloth ? TEX_ORM.cloth : null, side: THREE.DoubleSide, envMapIntensity: 0.3 }),
  };
  L._inMats = M;
  L._inGroups = [];
  if (L._inShell) for (const [name, g] of L._inShell.map) {
    if (!g.count) continue;
    const mesh = new THREE.Mesh(g.build(), M[name]);
    mesh.castShadow = name === 'in_paper'; mesh.receiveShadow = true; mesh.name = name;
    L.group.add(mesh);
  }
  // the furnishings: a group per house, no shadows, hidden with distance
  for (const H of L._inHouses) {
    const grp = new THREE.Group();
    grp.name = 'interior';
    for (const [name, g] of H.map) {
      if (!g.count) continue;
      const mesh = new THREE.Mesh(g.build(), M[name]);
      mesh.castShadow = false; mesh.receiveShadow = true; mesh.name = name;
      grp.add(mesh);
    }
    grp.userData = { x: H.x, z: H.z, r: H.r };
    L.group.add(grp);
    L._inGroups.push(grp);
  }
  // triangles per kind of piece (and 'rooms' for the finishes, 'windows' for radiators and curtains), for tuning
  L.interiorStats = { texMs: T.ms, ms: performance.now() - t0, tris: L._inTris || {} };
  delete L._inTris;
}
/** Show only the interiors near the camera (every frame from DoorSystem.update). */
function cullInteriors(L) {
  const cam = G.camera, gs = L._inGroups;
  if (!cam || !gs) return;
  const cx = cam.position.x, cz = cam.position.z;
  for (const g of gs) { const u = g.userData, d = Math.hypot(cx - u.x, cz - u.z) - u.r; g.visible = d < IN_CULL; }
}

// ───────────────────────────── the house ─────────────────────────────
/**
 * Build an enterable townhouse into level L. Returns the kit's house() record
 * ({ x, z, w, d, rot, top, P }) plus { floors, fy, plan, loot(f,k), post(f,k), stand(k), front, back, hallFront, hallBack }.
 */
export function buildTownhouse(L, x, z, w, d, o = {}) {
  const t0 = performance.now();
  const pl = planTownhouse({ x, z, w, d, rot: o.rot || 0, floors: o.floors || 2, fh: o.h, gy: (px, pz) => L.gy(px, pz), door: o.door || 's', back: o.back,
    roof: o.roof, garrison: o.garrison, low: o.low, balcony: o.balcony, lit: o.lit, seed: o.seed });
  for (const b of pl.boxes) L.world.addBox(b);
  for (const v of pl.indoor) L.indoor.push(v);
  const seed = (Math.floor(x * 7.31 + 1000) * 73856093) ^ (Math.floor(z * 5.17 + 1000) * 19349663);
  const rng = makeRng(seed ^ 0x1ab);
  const tex = o.wall || 'stone', isStone = tex === 'stone';
  const H = { map: new Map(), x, z, r: Math.hypot(w, d) / 2 };
  (L._inHouses || (L._inHouses = [])).push(H);
  const K = {
    wall: L._batch(tex), stone: L._batch('stone'), plaster: L._batch('plaster'), wood: L._batch('wood'), roof: L._batch('roof'), conc: L._batch('concrete'),
    cloth: L._batch('cloth'), dark: L._batch('dark'), glow: L._batch('glow'),
    pwood: SB(L, 'st_pwood'), paint: SB(L, 'st_paint'), metal: SB(L, 'st_metal'), glass: SB(L, 'st_glass'), cglass: SB(L, 'st_cglass'),
    floor: IB(L._inShell || (L._inShell = { map: new Map() }), 'in_floor'), paper: IB(L._inShell, 'in_paper'), car: IB(H, 'in_carpet'), ven: IB(H, 'in_veneer'), ena: IB(H, 'in_enamel'), fab: IB(H, 'in_fabric'),
  };
  const st = {
    tex, isStone, us: TEX_SCALE[tex] || 2.6, wallCol: C(o.tint ?? 0xffffff), trim: C(isStone ? 0xe8e2d4 : 0xe4ddcf), plinth: C(isStone ? 0xa29c90 : 0xaaa496),
    frame: C(rng.pick(FRAME_COLS)), shut: C(rng.pick(SHUT_COLS)), quoins: isStone && rng.chance(0.7),
    rooms: [0, 1, 2].map(() => C(rng.pick(ROOM_COLS))), floorWood: C(rng.pick([0x8a7a66, 0x7a6a58, 0x9a8670])), seed: seed >>> 0,
  };
  const fr = new Frame(x, z, pl.R);
  drawShell(L, pl, K, st, fr, rng);
  drawInside(L, pl, K, st, fr, rng);
  drawRoof(L, pl, K, st, new Frame(x, z, pl.rot), rng, o);
  // lamps (light for the stealth model and the lamp pool), a glow where you can see the flame
  for (const lp of pl.lamps) {
    const p = pl.Pc(lp.a, lp.b);
    L.lamps.push({ x: p[0], y: lp.y, z: p[1], r: lp.r, i: lp.i, color: lp.color, flicker: !!lp.flicker });
  }
  // doors
  const ds = L.doorSys || (L.doorSys = new DoorSystem(L));
  const hseDoors = [];
  for (const pd of pl.doors) hseDoors.push(ds.add(doorRecord(L, pl, pd, rng)));
  // a ladder up the outside, as house() has
  const c = Math.cos(pl.rot), s = Math.sin(pl.rot);
  const P = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
  if (o.ladder) {
    const m = { n: [0, -d / 2 - 0.25, PI], s: [0, d / 2 + 0.25, 0], w: [-w / 2 - 0.25, 0, -PI / 2], e: [w / 2 + 0.25, 0, PI / 2] }[o.ladder];
    const off = o.ladderAt ?? 0, p = m[0] === 0 ? P(off, m[1]) : P(m[0], off);
    L.ladder(p[0], p[1], pl.rot + m[2], pl.top - L.gy(p[0], p[1]) + 0.1);
  }
  L._inTime = (L._inTime || 0) + performance.now() - t0;
  const sp = pl.spots, pick = (list, k) => (list && list.length ? list[((k % list.length) + list.length) % list.length] : null);
  const rec = {
    x, z, w, d, rot: pl.rot, top: pl.top, P, floors: pl.floors, fy: pl.fy, plan: pl, doors: hseDoors,
    /** k-th loot spot on floor f: { x, y, z } (on a table where there is one) */
    loot: (f, k = 0) => pick(sp.loot[f], k),
    /** k-th sentry spot on floor f (at a window, behind sandbags where there are any): { x, y, z, face } */
    post: (f, k = 0) => pick(sp.posts[f], k),
    /** the window post on floor f whose view points most towards (tx, tz) */
    postToward: (f, tx, tz) => {
      let best = null, bd = -2;
      for (const q of sp.posts[f] || []) {
        if (q.radio) continue;
        const c = Math.cos(angDelta(q.face, yawTo(q.x, q.z, tx, tz))) + (q.bagged ? 0.15 : 0);
        if (c > bd) { bd = c; best = q; }
      }
      return best;
    },
    /** the radio operator's seat on floor f, if that floor has a radio room */
    radio: (f) => (sp.posts[f] || []).find((q) => q.radio) || null,
    /** a free point in the k-th ground-floor room, for patrol routes */
    stand: (k = 0) => pick(sp.stands, k),
    front: sp.front, back: sp.back, hallFront: sp.hallFront, hallBack: sp.hallBack,
  };
  (L.townhouses || (L.townhouses = [])).push(rec);
  return rec;
}

// ───────────────────────────── shell ─────────────────────────────
const faceBit = (na, nb) => (na > 0.5 ? 1 : na < -0.5 ? 2 : nb > 0.5 ? 16 : 32);
/** Box on side S: u ∈ [u0,u1] along the side, depth [d0,d1] in from the outer face, y ∈ [ya,yb]. */
function sideBox(fr, g, S, u0, u1, d0, d1, ya, yb, col, o = {}) {
  if (u1 - u0 < 1e-3 || d1 - d0 < 1e-3 || yb - ya < 1e-3) return;
  const um = (u0 + u1) / 2, dm = (d0 + d1) / 2;
  const a = S.o[0] + S.t[0] * um - S.n[0] * dm, b = S.o[1] + S.t[1] * um - S.n[1] * dm;
  const alongA = Math.abs(S.t[0]) > 0.5;
  fr.box(g, a, (ya + yb) / 2, b, alongA ? u1 - u0 : d1 - d0, yb - ya, alongA ? d1 - d0 : u1 - u0, col, o);
}

function drawShell(L, pl, K, st, fr, rng) {
  const { T, fy, y0, wallTop, top, floors, flat } = pl, Tout = DIM.Tout;
  for (const S of pl.SIDES) {
    const out = faceBit(S.n[0], S.n[1]), inn = faceBit(-S.n[0], -S.n[1]);
    const ends = S.key === 'front' || S.key === 'back';
    const holes = [];
    if (S.door) holes.push({ u0: S.door.u - S.door.w / 2, u1: S.door.u + S.door.w / 2, y0: y0 - 1, y1: S.door.g + DIM.doorH + 0.05 });
    const wins = pl.windows.filter((W) => W.side === S.key);
    for (const W of wins) holes.push({ u0: W.u - W.ww / 2, u1: W.u + W.ww / 2, y0: W.ya, y1: W.yb });
    // outer skin
    const oSpan = ends ? [-S.len / 2, S.len / 2] : [-S.len / 2 + Tout, S.len / 2 - Tout];
    for (const r of solidRects(oSpan[0], oSpan[1], y0, wallTop, holes)) sideBox(fr, K.wall, S, r.u0, r.u1, 0, Tout, r.y0, r.y1, st.wallCol, { skip: inn, us: st.us });
    // inner skin, one colour per floor; the parapet above a flat roof in the wall finish
    const iSpan = ends ? [-pl.ia, pl.ia] : [-S.len / 2 + Tout, S.len / 2 - Tout];
    for (let f = 0; f < floors; f++) {
      const ya = f === 0 ? y0 : fy[f], yb = f + 1 < floors ? fy[f + 1] : top;
      // (the face towards the room is the room's own finish, drawn in drawInside)
      for (const r of solidRects(iSpan[0], iSpan[1], ya, yb, holes)) sideBox(fr, K.plaster, S, r.u0, r.u1, Tout, T, r.y0, r.y1, st.rooms[f % 3], { skip: out | inn, us: 3.2, k: KIN, kb: 0.8 });
    }
    if (flat) for (const r of solidRects(iSpan[0], iSpan[1], top, wallTop, holes)) sideBox(fr, K.wall, S, r.u0, r.u1, Tout, T, r.y0, r.y1, mul(st.wallCol, 0.8), { skip: out | 8, us: st.us });
    // plinth, proud of the wall, broken by the door
    const pTop = pl.gMax + 0.5;
    const pHoles = S.door ? [{ u0: S.door.u - S.door.w / 2, u1: S.door.u + S.door.w / 2, y0: y0 - 1, y1: pTop + 1 }] : [];
    for (const W of wins) if (W.ya < pTop + 0.05) pHoles.push({ u0: W.u - W.ww / 2, u1: W.u + W.ww / 2, y0: W.ya, y1: pTop + 1 });
    for (const r of solidRects(-S.len / 2 - 0.04, S.len / 2 + 0.04, y0, pTop, pHoles)) sideBox(fr, K.stone, S, r.u0, r.u1, -0.04, 0, r.y0, r.y1, st.plinth, { skip: inn | 8, us: 2.6, kb: 0.75 });
    // string courses between floors, cornice at the top
    for (let f = 1; f < floors; f++) sideBox(fr, isS(st) ? K.stone : K.plaster, S, -S.len / 2 - 0.045, S.len / 2 + 0.045, -0.045, 0, fy[f] - 0.24, fy[f] - 0.08, st.trim, { skip: inn, us: 2.6 });
    sideBox(fr, isS(st) ? K.stone : K.plaster, S, -S.len / 2 - 0.1, S.len / 2 + 0.1, -0.1, 0, top - 0.32, top - 0.06, st.trim, { skip: inn, us: 2.6, kb: 0.8 });
    if (flat) sideBox(fr, K.conc, S, -S.len / 2 - 0.03, S.len / 2 + 0.03, -0.03, T + 0.03, wallTop, wallTop + 0.07, C(0x9a9890), { us: 3 });
    // windows and the door, dressed
    for (const W of wins) dressWindow(fr, K, st, pl, S, W, rng, out, inn);
    if (S.door) dressDoor(fr, K, st, pl, S, S.door, out, inn);
  }
  // quoins on stone houses
  if (st.quoins) {
    const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [sa, sb] of corners) {
      let alt = 0;
      for (let y = pl.gMax + 0.55; y + 0.4 < top - 0.34; y += 0.42) {
        const hh = 0.395, la = alt ? 0.28 : 0.46, lb = alt ? 0.46 : 0.28;
        fr.box(K.stone, sa * (pl.A / 2 - la / 2 + 0.0125), y + hh / 2, sb * (pl.B / 2 - lb / 2 + 0.0125), la + 0.025, hh, lb + 0.025, mul(st.trim, 0.94 + alt * 0.06), { skip: (sa > 0 ? 2 : 1) | (sb > 0 ? 32 : 16) | 8, us: 2.6 });
        alt ^= 1;
      }
    }
  }
  // balcony
  const bal = pl.balcony;
  if (bal) {
    const S = pl.sideByKey.front, u = bal.u, bw = bal.w, dz = bal.dz, fy0 = bal.y;
    const a = S.o[0] + u, b0 = S.o[1];
    fr.box(K.stone, a, fy0 - 0.09, b0 + dz / 2, bw, 0.18, dz, st.trim, { us: 2.6, kb: 0.7 });
    for (const sg of [-1, 1]) fr.box(K.stone, a + sg * (bw / 2 - 0.25), fy0 - 0.36, b0 + 0.25, 0.16, 0.36, 0.5, st.trim, { us: 2.6, k: 0.9 });
    const rail = st.frame;
    fr.box(K.pwood, a, fy0 + 0.96, b0 + dz - 0.04, bw, 0.07, 0.09, rail, { us: 0.9 });
    fr.box(K.pwood, a, fy0 + 0.12, b0 + dz - 0.04, bw, 0.05, 0.06, rail, { us: 0.9 });
    for (const sg of [-1, 1]) {
      fr.box(K.pwood, a + sg * (bw / 2 - 0.04), fy0 + 0.5, b0 + dz / 2, 0.07, 1.0, dz, rail, { us: 0.9, skip: 4 | 8 });
      fr.box(K.pwood, a + sg * (bw / 2 - 0.04), fy0 + 0.96, b0 + dz / 2, 0.08, 0.07, dz, rail, { us: 0.9 });
    }
    for (let xx = -bw / 2 + 0.16; xx < bw / 2 - 0.1; xx += 0.14) fr.box(K.pwood, a + xx, fy0 + 0.54, b0 + dz - 0.04, 0.035, 0.84, 0.035, rail, { skip: 4 | 8, us: 0.9 });
  }
}
const isS = (st) => st.isStone;

/** Frame, sill, head, shutters, shards or boards of one window. */
function dressWindow(fr, K, st, pl, S, W, rng, out, inn) {
  const { u, ww, ya, yb } = W, T = pl.T, u0 = u - ww / 2, u1 = u + ww / 2;
  const trimG = st.isStone ? K.stone : K.plaster, fw = 0.07, fd = T * 0.45;
  if (W.kind !== 'french') sideBox(fr, K.stone, S, u0 - 0.08, u1 + 0.08, -0.09, 0.04, ya - 0.075, ya, st.trim, { us: 2.6, kb: 0.6 });
  else sideBox(fr, K.stone, S, u0, u1, 0, T, ya - 0.03, ya, st.trim, { us: 2.6 });
  sideBox(fr, trimG, S, u0 - 0.13, u1 + 0.13, -0.024, 0, yb, yb + 0.2, st.trim, { skip: inn, us: 2.6 });
  if (st.isStone && rng.chance(0.6)) sideBox(fr, trimG, S, u - 0.085, u + 0.085, -0.048, 0, yb + 0.02, yb + 0.27, st.trim, { skip: inn, us: 2.6, k: 1.05 });
  // inner window board
  if (W.kind !== 'french') sideBox(fr, K.pwood, S, u0 - 0.06, u1 + 0.06, T - 0.04, T + 0.1, ya - 0.04, ya, mul(st.frame, 0.85), { us: 0.9 });
  // frame in the middle of the wall
  const fz0 = fd - 0.045, fz1 = fd + 0.045;
  sideBox(fr, K.pwood, S, u0, u0 + fw, fz0, fz1, ya, yb, st.frame, { us: 0.9 });
  sideBox(fr, K.pwood, S, u1 - fw, u1, fz0, fz1, ya, yb, st.frame, { us: 0.9 });
  sideBox(fr, K.pwood, S, u0 + fw, u1 - fw, fz0, fz1, yb - fw, yb, st.frame, { us: 0.9 });
  if (W.kind !== 'french' && W.kind !== 'low') sideBox(fr, K.pwood, S, u0 + fw, u1 - fw, fz0, fz1, ya, ya + fw, st.frame, { us: 0.9 });
  if (W.kind === 'shut') {
    // shutters closed in the opening (the collider is here too)
    for (const [p0, p1] of [[u0 + fw, u - 0.005], [u + 0.005, u1 - fw]]) {
      sideBox(fr, K.pwood, S, p0, p1, 0.06, 0.1, ya + fw, yb - fw, st.shut, { us: 0.9 });
      for (const fy2 of [0.2, 0.5, 0.8]) sideBox(fr, K.pwood, S, p0 + 0.03, p1 - 0.03, 0.045, 0.06, ya + (yb - ya) * fy2 - 0.035, ya + (yb - ya) * fy2 + 0.035, mul(st.shut, 0.9), { us: 0.9 });
    }
    return;
  }
  // glass: gone, a few shards left in the frame
  const ix0 = u0 + fw, ix1 = u1 - fw, iy0 = ya + fw, iy1 = yb - fw, gz = fd;
  const P3 = (uu, yy) => { const a = S.o[0] + S.t[0] * uu - S.n[0] * gz, b = S.o[1] + S.t[1] * uu - S.n[1] * gz; return [a, yy, b]; };
  const glassC = [0.07, 0.08, 0.092];
  const nSh = rng.int(0, 3);
  for (let k = 0; k < nSh; k++) {
    const corner = rng.int(0, 3), cu = corner & 1 ? ix1 : ix0, cy = corner & 2 ? iy1 : iy0, du = (corner & 1 ? -1 : 1) * rng.range(0.12, 0.35), dy = (corner & 2 ? -1 : 1) * rng.range(0.15, 0.5);
    const A = P3(cu, cy), B = P3(cu + du, cy), Cc = P3(cu, cy + dy);
    fr.poly(K.glass, [A, B, Cc], glassC, 1.3); fr.poly(K.glass, [A, Cc, B], glassC, 1.3);
  }
  if (W.kind === 'boarded') {
    const plank = C(rng.pick([0x9a8a72, 0x8a7a64, 0xa89880]));
    for (let k = 0; k < 2; k++) {
      const yy = ya + (yb - ya) * (k ? 0.7 : 0.3);
      sideBox(fr, K.wood, S, u0 - 0.12, u1 + 0.12, -0.035, -0.01, yy - 0.085, yy + 0.085, plank, { us: 1.8, rz: (rng() - 0.5) * 0.3 });
    }
  }
  // open shutters against the wall
  if ((W.kind === 'open' || W.kind === 'low') && rng.chance(0.6)) {
    const lw = ww / 2 + 0.01, broken = rng.chance(0.15);
    for (const sg of [-1, 1]) {
      if (broken && sg > 0) continue;
      const c0 = sg < 0 ? u0 - 0.03 - lw : u1 + 0.03, c1 = c0 + lw;
      sideBox(fr, K.pwood, S, c0, c1, -0.035, -0.005, ya, yb + 0.02, st.shut, { skip: inn, us: 0.9 });
      sideBox(fr, K.pwood, S, c0 + 0.03, c1 - 0.03, -0.05, -0.035, (ya + yb) / 2 - 0.03, (ya + yb) / 2 + 0.03, mul(st.shut, 0.9), { skip: inn, us: 0.9 });
    }
  }
  void out;
}

/** Outer door: frame, step, lintel. The leaf is a door instance. */
function dressDoor(fr, K, st, pl, S, D, out, inn) {
  const u0 = D.u - D.w / 2, u1 = D.u + D.w / 2, g = D.g, yt = g + DIM.doorH + 0.05, T = pl.T;
  const trimG = st.isStone ? K.stone : K.plaster;
  sideBox(fr, K.stone, S, u0 - 0.1, u1 + 0.1, -0.4, T, g - 0.25, g + 0.06, C(0xb8b2a6), { us: 2.6, kb: 0.7 });
  for (const uu of [u0 - 0.08, u1]) sideBox(fr, trimG, S, uu, uu + 0.08, -0.028, 0, g, yt + 0.02, st.trim, { skip: inn, us: 2.6 });
  sideBox(fr, trimG, S, u0 - 0.2, u1 + 0.2, -0.04, 0, yt, yt + 0.24, st.trim, { skip: inn, us: 2.6 });
  sideBox(fr, trimG, S, u0 - 0.27, u1 + 0.27, -0.1, 0, yt + 0.24, yt + 0.3, st.trim, { us: 2.6, k: 1.05 });
  const fz0 = T - 0.16, fz1 = T - 0.02, fw = 0.075;
  sideBox(fr, K.pwood, S, u0, u0 + fw, fz0, fz1, g, yt, st.frame, { us: 0.9 });
  sideBox(fr, K.pwood, S, u1 - fw, u1, fz0, fz1, g, yt, st.frame, { us: 0.9 });
  sideBox(fr, K.pwood, S, u0, u1, fz0, fz1, yt - fw, yt, st.frame, { us: 0.9 });
  void out;
}

// ───────────────────────────── inside ─────────────────────────────
const RY_OF_WALL = [PI / 2, -PI / 2, 0, PI];
const CEIL = C(0xeeebe2);           // whitewashed ceilings
const fall = (d, r) => (d >= r ? 0 : (1 - d / r) * (1 - d / r));
const WARM = [1.07, 1.0, 0.88];
const CURTAINS = [0x7a2a26, 0x6a6a3a, 0xa8883a, 0x2e5a5a, 0xd8c8a0, 0xa86a6a, 0x6a4a30, 0x8a9aa8];
const SKIRT = [0x4a3a2c, 0x5a3e2a, 0x3e3430, 0x6a5a48];
const FLOOR_PAINT = [0x9a4a36, 0x8a4a3a, 0x7a4632, 0xa0583e];
const FLOOR_WOOD = [0xe0c8a8, 0xd0b896, 0xe8d4b4];
/** knock a few edge breaks into [lo, hi]: the ends, a band at each end, and steps no longer than `step` */
function breaks(lo, hi, band, step) {
  const out = [lo];
  if (hi - lo > 2 * band + 0.05) {
    out.push(lo + band);
    const n = Math.max(1, Math.ceil((hi - lo - 2 * band) / step));
    for (let i = 1; i < n; i++) out.push(lo + band + (hi - lo - 2 * band) * i / n);
    out.push(hi - band);
  } else if (hi - lo > 0.4) out.push((lo + hi) / 2);
  out.push(hi);
  return out;
}

/** Every opening on floor f: centre on its wall line, width, heights, which way the wall runs. */
function openingsOn(pl, f) {
  const out = [];
  for (const wl of pl.walls) for (const g of wl.gaps) {
    const pa = wl.axis === 'b' ? wl.at : g.c, pb = wl.axis === 'b' ? g.c : wl.at, y0 = pl.floorAt(f, pa, pb);
    out.push({ axis: wl.axis, pa, pb, w: g.w, y0, y1: y0 + DIM.doorH, kind: 'gap' });
  }
  for (const S of pl.SIDES) {
    const axis = Math.abs(S.t[0]) > 0.5 ? 'a' : 'b';
    if (f === 0 && S.door) out.push({ axis, pa: S.o[0] + S.t[0] * S.door.u, pb: S.o[1] + S.t[1] * S.door.u, w: S.door.w, y0: S.door.g, y1: S.door.g + DIM.doorH + 0.05, kind: 'door' });
    for (const W of pl.windows) if (W.f === f && W.side === S.key) out.push({ axis, pa: S.o[0] + S.t[0] * W.u, pb: S.o[1] + S.t[1] * W.u, w: W.ww, y0: W.ya, y1: W.yb, kind: 'win', W });
  }
  return out;
}

function drawInside(L, pl, K, st, fr, rng) {
  const { floors, fy, top, slab, ia, ib, ti, T } = pl;
  const irng = makeRng((st.seed ^ 0x51f3a7) >>> 0);
  const ceilY = (f) => (f + 1 < floors ? fy[f + 1] : top) - slab;
  // interior walls: what the rooms' finishes do not cover — ends, tops, the lintels' undersides
  for (let f = 0; f < floors; f++) {
    const yTopF = (f + 1 < floors ? fy[f + 1] : top) - slab, col = st.rooms[(f + 1) % 3];
    for (const wl of pl.walls) {
      const along = wl.axis === 'a', skipF = 8 | (along ? 16 | 32 : 1 | 2);
      const at = (s0) => (along ? [s0, wl.at] : [wl.at, s0]);
      const yb0 = f === 0 ? Math.min(pl.gyC(...at(wl.from)), pl.gyC(...at(wl.to))) - 0.25 : fy[f];
      const seg = (s0, s1, ya, yb) => {
        if (s1 - s0 < 1e-3 || yb - ya < 1e-3) return;
        const p = at((s0 + s1) / 2);
        fr.box(K.plaster, p[0], (ya + yb) / 2, p[1], along ? s1 - s0 : ti, yb - ya, along ? ti : s1 - s0, col, { us: 3.2, k: KIN, kb: 0.8, skip: skipF });
      };
      const gs = wl.gaps.slice().sort((p, q) => p.c - q.c);
      let from = wl.from;
      for (const g of gs) {
        const gb = f === 0 ? pl.gyC(...at(g.c)) : fy[f];
        seg(from, g.c - g.w / 2, yb0, yTopF);
        seg(g.c - g.w / 2, g.c + g.w / 2, gb + DIM.doorH, yTopF);
        for (const e of [g.c - g.w / 2 - 0.04, g.c + g.w / 2 + 0.04]) { const p = at(e); fr.box(K.pwood, p[0], gb + DIM.doorH / 2 + 0.03, p[1], along ? 0.08 : ti + 0.04, DIM.doorH + 0.06, along ? ti + 0.04 : 0.08, st.frame, { us: 0.9, k: KIN, skip: 8 }); }
        { const p = at(g.c); fr.box(K.pwood, p[0], gb + DIM.doorH + 0.04, p[1], along ? g.w + 0.16 : ti + 0.04, 0.08, along ? ti + 0.04 : g.w + 0.16, st.frame, { us: 0.9, k: KIN }); }
        from = g.c + g.w / 2;
      }
      seg(from, wl.to, yb0, yTopF);
    }
  }
  // ceilings: plaster undersides of the slabs and the roof
  const slabBoxes = (f) => {
    const h = pl.holes.find((q) => q.f === f);
    if (!h) return [[0, 0, ia, ib]];
    return [[(-ia + h.a0) / 2, 0, (h.a0 + ia) / 2, ib], [(h.a1 + ia) / 2, 0, (ia - h.a1) / 2, ib],
      [(h.a0 + h.a1) / 2, (h.b1 + ib) / 2, (h.a1 - h.a0) / 2, (ib - h.b1) / 2], [(h.a0 + h.a1) / 2, (-ib + h.b0) / 2, (h.a1 - h.a0) / 2, (h.b0 + ib) / 2]];
  };
  for (let f = 1; f < floors; f++) for (const [a, b, ha, hb] of slabBoxes(f)) {
    if (ha < 1e-3 || hb < 1e-3) continue;
    fr.box(K.plaster, a, fy[f] - slab / 2 - 0.01, b, ha * 2, slab - 0.02, hb * 2, CEIL, { us: 3.2, k: KIN * 0.9, skip: 4 });
  }
  fr.box(K.plaster, 0, top - slab / 2, 0, ia * 2, slab, ib * 2, CEIL, { us: 3.2, k: KIN * 0.9, skip: 4 | 1 | 2 | 16 | 32 });
  if (pl.flat) {
    fr.box(K.conc, 0, top + 0.006, 0, ia * 2, 0.012, ib * 2, C(0x5e5e5a), { us: 3, skip: 8 | 1 | 2 | 16 | 32 });
    for (let k = 0; k < 4; k++) { const pw = rng.range(1, 3), pd = rng.range(0.8, 2.4); fr.box(K.conc, rng.range(-ia + pw / 2, ia - pw / 2), top + 0.014, rng.range(-ib + pd / 2, ib - pd / 2), pw, 0.004, pd, C(rng.pick([0x4a4a48, 0x6e6c66])), { us: 3, skip: 8 }); }
    fr.box(K.paint, rng.range(-0.3, 0.3) * ia, top + 0.03, rng.range(-0.3, 0.3) * ib, 0.8, 0.04, 0.8, C(0x5a5e58), { us: 1.6 });
  }
  // stairs
  for (const fl of pl.flights) drawFlight(fr, K, st, pl, fl);
  for (const rl of pl.rails) drawRail(fr, K, st, pl, rl);

  // ── every room and hall: wall finish, skirting, coving, floorboards, a ceiling light
  const tk = L._inTris || (L._inTris = {}), tri0 = triCount(K) + K.paper.i.length / 3 + K.plaster.i.length / 3;
  const spaces = pl.roomsF.concat(pl.halls), ops = [];
  for (let f = 0; f < floors; f++) ops.push(openingsOn(pl, f));
  const skirtCol = C(irng.pick(SKIRT)), curtainCol = C(irng.pick(CURTAINS)), curtainCol2 = C(irng.pick(CURTAINS));
  const unitPainted = irng.chance(0.65), unit = unitPainted ? C(irng.pick([0xe8e2d0, 0xd8dcc8, 0xc8d8d0, 0xe4d8b8, 0xd0d8e0])) : C(irng.pick([0xc89a74, 0xb08060, 0xd4ae86]));
  const floorCol = new Map();
  for (const sp of spaces) {
    const s = sp.style, f = sp.f, yTop = ceilY(f);
    const fY = (a, b) => (f === 0 ? pl.gyC(a, b) + 0.025 : fy[f]);
    const warm = sp.lit ? WARM : [1, 1, 1];
    const tintK = (col, kk) => [col[0] * kk * warm[0], col[1] * kk * warm[1], col[2] * kk * warm[2]];
    const fcol = C(s.floor === 'paint' ? FLOOR_PAINT[(sp.id + 7 * f + 4) & 3] : FLOOR_WOOD[(sp.id + f) % 3]);
    floorCol.set(f + ':' + sp.id, { fcol, fY, sp });
    const aoF = (a, b) => (1 - 0.34 * fall(a - sp.a0, 0.5)) * (1 - 0.34 * fall(sp.a1 - a, 0.5)) * (1 - 0.34 * fall(b - sp.b0, 0.5)) * (1 - 0.34 * fall(sp.b1 - b, 0.5));
    // floorboards (round the stairwell), shaded into the corners
    const holes = pl.holes.filter((h) => h.f === f).map((h) => ({ u0: h.a0, u1: h.a1, y0: h.b0, y1: h.b1 }));
    for (const r of solidRects(sp.a0, sp.a1, sp.b0, sp.b1, holes)) {
      const as = breaks(r.u0, r.u1, 0.45, f === 0 ? 1.0 : 2.2), bs = breaks(r.y0, r.y1, 0.45, f === 0 ? 1.0 : 2.2), g = K.floor, base = g.count, nx = as.length - 1;
      for (const b of bs) for (const a of as) fr._v(g, a, fY(a, b), b, 0, 1, 0, tintK(fcol, KIN), aoF(a, b), a / 2.4, b / 2.4);
      for (let j = 0; j < bs.length - 1; j++) for (let i = 0; i < nx; i++) { const q = base + j * (nx + 1) + i; g.i.push(q, q + nx + 1, q + 1, q + 1, q + nx + 1, q + nx + 2); }
    }
    // the four walls
    const fRef = fY((sp.a0 + sp.a1) / 2, (sp.b0 + sp.b1) / 2), yD = fRef + s.dadoH;
    for (let k = 0; k < 4; k++) {
      const along = k < 2 ? 'b' : 'a', at = k === 0 ? sp.a0 : k === 1 ? sp.a1 : k === 2 ? sp.b0 : sp.b1, s0 = k < 2 ? sp.b0 : sp.a0, s1 = k < 2 ? sp.b1 : sp.a1;
      const n = k === 0 ? [1, 0, 0] : k === 1 ? [-1, 0, 0] : k === 2 ? [0, 0, 1] : [0, 0, -1], flip = k === 0 || k === 3;
      const P = (sv) => (along === 'b' ? [at, sv] : [sv, at]);
      const fl = (sv) => { const p = P(sv); return fY(p[0], p[1]); };
      const mine = ops[f].filter((q) => q.axis === along && Math.abs((along === 'b' ? q.pa : q.pb) - at) < T + 0.06).map((q) => ({ ...q, s: along === 'b' ? q.pb : q.pa })).filter((q) => q.s > s0 - 0.05 && q.s < s1 + 0.05);
      const yLow = Math.min(fl(s0), fl(s1)) - 0.05;
      const holesW = mine.map((q) => ({ u0: q.s - q.w / 2, u1: q.s + q.w / 2, y0: q.kind === 'win' ? q.y0 : yLow - 1, y1: q.y1 }));
      const aoW = (sv, y) => (1 - 0.4 * fall(y - fl(sv), 0.32)) * (1 - 0.24 * fall(yTop - y, 0.3));
      const panel = (g, ya, yb, col, us) => {
        for (const r of solidRects(s0, s1, ya, yb, holesW)) {
          const ss = [r.u0];
          const nmid = f === 0 ? Math.ceil((r.u1 - r.u0) / 2.0) : 1;
          for (let i = 1; i < nmid; i++) ss.push(r.u0 + (r.u1 - r.u0) * i / nmid);
          ss.push(r.u1); ss.sort((p, q) => p - q);
          const bottom = r.y0 <= yLow + 1e-3, topC = r.y1 >= yTop - 1e-3, fMax = Math.max(fl(r.u0), fl(r.u1));
          const rows = (sv) => {
            const out = [bottom ? fl(sv) - 0.004 : r.y0];
            if (bottom && r.y1 - fMax > 0.45) out.push(fl(sv) + 0.3);
            if (topC && r.y1 - Math.max(r.y0, fMax) > 0.75) out.push(yTop - 0.3);
            out.push(r.y1);
            return out;
          };
          const base = g.count, nr = rows(ss[0]).length;
          for (const sv of ss) for (const y of rows(sv)) { const p = P(sv); fr._v(g, p[0], y, p[1], n[0], n[1], n[2], col, aoW(sv, y), sv / us, y / us); }
          for (let i = 0; i < ss.length - 1; i++) for (let j = 0; j < nr - 1; j++) {
            const a = base + i * nr + j, b = a + nr, c2 = b + 1, d = a + 1;
            if (flip) g.i.push(a, d, c2, a, c2, b); else g.i.push(a, b, c2, a, c2, d);
          }
        }
      };
      if (s.paper) panel(K.paper, yLow, yTop, tintK(C(s.wall), KIN), 0.56);
      else {
        panel(K.plaster, yLow, yD, tintK(C(s.dado), KIN * 0.95), 3.2);
        panel(K.plaster, yD, yTop, tintK(C(s.wall), KIN), 3.2);
        // the painted line along the top of the dado
        for (const r of solidRects(s0, s1, yD - 0.01, yD + 0.01, holesW)) {
          const p0 = P(r.u0), p1 = P(r.u1), o = 0.002, g = K.plaster, base = g.count, col = tintK(C(s.dado), KIN * 0.55);
          for (const [p, y] of [[p0, yD - 0.01], [p1, yD - 0.01], [p1, yD + 0.01], [p0, yD + 0.01]]) fr._v(g, p[0] + n[0] * o, y, p[1] + n[2] * o, n[0], 0, n[2], col, 1, 0, 0);
          if (flip) g.i.push(base, base + 2, base + 1, base, base + 3, base + 2); else g.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
      // skirting (broken at doorways), coving under the ceiling
      const lowOps = mine.filter((q) => q.y0 - fl(q.s) < 0.15).map((q) => ({ u0: q.s - q.w / 2, u1: q.s + q.w / 2, y0: -1, y1: 1 }));
      for (const r of solidRects(s0, s1, 0, 0.5, lowOps)) {
        const g = K.ven, dep = 0.018, hh = 0.1, col = mul(skirtCol, KIN);
        const q = (pts, nn) => { const base = g.count; for (const [sv, y, dd] of pts) { const p = P(sv); fr._v(g, p[0] + n[0] * dd, y, p[1] + n[2] * dd, nn[0], nn[1], nn[2], col, y < fl(sv) + 0.02 ? 0.7 : 1, sv / 0.9, y / 0.9); } if (flip) g.i.push(base, base + 3, base + 2, base, base + 2, base + 1); else g.i.push(base, base + 1, base + 2, base, base + 2, base + 3); };
        q([[r.u0, fl(r.u0) - 0.01, dep], [r.u1, fl(r.u1) - 0.01, dep], [r.u1, fl(r.u1) + hh, dep], [r.u0, fl(r.u0) + hh, dep]], n);
        q([[r.u0, fl(r.u0) + hh, dep], [r.u1, fl(r.u1) + hh, dep], [r.u1, fl(r.u1) + hh, 0], [r.u0, fl(r.u0) + hh, 0]], [0, 1, 0]);
      }
      {
        const g = K.plaster, base = g.count, cv = 0.075, col = tintK(C(0xf0ece2), KIN * 0.92), nn = [n[0] * 0.7, -0.7, n[2] * 0.7];
        const pA = P(s0), pB = P(s1);
        for (const [p, y, dd] of [[pA, yTop - cv, 0], [pB, yTop - cv, 0], [pB, yTop, cv], [pA, yTop, cv]]) fr._v(g, p[0] + n[0] * dd, y, p[1] + n[2] * dd, nn[0], nn[1], nn[2], col, y < yTop - 0.01 ? 0.92 : 0.8, 0, 0);
        if (flip) g.i.push(base, base + 3, base + 2, base, base + 2, base + 1); else g.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    // the ceiling light: enamel shade on a flex, a three-armed chandelier, or a glass dome
    {
      let ca = (sp.a0 + sp.a1) / 2, cb = (sp.b0 + sp.b1) / 2;
      if (sp.hall) {
        const busy = (b) => pl.holes.some((h) => (h.f === f || h.f === f + 1) && b > h.b0 - 0.8 && b < h.b1 + 0.8) || pl.flights.some((fl2) => fl2.f === f && b > Math.min(fl2.bFoot, fl2.bFoot + fl2.dir * fl2.run) - 0.6 && b < Math.max(fl2.bFoot, fl2.bFoot + fl2.dir * fl2.run) + 0.6);
        const cand = [0, -ib * 0.5, ib * 0.5, -ib * 0.75, ib * 0.75].find((b) => !busy(b));
        if (cand === undefined) continue;
        cb = cand;
      }
      const kind = sp.kind === 'living' ? (s.light ? 1 : 2) : sp.kind === 'bedroom' ? (s.light === 1 ? 1 : 2) : sp.kind === 'hall' ? (s.light ? 2 : 0) : 0;
      ceilingLight(Emit.at(fr, ca, yTop, cb, 0), K, kind, irng);
    }
  }
  tk.rooms = (tk.rooms || 0) + triCount(K) + K.paper.i.length / 3 + K.plaster.i.length / 3 - tri0;
  // thresholds under the doorways
  for (let f = 0; f < floors; f++) for (const wl of pl.walls) for (const g of wl.gaps) {
    const along = wl.axis === 'a', a0 = along ? g.c - g.w / 2 : wl.at - ti / 2 - 0.01, a1 = along ? g.c + g.w / 2 : wl.at + ti / 2 + 0.01, b0 = along ? wl.at - ti / 2 - 0.01 : g.c - g.w / 2, b1 = along ? wl.at + ti / 2 + 0.01 : g.c + g.w / 2;
    const yy = (a, b) => (f === 0 ? pl.gyC(a, b) + 0.027 : fy[f] + 0.002), gq = K.floor, base = gq.count, col = mul(C(0xb89a7a), KIN * 0.85);
    for (const [a, b] of [[a0, b0], [a1, b0], [a1, b1], [a0, b1]]) fr._v(gq, a, yy(a, b), b, 0, 1, 0, col, 1, (along ? b : a) / 2.4 + 0.3, (along ? a : b) / 2.4);
    gq.i.push(base, base + 3, base + 2, base, base + 2, base + 1);
  }
  // a runner down the ground-floor hall
  if (pl.hallL) {
    rng.pick(CLOTH_COLS);
    const fY0 = (a, b) => pl.gyC(a, b) + 0.025, len = ib * 2 - 2.4;
    carpet(Emit.at(fr, pl.ah, 0, 0, -PI / 2, fY0), K.car, len, 1.0, 3, mul([1, 1, 1], KIN * 1.15), { h: 0.016 });
  }

  // ── furniture, the household pieces, the things on the walls
  const spaceOf = (it) => (it.room >= 0 ? pl.roomsF.find((r) => r.f === it.f && r.id === it.room) : pl.halls.find((h) => h.f === it.f));
  const SHADE = { bed: 0.62, cot: 0.75, sofa: 0.5, armchair: 0.52, wardrobe: 0.45, wardrobeDown: 0.5, shelf: 0.55, bookcase: 0.55, cabinet: 0.5, counter: 0.5, sideboard: 0.58, stove: 0.6,
    fridge: 0.5, hutch: 0.48, dresser: 0.52, chest: 0.5, nightstand: 0.6, tv: 0.62, table: 0.72, ktable: 0.72, coffee: 0.7, tableDown: 0.7, crate: 0.5, barrel: 0.55, sacks: 0.55,
    cases: 0.6, mattress: 0.6, gascyl: 0.6, plant: 0.6, sandbags: 0.5 };
  const all = pl.furn.map((it, i) => [it, i + 1]).concat(pl.dress.map((it, i) => [it, 5000 + i]));
  for (const [it, idx] of all) {
    const sp = spaceOf(it), info = sp && floorCol.get(it.f + ':' + sp.id);
    if (!sp || !info) continue;
    const lift = it.f === 0 ? 0.025 : 0;
    // contact shade on the floor round anything that stands on it
    const sh = SHADE[it.kind];
    if (sh && !it.deco) shadeUnder(fr, K, it, info, sh, lift);
    if (it.kind === 'crate' || it.kind === 'barrel' || it.kind === 'sandbags') { drawMilitary(L, fr, K, pl, it, rng); continue; }
    const E = Emit.at(fr, it.a, it.y + lift, it.b, it.ry, info.fY);
    const c = { k: KIN, rng: makeRng((st.seed ^ Math.imul(idx, 0x9e3779b1)) >>> 0), room: sp.kind, lit: sp.lit, ceil: ceilY(it.f) - (it.y + lift), unit, unitG: unitPainted ? K.ena : K.ven, behind: windowBehind(pl, it) };
    const n0 = triCount(K);
    drawPiece(E, K, it, c);
    tk[it.kind] = (tk[it.kind] || 0) + triCount(K) - n0;
  }
  // radiators and curtains at the windows
  const tw0 = triCount(K);
  for (const q of pl.winDress) {
    const p = q.along === 'b' ? [q.at, q.s] : [q.s, q.at], E = Emit.at(fr, p[0], 0, p[1], RY_OF_WALL[q.side]);
    const sgn = [-1, 1, 1, -1][q.side], W = q.W, flY = pl.floorAt(q.f, p[0], p[1]) + (q.f === 0 ? 0.025 : 0);
    if (q.rad) radiator(E, K, q.rad.w, q.rad.h, flY, irng);
    const col = (q.room + q.f) % 3 ? curtainCol : curtainCol2, cw = 0.34, rodY = W.yb + 0.22;
    let lo = Infinity, hi = -Infinity;
    for (const side of [0, 1]) {
      const kind = q.curt[side];
      if (!kind) continue;
      const xc = sgn * (side ? 1 : -1) * (q.ww / 2 + 0.03 + cw / 2), yb = kind === 'long' ? flY + 0.03 : W.ya - 0.08;
      curtain(E, K, xc, cw, yb, rodY - 0.02, mul(col, KIN), irng);
      lo = Math.min(lo, xc - cw / 2); hi = Math.max(hi, xc + cw / 2);
    }
    if (hi > lo) {
      const brass = mul(C(0xb8964e), KIN);
      E.box(K.metal, (lo + hi) / 2, rodY, 0.1, hi - lo + 0.12, 0.022, 0.022, brass, {});
      for (const x of [lo - 0.07, hi + 0.07]) E.box(K.metal, x, rodY, 0.1, 0.04, 0.04, 0.04, brass, { skip: 32 });
    }
  }
  tk.windows = (tk.windows || 0) + triCount(K) - tw0;
  // lamps you can see burning: a paraffin lamp, its glass lit
  for (const lp of pl.lamps) {
    if (lp.flicker) continue;
    const E = Emit.at(fr, lp.a, lp.y - 0.35 + (lp.f === 0 ? 0.025 : 0), lp.b, 0), brass = mul(C(0xc8a050), KIN);
    E.lathe(K.metal, 0, 0, 0, [[0.06, 0], [0.065, 0.012], [0.03, 0.04], [0.024, 0.07]], 9, brass, { capB: true });
    E.lathe(K.cglass, 0, 0.07, 0, [[0.024, 0], [0.065, 0.03], [0.06, 0.08], [0.028, 0.1]], 9, [0.55, 0.65, 0.5], {});
    E.lathe(K.metal, 0, 0.17, 0, [[0.035, 0], [0.035, 0.035], [0.03, 0.04]], 8, brass, {});
    E.lathe(K.glow, 0, 0.21, 0, [[0.03, 0], [0.046, 0.06], [0.036, 0.13], [0.024, 0.22]], 9, C(0xffb860), {});
    E.box(K.glow, 0, 0.255, 0, 0.02, 0.05, 0.02, C(0xfff0c0), {});
  }
}

const triCount = (K) => (K.ven.i.length + K.ena.i.length + K.fab.i.length + K.car.i.length + K.floor.i.length + K.metal.i.length + K.cglass.i.length + K.glass.i.length) / 3;
/** is there a window in the wall right behind a piece standing against it (no tiles or wall cupboards there)? */
function windowBehind(pl, it) {
  if (it.deco) return false;
  const bk = [it.a - Math.sin(it.ry) * (it.d / 2 + 0.05), it.b - Math.cos(it.ry) * (it.d / 2 + 0.05)];
  return pl.windows.some((W) => {
    if (W.f !== it.f) return false;
    const S = pl.sideByKey[W.side], wa = S.o[0] + S.t[0] * W.u - S.n[0] * pl.T, wb = S.o[1] + S.t[1] * W.u - S.n[1] * pl.T;
    const along = Math.abs((wa - bk[0]) * Math.cos(it.ry) - (wb - bk[1]) * Math.sin(it.ry)), out = Math.abs((wa - bk[0]) * Math.sin(it.ry) + (wb - bk[1]) * Math.cos(it.ry));
    return out < 0.3 && along < it.w / 2 + W.ww / 2;
  });
}

/** a contact shade on the floor round a piece: floorboards darkened towards its footprint */
function shadeUnder(fr, K, it, info, k0, lift) {
  const { fcol, fY, sp } = info, wi = it.w / 2 - 0.02, di = it.d / 2 - 0.02, wo = it.w / 2 + 0.22, dO = it.d / 2 + 0.22;
  const xs = [-wo, -wi, wi, wo], zs = [-dO, -di, di, dO], cs = Math.cos(it.ry), sn = Math.sin(it.ry), g = K.floor, base = g.count;
  const warm = sp.lit ? WARM : [1, 1, 1], col = [fcol[0] * KIN * warm[0], fcol[1] * KIN * warm[1], fcol[2] * KIN * warm[2]];
  const aoF = (a, b) => (1 - 0.34 * fall(a - sp.a0, 0.5)) * (1 - 0.34 * fall(sp.a1 - a, 0.5)) * (1 - 0.34 * fall(b - sp.b0, 0.5)) * (1 - 0.34 * fall(sp.b1 - b, 0.5));
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const x = xs[i], z = zs[j], a = it.a + x * cs + z * sn, b = it.b - x * sn + z * cs, inner = (i === 1 || i === 2) && (j === 1 || j === 2);
    fr._v(g, a, fY(a, b) + 0.006, b, 0, 1, 0, col, aoF(a, b) * (inner ? k0 : 1), a / 2.4, b / 2.4);
  }
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) { const q = base + j * 4 + i; g.i.push(q, q + 1, q + 4, q + 1, q + 5, q + 4); }
  void lift;
}

/** cast-iron sectional radiator under a window, on two brackets, its pipe going down into the floor */
function radiator(E, K, w, h, flY, rng) {
  const col = mul(C(rng() < 0.6 ? 0xe8e4da : 0xc8ccc8), KIN), y0 = flY + 0.12, n = Math.max(4, Math.round(w / 0.085)), sw = w / n;
  E.box(K.ena, 0, y0 + h / 2, 0.075, w, h, 0.07, mul(col, 0.85), { skip: 32 | 8 });
  // the sections as one corrugated front
  for (let i = 0; i < 2 * n; i++) {
    const x0 = -w / 2 + sw * i / 2, x1 = x0 + sw / 2, z0 = i % 2 ? 0.135 : 0.11, z1 = i % 2 ? 0.11 : 0.135;
    E.quad(K.ena, [[x0, y0 + 0.01, z0], [x1, y0 + 0.01, z1], [x1, y0 + h, z1], [x0, y0 + h, z0]], col, { ks: [0.75, 0.75, 1, 1] });
  }
  const pipe = mul(C(0x8a8a84), KIN);
  E.box(K.metal, w / 2 + 0.05, (flY + y0 + h - 0.08) / 2, 0.06, 0.03, y0 + h - 0.08 - flY, 0.03, pipe, {});
  E.box(K.metal, w / 2 + 0.025, y0 + h - 0.08, 0.06, 0.05, 0.03, 0.03, pipe, {});
}

/** a pleated curtain panel hanging from yt to yb, centred at x along the wall */
function curtain(E, K, x, cw, yb, yt, col, rng) {
  const m = 7, g = K.fab, sh = rng() * 0.08;
  for (let i = 0; i < m - 1; i++) {
    const x0 = x - cw / 2 + cw * i / (m - 1), x1 = x - cw / 2 + cw * (i + 1) / (m - 1), z0 = 0.05 + (i % 2) * 0.06, z1 = 0.05 + ((i + 1) % 2) * 0.06;
    const k = i % 2 ? 0.82 - sh : 1;
    E.quad(g, [[x0, yb, z0], [x1, yb, z1], [x1, yt, z1], [x0, yt, z0]], col, { us: 1.2, ks: [k * 0.85, k * 0.85, k, k] });
  }
}

/** ceiling light, hanging down from y = 0 of E (the ceiling): 0 enamel shade, 1 chandelier, 2 glass dome */
function ceilingLight(E, K, kind, rng) {
  const k = KIN, brass = mul(C(0xb89a5a), k), white = mul(C(0xf2efe6), k * 1.1);
  if (kind === 0) {
    E.lathe(K.metal, 0, -0.02, 0, [[0.04, 0], [0.04, 0.02]], 6, mul(C(0xe8e4dc), k), { capB: true });
    E.box(K.dark, 0, -0.32, 0, 0.008, 0.6, 0.008, [0.05, 0.05, 0.05], {});
    E.lathe(K.ena, 0, -0.78, 0, [[0.2, 0], [0.1, 0.12], [0.025, 0.2]], 8, mul(C(rng() < 0.5 ? 0x3e6a4a : 0xe8e4da), k), { cap: true });
    E.lathe(K.ena, 0, -0.8, 0, [[0.0, 0], [0.04, 0.04], [0.02, 0.09]], 6, white, {});
  } else if (kind === 1) {
    E.lathe(K.metal, 0, -0.04, 0, [[0.07, 0], [0.06, 0.03], [0.02, 0.04]], 8, brass, { capB: true });
    E.box(K.metal, 0, -0.3, 0, 0.016, 0.5, 0.016, brass, {});
    E.lathe(K.metal, 0, -0.62, 0, [[0.0, 0], [0.05, 0.04], [0.03, 0.1], [0.012, 0.12]], 8, brass, {});
    for (let i = 0; i < 3; i++) {
      const a = i * 2 * PI / 3 + rng(), cx = Math.cos(a) * 0.26, cz = Math.sin(a) * 0.26;
      E.box(K.metal, cx / 2, -0.58, cz / 2, 0.26, 0.012, 0.012, brass, { ry: -a });
      E.lathe(K.ena, cx, -0.64, cz, [[0.02, 0], [0.075, 0.05], [0.08, 0.12]], 7, white, {});
    }
  } else {
    E.lathe(K.metal, 0, -0.012, 0, [[0.14, 0], [0.14, 0.012]], 10, mul(C(0xb8b4aa), k), { capB: true });
    E.lathe(K.ena, 0, -0.13, 0, [[0.0, 0], [0.09, 0.02], [0.13, 0.08], [0.125, 0.12]], 9, white, {});
  }
}

/** crates, barrels and the sandbag firing steps of the garrisoned houses */
function drawMilitary(L, fr, K, pl, it, rng) {
  if (it.kind === 'crate') { const p = fr.W(it.a, it.b); buildProp(L, 'crate', { x: p[0], z: p[1], s: 1, rot: pl.R + it.ry, y: it.y }); return; }
  if (it.kind === 'barrel') { const p = fr.W(it.a, it.b); buildProp(L, 'barrel', { x: p[0], z: p[1], y: it.y }); return; }
  // a firing step of bags under the window: one squashed box per bag, courses laid in bond
  const I = itemFrame(fr, it), w = it.w, h = it.h, n = Math.max(1, Math.round(h / 0.17)), bh = h / n;
  for (let c2 = 0; c2 < n; c2++) {
    const cnt = Math.max(1, Math.round(w / 0.5)), sp = w / cnt, off = c2 % 2 ? sp / 2 : 0;
    for (let i = 0; i < cnt - (c2 % 2 ? 1 : 0); i++) for (const lz of [-0.15, 0.15]) {
      I.box(K.cloth, -w / 2 + sp * (i + 0.5) + off + rng.range(-0.03, 0.03), bh * (c2 + 0.5), lz, sp * 1.02, bh * 1.08, 0.3, mul(C(rng.pick(BAG_COLS)), KIN * rng.range(0.9, 1.1)),
        { us: 1.2, ry: rng.range(-0.06, 0.06), rz: rng.range(-0.04, 0.04), skip: 8, kb: 0.8 });
    }
  }
}

function drawFlight(fr, K, st, pl, fl) {
  const am = (fl.a0 + fl.a1) / 2, wa = fl.a1 - fl.a0, run = DIM.run, wood = st.floorWood, side = mul(wood, 0.7);
  for (let i = 0; i < fl.n; i++) {
    const bc = fl.bFoot + fl.dir * (i + 0.5) * run, yt = fl.yTop - (fl.n - 1 - i) * fl.sh;
    // the block of the step (sides read as a solid stair), tread with a nosing
    fr.box(K.plaster, am, (fl.base + yt - 0.04) / 2, bc, wa, yt - 0.04 - fl.base, run, st.rooms[1], { us: 3.2, k: KIN * 0.85, skip: 4 | 8 });
    fr.box(K.wood, am, yt - 0.02, bc + fl.dir * -0.02, wa + 0.02, 0.04, run + 0.04, wood, { us: 1.8, k: KIN });
    void side;
  }
  // handrail on the open side: posts at both ends, a sloped rail between
  const ao = fl.a0 + 0.04 + (pl.ah > fl.a0 ? 0 : 0), b0 = fl.bFoot, b1 = fl.bFoot + fl.dir * fl.n * run;
  const railA = Math.abs(fl.a0 - (pl.ah - pl.hh)) < 0.01 ? fl.a1 - 0.04 : ao;
  const y0 = fl.yTop - (fl.n - 1) * fl.sh, y1 = fl.yTop;
  fr.box(K.pwood, railA, y0 + 0.45, b0 + fl.dir * 0.15, 0.07, 0.95, 0.07, st.frame, { us: 0.9, k: KIN });
  fr.box(K.pwood, railA, y1 + 0.45, b1 - fl.dir * 0.15, 0.07, 0.95, 0.07, st.frame, { us: 0.9, k: KIN });
  const len = Math.hypot(b1 - b0, y1 - y0), ang = Math.atan2(y1 - y0, Math.abs(b1 - b0));
  fr.box(K.pwood, railA, (y0 + y1) / 2 + 0.9, (b0 + b1) / 2, 0.06, 0.06, len, st.frame, { us: 0.9, k: KIN, rx: fl.dir > 0 ? -ang : ang });
  for (let k = 1; k < fl.n; k += 2) {
    const bc = fl.bFoot + fl.dir * (k + 0.5) * run, yt = fl.yTop - (fl.n - 1 - k) * fl.sh;
    fr.box(K.pwood, railA, yt + 0.45, bc, 0.03, 0.9, 0.03, st.frame, { us: 0.9, k: KIN, skip: 4 | 8 });
  }
}

function drawRail(fr, K, st, pl, rl) {
  const y = pl.fy[rl.f], len = rl.to - rl.from, m = (rl.from + rl.to) / 2;
  const at = (s0) => (rl.axis === 'a' ? [s0, rl.at] : [rl.at, s0]);
  const p = at(m), sa = rl.axis === 'a' ? len : 0.07, sb = rl.axis === 'a' ? 0.07 : len;
  fr.box(K.pwood, p[0], y + 0.97, p[1], sa, 0.06, sb, st.frame, { us: 0.9, k: KIN });
  fr.box(K.pwood, p[0], y + 0.5, p[1], rl.axis === 'a' ? len : 0.04, 0.04, rl.axis === 'a' ? 0.04 : len, st.frame, { us: 0.9, k: KIN });
  const n = Math.max(1, Math.round(len / 0.9));
  for (let k = 0; k <= n; k++) { const q = at(rl.from + (k / n) * len); fr.box(K.pwood, q[0], y + 0.48, q[1], 0.06, 0.96, 0.06, st.frame, { us: 0.9, k: KIN, skip: 4 | 8 }); }
}

// ───────────────────────────── roof ─────────────────────────────
function drawRoof(L, pl, K, st, hf, rng, o) {
  const { w, d, top, flat } = pl;
  if (flat) return;
  const rh = pl.rh, hd = d / 2, ov = 0.42, vg = 0.32;
  const X0 = -w / 2 - vg, X1 = w / 2 + vg;
  const slope = rh / hd, yE = top + 0.1 - ov * slope, ze = hd + ov, yR = top + 0.1 + rh;
  const rc = C(o.roofTint ?? rng.pick([0xffffff, 0xf0e8e0, 0xe0d8d0, 0xc8c4c0, 0xd8c8b8]));
  const us = TEX_SCALE.roof || 2.4;
  for (const sg of [1, -1]) {
    const A = [X0, yE, sg * ze], B = [X1, yE, sg * ze], Cc = [X1, yR, 0], D = [X0, yR, 0];
    if (sg > 0) hf.poly(K.roof, [A, B, Cc, D], rc, 1, us); else hf.poly(K.roof, [B, A, D, Cc], rc, 0.94, us);
    // fascia and gutter
    hf.box(K.pwood, 0, yE - 0.08, sg * (ze + 0.01), X1 - X0, 0.18, 0.03, st.frame, { us: 0.9, k: 0.85 });
    hf.box(K.paint, 0, yE - 0.12, sg * (ze + 0.08), X1 - X0 + 0.04, 0.1, 0.12, C(0x8c9090), { us: 1.6 });
    // soffit
    hf.poly(K.wood, sg > 0 ? [[X1, yE - 0.15, ze], [X0, yE - 0.15, ze], [X0, top, hd], [X1, top, hd]] : [[X0, yE - 0.15, -ze], [X1, yE - 0.15, -ze], [X1, top, -hd], [X0, top, -hd]], C(0x6a5a4a), 0.5, 1.8);
  }
  // gable walls
  for (const sx of [1, -1]) {
    const X = sx * w / 2;
    const pts = sx > 0 ? [[X, top, hd], [X, top, -hd], [X, yR - 0.15, 0]] : [[X, top, -hd], [X, top, hd], [X, yR - 0.15, 0]];
    hf.poly(K.wall, pts, mul(st.wallCol, 0.85), 1, st.us);
    // bargeboards
    for (const sg of [1, -1]) {
      const a = [sx * X1, yE + 0.02, sg * ze], b = [sx * X1, yR + 0.02, 0], len = Math.hypot(ze, yR - yE);
      hf.box(K.pwood, sx * X1, (a[1] + b[1]) / 2 - 0.08, sg * ze / 2, 0.04, 0.2, len, st.frame, { us: 0.9, k: 0.85, rx: sg > 0 ? Math.atan2(yR - yE, ze) : -Math.atan2(yR - yE, ze) });
    }
  }
  // ridge cap and a chimney
  hf.box(K.roof, 0, yR + 0.02, 0, X1 - X0 + 0.04, 0.08, 0.3, mul(rc, 0.8), { us });
  if (rng.chance(0.8)) {
    const lx = (rng.chance(0.5) ? 1 : -1) * rng.range(0.15, 0.35) * w, lz = rng.range(-0.25, 0.25) * hd;
    const yLow = top + 0.1 + rh * (1 - Math.abs(lz) / hd) - 0.3, yTop = yR + rng.range(0.5, 0.9);
    hf.box(K.stone, lx, (yLow + yTop) / 2, lz, 0.6, yTop - yLow, 0.5, st.isStone ? C(0xcfc8b8) : st.wallCol, { us: 2.6, kb: 0.8 });
    hf.box(K.conc, lx, yTop + 0.04, lz, 0.7, 0.08, 0.6, C(0x8a8a84), { us: 3 });
  }
}

// ───────────────────────────── doors ─────────────────────────────
/** World-space door record from a plan door. */
function doorRecord(L, pl, pd, rng) {
  const along = pd.axis === 'a';
  const ca = along ? pd.c : pd.at, cb = along ? pd.at : pd.c;
  const tC = along ? [1, 0] : [0, 1], nC = along ? [0, 1] : [1, 0];
  const toW = (va, vb) => [va * pl.cR + vb * pl.sR, -va * pl.sR + vb * pl.cR];
  const tW = toW(...tC), nW = toW(...nC);
  const centre = pl.Pc(ca, cb);
  const leaf = pd.w - 0.08;
  const hinge = [centre[0] + tW[0] * pd.hinge * (pd.w / 2 - 0.04), centre[1] + tW[1] * pd.hinge * (pd.w / 2 - 0.04)];
  const dir = [-tW[0] * pd.hinge, -tW[1] * pd.hinge];               // closed: from the hinge across the gap
  const yaw0 = Math.atan2(-dir[1], dir[0]);
  const into = [nW[0] * pd.swing, nW[1] * pd.swing];
  const sgn = Math.sign(-Math.sin(yaw0) * into[0] - Math.cos(yaw0) * into[1]) || 1;
  const y = pd.f === 0 ? L.gy(centre[0], centre[1]) : pl.fy[pd.f];
  return {
    x: centre[0], z: centre[1], y, hx: hinge[0], hz: hinge[1], yaw0, sgn, leaf, gapW: pd.w, rot: Math.atan2(-tW[1], tW[0]),
    tx: tW[0], tz: tW[1], ext: pd.ext, open: !!pd.open, f: pd.f, color: C(rng.pick(DOOR_COLS)),
  };
}

const _mx = new THREE.Matrix4(), _q = new THREE.Quaternion(), _pos = new THREE.Vector3(), _scl = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _col = new THREE.Color();
const CAP = 192;

/** Every door of a level: state, colliders, the instanced leaves, prompts and soldiers' use. */
export class DoorSystem {
  constructor(L) {
    this.L = L; this.doors = []; this.noticeT = 0;
    const g = new Geo({ uv: true }), fr = new Frame(0, 0, 0), white = [1, 1, 1], H = 2.08;
    fr.box(g, 0.5, H / 2, 0, 1, H, 0.045, white, { us: 0.9 });
    for (const sz of [-1, 1]) {
      for (const [y0, y1] of [[0.12, 0.92], [1.05, 1.95]]) fr.box(g, 0.5, (y0 + y1) / 2, sz * 0.027, 0.72, y1 - y0, 0.012, [0.92, 0.92, 0.92], { us: 0.9, skip: sz > 0 ? 32 : 16 });
      fr.box(g, 0.9, 1.0, sz * 0.045, 0.1, 0.025, 0.025, [0.25, 0.24, 0.22], {});
      fr.box(g, 0.94, 1.0, sz * 0.03, 0.03, 0.14, 0.012, [0.3, 0.29, 0.26], {});
    }
    const mat = worldMaterial('wood');
    this.mesh = new THREE.InstancedMesh(g.build(), mat, CAP);
    this.mesh.count = 0; this.mesh.castShadow = true; this.mesh.receiveShadow = true; this.mesh.frustumCulled = false;
    this.mesh.name = 'doors';
    L.group.add(this.mesh);
  }

  add(rec) {
    if (this.doors.length >= CAP) return null;
    rec.id = this.doors.length;
    rec.target = rec.open ? 1 : 0; rec.ang = rec.open ? DOOR.openAng : 0; rec.col = null; rec.byPlayer = false; rec.noticed = false;
    this.doors.push(rec);
    this.mesh.count = this.doors.length;
    this.mesh.setColorAt(rec.id, _col.setRGB(rec.color[0], rec.color[1], rec.color[2]));
    if (!rec.open) this._block(rec, true);
    this._pose(rec);
    return rec;
  }

  _block(dr, on) {
    const w = this.L.world;
    if (on && !dr.col) dr.col = w.addBox({ x: dr.x, y: dr.y + 1.06, z: dr.z, hx: dr.gapW / 2 - 0.02, hy: 1.06, hz: 0.035, rot: dr.rot, flags: THIN_WOOD, mat: 'woodThin', tag: 'door' });
    else if (!on && dr.col) { w.removeCollider(dr.col); dr.col = null; }
  }

  _pose(dr) {
    _q.setFromAxisAngle(_up, dr.yaw0 + dr.sgn * dr.ang);
    _mx.compose(_pos.set(dr.hx, dr.y + 0.02, dr.hz), _q, _scl.set(dr.leaf, 1, 1));
    this.mesh.setMatrixAt(dr.id, _mx);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Is anyone standing in the doorway (it cannot shut on them)? */
  occupied(dr) {
    const test = (x, y, z, r) => {
      if (Math.abs(y - dr.y) > 1.6) return false;
      const dx = x - dr.x, dz = z - dr.z, lx = dx * dr.tx + dz * dr.tz, lz = -dx * dr.tz + dz * dr.tx;
      return Math.abs(lx) < dr.gapW / 2 + r && Math.abs(lz) < 0.22 + r;
    };
    const p = G.player;
    if (p && test(p.x, p.y, p.z, 0.35)) return true;
    for (const e of G.enemies) if (e.alive && test(e.x, e.y, e.z, 0.3)) return true;
    return false;
  }

  /** Open or shut. by: 'player' | 'enemy'. Returns false when it could not shut. */
  toggle(dr, by, stance = 0) {
    const open = !dr.target;
    if (!open && this.occupied(dr)) return false;
    dr.target = open ? 1 : 0;
    if (open) this._block(dr, false);
    if (by === 'player') { dr.byPlayer = !dr.byPlayer; dr.noticed = false; } else dr.byPlayer = false;
    const quiet = by === 'player' && stance > 0;
    audio.play(open ? 'door_open' : 'door_shut', { x: dr.x, y: dr.y + 1.2, z: dr.z, vol: quiet ? 0.3 : 0.75, ref: 4, rate: 0.9 + Math.random() * 0.2 });
    if (by === 'player') noise.emit({ x: dr.x, y: dr.y, z: dr.z, radius: doorNoise(stance, NOISE.door), kind: 'door', byPlayer: true, time: G.simTime });
    return true;
  }

  /** The door the player is looking at within reach, or null. */
  nearest(px, py, pz, yaw) {
    let best = null, bd = DOOR.reach;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    for (const dr of this.doors) {
      if (Math.abs(dr.y - py) > 1.2) continue;
      const dx = dr.x - px, dz = dr.z - pz, d = Math.hypot(dx, dz);
      if (d > bd) continue;
      if (d > 0.7 && (dx * fx + dz * fz) / d < 0.25) continue;
      best = dr; bd = d;
    }
    return best;
  }

  /** A soldier walking into a shut door opens it (and leaves it open). */
  enemyPass(e) {
    for (const dr of this.doors) {
      if (dr.target || Math.abs(dr.y - e.y) > 1.2) continue;
      const dx = dr.x - e.x, dz = dr.z - e.z, d = Math.hypot(dx, dz);
      if (d > DOOR.enemyReach || d < 1e-3) continue;
      const hx = -Math.sin(e.loco ? e.loco.hd : e.yaw), hz = -Math.cos(e.loco ? e.loco.hd : e.yaw);
      if ((dx * hx + dz * hz) / d > 0.35 || d < 0.6) this.toggle(dr, 'enemy');
    }
  }

  update(dt) {
    cullInteriors(this.L);
    for (const dr of this.doors) {
      const goal = dr.target ? DOOR.openAng : 0;
      if (dr.ang === goal) continue;
      dr.ang = stepDoor(dr.ang, dr.target, dt);
      if (!dr.target && doorBlocks(dr.ang)) {
        if (this.occupied(dr)) dr.target = 1;            // someone stepped into it: swing back
        else { dr.ang = 0; this._block(dr, true); }
      }
      this._pose(dr);
    }
    // Hard: a patrolling soldier who sees a door the player changed comes over
    this.noticeT -= dt;
    if (this.noticeT > 0 || !G.mission || !G.mission.diff.flank) return;
    this.noticeT = 0.5;
    const w = this.L.world;
    for (const dr of this.doors) {
      if (!dr.byPlayer || dr.noticed) continue;
      for (const e of G.enemies) {
        if (!e.alive || !doorSuspicious(true, dr, e.state === AIS.PATROL ? 'patrol' : 'busy')) continue;
        const d = dist2D(e.x, e.z, dr.x, dr.z);
        if (d > DOOR.noticeRange || Math.abs(e.y - dr.y) > 2) continue;
        if (Math.abs(angDelta(e.yaw, yawTo(e.x, e.z, dr.x, dr.z))) > STEALTH.fovEdge) continue;
        if (!w.los(e.x, e.y + 1.6, e.z, dr.x, dr.y + 1.2, dr.z)) continue;
        dr.noticed = true;
        ai.stim(e, STIM.NOISE_QUIET, dr.x, dr.z);
        break;
      }
    }
  }

  save() { return encodeDoors(this.doors); }
  load(s) {
    const st = decodeDoors(s, this.doors.length);
    this.doors.forEach((dr, i) => { dr.target = st[i] ? 1 : 0; dr.ang = st[i] ? DOOR.openAng : 0; this._block(dr, !st[i]); this._pose(dr); });
  }
  dispose() { this.mesh.dispose(); }
}
