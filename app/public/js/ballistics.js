/**
 * ballistics.js — pure weapon maths: damage falloff, the lethal-headshot rule,
 * soldier hit zones (ray vs head / body / limb), recoil patterns, suppressor
 * wear and fit, and the SVD's projectile integration.
 * No Three.js here so it runs under Node for tests.
 */
import { clamp01, lerp } from './ctx.js';

/**
 * Suppressor durability after one shot.
 *   wear per shot = wearMult / shotsOnNormal
 * so Normal (wearMult 1) gets `shotsOnNormal` shots, Easy more, Hard fewer.
 * Returns a value in [0,1]; exactly 0 means the suppressor has broken.
 */
export function wearSuppressor(durability, shotsOnNormal, wearMult) {
  if (shotsOnNormal <= 0) return 0;
  const next = durability - wearMult / shotsOnNormal;
  return next <= 1e-6 ? 0 : next;
}

/**
 * Suppressors are weapon-specific. Each weapon names the pickup type that fits
 * it (config WEAPONS[id].supType): the pistol takes 'suppressor' (its spares),
 * the AKM and AK-74 take 'akmsup', the SVD takes 'svdsup'. A weapon with no
 * suppressor durability takes none.
 */
export const SUPPRESSOR_TYPES = ['suppressor', 'akmsup', 'svdsup'];
export function suppressorFits(weapon, supType) {
  return !!weapon && weapon.suppressorShots > 0 && weapon.supType === supType;
}

/**
 * Noise radius of a suppressed shot. A fresh can is nearly silent; as it wears
 * the radius climbs towards 60% of the unsuppressed radius (quadratic, so the
 * first half of its life stays quiet and the last quarter gets risky).
 */
export function suppressedNoise(weapon, durability) {
  const wear = 1 - clamp01(durability);
  return lerp(weapon.noiseSuppressed, weapon.noise * 0.6, wear * wear);
}

/** Noise radius for a shot given the suppressor state (null/0 = loud). */
export function shotNoise(weapon, suppressorDurability) {
  if (suppressorDurability == null || suppressorDurability <= 0) return weapon.noise;
  return suppressedNoise(weapon, suppressorDurability);
}

/**
 * A fresh suppressor bleeds a little muzzle energy (−10% damage); that penalty
 * fades as the baffles wear out, so damage rises along with noise.
 */
export function suppressedDamageMult(durability) {
  return lerp(1.0, 0.9, clamp01(durability));
}

/** Damage multiplier from range falloff: 1 up to `start`, `min` beyond `end`. */
export function falloffMult(weapon, dist) {
  const [start, end, min] = weapon.falloff;
  if (dist <= start) return 1;
  if (dist >= end) return min;
  return lerp(1, min, (dist - start) / (end - start));
}

// ───────────────────────── lethal headshots ─────────────────────────
/**
 * THE HEADSHOT RULE. This is the only place it lives.
 *
 * A bullet (pistol, AKM, AK-74, SVD) or a thrown knife that hits the head zone
 * kills any soldier outright, whatever the weapon, range, suppressor wear or
 * soldier kind. Headshots must not depend on how the numbers happen to line
 * up: an AKM head hit used to do 38 × 2.6 = 98.8 against a rifleman's 100 HP,
 * and the pistol stopped killing past ~22 m.
 *
 * The one exception: a round that has already gone through thin wood
 * (`penetrated`) is slowed and deformed, so it keeps the normal damage maths
 * (it still gets the head multiplier, but may or may not kill).
 * Blasts and melee never carry a head zone, so they are not affected.
 */
export const LETHAL = Infinity;
export function isLethalHit(zone, penetrated = false) { return zone === 'head' && !penetrated; }

/**
 * Final damage for a hit. zone: 'head' | 'body' | 'limb'.
 * Returns LETHAL for a head hit (see the headshot rule above).
 */
export function hitDamage(weapon, dist, zone, suppressorDurability, penetrated) {
  if (isLethalHit(zone, penetrated)) return LETHAL;
  let d = weapon.damage * falloffMult(weapon, dist);
  if (zone === 'head') d *= weapon.headMult;
  else if (zone === 'limb') d *= weapon.limbMult;
  if (suppressorDurability != null && suppressorDurability > 0) d *= suppressedDamageMult(suppressorDurability);
  if (penetrated) d *= weapon.penetration;
  return d;
}

