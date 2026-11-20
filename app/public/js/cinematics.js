/**
 * cinematics.js — the two camera set-pieces: the optional slow-motion kill
 * cam on long SVD headshots, and the flag raising at the end.
 */
import * as THREE from 'three';
import { G, bus, clamp01, lerp } from './ctx.js';
import { audio } from './audio.js';
import { R } from './render.js';

const cam = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
const _t = new THREE.Vector3();

export const cine = {
  kill: null, flag: null,
  /** Simulation time scale requested by a running cinematic (1 = normal). */
  timeScale() { return this.kill && !this.kill.ended ? 0.09 : 1; },
  active() { return !!(this.kill || this.flag); },

  frame(dtReal) {
    cam.aspect = G.camera.aspect;
    if (this.kill) {
      const k = this.kill, pr = k.pr, e = k.enemy;
      k.t += dtReal;
      _t.set(e.x, e.y + e.rig.headHeight(), e.z);
      if (!k.ended) {
        // ride just behind and beside the round, looking at the target
        const v = Math.hypot(pr.vx, pr.vy, pr.vz) || 1;
        cam.position.set(pr.x - pr.vx / v * 1.6 + pr.vz / v * 0.35, pr.y + 0.22, pr.z - pr.vz / v * 1.6 - pr.vx / v * 0.35);
        if (k.t > 6) k.ended = true;
      } else {
        k.endT += dtReal;
        cam.position.lerp(k.rest, clamp01(dtReal * 3));
        if (k.endT > 1.1) { this.kill = null; G.overrideCamera = null; G.player.lookLocked = false; return; }
      }
      cam.fov = 38; cam.lookAt(_t); cam.updateProjectionMatrix();
    }
    if (this.flag) {
      const f = this.flag, lv = G.level;
      f.t += dtReal;
      const fp = lv.flag, base = lv.gy(fp.x, fp.z);
      fp.setRaise(clamp01((f.t - 1) / 6));
      const a = -0.9 + f.t * 0.12, r = lerp(9, 15, clamp01(f.t / 10)), h = lerp(2.2, 7.5, clamp01(f.t / 9));
      cam.position.set(fp.x + Math.sin(a) * r, base + h, fp.z + Math.cos(a) * r);
      cam.fov = 46; cam.updateProjectionMatrix();
      cam.lookAt(_t.set(fp.x, base + lerp(2.5, 7.4, clamp01((f.t - 1) / 6)), fp.z));
      if (!f.said && f.t > 5.2) { f.said = true; bus.emit('radio', 'r_end'); }
      if (f.t > 11.5) { this.flag = null; bus.emit('fade', () => { G.overrideCamera = null; bus.emit('flagDone'); }); }
    }
  },
};

bus.on('killcam', (pr, enemy) => {
  if (cine.kill || cine.flag) return;
  cine.kill = { pr, enemy, t: 0, ended: false, endT: 0, rest: new THREE.Vector3() };
  G.overrideCamera = cam; G.player.lookLocked = true;
});
bus.on('killcamEnd', (end) => {
  const k = cine.kill;
  if (!k) return;
  k.ended = true;
  k.rest.set(end.x + (cam.position.x - end.x) * 0.25 + 1.2, end.y + 0.9, end.z + (cam.position.z - end.z) * 0.25 + 1.2);
});
bus.on('flagRaise', () => {
  if (cine.flag) return;
  const p = G.player;
  G.mission.flagRaised = true;
  p.frozen = true; p.lookLocked = true;
  cine.flag = { t: 0, said: false };
  G.overrideCamera = cam;
  audio.play('flag', { vol: 0.8 });
  audio.setMusic('calm');
  R.post.vignette = 0.35;
});
