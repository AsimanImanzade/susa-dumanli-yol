/**
 * level.js — the level kit and level runtime.
 *
 * Act files (levels/actN.js) describe a level by calling kit methods on a
 * Level: terrain, houses, walls, props, vegetation, lamps, enemies, pickups,
 * checkpoints, triggers, sectors. finalize() then merges all static geometry
 * into one mesh per texture (a handful of draw calls for a whole act),
 * instances the vegetation, and builds the collision hash, the nav grid and
 * the map image.
 */
import * as THREE from 'three';
import { G, clamp01, hash2 } from './ctx.js';
import { World, F, WALL } from './physics.js';
import { NavGrid } from './nav.js';
import { Geo, PAL, vcMaterial, meshOf, buildFlagpole, buildPickup } from './models.js';
import { buildHouse, buildBuilding, buildCar, buildProp, buildBarrier, buildRelay, buildFlagBase, buildMosque, buildRampart, finalizeStructures } from './structures.js';
import { staticColliders } from './vehicles.js';
import { TEX, TEX_SCALE } from './textures.js';
import { worldMaterial } from './materials.js';
import * as MIL from './military.js';
import { R } from './render.js';
import { lampContribution } from './stealth.js';
import { buildNature } from './nature.js';
import { buildTownhouse, finalizeInteriors } from './interiors.js';

const THIN_WOOD = F.SOLID | F.VISION | F.BULLET | F.THIN;

export class Level {
  constructor(act) {
    this.act = act;
    this.group = new THREE.Group();
    this.batches = new Map();
    this.world = null; this.nav = null;
    this.lamps = []; this.foliage = []; this.hideZones = []; this.indoor = [];
    this.ladders = []; this.pickups = []; this.checkpoints = []; this.triggers = [];
    this.sectors = []; this.spawns = []; this.interact = []; this.reinforce = [];
    this.barriers = []; this.trees = []; this.rocks = []; this.bushes = [];
    this.fires = []; this.beams = [];
    this.spawn = { x: 0, z: 0, yaw: 0 };
    this.exit = null; this.flag = null;
    this.noWalkFns = [];
    this.envName = 'forest';
    this.objective = '';
    this.dynamic = [];           // meshes that are not batched (barriers, relay…)
  }

  // ───────────────────────── terrain ─────────────────────────
  /** o: { bounds, height(x,z), surface(x,z), tex, tint(x,z)→hex, step } */
  terrain(o) {
    this.bounds = o.bounds;
    this.h = o.height;
    this.world = new World(o.bounds, o.height, o.surface);
    this.terrainOpts = o;
  }
  gy(x, z) { return this.h(x, z); }
  noWalk(fn) { this.noWalkFns.push(fn); }

  _batch(tex) {
    let b = this.batches.get(tex);
    if (!b) { b = new Geo({ uv: true }); this.batches.set(tex, b); }
    return b;
  }

  // ───────────────────────── primitives ─────────────────────────
  /**
   * A textured box sitting with its base at height y (default: terrain).
   * o: { y, rot, flags, mat, tint, noCollide, tag, lift }
   */
  box(x, z, w, h, d, tex, o = {}) {
    const y = (o.y ?? this.gy(x, z)) + (o.lift || 0);
    const rot = o.rot || 0;
    if (!o.noVisual) {
      this._batch(tex).box(x, y + h / 2, z, w, h, d, o.tint ?? 0xffffff, { ry: rot, uvScale: TEX_SCALE[tex] || 2, rx: o.rx || 0, rz: o.rz || 0 });
    }
    if (o.noCollide) return null;
    return this.world.addBox({ x, y: y + h / 2, z, hx: w / 2, hy: h / 2, hz: d / 2, rot, flags: o.flags ?? WALL, mat: o.mat || matOf(tex), tag: o.tag });
  }
  /** Straight wall from (x1,z1) to (x2,z2). */
  wall(x1, z1, x2, z2, h, t, tex, o = {}) {
    const len = Math.hypot(x2 - x1, z2 - z1), rot = Math.atan2(-(z2 - z1), x2 - x1);
    const cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;
    const y = o.y ?? Math.min(this.gy(x1, z1), this.gy(x2, z2), this.gy(cx, cz)) - 0.4;
    return this.box(cx, cz, len, h + 0.4, t, tex, { ...o, rot, y });
  }
  /** Thin wooden fence: blocks sight and movement, bullets pass with reduced damage. */
  fence(x1, z1, x2, z2, h = 1.9) { return this.wall(x1, z1, x2, z2, h, 0.08, 'wood', { flags: THIN_WOOD, mat: 'woodThin' }); }

