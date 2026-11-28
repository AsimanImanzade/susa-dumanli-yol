/**
 * textures.js — procedural world textures (the always-available fallback)
 * plus optional replacement by image files listed in the asset manifest.
 *
 * Every surface is built from ONE height field, so its colour map, its
 * tangent-space normal map (TEX_NORMAL) and its ORM map (TEX_ORM: R ambient
 * occlusion, G roughness, B metalness) always agree. Everything lives on a
 * wrapping power-of-two grid and the noise is periodic, so every map tiles.
 *
 * Start-up cost: a small bank of periodic fBm fields is built once with
 * separable value noise (one lerp per pixel per octave); recipes only read it
 * at integer frequency multiples and offsets, which keeps them tileable and
 * cheap. Large surfaces are 1024 px, minor ones 512 (halved on Low).
 */
import * as THREE from 'three';
import { G } from './ctx.js';

export const TEX = {};
/** tangent-space normal maps, same keys as TEX (world surfaces only) */
export const TEX_NORMAL = {};
/** R = cavity AO, G = roughness, B = metalness; same keys as TEX */
export const TEX_ORM = {};
/** build time of the last initTextures() in ms, and the large-surface size */
export const TEX_STATS = { ms: 0, size: 0, workers: 0 };
/** metres covered by one repeat of each texture on world geometry */
export const TEX_SCALE = { stone: 2.6, plaster: 3.2, cobble: 1.5, rock: 5, forest: 4, roof: 2.4, wood: 1.8,
  dirt: 4, metal: 2, cloth: 1.2, concrete: 3, dark: 2, bark: 1.5 };

const SURFACES = ['stone', 'plaster', 'cobble', 'rock', 'forest', 'dirt', 'roof', 'wood', 'concrete', 'metal', 'cloth', 'dark', 'bark'];
const BIG = new Set(SURFACES.slice(0, 9));

/**
 * The whole generator, self-contained (no outside references) so it can run
 * both here and, serialised with toString(), inside blob workers that build
 * the set in parallel off the main thread.
 */
