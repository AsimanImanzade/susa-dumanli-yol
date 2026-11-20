/**
 * audio.js — Web Audio engine.
 *
 *   • every sound has a synthesized version rendered once at start-up with an
 *     OfflineAudioContext (the fallback that always exists);
 *   • files listed in the asset manifest (manifest.audio) replace the
 *     synthesized buffer of the same name when they load;
 *   • world sounds go through a PannerNode for 3D positioning;
 *   • music is three looping layers (calm / tension / combat) cross-faded by
 *     the alert state;
 *   • radio lines play a squelch, an optional voice file, and raise a subtitle.
 */
import { G, bus, clamp01 } from './ctx.js';

const SR = 44100;
let ctx = null, master = null, sfxBus = null, musicBus = null, uiBus = null, comp = null;
const buffers = new Map();
const loops = new Map();          // name → { src, gain }
const loops3d = new Set();        // positioned loops (vehicle engines), see loop3d()
let unlocked = false, ready = false;
let manifestAudio = {};
let voices = 0;
const MAX_VOICES = 28;
const music = { layers: {}, state: 'calm', target: { calm: 1, tension: 0, combat: 0 }, level: { calm: 0, tension: 0, combat: 0 } };

// ───────────────────────────── synthesis helpers ─────────────────────────
function offline(dur) { return new OfflineAudioContext(1, Math.ceil(SR * dur), SR); }
let noiseBuf = null;
function noiseBuffer(oc) {
  if (!noiseBuf) { noiseBuf = new Float32Array(SR * 2); for (let i = 0; i < noiseBuf.length; i++) noiseBuf[i] = Math.random() * 2 - 1; }
  const b = oc.createBuffer(1, noiseBuf.length, SR); b.copyToChannel(noiseBuf, 0); return b;
}
/** Noise through a filter with an exponential-decay envelope. */
function nz(oc, t0, dur, peak, type, f0, f1, q = 0.7, attack = 0.002) {
  const s = oc.createBufferSource(); s.buffer = noiseBuffer(oc); s.loop = true;
  const f = oc.createBiquadFilter(); f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(f0, t0); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
  const g = oc.createGain();
  g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  s.connect(f).connect(g).connect(oc.destination);
  s.start(t0, Math.random()); s.stop(t0 + dur + 0.02);
}
/** Oscillator sweep with exponential decay. */
function tone(oc, t0, dur, peak, type, f0, f1, attack = 0.002) {
  const o = oc.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t0 + dur);
  const g = oc.createGain();
  g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(oc.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
/** A gunshot: mechanical click, broadband crack, low thump, filtered tail. */
function gunshot(oc, o) {
  nz(oc, 0, 0.012, o.click ?? 0.5, 'highpass', 3500, 6000, 0.5, 0.0005);
  nz(oc, 0, o.crack, o.level, 'lowpass', o.bright, o.dark, 0.6, 0.001);
  tone(oc, 0, o.thump, o.level * 0.9, 'sine', o.thumpF, 45, 0.001);
  if (o.tail) { nz(oc, 0.02, o.tail, o.level * 0.28, 'bandpass', 900, 260, 0.5, 0.01); nz(oc, 0.09, o.tail * 0.8, o.level * 0.12, 'lowpass', 500, 120, 0.5, 0.03); }
}

/** name → [duration, builder(oc)] */
const RECIPES = {
  pistol: [0.9, (oc) => gunshot(oc, { level: 0.95, crack: 0.14, bright: 9000, dark: 500, thump: 0.12, thumpF: 190, tail: 0.7 })],
  pistol_sup: [0.3, (oc) => { nz(oc, 0, 0.02, 0.35, 'highpass', 2500, 4000, 0.5, 0.0005); nz(oc, 0, 0.09, 0.5, 'bandpass', 1500, 500, 1.2, 0.001); tone(oc, 0, 0.06, 0.25, 'sine', 140, 70); }],
  akm: [1.1, (oc) => gunshot(oc, { level: 1.0, crack: 0.17, bright: 7000, dark: 300, thump: 0.16, thumpF: 150, tail: 0.9 })],
  ak74: [1.0, (oc) => gunshot(oc, { level: 0.95, crack: 0.14, bright: 9500, dark: 420, thump: 0.13, thumpF: 175, tail: 0.8 })],
  rifle_sup: [0.4, (oc) => { nz(oc, 0, 0.025, 0.4, 'highpass', 2000, 3500, 0.5, 0.0005); nz(oc, 0, 0.14, 0.6, 'bandpass', 1100, 350, 1.0, 0.001); tone(oc, 0, 0.09, 0.4, 'sine', 120, 55); }],
  svd: [1.9, (oc) => { gunshot(oc, { level: 1.0, crack: 0.22, bright: 6000, dark: 220, thump: 0.24, thumpF: 120, tail: 1.6 }); nz(oc, 0.25, 1.3, 0.1, 'lowpass', 380, 90, 0.5, 0.12); }],
  enemy_shot: [0.8, (oc) => gunshot(oc, { level: 0.85, crack: 0.12, bright: 5000, dark: 350, thump: 0.12, thumpF: 160, tail: 0.6, click: 0.2 })],
  dry: [0.08, (oc) => nz(oc, 0, 0.03, 0.4, 'bandpass', 2600, 1800, 3, 0.0005)],
  mag_out: [0.25, (oc) => { nz(oc, 0, 0.04, 0.35, 'bandpass', 1800, 900, 2, 0.001); nz(oc, 0.07, 0.08, 0.2, 'bandpass', 700, 400, 1.5, 0.004); }],
  mag_in: [0.25, (oc) => { nz(oc, 0, 0.05, 0.45, 'bandpass', 1400, 700, 2, 0.001); tone(oc, 0.01, 0.05, 0.2, 'square', 220, 110); }],
  bolt: [0.3, (oc) => { nz(oc, 0, 0.05, 0.4, 'bandpass', 2400, 1200, 2.5, 0.001); nz(oc, 0.11, 0.06, 0.5, 'bandpass', 1900, 800, 2.5, 0.001); }],
  sup_screw: [0.7, (oc) => { for (let i = 0; i < 6; i++) nz(oc, i * 0.1, 0.06, 0.16, 'bandpass', 2600 - i * 120, 1700, 4, 0.004); }],
  switch: [0.2, (oc) => { nz(oc, 0, 0.1, 0.18, 'bandpass', 900, 400, 1, 0.01); nz(oc, 0.08, 0.04, 0.2, 'bandpass', 2200, 1400, 3, 0.001); }],
  click: [0.05, (oc) => nz(oc, 0, 0.02, 0.3, 'bandpass', 3000, 2400, 4, 0.0005)],
  step_grass: [0.2, (oc) => nz(oc, 0, 0.15, 0.3, 'bandpass', 1300, 500, 0.8, 0.012)],
  step_dirt: [0.2, (oc) => { nz(oc, 0, 0.12, 0.34, 'lowpass', 900, 250, 0.7, 0.006); tone(oc, 0, 0.06, 0.12, 'sine', 90, 50); }],
  step_stone: [0.18, (oc) => { nz(oc, 0, 0.05, 0.4, 'bandpass', 1900, 900, 1.5, 0.002); tone(oc, 0, 0.05, 0.16, 'sine', 130, 70); }],
  step_wood: [0.22, (oc) => { tone(oc, 0, 0.12, 0.4, 'sine', 170, 80); nz(oc, 0, 0.05, 0.25, 'bandpass', 1200, 500, 1.5, 0.002); }],
  step_metal: [0.25, (oc) => { tone(oc, 0, 0.2, 0.22, 'triangle', 520, 480); nz(oc, 0, 0.04, 0.3, 'bandpass', 2600, 1500, 3, 0.001); }],
  land: [0.3, (oc) => { tone(oc, 0, 0.16, 0.6, 'sine', 110, 45); nz(oc, 0, 0.12, 0.35, 'lowpass', 700, 180, 0.7, 0.004); }],
  slash: [0.25, (oc) => nz(oc, 0, 0.18, 0.4, 'bandpass', 900, 4200, 1.2, 0.05)],
  stab: [0.3, (oc) => { nz(oc, 0, 0.08, 0.5, 'lowpass', 1200, 200, 0.8, 0.002); tone(oc, 0, 0.1, 0.4, 'sine', 100, 50); }],
  body: [0.5, (oc) => { tone(oc, 0, 0.25, 0.7, 'sine', 85, 38); nz(oc, 0, 0.2, 0.3, 'lowpass', 500, 120, 0.7, 0.006); nz(oc, 0.12, 0.2, 0.16, 'bandpass', 900, 400, 1, 0.02); }],
  cloth: [0.4, (oc) => nz(oc, 0, 0.32, 0.22, 'bandpass', 2200, 1200, 0.8, 0.08)],
  // doors: latch click, then a dry hinge creak (stick-slip pulses sliding down in pitch); shutting ends in a thump
  door_open: [0.9, (oc) => { nz(oc, 0, 0.03, 0.35, 'bandpass', 2600, 1800, 3, 0.0005); for (let i = 0; i < 11; i++) tone(oc, 0.06 + i * 0.055, 0.07, 0.07 + 0.03 * Math.sin(i), 'sawtooth', 520 - i * 18 + (i % 3) * 25, 430 - i * 16, 0.004); nz(oc, 0.06, 0.6, 0.05, 'bandpass', 900, 600, 2, 0.05); }],
  door_shut: [0.6, (oc) => { for (let i = 0; i < 5; i++) tone(oc, i * 0.05, 0.06, 0.05, 'sawtooth', 380 + i * 14, 330 + i * 10, 0.004); tone(oc, 0.26, 0.18, 0.6, 'sine', 95, 45, 0.002); nz(oc, 0.26, 0.12, 0.4, 'lowpass', 900, 200, 0.7, 0.002); nz(oc, 0.3, 0.03, 0.3, 'bandpass', 2800, 2000, 3, 0.0005); }],
  pin: [0.2, (oc) => { nz(oc, 0, 0.03, 0.4, 'bandpass', 4200, 3000, 6, 0.0005); tone(oc, 0.02, 0.12, 0.14, 'triangle', 2600, 2400); }],
  bounce: [0.2, (oc) => { tone(oc, 0, 0.08, 0.35, 'triangle', 900, 500); nz(oc, 0, 0.04, 0.3, 'bandpass', 2200, 1200, 2, 0.001); }],
  stone_hit: [0.3, (oc) => { nz(oc, 0, 0.07, 0.55, 'bandpass', 2400, 900, 1.5, 0.001); nz(oc, 0.1, 0.1, 0.2, 'bandpass', 1800, 800, 1.5, 0.002); }],
  explosion: [2.6, (oc) => { nz(oc, 0, 0.5, 1.0, 'lowpass', 5000, 120, 0.5, 0.002); tone(oc, 0, 0.9, 1.0, 'sine', 95, 28, 0.002); nz(oc, 0.05, 2.3, 0.4, 'lowpass', 600, 60, 0.5, 0.05); nz(oc, 0.3, 1.2, 0.12, 'bandpass', 2500, 600, 0.7, 0.2); }],
  flashbang: [2.4, (oc) => { nz(oc, 0, 0.2, 1.0, 'highpass', 800, 2500, 0.5, 0.001); tone(oc, 0, 0.3, 0.8, 'sine', 160, 50); tone(oc, 0.02, 2.3, 0.22, 'sine', 3900, 3850, 0.01); }],
  smoke: [2.2, (oc) => { nz(oc, 0, 0.04, 0.5, 'bandpass', 1500, 900, 1.5, 0.001); nz(oc, 0.03, 2.1, 0.22, 'bandpass', 5200, 3200, 0.6, 0.15); }],
  impact: [0.25, (oc) => { nz(oc, 0, 0.05, 0.5, 'bandpass', 3200, 1200, 1.5, 0.0005); nz(oc, 0.03, 0.18, 0.14, 'bandpass', 1800, 700, 1, 0.01); }],
  impact_wood: [0.25, (oc) => { tone(oc, 0, 0.09, 0.45, 'square', 320, 140); nz(oc, 0, 0.06, 0.3, 'bandpass', 1500, 700, 1.5, 0.001); }],
  whiz: [0.3, (oc) => nz(oc, 0, 0.24, 0.3, 'bandpass', 5200, 1500, 4, 0.03)],
  hitmark: [0.09, (oc) => tone(oc, 0, 0.06, 0.3, 'triangle', 1500, 1100)],
  headshot: [0.3, (oc) => { tone(oc, 0, 0.25, 0.3, 'triangle', 2100, 2050); tone(oc, 0, 0.12, 0.2, 'sine', 3150, 3100); }],
  hurt: [0.35, (oc) => { tone(oc, 0, 0.2, 0.6, 'sine', 120, 55); nz(oc, 0, 0.1, 0.3, 'lowpass', 900, 200, 0.7, 0.003); }],
  heartbeat: [0.9, (oc) => { tone(oc, 0, 0.14, 0.9, 'sine', 62, 38, 0.01); tone(oc, 0.26, 0.16, 0.7, 'sine', 54, 34, 0.01); }],
  pickup: [0.3, (oc) => { nz(oc, 0, 0.12, 0.25, 'bandpass', 1600, 900, 1, 0.01); tone(oc, 0.05, 0.14, 0.18, 'triangle', 660, 880); }],
  heal: [0.9, (oc) => { nz(oc, 0, 0.5, 0.2, 'bandpass', 2600, 1400, 0.8, 0.1); nz(oc, 0.45, 0.3, 0.22, 'bandpass', 1900, 1000, 1, 0.05); }],
  ui_move: [0.06, (oc) => tone(oc, 0, 0.04, 0.16, 'triangle', 820, 760)],
  ui_ok: [0.22, (oc) => { tone(oc, 0, 0.1, 0.22, 'triangle', 520, 520); tone(oc, 0.07, 0.14, 0.22, 'triangle', 780, 780); }],
  ui_back: [0.18, (oc) => tone(oc, 0, 0.14, 0.2, 'triangle', 520, 330)],
  radio_on: [0.3, (oc) => { nz(oc, 0, 0.22, 0.3, 'bandpass', 2400, 1900, 1.2, 0.004); tone(oc, 0, 0.05, 0.16, 'square', 1250, 1250); }],
  radio_off: [0.2, (oc) => { nz(oc, 0, 0.12, 0.26, 'bandpass', 2100, 1700, 1.2, 0.002); tone(oc, 0.08, 0.05, 0.14, 'square', 900, 900); }],
  radio_voice: [1.6, (oc) => { for (let i = 0; i < 9; i++) { const t0 = i * 0.17 + Math.random() * 0.03; nz(oc, t0, 0.13, 0.2, 'bandpass', 700 + Math.random() * 900, 500 + Math.random() * 600, 5, 0.02); tone(oc, t0, 0.12, 0.08, 'sawtooth', 110 + Math.random() * 30, 100); } }],
  shout: [0.5, (oc) => { tone(oc, 0, 0.36, 0.3, 'sawtooth', 210, 150, 0.03); nz(oc, 0, 0.36, 0.3, 'bandpass', 1100, 700, 4, 0.03); nz(oc, 0, 0.3, 0.16, 'bandpass', 2400, 1800, 5, 0.03); }],
  alert: [0.7, (oc) => { tone(oc, 0, 0.6, 0.3, 'sawtooth', 110, 104, 0.01); tone(oc, 0, 0.6, 0.22, 'sawtooth', 165, 156, 0.01); nz(oc, 0, 0.5, 0.12, 'highpass', 5000, 3000, 0.5, 0.005); }],
  nvg: [0.6, (oc) => { tone(oc, 0, 0.5, 0.12, 'sine', 900, 5200, 0.05); nz(oc, 0, 0.03, 0.25, 'bandpass', 2600, 2000, 3, 0.001); }],
  beep: [0.12, (oc) => tone(oc, 0, 0.09, 0.3, 'square', 1800, 1800)],
  grip: [0.3, (oc) => { nz(oc, 0, 0.2, 0.3, 'bandpass', 1500, 700, 1, 0.02); tone(oc, 0, 0.05, 0.14, 'sine', 140, 80); }],
  rocks: [1.2, (oc) => { for (let i = 0; i < 7; i++) nz(oc, i * 0.14 + Math.random() * 0.05, 0.1, 0.25, 'bandpass', 1400 + Math.random() * 900, 600, 1.5, 0.002); }],
  flag: [1.5, (oc) => { for (let i = 0; i < 5; i++) nz(oc, i * 0.28, 0.26, 0.2, 'bandpass', 700, 300, 0.7, 0.08); }],
  // ── armour and artillery (vehicles.js)
  mg_tank: [0.6, (oc) => gunshot(oc, { level: 0.9, crack: 0.1, bright: 4200, dark: 280, thump: 0.11, thumpF: 125, tail: 0.45, click: 0.25 })],
  tank_tell: [1.6, (oc) => {      // hydraulics swinging the gun onto the target, the breech closing: a second of warning
    tone(oc, 0, 1.25, 0.22, 'sawtooth', 170, 430, 0.12); nz(oc, 0, 1.25, 0.14, 'bandpass', 900, 1700, 2, 0.12);
    nz(oc, 0.5, 0.12, 0.6, 'bandpass', 1400, 700, 2, 0.002); tone(oc, 0.5, 0.16, 0.5, 'square', 150, 85);
    nz(oc, 1.1, 0.1, 0.75, 'bandpass', 2300, 900, 3, 0.001); tone(oc, 1.1, 0.14, 0.5, 'square', 240, 110);
  }],
  tank_gun: [3.4, (oc) => { nz(oc, 0, 0.06, 1.0, 'highpass', 1800, 4200, 0.5, 0.0005); nz(oc, 0, 0.8, 1.0, 'lowpass', 6000, 85, 0.5, 0.001); tone(oc, 0, 1.3, 1.0, 'sine', 68, 21, 0.001); nz(oc, 0.08, 3.2, 0.36, 'lowpass', 520, 45, 0.5, 0.08); }],
  artillery: [4.6, (oc) => { nz(oc, 0, 0.07, 1.0, 'highpass', 1500, 3600, 0.5, 0.0005); nz(oc, 0, 1.0, 1.0, 'lowpass', 5200, 75, 0.5, 0.001); tone(oc, 0, 1.5, 1.0, 'sine', 58, 19, 0.001); nz(oc, 0.15, 4.3, 0.42, 'lowpass', 720, 42, 0.5, 0.2); nz(oc, 1.3, 2.6, 0.16, 'bandpass', 320, 110, 0.6, 0.5); }],
  mortar: [1.8, (oc) => { tone(oc, 0, 0.38, 0.9, 'sine', 125, 48, 0.002); nz(oc, 0, 0.28, 0.75, 'lowpass', 1900, 200, 0.6, 0.002); nz(oc, 0.0, 0.04, 0.4, 'bandpass', 2600, 1600, 2, 0.0005); nz(oc, 0.05, 1.5, 0.2, 'lowpass', 600, 80, 0.5, 0.1); }],
  distant_boom: [3.2, (oc) => { tone(oc, 0, 1.7, 0.6, 'sine', 46, 24, 0.06); nz(oc, 0, 3.0, 0.36, 'lowpass', 240, 40, 0.5, 0.18); }],
  ricochet: [0.5, (oc) => { nz(oc, 0, 0.03, 0.55, 'highpass', 3000, 5200, 0.5, 0.0005); tone(oc, 0, 0.4, 0.3, 'sine', 3300, 1800, 0.001); tone(oc, 0, 0.12, 0.22, 'triangle', 1450, 1250, 0.001); }],
  track_snap: [1.2, (oc) => { for (let i = 0; i < 6; i++) { const t0 = i * 0.09 + Math.random() * 0.03; nz(oc, t0, 0.08, 0.5 - i * 0.06, 'bandpass', 2000 - i * 150, 800, 2.5, 0.001); tone(oc, t0, 0.1, 0.3, 'square', 260 - i * 20, 120); } nz(oc, 0.5, 0.6, 0.3, 'lowpass', 900, 120, 0.6, 0.01); }],
};

/** Looping beds, rendered with a tail and cross-faded into a seamless loop. */
const LOOPS = {
  rain: [6, (oc, d) => { nz(oc, 0, d, 0.0001, 'highpass', 4000, 4000); const s = oc.createBufferSource(); s.buffer = noiseBuffer(oc); s.loop = true; const f = oc.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 5200; f.Q.value = 0.4; const g = oc.createGain(); g.gain.value = 0.2; s.connect(f).connect(g).connect(oc.destination); s.start(0); }],
  wind: [8, (oc, d) => { const s = oc.createBufferSource(); s.buffer = noiseBuffer(oc); s.loop = true; const f = oc.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.4; f.frequency.setValueAtTime(320, 0); for (let t = 1; t <= d; t++) f.frequency.linearRampToValueAtTime(260 + Math.sin(t * 1.7) * 130 + Math.sin(t * 0.6) * 60, t); const g = oc.createGain(); g.gain.value = 0.3; s.connect(f).connect(g).connect(oc.destination); s.start(0); }],
  fire: [4, (oc, d) => { const s = oc.createBufferSource(); s.buffer = noiseBuffer(oc); s.loop = true; const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600; const g = oc.createGain(); g.gain.value = 0.25; s.connect(f).connect(g).connect(oc.destination); s.start(0); for (let i = 0; i < 26; i++) nz(oc, Math.random() * d, 0.03, 0.3, 'bandpass', 2600, 1200, 2, 0.0005); }],
  // tank diesel: a 27 Hz firing pulse through a low-pass, with the clatter of noise pulsed at the same rate
  tank_engine: [2, (oc) => {
    const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 230; lp.Q.value = 0.9;
    const g = oc.createGain(); g.gain.value = 0.34; lp.connect(g).connect(oc.destination);
    for (const [f, type, v] of [[27, 'sawtooth', 0.6], [54, 'square', 0.22], [13.5, 'sine', 0.45]]) { const o = oc.createOscillator(); o.type = type; o.frequency.value = f; const og = oc.createGain(); og.gain.value = v; o.connect(og).connect(lp); o.start(0); }
    const s = oc.createBufferSource(); s.buffer = noiseBuffer(oc); s.loop = true;
    const bp = oc.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 620; bp.Q.value = 0.8;
    const am = oc.createGain(); am.gain.value = 0.07;
    const lfo = oc.createOscillator(); lfo.type = 'sawtooth'; lfo.frequency.value = 27; const lg = oc.createGain(); lg.gain.value = 0.065; lfo.connect(lg).connect(am.gain); lfo.start(0);
    s.connect(bp).connect(am).connect(oc.destination); s.start(0);
  }],
  // track clatter: steel links slapping the sprocket and idler, with a low rumble under it
  tank_tracks: [1.2, (oc, d) => {
    for (let i = 0; i < Math.floor(d / 0.05); i++) { const t0 = i * 0.05 + Math.random() * 0.012; nz(oc, t0, 0.035, 0.2 + Math.random() * 0.14, 'bandpass', 1700 + Math.random() * 1500, 900, 3, 0.001); if (i % 3 === 0) tone(oc, t0, 0.05, 0.12, 'triangle', 360 + Math.random() * 180, 290); }
    const s = oc.createBufferSource(); s.buffer = noiseBuffer(oc); s.loop = true; const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 280; const g = oc.createGain(); g.gain.value = 0.3; s.connect(f).connect(g).connect(oc.destination); s.start(0);
  }],
  // music: D minor, 60 BPM, 16 s
  music_calm: [16, (oc, d) => { for (const [f, dt] of [[73.42, 0], [110, 3], [146.83, 0], [174.61, 7]]) { for (const det of [-4, 5]) { const o = oc.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det; const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(240, 0); lp.frequency.linearRampToValueAtTime(520, d / 2 + dt); lp.frequency.linearRampToValueAtTime(240, d + 2); const g = oc.createGain(); g.gain.value = 0.055; o.connect(lp).connect(g).connect(oc.destination); o.start(0); } } for (const t0 of [2, 9.5]) tone(oc, t0, 3.5, 0.05, 'sine', 587.33, 587.33, 1.2); }],
  music_tension: [16, (oc) => { for (let i = 0; i < 32; i++) { const t0 = i * 0.5; tone(oc, t0, 0.42, i % 4 === 0 ? 0.3 : 0.16, 'sawtooth', i % 8 < 6 ? 73.42 : 82.41, 70, 0.01); if (i % 2) nz(oc, t0 + 0.25, 0.05, 0.07, 'highpass', 7000, 6000, 0.5, 0.001); } for (const [t0, f] of [[0, 293.66], [8, 311.13]]) tone(oc, t0, 7.5, 0.05, 'triangle', f, f, 2.5); }],
  music_combat: [16, (oc) => { for (let i = 0; i < 64; i++) { const t0 = i * 0.25, b = i % 16; if (b === 0 || b === 3 || b === 6 || b === 10 || b === 13) { tone(oc, t0, 0.3, 0.75, 'sine', 120, 42, 0.002); nz(oc, t0, 0.07, 0.2, 'lowpass', 1500, 200, 0.7, 0.001); } if (b === 4 || b === 12) nz(oc, t0, 0.16, 0.3, 'bandpass', 1900, 900, 0.8, 0.001); if (b % 2 === 0) nz(oc, t0, 0.04, 0.06, 'highpass', 8000, 7000, 0.5, 0.0005); const f = [73.42, 73.42, 87.31, 73.42, 98, 73.42, 87.31, 65.41][(i >> 1) % 8]; tone(oc, t0, 0.2, 0.2, 'sawtooth', f, f * 0.98, 0.004); if (b === 0 || b === 8) { tone(oc, t0, 0.5, 0.1, 'sawtooth', 293.66, 293.66, 0.01); tone(oc, t0, 0.5, 0.08, 'sawtooth', 440, 440, 0.01); } } }],
};

async function renderOne(name, dur, build) {
  const oc = offline(dur);
  build(oc, dur);
  buffers.set(name, await oc.startRendering());
}
async function renderLoop(name, dur, build) {
  const tail = 1.5, oc = offline(dur + tail);
  build(oc, dur + tail);
  const full = await oc.startRendering();
  const src = full.getChannelData(0), n = Math.floor(dur * SR), x = Math.floor(tail * SR);
  const out = new Float32Array(n);
  out.set(src.subarray(0, n));
  for (let i = 0; i < x; i++) { const k = i / x; out[i] = src[i] * k + src[n + i] * (1 - k); }   // fold the tail into the head
  const buf = ctx.createBuffer(1, n, SR); buf.copyToChannel(out, 0);
  buffers.set(name, buf);
}

async function loadFile(name, url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    buffers.set(name, buf);
    return true;
  } catch { return false; }
}

