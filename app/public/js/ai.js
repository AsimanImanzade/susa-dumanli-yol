/**
 * ai.js — enemy soldiers: perception, the state machine's behaviours,
 * movement on the nav grid, shooting, grenades, bodies, radio check-ins,
 * sector alerts and reinforcements.
 *
 * The transition rules themselves live in ai-fsm.js (pure, unit-tested).
 * This file decides WHAT an enemy does while in each state:
 *
 *   PATROL      walk the route, pause at waypoints; fixed sentries scan
 *   SUSPICIOUS  walk to the glimpse / noise, look around, then go back
 *   SEARCHING   run to the last known position, call nearby teammates, sweep
 *               random points around it until the search time runs out
 *   COMBAT      shout for backup, take cover, fire bursts when the player is
 *               visible, suppress the last known position for a few seconds
 *               when not, throw grenades, flank (always on Hard)
 */
import { G, bus, clamp, clamp01, dampAngle, angDelta, yawTo, dist2D } from './ctx.js';
import { AI, STEALTH, NOISE, THROW, PLAYER } from './config.js';
import { S, STIM, nextState, alertLevel, noiseStimulus } from './ai-fsm.js';
import { visibility, sightRange, detectionRate, stepMeter } from './stealth.js';
import { rayVsSoldier, soldierHeadLocal, soldierHeadWorld } from './ballistics.js';
import { noise, hears } from './noise.js';
import { buildBeam } from './models.js'; import { buildSoldier } from './soldier-model.js';
import { steer, coast, moveLimits, paceFor, headingOf, clearLine } from './locomotion.js';
import { F } from './physics.js';
import { audio } from './audio.js';
import { fx } from './fx.js';
import { R } from './render.js';
import { t } from './loc.js';

let nextId = 1;
let thinkSlot = 0;

class Enemy {
  constructor(def, level) {
    this.id = nextId++;
    this.def = def; this.type = def.type || 'rifle'; this.sector = def.sector || 0;
    this.x = def.x; this.z = def.z;
    this.fixed = !!def.fixed;
    this.y = def.y ?? level.gy(def.x, def.z);
    this.yaw = def.face ?? 0; this.baseYaw = this.yaw;
    this.hp = AI.hp[this.type] || 100;
    this.state = S.PATROL; this.meter = 0; this.alive = true; this.dead = false;
    this.patrol = (def.patrol || []).map((p) => ({ x: p[0], z: p[1], wait: p[2] ?? 2 }));
    this.pIdx = 0; this.waitT = 0;
    this.path = []; this.pi = 0; this.pathT = 0; this.speed = 0; this.moving = false; this.lookYaw = null;
    this.goalX = this.x; this.goalZ = this.z;
    this.lkx = this.x; this.lkz = this.z;           // last known player position
    this.stateT = 0; this.seen = false; this.lastSeenT = -100; this.dist = 999;
    this.aimT = 0; this.burst = 0; this.shotT = 0; this.pauseT = 0;
    this.coverT = 0; this.inCover = false; this.flanker = false;
    this.grenadeT = AI.grenadeCooldown * (0.4 + G.rng() * 0.8);
    this.stunT = 0; this.tagT = 0;
    this.radio = !!def.radio; this.checkinT = AI.checkinPeriod * (0.5 + G.rng() * 0.5); this.checkinMissed = false;
    this.torchOn = !!def.torch;
    this.thinkT = (thinkSlot++ % 6) / 60;
    this.hidden = false; this.discovered = false; this.dragged = false; this.gone = false;
    this.wasUnaware = true;
    // movement: a velocity that builds and bleeds off (locomotion.js), each soldier at his own pace
    this.loco = { x: this.x, z: this.z, spd: 0, hd: this.yaw, sx: this.x, sz: this.z, pi: 0, face: this.yaw, faceFollows: true };
    this.pace = paceFor(this.id, AI.loco.pace[0], AI.loco.pace[1]);
    this.stuckT = 0; this.stuckX = this.x; this.stuckZ = this.z; this.stuckN = 0; this.prevYaw = this.yaw;
    const { mesh, rig } = buildSoldier(this.type);
    this.mesh = mesh; this.rig = rig;
    // feet land on the terrain under them (rooftop sentries stand on a flat roof the terrain knows nothing of)
    if (!this.fixed && rig.setGround) rig.setGround((x, z) => G.world.h(x, z));
    mesh.position.set(this.x, this.y, this.z); mesh.rotation.y = this.yaw;
    if (def.torch) { this.beam = buildBeam(15, 3); this.beam.position.set(0.15, 1.3, -0.4); mesh.add(this.beam); level.beams.push(this); }
    G.scene.add(mesh);
  }
  /** Height of his eyes (the animated head centre, same source as the hit test). */
  eyeY() { return this.y + soldierHeadLocal(this.rig, _eyeL).y; }
}

const _hit = {}, _zone = {}, _eyeL = { x: 0, y: 0, z: 0 };
const DARK_BODY_LIGHT = 0.22, DARK_BODY_RANGE = 3.5;   // bodies left in unlit rooms
const _lim = {}, _st = { vx: 0, vz: 0, want: 0, lookX: 0, lookZ: 0, done: false };

/**
 * Can a soldier stand at (x, z)? A free nav cell, or — when the cell is blocked
 * only by the grid's padding — no solid wall/prop within a body radius of 0.28 m
 * (the same overlap test the nav grid is built with, at the body's real size).
 */