  /**
   * A solid (non-enterable) house.
   * o: { h, floors, rot, wall, roof:'gable'|'flat', tint, lit, door:'n'|'s'|'e'|'w', ladder:'n'|'s'|'e'|'w' }
   */
  house(x, z, w, d, o = {}) {
    const floors = o.floors || 2, fh = o.h || 3.1, H = floors * fh, rot = o.rot || 0;
    const tex = o.wall || 'stone';
    const c = Math.cos(rot), s = Math.sin(rot);
    const P = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    const corners = [P(-w / 2, -d / 2), P(w / 2, -d / 2), P(-w / 2, d / 2), P(w / 2, d / 2)];
    const y0 = Math.min(...corners.map((p) => this.gy(p[0], p[1]))) - 0.5;
    const top = Math.max(...corners.map((p) => this.gy(p[0], p[1]))) + H;
    const flat = o.roof === 'flat';
    this.box(x, z, w, top - y0, d, tex, { y: y0, rot, tint: o.tint, flags: flat ? WALL : (F.SOLID | F.VISION | F.BULLET), noVisual: true });
    let rh = 0;
    if (flat) {
      // parapet: knee-high cover on the roof
      const ph = 0.55, pt = 0.3;
      for (const [lx, lz, pw, pd] of [[0, -d / 2 + pt / 2, w, pt], [0, d / 2 - pt / 2, w, pt], [-w / 2 + pt / 2, 0, pt, d - pt * 2], [w / 2 - pt / 2, 0, pt, d - pt * 2]]) {
        const p = P(lx, lz);
        this.box(p[0], p[1], pw, ph, pd, tex, { y: top, rot, tint: 0xd8d4c8, noVisual: true });
      }
    } else {
      rh = Math.min(3.2, d * 0.32);
      this.world.addBox({ x, y: top + rh * 0.3, z, hx: w / 2, hy: rh * 0.3, hz: d * 0.3, rot, flags: F.SOLID | F.VISION | F.BULLET, mat: 'metal' });
    }
    // lit windows: lamp entries here, the façade builder glazes the same windows with light
    const seed = Math.floor(x * 7 + z * 13);
    const isLit = (i, f, side) => !!o.lit && hash2(seed + i * 3 + f * 11, side) > 0.8;
    for (let f = 0; f < floors; f++) {
      const wy = Math.max(...corners.map((p) => this.gy(p[0], p[1]))) + f * fh + 1.25;
      for (const side of [-1, 1]) {
        const n = Math.max(1, Math.floor(w / 3.4));
        for (let i = 0; i < n; i++) {
          const lx = -w / 2 + (i + 0.5) * (w / n);
          if (isLit(i, f, side)) this.lamps.push({ x: P(lx, side * (d / 2 + 1.6))[0], y: wy + 0.4, z: P(lx, side * (d / 2 + 1.6))[1], r: 6, i: 0.45, color: 0xffc27a, noLight: true });
        }
      }
    }
    buildHouse(this, { x, z, w, d, rot, floors, fh, H, top, y0, flat, rh, tex, tint: o.tint, roofTint: o.roofTint, door: o.door, ladder: o.ladder, ladderAt: o.ladderAt, isLit });
    if (o.ladder) {
      const m = { n: [0, -d / 2 - 0.25, Math.PI], s: [0, d / 2 + 0.25, 0], w: [-w / 2 - 0.25, 0, -Math.PI / 2], e: [w / 2 + 0.25, 0, Math.PI / 2] }[o.ladder];
      const off = o.ladderAt ?? 0;
      const p = m[0] === 0 ? P(off, m[1]) : P(m[0], off);
      this.ladder(p[0], p[1], rot + m[2], top - this.gy(p[0], p[1]) + 0.1);
    }
    return { x, z, w, d, rot, top, P };
  }

  /**
   * An enterable building: four walls with door gaps, floor, flat walkable roof.
   * doors: [{ side:'n'|'s'|'e'|'w', at:-1..1 (position along the wall), w }]
   */
  building(x, z, w, d, o = {}) {
    const H = o.h || 3.4, t = 0.4, rot = o.rot || 0, tex = o.wall || 'stone';
    const c = Math.cos(rot), s = Math.sin(rot);
    const P = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    const y0 = this.gy(x, z);
    const doors = o.doors || [];
    const sides = { n: [0, -d / 2 + t / 2, w, 0], s: [0, d / 2 - t / 2, w, 0], w: [-w / 2 + t / 2, 0, d, 1], e: [w / 2 - t / 2, 0, d, 1] };
    const allGaps = {};
    for (const side in sides) {
      const [lx, lz, len, vert] = sides[side];
      const gaps = doors.filter((dd) => dd.side === side).map((dd) => ({ c: (dd.at || 0) * (len / 2 - 1.2), w: dd.w || 1.4 })).sort((a, b) => a.c - b.c);
      allGaps[side] = gaps;
      let from = -len / 2;
      const seg = (a, b, yBase, hh) => {
        if (b - a < 0.05) return;
        const mid = (a + b) / 2, p = vert ? P(lx, mid) : P(mid, lz);
        this.box(p[0], p[1], vert ? t : b - a, hh, vert ? b - a : t, tex, { y: yBase, rot, tint: o.tint, noVisual: true });
      };
      for (const g of gaps) {
        seg(from, g.c - g.w / 2, y0 - 0.4, H + 0.4);
        seg(g.c - g.w / 2, g.c + g.w / 2, y0 + 2.2, H - 2.2);       // lintel
        from = g.c + g.w / 2;
      }
      seg(from, len / 2, y0 - 0.4, H + 0.4);
    }
    this.box(x, z, w, 0.25, d, 'concrete', { y: y0 + H, rot, tint: 0x9a9a94, noVisual: true });  // roof slab (walkable)
    buildBuilding(this, { x, z, w, d, rot, H, t, y0, tex, tint: o.tint, gaps: allGaps });         // walls, trim, floor, roof edge
    this.indoor.push({ x, z, hx: w / 2, hz: d / 2, c, s, y0, y1: y0 + H });
    return { x, z, w, d, rot, top: y0 + H + 0.25, P };
  }

