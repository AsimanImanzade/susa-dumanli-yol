/**
 * input.js — keyboard + mouse, bound by PHYSICAL key codes so layouts
 * (including Azerbaijani) do not move the controls. All actions are
 * rebindable. Also owns Pointer Lock and its loss.
 *
 * The simulation runs on a fixed step, so key edges are latched: `pressed()`
 * stays true until the next `endStep()`, which the main loop calls after a
 * simulation step has actually consumed them.
 */
import { DEFAULT_BINDS, ACTIONS } from './config.js';
import { bus } from './ctx.js';

const held = Object.create(null);       // action → bool
const pressedQ = Object.create(null);   // action → bool (edge, latched)
const releasedQ = Object.create(null);
let binds = { ...DEFAULT_BINDS };
let codeToActions = new Map();
let canvas = null;
let captureCb = null;                   // rebinding: next key goes here
let uiHook = null;                      // menus: (KeyboardEvent) → true when the screen used the key
let enabled = true;

function rebuild() {
  codeToActions = new Map();
  for (const a of ACTIONS) {
    const c = binds[a];
    if (!c) continue;
    if (!codeToActions.has(c)) codeToActions.set(c, []);
    codeToActions.get(c).push(a);
  }
}

function setAction(a, down) {
  if (down) {
    if (!held[a]) pressedQ[a] = true;
    held[a] = true;
  } else {
    if (held[a]) releasedQ[a] = true;
    held[a] = false;
  }
}

function onCode(code, down, ev) {
  if (captureCb && down) {
    const cb = captureCb;
    captureCb = null;
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    cb(code);
    return;
  }
  const actions = codeToActions.get(code);
  if (!actions) return;
  // Pause must always work; everything else only while gameplay input is on.
  for (const a of actions) {
    if (!enabled && a !== 'pause') continue;
    setAction(a, down);
  }
  if (ev && enabled) ev.preventDefault();
}

export const input = {
  mouseDX: 0, mouseDY: 0, wheel: 0,
  locked: false,
  /** When true the game also accepts look input without pointer lock (drag). */
  allowUnlocked: false,

  init(cv, savedBinds) {
    canvas = cv;
    if (savedBinds) binds = { ...DEFAULT_BINDS, ...savedBinds };
    rebuild();

    window.addEventListener('keydown', (e) => {
      // a rebind takes the very next key, whatever it is (arrows, Enter and Esc are legal binds)
      if (captureCb) { if (!e.repeat) onCode(e.code, true, e); else e.preventDefault(); return; }
      // then the menus: a key a screen uses never reaches the game (so Esc on the pause screen cannot latch 'pause')
      if (uiHook && uiHook(e)) { e.preventDefault(); return; }
      if (e.repeat) { if (enabled && codeToActions.has(e.code)) e.preventDefault(); return; }
      const tag = e.target && e.target.tagName;
      if ((tag === 'INPUT' || tag === 'TEXTAREA') && !captureCb) return;   // typing a name
      bus.emit('anykey', e.code);
      onCode(e.code, true, e);
    });
    window.addEventListener('keyup', (e) => onCode(e.code, false, null));
    window.addEventListener('mousedown', (e) => {
      if (e.target !== canvas && !captureCb) return;
      onCode('Mouse' + e.button, true, e);
    });
    window.addEventListener('mouseup', (e) => onCode('Mouse' + e.button, false, null));
    window.addEventListener('contextmenu', (e) => { if (e.target === canvas) e.preventDefault(); });
    window.addEventListener('mousemove', (e) => {
      if (!enabled) return;
      if (this.locked || (this.allowUnlocked && (e.buttons & 3))) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      }
    });
    window.addEventListener('wheel', (e) => { if (enabled) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    window.addEventListener('blur', () => { this.releaseAll(); bus.emit('focuslost'); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.releaseAll(); bus.emit('focuslost'); } });
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === canvas;
      if (was && !this.locked) { this.releaseAll(); bus.emit('locklost'); }
      if (!was && this.locked) bus.emit('lockgained');
    });
    document.addEventListener('pointerlockerror', () => { this._reqAt = -1e9; bus.emit('lockerror'); });
  },

  /** Ask for pointer lock. Must be called from a user gesture; failure is reported via 'lockerror'. */
  requestLock() {
    // one request at a time: a click that resumes is followed by the same click landing on the canvas
    const now = performance.now();
    if (!canvas || this.locked || now - (this._reqAt || -1e9) < 400) return;
    this._reqAt = now;
    try {
      const p = canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => { this._reqAt = -1e9; bus.emit('lockerror'); });
    } catch { bus.emit('lockerror'); }
  },
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); },

  setEnabled(v) { enabled = v; if (!v) this.releaseAll(); },
  down(a) { return !!held[a]; },
  pressed(a) { return !!pressedQ[a]; },
  released(a) { return !!releasedQ[a]; },
  /** Clear latched edges; call once after a simulation step consumed them. */
  endStep() {
    for (const k in pressedQ) pressedQ[k] = false;
    for (const k in releasedQ) releasedQ[k] = false;
    this.wheel = 0;
  },
  /** Take and reset the accumulated mouse motion. */
  consumeMouse(out) { out.x = this.mouseDX; out.y = this.mouseDY; this.mouseDX = 0; this.mouseDY = 0; return out; },
  releaseAll() {
    for (const k in held) { if (held[k]) releasedQ[k] = true; held[k] = false; }
    this.mouseDX = 0; this.mouseDY = 0;
  },

  // ── bindings
  getBinds() { return { ...binds }; },
  bindOf(a) { return binds[a]; },
  /** Bind an action to a code. Any other action on that code is unbound so one key never does two things. */
  setBind(action, code) {
    for (const a of ACTIONS) if (a !== action && binds[a] === code) binds[a] = null;
    binds[action] = code;
    rebuild();
    return this.getBinds();
  },
  resetBinds() { binds = { ...DEFAULT_BINDS }; rebuild(); return this.getBinds(); },
  /** Route the next key or mouse button to cb(code) instead of the game. */
  capture(cb) { captureCb = cb; },
  cancelCapture() { captureCb = null; },
  capturing() { return !!captureCb; },
  /** Menus get first look at every key (after a rebind capture); fn(e) returns true when it used the key. */
  setUiHook(fn) { uiHook = fn; },

  /** Test hook: drive an action programmatically. */
  inject(action, down) { setAction(action, down); },
  injectMouse(dx, dy) { this.mouseDX += dx; this.mouseDY += dy; },
};
