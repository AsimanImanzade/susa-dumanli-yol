/**
 * interact.js — the F key: silent takedowns, dragging and hiding bodies,
 * ladders, pickups and weapon swaps, the flag, and act exits. Each step it
 * works out the single most relevant action and exposes it as a HUD prompt.
 */
import { G, bus, dist2D } from './ctx.js';
import { PLAYER, WEAPONS } from './config.js';
import { input } from './input.js';
import { audio } from './audio.js';
import { ai } from './ai.js';
import { buildPickup } from './models.js';
import { t, keyLabel } from './loc.js';

const ITEM_KEY = { ammo: 'i_ammo', suppressor: 'i_suppressor', akmsup: 'i_akmsup', svdsup: 'i_svdsup', battery: 'i_battery', weapon_svd: 'w_svd', weapon_akm: 'w_akm', weapon_ak74: 'w_ak74' };
const SUPS = { suppressor: 1, akmsup: 1, svdsup: 1 };
const itemName = (type) => t(ITEM_KEY[type] || 'i_' + type);

export const interact = {
  prompt: '', progress: 0, flagHold: 0,

  /** Add a pickup to the running level (enemy drops, recovered knives, swapped weapons). */
  spawnPickup(type, x, z, y, extra) {
    const lv = G.level;
    const p = { type, x, z, y: y ?? lv.world.groundHeight(x, z, G.player.y + 1, 2, null), amount: 1, taken: false, id: lv.pickups.length, ...extra };
    p.mesh = buildPickup(type, { sup: p.sup != null && p.sup > 0 });   // a dropped gun shows the can still on it
    p.mesh.position.set(p.x, p.y, p.z);
    lv.group.add(p.mesh);
    lv.pickups.push(p);
    return p;
  },

  _take(p) {
    const w = G.weapons, e = G.equip;
    if (p.type.startsWith('weapon_')) {
      const id = p.type.slice(7);
      const res = w.pickupWeapon(id, p.mag, { sup: p.sup, supStored: p.supStored });
      if (res.dropped) { const d = res.dropped; this.spawnPickup('weapon_' + d.id, G.player.x, G.player.z, undefined, { mag: d.mag, sup: d.sup, supStored: d.supStored }); }
      if (id === 'svd') bus.emit('gotSvd');
    } else if (p.type === 'ammo') w.addAmmo(p.amount);
    else if (SUPS[p.type]) w.addSuppressor(p.type, p.amount);
    else e.add(p.type, p.amount, true);
    p.taken = true; p.mesh.visible = false;
    audio.play('pickup', { vol: 0.6 });
    bus.emit('toast', t('picked', { item: itemName(p.type) + (p.amount > 1 ? ' ×' + p.amount : '') }));
  },

  update(dt) {
    const p = G.player, lv = G.level, w = G.weapons;
    this.prompt = ''; this.progress = 0;
    if (!lv || p.dead || p.frozen || w.takedown || lv.climb) return;
    const key = keyLabel(input.bindOf('interact'));
    const press = input.pressed('interact');
    const say = (k, extra) => { this.prompt = t(k, { key, ...extra }); };

    // carrying a body: drop it, or tip it into a dumpster
    if (p.dragging) {
      const b = p.dragging;
      const bin = lv.interact.find((it) => it.type === 'dumpster' && dist2D(p.x, p.z, it.x, it.z) < it.r);
      if (bin) { say('p_dump'); if (press) { ai.removeBody(b); p.dragging = null; audio.play('body', { vol: 0.5 }); bus.emit('toast', t('bodyHidden')); } }
      else { say('p_drop'); if (press) { p.dragging = null; if (ai.settleBody(b)) bus.emit('toast', t('bodyHidden')); audio.play('cloth', { vol: 0.5 }); } }
      return;
    }
    if (p.ladder) { say('p_ladderOff'); if (press) p.ladder = null; return; }

    const target = ai.takedownTarget();
    if (target) { say('p_takedown'); if (press) w.startTakedown(target); return; }

    for (const L of lv.ladders) {
      const atFoot = dist2D(p.x, p.z, L.x, L.z) < 1.25 && Math.abs(p.y - L.y0) < 1.2;
      const atTop = dist2D(p.x, p.z, L.tx, L.tz) < 1.4 && Math.abs(p.y - L.y1) < 1.0;
      if (!atFoot && !atTop) continue;
      say('p_ladder');
      if (press) { p.ladder = L; p.body.x = L.x; p.body.z = L.z; p.body.y = atTop ? L.y1 - 0.15 : Math.max(p.y, L.y0 + 0.05); p.stance = 0; audio.play('step_wood', { vol: 0.5 }); }
      return;
    }

    let best = null, bd = 1.8;
    for (const pk of lv.pickups) {
      if (pk.taken) continue;
      const d = dist2D(p.x, p.z, pk.x, pk.z);
      if (d < bd && Math.abs(pk.y - p.y) < 1.6) { bd = d; best = pk; }
    }
    if (best) {
      const isWeapon = best.type.startsWith('weapon_');
      const full = isWeapon && w.slots.p1 && w.slots.p2 && w.slots.p1.id !== best.type.slice(7) && w.slots.p2.id !== best.type.slice(7);
      say(full ? 'p_swap' : 'p_pickup', { item: itemName(best.type) });
      if (press) this._take(best);
      return;
    }

    const body = ai.nearestBody(p.x, p.z, 1.9);
    if (body && Math.abs(body.y - p.y) < 1.4) {
      say('p_drag');
      if (press) { body.dragged = true; body.hidden = false; p.dragging = body; if (p.stance === 2) p.stance = 1; audio.play('cloth', { vol: 0.6 }); }
      return;
    }

    // doors: open / shut the one in front of you (crouched: quietly)
    const door = lv.doorSys && lv.doorSys.nearest(p.x, p.y, p.z, p.yaw);
    if (door) {
      say(door.target ? 'p_doorClose' : 'p_doorOpen');
      if (press) lv.doorSys.toggle(door, 'player', p.stance);
      return;
    }

    for (const it of lv.interact) {
      if (it.type !== 'flag' || !G.mission.flagReady || G.mission.flagRaised) continue;
      if (dist2D(p.x, p.z, it.x, it.z) > it.r) continue;
      say('p_flag');
      if (input.down('interact')) { this.flagHold += dt; this.progress = this.flagHold / 2.4; if (this.flagHold >= 2.4) { this.flagHold = 0; bus.emit('flagRaise'); } }
      else this.flagHold = 0;
      return;
    }
    this.flagHold = 0;

    const ex = lv.exit;
    if (ex && (!ex.locked) && dist2D(p.x, p.z, ex.x, ex.z) < ex.r) {
      say(ex.kind === 'climb' ? 'p_climb' : 'p_next');
      if (press) bus.emit('exit');
    }
  },
};

bus.on('spawnPickup', (type, x, z, y) => { if (G.level) interact.spawnPickup(type, x, z, y); });
bus.on('drop', (e) => {
  if (!G.level) return;
  // most soldiers leave a magazine or two; some leave the rifle itself
  if (G.rng() < 0.22) interact.spawnPickup('weapon_ak74', e.x + 0.5, e.z + 0.3, e.y, { mag: 10 + Math.floor(G.rng() * 20) });
  else interact.spawnPickup('ammo', e.x + 0.4, e.z + 0.3, e.y);
});
void PLAYER; void WEAPONS;