  /**
   * An enterable house of one to three storeys (interiors.js): the same street
   * face as house() — stone or plaster, real window openings, tin or flat roof,
   * balcony — with rooms, stairs, furniture, hinged doors, dark and lit rooms.
   * o: { floors, h, rot, wall, roof:'gable'|'flat', tint, roofTint, door:'n'|'s'|'e'|'w' (front),
   *      back: side|false (second door, default opposite), low (a ground-floor window to climb through),
   *      garrison (military rooms: sandbagged windows, radio), balcony, lit (0–2 lit rooms), ladder, ladderAt }
   * Returns house()'s record plus { floors, fy, loot(f,k), post(f,k), stand(k), front, back, hallFront, hallBack }.
   */
  townhouse(x, z, w, d, o = {}) { return buildTownhouse(this, x, z, w, d, o); }

  // ───────────────────────── props ─────────────────────────
  crate(x, z, s = 1, rot = 0, o = {}) {
    buildProp(this, 'crate', { x, z, s, rot, y: o.y ?? this.gy(x, z), tint: o.tint });
    return this.box(x, z, s, s, s, 'wood', { rot, tint: o.tint ?? 0xb8a58a, mat: 'wood', y: o.y, noVisual: true });
  }
  barrel(x, z) {
    const y = this.gy(x, z);
    buildProp(this, 'barrel', { x, z, y });
    return this.world.addBox({ x, y: y + 0.45, z, hx: 0.28, hy: 0.45, hz: 0.28, flags: WALL, mat: 'metal' });
  }
  sandbags(x, z, len, rot = 0, h = 1.05) {
    buildProp(this, 'sandbags', { x, z, y: this.gy(x, z), len, rot, h });
    return this.box(x, z, len, h, 0.6, 'cloth', { rot, mat: 'dirt', noVisual: true });
  }
  car(x, z, rot = 0, color = 0x4f5650) {
    const y = this.gy(x, z);
    buildCar(this, x, z, rot, color);
    this.world.addBox({ x, y: y + 0.75, z, hx: 0.9, hy: 0.75, hz: 2.1, rot, flags: WALL, mat: 'metal' });
  }
  dumpster(x, z, rot = 0) {
    const y = this.gy(x, z);
    buildProp(this, 'dumpster', { x, z, y, rot });
    this.world.addBox({ x, y: y + 0.6, z, hx: 0.95, hy: 0.62, hz: 0.5, rot, flags: WALL, mat: 'metal' });
    this.interact.push({ type: 'dumpster', x, z, y, r: 2.0 });
  }
  /** Street lamp or bare light. o: { h, r, i, post, flicker, color } */
  lamp(x, z, o = {}) {
    const y = this.gy(x, z), h = o.h ?? 4.2;
    if (o.post !== false) this.world.addBox({ x, y: y + h / 2, z, hx: 0.1, hy: h / 2, hz: 0.1, flags: F.SOLID | F.BULLET, mat: 'metal' });
    buildProp(this, 'lamp', { x, z, y, h, post: o.post !== false, color: o.color ?? 0xffd49a });
    this.lamps.push({ x, y: y + h - 0.2, z, r: o.r ?? 11, i: o.i ?? 1, flicker: !!o.flicker, color: o.color ?? 0xffc98a });
  }
  campfire(x, z) {
    const y = this.gy(x, z);
    buildProp(this, 'campfire', { x, z, y });
    this.lamps.push({ x, y: y + 0.6, z, r: 11, i: 1.1, flicker: true, color: 0xff9a4a });
    this.fires.push({ x, y: y + 0.4, z });
  }
  tent(x, z, rot = 0) {
    const y = this.gy(x, z);
    buildProp(this, 'tent', { x, z, y, rot });
    this.world.addBox({ x, y: y + 0.8, z, hx: 1.8, hy: 0.8, hz: 1.1, rot, flags: F.SOLID | F.VISION, mat: 'dirt' });
  }
  ladder(x, z, rot, h) {
    const y = this.gy(x, z), c = Math.cos(rot), s = Math.sin(rot);
    buildProp(this, 'ladder', { x, z, y, rot, h });
    // (x,z) is the foot; `rot` faces away from the wall, so the top exit is one step behind it
    this.ladders.push({ x, z, y0: y, y1: y + h, rot, tx: x - s * 0.9, tz: z - c * 0.9 });
  }
  /** Flight of steps rising along −Z in local space, rotated by rot. */
  stairs(x, z, rot, w, rise, run) {
    const n = Math.max(1, Math.round(rise / 0.26)), sh = rise / n, sd = run / n;
    const c = Math.cos(rot), s = Math.sin(rot), y = this.gy(x, z);
    for (let i = 0; i < n; i++) {
      const lz = -(i + 0.5) * sd;
      this.box(x + lz * s, z + lz * c, w, sh * (i + 1), sd + 0.02, 'stone', { y, rot, tint: 0xc8c4b8, noVisual: true });
    }
    buildProp(this, 'stairs', { x, z, y, rot, w, rise, run });
  }
  tree(x, z, s = 1, kind = 0) {
    this.trees.push({ x, z, s, kind, r: hash2(x * 31, z * 17) * 6.28 });
    this.world.addBox({ x, y: this.gy(x, z) + 3 * s, z, hx: 0.22 * s, hy: 3 * s, hz: 0.22 * s, flags: F.SOLID | F.VISION | F.BULLET, mat: 'wood' });
  }
  rock(x, z, s = 1) {
    this.rocks.push({ x, z, s, r: hash2(x * 13, z * 7) * 6.28 });
    this.world.addBox({ x, y: this.gy(x, z) + s * 0.35, z, hx: s * 0.75, hy: s * 0.55, hz: s * 0.75, rot: 0.6, flags: WALL, mat: 'rock' });
  }
  /** Bush: no collision, hides the player and any body dropped inside it. */
  bush(x, z, r = 1.6) {
    this.bushes.push({ x, z, r });
    this.foliage.push({ x, z, r: r * 0.95 });
  }
  /** Removable barricade between sectors. */
  barrier(id, x1, z1, x2, z2) {
    const len = Math.hypot(x2 - x1, z2 - z1), rot = Math.atan2(-(z2 - z1), x2 - x1), cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;
    const y = this.gy(cx, cz);
    const mesh = buildBarrier(this, len); mesh.position.set(cx, y, cz); mesh.rotation.y = rot;
    this.group.add(mesh);
    const col = this.world.addBox({ x: cx, y: y + 1.2, z: cz, hx: len / 2, hy: 1.3, hz: 0.25, rot, flags: F.SOLID | F.VISION | F.BULLET, mat: 'wood' });
    this.barriers.push({ id, mesh, col, open: false });
  }
  openBarrier(id) {
    for (const b of this.barriers) if (b.id === id && !b.open) { b.open = true; this.world.removeCollider(b.col); b.mesh.visible = false; }
  }
  /** Comms relay: optional C4 target that stops reinforcements. */
  relay(x, z) {
    const y = this.gy(x, z);
    const mesh = buildRelay(this); mesh.position.set(x, y, z); this.group.add(mesh);
    const col = this.world.addBox({ x, y: y + 0.6, z, hx: 0.7, hy: 0.6, hz: 0.45, flags: WALL, mat: 'metal', tag: 'relay' });
    const it = { type: 'relay', x, z, y, r: 2.6, alive: true, mesh, col };
    this.interact.push(it); this.relayObj = it;
  }
  // ───────────────────────── vehicles and artillery ─────────────────────────
  // Records for vehicles.js, which builds and runs them after finalize(). The
  // parked kinds put their collision boxes in now, so the nav grid routes
  // round them; the tank's moving boxes are added later and stay off the grid.
  /** Patrolling tank. o: { route: [[x, z, wait], ...], loop, reverse, yaw, scanYaw, sectors } */
  tank(o) { (this.vehicles ||= []).push({ kind: 'tank', ...o }); }
  /** Towed howitzer in its firing position, barrel toward yaw `rot`, ammunition crates beside it. */
  gun(x, z, rot = 0) { return this._vehicle('gun', x, z, rot); }
  /** Mortar in a ring of sandbags (open at the back), firing toward yaw `rot`. */
  mortar(x, z, rot = 0) {
    for (let i = 0; i < 5; i++) {
      const a = rot + (i - 2) * 0.95, r = 1.9;       // five sides of a hexagon; the gap is behind the tube
      this.sandbags(x - Math.sin(a) * r, z - Math.cos(a) * r, 2.1, a, 0.8);
    }
    return this._vehicle('mortar', x, z, rot);
  }
  /** Parked armoured personnel carrier (scenery and hard cover; C4 destroys it). */
  apc(x, z, rot = 0) { return this._vehicle('apc', x, z, rot); }
  _vehicle(kind, x, z, rot) {
    const y = this.gy(x, z), c = Math.cos(rot), s = Math.sin(rot), def = { kind, x, z, y, rot, cols: [] };
    for (const b of staticColliders(kind)) {
      def.cols.push(this.world.addBox({ x: x + b.x * c + b.z * s, y: y + b.y, z: z - b.x * s + b.z * c, hx: b.hx, hy: b.hy, hz: b.hz, rot, flags: b.flags ?? (F.SOLID | F.VISION | F.BULLET), mat: 'armor', tag: kind }));
    }
    (this.vehicles ||= []).push(def);
    return def;
  }
  flagpole(x, z) {
    const f = buildFlagpole(9);
    f.group.position.set(x, this.gy(x, z), z);
    this.group.add(f.group);
    buildFlagBase(this, x, this.gy(x, z), z);
    this.world.addBox({ x, y: this.gy(x, z) + 1, z, hx: 0.25, hy: 1.2, hz: 0.25, flags: F.SOLID | F.BULLET, mat: 'metal' });
    this.flag = f; f.x = x; f.z = z;
    this.interact.push({ type: 'flag', x, z, y: this.gy(x, z), r: 2.6 });
  }
  /**
   * Stylised twin-minaret mosque. Scenery only: solid, not enterable, and the
   * area around it is excluded from navigation so nothing ever fights there.
   */
  mosque(x, z, rot = 0) {
    const y = this.gy(x, z), c = Math.cos(rot), s = Math.sin(rot);
    const P = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    this.box(x, z, 18, 9, 14, 'stone', { y: y - 0.5, rot, tint: 0xd6cfbd, flags: F.SOLID | F.VISION | F.BULLET, noVisual: true });
    for (const lx of [-10.5, 10.5]) {
      const p = P(lx, 6);
      this.world.addBox({ x: p[0], y: y + 9, z: p[1], hx: 1.2, hy: 10, hz: 1.2, flags: F.SOLID | F.VISION | F.BULLET, mat: 'stone' });
    }
    buildMosque(this, x, y, z, rot);
    this.noWalk((px, pz) => Math.hypot(px - x, pz - z) < 22);
    this.sanctuary = { x, z, r: 22 };
  }
  /** Crenellated fortress wall segment. */
  rampart(x1, z1, x2, z2, h = 7) {
    this.wall(x1, z1, x2, z2, h, 2.2, 'stone', { tint: 0xc9c2b0, noVisual: true });
    buildRampart(this, x1, z1, x2, z2, h);     // masonry, wall-walk and battlements (visual only, as before)
  }

