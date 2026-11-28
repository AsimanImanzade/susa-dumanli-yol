/**
 * save.js — settings, checkpoint and best scores in localStorage.
 * Every read is defensive: storage can be unavailable (private mode) or hold
 * data from an older build, and the game must still start.
 */
import { DEFAULT_SETTINGS, DEFAULT_BINDS } from './config.js';

const K = { settings: 'sdy:settings:v1', checkpoint: 'sdy:checkpoint:v1', best: 'sdy:best:v1', pid: 'sdy:pid' };

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
function remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }

export const save = {
  loadSettings() {
    const s = { ...DEFAULT_SETTINGS, ...(read(K.settings) || {}) };
    s.binds = { ...DEFAULT_BINDS, ...(s.binds || {}) };
    // clamp anything a hand-edited or stale save could have broken
    s.sensitivity = Math.min(3, Math.max(0.2, +s.sensitivity || 1));
    s.fov = Math.min(100, Math.max(55, +s.fov || 75));
    for (const k of ['volMaster', 'volMusic', 'volSfx']) s[k] = Math.min(1, Math.max(0, +s[k]));
    if (!['low', 'medium', 'high'].includes(s.quality)) s.quality = 'medium';
    if (!['az', 'en'].includes(s.lang)) s.lang = 'az';
    for (const k of ['invertY', 'motionBlur', 'killCam', 'subtitles', 'showFps', 'hudPercent']) s[k] = !!s[k];
    return s;
  },
  saveSettings(s) { write(K.settings, s); },

  /** Checkpoint snapshot written by game.js; null when there is none. */
  loadCheckpoint() {
    const c = read(K.checkpoint);
    return c && c.v === 1 && c.name && c.act >= 1 && c.act <= 4 ? c : null;
  },
  saveCheckpoint(c) { write(K.checkpoint, { ...c, v: 1 }); },
  clearCheckpoint() { remove(K.checkpoint); },

  /** Best result per difficulty: { easy: {score, rank, time}, ... }. */
  loadBest() { return read(K.best) || {}; },
  /** Records the result if it beats the stored one; returns true when it does. */
  recordBest(difficulty, result) {
    const best = this.loadBest();
    const prev = best[difficulty];
    if (prev && prev.score >= result.score) return false;
    best[difficulty] = { score: result.score, rank: result.rank, time: result.time };
    write(K.best, best);
    return true;
  },

  /** Stable anonymous id for this browser; also names this player's private room. */
  playerId() {
    let id = null;
    try { id = localStorage.getItem(K.pid); } catch { /* ignore */ }
    if (!id || !/^[a-z0-9]{8,16}$/.test(id)) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join('');
      try { localStorage.setItem(K.pid, id); } catch { /* ignore */ }
    }
    return id;
  },
};
