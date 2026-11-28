/**
 * weapons.js — the player's guns and knife: firing, hitscan and projectile
 * resolution, suppressor wear, recoil, reloads, fire modes, ADS / scope, and
 * the first-person view model animation.
 */
import * as THREE from 'three';
import { G, bus, clamp, clamp01, damp, lerp, DEG, dist2D, angDelta, yawTo } from './ctx.js';
import { WEAPONS, KNIFE, NOISE, PLAYER, LOADOUT } from './config.js';
import { wearSuppressor, shotNoise, hitDamage, recoilAt, stepProjectile, suppressorFits } from './ballistics.js';
import { F } from './physics.js';
import { input } from './input.js';
import { noise } from './noise.js';
import { audio } from './audio.js';
import { fx } from './fx.js';
import { ai } from './ai.js';
import { R } from './render.js';
import { buildViewModel } from './models.js';
import { vmItems } from './vm-items.js';
import { TEX } from './textures.js';
import { t } from './loc.js';

const hitW = {}, hitE = {};
const fwd = { x: 0, y: 0, z: 0 };
const _eye = { x: 0, y: 0, z: 0 };
const _v = new THREE.Vector3(), _mz = new THREE.Vector3(), _cp = new THREE.Vector3(), _mw = { x: 0, y: 0, z: 0 };
const SLOTS = ['pistol', 'p1', 'p2'];
const SOUND = { pistol: ['pistol', 'pistol_sup'], akm: ['akm', 'rifle_sup'], ak74: ['ak74', 'rifle_sup'], svd: ['svd', 'rifle_sup'] };

function makeInst(id, mag) {
  const def = WEAPONS[id];
  return { id, def, mag: mag ?? def.mag, sup: null, supStored: null, mode: 0 };
}

