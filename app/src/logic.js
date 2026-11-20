/**
 * Şuşa: Dumanlı Yol — room logic.
 *
 * The game itself (rendering, physics, AI, shooting) runs in the browser; see
 * public/js. This file only keeps the mission record for one player:
 * which act and checkpoint they reached, and the validated end-of-mission
 * score. It is deliberately small so the rules are easy to audit.
 *
 * Actions (all sent by the seated player):
 *   { type: "start", difficulty: "easy" | "normal" | "hard" }
 *   { type: "checkpoint", act: 1..4, cp: 0.., stats }
 *   { type: "finish", stats }
 *
 * stats = { kills, headshots, stealthKills, spotted, shots, hits, time, deaths }
 * — non-negative integers; `time` is seconds.
 *
 * Contract rules: six exports, no imports, pure and deterministic, state is
 * JSON-serializable.
 */

export const meta = {
  game: "Şuşa: Dumanlı Yol",
  minPlayers: 1,
  maxPlayers: 1,
};

const DIFFICULTY_MULT = { easy: 0.85, normal: 1, hard: 1.25 };
const STAT_KEYS = ["kills", "headshots", "stealthKills", "spotted", "shots", "hits", "time", "deaths"];
const STAT_MAX = { kills: 400, headshots: 400, stealthKills: 400, spotted: 1000, shots: 20000, hits: 20000, time: 86400, deaths: 1000 };
const ZERO = { kills: 0, headshots: 0, stealthKills: 0, spotted: 0, shots: 0, hits: 0, time: 0, deaths: 0 };

export function setup(players) {
  return { v: 1, player: players[0] ?? null, status: "idle", difficulty: null, act: 0, cp: 0, stats: { ...ZERO }, score: 0, rank: null, accuracy: 0 };
}

/** Shape and range check for a stats object. Returns an error string or null. */
function statsError(stats) {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) return "stats must be an object";
  for (const k of STAT_KEYS) {
    const v = stats[k];
    if (!Number.isInteger(v) || v < 0 || v > STAT_MAX[k]) return `stats.${k} must be an integer 0-${STAT_MAX[k]}`;
  }
  if (stats.headshots > stats.kills) return "headshots cannot exceed kills";
  if (stats.stealthKills > stats.kills) return "stealthKills cannot exceed kills";
  if (stats.hits > stats.shots) return "hits cannot exceed shots";
  return null;
}

/**
 * The gatekeeper. The client is untrusted, so everything is checked here:
 * who is acting, that progress only moves forward, and that the numbers are
 * sane.
 */
export function validateAction(state, playerId, action) {
  if (playerId !== state.player) return { ok: false, error: "not your mission" };
  if (!action || typeof action !== "object" || Array.isArray(action)) return { ok: false, error: "action must be an object" };

  if (action.type === "start") {
    if (!Object.prototype.hasOwnProperty.call(DIFFICULTY_MULT, action.difficulty)) return { ok: false, error: "difficulty must be easy, normal or hard" };
    return { ok: true };
  }

  if (action.type === "checkpoint") {
    if (state.status !== "active") return { ok: false, error: "no mission in progress" };
    if (!Number.isInteger(action.act) || action.act < 1 || action.act > 4) return { ok: false, error: "act must be an integer 1-4" };
    if (!Number.isInteger(action.cp) || action.cp < 0 || action.cp > 50) return { ok: false, error: "cp must be an integer 0-50" };
    // progress is forward-only, and one act at a time
    if (action.act < state.act) return { ok: false, error: "cannot go back an act" };
    if (action.act > state.act + 1) return { ok: false, error: "cannot skip an act" };
    if (action.act === state.act && action.cp < state.cp) return { ok: false, error: "cannot go back a checkpoint" };
    const err = statsError(action.stats);
    if (err) return { ok: false, error: err };
    if (action.stats.time < state.stats.time) return { ok: false, error: "time cannot run backwards" };
    return { ok: true };
  }

  if (action.type === "finish") {
    if (state.status !== "active") return { ok: false, error: "no mission in progress" };
    if (state.act !== 4) return { ok: false, error: "the mission ends in act 4" };
    const err = statsError(action.stats);
    if (err) return { ok: false, error: err };
    if (action.stats.time < state.stats.time) return { ok: false, error: "time cannot run backwards" };
    return { ok: true };
  }

  return { ok: false, error: "unknown action type" };
}

/**
 * End-of-mission score. Mirrors computeScore() in public/js/config.js
 * (this file may not import, so the formula lives in both places;
 * tests-node/score.mjs keeps them in step).
 */
function score(stats, difficulty) {
  const acc = stats.shots > 0 ? stats.hits / stats.shots : 0;
  const timeBonus = Math.min(1500, Math.max(0, 2400 - stats.time));
  let s = 5000 + stats.kills * 40 + stats.headshots * 60 + stats.stealthKills * 80
    + Math.round(acc * 1500) + timeBonus - stats.spotted * 200 - stats.deaths * 300;
  s = Math.max(0, Math.round(s * DIFFICULTY_MULT[difficulty]));
  const rank = s >= 10500 ? "S" : s >= 8500 ? "A" : s >= 6500 ? "B" : "C";
  return { score: s, rank, accuracy: Math.round(acc * 100) };
}

function pickStats(stats) {
  const out = {};
  for (const k of STAT_KEYS) out[k] = stats[k];
  return out;
}

/** Returns a NEW state; never mutates. Runs only after validateAction said ok. */
export function applyAction(state, playerId, action) {
  if (action.type === "start") {
    return { ...state, status: "active", difficulty: action.difficulty, act: 1, cp: 0, stats: { ...ZERO }, score: 0, rank: null, accuracy: 0 };
  }
  if (action.type === "checkpoint") {
    return { ...state, act: action.act, cp: action.cp, stats: pickStats(action.stats) };
  }
  // finish
  const stats = pickStats(action.stats);
  return { ...state, status: "done", stats, ...score(stats, state.difficulty) };
}

export function isGameOver(state) {
  if (state.status !== "done") return { over: false };
  return { over: true, winner: state.player, score: state.score, rank: state.rank, accuracy: state.accuracy, difficulty: state.difficulty };
}

/** The seated player sees their record; anyone else only sees that a mission is under way. */
export function viewFor(state, playerId) {
  if (playerId !== state.player) return { status: state.status, act: state.act };
  return { status: state.status, difficulty: state.difficulty, act: state.act, cp: state.cp, stats: state.stats, score: state.score, rank: state.rank, accuracy: state.accuracy };
}
