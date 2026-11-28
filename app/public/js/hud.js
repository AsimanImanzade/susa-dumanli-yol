/**
 * hud.js — the in-mission HUD. Text lives in DOM elements (crisp, localised);
 * everything that follows the world or the crosshair is drawn on one 2D
 * canvas: crosshair, hit markers, detection eyes and arrows, damage
 * direction, objective marker, the radial wheel, compass and minimap.
 *
 * What is shown depends on the difficulty's HUD aids (config.DIFFICULTY.hud).
 */
import * as THREE from 'three';
import { G, bus, clamp, clamp01, angDelta, yawTo, fmtTime, dist2D, damp, TAU } from './ctx.js';
import { WHEEL, PLAYER, STEALTH, THROWABLES, ITEMS, WEAPONS } from './config.js';
import { vehicles } from './vehicles.js';
import { R } from './render.js';
import { meterBand } from './stealth.js';
import { noise } from './noise.js';
import { weapons } from './weapons.js';
import { equip } from './equipment.js';
import { interact } from './interact.js';
import { climb } from './climb.js';
import { ai } from './ai.js';
import { game } from './game.js';
import { input } from './input.js';
import { t, keyLabel } from './loc.js';
import { icons, buildIcons, prepareIcons } from './icons.js';

const $ = (s) => document.querySelector(s);
const _v = new THREE.Vector3();
const BAND = ['#f2f2ee', '#ffcf4a', '#ff4b3a'];
let cv, g, W = 1, H = 1, root;
const el = {};
const cache = {};
const hits = [];            // damage direction indicators
const feed = [], toasts = [];
let hitT = 0, hitHead = false, hitKill = false, subT = 0, mapOpen = false, climbPrompt = '', marker = null;
// binoculars: raise 0..1, sway clock, built geometry, tag flashes
const bn = { t: 0, clock: 0, amp: 1, built: '', R: 300, ppm: 0, focus: 0, zoomI: 0, fx: [] };
const BN_SHEET = '<div class="bn-optic"><div class="bn-blur"></div><canvas class="bn-mask"></canvas><svg class="bn-ret" xmlns="http://www.w3.org/2000/svg"></svg>' +
  '<div class="bn-read bn-brg"><small></small><span></span></div><div class="bn-read bn-rng"><small></small><span></span></div><div class="bn-read bn-mag"><small></small><span></span></div>' +
  '<div class="bn-hint"></div></div><div class="bn-focus"></div><div class="bn-dim"></div><div class="bn-dmg"></div><div class="bn-flash"></div>';
const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);

// ───────────────────────── status cluster (bottom left) ─────────────────────────
// Health ring in five colour bands blended smoothly (anchors at the band centres), a white
// "chip" that lingers on the lost part then drains, a pale sweep ahead of the fill while
// healing; armour as four plate segments on the outer ring; the noise meter as rising bars.
const HP_STOPS = [[10, [255, 59, 48]], [30, [255, 140, 32]], [50, [255, 212, 60]], [70, [136, 216, 92]], [90, [30, 158, 78]]];
function hpRGB(h) {
  if (h <= HP_STOPS[0][0]) return HP_STOPS[0][1];
  for (let i = 1; i < HP_STOPS.length; i++) {
    const [h1, c1] = HP_STOPS[i];
    if (h <= h1) { const [h0, c0] = HP_STOPS[i - 1], k = (h - h0) / (h1 - h0); return c0.map((v, j) => Math.round(v + (c1[j] - v) * k)); }
  }
  return HP_STOPS[HP_STOPS.length - 1][1];
}
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const RING_R = 37, AR_R = 45.6;
function arcPath(r, a0, a1) {           // degrees, clockwise from 12 o'clock
  const P = (a) => { const t = (a - 90) * Math.PI / 180; return (50 + r * Math.cos(t)).toFixed(2) + ' ' + (50 + r * Math.sin(t)).toFixed(2); };
  return `M${P(a0)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${P(a1)}`;
}
const AR_SEG = 4;
const ring = (cls, r, w) => `<circle class="${cls}" cx="50" cy="50" r="${r}" stroke-width="${w}" pathLength="100" transform="rotate(-90 50 50)"/>`;
const STATUS_HTML = `<div id="h-status">
  <div class="gauge"><svg viewBox="0 0 100 100" aria-hidden="true">
    <circle class="disc" cx="50" cy="50" r="49.5"/>
    ${Array.from({ length: AR_SEG }, (_, i) => `<path class="art" d="${arcPath(AR_R, i * 90 + 4, i * 90 + 86)}" stroke-width="4.2"/>`).join('')}
    ${Array.from({ length: AR_SEG }, (_, i) => `<path class="arf" d="${arcPath(AR_R, i * 90 + 4, i * 90 + 86)}" stroke-width="4.2" pathLength="100" stroke-dasharray="0 100"/>`).join('')}
    ${ring('glow', RING_R, 13)}${ring('trk', RING_R, 8.5)}${ring('heal', RING_R, 8.5)}${ring('chip', RING_R, 8.5)}${ring('hpf', RING_R, 8.5)}${ring('seg', RING_R, 9.5)}
    <path class="cross" d="M45.5 37.5h9v8h8v9h-8v8h-9v-8h-8v-9h8Z"/>
    <text class="pct" x="50" y="57.5"></text><text class="arp" x="50" y="71"></text>
  </svg></div>
  <div class="side">
    <div class="name"></div>
    <div class="row"><svg class="stance" viewBox="0 0 24 24" aria-hidden="true">
      <g class="s0"><circle cx="12" cy="3.4" r="2.3"/><path d="M12 7.2V14.2M12 14.2L9.6 22M12 14.2L14.4 22M12 8.8L8.6 12.8M12 8.8L15.6 12.4"/></g>
      <g class="s1"><circle cx="13.6" cy="7.4" r="2.3"/><path d="M12.8 10.6L10.2 16.2M10.2 16.2L14.8 18M14.8 18L13.6 22.4M10.2 16.2L7.4 22.4M12.4 12.2L16.6 14.2"/></g>
      <g class="s2"><circle cx="20.2" cy="15.2" r="2.2"/><path d="M17.6 17.6L6.4 19.2M6.4 19.2L1.6 20.2M17 17.8L21.6 19.8"/><path class="gnd" d="M1 22.6H23"/></g>
    </svg><span class="stl"></span></div>
    <div class="bleed hidden"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5C9 7 6 10.6 6 14.6a6 6 0 0 0 12 0C18 10.6 15 7 12 2.5Z"/></svg><span></span></div>
    <div class="noise"><svg class="spk" viewBox="0 0 24 24" aria-hidden="true"><path class="sb" d="M3 9h4l5-4v14l-5-4H3Z"/><path class="w1" d="M15 8.6a4.8 4.8 0 0 1 0 6.8"/><path class="w2" d="M17.6 6a8.4 8.4 0 0 1 0 12"/></svg>
      <div class="eq">${'<i></i>'.repeat(12)}</div><span class="nzl"></span></div>
  </div>
</div>`;
const STATUS_SEL = { status: '#h-status', gauge: '#h-status .gauge', hpf: '#h-status .hpf', chip: '#h-status .chip', heal: '#h-status .heal', glow: '#h-status .glow',
  cross: '#h-status .cross', pct: '#h-status .pct', arp: '#h-status .arp', name: '#h-status .name', stance: '#h-status .stance', stl: '#h-status .stl',
  bleed: '#h-status .bleed', bleedT: '#h-status .bleed span', noise: '#h-status .noise', nzl: '#h-status .nzl' };

// ───────────────────────── weapon cluster (bottom right) ─────────────────────────
// Flat weapon silhouettes (viewBox 120×30, muzzle to the right); `sup` is drawn when a suppressor is fitted.
const GUNS = {
  akm: { body: 'M2 9.5L25 11.5L33 10H60L61 8.5H64L65 10H86V11H101V13H86V14H66L64 15.5H60L58.2 14.4L58.4 16L58.6 25L53 26.6L50.2 15.6H44.4L42.6 22.6H37.6L38.6 15.6H33L25 17L4 22L2 21.4ZM94.6 8H96.8V11H94.6Z', sup: 'M101 10.2H116.5V13.8H101Z' },
  ak74: { body: 'M2 9.5L25 11.5L33 10H60L61 8.5H64L65 10H86V11H99V13H86V14H66L64 15.5H60L58.2 14.4L58.4 16L58.6 25L53 26.6L50.2 15.6H44.4L42.6 22.6H37.6L38.6 15.6H33L25 17L4 22L2 21.4ZM94.6 8H96.8V11H94.6ZM99 10.4H105.4V13.6H99Z', sup: 'M105.4 10.2H119V13.8H105.4Z' },
  svd: { body: 'M2 10L28 11H33V10.2H75V11H108V12.6H75L74 14H60L58 15L58.6 21.6L54.4 22L53.6 14.8H44L41 20.6H37L38.6 14.8H33L24 19L5 20.2L2 19ZM7.5 14.4L20 13.6L18.2 17.2L8.6 17.8ZM42 5H66L67 6V8L66 9H42L41 8V6ZM48 9H50V10.2H48ZM58 9H60V10.2H58Z', sup: 'M108 10.1H119.6V13.5H108Z' },
  pistol: { body: 'M58 8H100V14.2H96.5L95.5 15.2H79L76.6 17.6H72.4L71 15.2H69.6L71.4 27.4L61.6 28L59.6 15.4L58 14.2ZM96 6.6H98V8H96Z', sup: 'M100 8.7H117V13.5H100Z' },
};
const WEAPON_HTML = `<div id="h-wpn">
  <div class="eq">
    <div class="slot thr"><img alt=""><b></b><span class="keys"><kbd></kbd><kbd></kbd></span></div>
    <div class="slot med"><img alt=""><b></b><span class="keys"><kbd></kbd></span></div>
    <div class="slot ban"><img alt=""><b></b><span class="keys"><kbd></kbd></span></div>
    <div class="slot c4"><img alt=""><b></b><span class="keys"><kbd></kbd></span></div>
    <div class="slot nvg hidden"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9.5h18v6.2h-6l-1.6-2h-2.8l-1.6 2H3ZM10 5.5h4v4h-4Z"/></svg><b></b></div>
  </div>
  <div class="main">
    <div class="head"><span class="mode"><i></i><i></i><i></i><em></em></span><svg class="gun" viewBox="0 0 120 30" aria-hidden="true"><path class="gb"/><path class="gs"/></svg></div>
    <div class="wname"></div>
    <div class="ammo"><span class="hint hidden"><kbd></kbd><em></em></span><b class="mag"></b><span class="res"></span></div>
    <div class="pips"></div>
    <div class="rld hidden"><div class="bar"><i></i></div><span></span></div>
    <div class="supr hidden"><svg viewBox="0 0 24 12" aria-hidden="true"><path d="M1 3.5h3v5H1ZM4 2.5h18v7H4Z"/></svg><div class="bar"><i></i></div><span></span></div>
  </div>
</div>`;
const WEAPON_SEL = { wpn: '#h-wpn', wname: '#h-wpn .wname', mag: '#h-wpn .mag', res: '#h-wpn .res', mode: '#h-wpn .mode', modeT: '#h-wpn .mode em', gunB: '#h-wpn .gb', gunS: '#h-wpn .gs',
  hint: '#h-wpn .hint', hintK: '#h-wpn .hint kbd', hintT: '#h-wpn .hint em', pips: '#h-wpn .pips', rld: '#h-wpn .rld', rldB: '#h-wpn .rld i', rldT: '#h-wpn .rld span',
  supBox: '#h-wpn .supr', sup: '#h-wpn .supr i', supL: '#h-wpn .supr span',
  sThr: '#h-wpn .thr', sThrImg: '#h-wpn .thr img', sThrN: '#h-wpn .thr b', sThrK1: '#h-wpn .thr kbd:first-child', sThrK2: '#h-wpn .thr kbd:last-child',
  sMed: '#h-wpn .med', sMedImg: '#h-wpn .med img', sMedN: '#h-wpn .med b', sMedK: '#h-wpn .med kbd',
  sBan: '#h-wpn .ban', sBanImg: '#h-wpn .ban img', sBanN: '#h-wpn .ban b', sBanK: '#h-wpn .ban kbd',
  sC4: '#h-wpn .c4', sC4Img: '#h-wpn .c4 img', sC4N: '#h-wpn .c4 b', sC4K: '#h-wpn .c4 kbd', sNvg: '#h-wpn .nvg', sNvgN: '#h-wpn .nvg b' };

