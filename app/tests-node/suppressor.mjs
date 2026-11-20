/**
 * Unit tests for the suppressor rules: the SVD's short-lived can and which
 * suppressor fits which weapon. Imported by rules.mjs (npm run test:unit);
 * also runs on its own with  node --test tests-node/suppressor.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTY, WEAPONS } from '../public/js/config.js';
import { wearSuppressor, shotNoise, suppressedNoise, suppressedDamageMult, hitDamage, suppressorFits, SUPPRESSOR_TYPES, dropAt } from '../public/js/ballistics.js';
import { hears } from '../public/js/noise.js';
import { t, setLang } from '../public/js/loc.js';

/** Suppressed shots until the can breaks, on a difficulty. */
const lifeOf = (w, diff) => { let d = 1, n = 0; while (d > 0) { d = wearSuppressor(d, w.suppressorShots, DIFFICULTY[diff].wearMult); n++; } return n; };

test('the SVD suppressor lasts 8 shots on Normal, about 13 on Easy and 5 on Hard', () => {
  const s = WEAPONS.svd;
  assert.equal(s.suppressorShots, 8);
  assert.equal(lifeOf(s, 'normal'), 8);
  assert.ok(lifeOf(s, 'easy') >= 13 && lifeOf(s, 'easy') <= 14, `easy ${lifeOf(s, 'easy')}`);
  assert.equal(lifeOf(s, 'hard'), 5);
  // far less than the pistol's can, which keeps its 40
  assert.equal(lifeOf(WEAPONS.pistol, 'normal'), 40);
  for (const d of ['easy', 'normal', 'hard']) assert.ok(lifeOf(s, d) * 4 < lifeOf(WEAPONS.pistol, d), d);
});

test('SVD noise: 38 m fresh, rising as it wears, 150 m when it breaks', () => {
  const s = WEAPONS.svd;
  assert.equal(shotNoise(s, 1), 38);
  let prev = 0;
  for (let d = 1; d > 0; d = wearSuppressor(d, s.suppressorShots, 1)) {        // every shot of a can's life on Normal
    const r = shotNoise(s, d);
    assert.equal(r, suppressedNoise(s, d));
    assert.ok(r >= prev && r < s.noise * 0.6 + 1e-9, `durability ${d}: ${r} m`);
    prev = r;
  }
  assert.ok(shotNoise(s, 0.5) > 38 && shotNoise(s, 0.5) < shotNoise(s, 0.125));
  assert.equal(shotNoise(s, 0), 150);
  assert.equal(shotNoise(s, null), 150);
});

test('a guard 60 m away does not hear a fresh SVD can, but does hear a worn-out or broken one', () => {
  const s = WEAPONS.svd, at = (r) => ({ x: 0, y: 1.3, z: 0, radius: r });
  assert.equal(hears(at(shotNoise(s, 1)), 60, 1.6, 0, false), 0);
  assert.equal(hears(at(shotNoise(s, 1)), 0, 1.6, 30, false) > 0, true);          // 30 m: still heard
  assert.equal(hears(at(shotNoise(s, 0.125)), 60, 1.6, 0, false) > 0, true);      // last shot before it breaks
  assert.equal(hears(at(shotNoise(s, 0)), 60, 1.6, 0, false) > 0, true);
  assert.equal(hears(at(shotNoise(s, null)), 140, 1.6, 0, false) > 0, true);
});

test('the SVD keeps its ballistics and gets the usual suppressed damage rule', () => {
  const s = WEAPONS.svd;
  assert.equal(s.muzzleVel, 360); assert.equal(s.gravity, 9.81); assert.equal(s.hitscan, false);
  assert.ok(Math.abs(dropAt(s.muzzleVel, 120) - 0.5 * 9.81 * (120 / 360) ** 2) < 1e-12);
  assert.ok(Math.abs(hitDamage(s, 50, 'body', 1, false) - s.damage * suppressedDamageMult(1)) < 1e-9);
  assert.ok(hitDamage(s, 50, 'body', 0.2, false) > hitDamage(s, 50, 'body', 1, false));
  assert.equal(hitDamage(s, 50, 'body', null, false), s.damage);
});

test('each suppressor fits only its own weapons', () => {
  const fits = {
    suppressor: ['pistol'],
    akmsup: ['akm', 'ak74'],
    svdsup: ['svd'],
  };
  assert.deepEqual([...SUPPRESSOR_TYPES].sort(), Object.keys(fits).sort());
  for (const type of SUPPRESSOR_TYPES) for (const id of Object.keys(WEAPONS))
    assert.equal(suppressorFits(WEAPONS[id], type), fits[type].includes(id), `${type} on ${id}`);
  // every gun takes exactly one kind
  for (const id of Object.keys(WEAPONS)) assert.equal(SUPPRESSOR_TYPES.filter((k) => suppressorFits(WEAPONS[id], k)).length, 1, id);
  // a weapon without durability takes none, whatever it names
  assert.equal(suppressorFits({ suppressorShots: 0, supType: 'svdsup' }, 'svdsup'), false);
  assert.equal(suppressorFits(null, 'svdsup'), false);
  assert.equal(suppressorFits(WEAPONS.svd, 'bogus'), false);
});

test('the SVD suppressor has its name in both languages', () => {
  setLang('az'); assert.equal(t('i_svdsup'), 'SVD səsboğucusu');
  setLang('en'); assert.equal(t('i_svdsup'), 'SVD suppressor');
  setLang('az');
});
