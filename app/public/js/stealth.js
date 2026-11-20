/**
 * stealth.js — the detection maths (pure functions, unit-tested under Node).
 *
 * THE MODEL
 * Every enemy carries a detection meter in [0,1]. While the enemy has an
 * unobstructed sight line to the player inside its view cone, the meter fills
 * at
 *
 *     rate = baseRate × difficulty × alertness × visibility × distance × cone
 *
 * and drains at a fixed rate when the sight line is lost.
 *
 *   visibility = stance × movement × light × foliage      (how easy the player is to see)
 *   distance   = (1 − d / range)^1.5, with range shortened by fog and darkness;
 *                inside `closeRange` it jumps to 4 (you cannot hide at arm's length)
 *   cone       = 1 in the central cone, falling to 0.25 at the edge of peripheral vision
 *
 * Thresholds: 0.34 → the enemy turns Suspicious and walks over to look
 * (icon white → yellow), 0.7 → icon turns red, 1.0 → spotted, combat starts.
 */
import { STEALTH } from './config.js';
import { clamp01, lerp } from './ctx.js';

/**
 * How visible the player is, independent of who is looking.
 * @param stance 0 stand, 1 crouch, 2 prone
 * @param speedFrac horizontal speed as a fraction of sprint speed (0..1)
 * @param light 0 (pitch dark) .. 1 (fully lit)
 * @param inFoliage true when standing inside a bush / tall grass zone
 */
export function visibility(stance, speedFrac, light, inFoliage) {
  const s = STEALTH.stance[stance] ?? 1;
  // still < walking < sprinting; piecewise-linear through the three anchors
  const m = speedFrac < 0.05 ? STEALTH.moveStill
    : speedFrac < 0.6 ? lerp(STEALTH.moveStill, STEALTH.moveWalk, speedFrac / 0.6)
      : lerp(STEALTH.moveWalk, STEALTH.moveSprint, (speedFrac - 0.6) / 0.4);
  const l = lerp(STEALTH.lightMin, STEALTH.lightMax, clamp01(light));
  const f = inFoliage ? (stance === 0 ? STEALTH.foliage : STEALTH.foliageLow) : 1;
  return s * m * l * f;
}

/**
 * Maximum distance at which an enemy can pick the player out at all.
 * Fog eats up to 55% of the clear-air range; darkness another 35%.
 * @param fog 0 (clear) .. 1 (pea soup)
 */
export function sightRange(fog, light) {
  const r = STEALTH.baseRange * (1 - 0.55 * clamp01(fog)) * lerp(0.65, 1, clamp01(light));
  return Math.max(STEALTH.minRange, r);
}

/** 1 inside the central cone, easing to 0.25 at the peripheral edge, 0 outside. */
export function coneFactor(angle) {
  const a = Math.abs(angle);
  if (a <= STEALTH.fovCentral) return 1;
  if (a >= STEALTH.fovEdge) return 0;
  const t = (a - STEALTH.fovCentral) / (STEALTH.fovEdge - STEALTH.fovCentral);
  return lerp(1, 0.25, t);
}

/** Distance term of the rate (see the model above). */
export function distanceFactor(dist, range) {
  if (dist <= STEALTH.closeRange) return 4;
  if (dist >= range) return 0;
  return Math.pow(1 - dist / range, 1.5);
}

/**
 * Meter fill rate per second for one enemy looking at the player.
 * @param o.dist      metres between eye and player
 * @param o.range     from sightRange()
 * @param o.angle     radians off the enemy's facing direction
 * @param o.vis       from visibility()
 * @param o.diffMult  DIFFICULTY[x].detectMult
 * @param o.alert     0 patrol, 1 suspicious/searching, 2 combat
 */
export function detectionRate(o) {
  const cone = coneFactor(o.angle);
  if (cone <= 0) return 0;
  const d = distanceFactor(o.dist, o.range);
  if (d <= 0) return 0;
  const alert = o.alert === 2 ? STEALTH.combatMult : o.alert === 1 ? STEALTH.alertMult : 1;
  return STEALTH.baseRate * o.diffMult * alert * o.vis * d * cone;
}

/** Advance a meter by dt. `seen` = a sight line exists this tick. */
export function stepMeter(meter, rate, seen, dt) {
  if (seen && rate > 0) return Math.min(1, meter + rate * dt);
  return Math.max(0, meter - STEALTH.decay * dt);
}

/** Icon colour band for a meter value: 0 white, 1 yellow, 2 red. */
export function meterBand(meter) {
  return meter >= STEALTH.redAt ? 2 : meter >= STEALTH.suspiciousAt ? 1 : 0;
}

/**
 * Light level at a point from ambient light plus point lights.
 * lamps: array of { x, y, z, r, i } (radius, intensity). Occlusion is the
 * caller's business (level.lightAt does the ray checks); this is the falloff.
 */
export function lampContribution(lamp, x, y, z) {
  const dx = x - lamp.x, dy = y - lamp.y, dz = z - lamp.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= lamp.r * lamp.r) return 0;
  const t = 1 - Math.sqrt(d2) / lamp.r;
  return lamp.i * t * t;
}