function texgen() {
/** mean sRGB colour of the previous (Lambert-era) set: albedo is matched to it so scenes keep their brightness and tint */
const TARGET = { stone: [144, 138, 122], plaster: [189, 181, 158], cobble: [97, 97, 94], rock: [102, 100, 95], forest: [56, 56, 36],
  roof: [103, 56, 41], wood: [78, 62, 44], dirt: [93, 81, 62], metal: [67, 71, 73], cloth: [123, 111, 81], concrete: [121, 121, 117],
  dark: [30, 32, 34], bark: [53, 44, 36] };

// ───────────────────────────── noise bank ─────────────────────────────
const BS = 10, BN = 1 << BS, BM = BN - 1;
let N0, N1, N2, N3;          // general · medium · fine grain · large patches

function rng(seed) { let s = Math.imul(seed, 2654435761) >>> 0 || 1; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
const hash = (x, y) => { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/** Periodic fBm on the BN² bank grid; separable: each octave interpolates p rows along x once, then one lerp per pixel. */
function fbmField(seed, p0, oct, gain) {
  const out = new Float32Array(BN * BN), x0 = new Int32Array(BN), x1 = new Int32Array(BN), wx = new Float32Array(BN);
  let amp = 1;
  for (let o = 0, p = p0; o < oct && p <= BN / 2; o++, p *= 2, amp *= gain) {
    const r = rng(seed * 131 + o * 7), lat = new Float32Array(p * p), cell = BN / p;
    for (let i = 0; i < p * p; i++) lat[i] = r();
    for (let x = 0; x < BN; x++) { const f = x / cell, i = f | 0, t = f - i; x0[x] = i; x1[x] = (i + 1) % p; wx[x] = t * t * (3 - 2 * t); }
    const rows = new Float32Array(p * BN);
    for (let j = 0; j < p; j++) {
      const lj = j * p, rj = j * BN;
      for (let x = 0; x < BN; x++) { const a = lat[lj + x0[x]]; rows[rj + x] = a + (lat[lj + x1[x]] - a) * wx[x]; }
    }
    for (let y = 0; y < BN; y++) {
      const f = y / cell, j = f | 0, t = f - j, w = t * t * (3 - 2 * t), a = j * BN, b = ((j + 1) % p) * BN, o2 = y * BN;
      for (let x = 0; x < BN; x++) { const ra = rows[a + x]; out[o2 + x] += amp * (ra + (rows[b + x] - ra) * w); }
    }
  }
  // normalise: mean 0.5, ±2.5σ → 0..1 (fBm piles up in the middle otherwise)
  let m = 0, v = 0;
  for (let i = 0; i < out.length; i += 7) m += out[i];
  m /= Math.ceil(out.length / 7);
  for (let i = 0; i < out.length; i += 7) v += (out[i] - m) * (out[i] - m);
  const k = 1 / (5 * Math.sqrt(v / Math.ceil(out.length / 7)));
  for (let i = 0; i < out.length; i++) { const t = 0.5 + (out[i] - m) * k; out[i] = t < 0 ? 0 : t > 1 ? 1 : t; }
  return out;
}
function bank() {
  if (N0) return;
  N0 = fbmField(1, 4, 8, 0.5); N1 = fbmField(2, 8, 7, 0.5); N2 = fbmField(3, 32, 5, 0.55); N3 = fbmField(4, 2, 5, 0.5);
}

// ───────────────────────────── surface buffers ─────────────────────────────
function surface(N) {
  const n = N * N, K = BN / N;
  const S = { N, M: N - 1, sh: Math.log2(N), s: N / 1024, alb: new Uint8ClampedArray(n * 4), h: new Float32Array(n), r: new Float32Array(n), m: null };
  /** bank field F at pixel (x, y), integer frequency multipliers sx/sy and bank-pixel offsets */
  S.at = (F, x, y, sx = 1, sy = sx, ox = 0, oy = 0) => F[(((y * sy * K) + oy) & BM) << BS | (((x * sx * K) + ox) & BM)];
  S.put = (i, R, Gc, B, h, r) => { const o = i << 2; S.alb[o] = R; S.alb[o + 1] = Gc; S.alb[o + 2] = B; S.h[i] = h; S.r[i] = r; };
  return S;
}
/** Run fn(i, dx, dy) over a wrapped square of radius R around (cx, cy). */
function stamp(S, cx, cy, R, fn) {
  const { M, sh } = S, r = Math.ceil(R), x0 = Math.floor(cx), y0 = Math.floor(cy);
  for (let y = y0 - r; y <= y0 + r; y++) {
    const row = (y & M) << sh, dy = y - cy;
    for (let x = x0 - r; x <= x0 + r; x++) fn(row | (x & M), x - cx, dy);
  }
}
const wrapD = (d, N) => d - Math.round(d / N) * N;

// ───────────────────────────── recipes ─────────────────────────────
// Each recipe fills S.alb (sRGB), S.h (0..1 height), S.r (roughness) and
// optionally S.m (metalness), then returns finishing options.
const RECIPES = {
  /** coursed limestone ashlar: uneven courses, staggered joints, chipped arrises, recessed sandy mortar */
  stone(S) {
    const { N, sh, s, at } = S, rnd = rng(101), rows = 6;
    const rowOf = new Int32Array(N), dyOf = new Float32Array(N), hs = [];
    let tot = 0;
    for (let i = 0; i < rows; i++) { const v = 0.8 + rnd() * 0.4; hs.push(v); tot += v; }
    for (let i = 0, y0 = 0; i < rows; i++) {
      const y1 = i === rows - 1 ? N : Math.round(y0 + hs[i] / tot * N);
      for (let y = y0; y < y1; y++) { rowOf[y] = i; dyOf[y] = Math.min(y - y0 + 0.5, y1 - y - 0.5); }
      y0 = y1;
    }
    const blk = new Int32Array(rows * N), dxOf = new Float32Array(rows * N);
    for (let i = 0; i < rows; i++) {
      const n = 2 + Math.floor(rnd() * 3), w = [], js = [];
      let t = 0, p = rnd() * N;
      for (let k = 0; k < n; k++) { const v = 0.6 + rnd() * 0.8; w.push(v); t += v; }
      for (let k = 0; k < n; k++) { js.push(p); p += w[k] / t * N; }
      for (let x = 0; x < N; x++) {
        let best = 1e9, id = 0, left = 1e9;
        for (let k = 0; k < n; k++) {
          const d = wrapD(x - js[k], N), a = Math.abs(d), l = ((x - js[k]) % N + N) % N;
          if (a < best) best = a;
          if (l < left) { left = l; id = k; }
        }
        blk[i * N + x] = i * 8 + id; dxOf[i * N + x] = best;
      }
    }
    const mw = 3.2 * s, bev = 9 * s, chipW = 7 * s;
    for (let y = 0; y < N; y++) {
      const row = rowOf[y], ey = dyOf[y];
      for (let x = 0; x < N; x++) {
        const i = (y << sh) | x, q = row * N + x, id = blk[q];
        const fine = at(N2, x, y), jag = (at(N2, x, y, 2, 2, 77, 0) - 0.5) * chipW + (at(N1, x, y, 1, 1, 300, 0) - 0.5) * chipW;
        const e = Math.min(dxOf[q], ey) + jag;
        if (e < mw) { const k = 0.78 + fine * 0.4; S.put(i, 110 * k, 104 * k, 92 * k, 0.1 + fine * 0.08, 0.97); continue; }
        const mott = at(N0, x, y, 1, 1, id * 97, id * 61), hb = hash(id, 7), tone = hash(id, 13);
        let R = 178, Gc = 170, B = 148;
        if (hb < 0.33) { R = 168; Gc = 164; B = 150; } else if (hb > 0.75) { R = 184; Gc = 168; B = 136; }
        const t = clamp01((e - mw) / bev), prof = t * (2 - t);
        const chipN = at(N1, x, y, 2, 2, id * 31, 0);
        const spall = e < mw + 24 * s && chipN > 0.62 ? (chipN - 0.62) * 2.6 : 0;
        const pit = fine < 0.2 ? (0.2 - fine) * 3 : 0;
        const streak = at(N3, x, y, 4, 1, 0, 500);
        let k = (0.88 + tone * 0.14) * (0.76 + mott * 0.4) * (0.9 + fine * 0.2) * (0.78 + 0.22 * prof) * (1 - pit * 0.25);
        k *= 1 - Math.max(0, streak - 0.58) * 0.5;                     // soft rain-washed grime runs
        if (spall > 0) k *= 1.06;
        const tool = at(N2, x, y, 4, 4, id * 13, 0);                     // dressed-face tooling and grain
        const h = 0.42 + 0.36 * prof + (mott - 0.5) * 0.16 + (fine - 0.5) * 0.08 + (tool - 0.5) * 0.06 - spall * 0.45 - pit * 0.12;
        S.put(i, R * k, Gc * k, B * k, h, 0.8 + (1 - mott) * 0.12 + spall * 0.2);
      }
    }
    return { normal: 9, ao: 3 };
  },

  /** lime render, wavy and stained, hairline cracks, fallen away in patches to show rubble masonry */
  plaster(S) {
    const { N, sh, s, at } = S, rows = 14, cols = 5;
    for (let y = 0; y < N; y++) {
      const fy = y * rows / N, row = fy | 0, ty = fy - row, eyPx = Math.min(ty, 1 - ty) * N / rows;
      for (let x = 0; x < N; x++) {
        const i = (y << sh) | x, n0 = at(N0, x, y), n3 = at(N3, x, y), fine = at(N2, x, y, 2), mid = at(N1, x, y, 2);
        const ex = n3 * 0.7 + mid * 0.3;
        if (ex > 0.73) {                                                // exposed rubble courses (small: they repeat every tile)
          const fx = x * cols / N + (row & 1) * 0.5, col = Math.floor(fx), tx = fx - col;
          const m = Math.min(Math.min(tx, 1 - tx) * N / cols, eyPx) + (fine - 0.5) * 5 * s;
          if (m < 2.6 * s) { const k = 0.6 + fine * 0.35; S.put(i, 92 * k, 86 * k, 74 * k, 0.08, 0.97); continue; }
          const k = (0.78 + hash(col % cols, row) * 0.32) * (0.84 + fine * 0.28);
          S.put(i, 156 * k, 144 * k, 120 * k, 0.22 + Math.min(1, (m - 2.6 * s) / (6 * s)) * 0.12 + fine * 0.05, 0.9);
          continue;
        }
        const lip = sstep(0.67, 0.73, ex);                              // render thins out towards the break
        const grime = Math.max(0, at(N3, x, y, 4, 1, 200, 0) - 0.55) * 0.32, damp = Math.max(0, 0.36 - n3) * 1.3;
        const speck = hash(x, y);
        let k = (0.86 + n0 * 0.2) * (0.92 + fine * 0.12) * (0.96 + speck * 0.08) * (1 - grime) * (1 - damp * 0.45) * (1 + lip * 0.05);
        const h = 0.62 + (n0 - 0.5) * 0.12 + (fine - 0.5) * 0.05 + speck * 0.012 - lip * 0.1;
        S.put(i, 200 * k, (192 + damp * 6) * k, (170 - damp * 4) * k, h, 0.9 - damp * 0.12);
      }
    }
    // hairline cracks: a few wandering walks with the odd branch, ending where the render has fallen off
    const { M, alb } = S, rnd = rng(61);
    const walk = (x, y, a, len, depth) => {
      for (let j = 0; j < len; j++) {
        a += (rnd() - 0.5) * 0.35; x += Math.cos(a); y += Math.sin(a);
        const i = ((Math.floor(y) & M) << sh) | (Math.floor(x) & M), o = i << 2;
        if (S.h[i] < 0.45) return;
        alb[o] *= 0.6; alb[o + 1] *= 0.6; alb[o + 2] *= 0.6; S.h[i] -= 0.1;
        if (depth < 2 && rnd() < 0.012) walk(x, y, a + (rnd() < 0.5 ? 0.8 : -0.8), len * 0.4, depth + 1);
      }
    };
    for (let c = 0; c < 7; c++) walk(rnd() * N, rnd() * N, rnd() * Math.PI * 2, (70 + rnd() * 170) * s, 0);
    return { normal: 8, ao: 3 };
  },

  /** rounded setts on a Voronoi layout; the joints hold dark wet grit (low roughness) */
  cobble(S) {
    const { N, sh, at } = S, n = 8, cell = N / n;
    const px = new Float32Array(n * n), py = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { px[j * n + i] = i + 0.18 + hash(i, j) * 0.64; py[j * n + i] = j + 0.18 + hash(j + 31, i + 17) * 0.64; }
    const PAL = [[118, 118, 114], [138, 132, 122], [100, 102, 102], [128, 120, 108], [110, 106, 98]];
    const cx9 = new Float32Array(9), cy9 = new Float32Array(9);
    for (let y = 0; y < N; y++) {
      const gy = y / cell, cy = Math.floor(gy);
      for (let x = 0; x < N; x++) {
        const gx = x / cell, cx = Math.floor(gx);
        let b1 = 1e9, k1 = 0, id = 0, q = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++, q++) {
          const ci = cx + di, cj = cy + dj, wi = (ci + n) % n, wj = (cj + n) % n, k = wj * n + wi;
          const ux = px[k] + ci - wi, uy = py[k] + cj - wj, d = (gx - ux) * (gx - ux) + (gy - uy) * (gy - uy);
          cx9[q] = ux; cy9[q] = uy;
          if (d < b1) { b1 = d; k1 = q; id = k; }
        }
        // distance to the nearest bisector = true edge distance
        let e = 1e9;
        const ax = cx9[k1], ay = cy9[k1];
        for (let q2 = 0; q2 < 9; q2++) {
          if (q2 === k1) continue;
          const bx = cx9[q2], by = cy9[q2], dx = bx - ax, dy = by - ay, L = Math.sqrt(dx * dx + dy * dy);
          const v = ((gx - (ax + bx) / 2) * dx + (gy - (ay + by) / 2) * dy) / L;
          if (-v < e) e = -v;
        }
        const i = (y << sh) | x, fine = at(N2, x, y, 2), n0 = at(N0, x, y, 2);
        e += (at(N1, x, y, 2) - 0.5) * 0.07;
        const g = 0.04;
        if (e < g) { const k = 0.7 + fine * 0.5; S.put(i, 44 * k, 43 * k, 40 * k, 0.04 + fine * 0.05, 0.3); continue; }
        const t = sstep(g, g + 0.16, e), d1 = Math.sqrt(b1), c = PAL[id % 5];
        const k = (0.8 + n0 * 0.32) * (0.9 + fine * 0.2) * (0.68 + 0.32 * t) * (0.88 + hash(id, 3) * 0.24);
        S.put(i, c[0] * k, c[1] * k, c[2] * k, 0.18 + 0.5 * t + 0.16 * (1 - d1) + (fine - 0.5) * 0.07, 0.5 + d1 * 0.22 + (1 - t) * 0.15);
      }
    }
    return { normal: 6, ao: 3.5 };
  },

  /** bedded limestone: terraced layers with weathered ledges, vertical joints, lichen */
  rock(S) {
    const { N, sh, at } = S;
    for (let y = 0; y < N; y++) {
      const v = y / N;
      for (let x = 0; x < N; x++) {
        const i = (y << sh) | x, n0 = at(N0, x, y), n3 = at(N3, x, y), n1 = at(N1, x, y, 2), fine = at(N2, x, y, 2);
        const L = v * 11 + (n3 - 0.5) * 1.4 + (n0 - 0.5) * 0.5, b = Math.floor(L), f = L - b, band = ((b % 11) + 11) % 11;
        const ledge = sstep(0, 0.12, f) * (1 - f * 0.4);
        const joint = Math.abs(at(N3, x, y, 4, 1, 700, 0) - 0.5);
        let h = 0.25 + ledge * 0.36 + (n1 - 0.5) * 0.28 + (fine - 0.5) * 0.12;
        let k = (0.8 + n1 * 0.28) * (0.86 + fine * 0.28) * (0.68 + ledge * 0.36);
        if (f < 0.035) { h -= 0.12; k *= 0.7; }                         // open bedding plane
        if (joint < 0.012 && at(N1, x, y, 1, 1, 10, 10) > 0.45) { const d = 1 - joint / 0.012; h -= 0.3 * d; k *= 1 - 0.55 * d; }
        const hb = hash(band, 3), warm = hash(band, 9) > 0.7 ? 1 : 0;
        let R = lerp(110, 142, hb) + warm * 8, Gc = lerp(108, 136, hb), B = lerp(102, 122, hb) - warm * 8;
        const li = at(N2, x, y, 1, 1, 123, 45), lich = li > 0.72 && n3 > 0.42 ? Math.min(1, (li - 0.72) * 8) : 0;
        R = lerp(R, 150, lich * 0.6); Gc = lerp(Gc, 156, lich * 0.6); B = lerp(B, 128, lich * 0.6);
        S.put(i, R * k, Gc * k, B * k, h + lich * 0.03, 0.86 + fine * 0.1);
      }
    }
    return { normal: 8, ao: 3 };
  },

  /** forest floor: dark soil and moss under drifts of fallen leaves, pine needles and twigs */
  forest(S) {
    const { N, M, sh, s, at, alb, h, r } = S, rnd = rng(77);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y << sh) | x, n0 = at(N0, x, y, 2), n1 = at(N1, x, y, 2), n3 = at(N3, x, y), fine = at(N2, x, y, 2);
      const k = (0.72 + n0 * 0.45) * (0.85 + hash(x, y) * 0.3), m = sstep(0.6, 0.72, n3 * 0.6 + n1 * 0.4) * 0.5, mk = 0.8 + fine * 0.4;
      S.put(i, lerp(50 * k, 42 * mk, m), lerp(42 * k, 50 * mk, m), lerp(30 * k, 30 * mk, m), 0.12 + n0 * 0.12 + m * 0.1 + fine * 0.05, 0.95 - m * 0.1);
    }
    const LC = [[118, 80, 40], [140, 98, 48], [96, 58, 34], [74, 52, 34], [150, 120, 62], [88, 70, 40], [104, 46, 30]];
    const leaves = Math.round(3000 * s * s);
    for (let n = 0; n < leaves; n++) {
      // 5–12 cm leaves; the litter thins out over the moss patches
      const cx = rnd() * N, cy = rnd() * N, a = (11 + rnd() * 14) * s, b = a * (0.42 + rnd() * 0.16), ang = rnd() * Math.PI;
      if (at(N3, cx | 0, cy | 0) > 0.62 && rnd() < 0.7) continue;
      const ca = Math.cos(ang), sa = Math.sin(ang), c = LC[(rnd() * LC.length) | 0], k = 0.6 + rnd() * 0.5, top = 0.32 + rnd() * 0.1, curl = rnd() * 0.08;
      stamp(S, cx, cy, a + 1, (i, dx, dy) => {
        const lx = (dx * ca + dy * sa) / a, ly = (-dx * sa + dy * ca) / b, w = 1 - Math.max(0, lx) * 0.45;   // pointed tip
        const q = lx * lx + (ly / w) * (ly / w);
        if (q > 1) return;
        const kk = k * (Math.abs(ly) < 0.08 ? 0.78 : 1) * (q > 0.78 ? 0.8 : 1), o = i << 2;
        alb[o] = c[0] * kk; alb[o + 1] = c[1] * kk; alb[o + 2] = c[2] * kk;
        h[i] = top + (1 - q) * 0.05 + Math.abs(ly) * curl; r[i] = 0.7;
      });
    }
    const line = (x0, y0, len, ang, w, R, Gc, B, ht, rough) => {
      const dx = Math.cos(ang), dy = Math.sin(ang);
      for (let j = 0; j < len; j++) {
        const px = x0 + dx * j, py = y0 + dy * j;
        if (w <= 1) { const i = ((Math.floor(py) & M) << sh) | (Math.floor(px) & M), o = i << 2; alb[o] = R; alb[o + 1] = Gc; alb[o + 2] = B; h[i] = ht; r[i] = rough; }
        else stamp(S, px, py, w / 2, (i, ex, ey) => { if (ex * ex + ey * ey > w * w / 4) return; const o = i << 2; alb[o] = R; alb[o + 1] = Gc; alb[o + 2] = B; h[i] = ht + 0.05; r[i] = rough; });
      }
    };
    const needles = Math.round(4200 * s * s);
    for (let n = 0; n < needles; n++) { const k = 0.7 + rnd() * 0.5, dry = rnd() < 0.6; line(rnd() * N, rnd() * N, (10 + rnd() * 14) * s, rnd() * Math.PI * 2, 1, (dry ? 110 : 82) * k, (dry ? 78 : 66) * k, (dry ? 42 : 44) * k, 0.48, 0.68); }
    const twigs = Math.round(50 * s * s);
    for (let n = 0; n < twigs; n++) { const k = 0.7 + rnd() * 0.4; line(rnd() * N, rnd() * N, (30 + rnd() * 50) * s, rnd() * Math.PI * 2, (2 + rnd() * 1.5) * s, 62 * k, 48 * k, 34 * k, 0.55, 0.85); }
    return { normal: 7, ao: 3 };
  },

  /** corrugated sheet roofing: faded red paint, rust blooms and runs, bare worn metal, lapped seams with screws */
  roof(S) {
    const { N, sh, s, at } = S, ridges = 12, seams = 2, sw = N / ridges, sl = N / seams;
    S.m = new Float32Array(N * N);
    const PROF = new Float32Array(N);
    for (let x = 0; x < N; x++) PROF[x] = 0.5 - 0.5 * Math.cos(((x * ridges / N) % 1) * Math.PI * 2);
    for (let y = 0; y < N; y++) {
      const sv = (y * seams / N) % 1;
      for (let x = 0; x < N; x++) {
        const i = (y << sh) | x, ph = (x * ridges / N) % 1, prof = PROF[x], ri = Math.floor(x * ridges / N);
        const n1 = at(N1, x, y, 2), n3 = at(N3, x, y), fine = at(N2, x, y, 2), run = at(N1, x, y, 6, 1, 50, 0);
        // rust: blooms where water sits, plus runs weeping down from the lap and screws above
        const below = (1 - sv) * (1 - sv) * (1 - sv);
        const ru = n3 * 0.35 + n1 * 0.35 + fine * 0.15 + run * below * 0.5 + (1 - prof) * 0.06 - 0.06;
        const rust = sstep(0.56, 0.66, ru), bare = sstep(0.52, 0.56, ru) * (1 - rust) * 0.5;
        const pk = (0.85 + n1 * 0.2) * (0.94 + fine * 0.12), fade = at(N0, x, y) * 0.35;
        let R = lerp(124 * pk, 128 * pk, fade), Gc = lerp(62 * pk, 94 * pk, fade), B = lerp(44 * pk, 82 * pk, fade);
        R = lerp(R, 96, bare); Gc = lerp(Gc, 94, bare); B = lerp(B, 90, bare);
        const rf = at(N2, x, y, 4, 4, 9, 9);
        R = lerp(R, lerp(140, 76, rf), rust); Gc = lerp(Gc, lerp(76, 44, rf), rust); B = lerp(B, lerp(38, 28, rf), rust);
        let k = 0.76 + 0.24 * prof, hh = 0.25 + prof * 0.5 + rust * (rf - 0.5) * 0.12 + (1 - sv) * 0.04, rough = lerp(0.55, 0.93, rust) - bare * 0.2, metal = bare * 0.9;
        if (sv > 0.985) { k *= 0.55; hh -= 0.05; }                     // shadow under the lap of the sheet above
        const sdx = (ph - 0.5) * sw, sdy = (sv - 0.03) * sl;
        if (ri % 2 === 0 && sdx * sdx + sdy * sdy < 10 * s * s) { R = 120; Gc = 118; B = 112; k = 1; hh += 0.05; rough = 0.4; metal = 0.8; }
        S.put(i, R * k, Gc * k, B * k, hh, rough); S.m[i] = metal;
      }
    }
    return { normal: 10, ao: 2 };
  },

  /** weathered planks: wavy grain bent round knots, raised latewood, open joints and nails */
  wood(S) {
    const { N, sh, s, at } = S, rnd = rng(55), planks = 5, pw = N / planks;
    const joint = [], knots = [];
    for (let p = 0; p < planks; p++) {
      joint.push(rnd() * N);
      const kn = [], c = rnd() < 0.3 ? 0 : rnd() < 0.6 ? 1 : 2;
      for (let j = 0; j < c; j++) kn.push({ x: (0.25 + rnd() * 0.5) * pw, y: rnd() * N, r: (9 + rnd() * 10) * s });
      knots.push(kn);
    }
    const gapW = 1.6 * s, bevW = 4 * s;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y << sh) | x, p = Math.floor(x / pw), lx = x - p * pw, fx = lx / pw;
      const jd = Math.abs(wrapD(y - joint[p], N)), edge = Math.min(lx, pw - lx, jd);
      if (edge < gapW) { const k = 0.8 + at(N2, x, y) * 0.3; S.put(i, 34 * k, 26 * k, 20 * k, 0.05, 0.95); continue; }
      let warp = 0, core = 0;
      for (const kn of knots[p]) {
        const dx = lx - kn.x, dy = wrapD(y - kn.y, N), d2 = (dx * dx + dy * dy * 0.3) / (kn.r * kn.r);
        warp += (dx / kn.r) * Math.exp(-d2 * 0.4) * 0.9;
        if (d2 < 1) core = Math.max(core, 1 - d2);
      }
      const fib = at(N2, x, y, 4, 1), g = fx * 9 + p * 0.37 + at(N1, x, y, 4, 1) * 0.45 + at(N0, x, y, 1, 1, p * 200, 0) * 0.7 + warp;
      const late = sstep(0.72, 0.94, g - Math.floor(g));
      const hb = hash(p, 3), wg = at(N3, x, y) * 0.5 + hash(p, 9) * 0.3;
      const k = (0.86 + fib * 0.22) * (1 - late * 0.28) * (1 - core * 0.5);
      const R = lerp(lerp(108, 86, hb), 112, wg * 0.5), Gc = lerp(lerp(88, 70, hb), 106, wg * 0.5), B = lerp(lerp(62, 50, hb), 96, wg * 0.5);
      let hh = 0.6 + late * 0.05 + (fib - 0.5) * 0.06 - core * 0.06 - (1 - Math.min(1, (edge - gapW) / bevW)) * 0.2;
      let nk = 1;
      if (jd < 14 * s) for (const ny of [-10 * s, 10 * s]) for (const nx of [pw * 0.22, pw * 0.78]) {   // nail heads beside each butt joint
        const ddx = lx - nx, ddy = wrapD(y - joint[p] - ny, N);
        if (ddx * ddx + ddy * ddy < 5 * s * s) { nk = 0; hh += 0.02; }
      }
      if (!nk) S.put(i, 58, 56, 54, hh, 0.5);
      else S.put(i, R * k, Gc * k, B * k, hh, 0.8 + fib * 0.12);
    }
    return { normal: 8, ao: 3 };
  },

  /** packed earth: pebbles, damp hollows, drying cracks */
  dirt(S) {
    const { N, sh, s, at, alb, h, r } = S, rnd = rng(91);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y << sh) | x, n0 = at(N0, x, y, 2), n1 = at(N1, x, y, 2), fine = at(N2, x, y, 2), n3 = at(N3, x, y);
      const damp = sstep(0.32, 0.18, n3), grain = hash(x, y), clod = at(N2, x, y, 4, 4, 0, 300);
      let k = (0.8 + n0 * 0.32) * (0.84 + fine * 0.3) * (0.88 + grain * 0.24) * (0.9 + clod * 0.2) * (1 - damp * 0.3);
      let hh = 0.3 + n0 * 0.2 + (fine - 0.5) * 0.1 + (clod - 0.5) * 0.08 + grain * 0.02 - damp * 0.05;
      const c = Math.abs(at(N1, x, y, 2, 2, 400, 0) - 0.5);
      if (c < 0.009 && n3 > 0.5) { const d = 1 - c / 0.009; hh -= 0.1 * d; k *= 1 - 0.35 * d; }
      S.put(i, lerp(80, 106, n1) * k, lerp(70, 94, n1) * k, lerp(52, 72, n1) * k, hh, 0.95 - damp * 0.4);
    }
    const PC = [[120, 116, 106], [96, 88, 74], [140, 130, 112], [108, 98, 84]];
    for (let n = Math.round(1800 * s * s); n > 0; n--) {
      const rad = (2 + rnd() * rnd() * 6) * s, c = PC[(rnd() * 4) | 0], k = 0.75 + rnd() * 0.4;
      stamp(S, rnd() * N, rnd() * N, rad + 1, (i, dx, dy) => {
        const q = (dx * dx + dy * dy) / (rad * rad);
        if (q > 1) return;
        const o = i << 2, kk = k * (0.8 + 0.2 * (1 - q));
        alb[o] = c[0] * kk; alb[o + 1] = c[1] * kk; alb[o + 2] = c[2] * kk; h[i] = Math.max(h[i], 0.5 + (1 - q) * 0.2); r[i] = 0.8;
      });
    }
    return { normal: 7, ao: 3 };
  },

  /** cast concrete: board-form lines, aggregate speckle, blowholes, run-off stains */
  concrete(S) {
    const { N, sh, s, at, alb, h, r } = S, rnd = rng(13), lift = N / 4;
    for (let y = 0; y < N; y++) {
      const fl = Math.min(y % lift, lift - (y % lift));
      for (let x = 0; x < N; x++) {
        const i = (y << sh) | x, n0 = at(N0, x, y), fine = at(N2, x, y, 2), n3 = at(N3, x, y), st = at(N3, x, y, 4, 1, 0, 300), g = hash(x, y);
        let k = (0.86 + n0 * 0.18) * (0.92 + fine * 0.16) * (0.94 + g * 0.12) * (1 - Math.max(0, st - 0.58) * 0.35);
        let hh = 0.5 + (n0 - 0.5) * 0.05 + (fine - 0.5) * 0.06 + g * 0.015;
        if (fl < 1.2 * s) { hh -= 0.04; k *= 0.9; }
        S.put(i, 128 * k * (1 + n3 * 0.03), 128 * k, 124 * k * (1 - n3 * 0.03), hh, 0.86 + fine * 0.08);
      }
    }
    for (let n = Math.round(500 * s * s); n > 0; n--) {
      const rad = (0.8 + rnd() * 1.8) * s;
      stamp(S, rnd() * N, rnd() * N, rad + 1, (i, dx, dy) => {
        const q = (dx * dx + dy * dy) / (rad * rad);
        if (q > 1) return;
        const o = i << 2; alb[o] *= 0.55; alb[o + 1] *= 0.55; alb[o + 2] *= 0.55; h[i] -= 0.15 * (1 - q); r[i] = 0.95;
      });
    }
    return { normal: 6, ao: 2.5 };
  },

  /** painted steel: dents, brushing, chipped paint with bare metal and a rust halo, scratches */
  metal(S) {
    const { N, sh, s, at, alb, h, r } = S, rnd = rng(29);
    S.m = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y << sh) | x, n0 = at(N0, x, y), brush = at(N2, x, y, 1, 8), chip = at(N1, x, y, 2, 2, 90, 0);
      const bare = sstep(0.67, 0.69, chip), halo = sstep(0.6, 0.67, chip) * (1 - bare), k = (0.84 + n0 * 0.26) * (0.95 + brush * 0.1);
      let R = lerp(72 * k, 104, halo), Gc = lerp(78 * k, 62, halo), B = lerp(74 * k, 36, halo);
      R = lerp(R, 128 * k, bare); Gc = lerp(Gc, 128 * k, bare); B = lerp(B, 124 * k, bare);
      S.put(i, R, Gc, B, 0.6 - bare * 0.06 + (n0 - 0.5) * 0.1, lerp(lerp(0.5, 0.9, halo), 0.35, bare)); S.m[i] = bare * 0.9;
    }
    for (let n = Math.round(80 * s * s); n > 0; n--) {
      const x0 = rnd() * N, y0 = rnd() * N, ang = rnd() * Math.PI, len = (10 + rnd() * 40) * s;
      for (let j = 0; j < len; j++) {
        const i = ((Math.floor(y0 + Math.sin(ang) * j) & S.M) << sh) | (Math.floor(x0 + Math.cos(ang) * j) & S.M), o = i << 2;
        alb[o] = 120; alb[o + 1] = 120; alb[o + 2] = 116; h[i] -= 0.02; r[i] = 0.4; S.m[i] = 0.8;
      }
    }
    return { normal: 6, ao: 2 };
  },

  /** woven canvas: over-under threads, fibre noise, stains */
  cloth(S) {
    const { N, sh, s, at } = S, p = Math.max(2, Math.round(8 * s));
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y << sh) | x, over = (((x / p) | 0) + ((y / p) | 0)) & 1;
      const wp = Math.sin(Math.PI * ((x % p) + 0.5) / p), wf = Math.sin(Math.PI * ((y % p) + 0.5) / p), th = over ? wp : wf;
      const n0 = at(N0, x, y), n3 = at(N3, x, y), fine = at(N2, x, y, 2), k = (0.86 + n0 * 0.22) * (0.84 + th * 0.2) * (0.94 + fine * 0.12) * (1 - Math.max(0, 0.3 - n3) * 0.8);
      S.put(i, 128 * k, 116 * k, 84 * k, 0.5 + th * 0.3, 0.96);
    }
    return { normal: 4, ao: 1.5 };
  },

  /** dark glazing and grime: smooth with smudges, so windows catch a faint reflection */
  dark(S) {
    const { N, sh, at } = S;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y << sh) | x, n0 = at(N0, x, y), sm = at(N1, x, y, 2), dust = Math.max(0, at(N1, x, y, 4, 1, 0, 200) - 0.55);
      const k = (0.8 + n0 * 0.4) * (1 + dust * 0.8);
      S.put(i, 30 * k, 32 * k, 35 * k, 0.5 + (n0 - 0.5) * 0.02, 0.26 + sm * 0.4 + dust);
    }
    return { normal: 3, ao: 0.5 };
  },

  /** deeply furrowed bark: vertical ridged plates, moss in the cracks */
  bark(S) {
    const { N, sh, at } = S;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y << sh) | x, fur = Math.abs(at(N1, x, y, 4, 1) - 0.5) * 2, plate = sstep(0.04, 0.3, fur);
      const fine = at(N2, x, y, 2, 1), n3 = at(N3, x, y), moss = n3 > 0.62 ? (1 - plate) * Math.min(1, (n3 - 0.62) * 6) : 0;
      const k = (0.5 + plate * 0.6) * (0.88 + fine * 0.24);
      S.put(i, lerp(62 * k, 46, moss), lerp(52 * k, 60, moss), lerp(42 * k, 32, moss), 0.2 + plate * 0.6 + (fine - 0.5) * 0.1, 0.95);
    }
    return { normal: 9, ao: 3 };
  },
};