export const audio = {
  get ready() { return ready; },
  report: { loaded: [], failed: [] },

  /** Create the context. Call from a user gesture (splash click / key). */
  async unlock(manifest) {
    if (unlocked) { if (ctx.state === 'suspended') ctx.resume(); return; }
    unlocked = true;
    manifestAudio = (manifest && manifest.audio) || {};
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
    master = ctx.createGain();
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.18;
    master.connect(comp).connect(ctx.destination);
    sfxBus = ctx.createGain(); musicBus = ctx.createGain(); uiBus = ctx.createGain();
    sfxBus.connect(master); musicBus.connect(master); uiBus.connect(master);
    this.applyVolumes();
    const jobs = [];
    for (const n in RECIPES) jobs.push(renderOne(n, RECIPES[n][0], RECIPES[n][1]));
    for (const n in LOOPS) jobs.push(renderLoop(n, LOOPS[n][0], LOOPS[n][1]));
    await Promise.all(jobs);
    // generated files override the synthesized buffers of the same name
    await Promise.all(Object.keys(manifestAudio).filter((n) => !n.startsWith('vo_')).map(async (n) => {
      (await loadFile(n, manifestAudio[n]) ? this.report.loaded : this.report.failed).push(n);
    }));
    ready = true;
    for (const k of ['calm', 'tension', 'combat']) this._startMusicLayer(k);
    bus.emit('audioready');
  },

  applyVolumes() {
    if (!ctx || !G.settings) return;
    master.gain.value = G.settings.volMaster;
    sfxBus.gain.value = G.settings.volSfx;
    uiBus.gain.value = G.settings.volSfx;
    musicBus.gain.value = G.settings.volMusic * 0.8;
  },
  suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); },
  resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); },

  /**
   * Play a one-shot. o: { x,y,z (world position → 3D), vol, rate, ref (distance
   * at which it is full volume), max, ui, low (drop first when voices run out) }
   */
  play(name, o) {
    if (!ready) return;
    const buf = buffers.get(name);
    if (!buf) return;
    if (voices >= MAX_VOICES && o && o.low) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (o && o.rate) || 1;
    const g = ctx.createGain();
    g.gain.value = (o && o.vol) ?? 1;
    let node = src.connect(g);
    if (o && o.x !== undefined) {
      const p = ctx.createPanner();
      p.panningModel = 'equalpower'; p.distanceModel = 'inverse';
      p.refDistance = o.ref || 4; p.maxDistance = o.max || 400; p.rolloffFactor = o.roll || 1.1;
      p.positionX.value = o.x; p.positionY.value = o.y; p.positionZ.value = o.z;
      node = node.connect(p);
    }
    node.connect(o && o.ui ? uiBus : sfxBus);
    voices++;
    src.onended = () => { voices--; };
    src.start();
  },
  ui(name) { this.play(name, { ui: true, vol: 0.7 }); },

  /** Start/stop/level a looping bed (rain, wind, fire). */
  loop(name, vol) {
    if (!ready) return;
    let l = loops.get(name);
    if (!l) {
      if (vol <= 0) return;
      const buf = buffers.get(name);
      if (!buf) return;
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(gain).connect(sfxBus); src.start();
      l = { src, gain }; loops.set(name, l);
    }
    l.gain.gain.setTargetAtTime(vol, ctx.currentTime, 0.4);
  },
  stopLoops() { if (!ctx) return; for (const [, l] of loops) l.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.2); for (const h of [...loops3d]) h.stop(); },

  /**
   * A looping sound at a place in the world (vehicle engines, tracks). Returns a
   * handle: set(x, y, z, vol, rate) moves and levels it, stop() fades it out.
   * o: { ref (distance at full volume), roll }
   */
  loop3d(name, o = {}) {
    if (!ready) return null;
    const buf = buffers.get(name);
    if (!buf) return null;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const p = ctx.createPanner();
    p.panningModel = 'equalpower'; p.distanceModel = 'inverse'; p.refDistance = o.ref || 6; p.maxDistance = 600; p.rolloffFactor = o.roll || 1;
    src.connect(gain).connect(p).connect(sfxBus);
    src.start(0, Math.random() * buf.duration);
    const h = {
      set(x, y, z, vol, rate) {
        p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
        gain.gain.setTargetAtTime(vol, ctx.currentTime, 0.12);
        if (rate) src.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.2);
      },
      stop() {
        if (!loops3d.has(h)) return;
        loops3d.delete(h);
        gain.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
        setTimeout(() => { try { src.stop(); src.disconnect(); } catch { /* already stopped */ } }, 1500);
      },
    };
    loops3d.add(h);
    return h;
  },

  /** Follow the camera. */
  listener(cam) {
    if (!ready) return;
    const L = ctx.listener, e = cam.matrixWorld.elements;
    if (L.positionX) {
      L.positionX.value = e[12]; L.positionY.value = e[13]; L.positionZ.value = e[14];
      L.forwardX.value = -e[8]; L.forwardY.value = -e[9]; L.forwardZ.value = -e[10];
      L.upX.value = e[4]; L.upY.value = e[5]; L.upZ.value = e[6];
    } else {
      L.setPosition(e[12], e[13], e[14]); L.setOrientation(-e[8], -e[9], -e[10], e[4], e[5], e[6]);
    }
  },

  // ── music
  _startMusicLayer(k) {
    const name = buffers.has('music_' + k + '_file') ? 'music_' + k + '_file' : 'music_' + k;
    const buf = buffers.get(manifestAudio['music_' + k] ? 'music_' + k : name);
    if (!buf) return;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const gain = ctx.createGain(); gain.gain.value = 0;
    src.connect(gain).connect(musicBus); src.start();
    music.layers[k] = { src, gain };
  },
  /** 'calm' | 'tension' | 'combat' | 'off' */
  setMusic(state) {
    if (music.state === state) return;
    music.state = state;
    const t = music.target;
    if (state === 'calm') { t.calm = 1; t.tension = 0; t.combat = 0; }
    else if (state === 'tension') { t.calm = 0.55; t.tension = 1; t.combat = 0; }
    else if (state === 'combat') { t.calm = 0.2; t.tension = 0.45; t.combat = 1; }
    else { t.calm = 0; t.tension = 0; t.combat = 0; }
    if (!ready) return;
    for (const k in music.layers) music.layers[k].gain.gain.setTargetAtTime(t[k], ctx.currentTime, state === 'combat' ? 0.35 : 1.3);
  },
  musicState() { return music.state; },

  /**
   * Radio line: squelch, voice (a generated file `vo_<key>` when the manifest
   * lists one, otherwise a short synthetic garble), squelch. The subtitle is
   * raised on the bus for the HUD. Returns the display duration in seconds.
   */
  radio(key, text) {
    const dur = clamp01(text.length / 90) * 3.5 + 2.6;
    bus.emit('subtitle', text, dur);
    if (!ready) return dur;
    this.play('radio_on', { ui: true, vol: 0.5 });
    const vo = 'vo_' + key;
    const start = () => this.play(buffers.has(vo) ? vo : 'radio_voice', { ui: true, vol: buffers.has(vo) ? 1 : 0.35 });
    if (manifestAudio[vo] && !buffers.has(vo)) loadFile(vo, manifestAudio[vo]).then(start); else setTimeout(start, 180);
    setTimeout(() => this.play('radio_off', { ui: true, vol: 0.4 }), dur * 1000 - 300);
    return dur;
  },
  has(name) { return buffers.has(name); },
  names() { return [...buffers.keys()]; },
};
