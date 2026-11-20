/**
 * config.js — every tuning number in one place (data, not code).
 * Pure module: no imports, safe to load under Node for tests.
 */

// ─────────────────────────────── difficulty ──────────────────────────────
// Mirrors the difficulty table in the design brief, one field per row.
export const DIFFICULTY = {
  easy: {
    id: 'easy',
    detectMult: 0.6,            // enemy detection speed: slow
    accuracy: 0.5,              // enemy accuracy: low
    damageMult: 0.6,            // enemy damage: low
    regen: { cap: 60, rate: 4, delay: 6 }, // partial health regen
    pickupMult: 1.5,            // ammo & items: plentiful
    hud: { markers: true, arrows: true, minimap: true, tag: true }, // all aids on
    cpTier: 3,                  // checkpoints: frequent (tiers 1..3 active)
    wearMult: 0.6,              // suppressor wear: slow (~66 shots)
    searchTime: 16,             // search after alert: short
    flank: false,
    loseSight: 5,               // seconds without LOS before combat → searching
    reinforceMult: 0.7,
    grenadeChance: 0.12,
    scoreMult: 0.85,
  },
  normal: {
    id: 'normal',
    detectMult: 1.0,
    accuracy: 0.72,
    damageMult: 1.0,
    regen: null,                // no regen
    pickupMult: 1.0,
    hud: { markers: false, arrows: true, minimap: false, tag: true }, // arrows only
    cpTier: 2,
    wearMult: 1.0,              // ~40 shots
    searchTime: 28,
    flank: false,
    loseSight: 7,
    reinforceMult: 1.0,
    grenadeChance: 0.28,
    scoreMult: 1.0,
  },
  hard: {
    id: 'hard',
    detectMult: 1.6,
    accuracy: 0.9,
    damageMult: 1.45,
    regen: null,
    pickupMult: 0.6,            // scarce
    hud: { markers: false, arrows: false, minimap: false, tag: false }, // off
    cpTier: 1,                  // few checkpoints
    wearMult: 1.6,              // ~25 shots
    searchTime: 48,             // long, with flanking
    flank: true,
    loseSight: 10,
    reinforceMult: 1.3,
    grenadeChance: 0.42,
    scoreMult: 1.25,
  },
};

// ─────────────────────────────── player ──────────────────────────────────
export const PLAYER = {
  radius: 0.35,
  height: [1.8, 1.2, 0.55],        // stand, crouch, prone
  eye: [1.66, 1.05, 0.38],
  speed: { walk: 3.5, sprint: 6.1, crouch: 1.9, prone: 0.8 },
  adsSpeedMult: 0.6,
  dragSpeedMult: 0.5,
  accel: 38, airAccel: 6, friction: 9,
  jumpVel: 4.7, gravity: 14,
  stepHeight: 0.5,
  maxHealth: 100,
  bleed: { light: 0.9, heavy: 2.6 },   // hp per second
  lowHealth: 30,
  leanAngle: 0.26, leanOffset: 0.42,
  breathMax: 5.5, breathRecover: 0.6,
  interactRange: 2.2,
  takedownRange: 1.9, takedownArc: 1.15,  // radians behind the target
  ladderSpeed: 2.2,
};

// ─────────────────────────────── noise radii (metres) ────────────────────
// Every audible action emits a noise event with one of these radii. Enemies
// inside the radius (reduced when a wall is in the way) react to it.
export const NOISE = {
  step: {                              // per surface, standing walk
    grass: 5, dirt: 6, mud: 6, stone: 9, wood: 11, metal: 12, rock: 8, water: 10,
  },
  stanceMult: [1.0, 0.35, 0.12],       // stand, crouch, prone
  sprintMult: 2.1,
  stillRadius: 0,
  bodyFall: 9,
  door: 8,
  stoneImpact: 16,
  knifeImpact: 5,
  bulletImpact: 8,                     // a round snapping into a wall nearby
  takedown: 2.5,
  melee: 6,
  land: 7,
  explosion: 120,
  flashbang: 70,
  smokePop: 14,
  c4: 150,
  enemyShot: 70,
  occlusionMult: 0.6,                  // radius multiplier when no line of sight
};

