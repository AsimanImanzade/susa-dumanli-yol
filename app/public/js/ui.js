/**
 * ui.js — every screen outside the mission: splash, main menu, name entry,
 * difficulty, briefing, loading, pause, settings (with key rebinding),
 * controls, credits, mission failed and the end-of-mission report.
 *
 * Front-end screens are drawn over the live fortress backdrop (menu-scene.js)
 * while no mission is loaded; in-mission screens dim the game behind them.
 *
 * Keyboard: input.js hands every key to handleKey() first (after a rebind
 * capture). ↑/↓ or W/S move between a screen's controls, Enter/Space use
 * the focused one, Esc/Backspace go back (pause → resume), ←/→ or A/D
 * change sliders, toggles, the quality and difficulty choices. Hover and
 * keyboard share one highlight: pointing at a control focuses it. Tab works
 * as usual. Keys a screen uses never reach the game.
 */
import { G, bus, fmtTime } from './ctx.js';
import { DIFFICULTY, ACTIONS } from './config.js';
import { t, setLang, getLang, sanitizeName, keyLabel } from './loc.js';
import { save } from './save.js';
import { input } from './input.js';
import { audio } from './audio.js';
import { game } from './game.js';
import { hud } from './hud.js';
import { R } from './render.js';
import { menuScene } from './menu-scene.js';

const VERSION = '1.1';
/** Screens drawn over the live fortress backdrop when no mission is loaded. */
const FRONT = ['splash', 'menu', 'name', 'diff', 'brief', 'credits', 'settings', 'controls'];
/** What Esc / Backspace does on each screen. */
const BACK = { name: 'menu', diff: 'toName', brief: 'toDiff', settings: 'back', controls: 'back', credits: 'back', pause: 'resume', relock: 'toPause' };
const NAV = 'button:not(:disabled), input';
const root = () => document.getElementById('ui');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let current = 'splash', returnTo = 'menu', pending = { name: '', difficulty: 'normal' }, lastResult = null, loadingAct = 1, briefTimer = null;
let loadReady = false, lockTimer = null;
let manifest = {};

const btn = (act, label, cls = '', dis = false, extra = '') => `<button data-act="${act}" class="${cls}"${dis ? ' disabled' : ''}${extra}>${esc(label)}</button>`;
const langBtn = () => `<button data-act="lang" class="lang" data-desc="d_lang" aria-label="${esc(t('lang'))}"><b${getLang() === 'az' ? ' class="on"' : ''}>AZ</b><i>/</i><b${getLang() === 'en' ? ' class="on"' : ''}>EN</b></button>`;
/** A main-menu row: label, and the key of the one-line description shown while it is focused. */
const mi = (act, label, desc, dis = false) => `<button data-act="${act}" class="mi"${desc ? ` data-desc="${desc}"` : ''}${dis ? ' disabled' : ''}><span>${esc(t(label))}</span></button>`;
const titleParts = () => { const [a, ...b] = t('title').split(':'); return [a.trim(), b.join(':').trim()]; };
/** A glass panel; step: position in the new-game flow (1–3). */
const panel = (cls, title, body, row, step) => `<section class="panel glass ${cls}" data-scroll="panel">${step ? `<span class="step">${esc(t('stepOf', { n: step, of: 3 }))}</span>` : ''}<h2>${esc(title)}</h2>${body}${row ? `<div class="row">${row}</div>` : ''}</section>`;

/** Bottom key-hint bar: [key label, string key] pairs per screen. */
const K = { nav: ['↑ ↓', 'k_select'], ok: ['Enter', 'confirm'], back: ['Esc', 'back'], adjust: ['← →', 'k_adjust'], type: ['A–Z', 'k_type'], resume: ['Esc', 'resume'] };
const HINTS = { menu: [K.nav, K.ok], name: [K.type, K.ok, K.back], diff: [K.adjust, K.ok, K.back], brief: [K.nav, K.ok, K.back], settings: [K.nav, K.adjust, K.ok, K.back],
  controls: [K.back], credits: [K.back], pause: [K.nav, K.ok, K.resume], fail: [K.nav, K.ok], end: [K.nav, K.ok], relock: [[null, 'resume'], ['Esc', 'paused']] };
