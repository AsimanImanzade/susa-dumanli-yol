/**
 * debug.js — developer overlay (?debug=1) and the test hooks exposed on
 * window.__game. The hooks let the game be driven and inspected without a
 * mouse: start a mission, fast-forward the simulation, teleport, read state.
 */
import { G, bus } from './ctx.js';
import { R } from './render.js';
import { input } from './input.js';
import { ai } from './ai.js';
import { weapons } from './weapons.js';
import { equip } from './equipment.js';
import { interact } from './interact.js';
import { climb } from './climb.js';
import { game } from './game.js';
import { audio } from './audio.js';
import { save } from './save.js';
import { noise } from './noise.js';
import { ui } from './ui.js';
import { hud } from './hud.js';

let el = null, frames = 0, acc = 0, fps = 0, worst = 0;

export const debug = {
  init() {
    const q = new URLSearchParams(location.search);
    G.debug = q.has('debug');
    input.allowUnlocked = G.debug || q.has('nolock');
    if (G.debug) {
      el = document.createElement('pre');
      el.id = 'debug';
      document.body.appendChild(el);
    }
    const errors = [];
    window.addEventListener('error', (e) => errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + String(e.reason && e.reason.message || e.reason)));

    window.__game = {
      G, R, ai, weapons, equip, interact, climb, game, audio, input, save, noise, bus, errors,
      /** Start a mission without clicking through the menus. Leaves the loop paused for manual stepping unless `live`. */
      quickStart(name = 'Test', difficulty = 'normal', act = 1, live = false) {
        game.start(name, difficulty);
        if (act > 1) game.loadAct(act, null, false);
        ui.show('none'); hud.setVisible(true); input.setEnabled(true);
        G.paused = !live;
        return this.state();
      },
      /** Run the simulation forward without rendering. */
      sim(seconds, dt = 1 / 60) {
        const n = Math.round(seconds / dt);
        for (let i = 0; i < n && G.mission && G.level; i++) { game.step(dt); input.endStep(); }
        return this.state();
      },
      /** Press an action for one step. */
      tap(action) { input.inject(action, true); game.step(1 / 60); input.endStep(); input.inject(action, false); game.step(1 / 60); input.endStep(); },
      tp(x, z, yaw) { const p = G.player; p.body.x = x; p.body.z = z; p.body.y = G.world.groundHeight(x, z, 99, 99, null); p.body.vx = p.body.vz = p.body.vy = 0; if (yaw !== undefined) p.yaw = yaw; },
      state() {
        const p = G.player, m = G.mission;
        if (!m || !p) return { screen: G.screen };
        const w = weapons.hud();
        return { screen: G.screen, act: m.act, name: m.name, difficulty: m.difficulty, playing: G.playing, paused: G.paused,
          pos: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)], yaw: +p.yaw.toFixed(2), health: Math.round(p.health), armor: Math.round(p.armor), bleed: p.bleed, dead: p.dead,
          stance: p.stance, light: +p.light.toFixed(2), foliage: p.inFoliage, weapon: w.id, mag: w.mag, reserve: w.reserve, sup: w.sup, alert: ai.globalAlert,
          enemies: G.enemies.filter((e) => e.alive).length, bodies: G.bodies.length, stats: { ...m.stats, time: Math.round(m.stats.time) }, prompt: interact.prompt };
      },
      enemies() { return G.enemies.map((e) => ({ id: e.id, type: e.type, alive: e.alive, state: e.state, meter: +e.meter.toFixed(2), x: +e.x.toFixed(1), z: +e.z.toFixed(1), sector: e.sector, dist: +e.dist.toFixed(1), hidden: e.hidden, discovered: e.discovered })); },
      killAll(sector) { for (const e of [...G.enemies]) if (e.alive && (sector === undefined || e.sector === sector)) ai.kill(e, { by: 'bullet' }); },
      god(on = true) { G.invulnerable = on; },
      ghost(on = true) { G.noDetect = on; },
    };
  },

  frame(dtReal) {
    if (!el) return;
    frames++; acc += dtReal; worst = Math.max(worst, dtReal);
    if (acc < 0.5) return;
    fps = frames / acc;
    const i = R.info(), p = G.player;
    el.textContent = `${fps.toFixed(0)} fps  worst ${(worst * 1000).toFixed(1)} ms  calls ${i.calls}  tris ${(i.tris / 1000).toFixed(1)}k  geo ${i.geos} tex ${i.tex}` +
      (p && G.mission ? `\nact ${G.mission.act}  pos ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}  light ${p.light.toFixed(2)}  alert ${ai.globalAlert}  enemies ${G.enemies.filter((e) => e.alive).length}  t ${G.simTime.toFixed(0)}s` : '');
    frames = 0; acc = 0; worst = 0;
  },
};