// ─────────────────────────────── weapons ─────────────────────────────────
// recoil: per-shot [pitchUp, yawRight] in degrees; pattern repeats its tail.
export const WEAPONS = {
  pistol: {
    id: 'pistol', slot: 'pistol', nameKey: 'w_pistol',
    mag: 12, reserveStart: 48, reserveMax: 96, ammo: 'p9',
    damage: 38, headMult: 3.0, limbMult: 0.8,   // headMult only applies through thin wood: a clean head hit always kills (ballistics.isLethalHit)
    rpm: 420, auto: false, modes: ['semi'],
    falloff: [22, 55, 0.55],           // start, end, min multiplier
    spreadHip: 1.3, spreadAds: 0.22, spreadMove: 0.9,
    recoil: [[1.5, 0.2], [1.6, -0.3], [1.7, 0.35], [1.6, -0.2]],
    recoilRecover: 9,
    reload: { tactical: 1.55, empty: 2.05 },
    adsFov: 60, adsTime: 0.16,
    noise: 62, noiseSuppressed: 6.5,
    suppressorShots: 40,               // durability in shots on Normal
    supType: 'suppressor',             // the pickup that fits it (ballistics.suppressorFits)
    penetration: 0.6,                  // damage kept through thin wood
    hitscan: true, tracer: false,
  },
  akm: {
    id: 'akm', slot: 'primary', nameKey: 'w_akm',
    mag: 30, reserveStart: 90, reserveMax: 210, ammo: 'r762',
    damage: 38, headMult: 2.6, limbMult: 0.8,
    rpm: 600, auto: true, modes: ['auto', 'semi'],
    falloff: [45, 110, 0.6],
    spreadHip: 2.4, spreadAds: 0.3, spreadMove: 1.4,
    // climbs hard for the first rounds, then walks left/right — the classic AK "7"
    recoil: [[1.1, 0.1], [1.3, 0.15], [1.4, -0.1], [1.3, 0.3], [1.1, 0.5], [0.9, 0.6],
             [0.7, 0.4], [0.6, -0.3], [0.6, -0.6], [0.5, -0.7], [0.5, -0.4], [0.5, 0.3],
             [0.5, 0.6], [0.45, 0.5], [0.45, -0.4], [0.45, -0.6]],
    recoilRecover: 7,
    reload: { tactical: 2.35, empty: 2.95 },
    adsFov: 52, adsTime: 0.22,
    noise: 95, noiseSuppressed: 20,
    suppressorShots: 60, supType: 'akmsup',
    penetration: 0.7,
    hitscan: true, tracer: true,
  },
  ak74: {
    id: 'ak74', slot: 'primary', nameKey: 'w_ak74',
    mag: 30, reserveStart: 60, reserveMax: 210, ammo: 'r545',
    damage: 31, headMult: 2.6, limbMult: 0.8,
    rpm: 650, auto: true, modes: ['auto', 'semi'],
    falloff: [50, 120, 0.6],
    spreadHip: 2.2, spreadAds: 0.26, spreadMove: 1.3,
    recoil: [[0.8, 0.1], [0.9, 0.1], [1.0, -0.1], [0.9, 0.2], [0.8, 0.35], [0.6, 0.4],
             [0.5, 0.2], [0.45, -0.25], [0.45, -0.4], [0.4, -0.45], [0.4, 0.2], [0.4, 0.4]],
    recoilRecover: 8,
    reload: { tactical: 2.3, empty: 2.9 },
    adsFov: 52, adsTime: 0.2,
    noise: 90, noiseSuppressed: 20,
    suppressorShots: 60, supType: 'akmsup',   // the AKM can threads onto the AK-74 too
    penetration: 0.6,
    hitscan: true, tracer: true,
  },
  svd: {
    id: 'svd', slot: 'primary', nameKey: 'w_svd',
    mag: 10, reserveStart: 20, reserveMax: 50, ammo: 'r54',
    damage: 115, headMult: 2.5, limbMult: 0.75,
    rpm: 75, auto: false, modes: ['semi'],
    falloff: [200, 400, 0.8],
    spreadHip: 4.5, spreadAds: 0.02, spreadMove: 3.0,
    recoil: [[3.4, 0.5], [3.6, -0.6]],
    recoilRecover: 4.5,
    reload: { tactical: 2.9, empty: 3.5 },
    adsFov: 18, zoomFovs: [18, 9, 5], adsTime: 0.3, scope: true,
    noise: 150, noiseSuppressed: 38,    // a fresh can still lets the supersonic crack through
    suppressorShots: 8, supType: 'svdsup',   // short-lived: ~13 shots on Easy, 5 on Hard
    penetration: 0.8,
    hitscan: false,                    // real projectile: drop + travel time
    muzzleVel: 360,                    // m/s, lowered from real 830 so drop and
    gravity: 9.81,                     // travel time are readable at 60–150 m
    sway: 0.9, swayHeld: 0.12,         // degrees of scope sway, normal / breath held
    tracer: true,
  },
};

