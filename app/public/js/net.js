/**
 * net.js — thin adapter to the room (app/src/logic.js).
 *
 * The game itself runs entirely in the browser. The room only records mission
 * state: which act and checkpoint the player reached, and the validated
 * end-of-mission score. Every browser gets its own room (named after its
 * anonymous id) so two players never share a seat.
 *
 * Offline is a supported mode: on a plain static server (no /ws endpoint) the
 * adapter stays silent and the local save is the only record.
 */
import { save } from './save.js';

const PING = '__ping', PONG = '__pong';
let socket = null, retry = 0, queue = [], timer = null;
const local = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
const enabled = !local || new URLSearchParams(location.search).has('net');

function intStats(s) {
  return { kills: s.kills | 0, headshots: s.headshots | 0, stealthKills: s.stealthKills | 0, spotted: s.spotted | 0,
    shots: s.shots | 0, hits: s.hits | 0, time: Math.round(s.time) | 0, deaths: s.deaths | 0 };
}

export const net = {
  online: false, status: 'offline', view: null, result: null, lastError: null,

  connect() {
    if (!enabled || socket) return;
    const pid = save.playerId();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { socket = new WebSocket(`${proto}//${location.host}/ws/p-${pid}`); } catch { socket = null; return; }
    socket.addEventListener('open', () => { retry = 0; this.online = true; this._raw({ type: 'join', playerId: pid }); });
    socket.addEventListener('message', (ev) => {
      if (ev.data === PONG) return;
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'state') {
        this.status = msg.status; this.view = msg.view; this.result = msg.result;
        const q = queue; queue = [];
        for (const a of q) this._action(a);
      } else if (msg.type === 'error') this.lastError = msg.error;
    });
    socket.addEventListener('close', () => {
      this.online = false; socket = null; this.status = 'offline';
      retry = Math.min(retry + 1, 6);
      if (retry < 6) setTimeout(() => this.connect(), 500 * 2 ** (retry - 1));
    });
    if (!timer) timer = setInterval(() => { if (socket && socket.readyState === WebSocket.OPEN) socket.send(PING); }, 30000);
  },

  _raw(msg) { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg)); },
  _action(action) {
    if (!enabled) return;
    if (!this.online || this.status === 'offline' || this.status === 'waiting') { if (queue.length < 8) queue.push(action); return; }
    // a finished mission must be reset before a new one can start
    if (this.status === 'over') { if (action.type !== 'start') return; this.status = 'playing'; this._raw({ type: 'reset' }); }
    this._raw({ type: 'action', action });
  },

  start(difficulty) { this._action({ type: 'start', difficulty }); },
  checkpoint(act, cp, stats) { this._action({ type: 'checkpoint', act, cp, stats: intStats(stats) }); },
  finish(stats) { this._action({ type: 'finish', stats: intStats(stats) }); },
};
