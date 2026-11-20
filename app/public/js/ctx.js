/**
 * ctx.js — shared game context, event bus and small math helpers.
 *
 * This module has NO dependencies (not even Three.js) so the pure gameplay
 * modules that import it (stealth, noise, ballistics, ai-fsm) can be unit-tested
 * under plain Node.
 */

/** The one mutable game context. Modules read/write fields here instead of
 *  importing each other in circles. Fields are filled in by main.js / game.js. */
export const G = {
  // engine
  renderer: null, scene: null, camera: null, vmScene: null, vmCamera: null,
  canvas: null,
  // persistent
  settings: null,
  // flow
  screen: 'boot',          // ui screen id
  playing: false,          // simulation running (not paused / not in menu)
  paused: false,
  timeScale: 1,            // global sim time scale (wheel slow-mo, kill cam)
  simTime: 0,              // seconds of simulated time in the current act
  realTime: 0,
  // mission runtime (set by game.js)
  mission: null,           // { name, difficulty, diff, act, sector, stats, ... }
  level: null,             // Level instance for the current act
  world: null,             // physics World
  nav: null,               // NavGrid
  player: null,
  enemies: [],
  bodies: [],
  rng: null,
  debug: false,
};

// ───────────────────────────── event bus ─────────────────────────────────
const listeners = new Map();
export const bus = {
  on(evt, fn) {
    let arr = listeners.get(evt);
    if (!arr) listeners.set(evt, (arr = []));
    arr.push(fn);
    return fn;
  },
  off(evt, fn) {
    const arr = listeners.get(evt);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  },
  emit(evt, a, b, c) {
    const arr = listeners.get(evt);
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) arr[i](a, b, c);
  },
  clear() { listeners.clear(); },
};

// ───────────────────────────── math helpers ──────────────────────────────
export const PI = Math.PI;
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function invLerp(a, b, v) { return a === b ? 0 : clamp01((v - a) / (b - a)); }
export function smoothstep(a, b, v) { const t = invLerp(a, b, v); return t * t * (3 - 2 * t); }
/** Frame-rate independent exponential approach. */
export function damp(a, b, lambda, dt) { return lerp(a, b, 1 - Math.exp(-lambda * dt)); }
export function wrapPi(a) {
  while (a > PI) a -= TAU;
  while (a < -PI) a += TAU;
  return a;
}
/** Shortest signed difference b - a, in (-PI, PI]. */
export function angDelta(a, b) { return wrapPi(b - a); }
export function dampAngle(a, b, lambda, dt) { return a + angDelta(a, b) * (1 - Math.exp(-lambda * dt)); }
export function dist2D(ax, az, bx, bz) { const dx = bx - ax, dz = bz - az; return Math.sqrt(dx * dx + dz * dz); }
export function dist3D(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
/** Yaw (around +Y) so that forward (-Z at yaw 0) points from a to b. */
export function yawTo(ax, az, bx, bz) { return Math.atan2(-(bx - ax), -(bz - az)); }

/** Small, fast seeded RNG (mulberry32). Gameplay randomness goes through this
 *  so a run is reproducible from its seed. */
export function makeRng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (a, b) => a + (b - a) * next();
  next.int = (a, b) => Math.floor(a + (b - a + 1) * next());
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.chance = (p) => next() < p;
  return next;
}

/** Deterministic 2D hash → [0,1). */
export function hash2(x, z) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise in [0,1], smooth. */
export function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Fractal noise in [0,1]. */
export function fbm(x, z, oct = 4) {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += vnoise(x * f, z * f) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** Format seconds as mm:ss. */
export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}