export const KNIFE = { damage: 70, range: 1.9, cooldown: 0.55, takedownTime: 1.25 };

// ─────────────────────────────── equipment ───────────────────────────────
export const THROW = {
  speed: 15, upBias: 0.18, gravity: 12, bounce: 0.35, friction: 0.6,
  frag: { fuse: 3.6, radius: 8.5, damage: 260, minDamage: 15 },
  smoke: { fuse: 1.6, radius: 5.5, duration: 20, grow: 2.2 },
  flash: { fuse: 1.7, radius: 12, stun: 5.5, playerRadius: 9 },
  stone: { },
  tknife: { speed: 21, damage: 140, gravity: 9 },
  c4: { radius: 8.5, damage: 400, placeRange: 2.6 },
  enemyFrag: { fuse: 2.8, radius: 6.5, damage: 70 },
};

export const ITEMS = {
  medkit: { time: 4.0, heal: 65 },
  bandage: { time: 2.0, heal: 14 },
  tourniquet: { time: 1.6 },
  plate: { time: 3.0, armor: 100 },
  repair: { time: 2.2, restore: 0.6 },
  nvg: { drain: 0.7, max: 100 },        // % per second
  // fov: field of view at the first zoom step; zoom: fov per mouse-wheel step, mag: the magnification
  // printed for each step; tagTime: how long a tag lasts; range / cone: what can be tagged;
  // dwell: seconds an enemy must stay in the cone to be tagged; finder: rangefinder reach (m);
  // raise: seconds to bring the binoculars up to the eyes
  binoculars: { fov: 11, zoom: [11, 6.6], mag: [6, 10], tagTime: 22, range: 140, cone: 0.07, dwell: 0.8, finder: 900, raise: 0.32 },
  armorAbsorb: 0.6,                     // share of damage a plate soaks
};

/** Starting loadout (scaled by difficulty pickupMult where noted in game.js). */
export const LOADOUT = {
  weapons: ['pistol', 'akm'],
  suppressors: 1, repair: 0,
  frag: 2, smoke: 1, flash: 1, stone: 5, tknife: 3, c4: 1,
  medkit: 1, bandage: 3, tourniquet: 1, plate: 0,
  armor: 60,
};