// ───────────────────────────── finishing ─────────────────────────────
const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const L2S = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055) * 255;

/** Wrapped box-average of h at 1/f resolution, read back with bilinear filtering. */
function blurred(h, N, f) {
  const n = N / f, lo = new Float32Array(n * n), sh = Math.log2(N), inv = 1 / (f * f);
  for (let y = 0; y < N; y++) { const ly = ((y / f) | 0) * n, row = y << sh; for (let x = 0; x < N; x++) lo[ly + ((x / f) | 0)] += h[row | x]; }
  for (let i = 0; i < lo.length; i++) lo[i] *= inv;
  const out = new Float32Array(N * N), m = n - 1;
  for (let y = 0; y < N; y++) {
    const fy = y / f - 0.5 + 1 / (2 * f), y0 = Math.floor(fy), ty = fy - y0, a = ((y0 + n) & m) * n, b = ((y0 + 1 + n) & m) * n, row = y << sh;
    for (let x = 0; x < N; x++) {
      const fx = x / f - 0.5 + 1 / (2 * f), x0 = Math.floor(fx), tx = fx - x0, i0 = (x0 + n) & m, i1 = (x0 + 1 + n) & m;
      const top = lo[a + i0] + (lo[a + i1] - lo[a + i0]) * tx, bot = lo[b + i0] + (lo[b + i1] - lo[b + i0]) * tx;
      out[row | x] = top + (bot - top) * ty;
    }
  }
  return out;
}

