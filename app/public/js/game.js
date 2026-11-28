/**
 * game.js — mission flow: starting a mission, loading acts, checkpoints and
 * autosave, triggers, sector clearing, objectives, waves, death and the
 * end-of-mission result.
 */
import { G, bus, makeRng, clamp01, damp } from './ctx.js';
import { DIFFICULTY, LOADOUT, computeScore } from './config.js';
import { Level } from './level.js';
import { Player } from './player.js';
import { weapons } from './weapons.js';
import { equip } from './equipment.js';
import { interact } from './interact.js';
import { ai } from './ai.js';
import { climb } from './climb.js';
import { fx } from './fx.js';
import { audio } from './audio.js';
import { R } from './render.js';
import { save } from './save.js';
import { net } from './net.js';
import { input } from './input.js';
import { t } from './loc.js';
import { vehicles } from './vehicles.js';
import * as act1 from './levels/act1.js';
import * as act2 from './levels/act2.js';
import * as act3 from './levels/act3.js';
import * as act4 from './levels/act4.js';

const ACTS = { 1: act1, 2: act2, 3: act3, 4: act4 };
const radioSaid = new Map();
let pendingCheckpoint = null;
let dawnT = 0;

function newStats() { return { kills: 0, headshots: 0, stealthKills: 0, spotted: 0, shots: 0, hits: 0, time: 0, deaths: 0, vehicles: 0 }; }