// ─────────────────────────────── stealth ─────────────────────────────────
export const STEALTH = {
  baseRange: 46,              // metres an enemy can see a lit, standing target in clear air
  minRange: 7,
  closeRange: 3.2,            // inside this, detection is near-instant
  fovCentral: 34 * Math.PI / 180,   // half-angle of full-acuity cone
  fovEdge: 80 * Math.PI / 180,      // half-angle of peripheral vision limit
  fovVertical: 55 * Math.PI / 180,
  baseRate: 1.25,             // meter units per second at point-blank, fully visible
  decay: 0.22,                // meter loss per second without sight
  suspiciousAt: 0.34,         // meter threshold: white → yellow, go investigate
  redAt: 0.7,                 // icon colour only
  spottedAt: 1.0,             // combat
  stance: [1.0, 0.58, 0.28],  // stand, crouch, prone
  moveStill: 0.7, moveWalk: 1.0, moveSprint: 1.55,
  lightMin: 0.3, lightMax: 1.35,    // factor at light level 0 and 1
  foliage: 0.38, foliageLow: 0.2,   // standing in a bush / crouched-prone in a bush
  alertMult: 1.6,             // already suspicious/searching enemies notice faster
  combatMult: 4.0,            // re-acquire speed in combat
  bodySeeRange: 17,
  tagFlash: 0.0,
};

// ─────────────────────────────── AI ──────────────────────────────────────
export const AI = {
  hp: { rifle: 100, sniper: 90, officer: 130 },
  walkSpeed: 1.5, searchSpeed: 2.5, runSpeed: 4.4,
  turnRate: 5.5,
  thinkHz: 10,
  suspiciousLook: 4.5,        // seconds spent looking around an investigated spot
  suspiciousMax: 14,
  callRadius: 34,             // teammates alerted by a shout
  backupRadius: 55,
  checkinPeriod: 55,          // seconds between radio check-ins
  checkinGrace: 6,
  burst: [3, 6], burstPause: [0.5, 1.3], shotInterval: 0.11,
  aimTime: 0.55,              // seconds between seeing and first shot
  weaponDamage: { rifle: 15, sniper: 46, officer: 13 },
  weaponRange: { rifle: 75, sniper: 160, officer: 45 },
  accuracyFalloff: 70,        // metres at which hit chance halves
  grenadeCooldown: 14, grenadeRange: [8, 26],
  coverSearchRadius: 14,
  flankDistance: 16,
  suppressTime: 3.0,
  reinforceDelay: 22,
  stunSee: 0,                 // stunned enemies see nothing
  // hit zones (geometry in ballistics.rayVsSoldier; a head hit is lethal, see ballistics.isLethalHit)
  bodyRadius: 0.3,
  headRadius: 0.165,          // the head + helmet fits 0.15; a little generous so a clear head hit never misses
  bodyTopGap: 0.1,            // body cylinder ends this far below the head centre
  neckBand: 0.3,              // a ray that touches the body no lower than this below the head centre and then goes through the head is a head hit
  kneeFrac: 0.55 / 1.6,       // body hits below this share of the head height are limb hits (0.55 m standing)
  eyeHeight: 1.62,
  dropAmmoChance: 0.75,
  // movement on the path (locomotion.js). walkSpeed / searchSpeed / runSpeed above stay the top speeds.
  loco: {
    walkRef: 1.5, runRef: 4.4,          // the speeds the walk and run numbers below belong to
    accWalk: 3.6, kAccWalk: 8,          // m/s², 1/s: a walk start takes ~0.5 s
    accRun: 4.2, kAccRun: 3.2,          // a run start ~1.3 s
    decWalk: 3.2, kDecWalk: 9,          // a walk stops in ~0.5 s
    decRun: 5.5, kDecRun: 4,            // a hard stop from a run ~0.8 s, 1.8 m
    brakePlan: 0.6,                     // share of the peak braking used to plan stops and corners
    latAcc: 5.5,                        // m/s² sideways grip: turning radius = v² / latAcc
    turnCap: 7, kTurn: 8,               // rad/s heading change near a standstill; how briskly the heading follows
    look0: 0.55, lookK: 0.38,           // m: carrot ahead on the path = look0 + lookK · speed (rounds corners)
    lookEyes: 2.2,                      // m: the eyes look this much further along the path than the carrot
    corridor: 0.28,                     // m: half width the rounded chord must keep clear on the nav grid
    passR: 0.45, arriveR: 0.35,         // m: corner waypoints count as passed (+0.15 per m/s); the goal (as before)
    creep: 0.3, cornerMin: 0.45,        // m/s: slowest approach to the goal / round the sharpest corner
    pace: [0.93, 1.0],                  // each soldier's share of the state's top speed
    strafeSpeed: 3.4, backSpeed: 2.4,   // m/s caps when moving while facing elsewhere (combat)
    pushMax: 3,                         // m/s: fastest the separation push between soldiers shoves
    stallTime: 1.0, directTime: 1.2,    // s nearly still: then this long straight at the next point, as before
    stuckTime: 2.5,                     // s without 0.25 m of progress: re-path, then skip, then give up
  },
};