/**
 * Turn a filled surface into GPU-ready bytes: normal map from the height
 * gradient, cavity AO from height below its local mean, albedo matched to the
 * target mean (in linear light) with the cavity lightly baked in. Normal and
 * ORM rows are written bottom-up so they upload with flipY = false and line up
 * with the canvas-based colour map (which three uploads flipped).
 */
function finish(S, name, o) {
  const { N, h, r, alb } = S, M = N - 1, sh = S.sh, n = N * N;
  const nrm = new Uint8Array(n * 4), orm = new Uint8Array(n * 4);
  const k = (o.normal || 8) * S.s * 0.5 * 4;
  const b1 = blurred(h, N, Math.max(2, 8 * S.s)), b2 = blurred(h, N, Math.max(4, 32 * S.s)), aoK = o.ao ?? 2.5;
  const cav = new Float32Array(n);
  for (let y = 0; y < N; y++) {
    const row = y << sh, up = ((y - 1) & M) << sh, dn = ((y + 1) & M) << sh, flip = (M - y) << sh;
    for (let x = 0; x < N; x++) {
      const i = row | x, nx = (h[row | ((x - 1) & M)] - h[row | ((x + 1) & M)]) * k, ny = (h[dn | x] - h[up | x]) * k;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1), q = (flip | x) << 2;
      nrm[q] = (nx * inv * 0.5 + 0.5) * 255; nrm[q + 1] = (ny * inv * 0.5 + 0.5) * 255; nrm[q + 2] = (inv * 0.5 + 0.5) * 255; nrm[q + 3] = 255;
      const c = 1 - Math.min(0.85, (Math.max(0, b1[i] - h[i]) + Math.max(0, b2[i] - h[i]) * 0.6) * aoK);
      cav[i] = c;
      orm[q] = c * 255; orm[q + 1] = clamp01(r[i]) * 255; orm[q + 2] = S.m ? clamp01(S.m[i]) * 255 : 0; orm[q + 3] = 255;
    }
  }
  // bake a little cavity into the colour (direct light ignores aoMap), then match the target mean per channel
  const sum = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const o4 = i << 2, b = 0.8 + 0.2 * cav[i];
    alb[o4] *= b; alb[o4 + 1] *= b; alb[o4 + 2] *= b; alb[o4 + 3] = 255;
    sum[0] += S2L[alb[o4]]; sum[1] += S2L[alb[o4 + 1]]; sum[2] += S2L[alb[o4 + 2]];
  }
  const tgt = TARGET[name];
  if (tgt) {
    const lut = [0, 1, 2].map((c) => {
      const g = Math.min(1.8, Math.max(0.55, S2L[tgt[c]] / (sum[c] / n || 1e-4))), t = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) t[v] = L2S(Math.min(1, S2L[v] * g)) + 0.5;
      return t;
    });
    for (let i = 0; i < n; i++) { const o4 = i << 2; alb[o4] = lut[0][alb[o4]]; alb[o4 + 1] = lut[1][alb[o4 + 1]]; alb[o4 + 2] = lut[2][alb[o4 + 2]]; }
  }
  return { alb, nrm, orm };
}

return {
  /** one surface's bytes at N×N: { alb (sRGB RGBA, rows top-down), nrm, orm (rows bottom-up) } */
  buildSurface(name, N) { bank(); const S = surface(N); return finish(S, name, RECIPES[name](S)); },
  free() { N0 = N1 = N2 = N3 = null; },
};
}

let inline = null;
/** Build one surface on this thread (exported for timing and tests). */
export function buildSurface(name, N) { return (inline || (inline = texgen())).buildSurface(name, N); }

