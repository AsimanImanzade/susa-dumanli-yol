/**
 * equipment.js — everything that is not a gun: throwables (frag, smoke,
 * flashbang, stones, throwing knives), C4, medical items, armor plates,
 * suppressor repair, night vision, binoculars and the radial wheel.
 */
import * as THREE from 'three';
import { G, bus, clamp, clamp01, damp, dist2D } from './ctx.js';
import { THROW, ITEMS, NOISE, LOADOUT, THROWABLES, WHEEL, PLAYER } from './config.js';
import { blastDamage, thrownKnifeDamage } from './ballistics.js';
import { F } from './physics.js';
import { input } from './input.js';
import { noise } from './noise.js';
import { audio } from './audio.js';
import { fx } from './fx.js';
import { ai } from './ai.js';
import { R } from './render.js';
import { buildItem } from './models.js';
import { t } from './loc.js';

const hit = {}, hitE = {};
const _wp = new THREE.Vector3();
const fwd = { x: 0, y: 0, z: 0 };
const _eye = { x: 0, y: 0, z: 0 };
const CONSUMABLE = { medkit: 1, bandage: 1, tourniquet: 1, plate: 1, repair: 1 };
const ARC_N = 32;

export const equip = {
  inv: {}, selected: 'frag', objs: [], smokes: [], c4s: [],
  nvg: { on: false, battery: 100 }, binoc: false, using: null, cook: null,
  wheelOpen: false, wheelX: 0, wheelY: 0, wheelSel: -1,
  arc: null,
  /** Cosmetic event counters for the first-person animations (vm-items.js); nothing in the game reads them. */
  anim: { use: 0, item: null, thrown: 0, placed: 0, det: 0 },

  init() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_N * 3), 3));
    this.arc = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffb648, transparent: true, opacity: 0.7, depthTest: false, fog: false }));
    this.arc.frustumCulled = false; this.arc.visible = false;
    G.scene.add(this.arc);
  },

  reset() {
    this._clearWorld();
    this.inv = { frag: LOADOUT.frag, smoke: LOADOUT.smoke, flash: LOADOUT.flash, stone: LOADOUT.stone, tknife: LOADOUT.tknife, c4: LOADOUT.c4,
      medkit: LOADOUT.medkit, bandage: LOADOUT.bandage, tourniquet: LOADOUT.tourniquet, plate: LOADOUT.plate, repair: LOADOUT.repair };
    this.selected = 'frag';
    this.nvg = { on: false, battery: 100 }; this.binoc = false; this.using = null; this.cook = null;
    this.wheelOpen = false; this.wheelSel = -1; this.c4Hold = 0; this.c4Placed = false; this.tagT = 0; this.tagWarned = false;
    R.post.nv = 0;
  },
  _clearWorld() {
    for (const o of this.objs) G.scene.remove(o.mesh);
    for (const c of this.c4s) if (c.mesh.parent) c.mesh.parent.remove(c.mesh);   // a charge on a vehicle hangs off its model
    this.objs.length = 0; this.c4s.length = 0; this.smokes.length = 0;
    if (G.world) G.world.smokes.length = 0;
    if (this.arc) this.arc.visible = false;
  },

  add(item, n = 1, silent) {
    if (item === 'battery') { this.nvg.battery = 100; return; }
    this.inv[item] = (this.inv[item] || 0) + n;
    if (!silent) audio.play('pickup', { vol: 0.5 });
  },
  count(item) { return item === 'nvg' ? Math.round(this.nvg.battery) : item === 'binoculars' ? 1 : this.inv[item] || 0; },

  /** Damage interrupts whatever the player is applying; the item is not spent. */
  interrupt() { if (this.using) { this.using = null; } },

  /** Start using a consumable (H / J / wheel). */
  use(item) {
    const p = G.player, w = G.weapons;
    if (this.using || p.dead || p.frozen || p.ladder) return;
    if (!(this.inv[item] > 0)) { bus.emit('toast', t('no_item', { item: t('i_' + item) })); return; }
    if (item === 'medkit' && p.health >= PLAYER.maxHealth - 1 && !p.bleed) return bus.emit('toast', t('hpFull'));
    if (item === 'bandage' && !p.bleed && p.health >= PLAYER.maxHealth - 1) return bus.emit('toast', t('hpFull'));
    if (item === 'tourniquet' && p.bleed !== 2) return bus.emit('toast', t('noBleed'));
    if (item === 'plate' && p.armor >= ITEMS.plate.armor - 1) return bus.emit('toast', t('armorFull'));
    if (item === 'repair') { const i = w.inst(); if (i.sup === null && i.supStored === null) return bus.emit('toast', t('supNone')); }
    if (w.reloading) w.reloading = null;
    this.using = { item, t: 0, dur: ITEMS[item].time };
    audio.play('heal', { vol: 0.5 });
  },
  _finishUse() {
    const p = G.player, item = this.using.item;
    this.anim.use++; this.anim.item = item;
    this.inv[item]--;
    if (item === 'medkit') { p.health = Math.min(PLAYER.maxHealth, p.health + ITEMS.medkit.heal); p.bleed = 0; }
    else if (item === 'bandage') { p.health = Math.min(PLAYER.maxHealth, p.health + ITEMS.bandage.heal); if (p.bleed === 1) p.bleed = 0; }
    else if (item === 'tourniquet') { p.bleed = 1; }                    // heavy bleeding is brought down to light
    else if (item === 'plate') { p.armor = ITEMS.plate.armor; }
    else if (item === 'repair') { G.weapons.repair(ITEMS.repair.restore); }
    this.using = null;
    audio.play('pickup', { vol: 0.4 });
  },

  toggleNvg() {
    if (!this.nvg.on && this.nvg.battery <= 0) return bus.emit('toast', t('nvgDead'));
    this.nvg.on = !this.nvg.on;
    audio.play('nvg', { vol: 0.5, rate: this.nvg.on ? 1 : 0.7 });
  },
  setBinoc(on) {
    if (on === this.binoc) return;
    this.binoc = on; audio.play('click', { vol: 0.6 });
    const p = G.player, B = ITEMS.binoculars;
    if (on) {
      this.zoomI = 0; this.binocRange = -1; this.tagT = 0;
      (this.tagProg ??= new Map()).clear();
      p.fovTarget = B.zoom ? B.zoom[0] : B.fov; p.sensMult = p.fovTarget / G.settings.fov;
    } else { p.fovTarget = G.settings.fov; p.sensMult = 1; if (this.tagProg) this.tagProg.clear(); }
  },
  /** Mouse wheel while looking through the binoculars: step between the zoom levels. */
  _binocZoom(dir) {
    const B = ITEMS.binoculars, steps = B.zoom || [B.fov];
    const z = clamp((this.zoomI || 0) + dir, 0, steps.length - 1);
    if (z === this.zoomI) return;
    this.zoomI = z; const p = G.player;
    p.fovTarget = steps[z]; p.sensMult = steps[z] / G.settings.fov;
    audio.play('click', { vol: 0.35, rate: 1.5, ui: true });
  },
  /** Binocular magnification shown in the view. */
  binocMag() { const B = ITEMS.binoculars; return B.mag ? B.mag[this.zoomI || 0] : Math.round(G.settings.fov / B.fov); },
  /** Tagging progress 0..1 per enemy currently held in the binoculars (for the HUD). */
  tagProgress() { return this.tagProg || null; },

  // ───────────────────────── simulation step ─────────────────────────
  update(dt) {
    const p = G.player, w = G.weapons;
    this._objects(dt);
    this._smoke(dt);
    if (p.dead) { this.wheelOpen = false; return; }

    // radial wheel: hold to open (time slows), move the mouse to pick, release to confirm
    const wantWheel = input.down('wheel') && !p.frozen;
    if (wantWheel && !this.wheelOpen) { this.wheelOpen = true; this.wheelX = this.wheelY = 0; this.wheelSel = -1; audio.ui('ui_move'); }
    else if (!wantWheel && this.wheelOpen) { this.wheelOpen = false; this._wheelPick(); }
    G.wheelSlow = this.wheelOpen;

    if (this.using) {
      this.using.t += dt;
      if (this.using.t >= this.using.dur) this._finishUse();
    }
    if (input.pressed('medkit')) this.use('medkit');
    if (input.pressed('bandage')) this.use(p.bleed === 2 && this.inv.tourniquet > 0 ? 'tourniquet' : 'bandage');
    if (input.pressed('nvg')) this.toggleNvg();
    if (input.pressed('cycleThrow')) {
      let i = THROWABLES.indexOf(this.selected);
      for (let k = 0; k < THROWABLES.length; k++) { i = (i + 1) % THROWABLES.length; if (this.inv[THROWABLES[i]] > 0) break; }
      this.selected = THROWABLES[i]; audio.play('click', { vol: 0.5 });
      bus.emit('toast', t('i_' + this.selected));
    }
    if (this.binoc && (input.pressed('fire') || input.pressed('aim') || p.sprinting)) this.setBinoc(false);

    // night vision battery
    if (this.nvg.on) {
      this.nvg.battery = Math.max(0, this.nvg.battery - ITEMS.nvg.drain * dt);
      if (this.nvg.battery <= 0) { this.nvg.on = false; bus.emit('toast', t('nvgDead')); audio.play('nvg', { vol: 0.4, rate: 0.6 }); }
    }

    // binoculars: zoom on the mouse wheel, a rangefinder under the centre mark, and tagging of
    // whoever is held in the view long enough (Easy / Normal)
    if (this.binoc) {
      const B = ITEMS.binoculars, POLL = 0.1;
      if (input.wheel) this._binocZoom(input.wheel < 0 ? 1 : -1);
      this.tagT -= dt;
      if (this.tagT <= 0) {
        this.tagT = POLL;
        p.forward(fwd);
        const cam = p.eyePos(_eye), bh = (this._bnHit ??= {}), bhe = (this._bnHitE ??= {}), lim = B.finder || 900;
        let r = G.world.raycast(cam.x, cam.y, cam.z, fwd.x, fwd.y, fwd.z, lim, F.BULLET, bh, null) ? bh.dist : -1;
        if (ai.rayHit(cam.x, cam.y, cam.z, fwd.x, fwd.y, fwd.z, r > 0 ? r : lim, bhe)) r = bhe.dist;
        this.binocRange = r;
        const prog = (this.tagProg ??= new Map()), stamp = (this._tagStamp = (this._tagStamp || 0) + 1), cosCone = Math.cos(B.cone);
        for (const e of G.enemies) {
          if (!e.alive) continue;
          const dx = e.x - cam.x, dy = e.y + 1.1 - cam.y, dz = e.z - cam.z, d = Math.hypot(dx, dy, dz);
          if (d > B.range || (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d < cosCone) continue;
          if (!G.world.los(cam.x, cam.y, cam.z, e.x, e.y + 1.2, e.z)) continue;
          if (!G.mission.diff.hud.tag) { if (!this.tagWarned) { this.tagWarned = true; bus.emit('toast', t('tagNA')); } break; }
          if (e.tagT > 0) { e.tagT = B.tagTime; continue; }          // already tagged: keep it fresh
          const c = prog.get(e) || { v: 0, s: 0 };
          c.v += POLL / (B.dwell || POLL); c.s = stamp; prog.set(e, c);
          if (c.v >= 1) {
            prog.delete(e); e.tagT = B.tagTime;
            bus.emit('toast', t('tagged')); bus.emit('binocTag', e);
            audio.play('click', { vol: 0.5, rate: 1.8, ui: true }); audio.play('beep', { vol: 0.3, ui: true });
          }
        }
        // out of the view or behind cover: the progress drains away
        for (const [e, c] of prog) if (c.s !== stamp && (c.v -= POLL * 2.5) <= 0 || !e.alive) prog.delete(e);
      }
    }

    // throwing: hold G to see the arc (frags cook while held), release to throw
    const canThrow = !w.busy() || this.cook;
    if (input.pressed('throw') && !this.cook && !w.busy() && !w.reloading) {
      if (this.inv[this.selected] > 0) { this.cook = { t: 0, kind: this.selected }; if (this.selected === 'frag') audio.play('pin', { vol: 0.7 }); }
      else bus.emit('toast', t('no_item', { item: t('i_' + this.selected) }));
    }
    if (this.cook) {
      this.cook.t += dt;
      const frag = this.cook.kind === 'frag';
      if (frag && this.cook.t >= THROW.frag.fuse) { this.inv.frag--; this._explode({ x: p.x, y: p.eyeY(), z: p.z, kind: 'frag' }); this.cook = null; }
      else if (!input.down('throw') && canThrow) { this._throw(this.cook.kind, frag ? THROW.frag.fuse - this.cook.t : undefined); this.cook = null; }
    }

    // C4: tap T on a surface to place, hold T to detonate
    if (input.pressed('c4') && !w.busy()) { this.c4Hold = 0; this.c4Placed = this._placeC4(); }
    if (input.down('c4') && !this.c4Placed && this.c4s.length) {
      this.c4Hold += dt;
      if (this.c4Hold >= 0.5) { this._detonate(); this.c4Hold = -99; }
    }
    if (input.released('c4')) { if (!this.c4Placed && this.c4Hold >= 0 && this.c4Hold < 0.5 && !this.c4s.length) bus.emit('toast', t(this.inv.c4 > 0 ? 'p_c4' : 'c4None', { key: 'T' })); this.c4Hold = 0; this.c4Placed = false; }
  },

  /** Mouse motion goes to the wheel instead of the camera while it is open. */
  wheelMove(dx, dy) {
    this.wheelX = clamp(this.wheelX + dx, -160, 160); this.wheelY = clamp(this.wheelY + dy, -160, 160);
    const len = Math.hypot(this.wheelX, this.wheelY);
    if (len < 28) { this.wheelSel = -1; return; }
    let a = Math.atan2(this.wheelX, -this.wheelY); if (a < 0) a += Math.PI * 2;
    const sel = Math.round(a / (Math.PI * 2) * WHEEL.length) % WHEEL.length;
    if (sel !== this.wheelSel) { this.wheelSel = sel; audio.ui('ui_move'); }
  },
  _wheelPick() {
    const item = WHEEL[this.wheelSel];
    if (!item) return;
    audio.ui('ui_ok');
    if (THROWABLES.includes(item)) this.selected = item;
    else if (CONSUMABLE[item]) this.use(item);
    else if (item === 'nvg') this.toggleNvg();
    else if (item === 'binoculars') this.setBinoc(!this.binoc);
    else if (item === 'c4') bus.emit('toast', t(this.c4s.length ? 'p_c4det' : 'p_c4', { key: 'T' }));
  },

  // ───────────────────────── throwables ─────────────────────────
  _launch(kind) {
    const p = G.player, cam = p.eyePos(_eye);
    p.forward(fwd);
    const sp = kind === 'tknife' ? THROW.tknife.speed : THROW.speed;
    const up = kind === 'tknife' ? 0.04 : THROW.upBias;
    return { x: cam.x + fwd.x * 0.5, y: cam.y - 0.1 + fwd.y * 0.5, z: cam.z + fwd.z * 0.5,
      vx: fwd.x * sp + p.body.vx * 0.5, vy: (fwd.y + up) * sp, vz: fwd.z * sp + p.body.vz * 0.5 };
  },
  _throw(kind, fuse) {
    if (!(this.inv[kind] > 0)) return;
    this.inv[kind]--;
    this.anim.thrown++;
    const o = this._launch(kind);
    o.kind = kind; o.mesh = buildItem(kind); o.bounces = 0; o.age = 0; o.done = false;
    o.fuse = fuse ?? (kind === 'smoke' ? THROW.smoke.fuse : kind === 'flash' ? THROW.flash.fuse : 999);
    G.scene.add(o.mesh);
    this.objs.push(o);
    audio.play('slash', { vol: 0.35, rate: 0.8 });
    if (this.inv[kind] <= 0 && kind === this.selected) { const nxt = THROWABLES.find((k) => this.inv[k] > 0); if (nxt) this.selected = nxt; }
  },
  /** Lobbed by an enemy: solve the launch velocity for a ~1.3 s flight to the target. */
  enemyGrenade(sx, sy, sz, tx, ty, tz) {
    const T = clamp(dist2D(sx, sz, tx, tz) / 13, 0.8, 1.7), g = THROW.gravity;
    const o = { kind: 'frag', enemy: true, x: sx, y: sy, z: sz, vx: (tx - sx) / T, vy: (ty - sy + 0.5 * g * T * T) / T, vz: (tz - sz) / T,
      mesh: buildItem('frag'), bounces: 0, age: 0, done: false, fuse: THROW.enemyFrag.fuse };
    G.scene.add(o.mesh); this.objs.push(o);
    audio.play('pin', { x: sx, y: sy, z: sz, vol: 0.8, ref: 5 });
    bus.emit('grenadeWarn', o);
  },

  _objects(dt) {
    const w = G.world;
    for (let i = this.objs.length - 1; i >= 0; i--) {
      const o = this.objs[i];
      o.age += dt; o.fuse -= dt;
      if (!o.done) {
        const g = o.kind === 'tknife' ? THROW.tknife.gravity : THROW.gravity;
        o.vy -= g * dt;
        let dx = o.vx * dt, dy = o.vy * dt, dz = o.vz * dt;
        const len = Math.hypot(dx, dy, dz);
        if (len > 1e-5) {
          dx /= len; dy /= len; dz /= len;
          // throwing knives and stones can strike a soldier
          if ((o.kind === 'tknife' || o.kind === 'stone') && ai.rayHit(o.x, o.y, o.z, dx, dy, dz, len + 0.1, hitE)) {
            if (o.kind === 'tknife') {
              audio.play('stab', { x: hitE.x, y: hitE.y, z: hitE.z, vol: 0.8, ref: 3 });
              fx.hit(hitE.x, hitE.y, hitE.z);
              G.mission.stats.hits++;
              const head = hitE.zone === 'head';             // lethal: see ballistics.isLethalHit
              const killed = ai.damage(hitE.enemy, thrownKnifeDamage(THROW.tknife.damage, hitE.zone), { by: 'tknife', head, fromX: G.player.x, fromZ: G.player.z, quiet: true });
              bus.emit('hitmarker', head, killed);
              audio.play(head ? 'headshot' : 'hitmark', { vol: 0.5, ui: true });
              bus.emit('spawnPickup', 'tknife', hitE.enemy.x, hitE.enemy.z);     // can be pulled out and reused
              this._remove(i); continue;
            }
            o.vx *= -0.2; o.vz *= -0.2; o.vy = 0;
            ai.stim(hitE.enemy, 'noise_quiet', G.player.x, G.player.z);
          } else if (w.raycast(o.x, o.y, o.z, dx, dy, dz, len + 0.06, F.SOLID, hit, null)) {
            o.x = hit.x + hit.nx * 0.06; o.y = hit.y + hit.ny * 0.06; o.z = hit.z + hit.nz * 0.06;
            if (o.kind === 'tknife') {                                 // sticks where it lands
              audio.play('impact_wood', { x: o.x, y: o.y, z: o.z, vol: 0.6, ref: 3 });
              noise.emit({ x: o.x, y: o.y, z: o.z, radius: NOISE.knifeImpact, kind: 'distraction', time: G.simTime });
              bus.emit('spawnPickup', 'tknife', o.x, o.z, o.y - 0.05);
              this._remove(i); continue;
            }
            const vn = o.vx * hit.nx + o.vy * hit.ny + o.vz * hit.nz;
            o.vx = (o.vx - 2 * vn * hit.nx) * (hit.ny > 0.5 ? THROW.friction : THROW.bounce);
            o.vy = (o.vy - 2 * vn * hit.ny) * THROW.bounce;
            o.vz = (o.vz - 2 * vn * hit.nz) * (hit.ny > 0.5 ? THROW.friction : THROW.bounce);
            o.bounces++;
            if (o.bounces <= 3) audio.play(o.kind === 'stone' ? 'stone_hit' : 'bounce', { x: o.x, y: o.y, z: o.z, vol: 0.7, ref: 4 });
            if (o.kind === 'stone' && o.bounces === 1) noise.emit({ x: o.x, y: o.y, z: o.z, radius: NOISE.stoneImpact, kind: 'distraction', time: G.simTime });
            if (Math.hypot(o.vx, o.vy, o.vz) < 0.8 && hit.ny > 0.5) { o.done = true; o.vx = o.vy = o.vz = 0; }
          } else { o.x += o.vx * dt; o.y += o.vy * dt; o.z += o.vz * dt; }
        }
        o.mesh.rotation.x += dt * 9; o.mesh.rotation.z += dt * 6;
      }
      o.mesh.position.set(o.x, o.y, o.z);
      if (o.fuse <= 0) {
        if (o.kind === 'frag') this._explode(o);
        else if (o.kind === 'smoke') this._startSmoke(o);
        else if (o.kind === 'flash') this._flash(o);
        this._remove(i);
      } else if (o.kind === 'stone' && o.done && o.age > 6) this._remove(i);
      else if (o.y < w.h(o.x, o.z) - 3) this._remove(i);
    }
  },
  _remove(i) { G.scene.remove(this.objs[i].mesh); this.objs.splice(i, 1); },

  /** Fragmentation blast (player frag, enemy frag or C4). */
  _explode(o) {
    const cfg = o.kind === 'c4' ? THROW.c4 : o.enemy ? THROW.enemyFrag : THROW.frag, p = G.player;
    fx.blast(o.x, o.y, o.z, cfg.radius, o.kind === 'c4' ? 'c4' : 'frag');
    R.flashAt(o.x, o.y + 0.5, o.z, 14, cfg.radius * 3, 0.14);
    audio.play('explosion', { x: o.x, y: o.y, z: o.z, vol: 1, ref: 14 });
    noise.emit({ x: o.x, y: o.y, z: o.z, radius: o.kind === 'c4' ? NOISE.c4 : NOISE.explosion, kind: 'explosion', byPlayer: !o.enemy, byEnemy: !!o.enemy, time: G.simTime });
    if (!o.enemy) ai.blast(o.x, o.y, o.z, cfg.radius, cfg.damage, cfg.minDamage || 20);
    const d = Math.hypot(p.x - o.x, p.y + 0.9 - o.y, p.z - o.z);
    if (d < cfg.radius * 1.6) p.shake = Math.max(p.shake, 1 - d / (cfg.radius * 1.6));
    if (d < cfg.radius && G.world.los(o.x, o.y + 0.3, o.z, p.x, p.y + 1, p.z)) {
      p.takeDamage(blastDamage(d, cfg.radius, o.enemy ? cfg.damage * G.mission.diff.damageMult : cfg.damage * 0.55, 6), o.x, o.z, 'blast');
    }
    // enemy equipment in the blast
    const lv = G.level, rel = lv.relayObj;
    if (rel && rel.alive && !o.enemy && dist2D(o.x, o.z, rel.x, rel.z) < (o.kind === 'c4' ? 5 : 2.2)) {
      rel.alive = false; rel.mesh.visible = false; lv.world.removeCollider(rel.col);
      fx.explosion(rel.x, rel.y + 1, rel.z, 5);
      bus.emit('toast', t('relayDown')); bus.emit('relayDown');
    }
    // armour and artillery: only C4 does anything (vehicles.onBlast)
    if (!o.enemy && G.vehicles) G.vehicles.onBlast(o);
  },
  _startSmoke(o) {
    audio.play('smoke', { x: o.x, y: o.y, z: o.z, vol: 0.9, ref: 6 });
    noise.emit({ x: o.x, y: o.y, z: o.z, radius: NOISE.smokePop, kind: 'distraction', time: G.simTime });
    const s = { x: o.x, y: o.y + 1.2, z: o.z, r: 0.5, age: 0, puffT: 0 };
    this.smokes.push(s); G.world.smokes.push(s);
  },
  /** Smoke clouds are vision blockers in the physics world (see World.los). */
  _smoke(dt) {
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.age += dt;
      const life = THROW.smoke.duration;
      s.r = THROW.smoke.radius * clamp01(s.age / THROW.smoke.grow) * (s.age > life - 4 ? clamp01((life - s.age) / 4) : 1);
      s.puffT -= dt;
      if (s.puffT <= 0 && s.age < life - 1.5) {
        s.puffT = 0.16;
        const a = Math.random() * 6.28, d = Math.random() * s.r * 0.8;
        fx.puff(s.x + Math.cos(a) * d, s.y - 0.9 + Math.random() * 2.2, s.z + Math.sin(a) * d, { size: 2.6 + Math.random() * 1.6, color: 0xb9bcbc, life: 3.2, grow: 0.25, rise: 0.12, opacity: 0.6 });
      }
      if (s.age >= life) { this.smokes.splice(i, 1); const k = G.world.smokes.indexOf(s); if (k >= 0) G.world.smokes.splice(k, 1); }
    }
  },
  _flash(o) {
    const p = G.player, cfg = THROW.flash;
    audio.play('flashbang', { x: o.x, y: o.y, z: o.z, vol: 1, ref: 10 });
    R.flashAt(o.x, o.y + 0.3, o.z, 30, 40, 0.12);
    fx.puff(o.x, o.y + 0.3, o.z, { size: 3, color: 0xffffff, life: 0.15, grow: 5, rise: 0, opacity: 1, add: true });
    noise.emit({ x: o.x, y: o.y, z: o.z, radius: NOISE.flashbang, kind: 'flash', byPlayer: true, time: G.simTime });
    ai.stun(o.x, o.y, o.z, cfg.radius, cfg.stun);
    const cam = p.eyePos(_eye), dx = o.x - cam.x, dy = o.y - cam.y, dz = o.z - cam.z, d = Math.hypot(dx, dy, dz);
    if (d < cfg.playerRadius && G.world.los(cam.x, cam.y, cam.z, o.x, o.y + 0.2, o.z)) {
      p.forward(fwd);
      const facing = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / Math.max(0.01, d);
      p.flash = Math.max(p.flash, (facing > 0.2 ? 1.3 : 0.45) * (1 - d / cfg.playerRadius * 0.6));
    }
  },

  // ───────────────────────── C4 ─────────────────────────
  _placeC4() {
    if (!(this.inv.c4 > 0)) return false;
    const p = G.player, cam = p.eyePos(_eye);
    p.forward(fwd);
    if (!G.world.raycast(cam.x, cam.y, cam.z, fwd.x, fwd.y, fwd.z, THROW.c4.placeRange, F.SOLID, hit, null)) return false;
    const mesh = buildItem('c4');
    mesh.position.set(hit.x + hit.nx * 0.03, hit.y + hit.ny * 0.03, hit.z + hit.nz * 0.03);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(hit.nx, hit.ny, hit.nz));
    G.scene.add(mesh);
    const c = { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z, mesh, veh: null };
    // stuck to a vehicle, the charge rides with it in the vehicle's own frame (it may be moving)
    const veh = hit.collider && hit.collider.veh;
    if (veh && G.vehicles) G.vehicles.attachCharge(veh, c);
    this.c4s.push(c);
    this.inv.c4--;
    audio.play('beep', { vol: 0.6 }); bus.emit('toast', t('c4Placed'));
    this.anim.placed++;
    return true;
  },
  _detonate() {
    this.anim.det++;
    audio.play('beep', { vol: 0.8, rate: 1.4 });
    for (const c of this.c4s) {
      const o = { x: c.x, y: c.y, z: c.z, kind: 'c4', veh: c.veh };
      if (c.veh) {
        // where it is now, and where on the vehicle it sits
        c.mesh.getWorldPosition(_wp); o.x = _wp.x; o.y = _wp.y; o.z = _wp.z;
        o.lx = c.mesh.position.x; o.ly = c.mesh.position.y; o.lz = c.mesh.position.z;
      }
      if (c.mesh.parent) c.mesh.parent.remove(c.mesh);
      this._explode(o);
    }
    this.c4s.length = 0;
  },

  // ───────────────────────── per frame ─────────────────────────
  frame(dt) {
    R.post.nv = damp(R.post.nv, this.nvg.on ? 1 : 0, 9, dt);
    // throw arc preview while the key is held
    const show = !!this.cook && this.cook.kind !== 'tknife';
    this.arc.visible = show;
    if (!show) return;
    const o = this._launch(this.cook.kind), pos = this.arc.geometry.attributes.position.array, w = G.world, h = 0.06;
    let n = 0;
    for (; n < ARC_N; n++) {
      pos[n * 3] = o.x; pos[n * 3 + 1] = o.y; pos[n * 3 + 2] = o.z;
      o.vy -= THROW.gravity * h;
      const nx = o.x + o.vx * h, ny = o.y + o.vy * h, nz = o.z + o.vz * h;
      const len = Math.hypot(nx - o.x, ny - o.y, nz - o.z);
      if (w.raycast(o.x, o.y, o.z, (nx - o.x) / len, (ny - o.y) / len, (nz - o.z) / len, len, F.SOLID, hit, null)) { n++; pos[n * 3] = hit.x; pos[n * 3 + 1] = hit.y; pos[n * 3 + 2] = hit.z; n++; break; }
      o.x = nx; o.y = ny; o.z = nz;
    }
    this.arc.geometry.setDrawRange(0, Math.min(n, ARC_N));
    this.arc.geometry.attributes.position.needsUpdate = true;
  },

  snapshot() { return { inv: { ...this.inv }, selected: this.selected, battery: this.nvg.battery }; },
  restore(s) { this.reset(); this.inv = { ...this.inv, ...s.inv }; this.selected = s.selected || 'frag'; this.nvg.battery = s.battery ?? 100; },
};
