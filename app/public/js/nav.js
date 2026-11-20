/**
 * nav.js — ground navigation for the AI.
 *
 * A 1 m grid is laid over the level. A cell is blocked when something solid
 * that cannot be stepped over overlaps an agent standing there, when the
 * terrain is too steep, or when the level marks it off-limits. Paths are A*
 * over the 8-connected grid (no corner cutting), then string-pulled so agents
 * walk straight lines instead of staircases.
 */
import { F } from './physics.js';

const SQRT2 = Math.SQRT2;

export class NavGrid {
  /**
   * @param world physics World
   * @param noWalk optional (x,z) → true for cells agents must never enter
   */
  constructor(world, noWalk) {
    this.world = world;
    const b = world.bounds;
    this.minX = b.minX; this.minZ = b.minZ;
    this.w = Math.ceil(b.maxX - b.minX);
    this.d = Math.ceil(b.maxZ - b.minZ);
    const n = this.w * this.d;
    this.blocked = new Uint8Array(n);
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.from = new Int32Array(n);
    this.seen = new Uint32Array(n);     // search stamp per cell
    this.closed = new Uint32Array(n);
    this.search = 0;
    this.heap = new Int32Array(n);
    this.heapN = 0;
    this._build(noWalk);
  }

  _build(noWalk) {
    const { world } = this;
    const R = 0.42;
    for (let iz = 0; iz < this.d; iz++) {
      for (let ix = 0; ix < this.w; ix++) {
        const x = this.minX + ix + 0.5, z = this.minZ + iz + 0.5;
        const i = iz * this.w + ix;
        if (noWalk && noWalk(x, z)) { this.blocked[i] = 1; continue; }
        const h = world.h(x, z);
        // too steep to walk
        if (Math.abs(world.h(x + 0.6, z) - world.h(x - 0.6, z)) > 0.95 ||
            Math.abs(world.h(x, z + 0.6) - world.h(x, z - 0.6)) > 0.95) { this.blocked[i] = 1; continue; }
        let hit = false;
        world._each(x - R, z - R, x + R, z + R, (cell) => {
          if (hit) return;
          for (let k = 0; k < cell.length; k++) {
            const c = cell[k];
            if (!(c.flags & F.SOLID) || c.tag === 'door') continue;   // soldiers open shut doors on the way
            const top = c.y + c.hy, bottom = c.y - c.hy;
            if (top < h + 0.45 || bottom > h + 1.7) continue;   // can step over it / it is overhead
            const dx = x - c.x, dz = z - c.z;
            const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
            if (Math.abs(lx) <= c.hx + R && Math.abs(lz) <= c.hz + R) { hit = true; return; }
          }
        });
        if (hit) this.blocked[i] = 1;
      }
    }
  }