const FONT = "Bahnschrift, 'DIN Condensed', 'Roboto Condensed', 'Arial Narrow', system-ui, sans-serif";
const CARD = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
const smooth01 = (x) => { const v = clamp01(x); return v * v * (3 - 2 * v); };
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
function hexPath(k, x, y, r) { k.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i - Math.PI / 2; k[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r); } k.closePath(); }
function diamondPath(k, x, y, r) { k.beginPath(); k.moveTo(x, y - r); k.lineTo(x + r * 0.8, y); k.lineTo(x, y + r); k.lineTo(x - r * 0.8, y); k.closePath(); }
const TANK_HOLD = 20;          // Hard: seconds the tank marker stays at its last-seen point
// objective markers: main task = filled amber diamond, optional = hollow blue hexagon
const OPT_COL = '#7fc8ff', OBJ_COL = '#ffb648';
const MK_MAIN = '<svg class="mk" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .8L11.2 6L6 11.2L.8 6Z"/></svg>';
const MK_OPT = '<svg class="mk" viewBox="0 0 12 12" aria-hidden="true"><path class="hx" d="M6 1L10.4 3.5V8.5L6 11L1.6 8.5V3.5Z"/><path class="ck" d="M3.6 6.2L5.3 7.9L8.6 4.4"/></svg>';
const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)');
/** A short highlight on a number that just changed (skipped under reduced motion). */
function bump(node, up) {
  if (!node.animate || (reduceMotion && reduceMotion.matches)) return;
  node.animate([{ transform: 'scale(1.32)', color: up ? '#ffe2b0' : '#ffffff' }, { transform: 'scale(1)' }], { duration: 300, easing: 'ease-out' });
}
/** A number that bumps when it changes. */
function num(key, node, n) { const s = String(n); if (cache[key] !== s) { const up = cache[key] !== undefined && n > +cache[key]; const had = cache[key] !== undefined; cache[key] = s; node.textContent = s; if (had) bump(node, up); } }
function attr(key, node, name, v) { if (cache[key] !== v) { cache[key] = v; node.setAttribute(name, v); } }
function cls(key, node, name, on) { if (cache[key] !== on) { cache[key] = on; node.classList.toggle(name, on); } }
// live HUD state (cleared in reset)
const st = { hp: -1, chip: 0, chipHold: 0, nz: 0, seenOpen: new Set(), doneAt: new Map(), objSig: '', tank: null, tankChk: 0, first: true };

function set(key, node, text) { if (cache[key] !== text) { cache[key] = text; node.textContent = text; } }
function bar(key, node, v) { const s = Math.round(clamp01(v) * 100) + '%'; if (cache[key] !== s) { cache[key] = s; node.style.width = s; } }
function show(key, node, on) { if (cache[key] !== on) { cache[key] = on; node.classList.toggle('hidden', !on); } }

function project(x, y, z) {
  const cam = G.overrideCamera || G.camera;
  _v.set(x, y, z).project(cam);
  if (_v.z > 1 || _v.z < -1) return null;
  return { x: (_v.x * 0.5 + 0.5) * W, y: (-_v.y * 0.5 + 0.5) * H };
}