  // ───────────────────────── field fortifications and military dressing (military.js) ─────────────────────────
  // Local −Z of each piece is its front (field of fire, entrance, bonnet); soldiers in a position take face: rot.
  sanger(x, z, rot, o) { return MIL.sanger(this, x, z, rot, o); }
  trench(pts, face, o) { return MIL.trench(this, pts, face, o); }
  alacig(x, z, rot, o) { return MIL.alacig(this, x, z, rot, o); }
  leanTo(x, z, rot, o) { return MIL.leanTo(this, x, z, rot, o); }
  windbreak(x, z, rot, len) { return MIL.windbreak(this, x, z, rot, len); }
  watchtower(x, z, rot, o) { return MIL.watchtower(this, x, z, rot, o); }
  dugout(x, z, rot) { return MIL.dugout(this, x, z, rot); }
  mgNest(x, z, rot, o) { return MIL.mgNest(this, x, z, rot, o); }
  wire(x1, z1, x2, z2) { return MIL.wire(this, x1, z1, x2, z2); }
  hedgehog(x, z, rot) { return MIL.hedgehog(this, x, z, rot); }
  concreteBlock(x, z, rot) { return MIL.concreteBlock(this, x, z, rot); }
  roadBarrier(x, z, rot, len, o) { return MIL.roadBarrier(this, x, z, rot, len, o); }
  logBarricade(x, z, rot, len) { return MIL.logBarricade(this, x, z, rot, len); }
  camoNet(x, z, rot, w, d, h, o) { return MIL.camoNet(this, x, z, rot, w, d, h, o); }
  ammoStack(x, z, rot, n) { return MIL.ammoStack(this, x, z, rot, n); }
  shellCases(x, z, rot) { return MIL.shellCases(this, x, z, rot); }
  jerrycans(x, z, rot, n) { return MIL.jerrycans(this, x, z, rot, n); }
  generator(x, z, rot, o) { return MIL.generator(this, x, z, rot, o); }
  fieldKitchen(x, z, rot) { return MIL.fieldKitchen(this, x, z, rot); }
  bowser(x, z, rot) { return MIL.bowser(this, x, z, rot); }
  radioMast(x, z, h) { return MIL.radioMast(this, x, z, h); }
  stretcher(x, z, rot) { return MIL.stretcher(this, x, z, rot); }
  duckboards(x1, z1, x2, z2) { return MIL.duckboards(this, x1, z1, x2, z2); }
  latrine(x, z, rot) { return MIL.latrine(this, x, z, rot); }
  signpost(x, z, rot) { return MIL.signpost(this, x, z, rot); }
  truck(x, z, rot, kind, o) { return MIL.truck(this, x, z, rot, kind, o); }
  /** Build pieces on a flat surface at height y that the terrain does not know (a plateau box, a roof). */
  atHeight(y, fn) { const h = this.h; this.h = () => y; try { fn(); } finally { this.h = h; } }