/**
 * Build every job ({ name, N }) on up to four blob workers, largest first.
 * Resolves to Map name → bytes. Any worker failure falls back to this thread.
 */
function buildAll(jobs) {
  const out = new Map();
  const runInline = (list) => { TEX_STATS.workers = 0; for (const j of list) if (!out.has(j.name)) out.set(j.name, buildSurface(j.name, j.N)); if (inline) inline.free(); return out; };
  let url = null, workers = [];
  try {
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1, jobs.length));
    if (typeof Worker === 'undefined' || n < 2) return Promise.resolve(runInline(jobs));
    const src = `const api = (${texgen.toString()})();
self.onmessage = (e) => { const d = api.buildSurface(e.data.name, e.data.N); self.postMessage({ name: e.data.name, d }, [d.alb.buffer, d.nrm.buffer, d.orm.buffer]); };`;
    url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const queue = [...jobs].sort((a, b) => b.N - a.N);
    TEX_STATS.workers = n;
    return new Promise((resolve) => {
      let done = false;
      const end = (fallback) => {
        if (done) return; done = true;
        for (const w of workers) w.terminate();
        URL.revokeObjectURL(url);
        resolve(fallback ? runInline(jobs) : out);
      };
      const feed = (w) => { const j = queue.shift(); if (j) w.postMessage(j); else if (out.size === jobs.length) end(false); };
      for (let i = 0; i < n; i++) {
        const w = new Worker(url);
        w.onmessage = (e) => { out.set(e.data.name, e.data.d); feed(w); };
        w.onerror = () => end(true);
        workers.push(w);
        feed(w);
      }
    });
  } catch {
    for (const w of workers) w.terminate();
    if (url) URL.revokeObjectURL(url);
    return Promise.resolve(runInline(jobs));
  }
}

// ───────────────────────────── non-tiled sprites ─────────────────────────────
/** Azerbaijani tricolour with crescent and eight-pointed star. Not tiled. */
function flagCanvas() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#00b5e2'; g.fillRect(0, 0, 512, 86);
  g.fillStyle = '#ef3340'; g.fillRect(0, 85, 512, 86);
  g.fillStyle = '#509e2f'; g.fillRect(0, 170, 512, 86);
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(244, 128, 30, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ef3340';
  g.beginPath(); g.arc(252, 128, 25, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.beginPath();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? 6.5 : 15;
    g[i ? 'lineTo' : 'moveTo'](280 + Math.cos(a) * r, 128 + Math.sin(a) * r);
  }
  g.closePath(); g.fill();
  return c;
}

/** Soft round sprite for smoke, dust and muzzle flash. */
function puffCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.5, 'rgba(255,255,255,0.45)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return c;
}

function tiled(tex, aniso, colorSpace) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = colorSpace;
  tex.anisotropy = aniso;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}
