/**
 * ui.js — every screen outside the mission: splash, main menu, name entry,
 * difficulty, briefing, loading, pause, settings (with key rebinding),
 * controls, credits, mission failed and the end-of-mission report.
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

const root = () => document.getElementById('ui');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let current = 'splash', returnTo = 'menu', pending = { name: '', difficulty: 'normal' }, lastResult = null, loadingAct = 1, briefTimer = null;
let manifest = {};

const btn = (act, label, cls = '', dis = false) => `<button data-act="${act}" class="${cls}"${dis ? ' disabled' : ''}>${esc(label)}</button>`;
const langBtn = () => `<button data-act="lang" class="lang">${getLang() === 'az' ? 'AZ · en' : 'az · EN'}</button>`;

const SCREENS = {
  splash: () => `<div class="splash"><h1>${esc(t('title'))}</h1><h3>${esc(t('subtitle'))}</h3><p class="blink">${esc(t('pressKey'))}</p></div>`,

  menu: () => {
    const cp = save.loadCheckpoint();
    return `<div class="menu"><h1>${esc(t('title'))}</h1><h3>${esc(t('subtitle'))}</h3><nav>
      ${btn('new', t('newGame'), 'primary')}${btn('continue', t('continue'), '', !cp)}
      ${cp ? `<small>${esc(t('continueInfo', { name: cp.name, act: t('act' + cp.act), diff: t('diff_' + cp.difficulty) }))}</small>` : ''}
      ${btn('settings', t('settings'))}${btn('controls', t('controls'))}${btn('credits', t('credits'))}</nav>${langBtn()}<p class="tag">${esc(t('tagline'))}</p></div>`;
  },

  name: () => `<div class="panel narrow"><h2>${esc(t('nameTitle'))}</h2>
    <input id="nameInput" type="text" maxlength="24" autocomplete="off" spellcheck="false" placeholder="${esc(t('namePlaceholder'))}" value="${esc(pending.name)}">
    <p class="hint">${esc(t('nameHint'))}</p><p class="error" id="nameErr"></p>
    <div class="row">${btn('menu', t('back'))}${btn('nameOk', t('confirm'), 'primary')}</div></div>`,

  diff: () => `<div class="panel"><h2>${esc(t('diffTitle'))}</h2><div class="cards">
    ${['easy', 'normal', 'hard'].map((d) => `<button data-act="diff" data-v="${d}" class="card${pending.difficulty === d ? ' sel' : ''}"><b>${esc(t('diff_' + d))}</b><span>${esc(t('diff_' + d + '_d'))}</span></button>`).join('')}
    </div><div class="row">${btn('toName', t('back'))}${btn('diffOk', t('confirm'), 'primary')}</div></div>`,

  brief: () => `<div class="panel wide brief"><h2>${esc(t('briefTitle'))}</h2><div class="cols"><canvas id="briefMap" width="520" height="340"></canvas>
    <div><p class="op">${esc(t('briefOperative'))}: <b>${esc(pending.name)}</b> · ${esc(t('diff_' + pending.difficulty))}</p><h4>${esc(t('briefObjectives'))}</h4>
    <ol>${[1, 2, 3, 4].map((i) => `<li>${esc(t('brief_o' + i))}</li>`).join('')}</ol><div id="briefRadio" class="radio"></div></div></div>
    <div class="row">${btn('toDiff', t('back'))}${btn('begin', t('briefStart'), 'primary')}</div></div>`,

  loading: () => `<div class="loading"${manifest.img && manifest.img['loading' + loadingAct] ? ` style="background-image:linear-gradient(rgba(10,13,16,.55),rgba(10,13,16,.85)),url('${manifest.img['loading' + loadingAct]}')"` : ''}>
    <h2>${esc(t('act' + loadingAct))}</h2><p>${esc(t('act' + loadingAct + '_d'))}</p><p class="tip">${esc(t('tip' + (1 + (loadingAct * 3 + Math.floor(Date.now() / 4000)) % 8)))}</p>
    <p class="blink" id="loadMsg">${esc(t('loading'))}</p></div>`,

  pause: () => `<div class="panel narrow"><h2>${esc(t('paused'))}</h2><nav>${btn('resume', t('resume'), 'primary')}${btn('settings', t('settings'))}${btn('controls', t('controls'))}
    ${btn('restart', t('restartCp'))}${btn('quit', t('quit'))}</nav></div>`,

  settings: () => {
    const s = G.settings;
    const slider = (k, label, min, max, step) => `<label><span>${esc(t(label))}</span><input type="range" data-set="${k}" min="${min}" max="${max}" step="${step}" value="${s[k]}"><output>${fmtVal(k, s[k])}</output></label>`;
    const toggle = (k, label) => `<label><span>${esc(t(label))}</span><button data-act="toggle" data-v="${k}" class="tg${s[k] ? ' on' : ''}">${esc(t(s[k] ? 'on' : 'off'))}</button></label>`;
    return `<div class="panel wide settings"><h2>${esc(t('settings'))}</h2><div class="cols">
      <div><h4>${esc(t('s_game'))}</h4>${slider('sensitivity', 's_sens', 0.2, 3, 0.05)}${slider('fov', 's_fov', 55, 100, 1)}${toggle('invertY', 's_invert')}${toggle('killCam', 's_killcam')}${toggle('subtitles', 's_subs')}
        <label><span>${esc(t('lang'))}</span>${langBtn()}</label>
        <h4>${esc(t('s_audio'))}</h4>${slider('volMaster', 's_master', 0, 1, 0.05)}${slider('volMusic', 's_music', 0, 1, 0.05)}${slider('volSfx', 's_sfx', 0, 1, 0.05)}
        <h4>${esc(t('s_video'))}</h4><label><span>${esc(t('s_quality'))}</span><span class="seg">${['auto', 'low', 'medium', 'high'].map((q) => `<button data-act="quality" data-v="${q}" class="${(q === 'auto' ? R.isAuto() : !R.isAuto() && s.quality === q) ? 'on' : ''}">${esc(t('q_' + q))}</button>`).join('')}</span></label>${toggle('motionBlur', 's_blur')}</div>
      <div><h4>${esc(t('s_binds'))}</h4><div class="binds">${ACTIONS.map((a) => `<label><span>${esc(t('a_' + a))}</span><button data-act="bind" data-v="${a}">${esc(keyLabel(input.bindOf(a)))}</button></label>`).join('')}</div>
        ${btn('resetBinds', t('s_reset'))}</div></div><div class="row">${btn('back', t('back'), 'primary')}</div></div>`;
  },

  controls: () => `<div class="panel wide"><h2>${esc(t('controls'))}</h2><div class="binds two">${ACTIONS.map((a) => `<label><span>${esc(t('a_' + a))}</span><kbd>${esc(keyLabel(input.bindOf(a)))}</kbd></label>`).join('')}</div>
    <div class="row">${btn('back', t('back'), 'primary')}</div></div>`,

  credits: () => `<div class="panel"><h2>${esc(t('credits'))}</h2><p class="pre">${esc(t('creditsText'))}</p><div class="row">${btn('back', t('back'), 'primary')}</div></div>`,

  fail: () => `<div class="panel narrow fail"><h2>${esc(t('failTitle'))}</h2><p>${esc(t('failSub', { name: G.mission ? G.mission.name : '' }))}</p><nav>${btn('restart', t('restartCp'), 'primary')}${btn('quit', t('quit'))}</nav></div>`,

  end: () => {
    const r = lastResult, s = r.stats;
    const row = (k, v) => `<tr><td>${esc(t(k))}</td><td>${esc(v)}</td></tr>`;
    return `<div class="panel wide end"><h2>${esc(t('endTitle'))}</h2><p class="sub">${esc(t('endSub'))}</p><div class="cols">
      <table>${row('e_soldier', r.name)}${row('e_diff', t('diff_' + r.difficulty))}${row('e_time', fmtTime(r.time))}${row('e_kills', s.kills)}${row('e_heads', s.headshots)}
        ${row('e_stealth', s.stealthKills)}${s.vehicles ? row('e_vehicles', s.vehicles) : ''}${row('e_spotted', s.spotted)}${row('e_acc', r.accuracy + '%')}${row('e_score', r.score)}</table>
      <div class="rank"><span>${esc(t('e_rank'))}</span><b class="r${r.rank}">${r.rank}</b><em>${esc(t('medal_' + r.rank))}</em>
        <small>${r.newBest ? esc(t('e_newBest')) : r.best ? esc(t('e_best')) + ': ' + r.best.score + ' (' + r.best.rank + ')' : ''}</small></div></div>
      <div class="row">${btn('menu', t('mainMenu'))}${btn('again', t('playAgain'), 'primary')}</div></div>`;
  },
};

function fmtVal(k, v) { return k === 'fov' ? Math.round(v) + '°' : k === 'sensitivity' ? (+v).toFixed(2) : Math.round(v * 100) + '%'; }

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
    r.addEventListener('keydown', (e) => { if (e.target.id === 'nameInput' && e.key === 'Enter') this.act('nameOk'); });
    r.addEventListener('mouseover', (e) => { if (e.target.tagName === 'BUTTON' && !e.target.disabled) audio.ui('ui_move'); });
    bus.on('anykey', (code) => {
      if (current === 'splash') this.leaveSplash();
      else if (code === 'Escape' && ['settings', 'controls', 'credits'].includes(current)) this.act('back');
    });
    r.addEventListener('pointerdown', () => { if (current === 'splash') this.leaveSplash(); });
    bus.on('loading', (n) => { loadingAct = n; hud.setVisible(false); this.show('loading'); });
    bus.on('actLoaded', () => {
      G.paused = true;
      const msg = document.getElementById('loadMsg');
      if (msg) msg.textContent = t('pressKey');
      const go = () => { if (current !== 'loading') return; window.removeEventListener('pointerdown', go); bus.off('anykey', go); this.enterPlay(); };
      setTimeout(() => { window.addEventListener('pointerdown', go); bus.on('anykey', go); }, 250);
    });
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
    current = name; G.screen = name;
    const r = root();
    r.className = name === 'none' ? 'hidden' : 'scr-' + name;
    r.innerHTML = name === 'none' ? '' : SCREENS[name]();
    const bg = manifest.img && manifest.img.menu;
    r.style.backgroundImage = bg && ['splash', 'menu', 'name', 'diff', 'brief', 'credits'].includes(name) && !G.mission ? `linear-gradient(rgba(10,13,16,.45),rgba(10,13,16,.88)),url('${bg}')` : '';
    if (name === 'name') setTimeout(() => { const i = document.getElementById('nameInput'); if (i) i.focus(); }, 30);
    if (name === 'brief') runBriefing();
  },
  refresh() { if (current !== 'none') this.show(current); },

  leaveSplash() {
    audio.unlock(manifest);
    audio.ui('ui_ok');
    this.show('menu');
  },

  /** Hand control to the mission: hide the UI, show the HUD, lock the pointer. */
  enterPlay() {
    this.show('none');
    hud.setVisible(true);
    G.paused = false;
    audio.resume();
    input.setEnabled(true);
    input.requestLock();
  },
  pause() {
    if (!G.mission || G.paused || current !== 'none') return;
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
    audio.ui(a === 'back' || a === 'menu' ? 'ui_back' : 'ui_ok');
    switch (a) {
      case 'new': pending.name = pending.name || ''; this.show('name'); break;
      case 'continue': { const cp = save.loadCheckpoint(); if (cp) game.resume(cp); break; }
      case 'menu': if (G.mission) game.quit(); hud.setVisible(false); this.show('menu'); break;
      case 'toName': this.show('name'); break;
      case 'toDiff': this.show('diff'); break;
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
