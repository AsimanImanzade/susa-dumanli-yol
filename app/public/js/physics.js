/**
 * physics.js — level collision.
 *
 * The world is a heightfield (an analytic terrain function) plus a set of
 * yaw-rotated boxes ("colliders") in a uniform spatial hash. Characters are
 * vertical capsules, treated as a circle in XZ with a vertical span:
 *
 *   • horizontal: circle vs rotated rectangle, pushed out along the shortest
 *     axis, in sub-steps of half a radius so nothing tunnels through a wall;
 *   • vertical: the feet rest on max(terrain, top of any walkable box under the
 *     feet that is within step height) — this is what makes stairs, crates and
 *     rooftops walkable;
 *   • rays: slab test against each box in the cells the ray crosses, plus a
 *     marched test against the terrain.
 *
 * No Three.js dependency: the AI and tests use this headless.
 */

export const F = {
  SOLID: 1,     // blocks movement
  VISION: 2,    // blocks sight
  BULLET: 4,    // blocks bullets
  THIN: 8,      // bullets pass through with reduced damage (thin wood)
  WALK: 16,     // top face can be stood on
};
export const WALL = F.SOLID | F.VISION | F.BULLET | F.WALK;

const CELL = 4;

export class World {
  /**
   * @param bounds {minX,maxX,minZ,maxZ}
   * @param heightFn (x,z) → terrain height
   * @param surfaceFn (x,z) → surface name for footsteps
   */
  constructor(bounds, heightFn, surfaceFn) {
    this.bounds = bounds;
    this.h = heightFn;
    this.surfaceFn = surfaceFn || (() => 'dirt');
    this.nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / CELL));
    this.nz = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / CELL));
    this.cells = new Array(this.nx * this.nz);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
    this.colliders = [];
    this.stamp = 1;
    this.smokes = [];          // {x,y,z,r} vision blockers, maintained by equipment.js
  }

  /**
   * Add a box. x,y,z = centre; hx,hy,hz = half extents; rot = yaw (radians).
   * Returns the collider so it can be removed later (doors, destroyed props).
   */
  addBox(o) {
    const c = {
      x: o.x, y: o.y, z: o.z, hx: o.hx, hy: o.hy, hz: o.hz,
      rot: o.rot || 0, cos: Math.cos(o.rot || 0), sin: Math.sin(o.rot || 0),
      flags: o.flags ?? WALL, mat: o.mat || 'stone', stamp: 0, tag: o.tag || null, dead: false,
      // world-space XZ bounding radius for the hash
      r: Math.sqrt(o.hx * o.hx + o.hz * o.hz),
    };
    this.colliders.push(c);
    this._insert(c);
    return c;
  }

  removeCollider(c) {
    if (!c || c.dead) return;
    c.dead = true;
    this._each(c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r, (cell) => {
      const i = cell.indexOf(c);
      if (i >= 0) cell.splice(i, 1);
    });
  }

  _insert(c) { this._each(c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r, (cell) => cell.push(c)); }

  _each(x0, z0, x1, z1, fn) {
    const b = this.bounds;
    let ix0 = Math.floor((x0 - b.minX) / CELL), ix1 = Math.floor((x1 - b.minX) / CELL);
    let iz0 = Math.floor((z0 - b.minZ) / CELL), iz1 = Math.floor((z1 - b.minZ) / CELL);
    if (ix1 < 0 || iz1 < 0 || ix0 >= this.nx || iz0 >= this.nz) return;
    if (ix0 < 0) ix0 = 0; if (iz0 < 0) iz0 = 0;
    if (ix1 >= this.nx) ix1 = this.nx - 1; if (iz1 >= this.nz) iz1 = this.nz - 1;
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) fn(this.cells[iz * this.nx + ix]);
  }

  surfaceAt(x, z) { return this.surfaceFn(x, z); }

  /**
   * Height the feet rest on at (x,z) for a body whose feet are at feetY:
   * terrain, or the top of a walkable box under the point if that top is no
   * more than `step` above the feet. `outInfo.mat` receives the box material
   * when standing on one.
   */
  groundHeight(x, z, feetY, step, outInfo) {
    let g = this.h(x, z);
    let mat = null;
    const b = this.bounds;
    const ix = Math.floor((x - b.minX) / CELL), iz = Math.floor((z - b.minZ) / CELL);
    if (ix >= 0 && iz >= 0 && ix < this.nx && iz < this.nz) {
      const cell = this.cells[iz * this.nx + ix];
      for (let i = 0; i < cell.length; i++) {
        const c = cell[i];
        if (!(c.flags & F.WALK)) continue;
        const top = c.y + c.hy;
        if (top <= g || top > feetY + step + 0.02) continue;
        const dx = x - c.x, dz = z - c.z;
        const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
        if (Math.abs(lx) <= c.hx + 0.12 && Math.abs(lz) <= c.hz + 0.12) { g = top; mat = c.mat; }
      }
    }
    if (outInfo) outInfo.mat = mat;
    return g;
  }

  /**
   * Move a capsule. body = { x,y,z, vx,vy,vz, radius, height, grounded, step }.
   * y is the FEET position. Mutates body; sets body.grounded, body.hitWall,
   * body.groundMat and body.landed (true on the step the body touches down,
   * with body.landSpeed = downward speed at impact).
   */
  move(body, dt, gravity) {
    const step = body.step ?? 0.5;
    const r = body.radius;
    const dx = body.vx * dt, dz = body.vz * dt;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const n = Math.max(1, Math.ceil(dist / (r * 0.5)));
    body.hitWall = false;
    for (let s = 0; s < n; s++) {
      body.x += dx / n; body.z += dz / n;
      this._resolveXZ(body, step);
    }
    // keep inside the level
    const b = this.bounds;
    if (body.x < b.minX + r) body.x = b.minX + r; else if (body.x > b.maxX - r) body.x = b.maxX - r;
    if (body.z < b.minZ + r) body.z = b.minZ + r; else if (body.z > b.maxZ - r) body.z = b.maxZ - r;

    // vertical
    const wasGrounded = body.grounded;
    const prevY = body.y;
    body.vy -= gravity * dt;
    let ny = body.y + body.vy * dt;
    // ceiling
    if (body.vy > 0) {
      const ceil = this._ceiling(body.x, body.z, r, prevY + body.height);
      if (ny + body.height > ceil) { ny = ceil - body.height; body.vy = 0; }
    }
    const info = this._info;
    const g = this.groundHeight(body.x, body.z, wasGrounded ? prevY : Math.max(prevY, ny), wasGrounded ? step : 0.1, info);
    body.landed = false;
    if (ny <= g) {
      if (!wasGrounded && body.vy < -1.5) { body.landed = true; body.landSpeed = -body.vy; }
      ny = g; body.vy = 0; body.grounded = true;
    } else if (wasGrounded && body.vy <= 0 && ny - g < step * 0.7) {
      // walking down a step or a slope: stay glued instead of hopping
      ny = g; body.vy = 0; body.grounded = true;
    } else {
      body.grounded = false;
    }
    body.y = ny;
    body.groundMat = info.mat;
  }

  _info = { mat: null };

  _resolveXZ(body, step) {
    const r = body.radius, feet = body.y, head = body.y + body.height;
    const b = this.bounds;
    let ix0 = Math.floor((body.x - r - b.minX) / CELL), ix1 = Math.floor((body.x + r - b.minX) / CELL);
    let iz0 = Math.floor((body.z - r - b.minZ) / CELL), iz1 = Math.floor((body.z + r - b.minZ) / CELL);
    if (ix0 < 0) ix0 = 0; if (iz0 < 0) iz0 = 0;
    if (ix1 >= this.nx) ix1 = this.nx - 1; if (iz1 >= this.nz) iz1 = this.nz - 1;
    const stamp = ++this.stamp;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const cell = this.cells[iz * this.nx + ix];
        for (let i = 0; i < cell.length; i++) {
          const c = cell[i];
          if (c.stamp === stamp) continue;
          c.stamp = stamp;
          if (!(c.flags & F.SOLID)) continue;
          const top = c.y + c.hy, bottom = c.y - c.hy;
          if (bottom >= head - 0.05) continue;                         // above the head
          if ((c.flags & F.WALK) && top <= feet + step + 0.02) continue; // low enough to step onto
          if (top <= feet + 0.02) continue;                            // below the feet
          // circle vs rotated rectangle, in the box's local frame
          const dx = body.x - c.x, dz = body.z - c.z;
          const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
          const cx = lx < -c.hx ? -c.hx : lx > c.hx ? c.hx : lx;
          const cz = lz < -c.hz ? -c.hz : lz > c.hz ? c.hz : lz;
          let px = lx - cx, pz = lz - cz;
          const d2 = px * px + pz * pz;
          if (d2 >= r * r) continue;
          let push;
          if (d2 > 1e-8) {
            const d = Math.sqrt(d2);
            push = (r - d) / d;
            px *= push; pz *= push;
          } else {
            // centre is inside the rectangle: leave by the nearest face
            const ex = c.hx - Math.abs(lx), ez = c.hz - Math.abs(lz);
            if (ex < ez) { px = (lx < 0 ? -1 : 1) * (ex + r); pz = 0; }
            else { px = 0; pz = (lz < 0 ? -1 : 1) * (ez + r); }
          }
          // back to world space
          const wx = px * c.cos + pz * c.sin, wz = -px * c.sin + pz * c.cos;
          body.x += wx; body.z += wz;
          // kill the velocity component going into the wall
          const len = Math.sqrt(wx * wx + wz * wz);
          if (len > 1e-6) {
            const nx = wx / len, nz = wz / len;
            const vn = body.vx * nx + body.vz * nz;
            if (vn < 0) { body.vx -= vn * nx; body.vz -= vn * nz; }
          }
          body.hitWall = true;
        }
      }
    }
  }

  /** Lowest box underside above headY whose footprint overlaps the circle. */
  _ceiling(x, z, r, headY) {
    let ceil = Infinity;
    this._each(x - r, z - r, x + r, z + r, (cell) => {
      for (let i = 0; i < cell.length; i++) {
        const c = cell[i];
        if (!(c.flags & F.SOLID)) continue;
        const bottom = c.y - c.hy;
        if (bottom < headY - 0.1 || bottom >= ceil) continue;
        const dx = x - c.x, dz = z - c.z;
        const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
        if (Math.abs(lx) <= c.hx + r * 0.7 && Math.abs(lz) <= c.hz + r * 0.7) ceil = bottom;
      }
    });
    return ceil;
  }

  /** Is there room for a capsule of this height at (x, feetY, z)? Used before standing up. */
  canFit(x, feetY, z, radius, height) {
    return this._ceiling(x, z, radius, feetY + 0.3) >= feetY + height;
  }

  /**
   * Ray vs world. Returns true and fills `hit` = { dist, x,y,z, nx,ny,nz,
   * collider, mat, terrain } with the nearest intersection within maxDist.
   * `mask` selects which collider flags stop the ray (F.BULLET for shots,
   * F.VISION for sight, F.SOLID for movement probes). `skip` is ignored.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, mask, hit, skip) {
    let best = maxDist;
    let bestC = null, bnx = 0, bny = 0, bnz = 0;
    const b = this.bounds;
    const stamp = ++this.stamp;

    // walk the grid cells under the ray (2D DDA in XZ)
    let cx = Math.floor((ox - b.minX) / CELL), cz = Math.floor((oz - b.minZ) / CELL);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const invX = Math.abs(dx) > 1e-9 ? 1 / Math.abs(dx) : Infinity;
    const invZ = Math.abs(dz) > 1e-9 ? 1 / Math.abs(dz) : Infinity;
    let tMaxX = invX === Infinity ? Infinity : ((dx > 0 ? (cx + 1) * CELL + b.minX - ox : ox - (cx * CELL + b.minX)) * invX);
    let tMaxZ = invZ === Infinity ? Infinity : ((dz > 0 ? (cz + 1) * CELL + b.minZ - oz : oz - (cz * CELL + b.minZ)) * invZ);
    const tDeltaX = invX * CELL, tDeltaZ = invZ * CELL;
    let t = 0;
    for (let guard = 0; guard < 400; guard++) {
      if (cx >= 0 && cz >= 0 && cx < this.nx && cz < this.nz) {
        const cell = this.cells[cz * this.nx + cx];
        for (let i = 0; i < cell.length; i++) {
          const c = cell[i];
          if (c.stamp === stamp) continue;
          c.stamp = stamp;
          if (!(c.flags & mask) || c === skip) continue;
          // ray into the box's local frame
          const rx = ox - c.x, rz = oz - c.z;
          const lox = rx * c.cos - rz * c.sin, loz = rx * c.sin + rz * c.cos, loy = oy - c.y;
          const ldx = dx * c.cos - dz * c.sin, ldz = dx * c.sin + dz * c.cos;
          // slabs
          let t0 = 0, t1 = best, axis = -1, sign = 0;
          // X
          if (Math.abs(ldx) < 1e-9) { if (Math.abs(lox) > c.hx) continue; }
          else {
            let a = (-c.hx - lox) / ldx, bb = (c.hx - lox) / ldx, s = -1;
            if (a > bb) { const q = a; a = bb; bb = q; s = 1; }
            if (a > t0) { t0 = a; axis = 0; sign = s; }
            if (bb < t1) t1 = bb;
            if (t0 > t1) continue;
          }
          // Y
          if (Math.abs(dy) < 1e-9) { if (Math.abs(loy) > c.hy) continue; }
          else {
            let a = (-c.hy - loy) / dy, bb = (c.hy - loy) / dy, s = -1;
            if (a > bb) { const q = a; a = bb; bb = q; s = 1; }
            if (a > t0) { t0 = a; axis = 1; sign = s; }
            if (bb < t1) t1 = bb;
            if (t0 > t1) continue;
          }
          // Z
          if (Math.abs(ldz) < 1e-9) { if (Math.abs(loz) > c.hz) continue; }
          else {
            let a = (-c.hz - loz) / ldz, bb = (c.hz - loz) / ldz, s = -1;
            if (a > bb) { const q = a; a = bb; bb = q; s = 1; }
            if (a > t0) { t0 = a; axis = 2; sign = s; }
            if (bb < t1) t1 = bb;
            if (t0 > t1) continue;
          }
          if (axis < 0 || t0 >= best) continue;     // started inside, or farther than best
          best = t0; bestC = c;
          if (axis === 0) { bnx = sign * c.cos; bny = 0; bnz = -sign * c.sin; }
          else if (axis === 1) { bnx = 0; bny = sign; bnz = 0; }
          else { bnx = sign * c.sin; bny = 0; bnz = sign * c.cos; }
        }
      }
      // advance to the next cell; stop once past the best hit
      if (tMaxX < tMaxZ) { t = tMaxX; tMaxX += tDeltaX; cx += stepX; }
      else { t = tMaxZ; tMaxZ += tDeltaZ; cz += stepZ; }
      if (t > best || t === Infinity) break;
      if (cx < -1 || cz < -1 || cx > this.nx || cz > this.nz) break;
    }

    // terrain: march, then bisect the crossing
    let terrain = false;
    {
      const stepLen = 0.8;
      let prevT = 0, prevAbove = oy - this.h(ox, oz);
      if (prevAbove >= 0) {
        for (let tt = stepLen; tt < best + stepLen; tt += stepLen) {
          const q = tt > best ? best : tt;
          const above = (oy + dy * q) - this.h(ox + dx * q, oz + dz * q);
          if (above < 0) {
            let lo = prevT, hi = q;
            for (let k = 0; k < 6; k++) {
              const mid = (lo + hi) * 0.5;
              if ((oy + dy * mid) - this.h(ox + dx * mid, oz + dz * mid) < 0) hi = mid; else lo = mid;
            }
            if (hi < best) { best = hi; bestC = null; terrain = true; bnx = 0; bny = 1; bnz = 0; }
            break;
          }
          prevT = q; prevAbove = above;
          if (q >= best) break;
        }
      }
    }

    if (best >= maxDist) return false;
    if (hit) {
      hit.dist = best;
      hit.x = ox + dx * best; hit.y = oy + dy * best; hit.z = oz + dz * best;
      hit.nx = bnx; hit.ny = bny; hit.nz = bnz;
      hit.collider = bestC; hit.terrain = terrain;
      hit.mat = bestC ? bestC.mat : this.surfaceFn(hit.x, hit.z);
    }
    return true;
  }

  /**
   * Line of sight between two points: true when nothing with F.VISION and no
   * smoke cloud lies between them.
   */
  los(ax, ay, az, bx, by, bz) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-4) return true;
    dx /= d; dy /= d; dz /= d;
    // smoke: segment vs sphere
    for (let i = 0; i < this.smokes.length; i++) {
      const s = this.smokes[i];
      const mx = s.x - ax, my = s.y - ay, mz = s.z - az;
      let tt = mx * dx + my * dy + mz * dz;
      tt = tt < 0 ? 0 : tt > d ? d : tt;
      const qx = ax + dx * tt - s.x, qy = ay + dy * tt - s.y, qz = az + dz * tt - s.z;
      if (qx * qx + qy * qy + qz * qz < s.r * s.r) return false;
    }
    return !this.raycast(ax, ay, az, dx, dy, dz, d - 0.05, F.VISION, null, null);
  }

  /** Is a point inside any smoke cloud? */
  inSmoke(x, y, z) {
    for (let i = 0; i < this.smokes.length; i++) {
      const s = this.smokes[i];
      const dx = x - s.x, dy = y - s.y, dz = z - s.z;
      if (dx * dx + dy * dy + dz * dz < s.r * s.r) return true;
    }
    return false;
  }
}