function dataTex(bytes, N, aniso) {
  const t = new THREE.DataTexture(bytes, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.flipY = false;
  t.needsUpdate = true;
  return tiled(t, aniso, THREE.NoColorSpace);
}

/**
 * Build every procedural texture, then swap in generated files from the
 * manifest (manifest.textures = { stone: 'assets/textures/stone.jpg', ... }).
 * A file that fails to load simply leaves the procedural version in place; a
 * file that loads marks the texture (userData.file) so materials stop pairing
 * it with the procedural normal/ORM maps it no longer matches.
 */
export async function initTextures(renderer, manifest) {
  const t0 = performance.now();
  const aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const big = G.texDetail === 'low' ? 512 : 1024;
  const built = await buildAll(SURFACES.map((name) => ({ name, N: BIG.has(name) ? big : big / 2 })));
  for (const name of SURFACES) {
    const N = BIG.has(name) ? big : big / 2, d = built.get(name);
    const c = document.createElement('canvas'); c.width = c.height = N;
    c.getContext('2d').putImageData(new ImageData(d.alb, N, N), 0, 0);
    TEX[name] = tiled(new THREE.CanvasTexture(c), aniso, THREE.SRGBColorSpace);
    TEX_NORMAL[name] = dataTex(d.nrm, N, aniso);
    TEX_ORM[name] = dataTex(d.orm, N, aniso);
  }
  TEX.flag = new THREE.CanvasTexture(flagCanvas());
  TEX.flag.colorSpace = THREE.SRGBColorSpace;
  TEX.puff = new THREE.CanvasTexture(puffCanvas());
  TEX_STATS.ms = Math.round(performance.now() - t0); TEX_STATS.size = big;
  if (G.debug) console.info(`[textures] ${SURFACES.length} surfaces built in ${TEX_STATS.ms} ms at ${big}px`);

  const files = (manifest && manifest.textures) || {};
  const loader = new THREE.ImageLoader();
  const report = { loaded: [], failed: [] };
  const jobs = Object.keys(files).filter((n) => TEX[n]).map((name) => new Promise((resolve) => {
    loader.load(files[name], (img) => {
      TEX[name].image = img; TEX[name].needsUpdate = true; TEX[name].userData.file = true;
      report.loaded.push(name); resolve();
    }, undefined, () => { report.failed.push(name); resolve(); });
  }));
  return Promise.all(jobs).then(() => report);
}

// ───────────────────────────── interiors: floorboards, wallpaper, veneer, carpets, pictures ─────────────────────────────
/*
 * Built on the main thread the first time a level with enterable houses is finalised, then kept for
 * every later level: floorboards and the carpet atlas 1024 px, wallpaper and veneer 512 px (halved on
 * Low). Colour, normal and roughness of a surface come from one height field, like the world set.
 */
const ih = (x, y, s) => { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
/** periodic value noise: u, v in [0,1) tile with px × py cells per repeat */
function pvn(u, v, px, py, s) {
  const x = u * px, y = v * py, xi = Math.floor(x), yi = Math.floor(y), tx = x - xi, ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px, y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py;
  const a = ih(x0, y0, s), b = ih(x1, y0, s), c = ih(x0, y1, s), d = ih(x1, y1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function pfb(u, v, px, py, oct, s) { let t = 0, amp = 0.5, n = 0; for (let o = 0; o < oct; o++) { t += pvn(u, v, px << o, py << o, s + o * 17) * amp; n += amp; amp *= 0.5; } return t / n; }
const sst = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function seeded(seed) { let s = seed >>> 0 || 1; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }

/** colour (sRGB bytes), height and roughness arrays → tiling DataTextures (rows top-down, flipY off) */
function packMaps(N, col, hgt, rough, nk, aniso) {
  const n = N * N, nrm = new Uint8Array(n * 4), rg = new Uint8Array(n * 4), M = N - 1;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, q = i * 4;
    const dx = (hgt[y * N + ((x + 1) & M)] - hgt[y * N + ((x - 1) & M)]) * nk, dy = (hgt[((y + 1) & M) * N + x] - hgt[((y - 1) & M) * N + x]) * nk;
    const l = 1 / Math.sqrt(dx * dx + dy * dy + 1);
    nrm[q] = (-dx * l * 0.5 + 0.5) * 255; nrm[q + 1] = (-dy * l * 0.5 + 0.5) * 255; nrm[q + 2] = (l * 0.5 + 0.5) * 255; nrm[q + 3] = 255;
    rg[q] = 255; rg[q + 1] = Math.min(1, Math.max(0, rough[i])) * 255; rg[q + 3] = 255;
  }
  const mk = (bytes, cs) => { const t = new THREE.DataTexture(bytes, N, N, THREE.RGBAFormat, THREE.UnsignedByteType); t.flipY = false; t.needsUpdate = true; return tiled(t, aniso, cs); };
  return { map: mk(col, THREE.SRGBColorSpace), normal: mk(nrm, THREE.NoColorSpace), rough: mk(rg, THREE.NoColorSpace) };
}
const put3 = (col, i, r, g, b) => { const q = i * 4; col[q] = r * 255; col[q + 1] = g * 255; col[q + 2] = b * 255; col[q + 3] = 255; };

/** Floorboards, one repeat = 2.4 m: 16 boards along v, butt joints, grain round the odd knot, nails over the joists. */
function floorMaps(N, aniso) {
  const n = N * N, col = new Uint8ClampedArray(n * 4), hgt = new Float32Array(n), rough = new Float32Array(n);
  const NP = 16, r = seeded(911), boards = [], pw = N / NP;
  for (let i = 0; i < NP; i++) {
    const nj = r() < 0.55 ? 2 : 1, j0 = r(), joints = [];
    for (let k = 0; k < nj; k++) joints.push((j0 + k / nj + (r() - 0.5) * 0.18 + 1) % 1);
    joints.sort((a, b) => a - b);
    boards.push({ joints, seg: joints.map(() => ({ tone: 0.8 + r() * 0.34, warm: (r() - 0.5) * 0.12, off: r() * 7, knot: r() < 0.4 ? [r() * 0.5 + 0.15, 0.25 + r() * 0.5] : null })) });
  }
  for (let y = 0; y < N; y++) {
    const v = y / N;
    for (let x = 0; x < N; x++) {
      const u = x / N, pu = u * NP, pi = Math.floor(pu), fu = pu - pi, P = boards[pi];
      let si = P.joints.length - 1, dj = 1;
      for (let k = 0; k < P.joints.length; k++) { if (v >= P.joints[k]) si = k; const d = Math.abs(v - P.joints[k]); dj = Math.min(dj, d, 1 - d); }
      const S = P.seg[si];
      let kn = 0, swirl = 0;
      if (S.knot) {
        const vk = (P.joints[si] + S.knot[0]) % 1, dv = Math.abs(v - vk), dkv = Math.min(dv, 1 - dv) * N, dku = (fu - S.knot[1]) * pw;
        const e = (dku / 4.5) ** 2 + (dkv / 10) ** 2;
        kn = e < 1 ? 1 - e : 0; swirl = 1.6 / (e + 0.35);
      }
      const warp = pfb(u, v, NP, 4, 3, 17 + pi * 3);
      const ph = fu * 3.2 + warp * 2.6 + S.off + v * 0.6 + swirl;
      const ring = Math.pow(0.5 + 0.5 * Math.sin(ph * 6.2832), 4);
      const fine = pvn(u, v, N / 2, 6, 23 + pi), wear = pfb(u, v, 3, 3, 3, 41);
      const edge = Math.min(fu, 1 - fu) * pw, seam = Math.min(sst(0.5, 1.7, edge), sst(0.6, 1.9, dj * N));
      let nail = 0;
      for (let jv = 0; jv < 4; jv++) {
        const dvp = (v - (jv + 0.5) / 4) * N;
        if (Math.abs(dvp) > 3) continue;
        for (const nu of [0.2, 0.8]) { const dup = (fu - nu) * pw, d2 = dup * dup + dvp * dvp; if (d2 < 4.5) nail = Math.max(nail, 1 - d2 / 4.5); }
      }
      let k = S.tone * (1 - 0.2 * ring) * (0.92 + 0.12 * fine) * (0.9 + 0.16 * wear) * (1 - 0.45 * kn);
      k *= (0.3 + 0.7 * seam) * (1 - 0.55 * nail);
      const i = y * N + x;
      put3(col, i, Math.min(1, 0.74 * k * (1 + S.warm)), 0.55 * k, Math.min(1, 0.38 * k * (1 - S.warm)));
      hgt[i] = seam * (1 - 0.05 * ring) - nail * 0.3;
      rough[i] = 0.46 + 0.2 * (1 - wear) + (1 - seam) * 0.4 + ring * 0.06;
    }
  }
  return packMaps(N, col, hgt, rough, 3.2 * N / 1024, aniso);
}

/** Embossed wallpaper, one repeat ≈ 0.56 m: rosettes in a half-drop between narrow double stripes, tone on tone (tinted per room). */
function paperMaps(N, aniso) {
  const n = N * N, col = new Uint8ClampedArray(n * 4), hgt = new Float32Array(n), rough = new Float32Array(n);
  const wrap = (d) => d - Math.round(d);
  for (let y = 0; y < N; y++) {
    const v = y / N;
    for (let x = 0; x < N; x++) {
      const u = x / N;
      // stripes at u = 0 and 0.5
      const ds = Math.abs(wrap(u * 2) / 2) * N, stripe = Math.max(1 - sst(0.6, 1.6, Math.abs(ds - 5)), 1 - sst(0.6, 1.6, Math.abs(ds - 9)));
      // rosettes at (0.25, 0.25) and (0.75, 0.75), vines between them
      let m = 0;
      for (const [cx, cy] of [[0.25, 0.25], [0.75, 0.75], [0.25, 1.25], [0.75, -0.25]]) {
        const dx = wrap(u - cx), dy = v - cy - Math.round(v - cy), rr = Math.hypot(dx, dy * 0.85), th = Math.atan2(dy, dx);
        const petal = rr < 0.062 * (0.68 + 0.32 * Math.cos(6 * th)) ? 1 : 0;
        const ring = 1 - sst(0.003, 0.0065, Math.abs(rr - 0.094));
        const core = rr < 0.018 ? 1 : 0;
        // leaf pairs above and below
        let leaf = 0;
        for (const sg of [-1, 1]) for (const sx of [-1, 1]) { const lx = dx - sx * 0.045, ly = dy - sg * 0.15; const e = (lx * Math.cos(0.7 * sx * sg) + ly * Math.sin(0.7 * sx * sg)) ** 2 / 0.0011 + (-lx * Math.sin(0.7 * sx * sg) + ly * Math.cos(0.7 * sx * sg)) ** 2 / 0.00018; if (e < 1) leaf = 1; }
        m = Math.max(m, petal * (core ? 0.5 : 1), ring, leaf * 0.85);
      }
      const vx = Math.abs(wrap(u * 2 - 0.5) / 2 - 0.022 * Math.sin(v * 6.2832 * 2)), vine = 1 - sst(0.0025, 0.005, vx);
      m = Math.max(m, vine * 0.8);
      const grain = 0.97 + 0.05 * pvn(u, v, 96, 96, 5) + 0.02 * pvn(u, v, 7, 7, 9);
      const k = grain * (1 - 0.1 * m - 0.12 * stripe);
      const i = y * N + x;
      put3(col, i, 0.95 * k, 0.92 * k * (1 - 0.03 * m), 0.86 * k * (1 - 0.08 * m));
      hgt[i] = m * 0.6 + stripe * 0.2 + grain * 0.15;
      rough[i] = 0.86 - m * 0.18;
    }
  }
  return packMaps(N, col, hgt, rough, 1.4 * N / 512, aniso);
}

/** Lacquered veneer, one repeat ≈ 0.9 m, grain along u. */
function veneerMaps(N, aniso) {
  const n = N * N, col = new Uint8ClampedArray(n * 4), hgt = new Float32Array(n), rough = new Float32Array(n);
  for (let y = 0; y < N; y++) {
    const v = y / N;
    for (let x = 0; x < N; x++) {
      const u = x / N, warp = pfb(u, v, 2, 6, 4, 61);
      const ring = Math.pow(0.5 + 0.5 * Math.sin((v * 14 + warp * 3.2) * 6.2832), 3), pores = pvn(u, v, 6, N / 2, 67), cloud = pfb(u, v, 3, 3, 2, 71);
      const k = (0.86 - 0.24 * ring) * (0.93 + 0.1 * pores) * (0.93 + 0.12 * cloud), i = y * N + x;
      put3(col, i, 0.68 * k, 0.47 * k, 0.3 * k);
      hgt[i] = -0.12 * ring + 0.06 * pores;
      rough[i] = 0.36 + 0.12 * ring + 0.06 * pores;
    }
  }
  return packMaps(N, col, hgt, rough, 1.2 * N / 512, aniso);
}

// carpet atlas (1024 units; v = 1 − y/1024 since canvas textures upload flipped)
/** the three carpets (x, y, w, h, border) and the runner, whose middle repeats along its length */
export const CARPET_CELLS = [
  { x: 0, y: 0, w: 512, h: 512, b: 76 }, { x: 512, y: 0, w: 512, h: 512, b: 76 }, { x: 0, y: 512, w: 512, h: 512, b: 76 },
  { x: 512, y: 512, w: 512, h: 192, b: 32 },
];
/** framed pictures (landscapes, still lifes), then the map and the clock dial */
export const PICTURE_CELLS = Array.from({ length: 8 }, (_, i) => ({ x: 512 + (i % 4) * 128, y: 704 + Math.floor(i / 4) * 160, w: 128, h: 160 }));
const CP = { red: '#8e2420', madder: '#7a1c1a', rust: '#a8452c', indigo: '#1f2a52', navy: '#161d38', ivory: '#e9ddc1', cream: '#d6c49a', yellow: '#cf9d3e', green: '#3f6b4c', teal: '#2d6a66', pink: '#c26a5c', brown: '#4e2f22', black: '#221a18' };

function carpetAtlas(S, aniso) {
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), r = seeded(4242);
  g.scale(S / 1024, S / 1024);
  const poly = (pts, col) => { g.fillStyle = col; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); };
  const rect = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const star8 = (x, y, rr, col) => { const p = []; for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8, q = i % 2 ? rr * 0.48 : rr; p.push([x + Math.cos(a) * q, y + Math.sin(a) * q]); } poly(p, col); };
  const diamond = (x, y, rx, ry, col) => poly([[x, y - ry], [x + rx, y], [x, y + ry], [x - rx, y]], col);
  const stepped = (x, y, rx, ry, nS, col) => {
    const q = [];
    for (let i = 0; i < nS; i++) q.push([rx * i / nS, -ry * (1 - i / nS)], [rx * (i + 1) / nS, -ry * (1 - i / nS)]);
    q.push([rx, 0]);
    const rev = q.slice().reverse();
    poly([...q.map(([a, b]) => [x + a, y + b]), ...rev.map(([a, b]) => [x + a, y - b]).slice(1), ...q.map(([a, b]) => [x - a, y - b]).slice(1), ...rev.map(([a, b]) => [x - a, y + b]).slice(1)], col);
  };
  const octagon = (x, y, rr, col) => { const p = []; for (let i = 0; i < 8; i++) { const a = (i + 0.5) * Math.PI / 4; p.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]); } poly(p, col); };
  const circle = (x, y, rr, col) => { g.fillStyle = col; g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill(); };
  const gul = (x, y, rr, a, b, cc) => { octagon(x, y, rr, CP.ivory); octagon(x, y, rr * 0.86, a); diamond(x, y, rr * 0.62, rr * 0.62, b); star8(x, y, rr * 0.36, cc); };
  const rosette = (x, y, rr, petal, mid, core) => { for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; circle(x + Math.cos(a) * rr * 0.62, y + Math.sin(a) * rr * 0.62, rr * 0.38, petal); } circle(x, y, rr * 0.5, mid); circle(x, y, rr * 0.22, core); };
  /** border bands round a cell; motif(cx, cy, s, horiz) along the main band; returns the field rect */
  const frame = (X, Y, W, H, B, pal, motif, period) => {
    rect(X, Y, W, H, pal.outer);
    const g1 = B * 0.12, m0 = B * 0.24, m1 = B * 0.8;
    rect(X + g1, Y + g1, W - 2 * g1, H - 2 * g1, pal.guard);
    rect(X + m0 - 2, Y + m0 - 2, W - 2 * m0 + 4, H - 2 * m0 + 4, pal.line);
    rect(X + m0, Y + m0, W - 2 * m0, H - 2 * m0, pal.main);
    const bw = m1 - m0;
    for (const horiz of [true, false]) {
      const len = horiz ? W - 2 * m0 : H - 2 * m0, nM = Math.max(1, Math.round(len / period)), step = len / nM;
      for (let i = 0; i < nM; i++) {
        const t = (horiz ? X : Y) + m0 + step * (i + 0.5);
        if (horiz) { motif(t, Y + m0 + bw / 2, bw, true); motif(t, Y + H - m0 - bw / 2, bw, true); }
        else { motif(X + m0 + bw / 2, t, bw, false); motif(X + W - m0 - bw / 2, t, bw, false); }
      }
    }
    for (const [cx, cy] of [[X + m0 + bw / 2, Y + m0 + bw / 2], [X + W - m0 - bw / 2, Y + m0 + bw / 2], [X + m0 + bw / 2, Y + H - m0 - bw / 2], [X + W - m0 - bw / 2, Y + H - m0 - bw / 2]]) { rect(cx - bw / 2, cy - bw / 2, bw, bw, pal.main); star8(cx, cy, bw * 0.36, pal.accent); }
    rect(X + m1 - 3, Y + m1 - 3, W - 2 * m1 + 6, H - 2 * m1 + 6, pal.line);
    rect(X + m1, Y + m1, W - 2 * m1, H - 2 * m1, pal.guard2);
    const f0 = B;
    rect(X + f0, Y + f0, W - 2 * f0, H - 2 * f0, pal.field);
    // abrash: the field's wool from different dye lots
    for (let yy = Y + f0; yy < Y + H - f0; yy += 6) if (r() < 0.25) { g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,240,220,0.05)'; g.fillRect(X + f0, yy, W - 2 * f0, 6 + Math.floor(r() * 10)); }
    // tiny dots on the guards
    const go = (gA, gB, lo, hi) => {
      for (let t = lo; t < hi; t += 9) for (const e of [gA, gB]) { circle(X + t, Y + e, 1.6, pal.dot); circle(X + t, Y + H - e, 1.6, pal.dot); }
      for (let t = lo; t < H - (W - hi); t += 9) for (const e of [gA, gB]) { circle(X + e, Y + t, 1.6, pal.dot); circle(X + W - e, Y + t, 1.6, pal.dot); }
    };
    go((g1 + m0) / 2, (g1 + m0) / 2, g1 + 4, W - g1 - 4);
    go((m1 + f0) / 2, (m1 + f0) / 2, m1 + 4, W - m1 - 4);
    return { x0: X + f0, y0: Y + f0, x1: X + W - f0, y1: Y + H - f0 };
  };
  const scatter = (F, n, avoid, draw) => { for (let i = 0, k = 0; i < n && k < n * 8; k++) { const x = F.x0 + 10 + r() * (F.x1 - F.x0 - 20), y = F.y0 + 10 + r() * (F.y1 - F.y0 - 20); if (avoid(x, y)) continue; draw(x, y); i++; } };

  // A: madder field, stepped indigo medallion with pendants, spandrels in the corners, ivory crab border
  {
    const C = CARPET_CELLS[0];
    const F = frame(C.x, C.y, C.w, C.h, C.b, { outer: CP.indigo, guard: CP.red, guard2: CP.red, line: CP.black, main: CP.ivory, field: CP.madder, accent: CP.red, dot: CP.ivory },
      (x, y, s, h) => { diamond(x, y, s * 0.36, s * 0.36, CP.indigo); diamond(x, y, s * 0.2, s * 0.2, CP.red); for (const sg of [-1, 1]) { const dx = h ? sg * s * 0.42 : 0, dy = h ? 0 : sg * s * 0.42; star8(x + dx, y + dy, s * 0.09, CP.green); } }, 46);
    const cx = (F.x0 + F.x1) / 2, cy = (F.y0 + F.y1) / 2, fw = F.x1 - F.x0, fh = F.y1 - F.y0;
    for (const sx of [0, 1]) for (const sy of [0, 1]) {
      const x = sx ? F.x1 : F.x0, y = sy ? F.y1 : F.y0;
      g.save(); g.beginPath(); g.rect(F.x0, F.y0, fw, fh); g.clip();
      stepped(x, y, fw * 0.24, fh * 0.2, 4, CP.ivory); stepped(x, y, fw * 0.19, fh * 0.155, 4, CP.indigo); stepped(x, y, fw * 0.1, fh * 0.08, 3, CP.yellow);
      g.restore();
    }
    for (const sg of [-1, 1]) { stepped(cx, cy + sg * fh * 0.33, fw * 0.12, fh * 0.09, 3, CP.ivory); stepped(cx, cy + sg * fh * 0.33, fw * 0.09, fh * 0.065, 3, CP.teal); star8(cx, cy + sg * fh * 0.33, fw * 0.035, CP.ivory); rect(cx - 3, cy + sg * fh * 0.2 - 10, 6, 20, CP.ivory); }
    stepped(cx, cy, fw * 0.34, fh * 0.24, 6, CP.ivory); stepped(cx, cy, fw * 0.31, fh * 0.215, 6, CP.indigo);
    stepped(cx, cy, fw * 0.2, fh * 0.14, 4, CP.ivory); stepped(cx, cy, fw * 0.17, fh * 0.115, 4, CP.red);
    star8(cx, cy, fw * 0.075, CP.ivory); star8(cx, cy, fw * 0.04, CP.indigo);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) diamond(cx + dx * fw * 0.245, cy + dy * fh * 0.17, 7, 7, CP.yellow);
    const inMed = (x, y) => Math.abs(x - cx) / (fw * 0.37) + Math.abs(y - cy) / (fh * 0.27) < 1 || Math.abs(x - cx) < fw * 0.15 && Math.abs(Math.abs(y - cy) - fh * 0.33) < fh * 0.12 || (Math.min(x - F.x0, F.x1 - x) / (fw * 0.26) + Math.min(y - F.y0, F.y1 - y) / (fh * 0.22) < 1);
    scatter(F, 34, inMed, (x, y) => { const k = r(); if (k < 0.35) star8(x, y, 6, CP.ivory); else if (k < 0.6) diamond(x, y, 5, 8, CP.yellow); else if (k < 0.8) { diamond(x, y, 6, 6, CP.green); diamond(x, y, 2.5, 2.5, CP.ivory); } else rect(x - 2, y - 7, 4, 14, CP.indigo); });
  }
  // B: indigo field with rose medallions and sprays, red border with ivory rosettes
  {
    const C = CARPET_CELLS[1];
    const F = frame(C.x, C.y, C.w, C.h, C.b, { outer: CP.madder, guard: CP.yellow, guard2: CP.yellow, line: CP.black, main: CP.red, field: CP.navy, accent: CP.ivory, dot: CP.red },
      (x, y, s) => rosette(x, y, s * 0.3, CP.ivory, CP.pink, CP.yellow), 44);
    const cx = (F.x0 + F.x1) / 2, cy = (F.y0 + F.y1) / 2, fw = F.x1 - F.x0, fh = F.y1 - F.y0;
    circle(cx, cy, fw * 0.25, CP.ivory); circle(cx, cy, fw * 0.235, CP.red);
    for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; circle(cx + Math.cos(a) * fw * 0.17, cy + Math.sin(a) * fw * 0.17, fw * 0.045, CP.pink); }
    rosette(cx, cy, fw * 0.11, CP.ivory, CP.rust, CP.yellow);
    for (const sg of [-1, 1]) { circle(cx, cy + sg * fh * 0.36, fw * 0.1, CP.ivory); rosette(cx, cy + sg * fh * 0.36, fw * 0.085, CP.pink, CP.red, CP.yellow); }
    for (const [sx, sy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { g.save(); g.beginPath(); g.rect(F.x0, F.y0, fw, fh); g.clip(); circle(sx ? F.x1 : F.x0, sy ? F.y1 : F.y0, fw * 0.16, CP.red); circle(sx ? F.x1 : F.x0, sy ? F.y1 : F.y0, fw * 0.11, CP.ivory); g.restore(); }
    const avoid = (x, y) => Math.hypot(x - cx, y - cy) < fw * 0.28 || Math.hypot(x - cx, Math.abs(y - cy) - fh * 0.36) < fw * 0.13 || Math.min(Math.hypot(x - F.x0, y - F.y0), Math.hypot(x - F.x1, y - F.y0), Math.hypot(x - F.x0, y - F.y1), Math.hypot(x - F.x1, y - F.y1)) < fw * 0.19;
    scatter(F, 26, avoid, (x, y) => { g.strokeStyle = CP.green; g.lineWidth = 2.5; g.beginPath(); g.moveTo(x - 9, y + 9); g.quadraticCurveTo(x, y + 2, x + 8, y - 8); g.stroke(); circle(x + 8, y - 8, 5.5, r() < 0.5 ? CP.pink : CP.rust); circle(x + 8, y - 8, 2.2, CP.yellow); diamond(x - 4, y + 2, 3, 6, CP.green); });
  }
  // C: red field with an indigo lattice, small güls in the lozenges, indigo border with a running-dog zigzag
  {
    const C = CARPET_CELLS[2];
    const F = frame(C.x, C.y, C.w, C.h, C.b, { outer: CP.red, guard: CP.ivory, guard2: CP.ivory, line: CP.black, main: CP.indigo, field: CP.red, accent: CP.yellow, dot: CP.red },
      (x, y, s, h) => { const a = s * 0.26; g.strokeStyle = CP.ivory; g.lineWidth = 4; g.beginPath(); if (h) { g.moveTo(x - 22, y + a); g.lineTo(x - 11, y - a); g.lineTo(x, y + a); g.lineTo(x + 11, y - a); g.lineTo(x + 22, y + a); } else { g.moveTo(x + a, y - 22); g.lineTo(x - a, y - 11); g.lineTo(x + a, y); g.lineTo(x - a, y + 11); g.lineTo(x + a, y + 22); } g.stroke(); }, 44);
    const fw = F.x1 - F.x0, fh = F.y1 - F.y0, nx = 4, ny = 4, sx = fw / nx, sy = fh / ny;
    g.save(); g.beginPath(); g.rect(F.x0, F.y0, fw, fh); g.clip();
    g.strokeStyle = CP.indigo; g.lineWidth = 5;
    for (let i = -ny; i <= nx + ny; i++) { g.beginPath(); g.moveTo(F.x0 + i * sx, F.y0); g.lineTo(F.x0 + (i - ny) * sx, F.y1); g.stroke(); g.beginPath(); g.moveTo(F.x0 + i * sx, F.y0); g.lineTo(F.x0 + (i + ny) * sx, F.y1); g.stroke(); }
    const pals = [[CP.teal, CP.ivory, CP.red], [CP.yellow, CP.indigo, CP.ivory], [CP.ivory, CP.red, CP.indigo]];
    for (let j = 0; j <= ny * 2; j++) for (let i = 0; i <= nx * 2; i++) if ((i + j) % 2 === 1) { const p = pals[(i + 2 * j) % 3]; gul(F.x0 + i * sx / 2, F.y0 + j * sy / 2, Math.min(sx, sy) * 0.2, p[0], p[1], p[2]); }
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) star8(F.x0 + i * sx, F.y0 + j * sy, 6, CP.yellow);
    g.restore();
  }
  // D: the runner — red field, a row of güls whose period divides the field so the middle repeats seamlessly
  {
    const C = CARPET_CELLS[3];
    const F = frame(C.x, C.y, C.w, C.h, C.b, { outer: CP.indigo, guard: CP.red, guard2: CP.red, line: CP.black, main: CP.ivory, field: CP.red, accent: CP.indigo, dot: CP.ivory },
      (x, y, s) => { diamond(x, y, s * 0.3, s * 0.3, CP.indigo); diamond(x, y, s * 0.12, s * 0.12, CP.yellow); }, 26);
    const fh = F.y1 - F.y0, cy = (F.y0 + F.y1) / 2, per = (F.x1 - F.x0) / 7;
    for (let i = 0; i < 7; i++) { const x = F.x0 + per * (i + 0.5); gul(x, cy, fh * 0.32, i % 2 ? CP.teal : CP.indigo, i % 2 ? CP.ivory : CP.yellow, CP.red); star8(F.x0 + per * i, cy - fh * 0.32, 5, CP.ivory); star8(F.x0 + per * i, cy + fh * 0.32, 5, CP.ivory); }
  }
  // pictures: mountains, pomegranates, a lake, an autumn wood, roses, a village; then a map and the clock dial
  const P = PICTURE_CELLS;
  const lin = (x, y0, y1, stops) => { const gr = g.createLinearGradient(x, y0, x, y1); stops.forEach(([t, c2]) => gr.addColorStop(t, c2)); return gr; };
  const ridge = (C, y, amp, col, seed) => { const rr = seeded(seed); const pts = [[C.x, C.y + C.h]]; for (let i = 0; i <= 16; i++) pts.push([C.x + C.w * i / 16, y - rr() * amp]); pts.push([C.x + C.w, C.y + C.h]); poly(pts, col); };
  {
    const C = P[0];
    rect(C.x, C.y, C.w, C.h, lin(0, C.y, C.y + C.h * 0.6, [[0, '#8fb0c8'], [1, '#e8dcc0']]));
    ridge(C, C.y + 60, 30, '#7d8ea6', 1); ridge(C, C.y + 82, 26, '#5f7088', 2); ridge(C, C.y + 108, 20, '#5b7a4a', 3); ridge(C, C.y + 130, 12, '#3e5a36', 4);
    poly([[C.x + 70, C.y + 34], [C.x + 84, C.y + 52], [C.x + 56, C.y + 52]], '#f0eee8');
    for (let i = 0; i < 6; i++) { const x = C.x + 10 + i * 21, y = C.y + 128 + (i % 2) * 8; poly([[x, y - 22], [x + 7, y], [x - 7, y]], '#2a3e26'); }
  }
  {
    const C = P[1];
    rect(C.x, C.y, C.w, C.h, lin(0, C.y, C.y + C.h, [[0, '#3a2a20'], [1, '#1c1410']]));
    rect(C.x, C.y + 112, C.w, 48, '#5a3a24'); rect(C.x, C.y + 112, C.w, 4, '#7a5234');
    poly([[C.x + 84, C.y + 112], [C.x + 112, C.y + 112], [C.x + 106, C.y + 62], [C.x + 98, C.y + 54], [C.x + 90, C.y + 62]], '#a8642e'); circle(C.x + 98, C.y + 54, 5, '#c07a3a');
    for (const [x, y, rr] of [[34, 104, 15], [58, 108, 13], [46, 88, 12]]) { circle(C.x + x, C.y + y, rr, '#8e1e1c'); circle(C.x + x - rr * 0.3, C.y + y - rr * 0.35, rr * 0.35, '#c4483a'); poly([[C.x + x - 3, C.y + y - rr], [C.x + x + 3, C.y + y - rr], [C.x + x + 4, C.y + y - rr - 6], [C.x + x - 4, C.y + y - rr - 6]], '#5a1410'); }
    for (let i = 0; i < 5; i++) circle(C.x + 70 + i * 4, C.y + 120 + (i % 2) * 3, 2.2, '#d64a48');
  }
  {
    const C = P[2];
    rect(C.x, C.y, C.w, C.h, lin(0, C.y, C.y + 80, [[0, '#a8c4d8'], [1, '#f2e6cc']]));
    ridge(C, C.y + 76, 16, '#6c8a74', 5);
    rect(C.x, C.y + 84, C.w, 40, lin(0, C.y + 84, C.y + 124, [[0, '#7aa0b8'], [1, '#3e6278']]));
    ridge(C, C.y + 132, 8, '#4e6e3c', 6);
    for (const x of [18, 30, 104]) { rect(C.x + x, C.y + 70, 3, 74, '#ece8de'); for (let k = 0; k < 6; k++) circle(C.x + x + (k % 2 ? 6 : -4), C.y + 66 + k * 9, 7, k % 2 ? '#7a9a3e' : '#5e8034'); }
  }
  {
    const C = P[3];
    rect(C.x, C.y, C.w, C.h, lin(0, C.y, C.y + C.h, [[0, '#d8c08a'], [1, '#6a4a2a']]));
    poly([[C.x + 54, C.y + C.h], [C.x + 74, C.y + C.h], [C.x + 66, C.y + 96], [C.x + 62, C.y + 96]], '#c8a870');
    for (let i = 0; i < 9; i++) { const x = C.x + 8 + i * 14 + (i % 3) * 2; rect(x, C.y + 50, 4, 70, '#3a2818'); for (let k = 0; k < 4; k++) circle(x + (k % 2 ? 7 : -5), C.y + 42 + k * 10 + (i % 2) * 6, 10, ['#c8641e', '#d8a02a', '#a8401a', '#e0b84a'][(i + k) % 4]); }
  }
  {
    const C = P[4];
    rect(C.x, C.y, C.w, C.h, lin(0, C.y, C.y + C.h, [[0, '#2e4a3a'], [1, '#18261e']]));
    poly([[C.x + 50, C.y + 150], [C.x + 78, C.y + 150], [C.x + 84, C.y + 112], [C.x + 72, C.y + 96], [C.x + 56, C.y + 96], [C.x + 44, C.y + 112]], '#d8dce4'); rect(C.x + 50, C.y + 116, 28, 6, '#3a5a9a');
    for (const [x, y, c2] of [[52, 70, '#b8202a'], [72, 62, '#d84858'], [62, 46, '#b8202a'], [42, 52, '#e8a0a8'], [84, 80, '#d84858'], [38, 80, '#b8202a']]) { circle(C.x + x + 4, C.y + y + 12, 6, '#3e7a3a'); circle(C.x + x, C.y + y, 9, c2); circle(C.x + x - 2, C.y + y - 2, 4, '#f0c0c0'); }
  }
  {
    const C = P[5];
    rect(C.x, C.y, C.w, C.h, lin(0, C.y, C.y + 70, [[0, '#9cb8d0'], [1, '#efe2c4']]));
    ridge(C, C.y + 70, 22, '#7a9a6a', 7); ridge(C, C.y + 104, 14, '#6a8a4a', 8);
    for (let i = 0; i < 5; i++) { const x = C.x + 14 + i * 22, y = C.y + 98 - (i % 2) * 14; rect(x, y, 16, 12, '#e8dcc4'); poly([[x - 2, y], [x + 8, y - 8], [x + 18, y]], '#a8442e'); rect(x + 6, y + 5, 4, 7, '#4a3020'); }
    for (const x of [8, 112]) poly([[C.x + x, C.y + 66], [C.x + x + 5, C.y + 120], [C.x + x - 5, C.y + 120]], '#2e4a2a');
    ridge(C, C.y + 136, 6, '#4a6a34', 9);
  }
  {
    const C = P[6];
    rect(C.x, C.y, C.w, C.h, '#ddd4b4');
    for (const [x, y, rr] of [[40, 50, 26], [96, 110, 30], [30, 128, 18]]) for (let k = 4; k > 0; k--) { g.strokeStyle = '#9a7a52'; g.lineWidth = 1; g.beginPath(); g.ellipse(C.x + x, C.y + y, rr * k / 4, rr * k / 5, 0.4, 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = 'rgba(80,140,70,0.35)'; g.beginPath(); g.ellipse(C.x + 70, C.y + 60, 30, 20, 0.3, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#3c6ca8'; g.lineWidth = 3; g.beginPath(); g.moveTo(C.x, C.y + 92); g.bezierCurveTo(C.x + 40, C.y + 70, C.x + 70, C.y + 130, C.x + 128, C.y + 100); g.stroke();
    g.strokeStyle = 'rgba(60,60,60,0.35)'; g.lineWidth = 1; for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(C.x + k * 32, C.y); g.lineTo(C.x + k * 32, C.y + C.h); g.stroke(); g.beginPath(); g.moveTo(C.x, C.y + k * 40); g.lineTo(C.x + C.w, C.y + k * 40); g.stroke(); }
    g.strokeStyle = '#b8282a'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(C.x + 20, C.y + 140); g.lineTo(C.x + 60, C.y + 100); g.lineTo(C.x + 54, C.y + 112); g.moveTo(C.x + 60, C.y + 100); g.lineTo(C.x + 48, C.y + 102); g.stroke();
    for (const [x, y] of [[84, 40], [100, 52], [22, 70]]) rect(C.x + x, C.y + y, 9, 6, '#2a4a9a');
  }
  {
    const C = P[7], cx = C.x + 64, cy = C.y + 80;
    rect(C.x, C.y, C.w, C.h, '#5a3a26');
    circle(cx, cy, 60, '#b8964e'); circle(cx, cy, 55, '#efe6d0');
    for (let i = 0; i < 60; i++) { const a = i * Math.PI / 30, big = i % 5 === 0, r0 = big ? 42 : 48; g.strokeStyle = '#2a2420'; g.lineWidth = big ? (i % 15 === 0 ? 4.5 : 3) : 1.2; g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * 52, cy + Math.sin(a) * 52); g.stroke(); }
    circle(cx, cy, 4, '#2a2420');
  }
  // wool: knots on a 2-px grid, rows of pile, soft fuzz (pictures get a lighter canvas grain)
  const img = g.getImageData(0, 0, S, S), d = img.data, k2 = 1024 / S;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const X = x * k2, Y = y * k2, pic = X >= 512 && Y >= 704, kn = ih(x >> 1, y >> 1, 7), fz = ih(x >> 3, y >> 3, 11);
    const k = pic ? 0.95 + 0.06 * kn : (0.86 + 0.14 * kn) * ((y & 1) ? 0.97 : 1.02) * (0.95 + 0.08 * fz), q = (y * S + x) * 4;
    d[q] *= k; d[q + 1] *= k; d[q + 2] *= k;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
  return t;
}

let INT = null;
/** The interior set, built once: { floor, paper, veneer: { map, normal, rough }, carpet: atlas texture, ms } */
export function interiorTextures() {
  if (INT) return INT;
  const t0 = performance.now(), low = G.texDetail === 'low', big = low ? 512 : 1024, small = big / 2;
  const aniso = Math.min(8, G.renderer && G.renderer.capabilities ? G.renderer.capabilities.getMaxAnisotropy() : 4);
  INT = { floor: floorMaps(big, aniso), paper: paperMaps(small, aniso), veneer: veneerMaps(small, aniso), carpet: carpetAtlas(big, aniso) };
  INT.ms = Math.round(performance.now() - t0);
  if (G.debug) console.info(`[textures] interior set built in ${INT.ms} ms at ${big}px`);
  return INT;
}