let _fitHit = false, _fitX = 0, _fitZ = 0, _fitH = 0;
const BODY_R = 0.28;
function fitCell(cell) {
  if (_fitHit) return;
  for (let k = 0; k < cell.length; k++) {
    const c = cell[k];
    if (!(c.flags & F.SOLID)) continue;
    if (c.y + c.hy < _fitH + 0.45 || c.y - c.hy > _fitH + 1.7) continue;
    const dx = _fitX - c.x, dz = _fitZ - c.z, lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
    if (Math.abs(lx) <= c.hx + BODY_R && Math.abs(lz) <= c.hz + BODY_R) { _fitHit = true; return; }
  }
}
function walkOk(nav, x, z) {
  if (nav.isFree(x, z)) return true;
  if (nav.idx(x, z) < 0) return false;
  const nw = G.level && G.level.noWalkFns;                 // places nobody may set foot (the mosque grounds)
  if (nw) for (let i = 0; i < nw.length; i++) if (nw[i](x, z)) return false;
  const w = G.world;
  _fitHit = false; _fitX = x; _fitZ = z; _fitH = w.h(x, z);
  if (Math.abs(w.h(x + 0.3, z) - w.h(x - 0.3, z)) > 0.5 || Math.abs(w.h(x, z + 0.3) - w.h(x, z - 0.3)) > 0.5) return false;   // too steep
  w._each(x - BODY_R, z - BODY_R, x + BODY_R, z + BODY_R, fitCell);
  return !_fitHit;
}