/** Thrown-knife damage by zone: LETHAL to the head (headshot rule above), 60% to a limb. */
export function thrownKnifeDamage(damage, zone) {
  if (isLethalHit(zone)) return LETHAL;
  return zone === 'limb' ? damage * 0.6 : damage;
}

// ───────────────────────── soldier hit zones ─────────────────────────
/**
 * Soldier-local point → world. A soldier mesh stands on its feet at (px,py,pz)
 * and is turned by mesh.rotation.y = yaw (ai.js sets exactly that every frame).
 * Three.js turns +yaw counter-clockwise seen from above; the model faces −Z at
 * yaw 0, so forward = (−sin yaw, 0, −cos yaw) and right = (cos yaw, 0, −sin yaw):
 *   world = feet + Ry(yaw)·local,  x' = x·cos + z·sin,  z' = −x·sin + z·cos
 * `out` may be the same object as `l`.
 */
export function soldierToWorld(px, py, pz, yaw, l, out) {
  const c = Math.cos(yaw), s = Math.sin(yaw), lx = l.x, ly = l.y, lz = l.z;
  out.x = px + lx * c + lz * s;
  out.y = py + ly;
  out.z = pz - lx * s + lz * c;
  return out;
}

/**
 * Centre of the head in the soldier's local frame (feet at the origin, facing
 * −Z, before yaw) for his current pose. Uses rig.headLocal(out) when the rig
 * provides it (it follows lean, crouch, aim, flinch and death, and is valid
 * right after rig.update), otherwise the upright column (0, headHeight, 0).
 */
export function soldierHeadLocal(rig, out) {
  if (typeof rig.headLocal === 'function') rig.headLocal(out);
  else { out.x = 0; out.y = rig.headHeight(); out.z = 0; }
  return out;
}

/** World-space head centre of a soldier { x, y, z, yaw, rig }. */
export function soldierHeadWorld(e, out) {
  return soldierToWorld(e.x, e.y, e.z, e.yaw, soldierHeadLocal(e.rig, out), out);
}

const _hd = { x: 0, y: 0, z: 0 };
/**
 * One ray against one soldier's hit zones. Pure geometry: ai.rayHit runs it for
 * every living soldier and keeps the nearest.
 *   ray   origin (ox,oy,oz), unit direction (dx,dy,dz); only hits nearer than maxDist count
 *   e     { x, y, z (feet), yaw, rig }
 *   dims  config AI: headRadius, bodyRadius, bodyTopGap, neckBand, kneeFrac
 * Returns the distance along the ray and sets out.zone ('head' | 'body' | 'limb'),
 * or returns -1 for a miss.
 *
 * Zones
 *   head  sphere of headRadius around the ANIMATED head centre (soldierHeadWorld).
 *   body  cylinder of bodyRadius standing on the feet, from 2 cm up to
 *         bodyTopGap below the head centre. Its axis leans from the feet
 *         towards the head (a sheared cylinder), so the torso follows a lean or
 *         a crouch; with the upright fallback head it is the old vertical
 *         column. Its top is closed, so a steep shot from a roof that drops
 *         onto the shoulders is a body hit (with the old open top it went
 *         straight through him).
 *   limb  a body hit below kneeFrac × head height (the legs). The line scales
 *         with the head height, so it drops when he crouches.
 *
 * Priority (head first). The cylinder is deliberately fat (it covers the arms)
 * and wider than the head, so a ray through the lower half of the head, from
 * level or from below, usually grazes the cylinder's skin a little earlier, in
 * the empty air in front of or beside the shoulders. Nearest-entry-wins scored
 * those clear headshots as body hits. Rule: a ray that goes through the head
 * sphere is a head hit, even if it touched the cylinder first, as long as that
 * first touch is in the neck-and-shoulder band (no more than neckBand below
 * the head centre). A ray whose first touch is lower than that really struck
 * the chest first, on a steep path up from below, and stays a body hit.
 * Shots from above always meet the head before the body, so they need no rule.
 */