// ─────────────────────────────── scoring ─────────────────────────────────
export const SCORE = {
  base: 5000, kill: 40, headshot: 60, stealthKill: 80,
  accuracy: 1500, timePar: 2400, timeBonusMax: 1500,
  spotted: -200, death: -300,
  ranks: [['S', 10500], ['A', 8500], ['B', 6500], ['C', -Infinity]],
};

/**
 * End-of-mission score. The same formula is duplicated (by necessity — that
 * file may not import) in app/src/logic.js; tests/score.test.js keeps the two
 * in step.
 */
export function computeScore(stats, difficultyId) {
  const d = DIFFICULTY[difficultyId] || DIFFICULTY.normal;
  const shots = Math.max(0, stats.shots | 0), hits = Math.min(shots, Math.max(0, stats.hits | 0));
  const acc = shots > 0 ? hits / shots : 0;
  const timeBonus = Math.min(SCORE.timeBonusMax, Math.max(0, SCORE.timePar - (stats.time | 0)));
  let s = SCORE.base
    + (stats.kills | 0) * SCORE.kill
    + (stats.headshots | 0) * SCORE.headshot
    + (stats.stealthKills | 0) * SCORE.stealthKill
    + Math.round(acc * SCORE.accuracy)
    + timeBonus
    + (stats.spotted | 0) * SCORE.spotted
    + (stats.deaths | 0) * SCORE.death;
  s = Math.max(0, Math.round(s * d.scoreMult));
  let rank = 'C';
  for (const [r, min] of SCORE.ranks) { if (s >= min) { rank = r; break; } }
  return { score: s, rank, accuracy: Math.round(acc * 100) };
}

// ─────────────────────────────── settings & binds ────────────────────────
export const DEFAULT_SETTINGS = {
  lang: 'az',
  sensitivity: 1.0,
  fov: 75,
  invertY: false,
  volMaster: 0.8, volMusic: 0.6, volSfx: 0.9,
  quality: 'high',
  motionBlur: false,
  killCam: true,
  subtitles: true,
  binds: null,
};

/** action → default physical key code (KeyboardEvent.code) or MouseN. */
export const DEFAULT_BINDS = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  jump: 'Space', sprint: 'ShiftLeft', crouch: 'KeyC', prone: 'KeyZ',
  leanL: 'KeyQ', leanR: 'KeyE',
  fire: 'Mouse0', aim: 'Mouse2', reload: 'KeyR',
  weapon1: 'Digit1', weapon2: 'Digit2', weapon3: 'Digit3',
  suppressor: 'KeyX', fireMode: 'KeyB',
  interact: 'KeyF', melee: 'KeyV',
  throw: 'KeyG', cycleThrow: 'Digit4',
  c4: 'KeyT', medkit: 'KeyH', bandage: 'KeyJ', nvg: 'KeyN',
  wheel: 'Tab', map: 'KeyM', pause: 'Escape',
};
export const ACTIONS = Object.keys(DEFAULT_BINDS);

/** Order of throwables for the cycle key. */
export const THROWABLES = ['frag', 'smoke', 'flash', 'stone', 'tknife'];

/** Radial wheel entries, clockwise from the top. */
export const WHEEL = ['frag', 'smoke', 'flash', 'stone', 'tknife', 'c4', 'medkit', 'bandage',
  'tourniquet', 'plate', 'repair', 'binoculars', 'nvg'];