export const game = {
  /** Begin a fresh mission from Act 1. */
  start(name, difficulty) {
    G.mission = { name, difficulty, diff: DIFFICULTY[difficulty], act: 1, stats: newStats(), cleared: {}, flagReady: false, flagRaised: false, seed: (Math.random() * 1e9) | 0 };
    G.rng = makeRng(G.mission.seed);
    if (!G.player) G.player = new Player();
    weapons.reset(); equip.reset();
    G.player.armor = LOADOUT.armor;
    net.start(difficulty);
    this.loadAct(1, null, true);
  },

  /** Resume from the stored checkpoint. */
  resume(snap) {
    G.mission = { name: snap.name, difficulty: snap.difficulty, diff: DIFFICULTY[snap.difficulty] || DIFFICULTY.normal, act: snap.act, stats: { ...newStats(), ...snap.stats }, cleared: snap.cleared || {}, flagReady: false, flagRaised: false, seed: snap.seed || 1 };
    G.rng = makeRng(G.mission.seed + snap.act * 7919);
    if (!G.player) G.player = new Player();
    this.loadAct(snap.act, snap, false);
  },

  /**
   * Build an act. `snap` restores a checkpoint inside it; `fresh` means the
   * loadout was just reset (new mission) rather than carried over.
   */
  loadAct(n, snap, fresh) {
    const m = G.mission, p = G.player;
    const carry = snap ? null : { health: p.health, armor: p.armor, bleed: p.bleed };
    G.playing = false;
    bus.emit('loading', n);
    if (G.level) { climb.stop(); G.level.dispose(); }
    ai.reset(); equip._clearWorld(); fx.reset(); vehicles.reset();
    radioSaid.clear(); pendingCheckpoint = null;
    m.act = n; m.flagReady = false; m.flagRaised = false;

    const L = new Level(n);
    ACTS[n].build(L, m);
    // pickups scale with difficulty (weapons never do)
    for (const pk of L.pickups) if (!pk.type.startsWith('weapon_') && pk.amount > 0) pk.amount = Math.max(1, Math.round(pk.amount * m.diff.pickupMult));
    if (m.diff.pickupMult < 1) L.pickups = L.pickups.filter((pk, i) => pk.type.startsWith('weapon_') || pk.type === 'c4' || (i * 7 + n) % 5 !== 0);
    L.finalize();
    G.level = L; G.world = L.world; G.nav = L.nav;
    vehicles.build(L);
    R.setEnv(L.envName);
    dawnT = 0;

    const cleared = (m.cleared[n] || []).slice();
    if (snap) {
      p.reset({ x: snap.pos.x, z: snap.pos.z, y: snap.pos.y, yaw: snap.pos.yaw });
      p.health = snap.health; p.armor = snap.armor; p.bleed = snap.bleed || 0;
      weapons.restore(snap.weapons); equip.restore(snap.equip);
      for (const id of snap.pickupsTaken || []) { const pk = L.pickups[id]; if (pk) { pk.taken = true; pk.mesh.visible = false; } }
      for (const i of snap.triggersDone || []) if (L.triggers[i]) L.triggers[i].done = true;
      for (const id of snap.cpsDone || []) { const c = L.checkpoints.find((k) => k.id === id); if (c) c.done = true; }
      if (snap.relayDead && L.relayObj) { L.relayObj.alive = false; L.relayObj.mesh.visible = false; L.world.removeCollider(L.relayObj.col); }
      if (snap.vehicles) vehicles.restore(snap.vehicles, p);      // wrecks stay wrecks; a live tank restarts clear of the player
      if (snap.doors && L.doorSys) L.doorSys.load(snap.doors);
    } else {
      p.reset(L.spawn);
      if (!fresh && carry) { p.health = Math.max(35, carry.health); p.armor = carry.armor; p.bleed = 0; }
      else p.armor = LOADOUT.armor;
    }
    for (const s of L.sectors) if (cleared.includes(s.id)) { s.cleared = true; if (L.gates && L.gates[s.id]) L.openBarrier(L.gates[s.id]); }
    if (L.exit && L.exit.locked && L.sectors.every((s) => s.cleared)) L.exit.locked = false;
    ai.spawnAll(L, cleared);
    L.totalEnemies = L.spawns.length;

    if (L.climb) climb.start(L, snap && snap.climbS ? snap.climbS : 0);
    audio.stopLoops();
    audio.loop('wind', n === 2 ? 0.5 : 0.22);
    audio.loop('rain', (R.rainAmt || 0) * 0.5);
    audio.setMusic('calm');
    input.releaseAll();
    G.simTime = 0;
    if (snap) net.checkpoint(n, L.checkpoints.filter((k) => k.done).length, m.stats);
    else this.saveCheckpoint('start');
    G.playing = true;
    bus.emit('actLoaded', n);
  },

  /** Write the checkpoint (position, health, loadout, progress) to storage. */
  saveCheckpoint(id) {
    const m = G.mission, p = G.player, L = G.level;
    if (!m || p.dead) return;
    const snap = {
      name: m.name, difficulty: m.difficulty, act: m.act, cp: id, seed: m.seed,
      pos: { x: p.x, y: p.y, z: p.z, yaw: p.yaw }, health: Math.max(25, p.health), armor: p.armor, bleed: 0,
      weapons: weapons.snapshot(), equip: equip.snapshot(), stats: { ...m.stats }, cleared: m.cleared,
      pickupsTaken: L.pickups.filter((k) => k.taken && k.id < 200).map((k) => k.id),
      triggersDone: L.triggers.map((k, i) => (k.done ? i : -1)).filter((i) => i >= 0),
      cpsDone: L.checkpoints.filter((k) => k.done).map((k) => k.id),
      relayDead: !!(L.relayObj && !L.relayObj.alive),
      vehicles: vehicles.snapshot(),
      doors: L.doorSys ? L.doorSys.save() : undefined,
      climbS: L.climb ? climb.lastLedge : 0,
    };
    if (L.climb) { snap.pos = { x: L.spawn.x, y: 0, z: L.spawn.z, yaw: 0 }; }
    save.saveCheckpoint(snap);
    net.checkpoint(m.act, L.checkpoints.filter((k) => k.done).length, m.stats);
    if (id !== 'start') bus.emit('toast', t('checkpoint'));
  },

  restartCheckpoint() {
    const snap = save.loadCheckpoint();
    if (!snap) return false;
    const deaths = G.mission ? G.mission.stats.deaths : 0, time = G.mission ? G.mission.stats.time : 0;
    snap.stats = { ...snap.stats, deaths: Math.max(deaths, snap.stats.deaths || 0), time: Math.max(time, snap.stats.time || 0) };
    this.resume(snap);
    return true;
  },

  radio(key, repeatAfter) {
    const last = radioSaid.get(key);
    if (last !== undefined && (!repeatAfter || G.simTime - last < repeatAfter)) return;
    radioSaid.set(key, G.simTime);
    audio.radio(key, t(key, { name: G.mission.name }));
  },

  // ───────────────────────── simulation step ─────────────────────────
  step(dt) {
    const p = G.player, L = G.level, m = G.mission;
    G.simTime += dt; m.stats.time += dt;
    p.update(dt);
    if (L.climb) climb.update(dt);
    weapons.update(dt);
    equip.update(dt);
    interact.update(dt);
    ai.update(dt);
    vehicles.update(dt);
    if (p.dead) return;

    // triggers (all acts run south → north, so most are simple lines)
    for (const tr of L.triggers) {
      if (tr.done) continue;
      const hit = tr.line ? p.z <= tr.z : Math.hypot(p.x - tr.x, p.z - tr.z) < tr.r;
      if (!hit) continue;
      tr.done = true;
      if (tr.radio) this.radio(tr.radio);
      if (tr.wave) ai.triggerWave(tr.wave);
    }
    // checkpoints: only saved once things are calm, so a save never lands mid-firefight
    for (const c of L.checkpoints) {
      if (c.done || c.tier > m.diff.cpTier) continue;
      if (c.r ? Math.hypot(p.x - c.x, p.z - c.z) < c.r : p.z <= c.z) { c.done = true; pendingCheckpoint = c.id; }
    }
    if (pendingCheckpoint && ai.globalAlert < 2 && !p.dragging && !weapons.takedown) { const id = pendingCheckpoint; pendingCheckpoint = null; this.saveCheckpoint(id); }

    // sectors: cleared when the last soldier in them is down
    if (m.act === 3) {
      for (const s of L.sectors) {
        if (s.cleared || ai.aliveIn(s.id) > 0) continue;
        s.cleared = true;
        (m.cleared[3] ||= []).push(s.id);
        bus.emit('toast', t('sectorClear'), 'good');
        this.radio('r_sectorClear', 5);
        if (L.gates[s.id]) L.openBarrier(L.gates[s.id]);
        if (L.sectors.every((k) => k.cleared)) L.exit.locked = false;
        pendingCheckpoint = 'sector' + s.id;
      }
    }
    if (m.act === 4 && !m.flagReady) {
      for (const r of L.waveRules) {
        if (r.fired || (r.after && !L.waveRules.find((k) => k.wave === r.after).fired)) continue;
        if (ai.aliveTotal() <= r.alive) {
          r.fired = true;
          if (ai.triggerWave(r.wave)) { bus.emit('toast', t('reinforce', { dir: t('dir' + r.dir) }), 'warn'); this.radio('r_reinforce', 5); }
        }
      }
      if (ai.aliveTotal() === 0 && ai.pendingWaves() === 0) {
        m.flagReady = true;
        bus.emit('toast', t('areaSecure'), 'good');
        this.radio('r_flag');
        pendingCheckpoint = 'secure';
      }
    }
  },

  /** Per rendered frame: time-of-day drift and looping beds. */
  frame(dt) {
    const L = G.level, m = G.mission;
    if (!L || !m) return;
    if (L.dawn) {
      const total = Math.max(1, L.totalEnemies);
      const target = m.flagRaised ? 1 : clamp01(1 - (ai.aliveTotal() + ai.pendingWaves()) / total) * 0.75;
      dawnT = damp(dawnT, target, 0.35, dt);
      R.setEnv('dawnStart', 'dawnEnd', dawnT);
    }
    const indoor = L.isIndoor(G.player.x, G.player.y + 1, G.player.z);
    audio.loop('rain', (R.rainAmt || 0) * (indoor ? 0.2 : 0.55));
    let fire = 0;
    for (const f of L.fires) { const d = Math.hypot(f.x - G.player.x, f.z - G.player.z); if (d < 16) fire = Math.max(fire, 1 - d / 16); }
    audio.loop('fire', fire * 0.6);
  },

  /** HUD text for the current objective. */
  objective() {
    const L = G.level, m = G.mission;
    if (!L) return { main: '', opt: '', remaining: -1 };
    if (m.act === 3) {
      const sec = L.sectorAt(G.player.x, G.player.z) || L.sectors[0];
      const all = L.sectors.every((s) => s.cleared);
      const cur = sec.cleared ? L.sectors.find((s) => !s.cleared) || sec : sec;
      const relay = L.relayObj && L.relayObj.alive, tank = vehicles.alive('tank');
      return { main: all ? t('obj_a3_next') : sec.cleared ? t('obj_a3_next') : t('obj_a3', { sector: t(cur.nameKey) }),
        opt: relay && tank ? t('obj_a3_both') : relay ? t('obj_a3_opt') : tank ? t('obj_a3_tank') : '', remaining: sec.cleared ? -1 : ai.aliveIn(sec.id) };
    }
    if (m.act === 4) return { main: m.flagReady ? t('obj_a4_flag') : t('obj_a4'), opt: !m.flagRaised && vehicles.alive('tank') ? t('obj_a4_tank') : '', remaining: m.flagReady ? -1 : ai.aliveTotal() + ai.pendingWaves() };
    if (m.act === 1) {
      const svd = !(weapons.slots.p1 && weapons.slots.p1.id === 'svd' || weapons.slots.p2 && weapons.slots.p2.id === 'svd'), guns = vehicles.alive('gun');
      return { main: t('obj_a1'), opt: svd && guns ? t('obj_a1_both') : svd ? t('obj_a1_opt') : guns ? t('obj_a1_bat') : '', remaining: -1 };
    }
    return { main: t(L.objective), opt: '', remaining: -1 };
  },

  /**
   * Every task of the act, one entry per line on the HUD:
   * [{ id, text, optional, done, point: {x,z}|null, moving }]. The main task comes first;
   * optional tasks stay in the list once done (done: true) so the HUD can tick them off.
   * `moving` marks a target whose point follows it (the tank); the HUD decides when to show it.
   */
  objectives() {
    const L = G.level, m = G.mission;
    if (!L || !m) return [];
    const o = this.objective(), list = [{ id: 'main', text: o.main, optional: false, done: false, point: this.objectivePoint(), moving: false }];
    const tank = vehicles.tanks[0];
    const tankTask = (key) => list.push({ id: 'tank', text: t(key), optional: true, done: !tank.alive, point: tank.alive ? { x: tank.x, z: tank.z } : null, moving: true });
    if (m.act === 1) {
      const svd = L.pickups.find((p) => p.type === 'weapon_svd');
      const held = ['p1', 'p2'].some((k) => weapons.slots[k] && weapons.slots[k].id === 'svd');
      if (svd) list.push({ id: 'svd', text: t('ob_svd'), optional: true, done: held, point: held || svd.taken ? null : { x: svd.x, z: svd.z }, moving: false });
      if (vehicles.has('gun')) {
        const guns = vehicles.list.filter((v) => v.alive && (v.kind === 'gun' || v.kind === 'mortar'));
        const pt = guns.length ? { x: guns.reduce((s, v) => s + v.def.x, 0) / guns.length, z: guns.reduce((s, v) => s + v.def.z, 0) / guns.length } : null;
        list.push({ id: 'battery', text: t('ob_battery'), optional: true, done: !guns.length, point: pt, moving: false });
      }
    } else if (m.act === 3) {
      if (L.relayObj) list.push({ id: 'relay', text: t('ob_relay'), optional: true, done: !L.relayObj.alive, point: L.relayObj.alive ? { x: L.relayObj.x, z: L.relayObj.z } : null, moving: false });
      if (tank) tankTask('ob_tank3');
    } else if (m.act === 4) {
      if (tank && !(m.flagRaised && tank.alive)) tankTask('ob_tank4');
    }
    list[0].remaining = o.remaining;
    return list;
  },

  /** Where the compass / objective marker should point. */
  objectivePoint() {
    const L = G.level, m = G.mission;
    if (!L) return null;
    if (m.act === 4) return L.flag ? { x: L.flag.x, z: L.flag.z } : null;
    if (m.act === 3) {
      const next = L.sectors.find((s) => !s.cleared);
      if (!next) return L.exit;
      const sec = L.sectorAt(G.player.x, G.player.z);
      return sec === next ? null : { x: 0, z: (next.minZ + next.maxZ) / 2 + 26 };
    }
    return L.exit;
  },

  onExit() {
    const m = G.mission;
    if (m.act < 4) { bus.emit('fade', () => this.loadAct(m.act + 1, null, false)); }
  },

  finish() {
    const m = G.mission;
    G.playing = false;
    const res = computeScore(m.stats, m.difficulty);
    const result = { ...res, name: m.name, difficulty: m.difficulty, stats: { ...m.stats }, time: Math.round(m.stats.time) };
    result.newBest = save.recordBest(m.difficulty, { score: res.score, rank: res.rank, time: result.time });
    result.best = save.loadBest()[m.difficulty];
    save.clearCheckpoint();
    net.finish(m.stats);
    audio.setMusic('calm');
    bus.emit('missionEnd', result);
  },

  quit() {
    G.playing = false; G.paused = false;
    if (G.level) { climb.stop(); G.level.dispose(); G.level = null; }
    ai.reset(); equip._clearWorld(); fx.reset(); vehicles.reset();
    audio.stopLoops(); audio.setMusic('calm');
    G.mission = null;
  },
};

// ── wiring
bus.on('radio', (key) => game.radio(key, 30));
bus.on('exit', () => game.onExit());
bus.on('spotted', () => { G.mission.stats.spotted++; game.radio('r_spotted', 40); bus.emit('toast', t('spotted'), 'warn'); audio.play('alert', { vol: 0.7, ui: true }); });
bus.on('lostTrail', () => { if (ai.globalAlert === 0 || ai.globalAlert === 1) { game.radio('r_lost', 40); bus.emit('toast', t('hiddenAgain'), 'good'); } });
bus.on('alert', (a) => { if (!G.level || G.level.climb) return; audio.setMusic(a === 2 ? 'combat' : a === 1 ? 'tension' : 'calm'); });
bus.on('lowHealth', () => game.radio('r_lowhp', 60));
bus.on('gotSvd', () => game.radio('r_svd'));
bus.on('suppressorBroke', () => {});
bus.on('vehicleDown', () => { if (G.level && !G.level.climb) pendingCheckpoint = pendingCheckpoint || 'vehicle'; });   // saved once things calm down
bus.on('playerDead', () => { G.mission.stats.deaths++; audio.setMusic('off'); setTimeout(() => bus.emit('missionFail'), 1600); });