export function rayVsSoldier(ox, oy, oz, dx, dy, dz, maxDist, e, out, dims) {
  // cheap reject before asking the rig for its head: no part of a standing,
  // crouched or leaning soldier is more than 2.5 m from a point 1 m above his feet
  const bx = e.x - ox, by = e.y + 1 - oy, bz = e.z - oz;
  const bt = bx * dx + by * dy + bz * dz;
  if (bt < -2.5 || bt > maxDist + 2.5 || bx * bx + by * by + bz * bz - bt * bt > 6.25) return -1;

  const h = soldierHeadWorld(e, _hd);
  const hh = h.y - e.y;                          // head centre height above the feet

  // head sphere: entry distance
  let th = -1;
  const cx = h.x - ox, cy = h.y - oy, cz = h.z - oz;
  const tca = cx * dx + cy * dy + cz * dz;
  const d2 = cx * cx + cy * cy + cz * cz - tca * tca, r2 = dims.headRadius * dims.headRadius;
  if (d2 < r2) { const t = tca - Math.sqrt(r2 - d2); if (t > 0 && t < maxDist) th = t; }

  // body cylinder: entry through the side wall, else through the top cap.
  // The axis at height y above the feet is offset by (kx, kz)·y, so the ray's
  // horizontal offset from it, (fx + gx·t, fz + gz·t), is still linear in t.
  let tb = -1;
  const top = hh - dims.bodyTopGap, R2 = dims.bodyRadius * dims.bodyRadius;
  const kx = hh > 0.5 ? (h.x - e.x) / hh : 0, kz = hh > 0.5 ? (h.z - e.z) / hh : 0;
  const fx = ox - e.x - kx * (oy - e.y), fz = oz - e.z - kz * (oy - e.y);
  const gx = dx - kx * dy, gz = dz - kz * dy, a = gx * gx + gz * gz;
  if (a > 1e-8) {
    const b = fx * gx + fz * gz, c = fx * fx + fz * fz - R2, disc = b * b - a * c;
    if (disc > 0) {
      const t = (-b - Math.sqrt(disc)) / a, y = oy + dy * t - e.y;
      if (t > 0 && t < maxDist && y > 0.02 && y < top) tb = t;
    }
  }
  if (tb < 0 && dy < -1e-6 && oy - e.y > top) {
    const t = (e.y + top - oy) / dy, px = fx + gx * t, pz = fz + gz * t;
    if (t > 0 && t < maxDist && px * px + pz * pz < R2) tb = t;
  }

  if (th > 0 && (tb < 0 || th <= tb || oy + dy * tb >= h.y - dims.neckBand)) { out.zone = 'head'; return th; }
  if (tb > 0) { out.zone = oy + dy * tb - e.y < dims.kneeFrac * hh ? 'limb' : 'body'; return tb; }
  return -1;
}

/**
 * Recoil kick for the n-th shot of a burst (0-based), in degrees
 * [pitchUp, yawRight]. Patterns are authored per weapon; once a burst runs past
 * the authored part, the last four entries loop so sustained fire keeps
 * weaving instead of climbing forever.
 */
export function recoilAt(weapon, shotIndex) {
  const p = weapon.recoil;
  if (shotIndex < p.length) return p[shotIndex];
  const tail = Math.min(4, p.length);
  return p[p.length - tail + ((shotIndex - p.length) % tail)];
}

/**
 * Advance a projectile by dt with gravity and a touch of drag.
 * p = { x,y,z, vx,vy,vz, t }. Mutates and returns p.
 * Semi-implicit Euler is plenty at 60 Hz for a 360 m/s round (6 m per step);
 * the caller raycasts the segment between the old and new position.
 */
export function stepProjectile(p, dt, gravity = 9.81, drag = 0.02) {
  const k = 1 - drag * dt;
  p.vx *= k; p.vz *= k;
  p.vy = p.vy * k - gravity * dt;
  p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
  p.t += dt;
  return p;
}

/** Closed-form drop (metres) after travelling `dist` at muzzle velocity v0. */
export function dropAt(v0, dist, gravity = 9.81) {
  const t = dist / v0;
  return 0.5 * gravity * t * t;
}

/** Flight time (seconds) to `dist`, ignoring drag. */
export function travelTime(v0, dist) { return dist / v0; }

/**
 * Explosion damage at a distance: full inside 25% of the radius, then linear
 * falloff to `minDamage` at the edge, 0 outside.
 */
export function blastDamage(dist, radius, damage, minDamage = 0) {
  if (dist >= radius) return 0;
  const inner = radius * 0.25;
  if (dist <= inner) return damage;
  return lerp(damage, minDamage, (dist - inner) / (radius - inner));
}
