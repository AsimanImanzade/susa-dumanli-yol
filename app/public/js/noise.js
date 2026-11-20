/**
 * noise.js — the noise event bus.
 *
 * Anything audible calls noise.emit({ x, y, z, radius, kind, ... }). The bus
 * hands the event to every registered listener (the AI module registers one
 * that fans it out to enemies). Whether a given enemy actually hears it is
 * decided by `hears()`: inside the radius, with the radius cut by
 * NOISE.occlusionMult when there is no clear line between source and ear.
 *
 * kinds: step, land, shot, shot_suppressed, impact, explosion, flash, body,
 *        door, distraction, melee, voice
 */
import { NOISE } from './config.js';

const sinks = [];
let lastPlayerRadius = 0;   // for the HUD noise indicator
let lastPlayerTime = -10;

export const noise = {
  /** Register a listener: fn(evt). */
  listen(fn) { sinks.push(fn); return fn; },
  clear() { sinks.length = 0; lastPlayerRadius = 0; lastPlayerTime = -10; },

  /**
   * @param evt { x, y, z, radius, kind, byPlayer?, time?, source? }
   */
  emit(evt) {
    if (!(evt.radius > 0)) return;
    if (evt.byPlayer) {
      const t = evt.time ?? 0;
      // keep the loudest recent radius so a shot isn't hidden by the next footstep
      if (evt.radius >= lastPlayerRadius || t - lastPlayerTime > 0.6) {
        lastPlayerRadius = evt.radius;
        lastPlayerTime = t;
      }
    }
    for (let i = 0; i < sinks.length; i++) sinks[i](evt);
  },

  /** HUD: 0..1 loudness of what the player last did, fading over ~1 s. */
  playerLoudness(now) {
    const age = now - lastPlayerTime;
    if (age > 1.2) return 0;
    const fade = age < 0.25 ? 1 : 1 - (age - 0.25) / 0.95;
    return Math.min(1, lastPlayerRadius / 60) * fade;
  },
};

/**
 * Does a listener at (lx,ly,lz) hear the event?
 * @param occluded true when geometry blocks the straight line
 * @returns 0 when not heard, otherwise loudness 0..1 (1 = right on top of it)
 */
export function hears(evt, lx, ly, lz, occluded) {
  const r = occluded ? evt.radius * NOISE.occlusionMult : evt.radius;
  const dx = lx - evt.x, dy = (ly - evt.y) * 1.5, dz = lz - evt.z; // floors muffle more than walls
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= r * r) return 0;
  return 1 - Math.sqrt(d2) / r;
}

/** Footstep noise radius for a surface, stance (0..2) and sprint flag. */
export function stepRadius(surface, stance, sprinting) {
  const base = NOISE.step[surface] ?? NOISE.step.dirt;
  return base * NOISE.stanceMult[stance] * (sprinting ? NOISE.sprintMult : 1);
}