  // ───────────────────────── gameplay data ─────────────────────────
  /** o: { x,z, y?, type, patrol:[[x,z,wait]], radio, torch, sector, fixed, face, wave } */
  enemy(o) { this.spawns.push({ type: 'rifle', sector: 0, ...o }); }
  pickup(type, x, z, o = {}) { this.pickups.push({ type, x, z, y: o.y, amount: o.amount ?? 1, taken: false, id: this.pickups.length }); }
  checkpoint(id, x, z, r, tier) { this.checkpoints.push({ id, x, z, r, tier, done: false }); }
  /** o: { radio, objective, wave, once=true, zOnly } */
  trigger(x, z, r, o) { this.triggers.push({ x, z, r, once: true, done: false, ...o }); }
  sector(id, nameKey, b) { this.sectors.push({ id, nameKey, ...b, cleared: false, alert: 0, reinforced: 0 }); }
  reinforceFrom(sector, x, z, dir, count) { this.reinforce.push({ sector, x, z, dir, count, used: false }); }
  sectorAt(x, z) {
    for (const s of this.sectors) if (x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ) return s;
    return null;
  }

  // ───────────────────────── finalize ─────────────────────────
  finalize() {
    const o = this.terrainOpts, b = this.bounds;
    // terrain mesh
    const step = o.step || 2, nx = Math.ceil((b.maxX - b.minX) / step), nz = Math.ceil((b.maxZ - b.minZ) / step);
    const pos = new Float32Array((nx + 1) * (nz + 1) * 3), col = new Float32Array((nx + 1) * (nz + 1) * 3), uv = new Float32Array((nx + 1) * (nz + 1) * 2);
    const tc = new THREE.Color(), us = TEX_SCALE[o.tex] || 4;
    for (let iz = 0; iz <= nz; iz++) for (let ix = 0; ix <= nx; ix++) {
      const x = b.minX + ix * step, z = b.minZ + iz * step, k = iz * (nx + 1) + ix;
      pos[k * 3] = x; pos[k * 3 + 1] = this.h(x, z); pos[k * 3 + 2] = z;
      tc.set(o.tint ? o.tint(x, z) : 0xffffff);
      const v = 0.86 + hash2(ix, iz) * 0.22;
      col[k * 3] = tc.r * v; col[k * 3 + 1] = tc.g * v; col[k * 3 + 2] = tc.b * v;
      uv[k * 2] = x / us; uv[k * 2 + 1] = z / us;
    }
    const idx = new Uint32Array(nx * nz * 6);
    let q = 0;
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const a = iz * (nx + 1) + ix, c = a + nx + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = a + 1; idx[q++] = a + 1; idx[q++] = c; idx[q++] = c + 1;
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    tg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    tg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    tg.setIndex(new THREE.BufferAttribute(idx, 1));
    tg.computeVertexNormals();
    const terrain = new THREE.Mesh(tg, worldMaterial(o.tex));
    terrain.receiveShadow = true;
    this.group.add(terrain);

    // static batches: one mesh per texture
    for (const [tex, geo] of this.batches) {
      if (!geo.count) continue;
      let mat;
      if (tex === 'glow') mat = new THREE.MeshBasicMaterial({ vertexColors: true });
      else if (tex === 'glow0') mat = worldMaterial(null);
      else mat = worldMaterial(tex, { side: tex === 'roof' || tex === 'cloth' ? THREE.DoubleSide : THREE.FrontSide });
      const m = new THREE.Mesh(geo.build(), mat);
      m.castShadow = tex !== 'glow'; m.receiveShadow = tex !== 'glow';
      this.group.add(m);
    }

    // vegetation (procedural, see nature.js)
    this.nature = buildNature(this);

    // pickups
    for (const p of this.pickups) {
      p.y = p.y ?? this.gy(p.x, p.z);
      p.mesh = buildPickup(p.type);
      p.mesh.position.set(p.x, p.y, p.z);
      p.mesh.rotation.y = hash2(p.x * 3, p.z * 5) * 6.28;
      this.group.add(p.mesh);
    }

    const noWalk = this.noWalkFns.length ? (x, z) => this.noWalkFns.some((fn) => fn(x, z)) : null;
    this.nav = new NavGrid(this.world, noWalk);
    this._buildMap();
    finalizeStructures(this);
    finalizeInteriors(this);
    G.scene.add(this.group);
    R.setLamps(this.lamps.filter((l) => !l.noLight));
    return this;
  }

