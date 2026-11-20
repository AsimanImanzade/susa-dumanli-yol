/**
 * ai-fsm.js — the enemy state machine as a pure transition table.
 *
 *              glimpse / quiet noise            2nd stimulus, loud noise,
 *   ┌────────┐ ───────────────────▶ ┌────────────┐ body found, missed check-in ┌───────────┐
 *   │ PATROL │                      │ SUSPICIOUS │ ──────────────────────────▶ │ SEARCHING │
 *   └────────┘ ◀─────────────────── └────────────┘                             └───────────┘
 *        ▲        looked, found nothing        │                                  │     ▲
 *        │                                     │ meter full / shot at            │     │ lost sight for
 *        │   search time ran out               ▼                                  ▼     │ `loseSight` s
 *        └──────────────────────────────── ┌────────┐ ◀──────── meter full ──────┘     │
 *                                          │ COMBAT │ ─────────────────────────────────┘
 *                                          └────────┘
 *   Any state ──flashbang──▶ STUNNED ──timer──▶ SEARCHING.   Any state ──hp ≤ 0──▶ DEAD.
 *
 * ai.js owns movement, shooting and timers; this file only answers "given this
 * state and this stimulus, what is the next state?", so the rules can be tested
 * without a scene.
 */

export const S = {
  PATROL: 'patrol', SUSPICIOUS: 'suspicious', SEARCHING: 'searching',
  COMBAT: 'combat', STUNNED: 'stunned', DEAD: 'dead',
};

/** Stimuli an enemy can receive. */
export const STIM = {
  GLIMPSE: 'glimpse',           // detection meter crossed the suspicious threshold
  SPOTTED: 'spotted',           // detection meter is full
  NOISE_QUIET: 'noise_quiet',   // footsteps, thrown stone, suppressed shot nearby, body fall
  NOISE_LOUD: 'noise_loud',     // unsuppressed shot, explosion
  BODY_FOUND: 'body_found',
  ALLY_CALL: 'ally_call',       // a teammate in combat shouted for help
  ALLY_SEARCH: 'ally_search',   // a teammate started searching and called it in
  CHECKIN_MISSED: 'checkin_missed',
  HIT: 'hit',                   // took damage and survived
  LOST_SIGHT: 'lost_sight',     // combat: no sight line for `loseSight` seconds
  INVESTIGATED: 'investigated', // suspicious: reached the spot, looked, nothing there
  SEARCH_DONE: 'search_done',   // searching: search time ran out
  FLASHED: 'flashed',
  RECOVERED: 'recovered',       // stun wore off
  KILLED: 'killed',
};

/** Alertness tier used by the detection maths: 0 calm, 1 wary, 2 fighting. */
export function alertLevel(state) {
  return state === S.COMBAT ? 2 : (state === S.SUSPICIOUS || state === S.SEARCHING) ? 1 : 0;
}

/**
 * The transition function. Returns the next state (possibly the same one).
 * Unknown combinations leave the state unchanged.
 */
export function nextState(state, stim) {
  if (state === S.DEAD) return S.DEAD;
  if (stim === STIM.KILLED) return S.DEAD;
  if (stim === STIM.FLASHED) return S.STUNNED;

  switch (state) {
    case S.STUNNED:
      // a stunned soldier is blind and deaf; he only comes round
      return stim === STIM.RECOVERED ? S.SEARCHING : S.STUNNED;

    case S.PATROL:
      switch (stim) {
        case STIM.GLIMPSE: case STIM.NOISE_QUIET: return S.SUSPICIOUS;
        case STIM.NOISE_LOUD: case STIM.BODY_FOUND: case STIM.ALLY_SEARCH:
        case STIM.CHECKIN_MISSED: case STIM.HIT: return S.SEARCHING;
        case STIM.SPOTTED: case STIM.ALLY_CALL: return S.COMBAT;
        default: return state;
      }

    case S.SUSPICIOUS:
      switch (stim) {
        // a second stimulus while already wary escalates
        case STIM.NOISE_QUIET: case STIM.NOISE_LOUD: case STIM.BODY_FOUND:
        case STIM.ALLY_SEARCH: case STIM.CHECKIN_MISSED: case STIM.HIT: return S.SEARCHING;
        case STIM.SPOTTED: case STIM.ALLY_CALL: return S.COMBAT;
        case STIM.INVESTIGATED: return S.PATROL;
        default: return state;   // another glimpse just refreshes the look target
      }

    case S.SEARCHING:
      switch (stim) {
        case STIM.SPOTTED: case STIM.ALLY_CALL: return S.COMBAT;
        case STIM.SEARCH_DONE: return S.PATROL;
        default: return state;   // further noises only move the search centre
      }

    case S.COMBAT:
      switch (stim) {
        case STIM.LOST_SIGHT: return S.SEARCHING;
        default: return state;
      }
  }
  return state;
}

/** Map a noise kind to the stimulus it produces. */
export function noiseStimulus(kind) {
  switch (kind) {
    case 'shot': case 'explosion': case 'flash': return STIM.NOISE_LOUD;
    default: return STIM.NOISE_QUIET;
  }
}
