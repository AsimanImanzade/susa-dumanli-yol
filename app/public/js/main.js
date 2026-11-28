/**
 * main.js — boot and the frame loop.
 *
 * The simulation advances in fixed 1/60 s steps (so behaviour does not depend
 * on frame rate); rendering runs once per animation frame. Mouse look, the
 * view model and the camera are updated every rendered frame for
 * responsiveness.
 */
import { G, bus } from './ctx.js';
import { setLang } from './loc.js';
import { save } from './save.js';
import { input } from './input.js';
import { R } from './render.js';
import { initTextures } from './textures.js';
import { fx } from './fx.js';
import { weapons } from './weapons.js';
import { equip } from './equipment.js';
import { cine } from './cinematics.js';
import { game } from './game.js';
import { hud } from './hud.js';
import { ui } from './ui.js';
import { audio } from './audio.js';
import { net } from './net.js';
import { debug } from './debug.js';
import { menuScene } from './menu-scene.js';

const STEP = 1 / 60;
const mouse = { x: 0, y: 0 };
let last = 0, acc = 0, menuAcc = 1, lastDraw = 0;

async function loadManifest() {
  try {
    const res = await fetch('assets/manifest.json', { cache: 'no-cache' });
    if (res.ok) return await res.json();
  } catch { /* fall through: procedural assets only */ }
  return { textures: {}, audio: {}, img: {} };
}

function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min(0.1, (now - last) / 1000 || 0);
  last = now;
  G.realTime += dtReal;

  const running = G.playing && !G.paused && G.mission && G.level;
  if (running) {
    const p = G.player;
    // pause / map keys are handled outside the fixed step so they always register
    if (input.pressed('pause')) { input.endStep(); ui.pause(); draw(now); return; }
    if (input.pressed('map')) hud.toggleMap();

    input.consumeMouse(mouse);
    if (equip.wheelOpen) equip.wheelMove(mouse.x, mouse.y); else p.look(mouse.x, mouse.y);

    // time scale: the equipment wheel and the kill cam slow the world down
    const scale = cine.timeScale() * (G.wheelSlow ? 0.25 : 1);
    G.timeScale = scale;
    acc += dtReal * scale;
    let steps = 0;
    while (acc >= STEP && steps < 5) {
      game.step(STEP);
      input.endStep();
      acc -= STEP; steps++;
      if (!G.playing || !G.level) break;        // an act change or the end of the mission
    }
    if (steps === 5) acc = 0;                   // do not spiral after a long hitch
    if (G.level && G.mission) {
      const dt = dtReal * scale;
      weapons.frame(dt, mouse.x, mouse.y);
      equip.frame(dt);
      p.applyCamera(dtReal, weapons.swayX, weapons.swayY);
      cine.frame(dtReal);
      game.frame(dtReal);
      fx.update(dt);
      G.level.update(dt, G.simTime);
      R.post.motion = G.settings.motionBlur ? Math.min(1, (Math.abs(mouse.x) + Math.abs(mouse.y)) / 60) : 0;
      R.update(dt, G.realTime);
      audio.listener(G.overrideCamera || G.camera);
      hud.frame(dtReal);
    }
  } else {
    input.consumeMouse(mouse);
    input.endStep();
    if (G.level && G.mission) R.update(0, G.realTime);
    else if (menuScene.active) {
      // on a 120/144 Hz display the backdrop draws every other refresh; 60–100 Hz displays draw every frame
      menuAcc += dtReal;
      if (menuAcc < 0.0095) return;
      menuScene.frame(menuAcc); menuAcc = 0;
    }
  }
  draw(now);
}

/** Render one frame; the FPS readouts count drawn frames. */
function draw(now) {
  debug.frame(Math.min(0.25, (now - lastDraw) / 1000 || 0));
  lastDraw = now;
  R.render(G.realTime);
}

export async function boot() {
  G.settings = save.loadSettings();
  setLang(G.settings.lang);
  document.documentElement.lang = G.settings.lang;
  const canvas = document.getElementById('game');
  debug.init();
  R.init(canvas);
  R.setEnv('forest');
  const manifest = await loadManifest();
  G.assetReport = await initTextures(R.renderer, manifest);
  fx.init();
  // player.js and ai.js reach these through the shared context (avoids import cycles)
  G.weapons = weapons; G.equip = equip;
  weapons.init();
  equip.init();
  input.init(canvas, G.settings.binds);
  input.setEnabled(false);
  hud.init();
  hud.setVisible(false);
  ui.init(manifest);
  net.connect();

  // losing the pointer or the window pauses the mission
  bus.on('locklost', () => { if (!input.allowUnlocked) ui.pause(); });
  bus.on('focuslost', () => ui.pause());
  // a refused lock (Chrome refuses for ~1 s after Esc left it) leaves the game paused behind a click-to-resume card
  bus.on('lockerror', () => ui.lockRefused());
  canvas.addEventListener('click', () => { if (G.playing && !G.paused && !input.locked) input.requestLock(); });

  document.getElementById('boot').remove();
  requestAnimationFrame(frame);
}