  /** Top-down map image for the minimap and the full map screen. */
  /**
   * Terrain at one sample per metre (surface colour, roads and squares picked out by their
   * lighter tint, brightened with height and hill-shaded from the north-west), then bushes,
   * tree canopies, rocks, enterable floors, and every solid collider by kind: walls and
   * ramparts as light strokes, buildings as roofs with a drop shadow and outline (a house's
   * ridge box draws as its tin ridge), low cover as small dark blocks. Built once per act.
   */
  _buildMap() {
    const b = this.bounds, s = 3, w = Math.ceil((b.maxX - b.minX) * s), h = Math.ceil((b.maxZ - b.minZ) * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    const to = this.terrainOpts || {}, surf = to.surface, tint = to.tint;
    const nx = Math.ceil(b.maxX - b.minX) + 1, nz = Math.ceil(b.maxZ - b.minZ) + 1, n = nx * nz;
    const hgt = new Float32Array(n), lum = new Float32Array(n), kind = new Array(n);
    let lo = Infinity, hi = -Infinity, lsum = 0;
    for (let iz = 0, i = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++, i++) {
      const x = b.minX + ix, z = b.minZ + iz, v = this.h(x, z);
      hgt[i] = v; if (v < lo) lo = v; if (v > hi) hi = v;
      kind[i] = surf ? surf(x, z) : 'grass';
      const tv = tint ? tint(x, z) : 0x9a9a9a;
      lum[i] = ((tv >> 16 & 255) * 0.3 + (tv >> 8 & 255) * 0.59 + (tv & 255) * 0.11) / 255; lsum += lum[i];
    }
    const range = hi - lo > 0.5 ? hi - lo : 0, lmean = lsum / n;          // flat acts (the cliff) get no height tint
    const BASE = { grass: [42, 56, 44], dirt: [80, 71, 54], stone: [66, 68, 66], cobble: [66, 68, 66], rock: [64, 63, 60], wood: [70, 58, 44], metal: [60, 62, 64] };
    const tc = document.createElement('canvas'); tc.width = nx; tc.height = nz;
    const tg = tc.getContext('2d'), img = tg.createImageData(nx, nz), d = img.data;
    const Lx = -0.55, Ly = 0.75, Lz = -0.55;                                 // light from the north-west, above
    for (let iz = 0, i = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++, i++) {
      const col = BASE[kind[i]] || [40, 46, 48];
      const dx = (hgt[iz * nx + Math.min(nx - 1, ix + 1)] - hgt[iz * nx + Math.max(0, ix - 1)]) / 2;
      const dz = (hgt[Math.min(nz - 1, iz + 1) * nx + ix] - hgt[Math.max(0, iz - 1) * nx + ix]) / 2;
      const nl = Math.hypot(dx, 1, dz), shade = Math.min(1.35, Math.max(0.45, 0.35 + 0.9 * ((-dx * Lx + Ly - dz * Lz) / nl)));
      const elev = range ? 0.82 + (hgt[i] - lo) / range * 0.36 : 1;
      const road = Math.min(1.4, Math.max(0.8, 1 + (lum[i] - lmean) * 2.6));
      const k = shade * elev * road;
      d[i * 4] = Math.min(255, col[0] * k); d[i * 4 + 1] = Math.min(255, col[1] * k); d[i * 4 + 2] = Math.min(255, col[2] * k); d[i * 4 + 3] = 255;
    }
    tg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(tc, -s / 2, -s / 2, nx * s, nz * s);
    const X = (x) => (x - b.minX) * s, Z = (z) => (z - b.minZ) * s;
    // vegetation and rocks
    g.fillStyle = 'rgba(45,74,49,0.8)';
    for (const f of this.bushes) { g.beginPath(); g.arc(X(f.x), Z(f.z), f.r * s, 0, 6.283); g.fill(); }
    for (const tr of this.rocks) { g.fillStyle = '#6f6b63'; g.beginPath(); g.arc(X(tr.x), Z(tr.z), 0.8 * tr.s * s, 0, 6.283); g.fill(); }
    for (const tr of this.trees) {
      const r = (tr.kind ? 1.8 : 2.4) * tr.s * s, x = X(tr.x), z = Z(tr.z);
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.arc(x + 2, z + 2, r, 0, 6.283); g.fill();
      g.fillStyle = tr.kind ? '#24402a' : '#1d3624'; g.strokeStyle = '#2f5236'; g.lineWidth = 1;
      g.beginPath(); g.arc(x, z, r, 0, 6.283); g.fill(); g.stroke();
      g.fillStyle = '#43674a'; g.beginPath(); g.arc(x - r * 0.2, z - r * 0.2, Math.max(1, r * 0.22), 0, 6.283); g.fill();
    }
    // enterable buildings: floors under their walls
    for (const r of this.indoor) {
      g.save(); g.translate(X(r.x), Z(r.z)); g.rotate(-Math.atan2(r.s, r.c));
      g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(-r.hx * s + 2, -r.hz * s + 2, r.hx * 2 * s, r.hz * 2 * s);
      g.fillStyle = '#5c574d'; g.fillRect(-r.hx * s, -r.hz * s, r.hx * 2 * s, r.hz * 2 * s);
      g.restore();
    }
    // solid colliders, low first so roofs and walls end up on top
    const ROOF = { stone: '#8b8374', plaster: '#9b907d', concrete: '#83837d', metal: '#7a5f4b', rock: '#77736b', wood: '#7d6648', woodThin: '#8a6f4e', armor: '#4c5446' };
    const list = [];
    for (const col of this.world.colliders) {
      if (col.dead || !(col.flags & F.SOLID) || col.hx * col.hz < 0.05) continue;
      if (col.tag === 'gun' || col.tag === 'mortar' || col.tag === 'apc' || col.tag === 'tank' || col.tag === 'relay') continue;
      const top = col.y + col.hy - this.h(col.x, col.z);
      if (top < 0.45) continue;
      list.push({ col, top });
    }
    list.sort((a, b2) => a.top - b2.top);
    for (const { col, top } of list) {
      const thin = Math.min(col.hx, col.hz), long = Math.max(col.hx, col.hz);
      const hx = Math.max(col.hx * s, 0.8), hz = Math.max(col.hz * s, 0.8);
      g.save(); g.translate(X(col.x), Z(col.z)); g.rotate(-col.rot);
      if (thin < 0.6 && long > 0.9 && top > 0.9) {                                  // wall or fence
        g.fillStyle = col.mat === 'woodThin' || col.mat === 'wood' ? '#9a7d58' : '#c4baa2';
        g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 1;
        g.strokeRect(-hx - 0.5, -hz - 0.5, hx * 2 + 1, hz * 2 + 1); g.fillRect(-hx, -hz, hx * 2, hz * 2);
      } else if (thin >= 0.9 && top > 4 && long / thin > 3 && col.mat !== 'rock') {                     // rampart
        g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(-hx + 2, -hz + 2, hx * 2, hz * 2);
        g.fillStyle = '#cbc1a7'; g.fillRect(-hx, -hz, hx * 2, hz * 2);
        g.strokeStyle = '#5b5446'; g.lineWidth = 1.2; g.strokeRect(-hx, -hz, hx * 2, hz * 2);
        g.strokeStyle = 'rgba(91,84,70,0.6)'; g.setLineDash([2, 3]); g.beginPath();
        if (col.hx > col.hz) { g.moveTo(-hx, 0); g.lineTo(hx, 0); } else { g.moveTo(0, -hz); g.lineTo(0, hz); }
        g.stroke(); g.setLineDash([]);
      } else if (top > 2.4) {                                                        // building, roof, tall rock
        g.fillStyle = 'rgba(0,0,0,0.42)'; g.fillRect(-hx + 2.5, -hz + 2.5, hx * 2, hz * 2);
        g.fillStyle = ROOF[col.mat] || '#8f8a7c'; g.fillRect(-hx, -hz, hx * 2, hz * 2);
        g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(-hx, -hz, hx * 2, Math.min(hz, 2));
        g.strokeStyle = '#2b2925'; g.lineWidth = 1.2; g.strokeRect(-hx, -hz, hx * 2, hz * 2);
      } else {                                                                        // low cover: crates, sandbags, cars
        g.fillStyle = '#56534b'; g.fillRect(-hx, -hz, hx * 2, hz * 2);
        g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 0.8; g.strokeRect(-hx, -hz, hx * 2, hz * 2);
      }
      g.restore();
    }
    this.map = { canvas: c, scale: s, minX: b.minX, minZ: b.minZ };
  }

  // ───────────────────────── runtime queries ─────────────────────────
  inFoliage(x, z) {
    for (let i = 0; i < this.foliage.length; i++) { const f = this.foliage[i], dx = x - f.x, dz = z - f.z; if (dx * dx + dz * dz < f.r * f.r) return true; }
    return false;
  }
  isIndoor(x, y, z) {
    for (let i = 0; i < this.indoor.length; i++) {
      const b = this.indoor[i], dx = x - b.x, dz = z - b.z, lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c;
      if (Math.abs(lx) < b.hx && Math.abs(lz) < b.hz && y >= b.y0 - 0.2 && y < b.y1) return true;
    }
    return false;
  }
  /**
   * Light level 0..1 at a point: ambient (time of day, darker indoors) plus
   * every lamp or fire that reaches it with a clear line, plus enemy torches.
   */
  lightAt(x, y, z) {
    let l = R.lightLevel * (this.isIndoor(x, y, z) ? 0.3 : 1);
    for (let i = 0; i < this.lamps.length; i++) {
      const lamp = this.lamps[i];
      if (lamp.off) continue;
      const c = lampContribution(lamp, x, y, z);
      if (c > 0.02 && this.world.los(lamp.x, lamp.y, lamp.z, x, y + 1, z)) l += c;
    }
    for (let i = 0; i < this.beams.length; i++) {
      const e = this.beams[i];
      if (e.dead || !e.torchOn) continue;
      const dx = x - e.x, dz = z - e.z, d = Math.hypot(dx, dz);
      if (d > 17 || d < 0.3) continue;
      const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
      if ((dx * fx + dz * fz) / d > 0.955 && this.world.los(e.x, e.y + 1.4, e.z, x, y + 1, z)) l += 0.85 * (1 - d / 17);
    }
    return clamp01(l);
  }

  update(dt, time) {
    for (const p of this.pickups) if (!p.taken && p.mesh.userData.glow) p.mesh.userData.glow.material.opacity = 0.45 + Math.sin(time * 3 + p.id) * 0.3;
    if (this.flag) this.flag.update(time);
    if (this.doorSys) this.doorSys.update(dt);
  }

  dispose() {
    if (this.doorSys) this.doorSys.dispose();
    G.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material !== vcMaterial() && o.material !== vcMaterial(true)) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) m.dispose(); }
    });
    R.setLamps([]);
  }
}

function matOf(tex) {
  return { stone: 'stone', plaster: 'stone', cobble: 'stone', rock: 'rock', roof: 'metal', wood: 'wood', cloth: 'dirt', concrete: 'stone', metal: 'metal', dark: 'stone', dirt: 'dirt', forest: 'grass' }[tex] || 'stone';
}
void PAL;
