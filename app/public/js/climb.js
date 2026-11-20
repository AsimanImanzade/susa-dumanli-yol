/**
 * climb.js — the scripted cliff climb (Act 2).
 *
 * The player moves along a fixed route (W up, S down). A sentry patrols the
 * rim above: every so often he walks to the edge and shines a torch down.
 * Moving while he is watching fills his detection meter quickly; hanging
 * still fills it barely at all, and a rest ledge under an overhang hides you
 * completely. Grip drains between ledges and is restored on them.
 */
import * as THREE from 'three';
import { G, bus, clamp, clamp01, damp, lerp } from './ctx.js';
import { input } from './input.js';
import { audio } from './audio.js';
import { buildBeam } from './models.js';
import { buildSoldier } from './soldier-model.js';
import { t, keyLabel } from './loc.js';
import { CLIFF_TOP } from './levels/act2.js';

export const climb = {
  active: false, s: 0, grip: 100, meter: 0, phase: 'clear', phaseT: 0, alarmT: 0, shotT: 0, onLedge: true, lastLedge: 0,
  watcher: null, done: false, moving: false, saidHold: false, saidGo: false,

  start(level, fromS = 0) {
    const c = level.climb;
    this.c = c; this.active = true; this.done = false;
    this.s = fromS; this.lastLedge = fromS; this.grip = 100; this.meter = 0;
    this.phase = 'clear'; this.phaseT = 9; this.alarmT = 0; this.gripT = 0; this.saidHold = this.saidGo = false; this.spottedThis = false;
    const p = G.player;
    p.frozen = true; p.stance = 0; p.yaw = 0; p.pitch = 0.5;
    // the sentry on the rim
    const { mesh, rig } = buildSoldier('rifle');
    this.watcher = { mesh, rig, x: -16, beam: buildBeam(CLIFF_TOP + 4, 4.2) };
    mesh.position.set(-16, CLIFF_TOP, -1.2);
    this.watcher.beam.rotation.x = -Math.PI / 2 + 0.06;            // points down the face
    this.watcher.beam.position.set(0, 1.3, -0.6);
    this.watcher.beam.material.opacity = 0.1;
    mesh.add(this.watcher.beam);
    level.group.add(mesh);
    this._place();
  },
  stop() { this.active = false; if (G.player) G.player.frozen = false; if (this.watcher) this.watcher.mesh.skeleton.dispose(); this.watcher = null; },

  _place() {
    const p = G.player;
    p.body.x = this.c.x(this.s); p.body.y = this.s; p.body.z = 1.7;
    p.body.vx = p.body.vy = p.body.vz = 0;
  },

  update(dt) {
    if (!this.active || this.done) return;
    const p = G.player, c = this.c, diff = G.mission.diff;
    if (p.dead) return;

    // ── the route
    const dir = (input.down('forward') ? 1 : 0) - (input.down('back') ? 1 : 0);
    const prev = this.s;
    this.s = clamp(this.s + dir * (dir > 0 ? 1.45 : 2.1) * dt * (this.grip < 20 ? 0.6 : 1), 0, c.top);
    this.moving = Math.abs(this.s - prev) > 1e-4;
    this.onLedge = this.s < 0.4 || c.ledges.some((y) => Math.abs(this.s - y) < 0.55);
    if (this.onLedge) { this.grip = Math.min(100, this.grip + 34 * dt); if (!this.moving) this.lastLedge = this.s; }
    else this.grip = Math.max(0, this.grip - (this.moving ? 3.2 : 2.2) * dt);
    if (this.moving) {
      this.gripT -= dt;
      if (this.gripT <= 0) { this.gripT = 0.62; audio.play('grip', { vol: 0.5, rate: 0.9 + Math.random() * 0.2 }); if (Math.random() < 0.12) audio.play('rocks', { vol: 0.25 }); }
    }
    if (this.grip <= 0) {
      // slipped: slide back down to the last ledge
      this.s = this.lastLedge; this.grip = 45;
      p.takeDamage(16, p.x, p.z, 'fall');
      audio.play('rocks', { vol: 0.9 }); audio.play('land', { vol: 0.8 });
      bus.emit('toast', t('climbSlip'), 'warn');
      this.meter = Math.min(1, this.meter + 0.35);
    }
    this._place();

    // ── the sentry: clear → warn (walks over) → watch (torch down) → clear
    const wch = this.watcher;
    this.phaseT -= dt;
    const targetX = this.phase === 'clear' ? (wch.x < 0 ? -18 : 18) : c.x(this.s);
    if (this.phaseT <= 0) {
      if (this.phase === 'clear') { this.phase = 'warn'; this.phaseT = 2.8; if (!this.saidHold) { this.saidHold = true; bus.emit('radio', 'r_climbHold'); } audio.play('step_stone', { vol: 0.5 }); }
      else if (this.phase === 'warn') { this.phase = 'watch'; this.phaseT = 4.5 + diff.detectMult * 1.6; }
      else { this.phase = 'clear'; this.phaseT = 8.5 - diff.detectMult * 1.5 + Math.random() * 4; wch.x += wch.x < c.x(this.s) ? -0.01 : 0.01; if (!this.saidGo) { this.saidGo = true; bus.emit('radio', 'r_climbGo'); } }
    }
    const dx = targetX - wch.x, sp = this.phase === 'warn' ? 6.5 : 1.6;
    const mv = clamp(dx, -sp * dt, sp * dt);
    wch.x += mv;
    wch.mesh.position.x = wch.x;
    wch.mesh.rotation.y = Math.abs(mv) > 0.002 ? (mv > 0 ? -Math.PI / 2 : Math.PI / 2) : damp(wch.mesh.rotation.y, Math.PI, 5, dt);
    wch.rig.setMove(Math.abs(mv) > 0.002 ? sp : 0); wch.rig.setAim(this.alarmT > 0);
    wch.rig.update(dt);
    wch.beam.visible = this.phase === 'watch' || this.alarmT > 0;
    wch.beam.rotation.z = Math.sin(G.simTime * 0.9) * 0.05;

    // ── detection: movement is what gives a climber away
    const watching = this.phase === 'watch' && Math.abs(wch.x - p.x) < 5;
    let rate = 0;
    if (watching && !this.onLedge) rate = (this.moving ? 0.95 : 0.035) * diff.detectMult;
    else if (watching && this.onLedge && this.moving) rate = 0.25 * diff.detectMult;
    this.meter = rate > 0 ? Math.min(1, this.meter + rate * dt) : Math.max(0, this.meter - 0.16 * dt);
    if (this.meter >= 1 && this.alarmT <= 0) {
      this.alarmT = 6; this.shotT = 0.5;
      if (!this.spottedThis) { this.spottedThis = true; G.mission.stats.spotted++; }
      bus.emit('toast', t('spotted'), 'warn'); audio.play('alert', { vol: 0.6, ui: true });
      audio.setMusic('combat');
    }
    if (this.alarmT > 0) {
      this.alarmT -= dt; this.shotT -= dt;
      if (this.shotT <= 0) {
        this.shotT = 0.55 + Math.random() * 0.4;
        audio.play('enemy_shot', { x: wch.x, y: CLIFF_TOP + 1.4, z: -1, vol: 0.9, ref: 12 });
        wch.rig.shoot();
        const chance = this.onLedge ? 0.06 : 0.38 * diff.accuracy;
        if (Math.random() < chance) p.takeDamage(13 * diff.damageMult, wch.x, -1, 'bullet');
        else audio.play('impact', { x: p.x + (Math.random() - 0.5) * 2, y: p.y + 1.5, z: 0.3, vol: 0.8, ref: 2 });
      }
      if (this.alarmT <= 0) { this.meter = 0.3; this.spottedThis = false; audio.setMusic('tension'); }
    } else audio.setMusic(this.phase === 'clear' ? 'calm' : 'tension');

    // ── the top
    if (this.s >= c.top - 0.05 && this.alarmT <= 0) {
      bus.emit('climbPrompt', t('climbTop', { key: keyLabel(input.bindOf('interact')) }));
      if (input.pressed('interact')) { this.done = true; bus.emit('exit'); }
    } else bus.emit('climbPrompt', '');
  },

  /** HUD state: grip 0..1, detection meter, and whether to freeze. */
  hud() { return { grip: this.grip / 100, meter: this.meter, freeze: this.phase !== 'clear' || this.alarmT > 0, alarm: this.alarmT > 0, onLedge: this.onLedge, progress: clamp01(this.s / this.c.top) }; },
};
void THREE; void lerp;