export const ai = {
  globalAlert: 0,
  combatT: 0,
  lostLine: false,
  waves: {},

  reset() {
    for (const e of G.enemies) { G.scene.remove(e.mesh); e.mesh.skeleton.dispose(); }   // frees each skeleton's bone texture
    G.enemies.length = 0; G.bodies.length = 0;
    this.globalAlert = 0; this.combatT = 0; this.waves = {}; this.checkinSaid = false;
    nextId = 1;
  },

  /** Spawn every enemy of the level except those in already-cleared sectors or held-back waves. */
  spawnAll(level, clearedSectors = []) {
    for (const def of level.spawns) {
      if (clearedSectors.includes(def.sector)) continue;
      if (def.wave) { (this.waves[def.wave] ||= []).push(def); continue; }
      G.enemies.push(new Enemy(def, level));
    }
  },
  /** Release a held-back wave; arrivals already know roughly where the player is. */
  triggerWave(name) {
    const defs = this.waves[name];
    if (!defs) return 0;
    delete this.waves[name];
    const p = G.player;
    for (const def of defs) {
      const e = new Enemy(def, G.level);
      G.enemies.push(e);
      e.lkx = p.x; e.lkz = p.z;
      this._enter(e, S.SEARCHING);
    }
    return defs.length;
  },
  pendingWaves() { let n = 0; for (const k in this.waves) n += this.waves[k].length; return n; },
  aliveIn(sector) { let n = 0; for (const e of G.enemies) if (e.alive && e.sector === sector) n++; return n; },
  aliveTotal() { let n = 0; for (const e of G.enemies) if (e.alive) n++; return n; },

  // ───────────────────────── noise ─────────────────────────
  onNoise(evt) {
    if (evt.byEnemy) return;
    const w = G.world;
    for (const e of G.enemies) {
      if (!e.alive || e.state === S.STUNNED || e === evt.source) continue;
      const ex = e.x, ey = e.y + 1.5, ez = e.z;
      const dx = ex - evt.x, dz = ez - evt.z;
      if (dx * dx + dz * dz > evt.radius * evt.radius) continue;
      const loud = hears(evt, ex, ey, ez, !w.los(evt.x, evt.y + 1, evt.z, ex, ey, ez));
      if (!loud) continue;
      if (G.vehicles && G.vehicles.masks(evt, ex, ez, loud)) continue;   // lost under a tank engine or a gun's report
      // How well the source can be placed: a loud shot far away only gives a
      // direction (error grows with distance); a quiet sound nearby is vague.
      const d = Math.sqrt(dx * dx + dz * dz);
      const err = evt.kind === 'shot' ? d * 0.22 : evt.kind === 'shot_suppressed' ? 4 + d * 0.3 : evt.kind === 'distraction' ? 0.5 : 1.5;
      const a = G.rng() * 6.283, r = G.rng() * err;
      this.stim(e, noiseStimulus(evt.kind), evt.x + Math.cos(a) * r, evt.z + Math.sin(a) * r);
    }
  },

  // ───────────────────────── state machine glue ─────────────────────────
  /** Deliver a stimulus with the position it points at. */
  stim(e, stim, px, pz, relay = true) {
    if (!e.alive) return;
    const ns = nextState(e.state, stim);
    if (px !== undefined && e.state !== S.COMBAT) {
      if (ns === S.SUSPICIOUS || ns === S.SEARCHING || ns === S.COMBAT) { e.lkx = px; e.lkz = pz; if (ns === e.state) this._goto(e, px, pz, true); }
    }
    if (ns !== e.state) this._enter(e, ns, relay);
  },

  _enter(e, state, relay = true) {
    const prev = e.state;
    e.state = state; e.stateT = 0; e.inCover = false; e.lookYaw = null;
    const diff = G.mission.diff;
    switch (state) {
      case S.PATROL:
        e.rig.setAim(false); e.rig.setCrouch(false); e.meter = Math.min(e.meter, 0.2);
        if (e.patrol.length) this._goto(e, e.patrol[e.pIdx].x, e.patrol[e.pIdx].z, true); else this._goto(e, e.def.x, e.def.z, true);
        break;
      case S.SUSPICIOUS:
        e.rig.setAim(false);
        this._goto(e, e.lkx, e.lkz, true);
        if (prev === S.PATROL) audio.play('shout', { x: e.x, y: e.y + 1.6, z: e.z, vol: 0.35, rate: 1.15, ref: 5 });
        break;
      case S.SEARCHING:
        e.rig.setAim(true); e.rig.setCrouch(false);
        e.searchT = diff.searchTime * (0.85 + G.rng() * 0.3);
        e.meter = Math.max(e.meter, STEALTH.suspiciousAt);
        this._goto(e, e.lkx, e.lkz, true);
        // call nearby teammates in on the search (one hop only)
        if (relay && prev !== S.COMBAT) for (const o of G.enemies) {
          if (o !== e && o.alive && o.state === S.PATROL && dist2D(e.x, e.z, o.x, o.z) < AI.callRadius) {
            const p = G.nav.randomNear(e.lkx, e.lkz, 6, G.rng);
            this.stim(o, STIM.ALLY_SEARCH, p.x, p.z, false);
          }
        }
        break;
      case S.COMBAT:
        e.rig.setAim(true);
        e.aimT = e.type === 'sniper' ? 1.4 : AI.aimTime * (0.7 + G.rng() * 0.6);
        e.burst = 0; e.coverT = 0; e.lastSeenT = G.simTime; e.meter = 1;
        e.flanker = !e.fixed && (diff.flank ? G.rng() < 0.45 : G.rng() < 0.15);
        audio.play('shout', { x: e.x, y: e.y + 1.6, z: e.z, vol: 0.8, ref: 8 });
        // shout for backup: those in earshot join the fight, the rest of the sector searches
        if (relay) for (const o of G.enemies) {
          if (o === e || !o.alive || o.state === S.COMBAT) continue;
          const d = dist2D(e.x, e.z, o.x, o.z);
          if (d < AI.callRadius) { o.lkx = e.lkx; o.lkz = e.lkz; this.stim(o, STIM.ALLY_CALL, e.lkx, e.lkz, false); }
          else if (d < AI.backupRadius || o.sector === e.sector) this.stim(o, STIM.ALLY_SEARCH, e.lkx, e.lkz, false);
        }
        break;
      case S.STUNNED:
        e.rig.setStun(true); e.rig.setAim(false); e.path.length = 0; e.moving = false;
        break;
    }
    if (prev === S.STUNNED && state !== S.STUNNED) e.rig.setStun(false);
  },

  _goto(e, x, z, force) {
    if (e.fixed) { e.lookYaw = yawTo(e.x, e.z, x, z); return; }
    if (!force && G.simTime - e.pathT < 0.6) return;
    e.pathT = G.simTime; e.goalX = x; e.goalZ = z; e.pi = 0;
    e.loco.sx = e.x; e.loco.sz = e.z;                 // the first segment starts where he stands
    e.stuckT = 0; e.stuckX = e.x; e.stuckZ = e.z;
    const nav = G.nav;
    // a goal authored inside a blocked cell is still walked to (as it always was): the wall guard spares that last leg
    e.goalBlocked = !nav.isFree(x, z);
    if (!nav.findPath(e.x, e.z, x, z, e.path)) { e.path.length = 0; return; }
    // the search starts from the centre of his nav cell: when the straight line from
    // where he actually stands to the first waypoint is not clear, step to that centre first
    if (e.path.length && !clearLine(nav, e.x, e.z, e.path[0].x, e.path[0].z, 0)) {
      const c = nav.nearestFree(e.x, e.z), i = c ? nav.idx(c.x, c.z) : -1;
      if (i >= 0) e.path.unshift({ x: nav.cx(i), z: nav.cz(i) });
    }
  },

  // ───────────────────────── perception ─────────────────────────
  /**
   * Run every think tick (10 Hz). Fills e.seen / e.dist and advances the
   * detection meter using the model documented in stealth.js.
   */
  _perceive(e, dt) {
    const p = G.player, w = G.world, diff = G.mission.diff;
    const ex = e.x, ey = e.eyeY(), ez = e.z;
    const dx = p.x - ex, dz = p.z - ez, d = Math.hypot(dx, dz);
    e.dist = d;
    let seen = false, rate = 0;
    if (!p.dead && !G.noDetect) {
      const al = alertLevel(e.state);
      // alert soldiers look harder: range stretches by 30% / 60%
      const range = sightRange(R.fogFactor(), p.light) * (al === 2 ? 1.6 : al === 1 ? 1.3 : 1);
      const angle = angDelta(e.yaw, yawTo(ex, ez, p.x, p.z));
      const vAngle = Math.atan2((p.y + 0.9) - ey, Math.max(0.5, d));
      const inCone = Math.abs(angle) < STEALTH.fovEdge && Math.abs(vAngle) < STEALTH.fovVertical;
      if ((inCone && d < range) || d < 1.3) {
        // two sight lines: to the head and to the chest; either is enough
        const hy = p.eyeY(), cy = p.y + p.eye * 0.55;
        if (w.los(ex, ey, ez, p.x, hy, p.z) || w.los(ex, ey, ez, p.x, cy, p.z)) {
          seen = true;
          const vis = visibility(p.stance, p.speedFrac, p.light, p.inFoliage);
          rate = detectionRate({ dist: d, range, angle: d < 1.3 ? 0 : angle, vis, diffMult: diff.detectMult, alert: al });
        }
      }
    }
    e.seen = seen && rate > 0;
    e.meter = stepMeter(e.meter, rate, e.seen, dt);

    if (e.state !== S.COMBAT) {
      if (e.meter >= STEALTH.spottedAt) { e.lkx = p.x; e.lkz = p.z; this.stim(e, STIM.SPOTTED, p.x, p.z); }
      else if (e.meter >= STEALTH.suspiciousAt && e.seen) {
        if (e.state === S.PATROL) this.stim(e, STIM.GLIMPSE, p.x, p.z);
        else if (e.state === S.SUSPICIOUS) { e.lkx = p.x; e.lkz = p.z; }       // keep tracking the glimpse
      }
    } else if (e.seen) { e.lkx = p.x; e.lkz = p.z; e.lastSeenT = G.simTime; }
    else if (G.simTime - e.lastSeenT > diff.loseSight) this.stim(e, STIM.LOST_SIGHT);

    // bodies: an unhidden body in view puts the whole sector on a search
    if (e.state !== S.COMBAT) for (const b of G.bodies) {
      if (b.hidden || b.discovered || b.gone) continue;
      const bd = dist2D(ex, ez, b.x, b.z);
      if (bd > STEALTH.bodySeeRange || (b.dark && bd > DARK_BODY_RANGE)) continue;   // a body in an unlit room is only found up close
      if (Math.abs(angDelta(e.yaw, yawTo(ex, ez, b.x, b.z))) > STEALTH.fovEdge && bd > 2) continue;
      if (!w.los(ex, ey, ez, b.x, b.y + 0.4, b.z)) continue;
      b.discovered = true;
      this.sectorAlert(e.sector, STIM.BODY_FOUND, b.x, b.z);
      bus.emit('toast', t('bodyFound'), 'warn');
      audio.play('alert', { vol: 0.6, ui: true });
      break;
    }
  },

  /** A vehicle crew that spots the player calls it in like a soldier's shout (vehicles.js). */
  alertFrom(x, z, lkx, lkz, sector) {
    for (const o of G.enemies) {
      if (!o.alive || o.state === S.COMBAT || o.state === S.STUNNED) continue;
      const d = dist2D(x, z, o.x, o.z);
      if (d < AI.callRadius) { o.lkx = lkx; o.lkz = lkz; this.stim(o, STIM.ALLY_CALL, lkx, lkz, false); }
      else if (d < AI.backupRadius || o.sector === sector) this.stim(o, STIM.ALLY_SEARCH, lkx, lkz, false);
    }
  },

  /** Put every living soldier of a sector on alert around a position. */
  sectorAlert(sector, stim, x, z) {
    for (const o of G.enemies) {
      if (!o.alive || o.sector !== sector) continue;
      const p = G.nav.randomNear(x, z, 7, G.rng);
      this.stim(o, stim, p.x, p.z, false);
    }
  },

  // ───────────────────────── behaviours ─────────────────────────
  _think(e, dt) {
    const nav = G.nav, p = G.player;
    e.stateT += dt;
    switch (e.state) {
      case S.PATROL:
        if (e.fixed) { e.lookYaw = e.baseYaw + Math.sin(G.simTime * 0.35 + e.id) * 0.9; break; }
        if (!e.patrol.length) { if (!e.moving) e.lookYaw = e.baseYaw + Math.sin(G.simTime * 0.3 + e.id) * 0.5; break; }
        if (!e.moving) {
          e.waitT -= dt;
          if (e.waitT <= 0) {
            const here = e.patrol[e.pIdx];
            if (dist2D(e.x, e.z, here.x, here.z) < 1.2) { e.pIdx = (e.pIdx + 1) % e.patrol.length; e.waitT = e.patrol[e.pIdx].wait; }
            this._goto(e, e.patrol[e.pIdx].x, e.patrol[e.pIdx].z, true);
          } else e.lookYaw = e.yaw + Math.sin(G.simTime * 0.8 + e.id) * 0.02;
        }
        break;

      case S.SUSPICIOUS:
        if (!e.fixed && !e.moving && dist2D(e.x, e.z, e.goalX, e.goalZ) > 1.5 && e.stateT < 1) this._goto(e, e.lkx, e.lkz, true);
        if (!e.moving || e.fixed) {
          // arrived: sweep the area with his eyes, then give up
          e.lookT = (e.lookT || 0) + dt;
          e.lookYaw = yawTo(e.x, e.z, e.lkx, e.lkz) + Math.sin(e.lookT * 1.6) * 1.2;
          if (e.lookT > AI.suspiciousLook) { e.lookT = 0; this.stim(e, STIM.INVESTIGATED); }
        } else e.lookT = 0;
        if (e.stateT > AI.suspiciousMax) { e.lookT = 0; this.stim(e, STIM.INVESTIGATED); }
        break;

      case S.SEARCHING:
        e.searchT -= dt;
        if (e.searchT <= 0) { this.stim(e, STIM.SEARCH_DONE); break; }
        if (e.fixed) { e.lookYaw = yawTo(e.x, e.z, e.lkx, e.lkz) + Math.sin(G.simTime * 0.9 + e.id) * 1.1; break; }
        if (!e.moving) {
          e.waitT -= dt;
          e.lookYaw = e.yaw + Math.sin(G.simTime * 2 + e.id) * 0.06 + dt * 1.2;
          if (e.waitT <= 0) {
            // next sweep point: wider on Hard so the search wraps around the player
            const r = G.mission.diff.flank ? 18 : 11;
            const pt = nav.randomNear(e.lkx, e.lkz, r, G.rng);
            this._goto(e, pt.x, pt.z, true);
            e.waitT = 1.2 + G.rng() * 1.6;
          }
        }
        break;

      case S.COMBAT: {
        e.coverT -= dt; e.grenadeT -= dt;
        const blind = G.simTime - e.lastSeenT;
        if (e.fixed) { e.lookYaw = yawTo(e.x, e.z, e.lkx, e.lkz); break; }
        if (e.coverT <= 0) {
          e.coverT = 2.5 + G.rng() * 2;
          if (e.flanker && e.dist > 9) {
            // circle to the player's side instead of sitting in front of him
            const a = yawTo(e.lkx, e.lkz, e.x, e.z) + (e.id % 2 ? 1.25 : -1.25);
            const pt = nav.nearestFree(e.lkx - Math.sin(a) * AI.flankDistance, e.lkz - Math.cos(a) * AI.flankDistance, 6);
            if (pt) this._goto(e, pt.x, pt.z, true);
          } else if (blind > 2.5) {
            // lost him: push up on the last known position
            const pt = nav.randomNear(e.lkx, e.lkz, 5, G.rng);
            this._goto(e, pt.x, pt.z, true);
          } else {
            const c = nav.findCover(e.x, e.z, p.x, p.eyeY(), p.z, AI.coverSearchRadius, G.rng);
            if (c) { this._goto(e, c.x, c.z, true); e.inCover = true; }
            else if (e.dist > 22) { const pt = nav.randomNear(e.lkx, e.lkz, 12, G.rng); this._goto(e, pt.x, pt.z, true); }
          }
        }
        if (e.seen || blind < AI.suppressTime) e.lookYaw = yawTo(e.x, e.z, e.lkx, e.lkz);
        // grenade: flush him out when he sits behind cover at mid range
        if (!e.seen && blind > 1.5 && blind < 9 && e.grenadeT <= 0 && e.dist > AI.grenadeRange[0] && e.dist < AI.grenadeRange[1]) {
          e.grenadeT = AI.grenadeCooldown;
          if (G.rng() < G.mission.diff.grenadeChance && G.equip) G.equip.enemyGrenade(e.x, e.y + 1.5, e.z, e.lkx, G.world.h(e.lkx, e.lkz), e.lkz);
        }
        break;
      }

      case S.STUNNED:
        e.stunT -= dt;
        if (e.stunT <= 0) { e.lkx = e.x; e.lkz = e.z; this.stim(e, STIM.RECOVERED); }
        break;
    }
  },

  /** Chance for one enemy round to hit the player. */
  hitChance(e) {
    const p = G.player, d = e.dist;
    let c = G.mission.diff.accuracy / (1 + Math.pow(d / AI.accuracyFalloff, 2));
    if (e.type === 'sniper') c = Math.min(0.95, c * 1.5);
    c *= p.stance === 2 ? 0.55 : p.stance === 1 ? 0.8 : 1;
    if (p.sprinting) c *= 0.7;
    if (p.inFoliage) c *= 0.75;
    if (G.world.inSmoke(p.x, p.y + 1, p.z)) c *= 0.2;
    if (e.state === S.COMBAT && !e.seen) c *= 0.25;         // suppressive fire at a guess
    return clamp01(c * 0.55);
  },

  _shoot(e, dt) {
    if (e.state !== S.COMBAT) return;
    const blind = G.simTime - e.lastSeenT, p = G.player;
    const canFire = e.seen || (blind < AI.suppressTime && e.type !== 'sniper');
    if (!canFire || p.dead) { e.aimT = Math.max(e.aimT, 0.25); return; }
    if (Math.abs(angDelta(e.yaw, yawTo(e.x, e.z, e.lkx, e.lkz))) > 0.35) return;
    if (e.aimT > 0) { e.aimT -= dt; return; }
    if (e.pauseT > 0) { e.pauseT -= dt; e.rig.setCrouch(e.inCover && !e.moving); return; }
    e.rig.setCrouch(false);
    e.shotT -= dt;
    if (e.shotT > 0) return;
    if (e.burst <= 0) e.burst = e.type === 'sniper' ? 1 : (AI.burst[0] + Math.floor(G.rng() * (AI.burst[1] - AI.burst[0] + 1)));
    e.shotT = AI.shotInterval; e.burst--;
    if (e.burst <= 0) e.pauseT = e.type === 'sniper' ? 2.4 : AI.burstPause[0] + G.rng() * (AI.burstPause[1] - AI.burstPause[0]);

    const mx = e.x - Math.sin(e.yaw) * 0.6, my = e.y + 1.4, mz = e.z - Math.cos(e.yaw) * 0.6;
    e.rig.shoot();
    audio.play('enemy_shot', { x: mx, y: my, z: mz, vol: 0.9, ref: 9, rate: e.type === 'sniper' ? 0.8 : 0.95 + G.rng() * 0.1 });
    R.flashAt(mx, my, mz, 3, 9, 0.05);
    let tx = e.seen ? p.x : e.lkx, ty = (e.seen ? p.y : G.world.h(e.lkx, e.lkz)) + 1.0, tz = e.seen ? p.z : e.lkz;
    const hitP = e.seen && G.rng() < this.hitChance(e);
    if (!hitP) { tx += (G.rng() - 0.5) * 2.4; ty += (G.rng() - 0.3) * 1.6; tz += (G.rng() - 0.5) * 2.4; }
    // the round still has to get there: walls stop it
    let dx = tx - mx, dy = ty - my, dz = tz - mz;
    const len = Math.hypot(dx, dy, dz); dx /= len; dy /= len; dz /= len;
    if (G.world.raycast(mx, my, mz, dx, dy, dz, len, 4, _hit, null)) {
      fx.tracer(mx, my, mz, _hit.x, _hit.y, _hit.z, 0xffc890);
      fx.impact(_hit.x, _hit.y, _hit.z, _hit.nx, _hit.ny, _hit.nz, _hit.mat);
      if (dist2D(_hit.x, _hit.z, p.x, p.z) < 4) audio.play('impact', { x: _hit.x, y: _hit.y, z: _hit.z, vol: 0.6, low: true });
      return;
    }
    fx.tracer(mx, my, mz, tx, ty, tz, 0xffc890);
    if (hitP) p.takeDamage((AI.weaponDamage[e.type] || 14) * G.mission.diff.damageMult * (0.85 + G.rng() * 0.3), e.x, e.z, 'bullet');
    else if (e.seen) audio.play('whiz', { x: tx, y: ty, z: tz, vol: 0.5, low: true });
  },

  /**
   * Walk the path with a real velocity (locomotion.steer): speed builds and
   * bleeds off, corners are rounded inside the nav corridor, he brakes before
   * sharp turns and the goal. The facing rules are the ones the perception
   * and shooting were tuned on: he faces his path, or what he is watching.
   */
  _move(e, dt) {
    const m = e.loco, P = AI.loco;
    e.moving = false;
    if (e.state === S.STUNNED) { m.spd = 0; e.prevYaw = e.yaw; e.rig.setMove(0, 0, 0, 0); return; }
    const top = e.state === S.COMBAT ? AI.runSpeed : e.state === S.SEARCHING ? AI.searchSpeed : e.state === S.SUSPICIOUS ? AI.walkSpeed * 1.25 : AI.walkSpeed;
    // the body turns to where he walks unless he is watching something
    const follow = e.lookYaw === null || e.state === S.PATROL || e.state === S.SEARCHING || (e.state === S.COMBAT && !e.seen && G.simTime - e.lastSeenT > AI.suppressTime);
    const ox = e.x, oz = e.z;
    let lookHd = null;
    if (!e.fixed && dt > 0) {
      moveLimits(top * e.pace, P, _lim);
      m.x = e.x; m.z = e.z; m.face = e.yaw; m.faceFollows = follow;
      const direct = e.directT > 0;
      m.direct = direct;
      if (direct) e.directT -= dt;
      // nearly there and a comrade already stands on the spot: this is as close as he gets
      if (e.pi === e.path.length - 1) {
        const gl = e.path[e.pi];
        if (Math.hypot(gl.x - e.x, gl.z - e.z) < 1.1) for (const o of G.enemies) {
          if (o !== e && o.alive && Math.hypot(gl.x - o.x, gl.z - o.z) < 0.6) { e.pi = e.path.length; break; }
        }
      }
      if (e.pi < e.path.length) {
        m.pi = e.pi;
        e.moving = steer(m, e.path, P, _lim, dt, G.nav, _st);
        e.pi = m.pi;
      } else coast(m, _lim, dt, _st);
      e.x = m.x; e.z = m.z;
      if (e.moving) {
        if (follow) e.yaw = dampAngle(e.yaw, _st.want, AI.turnRate, dt);
        lookHd = headingOf(_st.lookX - e.x, _st.lookZ - e.z);
        // do not walk through each other (shoved apart, never faster than pushMax);
        // someone in the way ahead is passed on one side rather than pushed against head-on
        const fx = -Math.sin(m.hd), fz = -Math.cos(m.hd);
        for (const o of G.enemies) {
          if (o === e || !o.alive) continue;
          const sx = e.x - o.x, sz = e.z - o.z, sd = sx * sx + sz * sz;
          if (sd < 0.5 && sd > 1e-4) {
            const r = Math.sqrt(sd), push = Math.min((0.71 - r) * 0.5, P.pushMax * dt);
            let px = sx / r, pz = sz / r;
            if (-(px * fx + pz * fz) > 0.3) { const side = px * -fz + pz * fx >= 0 ? 1 : -1; px += -fz * side * 0.8; pz += fx * side * 0.8; const l = Math.hypot(px, pz); px /= l; pz /= l; }
            e.x += px * push; e.z += pz * push;
          }
        }
      }
      if (e.x !== ox || e.z !== oz) {
        // never into a wall: slide along it, or stop. A nav cell blocked only by the grid's
        // padding is fine if his body fits there (squeezing past a comrade in an alley).
        const nav = G.nav;
        if (!direct && !walkOk(nav, e.x, e.z) && walkOk(nav, ox, oz) && !(e.goalBlocked && e.pi >= e.path.length - 1)) {
          if (walkOk(nav, e.x, oz)) e.z = oz; else if (walkOk(nav, ox, e.z)) e.x = ox; else { e.x = ox; e.z = oz; }
          m.spd = Math.min(m.spd, Math.hypot(e.x - ox, e.z - oz) / dt);
        }
        m.x = e.x; m.z = e.z;
        e.y = G.world.h(e.x, e.z);
      }
      // a shut door on his way: he opens it as he gets there, and leaves it open
      if (e.moving && G.level.doorSys) G.level.doorSys.enemyPass(e);
      // a second without headway: walk straight at the next point for a moment, as the old code did
      if (e.moving && !direct) {
        e.slowT = Math.hypot(e.x - ox, e.z - oz) < 0.15 * dt ? (e.slowT || 0) + dt : Math.max(0, (e.slowT || 0) - 2 * dt);
        if (e.slowT > P.stallTime) { e.slowT = 0; e.directT = P.directTime; }
      }
      // making no headway even so: re-path, then skip the waypoint, then give the path up
      if (e.moving) {
        e.stuckT += dt;
        if (e.stuckT > P.stuckTime) {
          const stuck = Math.hypot(e.x - e.stuckX, e.z - e.stuckZ) < 0.25;
          e.stuckT = 0; e.stuckX = e.x; e.stuckZ = e.z;
          if (!stuck) e.stuckN = 0;
          else if (++e.stuckN === 1) this._goto(e, e.goalX, e.goalZ, true);
          else if (e.stuckN === 2 && e.pi < e.path.length - 1) { m.sx = e.path[e.pi].x; m.sz = e.path[e.pi].z; e.pi++; }
          else { e.path.length = 0; e.moving = false; e.stuckN = 0; }
        }
      } else { e.stuckT = 0; e.stuckX = e.x; e.stuckZ = e.z; }
    } else m.spd = 0;
    const turnFree = !e.moving || (e.state === S.COMBAT && (e.seen || G.simTime - e.lastSeenT <= AI.suppressTime)) || e.state === S.SUSPICIOUS && !e.moving;
    if (turnFree && e.lookYaw !== null) e.yaw = dampAngle(e.yaw, e.lookYaw, AI.turnRate * (e.state === S.COMBAT ? 1.4 : 0.7), dt);
    // the rig gets his true planar velocity in his own frame, his turn rate and where his eyes are going
    const c = Math.cos(e.yaw), s = Math.sin(e.yaw), wvx = -Math.sin(m.hd) * m.spd, wvz = -Math.cos(m.hd) * m.spd;
    const yawRate = dt > 0 ? angDelta(e.prevYaw, e.yaw) / dt : 0;
    e.prevYaw = e.yaw;
    e.rig.setMove(m.spd, wvx * c - wvz * s, wvx * s + wvz * c, yawRate);
    if (e.rig.setLook) e.rig.setLook(turnFree && e.lookYaw !== null ? angDelta(e.yaw, e.lookYaw) : lookHd !== null ? angDelta(e.yaw, lookHd) : null);
    if (e.state === S.COMBAT || e.state === S.SEARCHING) e.rig.setAim(true, clamp(Math.atan2((G.player.y + 1) - (e.y + 1.4), Math.max(1, e.dist)), -0.6, 0.6));
  },

  // ───────────────────────── frame update ─────────────────────────
  update(dt) {
    const p = G.player;
    let maxAlert = 0, anySees = false;
    for (let i = 0; i < G.enemies.length; i++) {
      const e = G.enemies[i];
      if (e.gone) continue;
      if (e.alive) {
        e.thinkT -= dt;
        if (e.thinkT <= 0) {
          e.thinkT += 1 / AI.thinkHz;
          if (e.state !== S.STUNNED) this._perceive(e, 1 / AI.thinkHz);
          if (e.alive) this._think(e, 1 / AI.thinkHz);
        }
        this._move(e, dt);
        this._shoot(e, dt);
        const al = alertLevel(e.state);
        if (al > maxAlert) maxAlert = al;
        if (e.state === S.COMBAT && e.seen) anySees = true;
        if (e.tagT > 0) e.tagT -= dt;
        if (e.beam) e.beam.visible = e.torchOn;
        // radio operators report on a timer
        if (e.radio) {
          e.checkinT -= dt;
          if (e.checkinT <= 0) { e.checkinT = AI.checkinPeriod; if (e.dist < 30) audio.play('radio_on', { x: e.x, y: e.y + 1.4, z: e.z, vol: 0.25, ref: 4 }); }
        }
      } else {
        // a dead operator's next report never comes
        if (e.radio && !e.checkinMissed) {
          e.checkinT -= dt;
          if (e.checkinT <= -AI.checkinGrace) {
            e.checkinMissed = true;
            if (this.aliveIn(e.sector) > 0) {
              this.sectorAlert(e.sector, STIM.CHECKIN_MISSED, e.x, e.z);
              bus.emit('toast', t('checkinMissed'), 'warn');
              bus.emit('radio', 'r_checkin');
            }
          }
        }
        if (e.dragged) {
          const fx2 = -Math.sin(p.yaw), fz2 = -Math.cos(p.yaw);
          e.x = p.x + fx2 * 0.95; e.z = p.z + fz2 * 0.95; e.y = G.world.groundHeight(e.x, e.z, p.y, 0.6, null);
          e.yaw = p.yaw;
        }
      }
      e.mesh.position.set(e.x, e.y, e.z);
      e.mesh.rotation.y = e.yaw;
      e.rig.update(dt);
    }

    // global alert → music, "spotted" counter, radio chatter
    if (maxAlert === 2) this.combatT += dt; else this.combatT = 0;
    if (maxAlert !== this.globalAlert) {
      const was = this.globalAlert;
      this.globalAlert = maxAlert;
      if (maxAlert === 2 && was < 2) bus.emit('spotted');
      else if (was === 2 && maxAlert < 2) bus.emit('lostTrail');
      bus.emit('alert', maxAlert);
    }
    this.anySees = anySees;
    this._reinforce(dt);
  },

  /** Reinforcements arrive from a marked direction when a fight drags on. */
  _reinforce() {
    if (this.globalAlert < 2 || this.combatT < AI.reinforceDelay) return;
    const lv = G.level, sec = lv.sectorAt(G.player.x, G.player.z);
    if (!sec || sec.cleared) return;
    if (lv.relayObj && !lv.relayObj.alive) return;                       // comms cut: nobody is coming
    const max = G.mission.diff.flank ? 2 : 1;
    if (sec.reinforced >= max) return;
    const src = lv.reinforce.find((r) => r.sector === sec.id && !r.used);
    if (!src) { sec.reinforced = max; return; }
    src.used = true; sec.reinforced++; this.combatT = 0;
    const n = Math.max(1, Math.round(src.count * G.mission.diff.reinforceMult));
    for (let i = 0; i < n; i++) {
      const pt = G.nav.randomNear(src.x, src.z, 4, G.rng);
      const e = new Enemy({ x: pt.x, z: pt.z, type: 'rifle', sector: sec.id }, lv);
      G.enemies.push(e);
      e.lkx = G.player.x; e.lkz = G.player.z;
      this._enter(e, S.SEARCHING, false);
    }
    bus.emit('toast', t('reinforce', { dir: t('dir' + src.dir) }), 'warn');
    bus.emit('radio', 'r_reinforce');
    bus.emit('marker', src.x, src.z, 12);
  },

  // ───────────────────────── damage ─────────────────────────
  /**
   * Nearest soldier hit by a ray (unit direction). The zones follow the
   * animated head (rig.headLocal when the rig has it) and a head hit wins over
   * a graze of the body's neck/shoulder band; the geometry and the priority
   * rule are in ballistics.rayVsSoldier.
   * Fills out = { enemy, dist, zone, x,y,z } and returns true on a hit.
   */
  rayHit(ox, oy, oz, dx, dy, dz, maxDist, out) {
    let best = maxDist, found = false;
    for (let i = 0; i < G.enemies.length; i++) {
      const e = G.enemies[i];
      if (!e.alive) continue;
      const t = rayVsSoldier(ox, oy, oz, dx, dy, dz, best, e, _zone, AI);
      if (t >= 0) { best = t; found = true; out.enemy = e; out.zone = _zone.zone; }
    }
    if (found) { out.dist = best; out.x = ox + dx * best; out.y = oy + dy * best; out.z = oz + dz * best; }
    return found;
  },

  /** World-space centre of a soldier's head for his current pose (the point the hit test uses). */
  headPos(e, out) { return soldierHeadWorld(e, out); },

  /**
   * info: { by:'bullet'|'knife'|'tknife'|'blast', head, fromX, fromZ, dist, quiet }
   * `amount` is final: a lethal headshot arrives here as ballistics.LETHAL
   * (the headshot rule lives in ballistics.isLethalHit, nowhere else).
   */
  damage(e, amount, info = {}) {
    if (!e.alive) return false;
    e.hp -= amount;
    e.rig.hit();
    if (e.hp <= 0) { this.kill(e, info); return true; }
    // a wounded soldier knows he is under fire; a quiet hit does not give the shooter away
    if (e.state !== S.COMBAT) {
      if (info.quiet) this.stim(e, STIM.HIT, e.x + (G.rng() - 0.5) * 8, e.z + (G.rng() - 0.5) * 8);
      else { e.lkx = info.fromX ?? e.x; e.lkz = info.fromZ ?? e.z; this.stim(e, STIM.SPOTTED, e.lkx, e.lkz); }
    }
    return false;
  },

  kill(e, info = {}) {
    if (!e.alive) return;
    const unaware = e.state === S.PATROL || e.state === S.SUSPICIOUS || e.state === S.STUNNED;
    e.alive = false; e.dead = true; e.state = S.DEAD; e.hp = 0; e.torchOn = false;
    e.path.length = 0; e.moving = false;
    // fall away from the shot
    const away = info.fromX !== undefined ? Math.cos(angDelta(e.yaw, yawTo(e.x, e.z, info.fromX, info.fromZ))) : 1;
    e.rig.die(away > 0 ? 1 : -1);
    G.bodies.push(e);
    const st = G.mission.stats;
    st.kills++;
    if (info.head) st.headshots++;
    if (unaware) st.stealthKills++;
    audio.play('body', { x: e.x, y: e.y + 0.3, z: e.z, vol: 0.7, ref: 4 });
    noise.emit({ x: e.x, y: e.y, z: e.z, radius: info.by === 'knife' ? NOISE.takedown : NOISE.bodyFall, kind: 'body', source: e, time: G.simTime });
    bus.emit('kill', e, { ...info, stealth: unaware });
    // teammates who watch him drop come over to look (and will then find the body)
    for (const o of G.enemies) {
      if (!o.alive || o.state === S.COMBAT || o.state === S.STUNNED) continue;
      const d = dist2D(o.x, o.z, e.x, e.z);
      if (d > 26 || Math.abs(angDelta(o.yaw, yawTo(o.x, o.z, e.x, e.z))) > STEALTH.fovEdge) continue;
      if (G.world.los(o.x, o.eyeY(), o.z, e.x, e.y + 1, e.z)) this.stim(o, STIM.NOISE_QUIET, e.x, e.z);
    }
    if (G.rng() < AI.dropAmmoChance) bus.emit('drop', e);
  },

  /** Explosion damage to soldiers (with a wall check). */
  blast(x, y, z, radius, damage, minDamage, info = {}) {
    let kills = 0;
    for (const e of [...G.enemies]) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - x, e.y + 0.9 - y, e.z - z);
      if (d > radius || !G.world.los(x, y + 0.3, z, e.x, e.y + 1, e.z)) continue;
      const inner = radius * 0.25, dmg = d <= inner ? damage : damage + (minDamage - damage) * (d - inner) / (radius - inner);
      if (this.damage(e, dmg, { by: 'blast', fromX: x, fromZ: z, ...info })) kills++;
    }
    return kills;
  },

  /** Flashbang: blind and deafen every soldier with a line to the burst. */
  stun(x, y, z, radius, dur) {
    for (const e of G.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d > radius || !G.world.los(x, y + 0.2, z, e.x, e.eyeY(), e.z)) continue;
      e.stunT = dur * (1 - 0.4 * d / radius);
      this.stim(e, STIM.FLASHED);
    }
  },

  /** A soldier the player may take down silently: in reach and from behind (or stunned). */
  takedownTarget() {
    const p = G.player;
    let best = null, bd = PLAYER.takedownRange;
    for (const e of G.enemies) {
      if (!e.alive || e.fixed && Math.abs(e.y - p.y) > 1) continue;
      const d = dist2D(p.x, p.z, e.x, e.z);
      if (d > bd || Math.abs(e.y - p.y) > 1.2) continue;
      const behind = Math.cos(angDelta(e.yaw, yawTo(e.x, e.z, p.x, p.z))) < -Math.cos(PLAYER.takedownArc);
      if (e.state === S.STUNNED || (behind && e.state !== S.COMBAT)) { best = e; bd = d; }
    }
    return best;
  },

  /** Could a soldier stand here (free nav cell, or room for his body beside a wall)? For checks and tools. */
  canStand(x, z) { return walkOk(G.nav, x, z); },

  nearestBody(x, z, r) {
    let best = null, bd = r;
    for (const b of G.bodies) {
      if (b.gone || b.dragged) continue;
      const d = dist2D(x, z, b.x, b.z);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  },

  /** Mark a dropped body hidden when it lies in foliage. Returns true if hidden. */
  settleBody(b) {
    b.dragged = false;
    const was = b.hidden, lv = G.level;
    b.hidden = lv.inFoliage(b.x, b.z);
    // indoors and unlit: nobody notices it from the doorway or through a window
    b.dark = !b.hidden && lv.isIndoor(b.x, b.y + 0.5, b.z) && lv.lightAt(b.x, b.y, b.z) < DARK_BODY_LIGHT;
    return (b.hidden && !was) || b.dark;
  },
  removeBody(b) { b.gone = true; b.hidden = true; b.dragged = false; b.mesh.visible = false; },

  state: S,
};

noise.listen((evt) => ai.onNoise(evt));
void THROW;