const keyBar = (list) => `<footer class="keys">${list.map(([k, l]) => `<span><kbd>${esc(k || t('k_click'))}</kbd>${esc(t(l))}</span>`).join('')}</footer>`;

const SCREENS = {
  splash: () => {
    const [a, b] = titleParts();
    return `<div class="splash"><span class="kicker">${esc(t('subtitle'))}</span><h1><span>${esc(a)}</span><em>${esc(b)}</em></h1><i class="rule"></i><p class="blink">${esc(t('pressKey'))}</p></div>`;
  },

  menu: () => {
    const cp = save.loadCheckpoint(), [a, b] = titleParts();
    const cont = cp ? `<button data-act="continue" class="mi cont" data-desc="d_continue"><span>${esc(t('continue'))}</span>
      <small>${esc(t('continueInfo', { name: cp.name, act: t('act' + cp.act), diff: t('diff_' + cp.difficulty) }))}</small>
      <b class="acts" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i class="${i < cp.act ? 'done' : i === cp.act ? 'cur' : ''}"></i>`).join('')}</b></button>` : '';
    return `<div class="mm"><header class="mm-title"><span class="kicker">${esc(t('subtitle'))}</span><h1><span>${esc(a)}</span><em>${esc(b)}</em></h1><p class="tag">${esc(t('tagline'))}</p></header>
      <nav class="mm-list">${cont}${mi('new', 'newGame', 'd_new')}${mi('settings', 'settings', 'd_settings')}${mi('controls', 'controls', 'd_controls')}${mi('credits', 'credits', 'd_credits')}<i class="selbar" aria-hidden="true"></i></nav>
      <p class="mm-desc" id="mmDesc"></p></div>
      <div class="mm-corner">${langBtn()}<small>${esc(t('menuLine', { v: VERSION }))}</small></div>`;
  },

  name: () => panel('narrow', t('nameTitle'), `<input id="nameInput" type="text" maxlength="24" autocomplete="off" spellcheck="false" placeholder="${esc(t('namePlaceholder'))}" value="${esc(pending.name)}">
    <p class="hint">${esc(t('nameHint'))}</p><p class="error" id="nameErr"></p>`, btn('menu', t('back')) + btn('nameOk', t('confirm'), 'primary'), 1),

  diff: () => panel('', t('diffTitle'), `<div class="cards">${['easy', 'normal', 'hard'].map((d) => `<button data-act="diff" data-v="${d}" data-group="diff" class="card${pending.difficulty === d ? ' sel' : ''}" aria-pressed="${pending.difficulty === d}"><b>${esc(t('diff_' + d))}</b><span>${esc(t('diff_' + d + '_d'))}</span></button>`).join('')}</div>`,
    btn('toName', t('back')) + btn('diffOk', t('confirm'), 'primary'), 2),

  brief: () => panel('wide brief', t('briefTitle'), `<div class="cols"><canvas id="briefMap" width="520" height="340"></canvas>
    <div><p class="op">${esc(t('briefOperative'))}: <b>${esc(pending.name)}</b> · ${esc(t('diff_' + pending.difficulty))}</p><h4>${esc(t('briefObjectives'))}</h4>
    <ol>${[1, 2, 3, 4].map((i) => `<li>${esc(t('brief_o' + i))}</li>`).join('')}</ol><div id="briefRadio" class="radio"></div></div></div>`,
    btn('toDiff', t('back')) + btn('begin', t('briefStart'), 'primary', false, ' data-default'), 3),

  loading: () => `<div class="loading"${manifest.img && manifest.img['loading' + loadingAct] ? ` style="background-image:linear-gradient(rgba(10,13,16,.55),rgba(10,13,16,.85)),url('${manifest.img['loading' + loadingAct]}')"` : ''}>
    <h2>${esc(t('act' + loadingAct))}</h2><p>${esc(t('act' + loadingAct + '_d'))}</p><p class="tip">${esc(t('tip' + (1 + (loadingAct * 3 + Math.floor(Date.now() / 4000)) % 8)))}</p>
    <p class="blink" id="loadMsg">${esc(t('loading'))}</p></div>`,

  pause: () => {
    const m = G.mission;
    return `<div class="mm pause"><header class="mm-title"><span class="kicker">${esc(t('pauseOp'))}</span><h2 class="big">${esc(t('paused'))}</h2>
      <p class="tag">${m ? esc(t('continueInfo', { name: m.name, act: t('act' + m.act), diff: t('diff_' + m.difficulty) })) : ''}</p></header>
      <nav class="mm-list">${mi('resume', 'resume')}${mi('settings', 'settings')}${mi('controls', 'controls')}${mi('restart', 'restartCp')}${mi('quit', 'quit')}<i class="selbar" aria-hidden="true"></i></nav></div>`;
  },

  relock: () => `<section class="panel glass narrow relock"><h2>${esc(t('clickResume'))}</h2><p class="hint">${esc(t('relockHint'))}</p></section>`,

  settings: () => {
    const s = G.settings;
    const slider = (k, label, min, max, step) => `<label class="opt"><span>${esc(t(label))}</span><input type="range" data-set="${k}" min="${min}" max="${max}" step="${step}" value="${s[k]}"><output>${fmtVal(k, s[k])}</output></label>`;
    const toggle = (k, label) => `<label class="opt"><span>${esc(t(label))}</span><button data-act="toggle" data-v="${k}" class="tg${s[k] ? ' on' : ''}" aria-pressed="${!!s[k]}">${esc(t(s[k] ? 'on' : 'off'))}</button></label>`;
    const quality = ['auto', 'low', 'medium', 'high'].map((q) => {
      const on = q === 'auto' ? R.isAuto() : !R.isAuto() && s.quality === q;
      return `<button data-act="quality" data-v="${q}" data-group="quality" class="${on ? 'on' : ''}" aria-pressed="${on}">${esc(t('q_' + q))}</button>`;
    }).join('');
    return panel('wide settings', t('settings'), `<div class="cols">
      <div class="col"><h4>${esc(t('s_game'))}</h4>${slider('sensitivity', 's_sens', 0.2, 3, 0.05)}${slider('fov', 's_fov', 55, 100, 1)}${toggle('invertY', 's_invert')}${toggle('killCam', 's_killcam')}${toggle('subtitles', 's_subs')}
        <label class="opt"><span>${esc(t('lang'))}</span>${langBtn()}</label>
        <h4>${esc(t('s_hud'))}</h4>${toggle('showFps', 's_fps')}${toggle('hudPercent', 's_hudPct')}
        <h4>${esc(t('s_audio'))}</h4>${slider('volMaster', 's_master', 0, 1, 0.05)}${slider('volMusic', 's_music', 0, 1, 0.05)}${slider('volSfx', 's_sfx', 0, 1, 0.05)}
        <h4>${esc(t('s_video'))}</h4><label class="opt"><span>${esc(t('s_quality'))}</span><span class="seg">${quality}</span></label>${toggle('motionBlur', 's_blur')}</div>
      <div class="col"><h4>${esc(t('s_binds'))}</h4><div class="binds" data-scroll="binds">${ACTIONS.map((a) => `<label><span>${esc(t('a_' + a))}</span><button data-act="bind" data-v="${a}">${esc(keyLabel(input.bindOf(a)))}</button></label>`).join('')}</div>
        ${btn('resetBinds', t('s_reset'), 'quiet')}</div></div>`, btn('back', t('back'), 'primary'));
  },

  controls: () => panel('wide', t('controls'), `<div class="binds two">${ACTIONS.map((a) => `<label><span>${esc(t('a_' + a))}</span><kbd>${esc(keyLabel(input.bindOf(a)))}</kbd></label>`).join('')}</div>`, btn('back', t('back'), 'primary')),

  credits: () => panel('', t('credits'), `<p class="pre">${esc(t('creditsText'))}</p>`, btn('back', t('back'), 'primary')),

  fail: () => panel('narrow fail', t('failTitle'), `<p class="sub">${esc(t('failSub', { name: G.mission ? G.mission.name : '' }))}</p>
    <nav class="mm-list">${mi('restart', 'restartCp')}${mi('quit', 'quit')}<i class="selbar" aria-hidden="true"></i></nav>`),

  end: () => {
    const r = lastResult, s = r.stats;
    const row = (k, v) => `<tr><td>${esc(t(k))}</td><td>${esc(v)}</td></tr>`;
    return panel('wide end', t('endTitle'), `<p class="sub">${esc(t('endSub'))}</p><div class="cols">
      <table>${row('e_soldier', r.name)}${row('e_diff', t('diff_' + r.difficulty))}${row('e_time', fmtTime(r.time))}${row('e_kills', s.kills)}${row('e_heads', s.headshots)}
        ${row('e_stealth', s.stealthKills)}${s.vehicles ? row('e_vehicles', s.vehicles) : ''}${row('e_spotted', s.spotted)}${row('e_acc', r.accuracy + '%')}${row('e_score', r.score)}</table>
      <div class="rank"><span>${esc(t('e_rank'))}</span><b class="r${r.rank}">${r.rank}</b><em>${esc(t('medal_' + r.rank))}</em>
        <small>${r.newBest ? esc(t('e_newBest')) : r.best ? esc(t('e_best')) + ': ' + r.best.score + ' (' + r.best.rank + ')' : ''}</small></div></div>`,
    btn('menu', t('mainMenu')) + btn('again', t('playAgain'), 'primary', false, ' data-default'));
  },
};

function fmtVal(k, v) { return k === 'fov' ? Math.round(v) + '°' : k === 'sensitivity' ? (+v).toFixed(2) : Math.round(v * 100) + '%'; }

// ───────────────────────────── focus ─────────────────────────────
const visible = (el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
/** Controls the arrows step through: in a choice group (data-group) only the chosen one is a stop. */
function stops() {
  const all = [...root().querySelectorAll(NAV)].filter(visible), seen = new Set();
  return all.filter((el) => {
    const g = el.dataset.group;
    if (!g) return true;
    if (seen.has(g)) return false;
    const chosen = all.find((o) => o.dataset.group === g && (o.classList.contains('on') || o.classList.contains('sel'))) || el;
    if (chosen !== el) return false;
    seen.add(g); return true;
  });
}
function defaultFocus() { const r = root(); return r.querySelector('[data-default]') || r.querySelector('#nameInput') || stops()[0] || null; }
/** Identity of a control that survives a re-render. */
function keyOf(el) {
  if (!el || !root().contains(el)) return null;
  return { id: el.id, act: el.dataset.act, v: el.dataset.v, set: el.dataset.set };
}
function findKey(k) {
  const r = root();
  if (k.id) return r.querySelector('#' + k.id);
  if (k.set) return r.querySelector(`[data-set="${k.set}"]`);
  if (k.act) return r.querySelector(k.v !== undefined ? `[data-act="${k.act}"][data-v="${k.v}"]` : `[data-act="${k.act}"]`);
  return null;
}
/** The main-menu style lists: slide the amber bar to the focused row and show its description. */
function syncSelection(el) {
  const list = el && el.closest && el.closest('.mm-list');
  const bar = list && list.querySelector('.selbar');
  if (bar && el.classList.contains('mi')) {
    bar.style.transform = `translateY(${el.offsetTop}px)`;
    bar.style.height = el.offsetHeight + 'px';
    bar.classList.add('on');
  }
  const desc = document.getElementById('mmDesc');
  if (desc) desc.textContent = el && el.dataset && el.dataset.desc ? t(el.dataset.desc) : '';
}

/** The briefing map: the route through the four acts, drawn progressively. */
function runBriefing() {
  const c = document.getElementById('briefMap'), box = document.getElementById('briefRadio');
  if (!c) return;
  const k = c.getContext('2d'), pts = [[70, 300], [190, 250], [250, 150], [360, 120], [450, 60]];
  const t0 = performance.now();
  let said = -1;
  clearInterval(briefTimer);
  briefTimer = setInterval(() => {
    if (current !== 'brief' || !document.getElementById('briefMap')) return clearInterval(briefTimer);
    const el = (performance.now() - t0) / 1000, prog = Math.min(4, el / 2.2);
    k.fillStyle = '#12171b'; k.fillRect(0, 0, 520, 340);
    // terrain: forest, cliff band, town blocks
    k.fillStyle = '#1c2a22'; k.fillRect(0, 200, 520, 140);
    k.fillStyle = '#3a3d3c'; k.beginPath(); k.moveTo(0, 205); k.lineTo(520, 150); k.lineTo(520, 185); k.lineTo(0, 240); k.fill();
    k.fillStyle = '#4b4a44';
    for (let i = 0; i < 26; i++) k.fillRect(250 + (i * 37) % 250, 30 + (i * 53) % 110, 18 + (i % 3) * 8, 12 + (i % 2) * 7);
    k.strokeStyle = '#6f6a5c'; k.lineWidth = 3; k.strokeRect(232, 18, 280, 140);
    k.strokeStyle = '#ffb648'; k.lineWidth = 2.5; k.setLineDash([7, 5]); k.beginPath(); k.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < 4; i++) {
      const f = Math.max(0, Math.min(1, prog - i));
      if (f <= 0) break;
      k.lineTo(pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f);
    }
    k.stroke(); k.setLineDash([]);
    k.font = '600 12px system-ui, sans-serif';
    for (let i = 0; i < 4; i++) {
      if (prog < i) break;
      k.fillStyle = '#ffb648'; k.beginPath(); k.arc(pts[i + 1][0], pts[i + 1][1], 5, 0, 6.28); k.fill();
      k.fillStyle = '#e8e6de'; k.fillText(String(i + 1), pts[i + 1][0] + 9, pts[i + 1][1] + 4);
    }
    k.fillStyle = '#8fa39a'; k.fillText('▲ ' + t('title'), 244, 34);
    const idx = Math.min(3, Math.floor(el / 3.4));
    if (idx !== said) {
      said = idx;
      const p = document.createElement('p'); p.textContent = t('brief_r' + (idx + 1), { name: pending.name });
      box.appendChild(p); box.scrollTop = box.scrollHeight;
      audio.ui('radio_on');
    }
  }, 50);
}

export const ui = {
  init(m) {
    manifest = m || {};
    const r = root();
    r.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && !b.disabled) this.act(b.dataset.act, b.dataset.v, b); });
    r.addEventListener('input', (e) => {
      const k = e.target.dataset && e.target.dataset.set;
      if (!k) return;
      G.settings[k] = +e.target.value;
      e.target.nextElementSibling.textContent = fmtVal(k, G.settings[k]);
      this.applySettings();
    });
    // Space activates on keydown here (handleKey), so the button's own keyup click must not run as well
    r.addEventListener('keyup', (e) => { if (e.code === 'Space' && e.target.tagName === 'BUTTON') e.preventDefault(); });
    // one highlight: pointing at a control focuses it (not while typing a name or waiting for a key to bind).
    // Only real pointer movement counts: Chrome sends synthetic moves when the layout changes under a resting cursor.
    let px = -1, py = -1;
    r.addEventListener('mousemove', (e) => {
      if (e.clientX === px && e.clientY === py) return;
      px = e.clientX; py = e.clientY;
      const el = e.target.closest && e.target.closest(NAV);
      const ae = document.activeElement;
      if (!el || el === ae || input.capturing() || (ae && ae.id === 'nameInput')) return;
      el.focus({ preventScroll: true });
      audio.ui('ui_move');
    });
    r.addEventListener('focusin', (e) => syncSelection(e.target));
    r.addEventListener('pointerdown', () => {
      if (current === 'splash') this.leaveSplash();
      else if (current === 'loading' && loadReady) this.enterPlay();
      else if (current === 'relock') this.enterPlay();          // a click is a user gesture: the lock request inside it is allowed
    });
    input.setUiHook((e) => this.handleKey(e));
    // the act is built synchronously right after this event: the backdrop must be gone before it
    bus.on('loading', (n) => { menuScene.dispose(); loadingAct = n; loadReady = false; hud.setVisible(false); this.show('loading'); });
    bus.on('actLoaded', () => {
      G.paused = true;
      const msg = document.getElementById('loadMsg');
      if (msg) msg.textContent = t('pressKey');
      setTimeout(() => { if (current === 'loading') loadReady = true; }, 250);
    });
    bus.on('lockgained', () => { clearTimeout(lockTimer); if (current === 'relock') this.enterPlay(); });
    bus.on('missionFail', () => { input.exitLock(); G.paused = true; hud.setVisible(false); this.show('fail'); });
    bus.on('missionEnd', (res) => { lastResult = res; input.exitLock(); hud.setVisible(false); this.show('end'); audio.ui('ui_ok'); });
    bus.on('flagDone', () => game.finish());
    bus.on('fade', (cb) => {
      const f = document.getElementById('fade');
      f.classList.add('on');
      setTimeout(() => { cb(); setTimeout(() => f.classList.remove('on'), 350); }, 420);
    });
    this.show('splash');
  },

  screen() { return current; },
  show(name) {
    const r = root(), same = name === current && name !== 'none';
    const keep = same ? keyOf(document.activeElement) : null;
    const scroll = same ? [...r.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll, el.scrollTop]) : [];
    current = name; G.screen = name;
    const bg = manifest.img && manifest.img.menu;
    const fe = FRONT.includes(name) && !G.mission;
    // the live backdrop: built on the first front-end screen and again after a mission ends
    if (fe && !bg) { if (menuScene.active || menuScene.build()) menuScene.shot(name); }
    r.className = name === 'none' ? 'hidden' : 'scr-' + name + (fe ? ' fe' : ' ig') + (fe && menuScene.active ? ' live' : '') + (fe && bg ? ' img' : '') + (same ? '' : ' enter');
    r.innerHTML = name === 'none' ? '' : SCREENS[name]() + (HINTS[name] ? keyBar(HINTS[name]) : '');
    r.style.backgroundImage = bg && fe ? `linear-gradient(rgba(10,13,16,.45),rgba(10,13,16,.88)),url('${bg}')` : '';
    if (name === 'none') return;
    for (const [k, top] of scroll) { const el = r.querySelector(`[data-scroll="${k}"]`); if (el) el.scrollTop = top; }
    // after a re-render keep focus on the same control; on a new screen start at its default
    const target = (keep && findKey(keep)) || defaultFocus();
    if (target) target.focus({ preventScroll: !keep });
    syncSelection(target);
    if (name === 'brief') runBriefing();
  },
  refresh() { if (current !== 'none') this.show(current); },

  /** First look at every key while a screen is up; true when the screen used it (input.js then stops it). */
  handleKey(e) {
    const scr = current, k = e.code;
    if (scr === 'none' || e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(k)) return false;
    const modifier = /^(Shift|Control|Alt|Meta|OS|CapsLock|Tab)/.test(k);
    if (scr === 'splash') { if (!e.repeat && !modifier) this.leaveSplash(); return !modifier; }
    if (scr === 'loading') { if (loadReady && !e.repeat && !modifier) this.enterPlay(); return !modifier; }
    const ae = document.activeElement, inRoot = ae && root().contains(ae), inText = inRoot && ae.tagName === 'INPUT' && ae.type === 'text';
    // inside the name field every arrow stays with the field; Enter, Esc and Tab leave it
    const up = !inText && (k === 'ArrowUp' || k === 'KeyW'), down = !inText && (k === 'ArrowDown' || k === 'KeyS');
    const left = !inText && (k === 'ArrowLeft' || k === 'KeyA'), right = !inText && (k === 'ArrowRight' || k === 'KeyD');
    const ok = k === 'Enter' || k === 'NumpadEnter' || (!inText && k === 'Space');
    const back = k === 'Escape' || (!inText && k === 'Backspace');
    if (ok && e.repeat) return true;                 // a held Enter must not run on through every screen
    if (ok && scr === 'relock') { this.enterPlay(); return true; }
    if (back) { if (!e.repeat && BACK[scr]) this.act(BACK[scr]); return true; }
    if (up || down) { this.move(down ? 1 : -1); return true; }
    if (left || right) { this.adjust(right ? 1 : -1); return true; }
    if (ok) {
      if (inText) { if (ae.id === 'nameInput') this.act('nameOk'); return true; }
      if (inRoot && ae.dataset.act === 'diff') { this.act('diff', ae.dataset.v, ae); this.act('diffOk'); return true; }
      if (inRoot && ae.tagName === 'BUTTON') { ae.click(); return true; }
      if (!inRoot) { const d = defaultFocus(); if (d) d.focus(); }     // nothing focused yet: start at the screen's default
      return true;
    }
    return false;
  },
  /** Step the focus through the screen's controls (wraps). */
  move(dir) {
    const list = stops();
    if (!list.length) return;
    const ae = document.activeElement;
    let i = list.indexOf(ae);
    if (i < 0 && ae && ae.dataset && ae.dataset.group) i = list.findIndex((el) => el.dataset.group === ae.dataset.group);
    const next = i < 0 ? list[dir > 0 ? 0 : list.length - 1] : list[(i + dir + list.length) % list.length];
    next.focus();
    audio.ui('ui_move');
  },
  /** ←/→ on the focused control: slider step, toggle, next choice in a group, or the neighbour in a button row. */
  adjust(dir) {
    const el = document.activeElement;
    if (!el || !root().contains(el)) return;
    if (el.matches('input[type="range"]')) {
      const st = +el.step || 1, v = Math.min(+el.max, Math.max(+el.min, Math.round((+el.value + dir * st) / st) * st));
      if (v !== +el.value) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); audio.ui('ui_move'); }
      return;
    }
    const g = el.dataset.group;
    if (g) {
      const opts = [...root().querySelectorAll(`[data-group="${g}"]`)];
      const cur = Math.max(0, opts.findIndex((o) => o.classList.contains('on') || o.classList.contains('sel')));
      const n = opts[Math.min(opts.length - 1, Math.max(0, cur + dir))];
      if (n && n !== opts[cur]) { n.focus(); this.act(n.dataset.act, n.dataset.v, n); }
      return;
    }
    if (el.classList.contains('tg') || el.dataset.act === 'lang') { el.click(); return; }
    const row = el.closest('.row');
    if (row) {
      const bs = [...row.querySelectorAll('button:not(:disabled)')], n = bs[bs.indexOf(el) + dir];
      if (n) { n.focus(); audio.ui('ui_move'); }
    }
  },

  leaveSplash() {
    audio.unlock(manifest);
    audio.ui('ui_ok');
    this.show('menu');
  },

  /** Hand control to the mission: hide the UI, show the HUD, lock the pointer. */
  enterPlay() {
    clearTimeout(lockTimer);
    this.show('none');
    hud.setVisible(true);
    G.paused = false;
    audio.resume();
    input.setEnabled(true);
    input.endStep();                     // nothing latched in a menu carries into play
    input.requestLock();
    // a refused or ignored lock request (Chrome refuses for ~1 s after Esc left the lock) must not leave the game running without mouse look
    if (!input.locked && !input.allowUnlocked) lockTimer = setTimeout(() => this.lockRefused(), 900);
  },
  /** Pointer lock was refused: stay paused with a click-to-resume card. Safe to call more than once. */
  lockRefused() {
    clearTimeout(lockTimer);
    if (current !== 'none' || !G.mission || G.paused || input.locked || input.allowUnlocked) return;
    G.paused = true;
    input.setEnabled(false);
    hud.setVisible(false);
    this.show('relock');
  },
  pause() {
    if (!G.mission || G.paused || current !== 'none') return;
    clearTimeout(lockTimer);
    G.paused = true;
    input.setEnabled(false);
    input.exitLock();
    hud.setVisible(false);
    this.show('pause');
  },

  applySettings() {
    const s = G.settings;
    audio.applyVolumes();
    if (G.player) G.player.fovTarget = s.fov;
    save.saveSettings({ ...s, binds: input.getBinds() });
  },

  act(a, v, node) {
    audio.ui(['back', 'menu', 'toName', 'toDiff', 'toPause'].includes(a) ? 'ui_back' : 'ui_ok');
    switch (a) {
      case 'new': pending.name = pending.name || ''; this.show('name'); break;
      case 'continue': { const cp = save.loadCheckpoint(); if (cp) game.resume(cp); break; }
      case 'menu': if (G.mission) game.quit(); hud.setVisible(false); this.show('menu'); break;
      case 'toName': this.show('name'); break;
      case 'toDiff': this.show('diff'); break;
      case 'toPause': this.show('pause'); break;
      case 'nameOk': {
        const name = sanitizeName(document.getElementById('nameInput').value);
        if (!name) { document.getElementById('nameErr').textContent = t('nameError'); break; }
        pending.name = name; this.show('diff'); break;
      }
      case 'diff': pending.difficulty = DIFFICULTY[v] ? v : 'normal'; this.show('diff'); break;
      case 'diffOk': this.show('brief'); break;
      case 'begin': clearInterval(briefTimer); game.start(pending.name, pending.difficulty); break;
      case 'again': game.quit(); game.start(lastResult.name, lastResult.difficulty); break;
      case 'settings': case 'controls': case 'credits': returnTo = current; this.show(a); break;
      case 'back': input.cancelCapture(); this.show(returnTo === 'pause' && G.mission ? 'pause' : 'menu'); break;
      case 'resume': this.enterPlay(); break;
      case 'restart': hud.reset(); if (!game.restartCheckpoint()) { game.quit(); this.show('menu'); } break;
      case 'quit': game.quit(); hud.setVisible(false); this.show('menu'); break;
      case 'lang': G.settings.lang = getLang() === 'az' ? 'en' : 'az'; setLang(G.settings.lang); document.documentElement.lang = G.settings.lang; this.applySettings(); this.refresh(); break;
      case 'toggle': G.settings[v] = !G.settings[v]; this.applySettings(); this.refresh(); break;
      case 'quality':
        // "auto" hands the tier back to GPU detection and the frame-time watcher; a named tier is the player's and stays
        G.settings.qualityAuto = v === 'auto';
        G.settings.quality = v === 'auto' ? R.detectTier() : v;
        R.setQuality(G.settings.quality); this.applySettings(); this.refresh(); break;
      case 'resetBinds': input.resetBinds(); this.applySettings(); this.refresh(); break;
      case 'bind':
        node.textContent = t('pressNew'); node.classList.add('on');
        input.capture((code) => { if (code !== 'Escape') input.setBind(v, code); this.applySettings(); this.refresh(); });
        break;
    }
  },
};