export const weapons = {
  slots: { pistol: null, p1: null, p2: null },
  cur: 'pistol', reserve: {},
  /** Fresh suppressors carried loose, by pickup type ('suppressor' = the pistol's). See ballistics.suppressorFits. */
  spares: { suppressor: 0, akmsup: 0, svdsup: 0 },
  get spareSup() { return this.spares.suppressor; },
  set spareSup(n) { this.spares.suppressor = n; },
  ads: 0, scoped: false, zoomI: 0,
  projectiles: [],
  vms: {}, flash: null,

  init() {
    for (const id of ['pistol', 'akm', 'ak74', 'svd', 'knife']) {
      const vm = buildViewModel(id);
      vm.root.visible = false;
      G.vmScene.add(vm.root);
      this.vms[id] = vm;
    }
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.puff, color: 0xffd08a, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false }));
    this.flash.visible = false;
    G.vmScene.add(this.flash);
    vmItems.init();
  },

  reset() {
    this.slots = { pistol: makeInst('pistol'), p1: null, p2: null };
    this.slots.pistol.sup = LOADOUT.suppressors > 0 ? 1 : null;       // starts with a fresh suppressor fitted
    this.reserve = { p9: WEAPONS.pistol.reserveStart, r762: 0, r545: 0, r54: 0 };
    this.spares = { suppressor: Math.max(0, LOADOUT.suppressors - 1), akmsup: 0, svdsup: 0 };
    for (const id of LOADOUT.weapons) if (id !== 'pistol') this.give(id);
    this.cur = 'pistol';
    this._clearActions();
    this.projectiles.length = 0;
    this.ads = 0; this.scoped = false; this.zoomI = 0; this.kick = 0; this.burstI = 0; this.lastShot = -10; this.cool = 0;
    this.swayX = 0; this.swayY = 0; this.lagX = 0; this.lagY = 0; this.flashT = 0; this.flashK = 1;
    vmItems.reset();
  },
  _clearActions() { this.reloading = null; this.switching = null; this.supAnim = null; this.melee = null; this.takedown = null; this.dryLatch = false; },

  inst() { return this.slots[this.cur]; },
  /** Add a weapon to a free primary slot. Returns the slot name or null when both are full. */
  give(id, mag) {
    const slot = !this.slots.p1 ? 'p1' : !this.slots.p2 ? 'p2' : null;
    if (!slot) return null;
    this.slots[slot] = makeInst(id, mag);
    const a = WEAPONS[id].ammo;
    this.reserve[a] = Math.max(this.reserve[a] || 0, 0) + (mag === undefined ? WEAPONS[id].reserveStart : 0);
    return slot;
  },
  /**
   * Pick up a weapon from the world. If both primary slots are full the weapon
   * in hand (or primary 1 when the pistol is out) is dropped in exchange, with
   * its suppressor still on it. `carried` is the suppressor state of the weapon
   * on the ground ({ sup, supStored }); a weapon that has none gets a spare that
   * fits it, if one is carried. Returns { dropped: {id, mag, sup, supStored} | null }.
   */
  pickupWeapon(id, mag, carried) {
    const def = WEAPONS[id];
    for (const s of ['p1', 'p2']) if (this.slots[s] && this.slots[s].id === id) {       // already carried: take the rounds
      this.reserve[def.ammo] = Math.min(def.reserveMax, (this.reserve[def.ammo] || 0) + (mag ?? def.mag));
      return { dropped: null, ammoOnly: true };
    }
    let slot = this.give(id, mag);
    let dropped = null;
    if (!slot) {
      slot = this.cur === 'pistol' ? 'p1' : this.cur;
      const old = this.slots[slot];
      dropped = { id: old.id, mag: old.mag, sup: old.sup, supStored: old.supStored };
      this.slots[slot] = makeInst(id, mag);
    }
    const w = this.slots[slot];
    if (carried && def.suppressorShots > 0) { w.sup = carried.sup ?? null; w.supStored = carried.supStored ?? null; }
    if (w.sup === null && w.supStored === null && def.suppressorShots > 0 && this.spares[def.supType] > 0) {
      this.spares[def.supType]--; w.sup = 1;                      // the spare kept for this gun goes straight on
      bus.emit('toast', t('supOn'));
    }
    if (mag === undefined) this.reserve[def.ammo] = Math.min(def.reserveMax, (this.reserve[def.ammo] || 0) + def.mag);
    this._clearActions();
    this.cur = slot;
    audio.play('switch', { vol: 0.6 });
    return { dropped };
  },
  /** Ammo crate: `mags` magazines for every weapon carried. */
  addAmmo(mags) {
    for (const s of SLOTS) {
      const w = this.slots[s];
      if (w) this.reserve[w.def.ammo] = Math.min(w.def.reserveMax, (this.reserve[w.def.ammo] || 0) + w.def.mag * mags);
    }
  },
  /**
   * A picked-up suppressor of pickup type `type`. A rifle can goes into the pouch
   * of a carried gun it fits that has none (X fits it); otherwise, and always for
   * the pistol's spares, it is kept loose until a gun it fits is picked up or in hand.
   */
  addSuppressor(type, n = 1) {
    if (!(type in this.spares)) return false;
    for (let k = 0; k < n; k++) {
      const w = type === 'suppressor' ? null : ['p1', 'p2'].map((s) => this.slots[s]).find((i) => i && suppressorFits(i.def, type) && i.sup === null && i.supStored === null);
      if (w) w.supStored = 1; else this.spares[type]++;
    }
    return true;
  },
  /** Old name, kept for callers elsewhere. */
  addAkmSuppressor() { return this.addSuppressor('akmsup'); },
  /** Repair kit: restore durability on the fitted (or stowed) suppressor of the weapon in hand. */
  repair(amount) {
    const w = this.inst();
    if (w.sup !== null) { w.sup = Math.min(1, w.sup + amount); return true; }
    if (w.supStored !== null) { w.supStored = Math.min(1, w.supStored + amount); return true; }
    return false;
  },

  busy() {
    const p = G.player, e = G.equip;
    return !!(this.switching || this.supAnim || this.melee || this.takedown || p.dragging || p.ladder || p.vault || p.frozen || (e && (e.using || e.wheelOpen || e.binoc || e.cook)));
  },

  // ───────────────────────── simulation step ─────────────────────────
  update(dt) {
    const p = G.player, w = this.inst(), def = w.def;
    this.cool -= dt;
    this._projectiles(dt);
    if (p.dead) return;

    // timers of scripted actions
    if (this.takedown) return this._takedown(dt);
    if (this.melee) this._melee(dt);
    if (this.switching) {
      const s = this.switching; s.t += dt;
      if (!s.done && s.t >= 0.18) { s.done = true; this.cur = s.to; this.zoomI = 0; }
      if (s.t >= 0.36) this.switching = null;
    }
    if (this.supAnim) {
      const s = this.supAnim; s.t += dt;
      if (!s.done && s.t >= 0.65) {
        s.done = true;
        if (s.attach) {
          if (w.supStored !== null) { w.sup = w.supStored; w.supStored = null; }
          else if (this.spares[w.def.supType] > 0) { this.spares[w.def.supType]--; w.sup = 1; }
          bus.emit('toast', t('supOn'));
        }
        else { w.supStored = w.sup; w.sup = null; bus.emit('toast', t('supOff')); }
      }
      if (s.t >= 1.1) this.supAnim = null;
    }
    if (this.reloading) {
      const r = this.reloading, prev = r.t; r.t += dt;
      const at = (f) => prev < r.dur * f && r.t >= r.dur * f;
      if (at(0.22)) audio.play('mag_out', { vol: 0.7 });
      if (at(0.6)) audio.play('mag_in', { vol: 0.8 });
      if (r.empty && at(0.84)) audio.play('bolt', { vol: 0.8 });
      if (r.t >= r.dur) {
        const need = def.mag - w.mag, take = Math.min(need, this.reserve[def.ammo] || 0);
        w.mag += take; this.reserve[def.ammo] -= take;
        if (r.empty && G.equip) G.equip.add('stone', 1, true);      // the empty magazine becomes a throwable distraction
        this.reloading = null;
      }
    }

    const busy = this.busy();
    // weapon selection
    for (let i = 0; i < 3; i++) {
      if (input.pressed('weapon' + (i + 1)) && this.slots[SLOTS[i]] && SLOTS[i] !== this.cur && !this.takedown && !p.dragging && !p.frozen) {
        if (G.equip && G.equip.binoc) G.equip.setBinoc(false);
        this.reloading = null; this.supAnim = null;
        this.switching = { t: 0, to: SLOTS[i], done: false };
        audio.play('switch', { vol: 0.5 });
      }
    }
    if (!busy && !this.reloading) {
      if (input.pressed('reload') && w.mag < def.mag && (this.reserve[def.ammo] || 0) > 0) this._reload();
      if (input.pressed('suppressor')) this._toggleSuppressor();
      if (input.pressed('fireMode') && def.modes.length > 1) { w.mode = (w.mode + 1) % def.modes.length; audio.play('click', { vol: 0.7 }); bus.emit('toast', t('mode_' + def.modes[w.mode])); }
      if (input.pressed('melee')) { this.melee = { t: 0, hit: false }; audio.play('slash', { vol: 0.6 }); }
    }

    // aim
    const canAim = !busy && !this.reloading && !p.sprinting;
    const adsT = canAim && input.down('aim') ? 1 : 0;
    this.ads = clamp01(this.ads + (adsT ? 1 : -1) * dt / def.adsTime);
    this.scoped = !!def.scope && this.ads > 0.92;
    if (this.scoped && input.wheel) this.zoomI = clamp(this.zoomI - Math.sign(input.wheel), 0, def.zoomFovs.length - 1);
    const base = G.settings.fov;
    const target = def.scope ? def.zoomFovs[this.zoomI] : def.adsFov;
    if (!(G.equip && G.equip.binoc)) { p.fovTarget = lerp(base, target, this.ads * this.ads); p.sensMult = lerp(1, target / base, this.ads); }

    // fire
    const auto = def.modes[w.mode] === 'auto';
    const trig = auto ? input.down('fire') : input.pressed('fire');
    if (!input.down('fire')) this.dryLatch = false;
    if (trig && this.cool <= 0 && !busy && !this.reloading && !p.sprinting) {
      if (w.mag > 0) this._shoot(w);
      else if (!this.dryLatch) {
        this.dryLatch = true;
        audio.play('dry', { vol: 0.7 });
        if ((this.reserve[def.ammo] || 0) > 0) this._reload(); else bus.emit('toast', t('noAmmo'));
      }
    }
    if (G.simTime - this.lastShot > 0.28) this.burstI = 0;
  },

  _reload() {
    const w = this.inst();
    const empty = w.mag === 0;
    this.reloading = { t: 0, dur: empty ? w.def.reload.empty : w.def.reload.tactical, empty };
  },

  /** X: take the suppressor off, put the stowed one back on, or fit a spare that fits this gun. */
  _toggleSuppressor() {
    const w = this.inst(), type = w.def.supType;
    if (!w.def.suppressorShots) { bus.emit('toast', t('supNA')); return; }
    if (w.sup !== null) this.supAnim = { t: 0, attach: false, done: false };
    else if (w.supStored !== null) this.supAnim = { t: 0, attach: true, done: false };
    else if (this.spares[type] > 0) { this.spares[type]--; w.supStored = 1; this.supAnim = { t: 0, attach: true, done: false }; }
    else { bus.emit('toast', t('supNone')); return; }
    audio.play('sup_screw', { vol: 0.6 });
  },

  /**
   * Where the round visibly leaves the gun, in the world: the view model's
   * muzzle (the end of the suppressor when one is fitted) at the same point of
   * the screen, a metre or so out. Null when the view model is off screen.
   */
  _muzzleWorld(w, out) {
    const vm = this.vms[w.id], m = vm && (w.sup !== null && vm.supMuzzle ? vm.supMuzzle : vm.muzzle);
    if (!m || !G.vmCamera || !G.camera) return null;
    m.getWorldPosition(_mz);
    const d = Math.min(1.2, _mz.length());
    _mz.project(G.vmCamera);
    if (!(Math.abs(_mz.x) < 1.4 && Math.abs(_mz.y) < 1.4)) return null;
    _mz.z = 0.5; _mz.unproject(G.camera);
    G.camera.getWorldPosition(_cp);
    _mz.sub(_cp).normalize();
    out.x = _cp.x + _mz.x * d; out.y = _cp.y + _mz.y * d; out.z = _cp.z + _mz.z * d;
    return out;
  },

  _shoot(w) {
    const p = G.player, def = w.def, st = G.mission.stats, diff = G.mission.diff;
    w.mag--; st.shots++;
    this.cool = 60 / def.rpm; this.lastShot = G.simTime;
    const supBefore = w.sup;

    // spread cone: hip ↔ ADS, widened by movement, tightened by stance
    let spread = lerp(def.spreadHip, def.spreadAds, this.ads) + def.spreadMove * p.speedFrac * (1 - this.ads * 0.5);
    spread *= p.stance === 2 ? 0.6 : p.stance === 1 ? 0.8 : 1;
    if (p.health < PLAYER.lowHealth) spread *= 1.5;
    if (!p.body.grounded) spread *= 2;
    p.forward(fwd);
    const a = G.rng() * 6.2832, r = Math.sqrt(G.rng()) * spread * DEG;
    // perturb inside the cone using two axes perpendicular to the view
    const sy = Math.sin(p.yaw + p.kickYaw), cy = Math.cos(p.yaw + p.kickYaw);
    const rx = cy, rz = -sy;
    const ux = -fwd.y * (-sy), uy = Math.cos(p.pitch + p.kickPitch), uz = -fwd.y * (-cy);
    let dx = fwd.x + (rx * Math.cos(a) + ux * Math.sin(a)) * r;
    let dy = fwd.y + (uy * Math.sin(a)) * r;
    let dz = fwd.z + (rz * Math.cos(a) + uz * Math.sin(a)) * r;
    const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    const cam = p.eyePos(_eye), ox = cam.x, oy = cam.y, oz = cam.z;
    // where the tracer and flash visibly start: the gun's muzzle (or the suppressor's end) on screen
    let mx = ox + fwd.x * 0.7 + rx * 0.14, my = oy + fwd.y * 0.7 - 0.1, mz = oz + fwd.z * 0.7 + rz * 0.14;
    if (this._muzzleWorld(w, _mw)) { mx = _mw.x; my = _mw.y; mz = _mw.z; }

    // ── sound and noise: the suppressor decides how far the shot carries
    const radius = shotNoise(def, w.sup);
    const quiet = w.sup !== null && w.sup > 0;
    const snd = SOUND[def.id];
    if (quiet) {
      const wear = 1 - w.sup;
      if (def.id === 'svd') {
        // the can swallows the blast, not the supersonic crack of the full-power round
        audio.play(snd[1], { vol: 0.95, rate: 0.76 + Math.random() * 0.06 });
        audio.play(snd[0], { vol: 0.1 + wear * wear * 0.55, rate: 1.06 });
      } else {
        audio.play(snd[1], { vol: 0.8, rate: 0.96 + Math.random() * 0.08 });
        if (wear > 0.35) audio.play(snd[0], { vol: wear * wear * 0.6 });
      }
    } else audio.play(snd[0], { vol: 1, rate: 0.97 + Math.random() * 0.06 });
    noise.emit({ x: p.x, y: p.y + 1.3, z: p.z, radius, kind: quiet ? 'shot_suppressed' : 'shot', byPlayer: true, time: G.simTime });

    // ── suppressor wear (see ballistics.wearSuppressor)
    if (quiet) {
      w.sup = wearSuppressor(w.sup, def.suppressorShots, diff.wearMult);
      if (w.sup <= 0) { w.sup = null; bus.emit('toast', t('supBroke'), 'warn'); audio.play('bolt', { vol: 0.9, rate: 0.7 }); bus.emit('suppressorBroke'); }
    }

    // ── recoil: kick the view along the weapon's pattern; it recovers in frame()
    const rc = recoilAt(def, this.burstI++);
    const k = (this.ads > 0.5 ? 0.75 : 1) * (p.stance === 2 ? 0.6 : p.stance === 1 ? 0.85 : 1);
    this.kickP = (this.kickP || 0) + rc[0] * DEG * k;
    this.kickY = (this.kickY || 0) + rc[1] * DEG * k * (G.rng() < 0.5 ? 1 : 0.8);
    this.kick = 1;
    p.shake = Math.max(p.shake, def.id === 'svd' ? 0.5 : 0.12);

    // ── muzzle flash, shell
    if (!quiet) { this.flashT = 0.045; this.flashK = 1; R.vmFlashKick(1); R.flashAt(mx, my, mz, def.id === 'svd' ? 7 : 4, 12, 0.05); }
    else if (def.id === 'svd') { this.flashT = 0.03; this.flashK = 0.4; R.vmFlashKick(0.25); R.flashAt(mx, my, mz, 1.2, 4, 0.03); }   // a small flash still escapes the rifle's can
    const vm = this.vms[w.id];
    vm.eject.getWorldPosition(_v); fx.shell(_v);

    if (def.hitscan) {
      const end = this._resolve(ox, oy, oz, dx, dy, dz, 400, def, supBefore, false, 0);
      if (def.tracer) fx.tracer(mx, my, mz, end.x, end.y, end.z);
    } else {
      const pr = { x: ox, y: oy, z: oz, vx: dx * def.muzzleVel, vy: dy * def.muzzleVel, vz: dz * def.muzzleVel, t: 0, def, sup: supBefore, px: mx, py: my, pz: mz, dist: 0, cam: false };
      this.projectiles.push(pr);
      if (G.settings.killCam) this._predictKillCam(pr);
    }
  },

  /**
   * Resolve one straight segment of a shot against soldiers and the world.
   * Thin wood (F.THIN) lets the round through once, at reduced damage.
   * Returns the end point { x,y,z, hit:true|false, enemy? }.
   */
  _resolve(ox, oy, oz, dx, dy, dz, maxDist, def, sup, penetrated, travelled) {
    const p = G.player, w = G.world;
    const wHit = w.raycast(ox, oy, oz, dx, dy, dz, maxDist, F.BULLET, hitW, null);
    const lim = wHit ? hitW.dist : maxDist;
    if (ai.rayHit(ox, oy, oz, dx, dy, dz, lim, hitE)) {
      const e = hitE.enemy, d = travelled + hitE.dist, head = hitE.zone === 'head';
      const dmg = hitDamage(def, d, hitE.zone, sup, penetrated);
      G.mission.stats.hits++;
      fx.hit(hitE.x, hitE.y, hitE.z);
      const killed = ai.damage(e, dmg, { by: 'bullet', head, fromX: p.x, fromZ: p.z, dist: d, quiet: sup !== null && sup > 0 });
      bus.emit('hitmarker', head, killed);
      audio.play(head ? 'headshot' : 'hitmark', { vol: 0.5, ui: true });
      return { x: hitE.x, y: hitE.y, z: hitE.z, hit: true, enemy: e, killed, head };
    }
    if (wHit) {
      const hx = hitW.x, hy = hitW.y, hz = hitW.z, c = hitW.collider;
      fx.impact(hx, hy, hz, hitW.nx, hitW.ny, hitW.nz, hitW.mat);
      audio.play(hitW.mat === 'wood' || hitW.mat === 'woodThin' ? 'impact_wood' : 'impact', { x: hx, y: hy, z: hz, vol: 0.7, ref: 3, low: true });
      // a round cracking into a wall next to a guard is heard — at the wall, not at the shooter
      noise.emit({ x: hx, y: hy, z: hz, radius: NOISE.bulletImpact, kind: 'impact', time: G.simTime });
      if (c && (c.flags & F.THIN) && !penetrated) {
        const r2 = this._resolve(hx + dx * 0.2, hy + dy * 0.2, hz + dz * 0.2, dx, dy, dz, maxDist - hitW.dist - 0.2, def, sup, true, travelled + hitW.dist);
        r2.pen = true;                  // an SVD round carries this into its next segment (see _projectiles)
        return r2;
      }
      return { x: hx, y: hy, z: hz, hit: true };
    }
    return { x: ox + dx * maxDist, y: oy + dy * maxDist, z: oz + dz * maxDist, hit: false };
  },

  /** SVD rounds are real projectiles: gravity, drag and flight time (ballistics.stepProjectile). */
  _projectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      const x0 = pr.x, y0 = pr.y, z0 = pr.z;
      stepProjectile(pr, dt, pr.def.gravity);
      let dx = pr.x - x0, dy = pr.y - y0, dz = pr.z - z0;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) continue;
      dx /= len; dy /= len; dz /= len;
      // a round that went through thin wood in an earlier step stays `penetrated`
      // (reduced damage, no lethal headshot, no second penetration), as hitscan does
      const end = this._resolve(x0, y0, z0, dx, dy, dz, len, pr.def, pr.sup, !!pr.pen, pr.dist);
      if (end.pen) pr.pen = true;
      fx.tracer(pr.px, pr.py, pr.pz, end.x, end.y, end.z, 0xfff0c8, 0.09);
      pr.px = end.x; pr.py = end.y; pr.pz = end.z; pr.dist += len;
      if (end.hit || pr.t > 3 || pr.y < G.world.h(pr.x, pr.z) - 2) {
        if (pr.cam) bus.emit('killcamEnd', end);
        this.projectiles.splice(i, 1);
      }
    }
  },

  /** Fly the round ahead of time; a long headshot on a still-unmoved target earns the kill cam. */
  _predictKillCam(pr) {
    const c = { x: pr.x, y: pr.y, z: pr.z, vx: pr.vx, vy: pr.vy, vz: pr.vz, t: 0 };
    let travelled = 0;
    for (let i = 0; i < 180; i++) {
      const x0 = c.x, y0 = c.y, z0 = c.z;
      stepProjectile(c, 1 / 60, pr.def.gravity);
      let dx = c.x - x0, dy = c.y - y0, dz = c.z - z0;
      const len = Math.hypot(dx, dy, dz); dx /= len; dy /= len; dz /= len;
      const wHit = G.world.raycast(x0, y0, z0, dx, dy, dz, len, F.BULLET, hitW, null);
      if (ai.rayHit(x0, y0, z0, dx, dy, dz, wHit ? hitW.dist : len, hitE)) {
        if (hitE.zone === 'head' && travelled + hitE.dist > 32 && !hitE.enemy.moving) { pr.cam = true; bus.emit('killcam', pr, hitE.enemy); }
        return;
      }
      if (wHit) return;
      travelled += len;
    }
  },

  _melee(dt) {
    const m = this.melee, p = G.player;
    m.t += dt;
    if (!m.hit && m.t >= 0.14) {
      m.hit = true;
      let best = null, bd = KNIFE.range;
      for (const e of G.enemies) {
        if (!e.alive) continue;
        const d = dist2D(p.x, p.z, e.x, e.z);
        if (d < bd && Math.abs(e.y - p.y) < 1.4 && Math.abs(angDelta(p.yaw, yawTo(p.x, p.z, e.x, e.z))) < 0.9) { bd = d; best = e; }
      }
      if (best) {
        audio.play('stab', { vol: 0.8 });
        fx.hit(best.x, best.y + 1.2, best.z);
        const killed = ai.damage(best, KNIFE.damage, { by: 'knife', fromX: p.x, fromZ: p.z, quiet: true });
        bus.emit('hitmarker', false, killed);
      }
      noise.emit({ x: p.x, y: p.y + 1, z: p.z, radius: NOISE.melee * (best ? 1 : 0.5), kind: 'melee', byPlayer: true, time: G.simTime });
    }
    if (m.t >= KNIFE.cooldown) this.melee = null;
  },

  /** Silent knife takedown: a short first-person animation that ends the target. */
  startTakedown(e) {
    const p = G.player;
    this.reloading = null; this.switching = null; this.supAnim = null; this.melee = null;
    this.takedown = { t: 0, e, done: false, yaw0: p.yaw, pitch0: p.pitch };
    p.frozen = true; p.lookLocked = true; p.body.vx = p.body.vz = 0;
    ai.stim(e, 'flashed'); e.stunT = 3;
    audio.play('cloth', { vol: 0.6 });
  },
  _takedown(dt) {
    const td = this.takedown, p = G.player, e = td.e;
    td.t += dt;
    const k = clamp01(td.t / KNIFE.takedownTime);
    // step in behind him and look at the back of his neck
    const bx = e.x + Math.sin(e.yaw) * 0.75, bz = e.z + Math.cos(e.yaw) * 0.75;
    p.body.x = lerp(p.body.x, bx, clamp01(dt * 9)); p.body.z = lerp(p.body.z, bz, clamp01(dt * 9));
    p.yaw += angDelta(p.yaw, yawTo(p.x, p.z, e.x, e.z)) * clamp01(dt * 10);
    p.pitch = damp(p.pitch, -0.12 + Math.sin(k * Math.PI) * -0.1, 8, dt);
    if (!td.done && k >= 0.55) {
      td.done = true;
      audio.play('stab', { vol: 0.9 });
      ai.kill(e, { by: 'knife', fromX: p.x, fromZ: p.z });
      p.shake = 0.25;
    }
    if (k >= 1) { this.takedown = null; p.frozen = false; p.lookLocked = false; }
  },

  // ───────────────────────── per-frame: recoil recovery + view model ─────────────────────────
  frame(dt, mdx, mdy) {
    const p = G.player, w = this.inst(), def = w.def;
    // recoil is applied quickly, then eased back to the aim point
    const kp = this.kickP || 0, ky = this.kickY || 0;
    const applyP = kp * clamp01(dt * 30), applyY = ky * clamp01(dt * 30);
    p.kickPitch += applyP; p.kickYaw += applyY; this.kickP = kp - applyP; this.kickY = ky - applyY;
    p.kickPitch = damp(p.kickPitch, 0, def.recoilRecover, dt);
    p.kickYaw = damp(p.kickYaw, 0, def.recoilRecover, dt);
    this.kick = damp(this.kick || 0, 0, 16, dt);

    // scope sway: a slow figure-eight; holding breath (Shift) almost stops it
    let sx = 0, sy = 0;
    if (this.scoped) {
      const amp = (p.holdingBreath ? def.swayHeld : def.sway) * DEG * (p.stance === 2 ? 0.4 : p.stance === 1 ? 0.7 : 1) * (p.health < PLAYER.lowHealth ? 2.2 : 1) * (p.breath < 0.2 ? 1.8 : 1);
      this.swayAmp = damp(this.swayAmp || amp, amp, 5, dt);
      const tt = G.realTime;
      sx = Math.sin(tt * 0.9) * this.swayAmp + Math.sin(tt * 2.3) * this.swayAmp * 0.3;
      sy = Math.sin(tt * 1.8) * this.swayAmp * 0.6 + Math.cos(tt * 0.7) * this.swayAmp * 0.4;
    }
    this.swayX = sx; this.swayY = sy + vmItems.dipY;       // dipY: item animations glance down (camera only)

    // ── choose which model is on screen
    const knife = !!(this.melee || this.takedown);
    const hideAll = p.dead || this.scoped || p.frozen && !this.takedown || p.ladder || p.dragging || (G.equip && (G.equip.binoc));
    for (const id in this.vms) this.vms[id].root.visible = false;
    if (hideAll) { this.flash.visible = false; vmItems.frame(dt, null); return; }
    const vm = this.vms[knife ? 'knife' : w.id], root = vm.root;
    root.visible = true;
    if (vm.sup) vm.sup.visible = w.sup !== null || (this.supAnim && (this.supAnim.attach ? this.supAnim.t > 0.5 : this.supAnim.t < 0.6)) || vmItems.showSup;

    // base pose: hip ↔ ADS
    const a = knife ? 0 : this.ads * this.ads * (3 - 2 * this.ads);
    const hip = vm.hip;
    // adsZ / hipRot / slideTravel come from weapon-models.js (eye relief, a slight cant at the hip so the side shows)
    let x = lerp(hip[0], 0, a), y = lerp(hip[1], -vm.sightY, a), z = lerp(hip[2], vm.adsZ ?? (w.id === 'pistol' ? -0.34 : -0.24), a);
    const hr = vm.hipRot;
    let rx = hr ? hr[0] * (1 - a) : 0, ry = hr ? hr[1] * (1 - a) : 0, rz = hr ? hr[2] * (1 - a) : 0;
    // weapon lags a little behind the mouse, and bobs with the stride
    this.lagX = damp(this.lagX, clamp(-mdx * 0.0009, -0.05, 0.05), 10, dt);
    this.lagY = damp(this.lagY, clamp(mdy * 0.0009, -0.05, 0.05), 10, dt);
    x += this.lagX * (1 - a * 0.7); y += this.lagY * (1 - a * 0.7); ry += this.lagX * 1.5; rx += this.lagY * 1.2;
    const bobK = p.bob * (1 - a * 0.85);
    x += Math.cos(p.bobT) * 0.008 * bobK; y += Math.abs(Math.sin(p.bobT)) * -0.012 * bobK;
    // recoil kick
    z += this.kick * (def.id === 'svd' ? 0.09 : 0.045); rx += this.kick * (def.id === 'pistol' ? 0.16 : 0.07);
    // sprint: gun swings across the body
    this.sprintK = damp(this.sprintK || 0, p.sprinting ? 1 : 0, 9, dt);
    ry += this.sprintK * 0.7; rx -= this.sprintK * 0.25; x -= this.sprintK * 0.06; y -= this.sprintK * 0.05;
    // lowered while using an item, cooking a grenade or with the wheel open; an item animation (vm-items.js) decides while it runs
    const e = G.equip, ia = vmItems.active;
    const lower = ia ? vmItems.lower : e && ((e.using && e.using.item !== 'repair') || e.wheelOpen || e.cook) ? 1 : 0;
    this.lowerK = damp(this.lowerK || 0, lower, ia ? 14 : 10, dt);
    y -= this.lowerK * 0.3; rx -= this.lowerK * 0.6;
    if (ia) { const o = vmItems.gun; x += o.x; y += o.y; z += o.z; rx += o.rx; ry += o.ry; rz += o.rz; }
    if (ia && this.lowerK > 0.97) root.visible = false;     // all the way down: the item hands have the screen

    if (vm.mag) { vm.mag.position.set(0, 0, 0); vm.mag.visible = true; }
    if (vm.handL) {
      const out = vmItems.handLOut;     // repair: the support hand makes way for the one holding the brush
      vm.handL.position.set(0.03 * out, -0.24 * out, 0.12 * out); vm.handL.visible = out < 0.97;
    }
    if (vm.slide) vm.slide.position.set(0, 0, 0);
    if (this.switching) { const k = Math.sin(clamp01(this.switching.t / 0.36) * Math.PI); y -= k * 0.28; rx -= k * 0.5; }
    if (this.reloading) {
      // tilt the gun, drop the magazine with the left hand, seat a new one, rack if it ran dry
      const k = this.reloading.t / this.reloading.dur;
      const tilt = Math.sin(clamp01(k / 0.9) * Math.PI);
      rz += tilt * 0.35; rx += tilt * 0.22; y -= tilt * 0.04;
      const out = k < 0.22 ? 0 : k < 0.42 ? (k - 0.22) / 0.2 : k < 0.6 ? 1 - (k - 0.42) / 0.18 : 0;
      if (vm.mag) { vm.mag.position.y = -out * 0.22; vm.mag.visible = !(k > 0.36 && k < 0.44); }
      if (vm.handL) vm.handL.position.set(0.02 * out, -out * 0.2, w.id === 'pistol' ? 0 : out * 0.2);
      if (vm.slide && this.reloading.empty && k > 0.8) vm.slide.position.z = Math.sin((k - 0.8) / 0.2 * Math.PI) * (vm.slideTravel || 0.035);
      else if (vm.slide && this.reloading.empty && w.id === 'pistol') vm.slide.position.z = vm.slideTravel || 0.03;   // locked back until released
    } else if (vm.slide && this.kick > 0.3) vm.slide.position.z = this.kick * (vm.slideTravel || 0.03);           // slide / bolt carrier cycles
    else if (vm.slide && w.id === 'pistol' && w.mag === 0) vm.slide.position.z = vm.slideTravel || 0.03;          // slide stop on an empty magazine
    if (this.supAnim) {
      const k = Math.sin(clamp01(this.supAnim.t / 1.1) * Math.PI);
      ry += k * 0.5; rz -= k * 0.25; x -= k * 0.05;
      if (vm.handL) vm.handL.position.set(0.02, 0.04 * k, (w.id === 'pistol' ? -0.2 : w.id === 'svd' ? -0.5 : -0.45) * k + Math.sin(this.supAnim.t * 14) * 0.006);
    }
    if (knife) {
      if (this.takedown) {
        const k = clamp01(this.takedown.t / KNIFE.takedownTime);
        const reach = k < 0.45 ? k / 0.45 : k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
        x = lerp(0.24, 0.02, reach); y = lerp(-0.26, -0.1, reach); z = lerp(-0.3, -0.52, reach); rx = -0.2 - reach * 0.5; ry = 0.5 * reach; rz = 0.6;
      } else {
        const k = clamp01(this.melee.t / 0.3), sw = Math.sin(k * Math.PI);
        x = lerp(0.26, -0.12, k); y = -0.18 - sw * 0.02; z = -0.36 - sw * 0.14; ry = lerp(-0.5, 0.9, k); rz = 0.5; rx = -0.15;
      }
    }
    root.position.set(x, y, z);
    root.rotation.set(rx, ry, rz);

    // muzzle flash sprite
    this.flashT -= dt;
    if (this.flashT > 0 && !knife) {
      (w.sup !== null && vm.supMuzzle ? vm.supMuzzle : vm.muzzle).getWorldPosition(_v);
      this.flash.position.copy(_v); this.flash.position.z -= 0.05;
      const s = (def.id === 'pistol' ? 0.16 : 0.26) * (this.flashK ?? 1) * (0.8 + Math.random() * 0.5);
      this.flash.scale.set(s, s, 1); this.flash.visible = true;
    } else this.flash.visible = false;
    vmItems.frame(dt, knife ? null : vm);
  },

  /** HUD data for the weapon in hand. */
  hud() {
    const w = this.inst();
    return { id: w.id, name: t(w.def.nameKey), mag: w.mag, reserve: this.reserve[w.def.ammo] || 0, mode: w.def.modes[w.mode],
      sup: w.sup, supStored: w.supStored, canSup: w.def.suppressorShots > 0, supSpare: this.spares[w.def.supType] || 0,
      reloading: this.reloading ? this.reloading.t / this.reloading.dur : 0 };
  },

  snapshot() {
    const s = {};
    for (const k of SLOTS) { const w = this.slots[k]; s[k] = w ? { id: w.id, mag: w.mag, sup: w.sup, supStored: w.supStored, mode: w.mode } : null; }
    // spare suppressors under their original keys, so older checkpoints still load
    return { slots: s, cur: this.cur, reserve: { ...this.reserve }, spareSup: this.spares.suppressor, akmSupSpare: this.spares.akmsup, svdSupSpare: this.spares.svdsup };
  },
  restore(snap) {
    this.reset();
    for (const k of SLOTS) {
      const d = snap.slots[k];
      if (!d || !WEAPONS[d.id]) { if (k !== 'pistol') this.slots[k] = null; continue; }
      const w = makeInst(d.id, d.mag), canSup = w.def.suppressorShots > 0;
      w.sup = canSup ? d.sup ?? null : null; w.supStored = canSup ? d.supStored ?? null : null; w.mode = d.mode || 0;
      this.slots[k] = w;
    }
    this.cur = this.slots[snap.cur] ? snap.cur : 'pistol';
    this.reserve = { p9: 0, r762: 0, r545: 0, r54: 0, ...snap.reserve };
    this.spares = { suppressor: snap.spareSup || 0, akmsup: snap.akmSupSpare || 0, svdsup: snap.svdSupSpare || 0 };
  },
};
