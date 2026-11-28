/**
 * player.js — first-person controller: movement, stances, lean, vault,
 * ladders, health / bleeding / armor, footstep noise and the camera.
 */
import { G, bus, clamp, clamp01, damp, lerp, DEG } from './ctx.js';
import { PLAYER, NOISE, ITEMS } from './config.js';
import { input } from './input.js';
import { noise, stepRadius } from './noise.js';
import { audio } from './audio.js';
import { F } from './physics.js';
import { R } from './render.js';

const hit = {};
const SURF_SOUND = { grass: 'step_grass', dirt: 'step_dirt', mud: 'step_dirt', stone: 'step_stone', rock: 'step_stone', wood: 'step_wood', metal: 'step_metal', water: 'step_dirt' };

export class Player {
  constructor() {
    this.body = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, radius: PLAYER.radius, height: PLAYER.height[0], grounded: true, step: PLAYER.stepHeight };
    this.reset({ x: 0, z: 0, yaw: 0 });
  }

  reset(spawn) {
    const b = this.body;
    b.x = spawn.x; b.z = spawn.z; b.y = spawn.y ?? (G.world ? G.world.h(spawn.x, spawn.z) : 0);
    b.vx = b.vy = b.vz = 0; b.grounded = true;
    this.yaw = spawn.yaw || 0; this.pitch = 0;
    this.stance = 0; this.eye = PLAYER.eye[0]; this.lean = 0;
    this.health = PLAYER.maxHealth; this.armor = 0; this.bleed = 0;
    this.breath = PLAYER.breathMax; this.holdingBreath = false;
    this.sprinting = false; this.speedFrac = 0; this.moving = false;
    this.light = 0.3; this.inFoliage = false; this._senseT = 0;
    this.stride = 0; this.bobT = 0; this.bob = 0;
    this.dragging = null; this.ladder = null; this.vault = null;
    this.dead = false; this.lastDamageT = -100; this.flash = 0; this.shake = 0;
    if (this.vigLift) R.post.vignette -= this.vigLift;   // a relief cut short gives its vignette lift back
    this.relief = 0; this.vigLift = 0;
    this.kickPitch = 0; this.kickYaw = 0;       // recoil, added by weapons.js
    this.frozen = false;                        // cinematics / climbing own the body
    this.lookLocked = false;                    // takedown / cinematics own the view
    this.heartT = 0; this.lowWarned = false;
    this.fovTarget = G.settings ? G.settings.fov : 75; this.fov = this.fovTarget;
    this.sensMult = 1;
  }

  get x() { return this.body.x; } get y() { return this.body.y; } get z() { return this.body.z; }
  eyeY() { return this.body.y + this.eye; }
  /**
   * Eye position as the simulation sees it: includes the lean offset (so you can
   * shoot round a corner) but not head-bob or camera shake, and does not depend
   * on a frame having been rendered.
   */
  eyePos(out) {
    const lo = this.lean * PLAYER.leanOffset;
    out.x = this.body.x + Math.cos(this.yaw) * lo; out.y = this.body.y + this.eye - Math.abs(this.lean) * 0.06; out.z = this.body.z - Math.sin(this.yaw) * lo;
    return out;
  }
  /** Unit forward vector of the view (includes recoil). */
  forward(out) {
    const p = this.pitch + this.kickPitch, y = this.yaw + this.kickYaw, cp = Math.cos(p);
    out.x = -Math.sin(y) * cp; out.y = Math.sin(p); out.z = -Math.cos(y) * cp;
    return out;
  }

  /** Mouse look; called every rendered frame for responsiveness. */
  look(dx, dy) {
    if (this.dead || this.lookLocked) return;
    const s = 0.0022 * G.settings.sensitivity * this.sensMult;
    this.yaw -= dx * s;
    this.pitch = clamp(this.pitch - dy * s * (G.settings.invertY ? -1 : 1), -1.5, 1.5);
  }

  update(dt) {
    if (this.dead) return;
    const b = this.body, w = G.world, t = G.simTime;
    if (this.frozen) { this.speedFrac = 0; this.moving = false; return; }

    // ── ladders: no physics, just slide along the rail
    if (this.ladder) {
      const L = this.ladder, dir = (input.down('forward') ? 1 : 0) - (input.down('back') ? 1 : 0);
      b.y += dir * PLAYER.ladderSpeed * dt; b.vx = b.vz = b.vy = 0;
      if (dir && (this.stride += dt) > 0.38) { this.stride = 0; audio.play('step_wood', { vol: 0.4 }); noise.emit({ x: b.x, y: b.y, z: b.z, radius: 4, kind: 'step', byPlayer: true, time: t }); }
      if (b.y >= L.y1) { b.x = L.tx; b.z = L.tz; b.y = L.y1 + 0.05; b.grounded = true; this.ladder = null; }
      else if (b.y <= L.y0 || input.pressed('jump')) { b.y = Math.max(b.y, L.y0); this.ladder = null; }
      this.speedFrac = 0.2 * Math.abs(dir); this.moving = !!dir;
      this._sense(dt);
      return;
    }
    // ── vault: scripted hop onto / over a low obstacle
    if (this.vault) {
      const v = this.vault; v.t += dt / 0.36;
      const k = Math.min(1, v.t), e = k * k * (3 - 2 * k);
      b.x = lerp(v.x0, v.x1, e); b.z = lerp(v.z0, v.z1, e); b.y = lerp(v.y0, v.y1, Math.min(1, k * 1.6)) + Math.sin(k * Math.PI) * 0.12;
      b.vx = b.vz = b.vy = 0; b.grounded = true;
      if (k >= 1) this.vault = null;
      return;
    }

    // ── stance
    if (input.pressed('crouch')) this._setStance(this.stance === 1 ? 0 : 1);
    if (input.pressed('prone')) this._setStance(this.stance === 2 ? 0 : 2);
    const f = (input.down('forward') ? 1 : 0) - (input.down('back') ? 1 : 0);
    const s = (input.down('right') ? 1 : 0) - (input.down('left') ? 1 : 0);
    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    const fx = -sinY, fz = -cosY, rx = cosY, rz = -sinY;

    if (input.pressed('jump')) {
      if (this.stance > 0) this._setStance(0);
      else if (b.grounded && !this.dragging) {
        if (!(f > 0 && this._tryVault(fx, fz))) { b.vy = PLAYER.jumpVel; b.grounded = false; }
      }
    }

    const ads = G.weapons && G.weapons.ads > 0.5;
    const busy = G.equip && G.equip.using;
    this.sprinting = input.down('sprint') && this.stance === 0 && f > 0 && !ads && !this.dragging && !busy && b.grounded;
    let speed = this.stance === 2 ? PLAYER.speed.prone : this.stance === 1 ? PLAYER.speed.crouch : this.sprinting ? PLAYER.speed.sprint : PLAYER.speed.walk;
    if (ads) speed *= PLAYER.adsSpeedMult;
    if (this.dragging) speed *= PLAYER.dragSpeedMult;
    if (busy) speed *= 0.6;
    if (this.bleed === 2) speed *= 0.85;
    let wx = fx * f + rx * s, wz = fz * f + rz * s;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx = wx / wl * speed; wz = wz / wl * speed; }
    const acc = (b.grounded ? PLAYER.accel : PLAYER.airAccel) * dt;
    const dvx = wx - b.vx, dvz = wz - b.vz, dl = Math.hypot(dvx, dvz);
    if (dl > 0) { const k = Math.min(1, acc / dl); b.vx += dvx * k; b.vz += dvz * k; }

    b.height = PLAYER.height[this.stance];
    w.move(b, dt, PLAYER.gravity);
    const hs = Math.hypot(b.vx, b.vz);
    this.speedFrac = clamp01(hs / PLAYER.speed.sprint);
    this.moving = hs > 0.4;

    if (b.landed) {
      audio.play('land', { vol: clamp01(b.landSpeed / 9) });
      noise.emit({ x: b.x, y: b.y, z: b.z, radius: NOISE.land * NOISE.stanceMult[this.stance] * clamp(b.landSpeed / 5, 0.6, 2), kind: 'land', byPlayer: true, time: t });
      if (b.landSpeed > 10.5) this.takeDamage((b.landSpeed - 10.5) * 9, b.x, b.z, 'fall');
      this.shake = Math.max(this.shake, clamp01(b.landSpeed / 14));
    }

    // ── footsteps: one per stride, louder on hard surfaces and when sprinting
    if (b.grounded && this.moving) {
      this.stride += hs * dt;
      const len = this.stance === 2 ? 0.9 : this.sprinting ? 1.25 : this.stance === 1 ? 0.75 : 0.95;
      if (this.stride >= len) {
        this.stride = 0;
        const surf = b.groundMat || w.surfaceAt(b.x, b.z);
        const r = stepRadius(surf, this.stance, this.sprinting);
        noise.emit({ x: b.x, y: b.y, z: b.z, radius: r, kind: 'step', byPlayer: true, time: t });
        audio.play(SURF_SOUND[surf] || 'step_dirt', { vol: clamp(r / 14, 0.08, 0.9), rate: 0.92 + Math.random() * 0.16 });
      }
      this.bobT += hs * dt * (this.sprinting ? 1.5 : 1.9);
    }
    this.bob = damp(this.bob, b.grounded && this.moving ? 1 : 0, 8, dt);

    // ── lean (blocked by walls)
    let lt = (input.down('leanR') ? 1 : 0) - (input.down('leanL') ? 1 : 0);
    if (lt && w.raycast(b.x, b.y + this.eye, b.z, rx * lt, 0, rz * lt, PLAYER.leanOffset + 0.25, F.SOLID, hit)) lt *= clamp01((hit.dist - 0.2) / PLAYER.leanOffset);
    this.lean = damp(this.lean, lt, 10, dt);
    this.eye = damp(this.eye, PLAYER.eye[this.stance], 11, dt);

    // ── health
    if (this.bleed) {
      this.health -= (this.bleed === 2 ? PLAYER.bleed.heavy : PLAYER.bleed.light) * dt;
      if (this.health <= 0) return this._die();
    }
    const regen = G.mission && G.mission.diff.regen;
    if (regen && !this.bleed && t - this.lastDamageT > regen.delay && this.health < regen.cap) this.health = Math.min(regen.cap, this.health + regen.rate * dt);
    if (this.health < PLAYER.lowHealth) {
      this.heartT -= dt;
      if (this.heartT <= 0) { this.heartT = lerp(0.62, 1.0, this.health / PLAYER.lowHealth); audio.play('heartbeat', { vol: 0.8 }); }
      if (!this.lowWarned) { this.lowWarned = true; bus.emit('lowHealth'); }
    } else if (this.health > PLAYER.lowHealth + 15) this.lowWarned = false;

    // ── scope breath
    const scoped = G.weapons && G.weapons.scoped;
    this.holdingBreath = scoped && input.down('sprint') && this.breath > 0.05;
    if (this.holdingBreath) this.breath = Math.max(0, this.breath - dt);
    else this.breath = Math.min(PLAYER.breathMax, this.breath + PLAYER.breathRecover * dt);

    this._sense(dt);
    this.flash = Math.max(0, this.flash - dt * 0.45);
    this.shake = Math.max(0, this.shake - dt * 2.2);
  }

  /** Cache light level and foliage cover at 10 Hz (they need ray checks). */
  _sense(dt) {
    this._senseT -= dt;
    if (this._senseT > 0 || !G.level) return;
    this._senseT = 0.1;
    this.light = G.level.lightAt(this.body.x, this.body.y, this.body.z);
    this.inFoliage = G.level.inFoliage(this.body.x, this.body.z);
  }

  _setStance(s) {
    if (this.dragging && s === 2) return;
    const b = this.body;
    if (PLAYER.height[s] > b.height && !G.world.canFit(b.x, b.y, b.z, b.radius, PLAYER.height[s])) {
      if (s === 0 && this.stance === 2 && G.world.canFit(b.x, b.y, b.z, b.radius, PLAYER.height[1])) s = 1; else return;
    }
    this.stance = s;
    audio.play('cloth', { vol: 0.25 });
  }

  /** Mantle onto an obstacle 0.5–1.35 m high directly ahead. */
  _tryVault(fx, fz) {
    const b = this.body, w = G.world;
    if (!w.raycast(b.x, b.y + 0.35, b.z, fx, 0, fz, 0.95, F.SOLID, hit) || !hit.collider) return false;
    const c = hit.collider, top = c.y + c.hy, rise = top - b.y;
    if (rise < 0.5 || rise > 1.35 || !(c.flags & F.WALK)) return false;
    const tx = hit.x + fx * 0.55, tz = hit.z + fz * 0.55;
    const landY = w.groundHeight(tx, tz, top, 0.3, null);
    if (!w.canFit(tx, Math.max(landY, top), tz, b.radius, PLAYER.height[1])) return false;
    this.vault = { t: 0, x0: b.x, z0: b.z, y0: b.y, x1: tx, z1: tz, y1: Math.max(landY, top - (landY < top - 0.2 ? 0 : 0)) };
    if (landY < top - 0.3) { this.vault.x1 = hit.x + fx * 0.45; this.vault.z1 = hit.z + fz * 0.45; this.vault.y1 = top; }
    audio.play('cloth', { vol: 0.5 });
    noise.emit({ x: b.x, y: b.y, z: b.z, radius: 6, kind: 'step', byPlayer: true, time: G.simTime });
    return true;
  }

  /**
   * Apply damage. Armor plates soak ITEMS.armorAbsorb of each hit until they
   * are used up; what gets through can start bleeding.
   */
  takeDamage(amount, fromX, fromZ, kind) {
    if (this.dead || G.invulnerable || amount <= 0) return;
    if (this.armor > 0 && kind !== 'fall' && kind !== 'bleed') {
      const soak = Math.min(this.armor, amount * ITEMS.armorAbsorb);
      this.armor -= soak; amount -= soak;
    }
    this.health -= amount;
    this.lastDamageT = G.simTime;
    R.post.damage = Math.min(1, R.post.damage + amount / 40);
    this.shake = Math.max(this.shake, clamp01(amount / 45));
    audio.play('hurt', { vol: clamp(amount / 30, 0.3, 1) });
    if (kind !== 'fall') {
      const r = G.rng();
      if (kind === 'blast' ? r < 0.5 : (amount > 28 || this.health < 35) ? r < 0.3 : false) this.bleed = 2;
      else if (this.bleed === 0 && r < (kind === 'blast' ? 0.9 : 0.3)) this.bleed = 1;
    }
    bus.emit('playerHit', fromX, fromZ, amount);
    if (G.equip) G.equip.interrupt();
    if (this.health <= 0) this._die();
  }

  _die() {
    this.health = 0; this.dead = true;
    this.body.vx = this.body.vz = 0;
    if (this.dragging) { this.dragging.dragged = false; this.dragging = null; }
    bus.emit('playerDead');
  }

  /** Place the camera. `breathe` adds scope sway computed by weapons.js. */
  applyCamera(dt, swayX = 0, swayY = 0) {
    const cam = G.camera, b = this.body;
    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    const lo = this.lean * PLAYER.leanOffset;
    const bobY = Math.sin(this.bobT * 2) * 0.028 * this.bob * (this.stance === 2 ? 0.4 : 1);
    const bobX = Math.cos(this.bobT) * 0.018 * this.bob;
    const sh = this.shake * 0.035;
    cam.position.set(
      b.x + cosY * (lo + bobX) + (Math.random() - 0.5) * sh,
      b.y + this.eye + bobY - Math.abs(this.lean) * 0.06 + (Math.random() - 0.5) * sh,
      b.z - sinY * (lo + bobX));
    cam.rotation.set(this.pitch + this.kickPitch + swayY, this.yaw + this.kickYaw + swayX, -this.lean * PLAYER.leanAngle + (this.dead ? 0.9 : 0));
    this.fov = damp(this.fov, this.fovTarget + (this.sprinting ? 4 : 0), 14, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
    if (this.dead) cam.position.y = b.y + 0.35;
    // post effects that follow the player's condition
    const low = this.health < PLAYER.lowHealth ? 1 - this.health / PLAYER.lowHealth : 0;
    // relief after a medkit or bandage (vm-items.js sets relief = 1): blur and grey let go slowly, the image lifts a touch
    const rl = this.relief = Math.max(0, (this.relief || 0) - dt * 0.6), lift = rl > 0 ? Math.sin(Math.PI * (1 - rl)) : 0;
    R.post.blur = damp(R.post.blur, low * 1.1 + this.flash * 2.0, rl > 0 ? 2.2 : 6, dt);
    R.post.desat = damp(R.post.desat, low * 0.75, rl > 0 ? 1.5 : 4, dt);
    R.post.damage = Math.max(low * 0.35, R.post.damage - dt * (rl > 0 ? 1.8 : 0.9));
    R.post.flash = Math.max(this.flash > 0.02 ? Math.min(1, this.flash * 1.4) : 0, lift * 0.03);
    const vd = -0.1 * lift;                     // a delta, so whoever set the base vignette keeps it
    R.post.vignette += vd - (this.vigLift || 0); this.vigLift = vd;
  }
}
void DEG;