  idx(x, z) {
    const ix = Math.floor(x - this.minX), iz = Math.floor(z - this.minZ);
    if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.d) return -1;
    return iz * this.w + ix;
  }
  isFree(x, z) { const i = this.idx(x, z); return i >= 0 && !this.blocked[i]; }
  cx(i) { return this.minX + (i % this.w) + 0.5; }
  cz(i) { return this.minZ + Math.floor(i / this.w) + 0.5; }

  /** Nearest free cell centre to (x,z) within `maxR` cells; null if none. */
  nearestFree(x, z, maxR = 8) {
    const i0 = this.idx(x, z);
    if (i0 >= 0 && !this.blocked[i0]) return { x, z };
    const ix0 = Math.floor(x - this.minX), iz0 = Math.floor(z - this.minZ);
    for (let r = 1; r <= maxR; r++) {
      let best = -1, bd = Infinity;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const ix = ix0 + dx, iz = iz0 + dz;
        if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.d) continue;
        const i = iz * this.w + ix;
        if (this.blocked[i]) continue;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) return { x: this.cx(best), z: this.cz(best) };
    }
    return null;
  }

  // ── binary heap keyed by f
  _push(i) {
    const h = this.heap, f = this.f;
    let n = this.heapN++;
    h[n] = i;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (f[h[p]] <= f[h[n]]) break;
      const q = h[p]; h[p] = h[n]; h[n] = q; n = p;
    }
  }
  _pop() {
    const h = this.heap, f = this.f;
    const top = h[0];
    const last = h[--this.heapN];
    if (this.heapN > 0) {
      h[0] = last;
      let n = 0;
      for (;;) {
        const l = n * 2 + 1, r = l + 1;
        let m = n;
        if (l < this.heapN && f[h[l]] < f[h[m]]) m = l;
        if (r < this.heapN && f[h[r]] < f[h[m]]) m = r;
        if (m === n) break;
        const q = h[m]; h[m] = h[n]; h[n] = q; n = m;
      }
    }
    return top;
  }

  /**
   * A* from (sx,sz) to (tx,tz). Fills `out` (array of {x,z}, start excluded,
   * goal included) and returns true, or returns false when unreachable within
   * the expansion budget.
   */
  findPath(sx, sz, tx, tz, out, budget = 9000) {
    out.length = 0;
    const s = this.nearestFree(sx, sz), g = this.nearestFree(tx, tz);
    if (!s || !g) return false;
    const si = this.idx(s.x, s.z), gi = this.idx(g.x, g.z);
    if (si === gi) { out.push({ x: tx, z: tz }); return true; }
    const W = this.w, D = this.d, blocked = this.blocked;
    const stamp = ++this.search;
    this.heapN = 0;
    const gx = gi % W, gz = (gi / W) | 0;
    this.g[si] = 0; this.f[si] = 0; this.from[si] = -1; this.seen[si] = stamp;
    this._push(si);
    let found = false;
    while (this.heapN > 0 && budget-- > 0) {
      const cur = this._pop();
      if (cur === gi) { found = true; break; }
      if (this.closed[cur] === stamp) continue;
      this.closed[cur] = stamp;
      const cxi = cur % W, czi = (cur / W) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        const nz = czi + dz;
        if (nz < 0 || nz >= D) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nxp = cxi + dx;
          if (nxp < 0 || nxp >= W) continue;
          const ni = nz * W + nxp;
          if (blocked[ni] || this.closed[ni] === stamp) continue;
          // no squeezing diagonally between two blocked cells
          if (dx && dz && (blocked[czi * W + nxp] || blocked[nz * W + cxi])) continue;
          const ng = this.g[cur] + (dx && dz ? SQRT2 : 1);
          if (this.seen[ni] === stamp && ng >= this.g[ni]) continue;
          this.seen[ni] = stamp;
          this.g[ni] = ng;
          const hx = Math.abs(nxp - gx), hz = Math.abs(nz - gz);
          this.f[ni] = ng + (hx + hz) + (SQRT2 - 2) * Math.min(hx, hz);   // octile distance
          this.from[ni] = cur;
          this._push(ni);
        }
      }
    }
    if (!found) return false;
    // unwind
    const rev = [];
    for (let i = gi; i !== -1 && i !== si; i = this.from[i]) rev.push(i);
    // string-pull: keep a waypoint only when the straight line to the next one is blocked
    let ax = s.x, az = s.z;
    let k = rev.length - 1;
    while (k >= 0) {
      let far = k;
      for (let j = 0; j < k; j++) {        // try the farthest reachable waypoint first
        if (this.walkable(ax, az, this.cx(rev[j]), this.cz(rev[j]))) { far = j; break; }
      }
      const px = this.cx(rev[far]), pz = this.cz(rev[far]);
      out.push({ x: px, z: pz });
      ax = px; az = pz;
      k = far - 1;
    }
    // finish exactly on the requested point when it is free
    if (this.isFree(tx, tz) && out.length) { out[out.length - 1].x = tx; out[out.length - 1].z = tz; }
    return true;
  }

  /** Straight-line walkability between two points (samples every 0.4 m, agent-width aware). */
  walkable(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const d = Math.sqrt(dx * dx + dz * dz);
    const n = Math.ceil(d / 0.4);
    const px = d > 0 ? -dz / d * 0.3 : 0, pz = d > 0 ? dx / d * 0.3 : 0;
    for (let i = 0; i <= n; i++) {
      const t = n ? i / n : 0;
      const x = ax + dx * t, z = az + dz * t;
      if (!this.isFree(x, z) || !this.isFree(x + px, z + pz) || !this.isFree(x - px, z - pz)) return false;
    }
    return true;
  }

  /** A random free point within r of (x,z); falls back to (x,z). */
  randomNear(x, z, r, rng) {
    for (let k = 0; k < 14; k++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * r;
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      if (this.isFree(px, pz)) return { x: px, z: pz };
    }
    return this.nearestFree(x, z) || { x, z };
  }

  /**
   * Find cover from a threat: a free cell within maxR of (fx,fz), next to
   * something solid, from which the threat's eye cannot be seen. Prefers cells
   * close to the agent and not closer to the threat than the agent already is.
   */
  findCover(fx, fz, tx, ty, tz, maxR, rng) {
    const world = this.world;
    let best = null, bestScore = Infinity;
    for (let k = 0; k < 26; k++) {
      const a = rng() * Math.PI * 2, d = 2 + rng() * (maxR - 2);
      const x = fx + Math.cos(a) * d, z = fz + Math.sin(a) * d;
      const i = this.idx(x, z);
      if (i < 0 || this.blocked[i]) continue;
      const ix = i % this.w, iz = (i / this.w) | 0;
      // must touch a blocked neighbour (something to hide behind)
      let wall = false;
      for (let q = 0; q < 4 && !wall; q++) {
        const nx = ix + (q === 0 ? 1 : q === 1 ? -1 : 0), nz = iz + (q === 2 ? 1 : q === 3 ? -1 : 0);
        if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.d || this.blocked[nz * this.w + nx]) wall = true;
      }
      if (!wall) continue;
      const cx = this.cx(i), cz = this.cz(i);
      const h = world.h(cx, cz);
      if (world.los(cx, h + 1.2, cz, tx, ty, tz)) continue;        // still exposed when crouched
      const dT = Math.hypot(cx - tx, cz - tz);
      const score = d + (dT < 6 ? 20 : 0);
      if (score < bestScore) { bestScore = score; best = { x: cx, z: cz }; }
    }
    return best;
  }
}