export const hud = {
  init() {
    root = $('#hud');
    root.innerHTML = `
      <div id="h-obj"><div class="act"></div><div class="list"></div><div class="rem hidden"><svg viewBox="0 0 12 12"><path d="M6 1.2a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4ZM1.8 11c0-2.6 1.9-4.3 4.2-4.3s4.2 1.7 4.2 4.3Z"/></svg><span></span></div></div>
      <canvas id="h-compass"></canvas>
      <canvas id="h-minimap" class="hidden"></canvas>
      <div id="h-feed"></div><div id="h-toasts"></div>
      ${STATUS_HTML}
      ${WEAPON_HTML}
      <div id="h-prompt" class="hidden"><span></span><div class="bar"><i></i></div></div>
      <div id="h-use" class="hidden"><span></span><div class="bar"><i></i></div></div>
      <div id="h-sub" class="hidden"></div>
      <div id="h-climb" class="hidden"><div class="state"></div><div class="lbl"></div><div class="bar"><i></i></div></div>
      <div id="h-scope" class="hidden"><div class="tip"></div></div><div id="h-binoc" class="hidden">${BN_SHEET}</div>
      <div id="h-map" class="hidden"><h2></h2><div class="mwrap"><canvas width="900" height="620"></canvas><div class="legend"></div></div><p></p></div>`;
    cv = $('#hudc'); g = cv.getContext('2d');
    for (const [k, s] of Object.entries({ act: '#h-obj .act', objList: '#h-obj .list', remBox: '#h-obj .rem', rem: '#h-obj .rem span',
      ...STATUS_SEL, ...WEAPON_SEL, legend: '#h-map .legend',
      prompt: '#h-prompt', promptT: '#h-prompt span', promptB: '#h-prompt i', use: '#h-use', useT: '#h-use span', useB: '#h-use i', sub: '#h-sub',
      climb: '#h-climb', climbS: '#h-climb .state', climbL: '#h-climb .lbl', climbB: '#h-climb i', scope: '#h-scope', scopeTip: '#h-scope .tip', binoc: '#h-binoc', bnOptic: '#h-binoc .bn-optic', bnBlur: '#h-binoc .bn-blur', bnMask: '#h-binoc .bn-mask', bnRet: '#h-binoc .bn-ret',
      bnBrgL: '#h-binoc .bn-brg small', bnBrg: '#h-binoc .bn-brg span', bnRngL: '#h-binoc .bn-rng small', bnRng: '#h-binoc .bn-rng span', bnMagL: '#h-binoc .bn-mag small', bnMag: '#h-binoc .bn-mag span',
      bnHint: '#h-binoc .bn-hint', bnFocus: '#h-binoc .bn-focus', bnDim: '#h-binoc .bn-dim', bnDmg: '#h-binoc .bn-dmg', bnFlash: '#h-binoc .bn-flash',
      map: '#h-map', mapT: '#h-map h2', mapC: '#h-map canvas', mapP: '#h-map p', feed: '#h-feed', toasts: '#h-toasts', compass: '#h-compass', minimap: '#h-minimap' })) el[k] = $(s);
    el.arf = [...root.querySelectorAll('#h-status .arf')]; el.eqBars = [...root.querySelectorAll('#h-status .eq i')];
    el.eqBars.forEach((b, i) => { b.style.height = (4 + i) + 'px'; b.className = i < 5 ? 'c0' : i < 9 ? 'c1' : 'c2'; });
    window.addEventListener('resize', () => this.resize());
    this.resize();

    bus.on('toast', (text, kind) => { toasts.push({ text, kind: kind || '', t: 3.2 }); if (toasts.length > 4) toasts.shift(); this._lists(); });
    bus.on('subtitle', (text, dur) => { if (!G.settings.subtitles) return; el.sub.textContent = text; el.sub.classList.remove('hidden'); subT = dur; });
    bus.on('hitmarker', (head, kill) => { hitT = 0.22; hitHead = head; hitKill = kill; });
    bus.on('playerHit', (x, z, amount) => { hits.push({ x, z, t: 1.4, a: clamp(amount / 30, 0.4, 1) }); if (hits.length > 6) hits.shift(); });
    bus.on('kill', (e, info) => {
      const parts = [t('kf_kill')];
      if (info.head) parts.push(t('kf_head'));
      if (info.by === 'knife' || info.by === 'tknife') parts.push(t('kf_knife'));
      if (info.by === 'blast') parts.push(t('kf_blast'));
      if (info.stealth) parts.push(t('kf_stealth'));
      if (info.dist > 40) parts.push(t('kf_long', { m: Math.round(info.dist) }));
      feed.push({ text: parts.join(' · '), t: 4.5, head: !!info.head }); if (feed.length > 5) feed.shift(); this._lists();
    });
    bus.on('climbPrompt', (text) => { climbPrompt = text; });
    bus.on('marker', (x, z, dur) => { marker = { x, z, t: dur }; });
    bus.on('binocTag', (e) => { bn.fx.push({ e, t: 0.9 }); if (bn.fx.length > 6) bn.fx.shift(); });
  },

  resize() {
    W = window.innerWidth; H = window.innerHeight; cv.width = W; cv.height = H; bn.built = '';
    // one scale for the corner clusters: 0.8 on an 800×600 pane, 1 at 1280×720, up to 1.3 at 1080p and above
    const us = clamp(Math.min(W / 1280, H / 760), 0.8, 1.3);
    root.style.setProperty('--hs', us.toFixed(3));
    // the compass shrinks on narrow screens so it never runs into the task list or the minimap
    // (kept clear of the task list on the left and of the minimap on the right)
    const objW = Math.min(W * 0.34, 420) * us + 22, dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.round(clamp(Math.min(W - 2 * (objW + 18), W - 420), 230, 560)), ch = 58;
    el.compass.width = cw * dpr; el.compass.height = ch * dpr; el.compass.style.width = cw + 'px'; el.compass.style.height = ch + 'px';
    const ms = 176;
    el.minimap.width = ms * dpr; el.minimap.height = ms * dpr; el.minimap.style.width = ms + 'px'; el.minimap.style.height = ms + 'px';
    // the full map fills most of the screen
    this.mapMax = { w: Math.round(clamp(W * 0.94 - (W >= 980 ? 236 : 0), 300, 1500)), h: Math.round(clamp(H * (W >= 980 ? 0.8 : 0.62) - 40, 220, 1000)) };
    this.dpr = dpr; this._legendLang = '';
    if (mapOpen) this._map(game.objectives());
  },
  setVisible(on) { root.classList.toggle('hidden', !on); cv.classList.toggle('hidden', !on); if (!on) { mapOpen = false; el.map.classList.add('hidden'); } },
  reset() {
    bn.t = 0; bn.fx.length = 0; feed.length = 0; toasts.length = 0; hits.length = 0; marker = null; subT = 0; el.sub.classList.add('hidden'); this._lists(); for (const k in cache) delete cache[k];
    st.hp = -1; st.chip = 0; st.chipHold = 0; st.nz = 0; st.seenOpen.clear(); st.doneAt.clear(); st.objSig = ''; st.tank = null; st.tankChk = 0; st.act = 0; st.mission = null;
    el.objList.replaceChildren(); el.pips.replaceChildren();
  },
  toggleMap() { mapOpen = !mapOpen; el.map.classList.toggle('hidden', !mapOpen); if (mapOpen) this._map(game.objectives()); },
  mapOpen() { return mapOpen; },

  _lists() {
    el.feed.replaceChildren(...feed.map((f) => { const d = document.createElement('div'); d.textContent = f.text; if (f.head) d.className = 'head'; return d; }));
    el.toasts.replaceChildren(...toasts.map((f) => { const d = document.createElement('div'); d.textContent = f.text; d.className = f.kind; return d; }));
  },

  frame(dt) {
    const p = G.player, m = G.mission;
    if (!p || !m || !G.level) return;
    const aids = m.diff.hud, cl = G.level.climb ? climb.hud() : null;

    // ── timed lists
    let dirty = false;
    for (const list of [feed, toasts]) for (let i = list.length - 1; i >= 0; i--) { list[i].t -= dt; if (list[i].t <= 0) { list.splice(i, 1); dirty = true; } }
    if (dirty) this._lists();
    if (subT > 0) { subT -= dt; if (subT <= 0) el.sub.classList.add('hidden'); }

    // ── objectives (one call per frame; the canvas, compass and maps reuse it)
    const objs = game.objectives();
    this._objectives(objs, m, aids, dt);
    this._status(p, m, dt);
    this._weapon();

    // ── prompts
    const prompt = cl ? climbPrompt : interact.prompt;
    show('promptOn', el.prompt, !!prompt);
    if (prompt) { set('prompt', el.promptT, prompt); bar('promptB', el.promptB, interact.progress); }
    show('useOn', el.use, !!equip.using);
    if (equip.using) { set('useT', el.useT, t('use_' + equip.using.item)); bar('useB', el.useB, equip.using.t / equip.using.dur); }
    show('climbOn', el.climb, !!cl);
    if (cl) {
      set('climbS', el.climbS, t(cl.alarm ? 'spotted' : cl.freeze && !cl.onLedge ? 'climbFreeze' : 'climbGo'));
      if (cache.climbCls !== (cl.freeze ? 1 : 0)) { cache.climbCls = cl.freeze ? 1 : 0; el.climbS.classList.toggle('warn', cl.freeze); }
      set('climbL', el.climbL, t('grip') + '  ·  ' + t('climbHint')); bar('climbB', el.climbB, cl.grip);
    }
    show('scopeOn', el.scope, weapons.scoped && !G.overrideCamera);
    if (weapons.scoped) set('scopeTip', el.scopeTip, t('p_holdBreath', { key: keyLabel(input.bindOf('sprint')) }) + '  ·  ' + Math.round(p.breath / PLAYER.breathMax * 100) + '%');
    this._binoc(dt);
    show('miniOn', el.minimap, aids.minimap && !cl && !mapOpen);

    this._canvas(dt, aids, cl, objs);
    this._compass(objs);
    if (aids.minimap && !cl && !mapOpen) this._minimap(aids, objs);
    if (mapOpen) this._map(objs);
  },

  // ───────────────────────── objectives (top left) ─────────────────────────
  /**
   * The task list, the tank's last-seen point and the remaining counter. Each task gets one
   * line: the main task behind a filled amber diamond, optional tasks behind a hollow blue
   * hexagon. A finished optional task is ticked and struck through, then fades away; tasks
   * that were already done when the act (or a checkpoint) loaded are never shown.
   *
   * The tank moves. Easy and Normal show its live position. Hard turns the HUD aids off, and
   * binocular tagging only works on soldiers, so there the marker shows where the player last
   * saw it: refreshed while it is in view (range, view cone and a clear line of sight above
   * the hull) or while it is firing at the player, held for TANK_HOLD seconds after that, at
   * the last-seen spot. Out of contact long enough, the marker disappears.
   */
  _objectives(objs, m, aids, dt) {
    set('act', el.act, t('act' + m.act) + '  ·  ' + fmtTime(m.stats.time));
    const now = G.realTime, p = G.player;
    if (st.act !== m.act || st.mission !== m) { st.act = m.act; st.mission = m; st.seenOpen.clear(); st.doneAt.clear(); st.tank = null; }
    let sig = '';
    for (const o of objs) {
      if (!o.done) st.seenOpen.add(o.id);
      o.vis = true; o.stage = '';
      if (o.done) {
        if (!st.seenOpen.has(o.id)) { o.vis = false; continue; }
        if (!st.doneAt.has(o.id)) st.doneAt.set(o.id, now);
        const age = now - st.doneAt.get(o.id);
        o.vis = age < 6; o.stage = age > 4.2 ? 'gone' : 'done';
      }
      if (o.moving && o.point) {
        if (aids.markers || aids.arrows) { o.seen = true; continue; }           // Easy / Normal: live
        const tk = st.tank || (st.tank = { x: 0, z: 0, t: -99 });
        st.tankChk -= dt;
        if (st.tankChk <= 0) {
          st.tankChk = 0.35;
          const v = vehicles.tanks[0];
          if (v) {
            const d = dist2D(p.x, p.z, v.x, v.z), off = Math.abs(angDelta(p.yaw, yawTo(p.x, p.z, v.x, v.z)));
            const inView = d < 160 && off < 0.95 && G.world.los(p.x, p.eyeY(), p.z, v.x, G.level.gy(v.x, v.z) + 2.6, v.z);
            if (inView || v.state === 'combat') { tk.x = v.x; tk.z = v.z; tk.t = now; }
          }
        }
        const age = now - tk.t;
        if (age < TANK_HOLD) { o.point = { x: tk.x, z: tk.z }; o.seen = age < 1.2; o.stale = age >= 1.2; } else o.point = null;
      }
    }
    for (const o of objs) if (o.vis) sig += o.id + '|' + o.text + '|' + o.stage + ';';
    if (sig !== st.objSig) {
      st.objSig = sig;
      el.objList.replaceChildren(...objs.filter((o) => o.vis && o.text).map((o) => {
        const d = document.createElement('div');
        d.className = 'ob' + (o.optional ? ' opt' : '') + (o.stage ? ' ' + o.stage : '');
        d.innerHTML = o.optional ? MK_OPT : MK_MAIN;
        const s = document.createElement('span'); s.textContent = o.text; d.appendChild(s);
        return d;
      }));
    }
    const rem = objs.length ? objs[0].remaining : -1;
    show('remOn', el.remBox, rem >= 0);
    if (rem >= 0) {
      const txt = t('remaining', { n: rem });
      if (cache.rem !== txt) { const had = cache.remN !== undefined && cache.remN !== rem; cache.rem = txt; cache.remN = rem; el.rem.textContent = txt; if (had) bump(el.remBox, false); }
    }
  },

  // ───────────────────────── status (bottom left) ─────────────────────────
  _status(p, m, dt) {
    const max = PLAYER.maxHealth, h = clamp(p.health / max * 100, 0, 100);
    // displayed fill: drops at once on a hit (the chip keeps the lost part), sweeps up on a heal
    if (st.hp < 0) { st.hp = h; st.chip = h; }
    // a real hit (a drop of 1 hp or more in one frame) holds the chip; bleeding only feeds it, so it keeps draining
    if (h < st.hp - 0.05) { const hit = st.hp - h >= 1; st.chip = Math.max(st.chip, st.hp); st.hp = h; if (hit) st.chipHold = 0.6; }
    else if (h > st.hp) st.hp = Math.min(h, st.hp + dt * 70);
    st.chipHold -= dt;
    if (st.chipHold <= 0) st.chip = Math.max(st.hp, st.chip - dt * 42);
    if (st.chip < st.hp) st.chip = st.hp;
    const q = (v) => (Math.round(v * 4) / 4).toFixed(2);
    attr('hpf', el.hpf, 'stroke-dasharray', q(st.hp) + ' 100');
    attr('chip', el.chip, 'stroke-dasharray', q(st.chip) + ' 100');
    attr('heal', el.heal, 'stroke-dasharray', q(h) + ' 100');
    const c = rgb(hpRGB(st.hp));
    if (cache.hpCol !== c) { cache.hpCol = c; el.gauge.style.setProperty('--hp', c); }
    const band = h < 20 ? 'crit' : h < PLAYER.lowHealth ? 'low' : '';
    cls('gLow', el.gauge, 'low', band === 'low'); cls('gCrit', el.gauge, 'crit', band === 'crit');
    // armour: four plate segments of 25 each
    const a = clamp(p.armor, 0, 100), aq = Math.round(a * 2) / 2;
    if (cache.arQ !== aq) {
      cache.arQ = aq;
      el.arf.forEach((seg, i) => seg.setAttribute('stroke-dasharray', (clamp01((aq - i * 25) / 25) * 100).toFixed(1) + ' 100'));
      el.gauge.classList.toggle('noar', aq <= 0);
    }
    // centre: the percentage only when the player asked for numbers, otherwise a cross
    const pctOn = !!(G.settings && G.settings.hudPercent);
    cls('pctOn', el.gauge, 'nums', pctOn);
    if (pctOn) { set('pct', el.pct, String(Math.ceil(h))); set('arp', el.arp, a > 0 ? Math.round(a) + '' : ''); }

    set('name', el.name, m.name);
    attr('stance', el.stance, 'data-s', String(p.stance));
    set('stl', el.stl, t(['st_stand', 'st_crouch', 'st_prone'][p.stance]));
    show('bleedOn', el.bleed, p.bleed > 0);
    if (p.bleed) { set('bleedT', el.bleedT, t(p.bleed === 2 ? 'bleedingHeavy' : 'bleeding')); cls('bleedH', el.bleed, 'heavy', p.bleed === 2); }

    // noise: fast attack, slow release, twelve bars from quiet white through amber to red
    const l = clamp01(noise.playerLoudness(G.simTime));
    st.nz = l > st.nz ? damp(st.nz, l, 30, dt) : damp(st.nz, l, 4, dt);
    const lit = Math.min(12, Math.round(st.nz * 12));
    if (cache.nzLit !== lit) {
      cache.nzLit = lit;
      el.eqBars.forEach((b, i) => b.classList.toggle('on', i < lit));
      el.noise.dataset.lvl = lit === 0 ? '0' : lit <= 4 ? '1' : lit <= 8 ? '2' : '3';
    }
    set('nzl', el.nzl, t('noiseLbl'));
  },

  // ───────────────────────── weapon (bottom right) ─────────────────────────
  _weapon() {
    const w = weapons.hud(), def = WEAPONS[w.id], cap = def ? def.mag : Math.max(1, w.mag);
    set('wname', el.wname, w.name);
    num('mag', el.mag, w.mag); set('res', el.res, '/ ' + w.reserve);
    const gun = GUNS[w.id] || GUNS.akm;
    if (cache.gunId !== w.id) { cache.gunId = w.id; el.gunB.setAttribute('d', gun.body); el.gunS.setAttribute('d', gun.sup); }
    cls('gunSup', el.gunS, 'on', w.sup !== null && w.sup !== undefined);
    // fire mode: one lit round for single shots, three for automatic
    const auto = w.mode === 'auto';
    set('modeT', el.modeT, t('mode_' + w.mode)); cls('modeA', el.mode, 'auto', auto);
    // magazine pips (rebuilt when the weapon changes)
    if (cache.pipW !== w.id + cap) {
      cache.pipW = w.id + cap; cache.pipMag = -1;
      el.pips.replaceChildren(...Array.from({ length: cap }, () => document.createElement('i')));
      el.pips.style.setProperty('--n', cap);
    }
    if (cache.pipMag !== w.mag) {
      cache.pipMag = w.mag;
      const kids = el.pips.children;
      for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('x', i >= w.mag);
    }
    const low = w.mag <= Math.max(1, Math.floor(cap * 0.3)), empty = w.mag === 0;
    cls('wLow', el.wpn, 'low', low && !empty); cls('wEmpty', el.wpn, 'empty', empty);
    const rl = w.reloading > 0;
    show('rldOn', el.rld, rl); show('pipsOn', el.pips, !rl);
    if (rl) { bar('rldB', el.rldB, w.reloading); set('rldT', el.rldT, t('reloading')); }
    const hintOn = !rl && (low || empty);
    show('hintOn', el.hint, hintOn);
    if (hintOn) {
      const noRes = w.reserve <= 0;
      set('hintK', el.hintK, noRes ? '' : keyLabel(input.bindOf('reload'))); show('hintKOn', el.hintK, !noRes);
      set('hintT', el.hintT, noRes ? t(empty ? 'noAmmo' : 'h_lowAmmo') : empty ? t('h_empty') + ' · ' + t('h_reload') : t('h_reload'));
    }
    // suppressor wear and spares, only for weapons that take one
    show('supOn', el.supBox, w.canSup);
    if (w.canSup) {
      bar('sup', el.sup, w.sup ?? 0); set('supL', el.supL, w.supSpare > 0 ? '+' + w.supSpare : '');
      cls('supDim', el.supBox, 'dim', w.sup === null || w.sup === undefined);
      cls('supLow', el.supBox, 'low', (w.sup ?? 1) < 0.25);
    }

    // equipment: pictures once the icons exist
    if (!icons.ready() && G.realTime > (cache.iconAt ??= G.realTime + 1.5)) prepareIcons(WHEEL);
    const img = (key, node, kind) => { const u = icons.ready() ? icons.url(kind) : ''; if (u && cache[key] !== u) { cache[key] = u; node.src = u; } };
    const sel = equip.selected, nThr = equip.count(sel);
    img('thrSrc', el.sThrImg, sel); num('thrN', el.sThrN, nThr); cls('thrDim', el.sThr, 'dim', !nThr);
    if (cache.thrSel !== sel) { cache.thrSel = sel; el.sThr.title = t('i_' + sel); }
    set('thrK1', el.sThrK1, keyLabel(input.bindOf('throw'))); set('thrK2', el.sThrK2, keyLabel(input.bindOf('cycleThrow')));
    img('medSrc', el.sMedImg, 'medkit'); num('medN', el.sMedN, equip.inv.medkit); cls('medDim', el.sMed, 'dim', !equip.inv.medkit); set('medK', el.sMedK, keyLabel(input.bindOf('medkit')));
    img('banSrc', el.sBanImg, 'bandage'); num('banN', el.sBanN, equip.inv.bandage); cls('banDim', el.sBan, 'dim', !equip.inv.bandage); set('banK', el.sBanK, keyLabel(input.bindOf('bandage')));
    const placed = equip.c4s.length;
    img('c4Src', el.sC4Img, 'c4'); num('c4N', el.sC4N, equip.inv.c4); set('c4K', el.sC4K, keyLabel(input.bindOf('c4')) + (placed ? ' ●' + placed : ''));
    cls('c4Dim', el.sC4, 'dim', !equip.inv.c4 && !placed); cls('c4Arm', el.sC4, 'armed', placed > 0);
    show('nvgOn', el.sNvg, equip.nvg.on);
    if (equip.nvg.on) { set('nvgN', el.sNvgN, Math.round(equip.nvg.battery) + '%'); cls('nvgLow', el.sNvg, 'low', equip.nvg.battery < 20); }
  },

  _canvas(dt, aids, cl, objs) {
    const p = G.player, cx = W / 2, cy = H / 2;
    g.clearRect(0, 0, W, H);
    if (G.overrideCamera) return;
    g.lineCap = 'round';

    // enemies: detection eye above the head, tag brackets, easy-mode markers
    for (const e of G.enemies) {
      if (!e.alive) continue;
      const showEye = e.meter > 0.03 || e.state === 'combat' || e.state === 'searching' || e.state === 'suspicious';
      const tagged = e.tagT > 0;
      if (!showEye && !tagged && !(aids.markers && e.dist < 55)) continue;
      const s = project(e.x, e.y + e.rig.headHeight() + 0.42, e.z);
      if (!s) continue;
      const band = e.state === 'combat' ? 2 : meterBand(e.meter), col = BAND[band];
      if (showEye) {
        // eye outline that fills white → yellow → red with the meter
        g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2;
        g.beginPath(); g.ellipse(s.x, s.y, 12, 6.5, 0, 0, Math.PI * 2); g.stroke();
        g.save(); g.beginPath(); g.ellipse(s.x, s.y, 12, 6.5, 0, 0, Math.PI * 2); g.clip();
        g.globalAlpha = 0.85; g.fillRect(s.x - 12, s.y + 6.5 - 13 * clamp01(e.state === 'combat' ? 1 : e.meter), 24, 13); g.restore();
        g.fillStyle = '#101214'; g.beginPath(); g.arc(s.x, s.y, 2.6, 0, Math.PI * 2); g.fill();
      } else if (aids.markers && !tagged) {
        g.fillStyle = 'rgba(242,242,238,0.75)'; g.beginPath(); g.moveTo(s.x, s.y + 5); g.lineTo(s.x - 5, s.y - 3); g.lineTo(s.x + 5, s.y - 3); g.closePath(); g.fill();
      }
      if (tagged) {
        const f = project(e.x, e.y, e.z);
        if (f) {
          const h = Math.abs(f.y - s.y), wdt = h * 0.42;
          g.strokeStyle = '#ffb648'; g.lineWidth = 1.5;
          for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            const x0 = s.x + sx * wdt / 2, y0 = sy < 0 ? s.y + 8 : f.y;
            g.beginPath(); g.moveTo(x0 - sx * 6, y0); g.lineTo(x0, y0); g.lineTo(x0, y0 - sy * 6); g.stroke();
          }
        }
      }
    }

    if (bn.t > 0.01) this._binocTags(dt, cx, cy);

    // detection arrows around the crosshair: which way the watcher is
    if (aids.arrows) for (const e of G.enemies) {
      if (!e.alive || (e.meter < 0.06 && e.state !== 'combat')) continue;
      const a = -angDelta(p.yaw, yawTo(p.x, p.z, e.x, e.z)), lvl = e.state === 'combat' ? 1 : e.meter;
      g.save(); g.translate(cx, cy); g.rotate(a);
      g.fillStyle = BAND[e.state === 'combat' ? 2 : meterBand(e.meter)]; g.globalAlpha = 0.35 + lvl * 0.6;
      const r = 96, wd = 10 + lvl * 16;
      g.beginPath(); g.moveTo(0, -r - 16); g.lineTo(-wd, -r); g.lineTo(wd, -r); g.closePath(); g.fill();
      g.restore();
    }
    if (cl && cl.meter > 0.03) {
      g.fillStyle = BAND[cl.alarm ? 2 : meterBand(cl.meter)]; g.globalAlpha = 0.9;
      g.fillRect(cx - 70, 96, 140 * cl.meter, 6); g.globalAlpha = 0.5; g.strokeStyle = '#f2f2ee'; g.lineWidth = 1; g.strokeRect(cx - 70, 96, 140, 6); g.globalAlpha = 1;
    }

    // damage direction
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i]; h.t -= dt;
      if (h.t <= 0) { hits.splice(i, 1); continue; }
      const a = -angDelta(p.yaw, yawTo(p.x, p.z, h.x, h.z)) - Math.PI / 2;
      g.strokeStyle = `rgba(255,60,45,${clamp01(h.t) * h.a})`; g.lineWidth = 9;
      g.beginPath(); g.arc(cx, cy, 150, a - 0.3, a + 0.3); g.stroke();
    }

    // objective / reinforcement markers
    if (!cl) for (const o of objs) {
      const op = o.point;
      if (!op || o.done || (o.optional && !aids.markers)) continue;   // optional places float in the world on Easy only; elsewhere compass and map
      const s = project(op.x, G.level.gy(op.x, op.z) + (o.moving ? 4 : 2.2), op.z);
      if (!s || s.x < 20 || s.x > W - 20 || s.y < 20 || s.y > H - 20) continue;
      const col = o.optional ? OPT_COL : OBJ_COL;
      g.globalAlpha = o.stale ? 0.55 : 1;
      g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 4;
      if (o.optional) { hexPath(g, s.x, s.y, 8); g.stroke(); g.strokeStyle = col; g.lineWidth = 2; g.stroke(); }
      else { diamondPath(g, s.x, s.y, 8.5); g.stroke(); g.strokeStyle = col; g.lineWidth = 2; g.stroke(); }
      g.fillStyle = col; g.font = '600 12px ' + FONT; g.textAlign = 'center';
      g.fillText(Math.round(dist2D(p.x, p.z, op.x, op.z)) + ' m', s.x, o.optional ? s.y - 15 : s.y + 24);    // optional label above, so two markers in line stay readable
      g.globalAlpha = 1;
    }
    if (marker) {
      marker.t -= dt;
      const s = project(marker.x, G.level.gy(marker.x, marker.z) + 2.5, marker.z);
      if (s) { g.fillStyle = '#ff4b3a'; g.beginPath(); g.moveTo(s.x, s.y + 8); g.lineTo(s.x - 8, s.y - 6); g.lineTo(s.x + 8, s.y - 6); g.closePath(); g.fill(); }
      if (marker.t <= 0) marker = null;
    }
    // incoming grenade
    for (const o of equip.objs) {
      if (!o.enemy) continue;
      const s = project(o.x, o.y + 0.3, o.z);
      if (s) { g.strokeStyle = '#ff4b3a'; g.lineWidth = 2.5; g.beginPath(); g.arc(s.x, s.y, 13, 0, Math.PI * 2); g.stroke(); g.fillStyle = '#ff4b3a'; g.fillRect(s.x - 1.5, s.y - 7, 3, 8); g.fillRect(s.x - 1.5, s.y + 3, 3, 3); }
    }

    // crosshair (hidden when aiming, scoped, climbing or carrying)
    if (!cl && !equip.binoc && weapons.ads < 0.6 && !p.dragging && !p.frozen) {
      const wi = weapons.inst(), gap = 5 + (wi.def.spreadHip * 2.2 + wi.def.spreadMove * p.speedFrac * 6) * (p.stance === 2 ? 0.6 : p.stance === 1 ? 0.8 : 1) + (weapons.kick || 0) * 8;
      g.strokeStyle = 'rgba(242,242,238,0.85)'; g.lineWidth = 1.6; g.globalAlpha = 1 - weapons.ads;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.beginPath(); g.moveTo(cx + dx * gap, cy + dy * gap); g.lineTo(cx + dx * (gap + 7), cy + dy * (gap + 7)); g.stroke(); }
      g.fillStyle = 'rgba(242,242,238,0.9)'; g.fillRect(cx - 1, cy - 1, 2, 2); g.globalAlpha = 1;
    }
    if (hitT > 0) {
      hitT -= dt;
      // a headshot always kills, so its gold marker takes priority over the red kill marker
      g.strokeStyle = hitHead ? '#ffcf4a' : hitKill ? '#ff4b3a' : '#f2f2ee'; g.lineWidth = hitKill ? 3 : 2; g.globalAlpha = clamp01(hitT / 0.12);
      const a = 6, b = hitKill ? 15 : 12;
      for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) { g.beginPath(); g.moveTo(cx + dx * a, cy + dy * a); g.lineTo(cx + dx * b, cy + dy * b); g.stroke(); }
      g.globalAlpha = 1;
    }
    // grenade cook timer
    if (equip.cook && equip.cook.kind === 'frag') { g.strokeStyle = '#ff4b3a'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp01(equip.cook.t / 3.6)); g.stroke(); }

    if (equip.wheelOpen) this._wheel(cx, cy);
  },

  _wheel(cx, cy) {
    if (!icons.ready()) buildIcons(WHEEL);
    // scales with the viewport: 1 at 1280×720, ~3 on a 4K screen
    const n = WHEEL.length, us = clamp(Math.min(W / 1280, H / 720), 0.75, 3), r0 = 96 * us, r1 = 206 * us, gap = 0.014;
    const isz = (r1 - r0) * 0.66, rm = (r0 + r1) / 2 + 2 * us;
    g.fillStyle = 'rgba(8,10,12,0.6)'; g.fillRect(0, 0, W, H);
    g.lineCap = 'butt';
    for (let i = 0; i < n; i++) {
      const a0 = (i - 0.5) / n * TAU - Math.PI / 2, a1 = (i + 0.5) / n * TAU - Math.PI / 2, sel = i === equip.wheelSel;
      const item = WHEEL[i], cnt = equip.count(item), empty = item !== 'binoculars' && cnt <= 0;
      const active = item === equip.selected || (item === 'nvg' && equip.nvg.on) || (item === 'binoculars' && equip.binoc);
      g.beginPath(); g.arc(cx, cy, r1, a0 + gap, a1 - gap); g.arc(cx, cy, r0, a1 - gap, a0 + gap, true); g.closePath();
      g.fillStyle = sel ? 'rgba(92,76,46,0.94)' : empty ? 'rgba(20,23,26,0.8)' : 'rgba(44,50,55,0.88)'; g.fill();
      g.strokeStyle = sel ? '#ffb648' : 'rgba(242,242,238,0.10)'; g.lineWidth = (sel ? 2 : 1) * us; g.stroke();
      // outer accent: amber bar on the hovered segment, a thin one on the active item
      if (sel || active) {
        g.strokeStyle = sel ? '#ffb648' : 'rgba(255,182,72,0.75)'; g.lineWidth = (sel ? 5 : 3) * us;
        g.beginPath(); g.arc(cx, cy, r1 + (sel ? 5 : 4) * us, a0 + gap * 2, a1 - gap * 2); g.stroke();
      }
      const am = (a0 + a1) / 2, tx = cx + Math.cos(am) * rm, ty = cy + Math.sin(am) * rm;
      const pic = icons.get(item, empty), sz = isz * (sel ? 1.12 : 1);
      if (pic) g.drawImage(pic, tx - sz / 2, ty - sz / 2 - 8 * us, sz, sz);
      else { g.fillStyle = empty ? 'rgba(242,242,238,0.35)' : '#f2f2ee'; g.font = `600 ${Math.round(11 * us)}px system-ui, sans-serif`; g.textAlign = 'center'; g.fillText(t('i_' + item), tx, ty - 6 * us); }
      // count under the picture (battery % for the goggles, nothing for the binoculars)
      const label = item === 'nvg' ? cnt + '%' : item === 'binoculars' ? '' : '×' + cnt;
      if (label) {
        g.font = `700 ${Math.round(13 * us)}px system-ui, sans-serif`; g.textAlign = 'center';
        g.fillStyle = empty ? 'rgba(242,242,238,0.32)' : sel ? '#ffd9a0' : '#f2f2ee';
        g.fillText(label, tx, ty + isz * 0.42 + 8 * us);
      }
      if (active) {      // a small amber pip on the selected throwable / the goggles or binoculars in use
        const px = cx + Math.cos(a0 + 0.07) * (r1 - 10 * us), py = cy + Math.sin(a0 + 0.07) * (r1 - 10 * us);
        g.fillStyle = '#ffb648'; g.beginPath(); g.arc(px, py, 3.5 * us, 0, TAU); g.fill();
      }
    }
    // centre: the hovered item's name and what it holds, or the wheel's title
    g.beginPath(); g.arc(cx, cy, r0 - 8 * us, 0, TAU); g.fillStyle = 'rgba(12,15,17,0.78)'; g.fill();
    g.textAlign = 'center';
    if (equip.wheelSel >= 0) {
      const item = WHEEL[equip.wheelSel], cnt = equip.count(item);
      g.fillStyle = '#f2f2ee'; g.font = `600 ${Math.round(16 * us)}px system-ui, sans-serif`;
      this._fitText(t('i_' + item), cx, cy - 2 * us, (r0 - 18 * us) * 2);
      g.fillStyle = '#ffb648'; g.font = `600 ${Math.round(12 * us)}px system-ui, sans-serif`;
      g.fillText(item === 'nvg' ? cnt + '%' : item === 'binoculars' ? '' : '×' + cnt, cx, cy + 18 * us);
    } else {
      g.fillStyle = 'rgba(242,242,238,0.75)'; g.font = `600 ${Math.round(13 * us)}px system-ui, sans-serif`;
      this._fitText(t('a_wheel'), cx, cy + 5 * us, (r0 - 18 * us) * 2);
    }
    void THROWABLES;
  },
  /** fillText, shrunk to fit a width. */
  _fitText(s, x, y, w) {
    const m = g.measureText(s).width;
    if (m <= w) { g.fillText(s, x, y); return; }
    g.save(); g.translate(x, y); g.scale(w / m, w / m); g.fillText(s, 0, 0); g.restore();
  },

  // ───────────────────────── binoculars ─────────────────────────
  /** Raise / lower, sway, readouts and the overlays that must stay visible over the optics. */
  _binoc(dt) {
    const p = G.player, B = ITEMS.binoculars, up = equip.binoc && !G.overrideCamera;
    bn.t = clamp01(bn.t + (up ? 1 : -1.45) * dt / (B.raise || 0.3));
    const vis = bn.t > 0.001;
    show('binocOn', el.binoc, vis);
    if (!vis) return;
    if (bn.built !== W + 'x' + H) this._binocBuild();
    const e = easeOut(bn.t), lo = 1 - e;

    // hand sway: slow figure-of-eight plus breathing, calmer crouched and steady prone, worse on the move
    bn.clock += dt;
    bn.amp = damp(bn.amp, [1, 0.55, 0.22][p.stance] * (1 + p.speedFrac * 1.6), 3, dt);
    const c = bn.clock, a = bn.R * 0.016 * bn.amp;
    const sx = a * (Math.sin(c * 0.9) * 0.7 + Math.sin(c * 2.3 + 1.3) * 0.3);
    const sy = a * (Math.sin(c * 1.8 + 0.4) * 0.45 + Math.sin(c * 0.55) * 0.4) + bn.R * 0.004 * Math.sin(c * 1.6) * bn.amp;
    el.bnOptic.style.transform = `translate3d(${sx.toFixed(1)}px,${(sy + lo * H * 0.42).toFixed(1)}px,0) scale(${(1 + lo * 0.14).toFixed(3)})`;

    // the view comes up dark and out of focus, then clears; a zoom step refocuses briefly
    if (equip.zoomI !== bn.zoomI) { bn.zoomI = equip.zoomI; if (up && bn.t >= 1) bn.focus = 1; }
    bn.focus = Math.max(0, bn.focus - dt / 0.22);
    const blur = Math.max(lo * 9, bn.focus * 3.5);
    const bs = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none';
    if (cache.bnBlur !== bs) { cache.bnBlur = bs; el.bnFocus.style.backdropFilter = bs; el.bnFocus.style.webkitBackdropFilter = bs; }
    el.bnDim.style.opacity = (lo * 0.92).toFixed(3);
    // damage and flash read through the optics (they live in the post pass, under this overlay)
    el.bnDmg.style.opacity = (clamp01(R.post.damage) * 0.85).toFixed(3);
    el.bnFlash.style.opacity = clamp01(R.post.flash).toFixed(3);

    // reticle scale follows the true field of view, so the mil marks measure the world
    const fov = (p.fov || B.fov) * Math.PI / 180, ppm = (H / 2) / Math.tan(fov / 2) * (TAU / 6000);
    if (Math.abs(ppm - bn.ppm) > 0.004) {
      bn.ppm = ppm; const w = 120 * ppm, h = 80 * ppm;
      el.bnRet.style.width = w.toFixed(1) + 'px'; el.bnRet.style.height = h.toFixed(1) + 'px';
      el.bnRet.style.transform = `translate(${(-w / 2).toFixed(1)}px,${(-h / 2).toFixed(1)}px)`;
    }

    // dark etched lines by day and through night vision; at night without it they glow faintly so they can be read
    const lit = R.lightLevel < 0.3 && !equip.nvg.on;
    if (cache.bnLit !== lit) { cache.bnLit = lit; el.binoc.classList.toggle('lit', lit); }

    // readouts
    const deg = Math.round(((-p.yaw * 180 / Math.PI) % 360 + 360) % 360) % 360, r = equip.binocRange;
    set('bnBrg', el.bnBrg, String(deg).padStart(3, '0') + '°');
    set('bnRng', el.bnRng, r > 0 && r < (B.finder || 900) ? Math.round(r) + ' m' : '– – –');
    set('bnMag', el.bnMag, equip.binocMag() + '×');
    set('bnBrgL', el.bnBrgL, t('bn_bearing')); set('bnRngL', el.bnRngL, t('bn_range')); set('bnMagL', el.bnMagL, t('bn_zoom'));
    set('bnHint', el.bnHint, t(G.mission.diff.hud.tag ? 'bn_hint' : 'bn_hintNoTag'));
  },

  /** Mask (one soft field, rim vignette, colour fringe), edge-blur mask and the etched reticle; once per screen size. */
  _binocBuild() {
    bn.built = W + 'x' + H; bn.ppm = 0;
    const Rr = bn.R = Math.min(H * 0.45, W * 0.29), off = Rr * 0.6;
    el.binoc.style.setProperty('--R', Rr.toFixed(1) + 'px');
    // "outside the field" at scale s, in a canvas of size cw x ch at pixel scale sc
    const outside = (cw, ch, sc, s) => {
      const c = document.createElement('canvas'); c.width = cw; c.height = ch;
      const k = c.getContext('2d'), x = cw / 2, y = ch / 2, r = Rr * sc * s, o = off * sc * s;
      k.fillStyle = '#000'; k.fillRect(0, 0, cw, ch); k.globalCompositeOperation = 'destination-out';
      k.beginPath(); k.arc(x - o, y, r, 0, TAU); k.moveTo(x + o + r, y); k.arc(x + o, y, r, 0, TAU);
      k.moveTo(x + o * 1.2, y); k.ellipse(x, y, o * 1.2, r * 0.9, 0, 0, TAU); k.fill();
      return c;
    };
    // draw only the blurred shadow of an image (soft on both sides of its edge)
    const shadow = (k, img, cw, ch, blur, col) => { k.save(); k.shadowColor = col; k.shadowBlur = blur; k.shadowOffsetX = cw * 3; k.drawImage(img, -cw * 3, 0, cw, ch); k.restore(); };

    const sc = 0.5, cw = Math.ceil(W * 1.28 * sc), ch = Math.ceil(H * 1.28 * sc), Rs = Rr * sc;
    const m = el.bnMask; m.width = cw; m.height = ch;
    const k = m.getContext('2d');
    shadow(k, outside(cw, ch, sc, 1.0), cw, ch, Rs * 0.32, 'rgba(0,0,0,0.6)');          // deep soft vignette
    shadow(k, outside(cw, ch, sc, 0.975), cw, ch, Rs * 0.03, 'rgba(255,176,72,0.32)');   // warm fringe
    shadow(k, outside(cw, ch, sc, 0.955), cw, ch, Rs * 0.045, 'rgba(80,150,255,0.12)');  // faint cool fringe further in
    const o1 = outside(cw, ch, sc, 1.0);
    shadow(k, o1, cw, ch, Rs * 0.05, '#000');                                           // the soft field stop
    shadow(k, o1, cw, ch, Rs * 0.02, '#000');
    // edge blur: alpha grows towards the rim
    const bw = Math.ceil(cw / 3), bh = Math.ceil(ch / 3), bc = document.createElement('canvas'); bc.width = bw; bc.height = bh;
    shadow(bc.getContext('2d'), o1, bw, bh, Rs / 3 * 0.38, '#000');
    const url = `url(${bc.toDataURL('image/png')})`;
    el.bnBlur.style.maskImage = url; el.bnBlur.style.webkitMaskImage = url;

    // etched reticle in mils (0-01 = 1/6000 of a turn): horizontal scale +-40 with numbers, centre chevron,
    // short vertical scale below
    const sw = Math.max(1, H / 760).toFixed(2), hw = (Math.max(1, H / 760) + 1.6).toFixed(2);
    let d = 'M-40 0H-2.6M2.6 0H40M-1.7 2.7L0 0.35L1.7 2.7M0 4.2V15.5';
    for (let x = 5; x <= 40; x += 5) for (const sg of [-1, 1]) d += `M${sg * x} 0V${x % 10 ? -1.3 : -2.6}`;
    for (let x = 2.5; x <= 40; x += 5) for (const sg of [-1, 1]) d += `M${sg * x} 0V0.7`;
    for (const y of [5, 10, 15]) d += y === 10 ? `M-2.2 ${y}H2.2` : `M-1.2 ${y}H1.2`;
    let txt = '';
    for (const x of [10, 20, 30, 40]) for (const sg of [-1, 1]) txt += `<text x="${sg * x}" y="-4.1">${x}</text>`;
    txt += '<text x="-3.4" y="11.3" text-anchor="end">10</text>';
    el.bnRet.setAttribute('viewBox', '-60 -40 120 80');
    el.bnRet.innerHTML = `<path class="rh" d="${d}" fill="none" stroke-width="${hw}" stroke-linecap="round"/><path class="rc" d="${d}" fill="none" stroke-width="${sw}" stroke-linecap="round"/>` +
      `<g class="rt" font-family="Bahnschrift, 'DIN Condensed', 'Roboto Condensed', 'Arial Narrow', sans-serif" font-size="3.7" font-weight="600" text-anchor="middle" stroke-width="2.4" paint-order="stroke">${txt}</g>`;
  },

  /** Tagging progress arcs around soldiers held in the view, a small arc at the centre mark, and the tag flash. */
  _binocTags(dt, cx, cy) {
    const us = clamp(H / 720, 0.8, 3), prog = equip.binoc ? equip.tagProgress() : null;
    let best = 0;
    g.lineCap = 'round';
    if (prog) for (const [e, c] of prog) {
      c.d = damp(c.d || 0, c.v, 14, dt); best = Math.max(best, c.d);
      const s = project(e.x, e.y + 1.15, e.z);
      if (!s) continue;
      const r = 15 * us;
      g.strokeStyle = 'rgba(255,182,72,0.28)'; g.lineWidth = 1.5 * us; g.beginPath(); g.arc(s.x, s.y, r, 0, TAU); g.stroke();
      g.strokeStyle = '#ffb648'; g.lineWidth = 2.2 * us; g.beginPath(); g.arc(s.x, s.y, r, -Math.PI / 2, -Math.PI / 2 + TAU * clamp01(c.d)); g.stroke();
    }
    if (best > 0.02) {
      g.strokeStyle = 'rgba(255,182,72,0.85)'; g.lineWidth = 1.8 * us;
      g.beginPath(); g.arc(cx, cy, 7 * us, -Math.PI / 2, -Math.PI / 2 + TAU * clamp01(best)); g.stroke();
      g.fillStyle = 'rgba(255,182,72,0.9)'; g.font = `600 ${Math.round(10 * us)}px system-ui, sans-serif`; g.textAlign = 'left';
      g.fillText(t('bn_tagging'), cx + 12 * us, cy + 18 * us);
    }
    for (let i = bn.fx.length - 1; i >= 0; i--) {
      const f = bn.fx[i]; f.t -= dt;
      if (f.t <= 0 || !f.e.alive) { bn.fx.splice(i, 1); continue; }
      const s = project(f.e.x, f.e.y + 1.15, f.e.z);
      if (!s) continue;
      const q = 1 - f.t / 0.9, r = (12 + 22 * easeOut(q)) * us;
      g.strokeStyle = `rgba(255,182,72,${(1 - q).toFixed(3)})`; g.lineWidth = 2 * us;
      g.beginPath(); g.moveTo(s.x, s.y - r); g.lineTo(s.x + r, s.y); g.lineTo(s.x, s.y + r); g.lineTo(s.x - r, s.y); g.closePath(); g.stroke();
    }
  },

  // ───────────────────────── compass (top centre) ─────────────────────────
  /** Heading tape: ticks every 15°, bearings, N/E/S/W, task markers with distance, the reinforcement marker. */
  _compass(objs) {
    const c = el.compass, k = c.getContext('2d'), dpr = this.dpr || 1, w = c.width / dpr, h = c.height / dpr, p = G.player;
    k.setTransform(dpr, 0, 0, dpr, 0, 0); k.clearRect(0, 0, w, h);
    const cx = w / 2, y0 = 17, y1 = 41, span = clamp(w / 3.6, 70, 150), ppd = w / span;
    const deg = ((-p.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const fade = (x) => 1 - smooth01((Math.abs(x - cx) / (w / 2) - 0.62) / 0.38);
    // backing: dark band and two hairlines, all fading out at the ends
    const gr = k.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0, 'rgba(10,13,16,0)'); gr.addColorStop(0.18, 'rgba(10,13,16,0.58)'); gr.addColorStop(0.82, 'rgba(10,13,16,0.58)'); gr.addColorStop(1, 'rgba(10,13,16,0)');
    k.fillStyle = gr; k.fillRect(0, y0, w, y1 - y0);
    const gl = k.createLinearGradient(0, 0, w, 0);
    gl.addColorStop(0, 'rgba(242,242,238,0)'); gl.addColorStop(0.25, 'rgba(242,242,238,0.28)'); gl.addColorStop(0.75, 'rgba(242,242,238,0.28)'); gl.addColorStop(1, 'rgba(242,242,238,0)');
    k.fillStyle = gl; k.fillRect(0, y0, w, 1); k.fillRect(0, y1 - 1, w, 1);
    k.textAlign = 'center'; k.textBaseline = 'alphabetic';
    const numbers = ppd * 15 >= 30;
    for (let d = Math.floor((deg - span / 2) / 5) * 5; d <= deg + span / 2; d += 5) {
      const x = cx + (d - deg) * ppd, n = ((d % 360) + 360) % 360, a = fade(x);
      if (a <= 0.02) continue;
      k.globalAlpha = a;
      const card = CARD[n];
      if (n % 15) { if (ppd > 2.4) { k.fillStyle = 'rgba(242,242,238,0.35)'; k.fillRect(x - 0.5, y1 - 5, 1, 4); } continue; }
      if (card && n % 90 === 0) {
        k.fillStyle = n === 0 ? '#ffcf7a' : '#f2f2ee'; k.font = '700 15px ' + FONT; k.fillText(card, x, y0 + 16);
        k.fillRect(x - 1, y1 - 6, 2, 5);
      } else if (card) {
        k.fillStyle = 'rgba(242,242,238,0.82)'; k.font = '600 11px ' + FONT; k.fillText(card, x, y0 + 15);
        k.fillRect(x - 0.75, y1 - 6, 1.5, 5);
      } else {
        k.fillStyle = 'rgba(242,242,238,0.6)'; k.fillRect(x - 0.5, y1 - 7, 1, 6);
        if (numbers) { k.font = '500 10px ' + FONT; k.fillStyle = 'rgba(242,242,238,0.55)'; k.fillText(String(n), x, y0 + 13); }
      }
    }
    k.globalAlpha = 1;
    // markers: angle off the view, clamped to the ends with a chevron when behind
    const place = (pt) => {
      const a = angDelta(p.yaw, yawTo(p.x, p.z, pt.x, pt.z)) * -180 / Math.PI;
      const x = cx + a * ppd, lim = w / 2 - 10;
      return { x: clamp(x, cx - lim, cx + lim), off: Math.abs(x - cx) > lim ? Math.sign(x - cx) : 0, a };
    };
    const marks = [];
    for (const o of objs) if (o.point && !o.done) marks.push({ o, pt: o.point });
    if (marker) marks.push({ o: null, pt: marker });
    for (const mk of marks.reverse()) {
      const q = place(mk.pt), ym = (y0 + y1) / 2 + 1, o = mk.o;
      k.globalAlpha = o && o.stale ? 0.55 : 1;
      if (!o) { k.fillStyle = '#ff4b3a'; k.beginPath(); k.moveTo(q.x, ym + 7); k.lineTo(q.x - 7, ym - 5); k.lineTo(q.x + 7, ym - 5); k.closePath(); k.fill(); k.strokeStyle = 'rgba(0,0,0,0.6)'; k.lineWidth = 1; k.stroke(); }
      else if (o.optional) {
        hexPath(k, q.x, ym, 7.5); k.fillStyle = 'rgba(10,20,30,0.75)'; k.fill(); k.strokeStyle = OPT_COL; k.lineWidth = 2;
        if (o.stale) k.setLineDash([3, 2]);
        k.stroke(); k.setLineDash([]);
        if (o.moving) { k.fillStyle = OPT_COL; k.fillRect(q.x - 2, ym - 2, 4, 4); }
      } else { diamondPath(k, q.x, ym, 8.5); k.fillStyle = OBJ_COL; k.fill(); k.strokeStyle = 'rgba(0,0,0,0.6)'; k.lineWidth = 1; k.stroke(); }
      if (q.off) {         // behind or far to the side: a chevron pointing the way to turn
        k.fillStyle = o ? (o.optional ? OPT_COL : OBJ_COL) : '#ff4b3a';
        const ex = q.x + q.off * 11;
        k.beginPath(); k.moveTo(ex + q.off * 4, ym); k.lineTo(ex - q.off * 1.5, ym - 4.5); k.lineTo(ex - q.off * 1.5, ym + 4.5); k.closePath(); k.fill();
      }
      // distance when roughly in front
      if (o && Math.abs(q.a) < Math.min(14, span * 0.12)) {
        k.font = '600 11px ' + FONT; k.fillStyle = o.optional ? OPT_COL : OBJ_COL;
        k.strokeStyle = 'rgba(0,0,0,0.7)'; k.lineWidth = 3; k.lineJoin = 'round';
        const s = Math.round(dist2D(p.x, p.z, mk.pt.x, mk.pt.z)) + ' m';
        k.strokeText(s, q.x, y1 + 12); k.fillText(s, q.x, y1 + 12);
      }
      k.globalAlpha = 1;
    }
    // centre notch and heading readout
    k.fillStyle = '#f2f2ee'; k.beginPath(); k.moveTo(cx, y0 + 5); k.lineTo(cx - 4.5, y0 - 1); k.lineTo(cx + 4.5, y0 - 1); k.closePath(); k.fill();
    k.fillStyle = 'rgba(10,13,16,0.7)'; k.fillRect(cx - 19, 0, 38, 15);
    k.fillStyle = 'rgba(242,242,238,0.25)'; k.fillRect(cx - 19, 14, 38, 1);
    k.fillStyle = '#f2f2ee'; k.font = '600 12px ' + FONT; k.fillText(String(Math.round(deg) % 360).padStart(3, '0'), cx, 12);
  },

  // ───────────────────────── minimap (Easy) ─────────────────────────
  /** Heading-up disc: bearing ring with the N mark, view cone, enemies, task icons clamped to the rim. */
  _minimap(aids, objs) {
    const c = el.minimap, k = c.getContext('2d'), m = G.level.map, p = G.player, dpr = this.dpr || 1, S = c.width / dpr, sc = 1.25;
    const C = S / 2, Rr = C - 3, rim = Rr - 15, cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
    k.setTransform(dpr, 0, 0, dpr, 0, 0); k.clearRect(0, 0, S, S);
    // world → minimap
    const toMini = (x, z) => { const dx = (x - p.x) * sc, dz = (z - p.z) * sc; return [C + dx * cy - dz * sy, C + dx * sy + dz * cy]; };
    k.save();
    k.beginPath(); k.arc(C, C, Rr, 0, TAU); k.clip();
    k.fillStyle = '#12171a'; k.fillRect(0, 0, S, S);
    k.save(); k.translate(C, C); k.rotate(p.yaw); k.scale(sc / m.scale, sc / m.scale);
    k.globalAlpha = 0.95; k.drawImage(m.canvas, -(p.x - m.minX) * m.scale, -(p.z - m.minZ) * m.scale); k.globalAlpha = 1;
    k.restore();
    // view cone (the horizontal field of view)
    const cam = G.camera, hf = cam ? Math.atan(Math.tan(cam.fov * Math.PI / 360) * (cam.aspect || 1.6)) : 0.9;
    const cg = k.createRadialGradient(C, C, 4, C, C, Rr);
    cg.addColorStop(0, 'rgba(242,242,238,0.28)'); cg.addColorStop(1, 'rgba(242,242,238,0)');
    k.fillStyle = cg; k.beginPath(); k.moveTo(C, C); k.arc(C, C, Rr, -Math.PI / 2 - hf, -Math.PI / 2 + hf); k.closePath(); k.fill();
    if (aids.markers) for (const e of G.enemies) {
      if (!e.alive || e.dist > 75) continue;
      const [x, y] = toMini(e.x, e.z);
      k.fillStyle = BAND[e.state === 'combat' ? 2 : meterBand(e.meter)]; k.beginPath(); k.arc(x, y, 2.6, 0, TAU); k.fill();
      k.strokeStyle = 'rgba(0,0,0,0.6)'; k.lineWidth = 1; k.stroke();
    }
    // bearing ring
    k.fillStyle = 'rgba(8,10,12,0.62)'; k.beginPath(); k.arc(C, C, Rr, 0, TAU); k.arc(C, C, Rr - 12, 0, TAU, true); k.fill();
    k.restore();
    k.save();
    k.strokeStyle = 'rgba(242,242,238,0.45)'; k.lineWidth = 1;
    // bearing d sits at screen angle (clockwise from up) d + yaw
    for (let d = 0; d < 360; d += 30) {
      const sa = (d * Math.PI / 180) + p.yaw, x0 = C + Math.sin(sa) * (Rr - 1), y0 = C - Math.cos(sa) * (Rr - 1), x1 = C + Math.sin(sa) * (Rr - (d % 90 ? 4 : 6)), y1 = C - Math.cos(sa) * (Rr - (d % 90 ? 4 : 6));
      if (d % 90 === 0) continue;
      k.beginPath(); k.moveTo(x0, y0); k.lineTo(x1, y1); k.stroke();
    }
    k.textAlign = 'center'; k.textBaseline = 'middle';
    for (const [d, lbl] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
      const sa = d * Math.PI / 180 + p.yaw, x = C + Math.sin(sa) * (Rr - 6.5), y = C - Math.cos(sa) * (Rr - 6.5);
      k.font = (d ? '600 9px ' : '700 11px ') + FONT; k.fillStyle = d ? 'rgba(242,242,238,0.7)' : '#ffcf7a'; k.fillText(lbl, x, y + 0.5);
    }
    k.restore();
    // task icons and the reinforcement marker, held on the rim when out of range
    const icon = (pt, draw) => {
      let [x, y] = toMini(pt.x, pt.z);
      const dx = x - C, dy = y - C, r = Math.hypot(dx, dy), out = r > rim;
      if (out) { x = C + dx / r * rim; y = C + dy / r * rim; }
      draw(x, y, out ? 0.75 : 1);
    };
    for (const o of objs) {
      if (!o.point || o.done) continue;
      icon(o.point, (x, y, s) => {
        k.globalAlpha = o.stale ? 0.6 : 1;
        if (o.optional) { hexPath(k, x, y, 6 * s); k.fillStyle = 'rgba(10,20,30,0.8)'; k.fill(); k.strokeStyle = OPT_COL; k.lineWidth = 2; k.stroke(); }
        else { diamondPath(k, x, y, 7 * s); k.fillStyle = OBJ_COL; k.fill(); k.strokeStyle = 'rgba(0,0,0,0.6)'; k.lineWidth = 1; k.stroke(); }
        k.globalAlpha = 1;
      });
    }
    if (marker) icon(marker, (x, y, s) => { k.fillStyle = '#ff4b3a'; k.beginPath(); k.moveTo(x, y + 6 * s); k.lineTo(x - 6 * s, y - 4 * s); k.lineTo(x + 6 * s, y - 4 * s); k.closePath(); k.fill(); });
    // player
    k.fillStyle = '#f2f2ee'; k.strokeStyle = 'rgba(0,0,0,0.7)'; k.lineWidth = 1.2;
    k.beginPath(); k.moveTo(C, C - 8); k.lineTo(C - 5.5, C + 5.5); k.lineTo(C, C + 3); k.lineTo(C + 5.5, C + 5.5); k.closePath(); k.fill(); k.stroke();
    k.strokeStyle = 'rgba(242,242,238,0.55)'; k.lineWidth = 1.5; k.beginPath(); k.arc(C, C, Rr, 0, TAU); k.stroke();
    k.strokeStyle = 'rgba(242,242,238,0.16)'; k.lineWidth = 1; k.beginPath(); k.arc(C, C, Rr - 12, 0, TAU); k.stroke();
  },

  // ───────────────────────── full map (M) ─────────────────────────
  /** Grid with coordinates, sectors, tasks, enemies the player may see, player with view cone, scale bar, north arrow, legend. */
  _map(objs) {
    if (!G.level || !G.mission) return;
    const c = el.mapC, k = c.getContext('2d'), m = G.level.map, L = G.level, p = G.player, aids = G.mission.diff.hud, dpr = this.dpr || 1;
    // the canvas takes the map's own proportions inside the space the screen allows
    const mm = this.mapMax || { w: 900, h: 620 }, mxm = 26, mym = 22;
    const fs = Math.min((mm.w - mxm * 2) / m.canvas.width, (mm.h - mym * 2) / m.canvas.height);
    const cw = Math.round(m.canvas.width * fs + mxm * 2), ch = Math.round(m.canvas.height * fs + mym * 2);
    if (c.width !== cw * dpr || c.height !== ch * dpr) { c.width = cw * dpr; c.height = ch * dpr; c.style.width = cw + 'px'; c.style.height = ch + 'px'; }
    set('mapTitle', el.mapT, t('mapTitle') + ' — ' + t('act' + G.mission.act));
    set('mapHint', el.mapP, t('mapClose', { key: keyLabel(input.bindOf('map')) }));
    const showEnemies = aids.markers || G.enemies.some((e) => e.alive && e.tagT > 0);
    this._legend(showEnemies);
    k.setTransform(dpr, 0, 0, dpr, 0, 0);
    k.fillStyle = '#0d1114'; k.fillRect(0, 0, cw, ch);
    const mx = 26, my = 22, s = Math.min((cw - mx * 2) / m.canvas.width, (ch - my * 2) / m.canvas.height);
    const iw = m.canvas.width * s, ih = m.canvas.height * s, ox = (cw - iw) / 2, oy = (ch - ih) / 2, ppm = m.scale * s;
    k.imageSmoothingEnabled = true; k.imageSmoothingQuality = 'high';
    k.drawImage(m.canvas, ox, oy, iw, ih);
    const X = (x) => ox + (x - m.minX) * ppm, Z = (z) => oy + (z - m.minZ) * ppm;
    const b = L.bounds;
    // grid: letters across, numbers down
    const step = ppm * 25 >= 44 ? 25 : ppm * 50 >= 44 ? 50 : 100;
    k.strokeStyle = 'rgba(242,242,238,0.09)'; k.lineWidth = 1; k.font = '600 10px ' + FONT; k.fillStyle = 'rgba(242,242,238,0.55)';
    k.textAlign = 'center'; k.textBaseline = 'middle';
    const gx0 = b.minX, gz0 = b.minZ;            // the grid starts at the map's corner: A1 is top left
    for (let x = gx0, i = 0; x < b.maxX; x += step, i++) {
      const sx = X(Math.max(x, b.minX)), ex = X(Math.min(x + step, b.maxX));
      if (x > b.minX) { k.beginPath(); k.moveTo(Math.round(sx) + 0.5, oy); k.lineTo(Math.round(sx) + 0.5, oy + ih); k.stroke(); }
      if (ex - sx > 10) k.fillText(String.fromCharCode(65 + i), (sx + ex) / 2, oy - 9);
    }
    for (let z = gz0, i = 1; z < b.maxZ; z += step, i++) {
      const sz = Z(Math.max(z, b.minZ)), ez = Z(Math.min(z + step, b.maxZ));
      if (z > b.minZ) { k.beginPath(); k.moveTo(ox, Math.round(sz) + 0.5); k.lineTo(ox + iw, Math.round(sz) + 0.5); k.stroke(); }
      if (ez - sz > 10) k.fillText(String(i), ox - 12, (sz + ez) / 2);
    }
    k.strokeStyle = 'rgba(242,242,238,0.3)'; k.strokeRect(ox + 0.5, oy + 0.5, iw - 1, ih - 1);
    // sectors (only where the act has more than one)
    if (L.sectors.length > 1) {
      k.save(); k.setLineDash([6, 4]); k.lineWidth = 1.5;
      for (const sec of L.sectors) {
        const x0 = X(Math.max(sec.minX, b.minX)), x1 = X(Math.min(sec.maxX, b.maxX)), z0 = Z(Math.max(sec.minZ, b.minZ)), z1 = Z(Math.min(sec.maxZ, b.maxZ));
        k.strokeStyle = sec.cleared ? 'rgba(127,208,138,0.7)' : 'rgba(255,182,72,0.55)';
        k.strokeRect(x0 + 3, z0 + 3, x1 - x0 - 6, z1 - z0 - 6);
        k.setLineDash([]);
        const label = t(sec.nameKey) + (sec.cleared ? '  ✓' : '');
        k.font = '600 12px ' + FONT; k.textAlign = 'left'; k.textBaseline = 'top';
        const tw = k.measureText(label).width;
        k.fillStyle = 'rgba(8,10,12,0.7)'; k.fillRect(x0 + 7, z0 + 7, tw + 10, 18);
        k.fillStyle = sec.cleared ? '#9fe0a8' : '#ffd08a'; k.fillText(label, x0 + 12, z0 + 10);
        k.setLineDash([6, 4]);
      }
      k.restore();
    }
    // enemies the player is allowed to see
    if (showEnemies) for (const e of G.enemies) {
      if (!e.alive || !(aids.markers || e.tagT > 0)) continue;
      k.fillStyle = BAND[e.state === 'combat' ? 2 : meterBand(e.meter)]; k.beginPath(); k.arc(X(e.x), Z(e.z), 3.5, 0, TAU); k.fill();
      k.strokeStyle = 'rgba(0,0,0,0.7)'; k.lineWidth = 1; k.stroke();
    }
    // tasks
    k.textAlign = 'left'; k.textBaseline = 'middle';
    for (const o of objs) {
      if (!o.point || o.done) continue;
      const x = X(o.point.x), y = Z(o.point.z);
      k.globalAlpha = o.stale ? 0.6 : 1;
      if (o.optional) { hexPath(k, x, y, 8); k.fillStyle = 'rgba(10,20,30,0.85)'; k.fill(); k.strokeStyle = OPT_COL; k.lineWidth = 2.5; if (o.stale) k.setLineDash([3, 2]); k.stroke(); k.setLineDash([]); }
      else { diamondPath(k, x, y, 9); k.fillStyle = OBJ_COL; k.fill(); k.strokeStyle = 'rgba(0,0,0,0.7)'; k.lineWidth = 1.2; k.stroke(); }
      if (o.stale) { k.font = '500 10px ' + FONT; k.fillStyle = OPT_COL; k.fillText(t('h_lastSeen'), x + 12, y); }
      k.globalAlpha = 1;
    }
    if (marker) { const x = X(marker.x), y = Z(marker.z); k.fillStyle = '#ff4b3a'; k.beginPath(); k.moveTo(x, y + 8); k.lineTo(x - 8, y - 6); k.lineTo(x + 8, y - 6); k.closePath(); k.fill(); }
    // player with view cone
    const cam = G.camera, hf = cam ? Math.atan(Math.tan(cam.fov * Math.PI / 360) * (cam.aspect || 1.6)) : 0.9, px = X(p.x), py = Z(p.z), cr = Math.max(40, ppm * 30);
    k.save(); k.translate(px, py); k.rotate(-p.yaw);
    const cg = k.createRadialGradient(0, 0, 4, 0, 0, cr); cg.addColorStop(0, 'rgba(242,242,238,0.32)'); cg.addColorStop(1, 'rgba(242,242,238,0)');
    k.fillStyle = cg; k.beginPath(); k.moveTo(0, 0); k.arc(0, 0, cr, -Math.PI / 2 - hf, -Math.PI / 2 + hf); k.closePath(); k.fill();
    k.fillStyle = '#f2f2ee'; k.strokeStyle = 'rgba(0,0,0,0.8)'; k.lineWidth = 1.5;
    k.beginPath(); k.moveTo(0, -10); k.lineTo(-7, 7); k.lineTo(0, 3.5); k.lineTo(7, 7); k.closePath(); k.fill(); k.stroke();
    k.restore();
    // north arrow (map north is −z, up) and scale bar
    const nx = ox + iw - 20, ny = oy + 26;
    k.fillStyle = 'rgba(8,10,12,0.7)'; k.beginPath(); k.arc(nx, ny, 15, 0, TAU); k.fill();
    k.fillStyle = '#ffcf7a'; k.beginPath(); k.moveTo(nx, ny - 11); k.lineTo(nx - 5, ny + 1); k.lineTo(nx + 5, ny + 1); k.closePath(); k.fill();
    k.fillStyle = 'rgba(242,242,238,0.55)'; k.beginPath(); k.moveTo(nx, ny + 11); k.lineTo(nx - 5, ny + 1); k.lineTo(nx + 5, ny + 1); k.closePath(); k.fill();
    k.font = '700 11px ' + FONT; k.textAlign = 'center'; k.fillStyle = '#ffcf7a'; k.fillText('N', nx, ny - 21);
    const sm = [10, 20, 25, 50, 100].find((v) => v * ppm >= 60) || 100, sw = sm * ppm, sx = ox + 12, sy = oy + ih - 16;
    k.fillStyle = 'rgba(8,10,12,0.7)'; k.fillRect(sx - 6, sy - 16, sw + 12, 24);
    k.fillStyle = '#f2f2ee'; k.fillRect(sx, sy, sw, 2); k.fillRect(sx, sy - 4, 1.5, 6); k.fillRect(sx + sw - 1.5, sy - 4, 1.5, 6); k.fillRect(sx + sw / 2 - 0.5, sy - 2, 1, 4);
    k.font = '600 10px ' + FONT; k.textAlign = 'center'; k.fillText(sm + ' m', sx + sw / 2, sy - 9);
  },

  /** The map legend, rebuilt only when the language or the enemy row changes. */
  _legend(enemies) {
    const sig = t('mapYou') + enemies + (G.level.act === 3 ? 'r' : '');
    if (this._legendLang === sig) return;
    this._legendLang = sig;
    const sw = (fill, stroke, extra = '') => `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" fill="${fill}" stroke="${stroke}" ${extra}/></svg>`;
    const rows = [
      ['<svg viewBox="0 0 16 16"><path d="M8 1.5L13 14L8 11.2L3 14Z" fill="#f2f2ee"/></svg>', t('mapYou')],
      ['<svg viewBox="0 0 16 16"><path d="M8 1.5L14.5 8L8 14.5L1.5 8Z" fill="' + OBJ_COL + '"/></svg>', t('mapObj')],
      ['<svg viewBox="0 0 16 16"><path d="M8 1.8L13.4 4.9V11.1L8 14.2L2.6 11.1V4.9Z" fill="none" stroke="' + OPT_COL + '" stroke-width="2"/></svg>', t('mapOpt')],
      ...(enemies ? [['<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5" fill="#ffcf4a"/></svg>', t('mapEnemy')]] : []),
      ['<svg viewBox="0 0 16 16"><path d="M8 14L1.5 3.5H14.5Z" fill="#ff4b3a"/></svg>', t('mapReinf')],
      [sw('#7b7466', '#2b2925', 'stroke-width="1.5"'), t('mapBuilding')],
      ['<svg viewBox="0 0 16 16"><path d="M1.5 8H14.5" stroke="#c9bfa6" stroke-width="3"/></svg>', t('mapWall')],
      [sw('#5d5c55', 'none'), t('mapRoad')],
      ['<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="#1f3a26" stroke="#2f5236" stroke-width="1.5"/><circle cx="8" cy="8" r="1.4" fill="#43674a"/></svg>', t('mapTree')],
      ['<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="#2d4a31" opacity="0.8"/></svg>', t('mapBush')],
    ];
    el.legend.innerHTML = rows.map(([ic, s]) => `<div>${ic}<span>${esc(s)}</span></div>`).join('');
  },
};
void STEALTH; void ai;