// ─────────────────────────────── vehicles and artillery ──────────────────
// The patrolling tank, the towed howitzers, the mortar pit and the parked
// armoured vehicle (vehicles.js runs them, vehicle-rules.js holds the pure
// rules). Detection speed and damage also follow DIFFICULTY's multipliers.
export const VEHICLES = {
  tank: {
    // body (local frame: origin on the ground at the hull centre, forward = −z)
    hw: 1.78, hlF: 3.45, hlR: 3.8,          // half width (skirts), front / rear half length (rear includes the fuel drums)
    hullTop: 1.45, turretTop: 2.15, turretR: 1.2, turretZ: 0.15, eyeY: 2.45,
    // driving
    speed: 3.0,                             // m/s cruising speed on the route
    accel: 0.9, decel: 1.8,                 // m/s²
    turnRate: 0.42,                         // rad/s heading change while rolling
    pivotRate: 0.5,                         // rad/s neutral-steer turn on the spot
    pivotAt: 0.5,                           // rad heading error above which it stops and pivots
    arrive: 1.2,                            // m: waypoint reached
    respawnClear: 25,                       // m: a restored tank starts at least this far from the player
    // turret
    sweepRate: 0.16,                        // rad/s while patrolling (slow scan)
    sweepArc: 1.5,                          // rad either side of the scan centre
    sweepPeriod: 26,                        // s for one full sweep
    trackRate: 0.55,                        // rad/s when alerted
    elevMin: -0.1, elevMax: 0.32,           // rad gun depression / elevation
    // perception (same model as the soldiers, see stealth.js, slower build-up)
    hullArc: 60 * Math.PI / 180,            // driver's forward arc, half angle
    turretArc: 38 * Math.PI / 180,          // gunner's sight arc around the turret direction
    rearBlind: 35 * Math.PI / 180,          // never seen directly behind
    nearSide: 2.2, nearRear: 2.5,           // m: dead ground beside and behind the hull
    detectMult: 0.5,                        // × soldier detection speed
    rangeMult: 1.1,                         // optics: a little further than a soldier
    thinkHz: 5,
    alertLook: 7,                           // s looking at a glimpse before it drives on
    linkRadius: 45,                         // m: soldiers in combat this close alert the tank
    // coaxial machine gun
    mg: { burst: [6, 10], interval: 0.085, pause: [0.9, 1.7], damage: 11, accuracy: 0.62, aimTime: 0.9, aimTol: 0.08, range: 75, suppress: 3.5 },
    // main gun: only at a player who has hidden in hard cover for a while
    gun: { coverTime: 3.5, memory: 14, tell: 1.4, cooldown: 13, radius: 6, damage: 85, coverMult: 0.6, minRange: 9, maxRange: 95, shake: 1 },
    // being run over
    crush: { contactDps: 45, crushDps: 420, minSpeed: 0.6 },
    // engine noise: masks footsteps for soldiers near the tank
    engine: { idleRadius: 24, moveRadius: 42, maskMargin: 0.1 },
    exhaust: { idle: 0.28, moving: 0.14 },
  },
  // which part of the tank a charge sits on (tank-local metres, see vehicle-rules.chargeZone)
  charge: { deckZ: 0.95, deckY: 1.3, rearZ: 3.25, turretY: 1.5 },
  artillery: {
    period: [24, 36],                       // s between rounds of one howitzer
    mortarPeriod: [15, 22],
    destroyRadius: 3.8,                     // m: a C4 charge this close destroys the gun
    coverTime: 1.8,                         // s a report covers the player's shots
    coverNear: 10,                          // m: soldiers this close to the shooter still hear him
    coverRadius: 140,                       // m around the battery
    crewRadius: 12,                         // m: with no living soldier this close the gun stops firing
    safeCone: 0.45,                         // rad: never fires with the player in front of the muzzle
    safeRange: 70,
    cookoff: [0.7, 1.4, 2.3, 3.4],          // s after destruction: secondary bangs from the ammunition crates
    cookRadius: 3.2, cookDamage: 45,
  },
  apc: { destroyRadius: 3.6 },
  wreck: { fireI: 0.95, fireR: 10, burnTime: 150 },
};
