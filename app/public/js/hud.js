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
import { WHEEL, PLAYER, STEALTH, THROWABLES, ITEMS } from './config.js';
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
      <div id="h-obj"><div class="act"></div><div class="main"></div><div class="opt"></div><div class="rem"></div></div>
      <canvas id="h-compass" width="460" height="34"></canvas>
      <canvas id="h-minimap" width="176" height="176" class="hidden"></canvas>
      <div id="h-feed"></div><div id="h-toasts"></div>
      <div id="h-status"><div class="name"></div><div class="row"><span class="stance"></span><span class="bleed hidden"></span></div>
        <div class="bar hp"><i></i></div><div class="bar ar"><i></i></div>
        <div class="row small"><span class="nzl"></span><div class="bar nz"><i></i></div></div></div>
      <div id="h-weapon"><div class="wname"></div><div class="ammo"><b></b><span></span></div><div class="mode"></div>
        <div class="sup"><span></span><div class="bar"><i></i></div></div></div>
      <div id="h-thr" class="hidden"><img alt=""><span></span></div><div id="h-equip"></div>
      <div id="h-prompt" class="hidden"><span></span><div class="bar"><i></i></div></div>
      <div id="h-use" class="hidden"><span></span><div class="bar"><i></i></div></div>
      <div id="h-sub" class="hidden"></div>
      <div id="h-climb" class="hidden"><div class="state"></div><div class="lbl"></div><div class="bar"><i></i></div></div>
      <div id="h-scope" class="hidden"><div class="tip"></div></div><div id="h-binoc" class="hidden">${BN_SHEET}</div>
      <div id="h-map" class="hidden"><h2></h2><canvas width="900" height="620"></canvas><p></p></div>`;
    cv = $('#hudc'); g = cv.getContext('2d');
    for (const [k, s] of Object.entries({ act: '#h-obj .act', main: '#h-obj .main', opt: '#h-obj .opt', rem: '#h-obj .rem', name: '#h-status .name', stance: '#h-status .stance',
      bleed: '#h-status .bleed', hp: '#h-status .hp i', ar: '#h-status .ar i', nz: '#h-status .nz i', nzl: '#h-status .nzl', wname: '#h-weapon .wname', mag: '#h-weapon .ammo b',
      res: '#h-weapon .ammo span', mode: '#h-weapon .mode', supBox: '#h-weapon .sup', supL: '#h-weapon .sup span', sup: '#h-weapon .sup i', equip: '#h-equip', thr: '#h-thr', thrImg: '#h-thr img', thrT: '#h-thr span',
      prompt: '#h-prompt', promptT: '#h-prompt span', promptB: '#h-prompt i', use: '#h-use', useT: '#h-use span', useB: '#h-use i', sub: '#h-sub',
      climb: '#h-climb', climbS: '#h-climb .state', climbL: '#h-climb .lbl', climbB: '#h-climb i', scope: '#h-scope', scopeTip: '#h-scope .tip', binoc: '#h-binoc', bnOptic: '#h-binoc .bn-optic', bnBlur: '#h-binoc .bn-blur', bnMask: '#h-binoc .bn-mask', bnRet: '#h-binoc .bn-ret',
      bnBrgL: '#h-binoc .bn-brg small', bnBrg: '#h-binoc .bn-brg span', bnRngL: '#h-binoc .bn-rng small', bnRng: '#h-binoc .bn-rng span', bnMagL: '#h-binoc .bn-mag small', bnMag: '#h-binoc .bn-mag span',
      bnHint: '#h-binoc .bn-hint', bnFocus: '#h-binoc .bn-focus', bnDim: '#h-binoc .bn-dim', bnDmg: '#h-binoc .bn-dmg', bnFlash: '#h-binoc .bn-flash',
      map: '#h-map', mapT: '#h-map h2', mapC: '#h-map canvas', mapP: '#h-map p', feed: '#h-feed', toasts: '#h-toasts', compass: '#h-compass', minimap: '#h-minimap' })) el[k] = $(s);
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

  resize() { W = window.innerWidth; H = window.innerHeight; cv.width = W; cv.height = H; bn.built = ''; },
  setVisible(on) { root.classList.toggle('hidden', !on); cv.classList.toggle('hidden', !on); if (!on) { mapOpen = false; el.map.classList.add('hidden'); } },
  reset() { bn.t = 0; bn.fx.length = 0; feed.length = 0; toasts.length = 0; hits.length = 0; marker = null; subT = 0; el.sub.classList.add('hidden'); this._lists(); for (const k in cache) delete cache[k]; },
  toggleMap() { mapOpen = !mapOpen; el.map.classList.toggle('hidden', !mapOpen); if (mapOpen) this._map(); },
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

    // ── objective
    const o = game.objective();
    set('act', el.act, t('act' + m.act) + '  ·  ' + fmtTime(m.stats.time));
    set('main', el.main, o.main); set('opt', el.opt, o.opt);
    set('rem', el.rem, o.remaining >= 0 ? t('remaining', { n: o.remaining }) : '');

    // ── status
    set('name', el.name, m.name);
    set('stance', el.stance, t(['st_stand', 'st_crouch', 'st_prone'][p.stance]));
    show('bleedOn', el.bleed, p.bleed > 0);
    if (p.bleed) { set('bleed', el.bleed, t(p.bleed === 2 ? 'bleedingHeavy' : 'bleeding')); el.bleed.classList.toggle('heavy', p.bleed === 2); }
    bar('hp', el.hp, p.health / PLAYER.maxHealth); bar('ar', el.ar, p.armor / 100);
    if (cache.low !== (p.health < PLAYER.lowHealth)) { cache.low = p.health < PLAYER.lowHealth; el.hp.classList.toggle('low', cache.low); }
    set('nzl', el.nzl, t('noiseLbl')); bar('nz', el.nz, noise.playerLoudness(G.simTime));

    // ── weapon
    const w = weapons.hud();
    set('wname', el.wname, w.name); set('mag', el.mag, String(w.mag)); set('res', el.res, ' / ' + w.reserve);
    set('mode', el.mode, w.reloading ? t('reloading') : t('mode_' + w.mode));
    show('supOn', el.supBox, w.canSup);
    if (w.canSup) { set('supL', el.supL, t('suppressor') + (w.supSpare > 0 ? ' +' + w.supSpare : '')); bar('sup', el.sup, w.sup ?? 0); if (cache.supDim !== (w.sup === null)) { cache.supDim = w.sup === null; el.supBox.classList.toggle('dim', cache.supDim); } }
    // the selected throwable gets its picture once the icons exist; until then it stays in the text line
    if (!icons.ready() && G.realTime > (cache.iconAt ??= G.realTime + 1.5)) prepareIcons(WHEEL);
    const pic = icons.ready() && icons.url(equip.selected);
    show('thrOn', el.thr, !!pic);
    if (pic) { if (cache.thrSrc !== pic) { cache.thrSrc = pic; el.thrImg.src = pic; } set('thrT', el.thrT, `${t('i_' + equip.selected)} ×${equip.count(equip.selected)}`); if (cache.thrDim !== !equip.count(equip.selected)) { cache.thrDim = !equip.count(equip.selected); el.thr.classList.toggle('dim', cache.thrDim); } }
    const eq = (pic ? '' : `${t('i_' + equip.selected)} ×${equip.count(equip.selected)}   `) + `${t('i_medkit')} ×${equip.inv.medkit}   ${t('i_bandage')} ×${equip.inv.bandage}` +
      (equip.c4s.length ? `   C4 ●${equip.c4s.length}` : equip.inv.c4 ? `   C4 ×${equip.inv.c4}` : '') + (equip.nvg.on ? `   ${t('i_nvg')} ${Math.round(equip.nvg.battery)}%` : '');
    set('equip', el.equip, eq);

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

    this._canvas(dt, aids, cl);
    this._compass();
    if (aids.minimap && !cl) this._minimap(aids);
    if (mapOpen) this._map();
  },

  _canvas(dt, aids, cl) {
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
    const op = game.objectivePoint();
    if (op && !cl) {
      const s = project(op.x, G.level.gy(op.x, op.z) + 2.2, op.z);
      if (s && s.x > 20 && s.x < W - 20 && s.y > 20 && s.y < H - 20) {
        g.strokeStyle = '#ffb648'; g.lineWidth = 2; g.beginPath(); g.moveTo(s.x, s.y - 9); g.lineTo(s.x + 7, s.y); g.lineTo(s.x, s.y + 9); g.lineTo(s.x - 7, s.y); g.closePath(); g.stroke();
        g.fillStyle = '#ffb648'; g.font = '600 12px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText(Math.round(dist2D(p.x, p.z, op.x, op.z)) + ' m', s.x, s.y + 24);
      }
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

  _compass() {
    const c = el.compass, k = c.getContext('2d'), w = c.width, h = c.height, p = G.player;
    k.clearRect(0, 0, w, h);
    k.fillStyle = 'rgba(12,15,17,0.45)'; k.fillRect(0, 6, w, h - 12);
    const deg = ((-p.yaw * 180 / Math.PI) % 360 + 360) % 360, ppd = w / 150;
    k.textAlign = 'center'; k.font = '600 12px system-ui, sans-serif';
    for (let d = Math.floor((deg - 80) / 15) * 15; d <= deg + 80; d += 15) {
      const x = w / 2 + (d - deg) * ppd, n = ((d % 360) + 360) % 360;
      const lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[n];
      k.fillStyle = lbl ? '#f2f2ee' : 'rgba(242,242,238,0.5)';
      if (lbl) k.fillText(lbl, x, 22); else k.fillRect(x - 0.5, 13, 1, n % 45 === 0 ? 10 : 6);
    }
    const mark = (pt, col) => {
      const a = angDelta(p.yaw, yawTo(p.x, p.z, pt.x, pt.z)) * -180 / Math.PI, x = clamp(w / 2 + a * ppd, 6, w - 6);
      k.fillStyle = col; k.beginPath(); k.moveTo(x, 4); k.lineTo(x - 5, 12); k.lineTo(x + 5, 12); k.closePath(); k.fill();
    };
    const op = game.objectivePoint();
    if (op) mark(op, '#ffb648');
    if (marker) mark(marker, '#ff4b3a');
    k.fillStyle = '#f2f2ee'; k.fillRect(w / 2 - 0.75, 4, 1.5, h - 8);
  },

  _minimap(aids) {
    const c = el.minimap, k = c.getContext('2d'), m = G.level.map, p = G.player, S = c.width, sc = 1.25;
    k.save(); k.clearRect(0, 0, S, S);
    k.beginPath(); k.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); k.clip();
    k.fillStyle = '#161b1e'; k.fillRect(0, 0, S, S);
    k.translate(S / 2, S / 2); k.rotate(p.yaw); k.scale(sc / m.scale, sc / m.scale);
    k.globalAlpha = 0.9; k.drawImage(m.canvas, -(p.x - m.minX) * m.scale, -(p.z - m.minZ) * m.scale); k.globalAlpha = 1;
    k.scale(m.scale, m.scale);
    if (aids.markers) for (const e of G.enemies) {
      if (!e.alive || e.dist > 70) continue;
      k.fillStyle = BAND[e.state === 'combat' ? 2 : meterBand(e.meter)]; k.beginPath(); k.arc(e.x - p.x, e.z - p.z, 1.6, 0, 6.28); k.fill();
    }
    const op = game.objectivePoint();
    if (op) { k.fillStyle = '#ffb648'; k.fillRect(op.x - p.x - 1.6, op.z - p.z - 1.6, 3.2, 3.2); }
    k.restore();
    k.fillStyle = '#f2f2ee'; k.beginPath(); k.moveTo(S / 2, S / 2 - 7); k.lineTo(S / 2 - 5, S / 2 + 5); k.lineTo(S / 2 + 5, S / 2 + 5); k.closePath(); k.fill();
    k.strokeStyle = 'rgba(242,242,238,0.5)'; k.lineWidth = 2; k.beginPath(); k.arc(S / 2, S / 2, S / 2 - 2, 0, 6.28); k.stroke();
  },

  _map() {
    const c = el.mapC, k = c.getContext('2d'), m = G.level.map, p = G.player, aids = G.mission.diff.hud;
    el.mapT.textContent = t('mapTitle') + ' — ' + t('act' + G.mission.act);
    el.mapP.textContent = `▲ ${t('mapYou')}   ◆ ${t('mapObj')}` + (aids.markers || G.enemies.some((e) => e.tagT > 0) ? `   ● ${t('mapEnemy')}` : '');
    k.fillStyle = '#12161a'; k.fillRect(0, 0, c.width, c.height);
    const s = Math.min(c.width / m.canvas.width, c.height / m.canvas.height) * 0.96;
    const ox = (c.width - m.canvas.width * s) / 2, oy = (c.height - m.canvas.height * s) / 2;
    k.drawImage(m.canvas, ox, oy, m.canvas.width * s, m.canvas.height * s);
    const X = (x) => ox + (x - m.minX) * m.scale * s, Z = (z) => oy + (z - m.minZ) * m.scale * s;
    for (const e of G.enemies) {
      if (!e.alive || !(aids.markers || e.tagT > 0)) continue;
      k.fillStyle = BAND[e.state === 'combat' ? 2 : meterBand(e.meter)]; k.beginPath(); k.arc(X(e.x), Z(e.z), 3.5, 0, 6.28); k.fill();
    }
    const op = game.objectivePoint();
    if (op) { k.fillStyle = '#ffb648'; k.save(); k.translate(X(op.x), Z(op.z)); k.rotate(Math.PI / 4); k.fillRect(-5, -5, 10, 10); k.restore(); }
    k.save(); k.translate(X(p.x), Z(p.z)); k.rotate(-p.yaw); k.fillStyle = '#f2f2ee'; k.beginPath(); k.moveTo(0, -9); k.lineTo(-6, 7); k.lineTo(6, 7); k.closePath(); k.fill(); k.restore();
  },
};
void STEALTH; void ai;
