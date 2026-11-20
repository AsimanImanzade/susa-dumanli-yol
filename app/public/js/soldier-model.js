/**
 * soldier-model.js — procedural infantry.
 *
 *   buildSoldier(kind, opts)  one SkinnedMesh (one draw call, one shared
 *                             material) plus a SoldierRig that poses it in code
 *   SoldierRig                procedural locomotion: feet planted in the world
 *                             (they never slide), a step rhythm driven by the
 *                             distance covered, directional steps (strafe, back-
 *                             pedal), walk / search / run gaits, step-turns,
 *                             feet on the terrain; two-bone IK on legs and arms
 *                             (the hands stay on the rifle), braced aim, kneel,
 *                             flinch, stun, three death falls, and headLocal()
 *                             by forward kinematics
 *
 * Self-contained on purpose: it imports only `three`, so models.js can
 * re-export it without an import cycle. Geometry is cached per kind/variant;
 * the 1024 px texture atlas and the material are created once per session and
 * shared by every soldier (nothing to dispose between levels).
 *
 * Frame: feet at the origin, facing −Z, +X is the soldier's right, metres.
 */
import * as THREE from 'three';

// ───────────────────────────── small helpers ─────────────────────────────
const PI = Math.PI, TAU = PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
const sstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
/** smooth compact bump: 1 at c, 0 beyond ±w */
const bump = (x, c, w) => { const d = (x - c) / w; if (d <= -1 || d >= 1) return 0; const q = 1 - d * d; return q * q; };
const spow = (t, e) => (t < 0 ? -Math.pow(-t, e) : Math.pow(t, e));
const ease3 = (t) => t * t * (3 - 2 * t);

function ihash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul((s | 0) + 1, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vn(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = ihash(xi, yi, s), b = ihash(xi + 1, yi, s), c = ihash(xi, yi + 1, s), d = ihash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct, s) {
  let t = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) { t += vn(x, y, s + i * 17) * a; n += a; a *= 0.5; x *= 2.03; y *= 2.03; }
  return t / n;
}

// ───────────────────────────── skeleton ─────────────────────────────────
export const SOLDIER_BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'clavL', 'armL', 'foreL', 'handL', 'clavR', 'armR', 'foreR', 'handR',
  'legL', 'shinL', 'footL', 'legR', 'shinR', 'footR', 'weapon'];
const HIPS = 0, SPINE = 1, CHEST = 2, NECK = 3, HEAD = 4, CLAV_L = 5, ARM_L = 6, FORE_L = 7, HAND_L = 8, CLAV_R = 9, ARM_R = 10, FORE_R = 11, HAND_R = 12,
  LEG_L = 13, SHIN_L = 14, FOOT_L = 15, LEG_R = 16, SHIN_R = 17, FOOT_R = 18, WEAPON = 19;
const NB = SOLDIER_BONES.length;
const PAR = [-1, HIPS, SPINE, CHEST, NECK, CHEST, CLAV_L, ARM_L, FORE_L, CHEST, CLAV_R, ARM_R, FORE_R, HIPS, LEG_L, SHIN_L, HIPS, LEG_R, SHIN_R, -1];
const A_POSE = 0.58;                               // arm bind angle from vertical
const SA = Math.sin(A_POSE), CA = Math.cos(A_POSE);
const UPPER = 0.305, LOWER = 0.262, THIGH = 0.43, SHANK = 0.42, ANKLE_H = 0.085;
const SHX = 0.178, SHY = 1.42;                     // shoulder joint (right; left mirrored)
const HIPX = 0.092;
/** nominal bind positions (mesh space, k = 1); bones are unrotated in bind */
const BIND = (() => {
  const b = [];
  b[HIPS] = [0, 0.98, 0]; b[SPINE] = [0, 1.10, 0.006]; b[CHEST] = [0, 1.27, 0.002]; b[NECK] = [0, 1.462, 0.014]; b[HEAD] = [0, 1.585, 0.002];
  for (const s of [-1, 1]) {
    const L = s < 0;
    b[L ? CLAV_L : CLAV_R] = [s * 0.026, 1.428, -0.012];
    b[L ? ARM_L : ARM_R] = [s * SHX, SHY, 0];
    b[L ? FORE_L : FORE_R] = [s * (SHX + UPPER * SA), SHY - UPPER * CA, 0];
    b[L ? HAND_L : HAND_R] = [s * (SHX + (UPPER + LOWER) * SA), SHY - (UPPER + LOWER) * CA, 0];
    b[L ? LEG_L : LEG_R] = [s * HIPX, 0.935, 0];
    b[L ? SHIN_L : SHIN_R] = [s * HIPX, 0.935 - THIGH, 0];
    b[L ? FOOT_L : FOOT_R] = [s * HIPX, ANKLE_H, 0];
  }
  b[WEAPON] = [0.28, 1.0, -0.35];
  return b;
})();
/** head centre in the head bone's frame (nominal) */
const HEAD_C = [0, 0.043, -0.014];

// ───────────────────────────── texture atlas ─────────────────────────────
const AT = 1024;
const REG = {
  fabE: [0, 0, 512, 512], fabF: [512, 0, 512, 512],
  head: [0, 512, 512, 256],
  web: [512, 512, 256, 256], leather: [768, 512, 256, 256],
  skin: [0, 768, 256, 256], paint: [256, 768, 256, 256],
  wood: [512, 768, 256, 128], metal: [512, 896, 256, 128],
  rubber: [768, 768, 256, 128], plastic: [768, 896, 256, 128],
};
const PPM = { fab: 470, web: 470, leather: 650, skin: 560, wood: 560, metal: 560, rubber: 560, plastic: 560 };
// head cylinder mapping: θ ∈ [−π, π] across, h (relative to the head centre) down
const H_TOP = 0.125, H_BOT = -0.22;

const CAMO = {
  E: { base: [88, 74, 58], dark: [70, 58, 46], light: [106, 91, 71], spot: [57, 49, 40] },
  F: { base: [82, 88, 59], dark: [70, 76, 51], light: [95, 99, 68], spot: [62, 67, 47] },
};

function headProfileAt(h) {                         // interpolated row of HEADT
  const T = HEADT;
  if (h <= T[0][0]) return T[0];
  for (let i = 1; i < T.length; i++) {
    if (h <= T[i][0]) {
      const a = T[i - 1], b = T[i], t = (h - a[0]) / (b[0] - a[0]);
      return a.map((v, k) => v + (b[k] - v) * t);
    }
  }
  return T[T.length - 1];
}
/** θ on the head ring where the front surface reaches lateral offset x at height h */
function faceTheta(x, h) {
  const r = headProfileAt(h), a = r[1], n = r[4];
  const q = clamp(Math.abs(x) / a, 0, 0.999);
  return Math.sign(x) * Math.asin(Math.pow(q, n / 2));
}
const headPx = (th) => REG.head[0] + (th + PI) / TAU * REG.head[2];
const headPy = (h) => REG.head[1] + (H_TOP - h) / (H_TOP - H_BOT) * REG.head[3];

function paintAtlas() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = AT;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(AT, AT), d = img.data;
  const out = [0, 0, 0];
  const fill = (reg, fn) => {
    for (let y = 0; y < reg[3]; y++) for (let x = 0; x < reg[2]; x++) {
      fn(x, y, out);
      const i = ((reg[1] + y) * AT + reg[0] + x) * 4;
      d[i] = clamp(out[0], 0, 255); d[i + 1] = clamp(out[1], 0, 255); d[i + 2] = clamp(out[2], 0, 255); d[i + 3] = 255;
    }
  };
  // uniform fabric: blotch camouflage, twill weave, fibre noise
  const fabric = (pal, seed) => (x, y, o) => {
    const n1 = fbm(x / 34, y / 42, 3, seed), n2 = fbm(x / 17 + 9, y / 20 - 4, 3, seed + 5), n3 = fbm(x / 7, y / 7, 2, seed + 9);
    let c = pal.base;
    if (n1 > 0.585) c = pal.dark; else if (n1 < 0.40) c = pal.light;
    if (n2 > 0.665) c = pal.spot;
    const tw = ((x + (y >> 1)) & 3) < 2 ? 1.035 : 0.965;
    const k = tw * (0.9 + 0.2 * ihash(x, y, seed)) * (0.93 + 0.14 * n3);
    o[0] = c[0] * k; o[1] = c[1] * k; o[2] = c[2] * k;
  };
  fill(REG.fabE, fabric(CAMO.E, 11));
  fill(REG.fabF, fabric(CAMO.F, 23));
  // webbing / nylon: near-white so vertex colour sets the hue; MOLLE rows and stitching
  fill(REG.web, (x, y, o) => {
    const row = y % 18, band = row < 12;
    let k = band ? 0.93 : 0.8;
    if (row === 0 || row === 11) k *= 0.72;
    if (band && (x % 26) < 2) k *= 0.82;                   // bar-tack stitching
    k *= 0.9 + 0.12 * ((x + y) & 1) + 0.08 * fbm(x / 5, y / 5, 2, 3);
    const v = 236 * k; o[0] = v; o[1] = v; o[2] = v;
  });
  // leather: grain and creases (neutral)
  fill(REG.leather, (x, y, o) => {
    const g = fbm(x / 3, y / 3, 3, 41), cr = Math.abs(fbm(x / 40, y / 14, 3, 43) - 0.5);
    let k = 0.78 + 0.25 * g; if (cr < 0.025) k *= 0.8;
    const v = 228 * k; o[0] = v; o[1] = v * 0.98; o[2] = v * 0.96;
  });
  // plain skin for hands, forearms and ears
  fill(REG.skin, (x, y, o) => {
    const n = fbm(x / 14, y / 14, 3, 51), f = ihash(x, y, 52);
    const k = 0.93 + 0.1 * n + 0.04 * f;
    o[0] = 198 * k; o[1] = 150 * k; o[2] = 122 * k * (0.98 + 0.04 * n);
  });
  // helmet paint: neutral matt paint with chips and grime (u = around, v = crown → rim)
  fill(REG.paint, (x, y, o) => {
    const n = fbm(x / 20, y / 20, 4, 61), chip = fbm(x / 6, y / 6, 3, 62), rimY = y / REG.paint[3];
    let k = 0.86 + 0.12 * n;
    if (chip > 0.74 + 0.1 * (1 - rimY)) k = 1.05;           // chipped paint shows lighter primer/metal, more near the rim
    if (Math.abs(fbm(x / 60, y / 3, 2, 63) - 0.5) < 0.006) k *= 1.12;   // scratches
    k *= 1 - 0.2 * sstep(0.55, 1, rimY) * (0.6 + 0.4 * n);   // grime towards the rim
    const v = 222 * k; o[0] = v; o[1] = v; o[2] = v * 0.97;
  });
  // laminated birch AK furniture
  fill(REG.wood, (x, y, o) => {
    const g = Math.sin(x * 0.11 + fbm(x / 50, y / 7, 3, 71) * 9) * 0.5 + 0.5, f = fbm(x / 4, y / 30, 2, 72);
    const k = 0.78 + 0.18 * g + 0.1 * f;
    o[0] = 104 * k; o[1] = 58 * k; o[2] = 36 * k;
  });
  // blued steel with wear
  fill(REG.metal, (x, y, o) => {
    const n = fbm(x / 8, y / 3, 3, 81), w = fbm(x / 30, y / 30, 2, 82);
    let k = 0.82 + 0.16 * n; if (w > 0.7) k += 0.25 * (w - 0.7) / 0.3;
    const v = 200 * k; o[0] = v; o[1] = v; o[2] = v * 1.03;
  });
  fill(REG.rubber, (x, y, o) => { const v = 200 * (0.85 + 0.15 * fbm(x / 3, y / 3, 2, 91)); o[0] = v; o[1] = v; o[2] = v; });
  fill(REG.plastic, (x, y, o) => { const v = 210 * (0.9 + 0.1 * fbm(x / 6, y / 6, 2, 95)); o[0] = v; o[1] = v; o[2] = v; });
  // head: skin, short hair, stubble, slight colour in cheeks and ears
  fill(REG.head, (x, y, o) => {
    const th = x / REG.head[2] * TAU - PI, h = H_TOP - y / REG.head[3] * (H_TOP - H_BOT), at = Math.abs(th);
    const n = fbm(x / 10, y / 10, 3, 101), f = ihash(x, y, 102);
    let r = 196, g = 148, b = 120;
    const kk = 0.93 + 0.1 * n + 0.03 * f; r *= kk; g *= kk; b *= kk;
    // warmth on the cheeks, nose and ears; cooler under the jaw
    const warm = bump(at, 0.62, 0.4) * bump(h, -0.012, 0.03) * 0.7 + bump(at, 0, 0.18) * bump(h, -0.02, 0.025) * 0.6 + bump(at, 1.62, 0.25) * bump(h, 0.0, 0.05) * 0.5;
    r += 14 * warm; g -= 4 * warm; b -= 6 * warm;
    if (h < -0.1) { const c = sstep(-0.1, -0.13, h) * 0.06; r *= 1 - c; g *= 1 - c * 0.8; }
    // stubble: jaw, chin, upper lip (not the lips themselves)
    const lips = bump(at, 0, 0.30) * bump(h, -0.056, 0.012);
    let st = sstep(-0.015, -0.035, h) * sstep(-0.125, -0.105, h) * sstep(1.65, 1.35, at);
    st = Math.max(st, bump(at, 0, 0.34) * bump(h, -0.044, 0.008));
    st *= (1 - lips) * (0.55 + 0.45 * ihash(x >> 1, y >> 1, 103));
    r = lerp(r, r * 0.74, st * 0.55); g = lerp(g, g * 0.75, st * 0.55); b = lerp(b, b * 0.8, st * 0.5);
    // hair: buzz cut on the back and sides, forehead hairline
    const line = at > 1.95 ? -0.065 + 0.03 * sstep(2.6, 1.95, at) : at > 1.25 ? lerp(0.012, -0.035, sstep(1.3, 1.95, at)) : lerp(0.075, 0.012, sstep(0.75, 1.3, at));
    const side = at > 1.25 && at < 1.5 && h < 0.02 ? sstep(1.5, 1.38, at) * sstep(-0.012, 0.0, h) : 0;   // sideburns
    const hm = Math.max(sstep(line - 0.004, line + 0.006, h), side) * (0.78 + 0.22 * ihash(x, y, 104));
    r = lerp(r, 40, hm * 0.88); g = lerp(g, 32, hm * 0.88); b = lerp(b, 27, hm * 0.88);
    o[0] = r; o[1] = g; o[2] = b;
  });
  ctx.putImageData(img, 0, 0);
  paintFace(ctx);
  return cv;
}

/** Eyes, brows, nose and mouth drawn onto the head region (understated). */
function paintFace(ctx) {
  const pxPerM = REG.head[3] / (H_TOP - H_BOT);
  const at = (x, h) => [headPx(faceTheta(x, h)), headPy(h)];
  ctx.save();
  for (const s of [-1, 1]) {
    // eye socket shading
    const [ex, ey] = at(s * 0.032, 0.013);
    const gr = ctx.createRadialGradient(ex, ey + 1, 1, ex, ey + 1, 15);
    gr.addColorStop(0, 'rgba(60,34,26,0.5)'); gr.addColorStop(1, 'rgba(60,34,26,0)');
    ctx.fillStyle = gr; ctx.fillRect(ex - 18, ey - 16, 36, 32);
    // eye: dim sclera, dark iris, heavy upper lid line
    const [x0] = at(s * 0.018, 0.013), [x1] = at(s * 0.046, 0.013);
    const w = Math.abs(x1 - x0) / 2, cx = (x0 + x1) / 2, hh = 0.0052 * pxPerM;
    ctx.fillStyle = 'rgb(160,140,124)';
    ctx.beginPath(); ctx.ellipse(cx, ey, w, hh, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgb(48,34,26)';
    ctx.beginPath(); ctx.ellipse(cx - s * w * 0.1, ey + 0.3, hh * 1.05, hh * 1.05, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgb(40,26,20)'; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.ellipse(cx, ey + hh * 0.5, w * 1.05, hh * 1.4, 0, PI * 1.08, PI * 1.92); ctx.stroke();
    ctx.strokeStyle = 'rgba(90,55,45,0.45)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cx, ey - hh * 0.3, w * 0.95, hh * 1.3, 0, PI * 0.15, PI * 0.85); ctx.stroke();
    // brow
    ctx.strokeStyle = 'rgba(46,34,27,0.85)'; ctx.lineCap = 'round';
    const b0 = at(s * 0.010, 0.029), b1 = at(s * 0.030, 0.034), b2 = at(s * 0.052, 0.030);
    ctx.lineWidth = 0.0062 * pxPerM;
    ctx.beginPath(); ctx.moveTo(b0[0], b0[1]); ctx.quadraticCurveTo(b1[0], b1[1] - 2, b2[0], b2[1]); ctx.stroke();
    // nose side shading and nostril
    const [nx, ny] = at(s * 0.012, -0.01);
    const g2 = ctx.createLinearGradient(nx - s * 4, ny, nx + s * 8, ny);
    g2.addColorStop(0, 'rgba(90,50,38,0)'); g2.addColorStop(0.5, 'rgba(90,50,38,0.22)'); g2.addColorStop(1, 'rgba(90,50,38,0)');
    ctx.fillStyle = g2; ctx.fillRect(Math.min(nx - s * 4, nx + s * 8), ny - 14, 12, 26);
    const [sx, sy] = at(s * 0.009, -0.034);
    ctx.fillStyle = 'rgba(55,30,24,0.75)';
    ctx.beginPath(); ctx.ellipse(sx, sy, 2.4, 1.3, 0, 0, TAU); ctx.fill();
    // nasolabial fold
    ctx.strokeStyle = 'rgba(95,55,42,0.25)'; ctx.lineWidth = 1.5;
    const f0 = at(s * 0.022, -0.028), f1 = at(s * 0.03, -0.06);
    ctx.beginPath(); ctx.moveTo(f0[0], f0[1]); ctx.lineTo(f1[0], f1[1]); ctx.stroke();
  }
  // mouth: lips slightly darker and redder, a thin line between them
  const [mx0, my] = at(-0.024, -0.056), [mx1] = at(0.024, -0.056);
  ctx.fillStyle = 'rgba(120,62,54,0.45)';
  ctx.beginPath(); ctx.ellipse((mx0 + mx1) / 2, my + 2, (mx1 - mx0) / 2, 4.5, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(60,30,26,0.85)'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(mx0, my); ctx.quadraticCurveTo((mx0 + mx1) / 2, my + 1.5, mx1, my); ctx.stroke();
  // shadow under the lower lip and on the chin
  const [cx, cy] = at(0, -0.072);
  const g3 = ctx.createRadialGradient(cx, cy, 1, cx, cy, 12);
  g3.addColorStop(0, 'rgba(70,40,32,0.25)'); g3.addColorStop(1, 'rgba(70,40,32,0)');
  ctx.fillStyle = g3; ctx.fillRect(cx - 14, cy - 12, 28, 24);
  ctx.restore();
}

let _atlas = null, _mat = null;
function atlasTexture() {
  if (_atlas) return _atlas;
  const tex = new THREE.CanvasTexture(paintAtlas());
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.name = 'soldier_atlas';
  _atlas = tex;
  return tex;
}
/**
 * The one material every soldier shares: Lambert (like the scene) with the
 * atlas and baked AO in vertex colours. A faint view-dependent rim, scaled by
 * the hemisphere light, keeps the silhouette readable against dark fog
 * without making the soldier glow.
 */
export function soldierMaterial() {
  if (_mat) return _mat;
  _mat = new THREE.MeshLambertMaterial({ map: atlasTexture(), vertexColors: true });
  _mat.name = 'soldier';
  _mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <aomap_fragment>', `#include <aomap_fragment>
      #if NUM_HEMI_LIGHTS > 0
      {
        float rimF = 1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
        rimF = rimF * rimF * rimF;
        reflectedLight.indirectDiffuse += diffuseColor.rgb * hemisphereLights[0].skyColor * rimF * (0.6 * RECIPROCAL_PI);
      }
      #endif`);
  };
  _mat.customProgramCacheKey = () => 'soldier-rim-1';
  return _mat;
}

// ───────────────────────────── geometry builder ─────────────────────────
const _bv = new THREE.Vector3();
const WS = new Float32Array(NB);       // weight scratch

class Builder {
  constructor(k) {
    this.k = k;
    this.pos = []; this.nom = []; this.uv = []; this.tint = []; this.si = []; this.sw = []; this.idx = [];
    this.pid = []; this.grp = []; this.weldOf = [false];
    this.n = 0; this.part = 0; this.xf = null; this.scale = true; this.wf = null; this.g = 0;
  }
  /** Start a new smoothing part. o: { wf(x,y,z) weight fn, grp (AO group), xf (Matrix4), scale, weld } */
  begin(o = {}) {
    this.part++; this.wf = o.wf || this.wf; this.g = o.grp ?? this.g; this.xf = o.xf || null;
    this.scale = o.scale !== false; this.weldOf[this.part] = o.weld !== false;
    return this;
  }
  vert(x, y, z, px, py, r, g, b) {
    _bv.set(x, y, z); if (this.xf) _bv.applyMatrix4(this.xf);
    const nx = _bv.x, ny = _bv.y, nz = _bv.z, s = this.scale ? this.k : 1;
    this.nom.push(nx, ny, nz);
    this.pos.push(nx * s, ny * s, nz * s);
    this.uv.push(px / AT, 1 - py / AT);
    this.tint.push(r, g, b);
    WS.fill(0); this.wf(nx, ny, nz);
    // keep the four largest weights
    const bi = [0, 0, 0, 0], bw = [0, 0, 0, 0];
    for (let i = 0; i < NB; i++) {
      const w = WS[i]; if (w <= 0) continue;
      let m = 0; for (let q = 1; q < 4; q++) if (bw[q] < bw[m]) m = q;
      if (w > bw[m]) { bw[m] = w; bi[m] = i; }
    }
    const sum = bw[0] + bw[1] + bw[2] + bw[3] || 1;
    this.si.push(bi[0], bi[1], bi[2], bi[3]); this.sw.push(bw[0] / sum, bw[1] / sum, bw[2] / sum, bw[3] / sum);
    this.pid.push(this.part); this.grp.push(this.g);
    return this.n++;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  /** triangle tally by section (dev stats) */
  mark(name) {
    const n = this.idx.length / 3;
    if (this._mk) (this.tally ||= {})[this._mk] = ((this.tally || {})[this._mk] || 0) + n - this._mn;
    this._mk = name; this._mn = n;
  }

  /**
   * Loft a tube through rings. ring: { c:[x,y,z], X:[..], Z:[..], pts:[[lx,lz,tintMul?],...] }
   * (closed rings, no duplicate point). o: { reg, ppm, u0, v0, tint:[r,g,b], capA, capB ('dome'|'flat'), uvFn }
   */
  loft(rings, o) {
    const nR = rings.length, nP = rings[0].pts.length, base = this.n, tint = o.tint || [1, 1, 1];
    const reg = o.reg, ppm = o.ppm || 500, pad = 3;
    let vAcc = o.v0 || 0;
    const P = (R, p) => [R.c[0] + R.X[0] * p[0] + R.Z[0] * p[1], R.c[1] + R.X[1] * p[0] + R.Z[1] * p[1], R.c[2] + R.X[2] * p[0] + R.Z[2] * p[1]];
    const uvPx = (u, v) => [clamp(reg[0] + pad + u * ppm, reg[0] + pad, reg[0] + reg[2] - pad), clamp(reg[1] + pad + v * ppm, reg[1] + pad, reg[1] + reg[3] - pad)];
    for (let k = 0; k < nR; k++) {
      const R = rings[k];
      if (k > 0) { const c0 = rings[k - 1].c; vAcc += Math.hypot(R.c[0] - c0[0], R.c[1] - c0[1], R.c[2] - c0[2]); }
      let uAcc = o.u0 || 0, prev = null;
      const tk = R.t ?? 1;
      for (let j = 0; j <= nP; j++) {
        const p = R.pts[j % nP], q = P(R, p);
        if (prev) uAcc += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
        prev = q;
        const m = tk * (p[2] ?? 1);
        const px = o.uvFn ? o.uvFn(k, j, nP, q) : uvPx(uAcc, vAcc);
        this.vert(q[0], q[1], q[2], px[0], px[1], tint[0] * m, tint[1] * m, tint[2] * m);
      }
    }
    const flip = windingFlip(this.nom, base, nR, nP);
    for (let k = 0; k < nR - 1; k++) for (let j = 0; j < nP; j++) {
      const a = base + k * (nP + 1) + j, b = a + 1, c = a + nP + 1, d = c + 1;
      if (flip) { this.tri(a, c, b); this.tri(b, c, d); } else { this.tri(a, b, c); this.tri(b, d, c); }
    }
    // caps
    const cap = (k, kind, dirSign) => {
      if (!kind) return;
      const R = rings[k], r0 = base + k * (nP + 1);
      let cx = R.c[0], cy = R.c[1], cz = R.c[2];
      // dome: push the centre along the loft direction
      const other = rings[k === 0 ? 1 : nR - 2].c;
      let tx = R.c[0] - other[0], ty = R.c[1] - other[1], tz = R.c[2] - other[2];
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      if (kind === 'dome') {
        let rr = 0; for (const p of R.pts) rr += Math.hypot(p[0], p[1]); rr /= nP;
        cx += tx * rr * 0.45; cy += ty * rr * 0.45; cz += tz * rr * 0.45;
      }
      const uvc = o.uvFn ? o.uvFn(k, 0, nP, [cx, cy, cz]) : uvPx(0.05, vAcc * 0);
      const ci = this.vert(cx, cy, cz, uvc[0], uvc[1], tint[0] * (R.t ?? 1), tint[1] * (R.t ?? 1), tint[2] * (R.t ?? 1));
      // orientation: the fan normal must point along t (outward)
      for (let j = 0; j < nP; j++) {
        const a = r0 + j, b = r0 + j + 1;
        const A = this.nom;
        const ux = A[a * 3] - A[ci * 3], uy = A[a * 3 + 1] - A[ci * 3 + 1], uz = A[a * 3 + 2] - A[ci * 3 + 2];
        const vx = A[b * 3] - A[ci * 3], vy = A[b * 3 + 1] - A[ci * 3 + 1], vz = A[b * 3 + 2] - A[ci * 3 + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        _bv.set(tx, ty, tz); if (this.xf) _bv.transformDirection(this.xf);
        const dot = (nx * _bv.x + ny * _bv.y + nz * _bv.z) * dirSign;
        if (dot >= 0) this.tri(ci, a, b); else this.tri(ci, b, a);
      }
    };
    cap(0, o.capA, 1); cap(nR - 1, o.capB, 1);
    return this;
  }

  /** Extrude a side profile (points [z, y], any order, star-shaped) along X by ±hw. Hard edges. */
  extrude(pts, hw, o) {
    const reg = o.reg, ppm = o.ppm || 560, t = o.tint, n = pts.length, x0 = o.x || 0;
    let cz = 0, cy = 0; for (const p of pts) { cz += p[0]; cy += p[1]; } cz /= n; cy /= n;
    const uv = (z, y) => [clamp(reg[0] + 3 + (z + 0.5) * ppm % (reg[2] - 6), reg[0] + 3, reg[0] + reg[2] - 3), clamp(reg[1] + 3 + (0.2 - y) * ppm, reg[1] + 3, reg[1] + reg[3] - 3)];
    for (const s of [-1, 1]) {
      this.begin({ wf: this.wf, grp: this.g, xf: o.xf, scale: o.scale, weld: false });
      const c = this.vert(x0 + s * hw, cy, cz, ...uv(cz, cy), t[0], t[1], t[2]);
      const first = this.n;
      for (const p of pts) this.vert(x0 + s * hw, p[1], p[0], ...uv(p[0], p[1]), t[0], t[1], t[2]);
      for (let i = 0; i < n; i++) {
        const a = first + i, b = first + (i + 1) % n;
        // facing ±X
        const A = this.nom, ay = A[a * 3 + 1] - A[c * 3 + 1], az = A[a * 3 + 2] - A[c * 3 + 2], by = A[b * 3 + 1] - A[c * 3 + 1], bz = A[b * 3 + 2] - A[c * 3 + 2];
        _bv.set(1, 0, 0); if (o.xf) _bv.transformDirection(o.xf);
        const nx = ay * bz - az * by;           // x of (a-c)×(b-c) in local frame (y,z components only)
        if ((nx > 0) === (s > 0)) this.tri(c, a, b); else this.tri(c, b, a);
      }
    }
    // rim: one quad per edge, own vertices (flat) unless smooth
    this.begin({ wf: this.wf, grp: this.g, xf: o.xf, scale: o.scale, weld: !!o.smooth });
    let along = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const u0 = reg[0] + 3 + (along * ppm) % (reg[2] - 20), u1 = Math.min(u0 + len * ppm, reg[0] + reg[2] - 3);
      const vA = reg[1] + 3, vB = Math.min(reg[1] + 3 + hw * 2 * ppm, reg[1] + reg[3] - 3);
      along += len;
      const a = this.vert(x0 - hw, p[1], p[0], u0, vA, t[0], t[1], t[2]), b = this.vert(x0 + hw, p[1], p[0], u0, vB, t[0], t[1], t[2]);
      const c = this.vert(x0 - hw, q[1], q[0], u1, vA, t[0], t[1], t[2]), d = this.vert(x0 + hw, q[1], q[0], u1, vB, t[0], t[1], t[2]);
      // outward = away from the centroid
      const mz = (p[0] + q[0]) / 2 - cz, my = (p[1] + q[1]) / 2 - cy;
      const ez = q[0] - p[0], ey = q[1] - p[1];
      // edge normal in (z,y) plane: (ey, -ez) or (-ey, ez)
      const out = (ey * mz - ez * my) > 0;
      // quad a(−x,p) b(+x,p) c(−x,q) d(+x,q): normal of (b−a)×(c−a) = X × (q−p)
      // X × (0, ey, ez) = (0, -ez, ey) → in (z,y) = (ey, -ez)
      if (out) { this.tri(a, b, c); this.tri(b, d, c); } else { this.tri(a, c, b); this.tri(b, c, d); }
    }
    return this;
  }

  /** Cylinder along a straight segment (smooth sides, flat caps). */
  tube(a, b, r0, r1, seg, o) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz);
    const T = [dx / L, dy / L, dz / L];
    let X = Math.abs(T[1]) < 0.9 ? cross(T, [0, 1, 0]) : cross(T, [1, 0, 0]); X = norm(X);
    const Z = cross(X, T);
    const ring = (c, r) => ({ c, X, Z, pts: circlePts(seg, r, r) });
    const rings = [ring(a, r0), ring(b, r1)];
    if (o.mid) rings.splice(1, 0, ...o.mid.map(([t, r]) => ring([a[0] + dx * t, a[1] + dy * t, a[2] + dz * t], r)));
    this.begin({ wf: this.wf, grp: this.g, xf: o.xf, scale: o.scale, weld: true });
    const caps = o.caps !== false;
    this.loft(rings, { reg: o.reg, ppm: o.ppm, tint: o.tint, capA: caps ? 'flat' : null, capB: caps ? 'flat' : null });
    return this;
  }

  /**
   * Rounded box (sewn pouch, radio): centre c, axes R (right), U (up), N (out),
   * half sizes w, h, d. Loft along U with superellipse sections.
   */
  rbox(c, R, U, N, w, h, d, o) {
    const seg = o.seg || 10, n = o.n || 4, rings = [];
    const prof = (sw, sd) => {
      const pts = [];
      for (let j = 0; j < seg; j++) { const a = -PI + TAU * j / seg; pts.push([w * sw * spow(Math.sin(a), 2 / n), -d * sd * spow(Math.cos(a), 2 / n), 1]); }
      return pts;
    };
    // X axis = R, Z axis = −N (so "front" (cos>0 → −Z) is +N)
    const Zx = [-N[0], -N[1], -N[2]];
    const at = (t) => [c[0] + U[0] * h * t, c[1] + U[1] * h * t, c[2] + U[2] * h * t];
    const top = o.flap ? 1.06 : 0.9;
    for (const [t, sw, sd, tm] of [[-1, 0.82, 0.8, 0.85], [-0.8, 1, 1, 0.95], [0.75, 1, 1, 1], [0.92, top, o.flap ? 1.08 : 0.96, 1.05], [1, top * 0.9, o.flap ? 0.95 : 0.8, 1.05]]) {
      rings.push({ c: at(t), X: R, Z: Zx, pts: prof(sw, sd), t: tm });
    }
    this.begin({ wf: this.wf, grp: o.grp ?? this.g, xf: o.xf, scale: o.scale, weld: true });
    this.loft(rings, { reg: o.reg, ppm: o.ppm, tint: o.tint, capA: 'dome', capB: 'dome' });
    return this;
  }

  finish() {
    const n = this.n, P = this.pos, I = this.idx;
    const N = new Float32Array(n * 3);
    for (let i = 0; i < I.length; i += 3) {
      const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const v of [a, b, c]) { N[v] += nx; N[v + 1] += ny; N[v + 2] += nz; }
    }
    // weld normals of coincident vertices within a smooth part (loft seams, caps)
    const map = new Map();
    for (let v = 0; v < n; v++) {
      const p = this.pid[v]; if (!this.weldOf[p]) continue;
      const key = p + ':' + Math.round(P[v * 3] * 2e4) + ',' + Math.round(P[v * 3 + 1] * 2e4) + ',' + Math.round(P[v * 3 + 2] * 2e4);
      let g = map.get(key); if (!g) map.set(key, (g = [])); g.push(v);
    }
    for (const g of map.values()) {
      if (g.length < 2) continue;
      let x = 0, y = 0, z = 0; for (const v of g) { x += N[v * 3]; y += N[v * 3 + 1]; z += N[v * 3 + 2]; }
      for (const v of g) { N[v * 3] = x; N[v * 3 + 1] = y; N[v * 3 + 2] = z; }
    }
    for (let v = 0; v < n; v++) {
      const l = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) || 1;
      N[v * 3] /= l; N[v * 3 + 1] /= l; N[v * 3 + 2] /= l;
    }
    this.normals = N;
    return N;
  }
}

/**
 * Decide the triangle order of a loft so faces point away from each ring's
 * centroid: sums (b−a)×(c−a)·(a−centroid) over the first non-degenerate band.
 */
function windingFlip(A, base, nR, nP) {
  for (let k = 0; k < nR - 1; k++) {
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < nP; j++) { const v = (base + k * (nP + 1) + j) * 3; cx += A[v]; cy += A[v + 1]; cz += A[v + 2]; }
    cx /= nP; cy /= nP; cz /= nP;
    let acc = 0;
    for (let j = 0; j < nP; j++) {
      const a = base + k * (nP + 1) + j, b = a + 1, c = a + nP + 1;
      const ax = A[a * 3], ay = A[a * 3 + 1], az = A[a * 3 + 2];
      const ux = A[b * 3] - ax, uy = A[b * 3 + 1] - ay, uz = A[b * 3 + 2] - az, vx = A[c * 3] - ax, vy = A[c * 3 + 1] - ay, vz = A[c * 3 + 2] - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      acc += nx * (ax - cx) + ny * (ay - cy) + nz * (az - cz);
    }
    if (Math.abs(acc) > 1e-12) return acc < 0;
  }
  return false;
}
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function circlePts(seg, rx, rz, n = 2, fn) {
  const pts = [];
  for (let j = 0; j < seg; j++) {
    const a = -PI + TAU * j / seg, s = Math.sin(a), c = Math.cos(a);
    let x = rx * spow(s, 2 / n), z = -rz * spow(c, 2 / n);
    if (fn) { const r = fn(a); const l = Math.hypot(x, z) || 1; x += x / l * r; z += z / l * r; }
    pts.push([x, z]);
  }
  return pts;
}

// ───────────────────────────── skin weights ─────────────────────────────
// Each writes into WS for a bind-space (nominal) position.
function wTorso(x, y, z) {
  const hipsW = 1 - sstep(0.95, 1.08, y), chestIn = sstep(1.14, 1.27, y), neckIn = sstep(1.445, 1.50, y);
  let spine = sstep(0.95, 1.08, y) - chestIn, chest = chestIn - neckIn, hips = hipsW;
  // shoulders: the top of the torso near the arm follows the clavicle and a little of the arm
  const ax = Math.abs(x), side = x < 0;
  const sh = sstep(0.10, 0.19, ax) * sstep(1.30, 1.41, y);
  WS[side ? CLAV_L : CLAV_R] += chest * sh * 0.55; WS[side ? ARM_L : ARM_R] += chest * sh * 0.22;
  chest *= 1 - sh * 0.77;
  // hips and buttocks: blend into the thighs
  const lg = sstep(0.93, 0.80, y) * sstep(0.02, 0.09, ax) * (z > 0.02 ? 0.55 : 0.4);
  WS[side ? LEG_L : LEG_R] += hips * lg; hips *= 1 - lg;
  WS[HIPS] += hips; WS[SPINE] += spine; WS[CHEST] += chest; WS[NECK] += neckIn;
}
function wNeckHead(x, y, z) {
  // jaw/chin (front) belongs to the head higher up the neck than the back of the neck does
  const front = sstep(-0.01, -0.06, z);
  const head = sstep(1.50 - 0.02 * front, 1.565 - 0.03 * front, y);
  const neck = sstep(1.42, 1.475, y) - head;
  WS[HEAD] += head; WS[NECK] += Math.max(0, neck); WS[CHEST] += 1 - sstep(1.42, 1.475, y);
}
const wHead = () => { WS[HEAD] += 1; };
const wChest = () => { WS[CHEST] += 1; };
const wWeapon = () => { WS[WEAPON] += 1; };
function wLeg(side) {
  const LEG = side < 0 ? LEG_L : LEG_R, SH = side < 0 ? SHIN_L : SHIN_R, FT = side < 0 ? FOOT_L : FOOT_R;
  return (x, y) => {
    const hip = sstep(0.87, 1.0, y) * 0.55;
    const knee = 1 - sstep(0.455, 0.545, y);
    const ank = 1 - sstep(0.075, 0.15, y);
    WS[HIPS] += hip; WS[LEG] += (1 - hip) * (1 - knee); WS[SH] += (1 - hip) * knee * (1 - ank); WS[FT] += knee * ank;
  };
}
function wArm(side) {
  const CL = side < 0 ? CLAV_L : CLAV_R, AR = side < 0 ? ARM_L : ARM_R, FO = side < 0 ? FORE_L : FORE_R, HA = side < 0 ? HAND_L : HAND_R;
  return (x, y, z) => {
    // parameter along the arm from the shoulder joint
    const t = (Math.abs(x) - SHX) * SA + (SHY - y) * CA;
    const cl = (1 - sstep(-0.05, 0.05, t)) * 0.6;
    const el = sstep(UPPER - 0.045, UPPER + 0.035, t);
    const wr = sstep(UPPER + LOWER - 0.03, UPPER + LOWER + 0.012, t);
    WS[CL] += cl; WS[AR] += (1 - cl) * (1 - el); WS[FO] += el * (1 - wr); WS[HA] += el * wr;
  };
}
function wHand(side) { const FO = side < 0 ? FORE_L : FORE_R, HA = side < 0 ? HAND_L : HAND_R; return (x, y) => { const t = clamp01((y + 0.004) / 0.02); WS[FO] += t * 0.5; WS[HA] += 1 - t * 0.5; }; }

// ───────────────────────────── body shapes ──────────────────────────────
// torso rows: y, half-width, front depth, back depth, centre z, exponent
const TORSO = [
  [0.790, 0.060, 0.045, 0.050, 0.000, 2.0],
  [0.822, 0.126, 0.080, 0.090, 0.000, 2.3],
  [0.862, 0.158, 0.097, 0.112, 0.000, 2.5],
  [0.912, 0.173, 0.106, 0.124, 0.000, 2.5],
  [0.972, 0.167, 0.104, 0.112, 0.000, 2.5],
  [1.032, 0.154, 0.100, 0.098, 0.000, 2.4],
  [1.092, 0.151, 0.104, 0.094, 0.000, 2.4],
  [1.162, 0.157, 0.112, 0.097, -0.004, 2.4],
  [1.232, 0.164, 0.119, 0.104, -0.006, 2.5],
  [1.298, 0.170, 0.121, 0.109, -0.005, 2.6],
  [1.358, 0.178, 0.115, 0.111, -0.001, 2.8],
  [1.405, 0.182, 0.101, 0.104, 0.004, 3.0],
  [1.438, 0.160, 0.080, 0.087, 0.009, 2.8],
  [1.462, 0.112, 0.062, 0.071, 0.013, 2.4],
  [1.486, 0.070, 0.053, 0.059, 0.015, 2.1],
];
function torsoRow(y) {
  const T = TORSO;
  if (y <= T[0][0]) return T[0];
  for (let i = 1; i < T.length; i++) if (y <= T[i][0]) { const a = T[i - 1], b = T[i], t = (y - a[0]) / (b[0] - a[0]); return a.map((v, k) => v + (b[k] - v) * t); }
  return T[T.length - 1];
}
/** Torso surface point (x, z) at height y and angle θ (0 = front, +π/2 = right), grown by `off`. */
function torsoAt(y, th, build, off = 0) {
  const r = torsoRow(y), e = 2 / r[5], s = Math.sin(th), c = Math.cos(th);
  let x = r[1] * build * spow(s, e), z = r[4] + (c > 0 ? -r[2] : r[3]) * build * Math.abs(spow(c, e));
  // buttocks and chest
  const back = c < 0 ? -c : 0, front = c > 0 ? c : 0;
  let bulge = 0.012 * back * bump(y, 0.9, 0.075) * (1 - 0.6 * bump(th, PI, 0.16) - 0.6 * bump(th, -PI, 0.16));
  bulge += 0.008 * front * bump(y, 1.28, 0.06) * (1 - 0.5 * bump(th, 0, 0.12));
  bulge += 0.006 * back * bump(y, 1.33, 0.06) * bump(Math.abs(s), 0.5, 0.35);
  const l = Math.hypot(x, z - r[4]) || 1, dx = x / l, dz = (z - r[4]) / l;
  x += dx * (bulge + off); z += dz * (bulge + off);
  return [x, z, dx, dz];
}

// head rows: h (from head centre), half-width, front, back, front exponent, back exponent, centre z
const HEADT = [
  [-0.220, 0.061, 0.059, 0.065, 2.0, 2.0, 0.020],
  [-0.185, 0.057, 0.054, 0.061, 2.0, 2.0, 0.018],
  [-0.150, 0.054, 0.052, 0.058, 2.0, 2.0, 0.014],
  [-0.124, 0.052, 0.054, 0.058, 2.1, 2.0, 0.010],
  [-0.108, 0.048, 0.072, 0.060, 2.4, 2.0, 0.006],
  [-0.092, 0.053, 0.085, 0.066, 2.6, 2.0, 0.002],
  [-0.072, 0.061, 0.088, 0.078, 2.7, 2.1, 0.000],
  [-0.052, 0.066, 0.089, 0.088, 2.8, 2.1, 0.000],
  [-0.030, 0.070, 0.089, 0.094, 2.9, 2.1, 0.000],
  [-0.010, 0.074, 0.090, 0.099, 3.0, 2.1, 0.000],
  [0.012, 0.076, 0.087, 0.101, 3.0, 2.1, 0.000],
  [0.032, 0.077, 0.094, 0.102, 2.9, 2.1, 0.000],
  [0.055, 0.075, 0.092, 0.100, 2.6, 2.1, 0.000],
  [0.078, 0.069, 0.085, 0.093, 2.3, 2.1, 0.000],
  [0.098, 0.057, 0.071, 0.080, 2.1, 2.0, 0.003],
  [0.112, 0.040, 0.050, 0.058, 2.0, 2.0, 0.005],
  [0.121, 0.020, 0.025, 0.030, 2.0, 2.0, 0.006],
];
const HEAD_CY = 1.628, HEAD_CZ = -0.012;
/** head surface offset [x, z] at height h (relative to the head centre) and angle θ */
function headAt(h, th) {
  const r = headProfileAt(h), s = Math.sin(th), c = Math.cos(th);
  const front = c > 0;
  const e = 2 / (front ? r[4] : r[5]);
  let x = r[1] * spow(s, e), z = r[6] + (front ? -r[2] : r[3]) * Math.abs(spow(c, e));
  const at = Math.abs(th);
  let f = 0;
  if (front) {
    // nose: bridge → tip → underside
    const np = h > 0.022 ? 0 : h > 0.0 ? lerp(0.0, 0.008, (0.022 - h) / 0.022) : h > -0.024 ? lerp(0.008, 0.022, -h / 0.024) : h > -0.036 ? lerp(0.022, 0.0, (-0.024 - h) / 0.012) : 0;
    f += np * bump(th, 0, 0.17);
    f -= 0.008 * bump(at, 0.31, 0.2) * bump(h, 0.012, 0.016);       // eye sockets
    f += 0.005 * bump(at, 0.27, 0.38) * bump(h, 0.031, 0.013);       // brow ridge
    f += 0.004 * bump(at, 0.78, 0.35) * bump(h, -0.006, 0.022);      // cheekbones
    f += 0.0045 * bump(th, 0, 0.32) * bump(h, -0.054, 0.016);        // lips
    f -= 0.0018 * bump(th, 0, 0.3) * bump(h, -0.0565, 0.003);        // mouth line
    f += 0.006 * bump(th, 0, 0.38) * bump(h, -0.088, 0.016);         // chin
    f += 0.0035 * bump(th, 0, 0.28) * bump(h, -0.15, 0.016);         // Adam's apple
  }
  const l = Math.hypot(x, z - r[6]) || 1;
  x += x / l * f; z += (z - r[6]) / l * f;
  return [x, z];
}

/** Body (skin, uniform, boots, hands). sp: variant spec */
function buildBody(B, sp) {
  const bd = sp.build, fab = sp.side === 'F' ? REG.fabF : REG.fabE;
  const segT = 18;
  // ── torso (jacket)
  B.mark('torso');
  B.begin({ wf: wTorso, grp: 1 });
  const rings = [];
  for (const row of TORSO) {
    const y = row[0], pts = [];
    for (let j = 0; j < segT; j++) { const th = -PI + TAU * j / segT, p = torsoAt(y, th, bd); pts.push([p[0], p[1]]); }
    rings.push({ c: [0, y, 0], X: [1, 0, 0], Z: [0, 0, 1], pts, t: y < 0.99 ? 0.9 : 1 });
  }
  B.loft(rings, { reg: fab, ppm: PPM.fab, tint: sp.fabTint, capA: 'dome' });

  // ── legs (trousers bloused into the boots)
  B.mark('legs');
  for (const s of [-1, 1]) {
    B.mark('legs');
    B.begin({ wf: wLeg(s), grp: s < 0 ? 2 : 3 });
    const LEGR = [
      [0.995, 0.058, 0.060, 0.000, 0.0],
      [0.945, 0.088, 0.092, -0.004, 0.010],
      [0.800, 0.081, 0.084, -0.008, 0.004],
      [0.720, 0.075, 0.078, -0.008, 0.0],
      [0.640, 0.068, 0.071, -0.008, 0.0],
      [0.570, 0.061, 0.064, -0.010, 0.0],
      [0.520, 0.057, 0.061, -0.013, 0.0],
      [0.400, 0.057, 0.064, 0.002, 0.0],
      [0.330, 0.054, 0.060, 0.004, 0.0],
      [0.282, 0.058, 0.063, 0.004, 0.0],
      [0.258, 0.061, 0.066, 0.004, 0.0],
      [0.240, 0.050, 0.056, 0.004, 0.0],
      [0.225, 0.042, 0.048, 0.004, 0.0],
    ];
    const lr = [];
    for (const [y, rx, rz, zc, xo] of LEGR) {
      const pts = circlePts(12, rx * bd, rz * bd, 2.2, (a) => 0.004 * bump(Math.abs(a), PI, 0.5) * sstep(0.55, 0.45, y) * sstep(0.35, 0.42, y)); // calf
      lr.push({ c: [s * (HIPX + xo), y, zc], X: [s, 0, 0], Z: [0, 0, 1], pts, t: 0.92 - 0.06 * bump(y, 0.52, 0.04) });
    }
    B.loft(lr, { reg: fab, ppm: PPM.fab, u0: s < 0 ? 0.05 : 0.45, v0: 0.05, tint: sp.fabTint });
    // cargo pocket on the outer thigh
    const pc = [s * (HIPX + 0.079 * bd), 0.70, -0.012];
    B.rbox(pc, [0, 0, s], [0, 1, 0], [s, 0, 0], 0.052, 0.062, 0.012, { reg: fab, ppm: PPM.fab, tint: mulT(sp.fabTint, 0.92), seg: 6, flap: true, grp: s < 0 ? 2 : 3 });
    if (sp.knee) {      // knee pad on the front of the knee
      B.begin({ wf: (x, y) => { WS[s < 0 ? SHIN_L : SHIN_R] += 0.6; WS[s < 0 ? LEG_L : LEG_R] += 0.4; }, grp: s < 0 ? 2 : 3 });
      B.rbox([s * HIPX, 0.505, -0.058 * bd], [s, 0, 0], [0, 1, 0], [0, 0, -1], 0.05, 0.06, 0.016, { reg: REG.plastic, tint: sp.accent, seg: 6 });
    }
    // ── boot: shaft + foot, sole darker
    B.mark('boots');
    B.begin({ wf: wLeg(s), grp: s < 0 ? 2 : 3 });
    const sr = [];
    for (const [y, rx, rz, zc] of [[0.262, 0.053, 0.058, 0.006], [0.2, 0.046, 0.053, 0.009], [0.125, 0.045, 0.054, 0.011], [0.09, 0.049, 0.060, 0.004]]) {
      sr.push({ c: [s * HIPX, y, zc], X: [s, 0, 0], Z: [0, 0, 1], pts: circlePts(10, rx, rz, 2.3) });
    }
    B.loft(sr, { reg: REG.leather, ppm: PPM.leather, tint: sp.boot });
    const FOOT = [ // z, half-width, top y, (bottom y)
      [0.082, 0.026, 0.055], [0.07, 0.043, 0.092], [0.035, 0.048, 0.114], [-0.02, 0.05, 0.108],
      [-0.10, 0.053, 0.077], [-0.155, 0.05, 0.065], [-0.198, 0.037, 0.053], [-0.212, 0.018, 0.040],
    ];
    const fr = [];
    for (const [zz, hw, top] of FOOT) {
      const pts = [];
      // rounded section with a flat sole: points around, sole points darker
      const ns = 12;
      for (let j = 0; j < ns; j++) {
        const a = -PI + TAU * j / ns, sn = Math.sin(a), cs = Math.cos(a);
        // lx across the foot, ly up; bottom flat at y = 0
        const lx = hw * spow(sn, 0.7), ly = cs > 0 ? 0.012 + (top - 0.012) * spow(cs, 0.8) : 0.012 + 0.012 * spow(cs, 0.25);
        const sole = ly < 0.026 ? 0.28 : 1;
        pts.push([lx, ly, sole]);
      }
      fr.push({ c: [s * HIPX, 0, zz], X: [s, 0, 0], Z: [0, 1, 0], pts });
    }
    B.begin({ wf: () => { WS[s < 0 ? FOOT_L : FOOT_R] += 1; }, grp: s < 0 ? 2 : 3 });
    B.loft(fr, { reg: REG.leather, ppm: PPM.leather, tint: sp.boot, capA: 'dome', capB: 'dome' });
  }

  // ── arms: sleeves (down or rolled), skin forearms, hands
  B.mark('arms');
  for (const s of [-1, 1]) {
    const dir = [s * SA, -CA, 0], X = [s * CA, SA, 0], Z = [0, 0, 1];
    const at = (t) => [s * SHX + dir[0] * t, SHY + dir[1] * t, 0];
    const rolled = sp.sleeve === 'rolled';
    B.begin({ wf: wArm(s), grp: s < 0 ? 4 : 5 });
    const SL = [
      [-0.04, 0.026, 0.034], [-0.012, 0.044, 0.05], [0.03, 0.054, 0.055], [0.085, 0.051, 0.051], [0.15, 0.047, 0.048], [0.22, 0.045, 0.046],
      [0.285, 0.043, 0.045], [0.322, 0.045, 0.047],
    ];
    if (rolled) SL.push([0.35, 0.046, 0.048], [0.365, 0.054, 0.056], [0.39, 0.054, 0.055], [0.40, 0.042, 0.044]);
    else SL.push([0.38, 0.043, 0.045], [0.45, 0.039, 0.041], [0.51, 0.037, 0.038], [0.525, 0.04, 0.041], [0.532, 0.03, 0.031]);
    const ar = SL.map(([t, rx, rz]) => ({ c: at(t), X, Z, pts: circlePts(10, rx * bd, rz * bd, 2.1), t: t > 0.33 && rolled ? 0.95 : 1 }));
    B.loft(ar, { reg: sp.side === 'F' ? REG.fabF : REG.fabE, ppm: PPM.fab, u0: s < 0 ? 0.6 : 0.8, v0: 0.5, tint: sp.fabTint });
    // forearm skin
    B.begin({ wf: wArm(s), grp: s < 0 ? 4 : 5 });
    const FA = rolled ? [[0.33, 0.04, 0.042], [0.40, 0.039, 0.04], [0.46, 0.034, 0.034], [0.52, 0.029, 0.027], [0.556, 0.026, 0.021], [0.575, 0.024, 0.019]]
      : [[0.48, 0.033, 0.033], [0.52, 0.029, 0.027], [0.556, 0.026, 0.021], [0.575, 0.024, 0.019]];
    B.loft(FA.map(([t, rx, rz]) => ({ c: at(t), X, Z, pts: circlePts(8, rx * bd, rz * bd) })), { reg: sp.gloves ? REG.leather : REG.skin, ppm: PPM.skin, tint: sp.gloves && !rolled ? sp.accent : sp.skinT });
    B.mark('hands');
    buildHand(B, s, sp);
    B.mark('arms');
  }

  // ── neck and head
  B.mark('head');
  B.begin({ wf: wNeckHead, grp: 6 });
  const segH = 18, hr = [];
  for (const row of HEADT) {
    const h = row[0], pts = [];
    for (let j = 0; j < segH; j++) { const th = -PI + TAU * j / segH, p = headAt(h, th); pts.push([p[0], p[1]]); }
    hr.push({ c: [0, HEAD_CY + h, HEAD_CZ], X: [1, 0, 0], Z: [0, 0, 1], pts });
  }
  B.loft(hr, {
    tint: sp.skinT, capB: 'dome',
    uvFn: (k, j, nP, q) => {
      const th = Math.atan2(q[0], -(q[2] - HEAD_CZ));
      const u = j >= nP ? PI : j === 0 ? -PI : th;
      return [headPx(u), headPy(q[1] - HEAD_CY)];
    },
  });
  // ears
  for (const s of [-1, 1]) {
    B.begin({ wf: wHead, grp: 6 });
    const er = [];
    for (const [h, len, th, out] of [[-0.034, 0.012, 0.004, 0.004], [-0.026, 0.024, 0.008, 0.009], [-0.01, 0.03, 0.009, 0.013], [0.008, 0.033, 0.009, 0.015], [0.022, 0.028, 0.008, 0.013], [0.031, 0.014, 0.005, 0.006]]) {
      const p = headAt(h, s * 1.72);
      er.push({ c: [p[0] + s * out * 0.55, HEAD_CY + h, HEAD_CZ + p[1] + 0.006], X: [s * 0.25, 0, 0.97], Z: [s * 0.97, 0, -0.25], pts: circlePts(6, len * 0.62, th) });
    }
    B.loft(er, { reg: REG.skin, ppm: PPM.skin, tint: mulT(sp.skinT, 0.96), capA: 'dome', capB: 'dome' });
  }
}

const mulT = (t, k) => [t[0] * k, t[1] * k, t[2] * k];

/**
 * Hand in a grip pose (fingers curled round a 42 mm cylinder). Canonical
 * right hand: wrist at the origin, along −Y, palm facing −X, grip axis −Z
 * (pinky → index). Left hand is mirrored in X. Placed at the bind wrist.
 */
export const GRIP_OFF = [0.034, 0.072];        // grip centre from the wrist: palm, along
function buildHand(B, s, sp) {
  const m = new THREE.Matrix4().makeRotationZ(s * A_POSE);
  const mir = new THREE.Matrix4().makeScale(s, 1, 1);
  const wrist = BIND[s < 0 ? HAND_L : HAND_R];
  const xf = new THREE.Matrix4().makeTranslation(wrist[0], wrist[1], wrist[2]).multiply(m).multiply(mir);
  const reg = sp.gloves ? REG.leather : REG.skin, tint = sp.gloves ? sp.accent : sp.skinT, ppm = PPM.skin;
  const wf = wHand(s);
  const C = [-GRIP_OFF[0], -GRIP_OFF[1]], RG = 0.021;
  // palm: loft along −Y; section lx = thickness (palm at −X), lz = width (index at −Z)
  B.begin({ wf, grp: s < 0 ? 7 : 8, xf });
  const PR = [[0.014, 0.017, 0.027, 0.0], [0.0, 0.018, 0.031, 0.0], [-0.034, 0.0172, 0.041, -0.002], [-0.075, 0.0155, 0.045, -0.002], [-0.094, 0.012, 0.042, 0.0], [-0.1, 0.006, 0.03, 0.002]];
  B.loft(PR.map(([y, th, w, cx]) => ({ c: [cx, y, 0], X: [1, 0, 0], Z: [0, 0, 1],
    pts: circlePts(8, th, w, 3, (a) => (Math.cos(a) > 0 ? 0.004 * bump(y, -0.03, 0.03) : 0)) })), { reg, ppm, tint, capB: 'dome' });
  // curled fingers round the grip: index separate, three grouped
  const finger = (zc, hw, ht, f0, f1, r0, r1, n) => {
    const rs = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, f = lerp(f0, f1, t), r = lerp(r0, r1, t);
      const c = [C[0] + Math.cos(f) * r, C[1] + Math.sin(f) * r, zc];
      const R = [Math.cos(f), Math.sin(f), 0];
      rs.push({ c, X: [0, 0, 1], Z: R, pts: circlePts(6, hw * lerp(1, 0.85, t), ht * lerp(1, 0.85, t), 2.6) });
    }
    B.begin({ wf, grp: s < 0 ? 7 : 8, xf });
    B.loft(rs, { reg, ppm, tint, capB: 'dome' });
  };
  finger(0.011, 0.028, 0.0095, -0.62, -3.55, RG + 0.02, RG + 0.0085, 5);
  finger(-0.029, 0.0098, 0.0092, -0.62, -3.15, RG + 0.02, RG + 0.0085, 4);
  // thumb wraps the other way over the top of the index side
  const TH = [[-0.004, -0.016, -0.03, 0.0125], [-0.018, -0.032, -0.04, 0.012], [-0.038, -0.047, -0.042, 0.0105], [-0.056, -0.057, -0.033, 0.0095], [-0.064, -0.064, -0.017, 0.0085]];
  const trs = [];
  for (let i = 0; i < TH.length; i++) {
    const a = TH[Math.max(0, i - 1)], b = TH[Math.min(TH.length - 1, i + 1)];
    const T = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const X = norm(cross(T, [0, 0, 1])), Z = cross(X, T);
    trs.push({ c: TH[i].slice(0, 3), X, Z, pts: circlePts(6, TH[i][3], TH[i][3] * 0.85) });
  }
  B.begin({ wf, grp: s < 0 ? 7 : 8, xf });
  B.loft(trs, { reg, ppm, tint, capA: 'dome', capB: 'dome' });
}

// ───────────────────────────── gear ──────────────────────────────────────
/** A shell following the torso surface over y ∈ [y0, y1], θ ∈ [t0, t1], thick rolled border. */
function torsoShell(B, sp, y0, y1, t0, t1, off, o) {
  const rows = o.rows || 6, cols = o.cols || 12, bd = sp.build, border = o.border ?? 0.008;
  const ys = [y0 - 0.002, y0]; for (let i = 0; i <= rows; i++) ys.push(lerp(y0 + 0.006, y1 - 0.006, i / rows)); ys.push(y1, y1 + 0.002);
  const ts = [t0 - 0.012, t0]; for (let i = 0; i <= cols; i++) ts.push(lerp(t0 + 0.03, t1 - 0.03, i / cols)); ts.push(t1, t1 + 0.012);
  const base = B.n, nC = ts.length;
  B.begin({ wf: wTorso, grp: o.grp ?? 9 });
  for (let i = 0; i < ys.length; i++) {
    for (let j = 0; j < nC; j++) {
      const edge = i === 0 || i === ys.length - 1 || j === 0 || j === nC - 1, rim = i === 1 || i === ys.length - 2 || j === 1 || j === nC - 2;
      const extra = o.offFn ? o.offFn(ys[i], ts[j]) : 0;
      const p = torsoAt(ys[i], ts[j], bd, edge ? 0.003 : rim ? off - border * 0.35 : off + extra);
      const u = (ts[j] - t0) * 0.17, v = (y1 - ys[i]);
      const reg = o.reg;
      B.vert(p[0], ys[i], p[1], reg[0] + 3 + (u + (o.u0 || 0)) * o.ppm % (reg[2] - 6), reg[1] + 3 + clamp(v * o.ppm, 0, reg[3] - 6), o.tint[0], o.tint[1], o.tint[2]);
    }
  }
  for (let i = 0; i < ys.length - 1; i++) for (let j = 0; j < nC - 1; j++) {
    const a = base + i * nC + j, b = a + 1, c = a + nC, d = c + 1;
    // rows go up, columns go right round the body: outward is (b−a)×(c−a) when θ increases clockwise from above
    B.tri(a, c, b); B.tri(b, c, d);
  }
}
/** Point and frame on the torso surface for gear placement: returns { c, R, U, N } */
function onTorso(sp, y, th, off) {
  const p = torsoAt(y, th, sp.build, off);
  const N = [p[2], 0, p[3]], U = [0, 1, 0], R = norm(cross(U, N));
  return { c: [p[0], y, p[1]], R: [-R[0], -R[1], -R[2]], U, N };
}
function pouch(B, sp, y, th, w, h, d, off, o = {}) {
  const f = onTorso(sp, y, th, off + d);
  B.begin({ wf: wTorso, grp: 9 });
  B.rbox(f.c, f.R, f.U, f.N, w, h, d, { reg: REG.web, ppm: PPM.web, tint: o.tint || sp.vest, seg: o.seg || 8, flap: o.flap !== false, grp: 9 });
}
/** a strap following explicit control points (bind space), rectangular-ish section */
function strap(B, pts, w, t, o) {
  const rs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const T = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const out = norm(o.outFn ? o.outFn(pts[i]) : [pts[i][0], 0, pts[i][2]]);
    const X = norm(cross(T, out)), Z = norm(cross(X, T));
    rs.push({ c: pts[i], X, Z: [-Z[0], -Z[1], -Z[2]], pts: circlePts(o.seg || 4, w, t, 6) });
  }
  B.begin({ wf: o.wf || wTorso, grp: o.grp ?? 9 });
  B.loft(rs, { reg: o.reg || REG.web, ppm: o.ppm || PPM.web, tint: o.tint, capA: 'flat', capB: 'flat' });
}

function buildBelt(B, sp) {
  const bd = sp.build;
  B.begin({ wf: wTorso, grp: 10 });
  const rs = [];
  for (const [y, off, tm] of [[0.948, 0.004, 0.8], [0.952, 0.012, 1], [0.998, 0.012, 1], [1.002, 0.004, 0.8]]) {
    const pts = [];
    for (let j = 0; j < 16; j++) { const th = -PI + TAU * j / 16, p = torsoAt(y, th, bd, off); pts.push([p[0], p[1], tm]); }
    rs.push({ c: [0, y, 0], X: [1, 0, 0], Z: [0, 0, 1], pts });
  }
  B.loft(rs, { reg: sp.side === 'F' ? REG.web : REG.leather, ppm: PPM.leather, tint: sp.belt });
  const f = onTorso(sp, 0.975, 0, 0.018);
  B.begin({ wf: wTorso, grp: 10 });
  B.rbox(f.c, f.R, f.U, f.N, 0.03, 0.024, 0.006, { reg: REG.metal, tint: [0.55, 0.5, 0.4], seg: 6, n: 6 });
}

function buildChestRig(B, sp, count, grenades) {
  // front panel on the belly and lower chest, H-harness over the shoulders
  torsoShell(B, sp, 1.035, 1.305, -1.22, 1.22, 0.014, { reg: REG.web, ppm: PPM.web, tint: sp.vest, rows: 5, cols: 12 });
  const ths = count === 4 ? [-0.5, -0.17, 0.17, 0.5] : [-0.34, 0, 0.34];
  for (const th of ths) pouch(B, sp, 1.18, th, 0.04, 0.085, 0.024, 0.016);
  if (grenades) for (const th of [-0.95, 0.95]) pouch(B, sp, 1.16, th, 0.03, 0.05, 0.026, 0.016, { seg: 6 });
  else for (const th of [-0.92, 0.92]) pouch(B, sp, 1.21, th, 0.028, 0.045, 0.016, 0.016, { seg: 6 });
  for (const s of [-1, 1]) {
    const pts = [[s * 0.098, 1.29, -0.128], [s * 0.104, 1.38, -0.112], [s * 0.112, 1.44, -0.06], [s * 0.112, 1.462, 0.0], [s * 0.108, 1.44, 0.07], [s * 0.098, 1.37, 0.112], [s * 0.09, 1.25, 0.118], [s * 0.08, 1.10, 0.105], [s * 0.075, 1.01, 0.12]];
    strap(B, pts.map((p) => { const q = torsoAt(p[1], Math.atan2(p[0], -p[2]), sp.build, 0.009); return [q[0], p[1] + (Math.abs(p[2]) < 0.07 ? 0.006 : 0), q[1]]; }), 0.022, 0.004, { tint: mulT(sp.vest, 0.92) });
  }
  // back strap of the rig
  const bk = [];
  for (let i = 0; i <= 8; i++) { const th = lerp(PI - 1.25, PI + 1.25, i / 8), p = torsoAt(1.1, th, sp.build, 0.007); bk.push([p[0], 1.1, p[1]]); }
  strap(B, bk, 0.018, 0.003, { tint: mulT(sp.vest, 0.88), outFn: (p) => [p[0], 0, p[2]] });
}

function buildPlateCarrier(B, sp) {
  const bulge = (y, th) => 0.012 * bump(th, 0, 1.3) * bump(y, 1.29, 0.2);
  torsoShell(B, sp, 1.12, 1.43, -1.0, 1.0, 0.028, { reg: REG.web, ppm: PPM.web, tint: sp.vest, rows: 4, cols: 7, offFn: bulge, border: 0.016 });
  torsoShell(B, sp, 1.11, 1.43, PI - 0.95, PI + 0.95, 0.026, { reg: REG.web, ppm: PPM.web, tint: sp.vest, rows: 3, cols: 6, border: 0.016 });
  torsoShell(B, sp, 1.12, 1.27, 0.95, PI - 0.9, 0.012, { reg: REG.web, ppm: PPM.web, tint: mulT(sp.vest, 0.95), rows: 1, cols: 3 });
  torsoShell(B, sp, 1.12, 1.27, -PI + 0.9, -0.95, 0.012, { reg: REG.web, ppm: PPM.web, tint: mulT(sp.vest, 0.95), rows: 1, cols: 3 });
  for (const th of [-0.34, 0, 0.34]) pouch(B, sp, 1.19, th, 0.038, 0.06, 0.022, 0.04);
  pouch(B, sp, 1.36, -0.25, 0.05, 0.035, 0.014, 0.042, { seg: 6 });
  pouch(B, sp, 1.20, -1.35, 0.03, 0.06, 0.022, 0.014, { seg: 6, tint: mulT(sp.vest, 0.9) });
  for (const s of [-1, 1]) {
    const pts = [[s * 0.1, 1.40, -0.13], [s * 0.112, 1.445, -0.07], [s * 0.114, 1.465, 0.0], [s * 0.11, 1.445, 0.07], [s * 0.1, 1.40, 0.125]];
    strap(B, pts.map((p) => { const q = torsoAt(p[1], Math.atan2(p[0], -p[2]), sp.build, 0.012); return [q[0], p[1] + (Math.abs(p[2]) < 0.08 ? 0.009 : 0), q[1]]; }), 0.034, 0.008, { tint: sp.vest });
  }
}

function buildCollar(B, sp, fab) {
  // shirt collar: stands at the back, lies lower at the front with a V opening
  B.begin({ wf: (x, y, z) => { const t = sstep(1.45, 1.52, y); WS[CHEST] += 1 - t * 0.6; WS[NECK] += t * 0.6; }, grp: 11 });
  const seg = 14, rs = [];
  for (const [f, off, tm] of [[0, 0.003, 0.75], [0.45, 0.013, 0.95], [1, 0.02, 1], [0.92, 0.011, 0.8]]) {
    const pts = [], ys = [];
    for (let j = 0; j < seg; j++) {
      const th = -PI + TAU * j / seg, fr = Math.max(0, Math.cos(th));
      const yb = 1.478 - 0.024 * fr - 0.018 * bump(th, 0, 0.42), ch = 0.03 - 0.01 * fr;
      const y = yb + ch * f, p = headAt(y - HEAD_CY, th), l = Math.hypot(p[0], p[1] - 0.012) || 1;
      pts.push([p[0] + p[0] / l * off, p[1] + (p[1] - 0.012) / l * off, tm]); ys.push(y);
    }
    rs.push({ pts, ys });
  }
  loftFree(B, rs, { reg: fab, ppm: PPM.fab, u0: 0.1, tint: sp.fabTint, C: [0, 1.47, HEAD_CZ] });
}

/** helmet / cap / boonie on the head bone */
function buildHeadgear(B, sp) {
  const hc = [0, HEAD_CY, HEAD_CZ];
  const kind = sp.head;
  B.begin({ wf: wHead, grp: 12 });
  if (kind === 'ssh' || kind === 'modern') {
    const modern = kind === 'modern';
    const C = [0, HEAD_CY + (modern ? 0.026 : 0.024), HEAD_CZ + 0.004];
    const ax = modern ? 0.108 : 0.111, ay = modern ? 0.11 : 0.116, azF = modern ? 0.12 : 0.124, azB = modern ? 0.127 : 0.132;
    const rimH = (th) => {                 // rim height relative to the head centre
      const at = Math.abs(th), c = Math.cos(th);
      if (modern) return c > 0 ? lerp(0.022, 0.05, c) + 0.012 * bump(at, 1.5, 0.45) : lerp(0.022, -0.03, -c) + 0.012 * bump(at, 1.5, 0.45);
      return c > 0 ? lerp(-0.004, 0.038, Math.pow(c, 1.4)) : lerp(-0.004, -0.045, Math.pow(-c, 1.2));
    };
    const seg = 18, lats = [0.1, 0.3, 0.5, 0.67, 0.81, 0.92, 1.0];
    const rings = [];
    const pt = (th, f, grow = 0) => {
      const rh = rimH(th) - (C[1] - HEAD_CY);
      const phiR = Math.acos(clamp(rh / ay, -0.95, 0.95));
      const phi = phiR * f, sn = Math.sin(phi);
      const az = Math.cos(th) > 0 ? azF : azB;
      return [(ax + grow) * sn * Math.sin(th), C[1] + (ay + grow * 0.5) * Math.cos(phi), C[2] - (az + grow) * sn * Math.cos(th)];
    };
    const cover = sp.cover && !modern || modern && !sp.bareHelmet;
    const tint = cover ? sp.coverTint : sp.helmet;
    for (const f of lats) {
      const pts = [];
      for (let j = 0; j < seg; j++) { const th = -PI + TAU * j / seg, p = pt(th, f, cover ? 0.004 : 0); pts.push([p[0], p[2] - C[2], 1, p[1]]); }
      rings.push(pts);
    }
    // flare: out and down from the rim, then the lip back inside
    const flare = modern ? 0.006 : 0.015, drop = modern ? 0.004 : 0.012;
    const rimRing = rings[rings.length - 1];
    const ring2 = rimRing.map((p) => { const l = Math.hypot(p[0], p[1]) || 1; return [p[0] + p[0] / l * flare, p[1] + p[1] / l * flare, 0.95, p[3] - drop]; });
    const ring3 = ring2.map((p) => { const l = Math.hypot(p[0], p[1]) || 1; return [p[0] - p[0] / l * 0.006, p[1] - p[1] / l * 0.006, 0.6, p[3] - 0.004]; });
    const ring4 = rimRing.map((p) => { const l = Math.hypot(p[0], p[1]) || 1; return [p[0] - p[0] / l * 0.009, p[1] - p[1] / l * 0.009, 0.35, p[3] + 0.012]; });
    rings.push(ring2, ring3, ring4);
    const lr = rings.map((pts) => ({ c: [0, 0, C[2]], X: [1, 0, 0], Z: [0, 0, 1], pts: pts.map((p) => [p[0], p[1], p[2]]), ys: pts.map((p) => p[3]) }));
    // per-point heights: encode y by building rings with c.y = 0 and adding y via a custom loft
    const ringsXYZ = lr.map((r) => ({ c: [0, 0, 0], X: [1, 0, 0], Z: [0, 0, 1], pts: r.pts }));
    loftFree(B, lr, {
      reg: cover ? (sp.side === 'F' ? REG.fabF : REG.fabE) : REG.paint, tint, capA: 'dome', C,
      uvFn: cover ? null : (k, j) => [REG.paint[0] + 3 + j / seg * (REG.paint[2] - 6), REG.paint[1] + 3 + k / (lr.length - 1) * (REG.paint[3] - 6)],
      ppm: PPM.fab,
    });
    void ringsXYZ;
    if (sp.band && !modern) {        // rubber band round the helmet
      const br = [];
      for (const [f, g, tm] of [[0.62, 0.004, 0.8], [0.66, 0.008, 1], [0.74, 0.008, 1], [0.78, 0.004, 0.8]]) {
        const pts = []; for (let j = 0; j < seg; j++) { const th = -PI + TAU * j / seg, p = pt(th, f, g); pts.push([p[0], p[2] - C[2], 1, p[1]]); }
        br.push({ c: [0, 0, C[2]], X: [1, 0, 0], Z: [0, 0, 1], pts: pts.map((p) => [p[0], p[1], p[2]]), ys: pts.map((p) => p[3]) });
      }
      B.begin({ wf: wHead, grp: 12 });
      loftFree(B, br, { reg: REG.rubber, tint: [0.16, 0.15, 0.14], ppm: PPM.rubber, C });
    }
    if (modern) {
      // NVG shroud on the front, rails on the sides
      B.begin({ wf: wHead, grp: 12 });
      const fp = pt(0, 0.8, 0.004);
      B.rbox([fp[0], fp[1] - 0.004, fp[2] - 0.006], [1, 0, 0], [0, 0.95, -0.3], [0, 0.3, -0.95], 0.022, 0.016, 0.008, { reg: REG.plastic, tint: [0.12, 0.12, 0.12], seg: 6, n: 6 });
      for (const s of [-1, 1]) {
        const p = pt(s * PI / 2, 0.93, 0.004);
        B.rbox([p[0] + s * 0.004, p[1] + 0.006, p[2]], [0, 0, -1], [0, 1, 0], [s, 0, 0], 0.035, 0.008, 0.005, { reg: REG.plastic, tint: [0.14, 0.14, 0.13], seg: 6, n: 6 });
      }
    }
    // chin strap: from the rim at the sides under the chin
    const sp2 = [];
    for (const [x, h, z] of [[-0.084, -0.004, 0.004], [-0.077, -0.04, -0.012], [-0.064, -0.075, -0.035], [-0.044, -0.1, -0.058], [-0.022, -0.113, -0.07], [0, -0.117, -0.073],
      [0.022, -0.113, -0.07], [0.044, -0.1, -0.058], [0.064, -0.075, -0.035], [0.077, -0.04, -0.012], [0.084, -0.004, 0.004]]) {
      const th = Math.atan2(x, -(z)), p = headAt(h, th), l = Math.hypot(p[0], p[1]) || 1;
      sp2.push([p[0] + p[0] / l * 0.004, HEAD_CY + h, HEAD_CZ + p[1] + p[1] / l * 0.004]);
    }
    strap(B, sp2, 0.007, 0.0018, { wf: wHead, grp: 12, tint: modern ? [0.12, 0.12, 0.11] : mulT(sp.helmet, 0.55), outFn: (p) => [p[0], (p[1] - HEAD_CY) * 0.6, p[2] - HEAD_CZ], reg: REG.web });
  } else if (kind === 'cap') {
    // patrol cap: soft crown, flat top, short peak
    const rs = [];
    for (const [h, g, tm] of [[0.045, 0.006, 0.8], [0.052, 0.009, 1], [0.08, 0.008, 1], [0.112, 0.012, 1], [0.124, 0.014, 1], [0.13, 0.006, 0.95]]) {
      const pts = [];
      for (let j = 0; j < 20; j++) {
        const th = -PI + TAU * j / 20, hh = h - 0.012 * Math.max(0, -Math.cos(th)) * (h < 0.1 ? 1 : 0.4);
        const base = headAt(Math.min(hh, 0.07), th), l = Math.hypot(base[0], base[1]) || 1;
        const grow = g + (h > 0.1 ? 0.004 : 0);
        pts.push([base[0] + base[0] / l * grow, base[1] + base[1] / l * grow, tm, HEAD_CY + hh]);
      }
      rs.push({ c: [0, 0, HEAD_CZ], X: [1, 0, 0], Z: [0, 0, 1], pts: pts.map((p) => [p[0], p[1], p[2]]), ys: pts.map((p) => p[3]) });
    }
    loftFree(B, rs, { reg: sp.side === 'F' ? REG.fabF : REG.fabE, ppm: PPM.fab, tint: mulT(sp.fabTint, 0.95), capB: 'dome', C: [0, HEAD_CY, HEAD_CZ] });
    // peak
    B.begin({ wf: wHead, grp: 12 });
    const pk = [];
    for (let i = 0; i <= 6; i++) {
      const th = lerp(-1.05, 1.05, i / 6), base = headAt(0.05, th), l = Math.hypot(base[0], base[1]);
      const ext = 0.058 * Math.cos(th * 1.2);
      const x0 = base[0] + base[0] / l * 0.008, z0 = base[1] + base[1] / l * 0.008;
      const x1 = x0 + base[0] / l * ext, z1 = z0 + base[1] / l * ext;
      pk.push([x0, z0, x1, z1]);
    }
    const rows = [];
    for (const [t, dy] of [[0, 0], [0.5, -0.008], [1, -0.02]]) {
      rows.push(pk.map((p) => [lerp(p[0], p[2], t), HEAD_CY + 0.052 + dy, HEAD_CZ + lerp(p[1], p[3], t)]));
    }
    plate(B, rows, 0.0035, { reg: sp.side === 'F' ? REG.fabF : REG.fabE, ppm: PPM.fab, tint: mulT(sp.fabTint, 0.85) });
  } else if (kind === 'boonie') {
    const rs = [];
    for (const [h, g, tm] of [[0.03, 0.008, 0.8], [0.04, 0.012, 1], [0.075, 0.012, 1], [0.105, 0.016, 1], [0.124, 0.014, 1], [0.134, 0.006, 1]]) {
      const pts = [];
      for (let j = 0; j < 20; j++) {
        const th = -PI + TAU * j / 20, base = headAt(Math.min(h, 0.075), th), l = Math.hypot(base[0], base[1]) || 1;
        pts.push([base[0] + base[0] / l * g, base[1] + base[1] / l * g, tm, HEAD_CY + h - 0.01 * Math.max(0, -Math.cos(th))]);
      }
      rs.push({ c: [0, 0, HEAD_CZ], X: [1, 0, 0], Z: [0, 0, 1], pts: pts.map((p) => [p[0], p[1], p[2]]), ys: pts.map((p) => p[3]) });
    }
    loftFree(B, rs, { reg: REG.fabE, ppm: PPM.fab, u0: 0.3, tint: mulT(sp.fabTint, 1.02), capB: 'dome', C: [0, HEAD_CY, HEAD_CZ] });
    // brim all round, drooping
    B.begin({ wf: wHead, grp: 12 });
    const rows = [];
    for (const [ext, dy] of [[0, 0], [0.03, -0.01], [0.062, -0.03]]) {
      const row = [];
      for (let j = 0; j <= 24; j++) {
        const th = -PI + TAU * j / 24, base = headAt(0.05, th), l = Math.hypot(base[0], base[1]);
        const e = 0.014 + ext * (1 + 0.15 * Math.sin(th * 3 + 1)), droop = dy * (1 + 0.3 * Math.cos(th * 2));
        row.push([base[0] + base[0] / l * e, HEAD_CY + 0.035 + droop - 0.01 * Math.max(0, -Math.cos(th)), HEAD_CZ + base[1] + base[1] / l * e]);
      }
      rows.push(row);
    }
    plate(B, rows, 0.003, { reg: REG.fabE, ppm: PPM.fab, tint: mulT(sp.fabTint, 0.95) });
  }
}

/** Loft whose ring points carry their own y (ring.ys) relative to nothing: positions = (x, ys, C.z + z). */
function loftFree(B, rings, o) {
  const fake = rings.map((r) => ({ c: [0, 0, 0], X: [1, 0, 0], Z: [0, 0, 1], pts: r.pts.map((p, j) => [p[0], p[1], p[2], r.ys[j]]), t: r.t }));
  // Builder.loft computes q = c + X*lx + Z*lz; feed y through a transform-free hook
  const save = B.loft;
  const C = o.C || [0, 0, 0];
  const P = (R, p) => [p[0], p[3], C[2] + p[1]];
  // inline variant of loft with custom point placement
  const nR = fake.length, nP = fake[0].pts.length, base = B.n, tint = o.tint || [1, 1, 1], reg = o.reg, ppm = o.ppm || 500;
  let vAcc = 0;
  for (let k = 0; k < nR; k++) {
    let uAcc = 0, prev = null;
    if (k > 0) vAcc += 0.02;
    for (let j = 0; j <= nP; j++) {
      const p = fake[k].pts[j % nP], q = P(fake[k], p);
      if (prev) uAcc += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
      prev = q;
      const m = p[2] ?? 1;
      const px = o.uvFn ? o.uvFn(k, j, nP, q) : [clamp(reg[0] + 3 + (uAcc + (o.u0 || 0)) * ppm, reg[0] + 3, reg[0] + reg[2] - 3), clamp(reg[1] + 3 + (vAcc + 0.1) * ppm, reg[1] + 3, reg[1] + reg[3] - 3)];
      B.vert(q[0], q[1], q[2], px[0], px[1], tint[0] * m, tint[1] * m, tint[2] * m);
    }
  }
  // winding: faces point away from the hat's centre
  const A = B.nom;
  let acc = 0;
  for (let k = 0; k < nR - 1; k++) for (let j = 0; j < nP; j++) {
    const a = base + k * (nP + 1) + j, b = a + 1, c = a + nP + 1;
    const ux = A[b * 3] - A[a * 3], uy = A[b * 3 + 1] - A[a * 3 + 1], uz = A[b * 3 + 2] - A[a * 3 + 2];
    const vx = A[c * 3] - A[a * 3], vy = A[c * 3 + 1] - A[a * 3 + 1], vz = A[c * 3 + 2] - A[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    acc += nx * (A[a * 3] - C[0]) + ny * (A[a * 3 + 1] - C[1]) + nz * (A[a * 3 + 2] - C[2]);
  }
  const flip = acc < 0;
  for (let k = 0; k < nR - 1; k++) for (let j = 0; j < nP; j++) {
    const a = base + k * (nP + 1) + j, b = a + 1, c = a + nP + 1, d = c + 1;
    if (flip) { B.tri(a, c, b); B.tri(b, c, d); } else { B.tri(a, b, c); B.tri(b, d, c); }
  }
  const cap = (k) => {
    const r0 = base + k * (nP + 1);
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < nP; j++) { cx += A[(r0 + j) * 3]; cy += A[(r0 + j) * 3 + 1]; cz += A[(r0 + j) * 3 + 2]; }
    cx /= nP; cy /= nP; cz /= nP;
    const up = 1;                       // crowns and hat tops face up
    cy += 0.006;
    const px = o.uvFn ? o.uvFn(k, 0, nP, [cx, cy, cz]) : [reg[0] + 10, reg[1] + 10];
    const ci = B.vert(cx, cy, cz, px[0], px[1], tint[0], tint[1], tint[2]);
    for (let j = 0; j < nP; j++) {
      const a = r0 + j, b = r0 + j + 1;
      const ux = A[a * 3] - A[ci * 3], uy = A[a * 3 + 1] - A[ci * 3 + 1], uz = A[a * 3 + 2] - A[ci * 3 + 2];
      const vx = A[b * 3] - A[ci * 3], vy = A[b * 3 + 1] - A[ci * 3 + 1], vz = A[b * 3 + 2] - A[ci * 3 + 2];
      const ny = uz * vx - ux * vz;
      if (ny * up >= 0 || Math.abs(ny) < 1e-12) B.tri(ci, a, b); else B.tri(ci, b, a);
      void uy; void vy;
    }
  };
  if (o.capA) cap(0);
  if (o.capB) cap(nR - 1);
  void save;
}

/** Two-sided thin plate from rows of points (row 0 = attached edge). */
function plate(B, rows, th, o) {
  const tint = o.tint, reg = o.reg, ppm = o.ppm;
  const nR = rows.length, nC = rows[0].length;
  for (const side of [1, -1]) {
    B.begin({ wf: wHead, grp: 12 });
    const base = B.n;
    for (let i = 0; i < nR; i++) for (let j = 0; j < nC; j++) {
      const p = rows[i][j];
      B.vert(p[0], p[1] + side * th, p[2], reg[0] + 3 + (j / (nC - 1)) * Math.min(reg[2] - 6, 0.3 * ppm), reg[1] + 3 + i * 10, tint[0] * (side > 0 ? 1 : 0.7), tint[1] * (side > 0 ? 1 : 0.7), tint[2] * (side > 0 ? 1 : 0.7));
    }
    for (let i = 0; i < nR - 1; i++) for (let j = 0; j < nC - 1; j++) {
      const a = base + i * nC + j, b = a + 1, c = a + nC, d = c + 1;
      // orient so the top side faces up
      const A = B.nom, ux = A[b * 3] - A[a * 3], uz = A[b * 3 + 2] - A[a * 3 + 2], vx = A[c * 3] - A[a * 3], vz = A[c * 3 + 2] - A[a * 3 + 2];
      const ny = uz * vx - ux * vz;
      if ((ny > 0) === (side > 0)) { B.tri(a, b, c); B.tri(b, d, c); } else { B.tri(a, c, b); B.tri(b, c, d); }
    }
  }
  // outer edge strip
  B.begin({ wf: wHead, grp: 12 });
  const last = rows[nR - 1], e0 = B.n;
  for (const p of last) { B.vert(p[0], p[1] + th, p[2], reg[0] + 5, reg[1] + 5, tint[0] * 0.8, tint[1] * 0.8, tint[2] * 0.8); B.vert(p[0], p[1] - th, p[2], reg[0] + 5, reg[1] + 8, tint[0] * 0.8, tint[1] * 0.8, tint[2] * 0.8); }
  const prevRow = rows[nR - 2];
  for (let j = 0; j < nC - 1; j++) {
    const a = e0 + j * 2, b = a + 1, c = a + 2, d = a + 3;
    // outward = away from the previous row
    const A = B.nom, ox = last[j][0] - prevRow[j][0], oz = last[j][2] - prevRow[j][2];
    const ux = A[c * 3] - A[a * 3], uz = A[c * 3 + 2] - A[a * 3 + 2], uy = A[c * 3 + 1] - A[a * 3 + 1], vy = A[b * 3 + 1] - A[a * 3 + 1];
    const nx = uy * 0 - uz * vy, nz = ux * vy - uy * 0;
    if (nx * ox + nz * oz > 0) { B.tri(a, c, b); B.tri(b, c, d); } else { B.tri(a, b, c); B.tri(b, d, c); }
  }
}

function buildExtras(B, sp) {
  const bd = sp.build;
  for (const ex of sp.extra || []) {
    if (ex === 'canteen') {
      const f = onTorso(sp, 0.92, 2.35, 0.045);
      B.begin({ wf: wTorso, grp: 10 });
      B.rbox(f.c, f.R, f.U, f.N, 0.052, 0.07, 0.032, { reg: REG.web, ppm: PPM.web, tint: mulT(sp.vest, 1.05), seg: 12, n: 2.6, flap: true });
    } else if (ex === 'buttpack') {
      const f = onTorso(sp, 0.955, PI, 0.05);
      B.begin({ wf: wTorso, grp: 10 });
      B.rbox(f.c, f.R, f.U, f.N, 0.11, 0.06, 0.042, { reg: REG.web, ppm: PPM.web, tint: sp.vest, seg: 12, n: 3.2, flap: true });
    } else if (ex === 'shovel') {
      const f = onTorso(sp, 0.9, -2.0, 0.02);
      B.begin({ wf: wTorso, grp: 10 });
      B.rbox(f.c, f.R, f.U, f.N, 0.07, 0.1, 0.014, { reg: REG.web, ppm: PPM.web, tint: mulT(sp.vest, 0.95), seg: 10, n: 3, flap: true });
    } else if (ex === 'holster') {
      const f = onTorso(sp, 0.92, 1.45, 0.03);
      B.begin({ wf: wTorso, grp: 10 });
      B.rbox(f.c, f.R, [0, 0.97, -0.24], f.N, 0.03, 0.075, 0.02, { reg: REG.leather, ppm: PPM.leather, tint: sp.belt, seg: 10, n: 3, flap: true });
    } else if (ex === 'mapcase') {
      const f = onTorso(sp, 0.93, -1.55, 0.016);
      B.begin({ wf: wTorso, grp: 10 });
      B.rbox(f.c, f.R, f.U, f.N, 0.11, 0.09, 0.012, { reg: REG.leather, ppm: PPM.leather, tint: mulT(sp.belt, 1.1), seg: 10, n: 4, flap: true });
      strap(B, [[-0.17 * bd, 1.0, 0.0], [-0.13, 1.2, -0.115], [-0.02, 1.33, -0.128], [0.1, 1.42, -0.105], [0.12, 1.466, 0.0], [0.11, 1.42, 0.1], [0.02, 1.3, 0.12], [-0.12, 1.12, 0.1], [-0.16 * bd, 1.0, 0.04]]
        .map((p) => { const q = torsoAt(p[1], Math.atan2(p[0], -p[2]), bd, 0.007); return [q[0], p[1] + (Math.abs(p[2]) < 0.05 ? 0.008 : 0), q[1]]; }), 0.012, 0.003, { reg: REG.leather, ppm: PPM.leather, tint: sp.belt });
    } else if (ex === 'radio') {
      // R-159-style backpack radio with a whip antenna
      const c = [0.02, 1.235, 0.0];
      const back = torsoAt(1.24, PI, bd, 0.0);
      c[2] = back[1] + 0.058;
      B.begin({ wf: wChest, grp: 13 });
      B.rbox(c, [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.12, 0.15, 0.055, { reg: REG.metal, ppm: PPM.metal, tint: [0.32, 0.33, 0.24], seg: 12, n: 6, flap: false });
      B.rbox([c[0] + 0.065, c[1] + 0.155, c[2] + 0.01], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.025, 0.014, 0.02, { reg: REG.plastic, tint: [0.1, 0.1, 0.1], seg: 8, n: 4, flap: false });
      B.begin({ wf: wChest, grp: 13 });
      B.tube([c[0] + 0.07, c[1] + 0.16, c[2] + 0.012], [c[0] + 0.09, c[1] + 0.86, c[2] + 0.07], 0.0035, 0.0018, 4, { reg: REG.rubber, tint: [0.1, 0.1, 0.1], mid: [[0.04, 0.005]], caps: false });
      for (const s of [-1, 1]) {
        strap(B, [[s * 0.1, 1.40, -0.128], [s * 0.112, 1.445, -0.07], [s * 0.114, 1.466, 0.0], [s * 0.11, 1.44, 0.07], [s * 0.1, 1.36, back[1] + 0.012]]
          .map((p) => { const q = torsoAt(p[1], Math.atan2(p[0], -p[2]), bd, 0.007); return [q[0], p[1] + (Math.abs(p[2]) < 0.08 ? 0.008 : 0), q[1]]; }), 0.018, 0.004, { reg: REG.web, tint: [0.3, 0.3, 0.22] });
      }
    } else if (ex === 'veil') {
      // sniper's scrim veil over the shoulders and upper back, ragged
      torsoShell(B, sp, 1.30, 1.47, PI - 2.3, PI + 2.3, 0.022, { reg: REG.fabE, ppm: PPM.fab, tint: mulT(sp.fabTint, 0.95), rows: 3, cols: 14, border: 0.01,
        offFn: (y, th) => 0.012 * fbm(th * 3, y * 20, 2, 7) });
    } else if (ex === 'scarf') {
      B.begin({ wf: (x, y) => { WS[CHEST] += 0.6; WS[NECK] += 0.4; }, grp: 11 });
      const rs = [];
      for (const [y, off, tm] of [[1.43, 0.03, 0.85], [1.455, 0.042, 1], [1.49, 0.036, 1], [1.51, 0.02, 0.9]]) {
        const pts = []; for (let j = 0; j < 16; j++) { const th = -PI + TAU * j / 16, p = headAt(y - HEAD_CY, th), l = Math.hypot(p[0], p[1]) || 1; pts.push([p[0] + p[0] / l * off, p[1] + p[1] / l * off]); }
        rs.push({ c: [0, y, HEAD_CZ], X: [1, 0, 0], Z: [0, 0, 1], pts, t: tm });
      }
      B.loft(rs, { reg: REG.web, ppm: PPM.web, tint: [0.42, 0.37, 0.28] });
    } else if (ex === 'beltpouch') {
      for (const th of [-0.6, 0.6]) {
        const f = onTorso(sp, 0.975, th, 0.035);
        B.begin({ wf: wTorso, grp: 10 });
        B.rbox(f.c, f.R, f.U, f.N, 0.035, 0.045, 0.02, { reg: REG.web, ppm: PPM.web, tint: sp.vest, seg: 8, flap: true });
      }
    }
  }
}

// ───────────────────────────── rifles ────────────────────────────────────
/** grip data in weapon space: right-hand grip at the origin, axis bottom → top */
const GUNS = {
  ak: { gripAxis: [0, 0.96, -0.28], rail: [0.07, -0.33, -0.17, -0.25], butt: [0, 0.025, 0.345], muzzle: -0.56 },
  svd: { gripAxis: [0, 0.96, -0.28], rail: [0.075, -0.40, -0.20, -0.28], butt: [0, 0.01, 0.43], muzzle: -0.87 },
};
function buildRifle(B, kindGun, sp) {
  const xf = new THREE.Matrix4().makeTranslation(BIND[WEAPON][0] * B.k, BIND[WEAPON][1] * B.k, BIND[WEAPON][2] * B.k);
  const metal = [0.2, 0.205, 0.215], dark = [0.13, 0.13, 0.135];
  const furn = sp.furniture === 'polymer' ? { reg: REG.plastic, tint: [0.17, 0.15, 0.14] } : sp.furniture === 'tan' ? { reg: REG.plastic, tint: [0.5, 0.42, 0.3] } : { reg: REG.wood, tint: [1, 1, 1] };
  const o = (reg, tint, extra) => ({ reg, tint, xf, scale: false, ...extra });
  B.begin({ wf: wWeapon, grp: 20, xf, scale: false });
  B.wf = wWeapon; B.g = 20;
  if (kindGun === 'svd') {
    B.extrude([[-0.018, 0.048], [0.012, 0.048], [0.042, -0.064], [0.03, -0.076], [0.004, -0.074], [-0.022, 0.018]], 0.015, o(furn.reg, furn.tint, { smooth: true }));     // grip
    B.extrude([[-0.19, 0.04], [0.10, 0.04], [0.105, 0.07], [0.10, 0.112], [-0.19, 0.112]], 0.021, o(REG.metal, metal));               // receiver
    B.extrude([[0.10, 0.068], [0.10, 0.114], [0.24, 0.124], [0.34, 0.098], [0.40, 0.094], [0.40, 0.066], [0.2, 0.074]], 0.018, o(furn.reg, furn.tint, { smooth: true }));   // comb
    B.extrude([[0.385, 0.096], [0.44, 0.096], [0.445, -0.07], [0.39, -0.066]], 0.02, o(furn.reg, furn.tint, { smooth: true }));     // butt
    B.extrude([[0.03, -0.062], [0.05, -0.076], [0.40, -0.058], [0.40, -0.036], [0.06, -0.044]], 0.016, o(furn.reg, furn.tint, { smooth: true }));   // lower bar
    B.extrude([[0.44, 0.096], [0.452, 0.096], [0.457, -0.07], [0.445, -0.07]], 0.021, o(REG.rubber, [0.16, 0.16, 0.16]));
    B.extrude([[-0.105, 0.042], [-0.045, 0.042], [-0.05, -0.065], [-0.11, -0.058]], 0.013, o(REG.metal, dark));               // mag
    B.extrude([[-0.45, 0.06], [-0.19, 0.056], [-0.19, 0.122], [-0.45, 0.116]], 0.024, o(furn.reg, furn.tint, { smooth: true }));     // handguard
    B.tube([0, 0.09, -0.19], [0, 0.09, -0.80], 0.0105, 0.0095, 8, o(REG.metal, dark));
    B.tube([0, 0.09, -0.80], [0, 0.09, -0.87], 0.0125, 0.012, 8, o(REG.metal, dark));
    B.extrude([[-0.62, 0.08], [-0.59, 0.08], [-0.59, 0.135], [-0.6, 0.15], [-0.61, 0.15], [-0.62, 0.12]], 0.011, o(REG.metal, dark));
    B.tube([0, 0.124, -0.45], [0, 0.124, -0.6], 0.009, 0.009, 6, o(REG.metal, dark));
    // PSO-1-style scope on a left-side mount
    B.extrude([[-0.07, 0.11], [0.03, 0.11], [0.03, 0.15], [-0.07, 0.15]], 0.008, o(REG.metal, dark, { x: -0.014 }));
    B.tube([-0.02, 0.168, -0.11], [-0.02, 0.168, 0.09], 0.0145, 0.0145, 10, o(REG.metal, [0.16, 0.16, 0.17], { mid: [[0.06, 0.0145]] }));
    B.tube([-0.02, 0.168, -0.16], [-0.02, 0.168, -0.11], 0.021, 0.0145, 10, o(REG.metal, [0.16, 0.16, 0.17]));
    B.tube([-0.02, 0.168, 0.09], [-0.02, 0.168, 0.145], 0.0145, 0.019, 10, o(REG.rubber, [0.1, 0.1, 0.1]));
    B.extrude([[-0.02, 0.18], [0.02, 0.18], [0.02, 0.198], [-0.02, 0.198]], 0.009, o(REG.metal, [0.16, 0.16, 0.17], { x: -0.02 }));
  } else {
    B.extrude([[-0.02, 0.048], [0.012, 0.048], [0.04, -0.062], [0.028, -0.074], [0.004, -0.072], [-0.024, 0.018]], 0.0145, o(furn.reg, furn.tint, { smooth: true }));   // grip
    B.extrude([[-0.17, 0.04], [0.118, 0.04], [0.124, 0.066], [0.118, 0.106], [0.05, 0.12], [-0.14, 0.116], [-0.17, 0.106]], 0.022, o(REG.metal, metal));   // receiver + cover
    B.extrude([[-0.172, 0.104], [-0.11, 0.113], [-0.11, 0.125], [-0.172, 0.13]], 0.015, o(REG.metal, dark));       // rear sight block
    B.extrude([[-0.048, 0.04], [-0.002, 0.04], [-0.006, 0.018], [-0.044, 0.016]], 0.004, o(REG.metal, dark));      // trigger guard plate
    if (sp.foldStock) {
      B.extrude([[0.11, 0.09], [0.118, 0.104], [0.36, 0.088], [0.36, 0.076]], 0.006, o(REG.metal, dark, { x: -0.012 }));
      B.extrude([[0.11, 0.05], [0.118, 0.064], [0.36, 0.0], [0.355, -0.012]], 0.006, o(REG.metal, dark, { x: -0.012 }));
      B.extrude([[0.345, 0.092], [0.365, 0.092], [0.365, -0.02], [0.345, -0.02]], 0.016, o(REG.metal, dark));
    } else {
      B.extrude([[0.112, 0.044], [0.12, 0.11], [0.34, 0.09], [0.345, 0.074], [0.345, -0.034], [0.33, -0.04], [0.17, 0.036]], 0.019, o(furn.reg, furn.tint, { smooth: true }));
      B.extrude([[0.343, 0.092], [0.355, 0.092], [0.355, -0.04], [0.343, -0.042]], 0.02, o(REG.metal, dark));
    }
    // curved magazine: loft along an arc
    const mr = [];
    let mz = -0.112, my = 0.045, ang = -PI / 2 - 0.14;
    for (let i = 0; i <= 6; i++) {
      const t = i / 6, len = lerp(0.033, 0.039, t);
      const T = [0, Math.sin(ang), Math.cos(ang)], Lx = [0, -T[2], T[1]];      // along the length of the section (front-back)
      mr.push({ c: [0, my, mz], X: [1, 0, 0], Z: Lx, pts: circlePts(8, 0.0135, len, 5) });
      mz += Math.cos(ang) * 0.036; my += Math.sin(ang) * 0.036; ang -= 0.085;
    }
    B.begin({ wf: wWeapon, grp: 20, xf, scale: false, weld: true });
    B.loft(mr, { reg: REG.metal, ppm: PPM.metal, tint: sp.furniture === 'polymer' || sp.furniture === 'tan' ? [0.22, 0.17, 0.14] : [0.3, 0.29, 0.28], capA: 'flat', capB: 'flat' });
    B.extrude([[-0.34, 0.055], [-0.18, 0.05], [-0.17, 0.064], [-0.17, 0.104], [-0.34, 0.102], [-0.35, 0.09], [-0.35, 0.066]], 0.021, o(furn.reg, furn.tint, { smooth: true }));   // lower handguard
    B.tube([0, 0.121, -0.17], [0, 0.121, -0.33], 0.0165, 0.0155, 8, o(furn.reg, furn.tint));     // upper handguard
    B.tube([0, 0.121, -0.33], [0, 0.121, -0.38], 0.011, 0.011, 6, o(REG.metal, dark));           // gas tube
    B.extrude([[-0.405, 0.074], [-0.375, 0.074], [-0.375, 0.135], [-0.405, 0.13]], 0.013, o(REG.metal, dark));     // gas block
    B.tube([0, 0.09, -0.17], [0, 0.09, -0.52], 0.0105, 0.0095, 6, o(REG.metal, dark));
    B.tube([0, 0.09, -0.52], [0, 0.09, -0.565], 0.0135, 0.0125, 8, o(REG.metal, dark));
    B.extrude([[-0.50, 0.078], [-0.47, 0.078], [-0.47, 0.11], [-0.48, 0.128], [-0.484, 0.152], [-0.492, 0.152], [-0.50, 0.112]], 0.011, o(REG.metal, dark));  // front sight
  }
}

// ───────────────────────────── AO bake ──────────────────────────────────
function bakeAO(B, sp) {
  const N = B.normals, P = B.nom, out = new Float32Array(B.n * 3);
  const caps = [];
  const cap = (a, b, r, g) => caps.push({ a, b, r, g });
  cap([0, 0.86, 0.01], [0, 1.36, 0.0], 0.145 * sp.build, 1);
  cap([0, 1.47, 0.01], [0, 1.62, -0.01], 0.07, 6);
  for (const s of [-1, 1]) {
    cap([s * HIPX, 0.92, -0.005], [s * HIPX, 0.52, -0.01], 0.07 * sp.build, s < 0 ? 2 : 3);
    cap([s * HIPX, 0.5, 0], [s * HIPX, 0.12, 0.004], 0.052, s < 0 ? 2 : 3);
    const sh = BIND[s < 0 ? ARM_L : ARM_R], el = BIND[s < 0 ? FORE_L : FORE_R], wr = BIND[s < 0 ? HAND_L : HAND_R];
    cap(sh, el, 0.048, s < 0 ? 4 : 5); cap(el, wr, 0.038, s < 0 ? 4 : 5);
  }
  if (sp.head === 'ssh' || sp.head === 'modern') cap([0, 1.68, -0.01], [0, 1.70, -0.0], 0.12, 12);
  else if (sp.head === 'boonie') cap([0, 1.69, -0.01], [0, 1.70, 0], 0.13, 12);
  else cap([0, 1.70, -0.02], [0, 1.71, -0.01], 0.1, 12);
  if (sp.rig) cap([0, 1.1, -0.01], [0, 1.33, 0.0], 0.165 * sp.build, 9);
  const q = [0, 0, 0];
  for (let v = 0; v < B.n; v++) {
    const px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2], nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2], g = B.grp[v];
    let ao = 1;
    if (g !== 20) {
      for (const c of caps) {
        if (c.g === g || (g === 9 && c.g === 1) || (g === 10 && c.g === 1) || (g === 11 && (c.g === 1 || c.g === 6))) continue;
        const ab = [c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]], L2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
        let t = L2 > 0 ? ((px - c.a[0]) * ab[0] + (py - c.a[1]) * ab[1] + (pz - c.a[2]) * ab[2]) / L2 : 0; t = clamp01(t);
        q[0] = c.a[0] + ab[0] * t - px; q[1] = c.a[1] + ab[1] * t - py; q[2] = c.a[2] + ab[2] * t - pz;
        const d = Math.hypot(q[0], q[1], q[2]) || 1e-4;
        const cosT = (q[0] * nx + q[1] * ny + q[2] * nz) / d;
        if (cosT <= 0) continue;
        const f = Math.pow(c.r / Math.max(d, c.r), 2) * cosT;
        ao *= 1 - 0.75 * f;
      }
      // ground and height: darker towards the boots and on downward faces
      ao *= lerp(0.72, 1, sstep(0.0, 0.55, py)) * (0.88 + 0.12 * (ny * 0.5 + 0.5));
    } else ao = 0.92 + 0.08 * ny;
    ao = clamp(ao, 0.3, 1);
    const k = Math.pow(ao, 0.9);
    out[v * 3] = B.tint[v * 3] * k; out[v * 3 + 1] = B.tint[v * 3 + 1] * k; out[v * 3 + 2] = B.tint[v * 3 + 2] * k;
  }
  return out;
}

// ───────────────────────────── variants ─────────────────────────────────
const C = (hex, k = 1) => { const c = new THREE.Color(hex); return [c.r * k, c.g * k, c.b * k]; };
const SKINS = [[1, 1, 1], [0.86, 0.8, 0.76], [1.05, 1.0, 0.95]];
function specFor(kind, variant) {
  const E = { side: 'E', fabTint: [1, 1, 1], vest: C(0x6b6450, 1.15), belt: C(0x4a3a2a, 1.25), boot: C(0x262220, 1.2), helmet: C(0x4a5240, 1.25), coverTint: [1, 1, 1], accent: C(0x5a5040, 1.2) };
  const F = { side: 'F', fabTint: [1, 1, 1], vest: C(0x60664a, 1.2), belt: C(0x5a5a44, 1.2), boot: C(0x6a5440, 1.25), helmet: C(0x585e44, 1.2), coverTint: C(0xb09a72, 1.15), accent: C(0xb09670, 1.2) };
  let s;
  if (kind === 'friendly') {
    s = variant === 1
      ? { ...F, head: 'modern', bareHelmet: true, sleeve: 'rolled', rig: 'plate', skin: 1, k: 0.985, build: 1.0, gloves: true, knee: true, gun: 'ak', furniture: 'polymer', extra: [] }
      : { ...F, head: 'modern', sleeve: 'down', rig: 'plate', skin: 0, k: 1.0, build: 1.02, gloves: true, knee: true, gun: 'ak', furniture: 'tan', extra: [] };
  } else if (kind === 'sniper') {
    s = { ...E, head: 'boonie', sleeve: 'down', rig: null, skin: 1, k: 1.0, build: 0.97, gun: 'svd', extra: ['veil', 'scarf', 'beltpouch', 'canteen'] };
  } else if (kind === 'officer') {
    s = { ...E, head: 'cap', sleeve: 'down', rig: null, skin: 2, k: 1.01, build: 1.02, gun: 'ak', furniture: 'polymer', foldStock: true, extra: ['radio', 'holster', 'mapcase'] };
  } else {
    s = [
      { ...E, head: 'ssh', sleeve: 'down', rig: 'chest3', skin: 0, k: 1.0, build: 1.0, gun: 'ak', extra: ['canteen'] },
      { ...E, head: 'ssh', cover: true, sleeve: 'rolled', rig: 'chest4', skin: 1, k: 0.975, build: 1.04, gun: 'ak', extra: ['buttpack'] },
      { ...E, head: 'ssh', band: true, sleeve: 'down', rig: 'chest3g', skin: 2, k: 1.025, build: 0.97, gun: 'ak', extra: ['canteen', 'shovel'] },
    ][variant % 3];
  }
  s.skinT = SKINS[s.skin];
  return s;
}
export const SOLDIER_VARIANTS = { rifle: 3, sniper: 1, officer: 1, friendly: 2 };

const assetCache = new Map();
function soldierAsset(kind, variant) {
  const key = kind + ':' + variant;
  if (assetCache.has(key)) return assetCache.get(key);
  const sp = specFor(kind, variant);
  const B = new Builder(sp.k);
  const parts = {};
  const step = (name, fn) => { const t0 = B.idx.length; B.mark(name); fn(); parts[name] = (B.idx.length - t0) / 3; };
  step('body', () => buildBody(B, sp));
  step('belt', () => buildBelt(B, sp));
  step('collar', () => buildCollar(B, sp, sp.side === 'F' ? REG.fabF : REG.fabE));
  step('vest', () => {
    if (sp.rig === 'chest3' || sp.rig === 'chest4' || sp.rig === 'chest3g') buildChestRig(B, sp, sp.rig === 'chest4' ? 4 : 3, sp.rig === 'chest3g');
    else if (sp.rig === 'plate') buildPlateCarrier(B, sp);
  });
  step('extras', () => buildExtras(B, sp));
  step('headgear', () => buildHeadgear(B, sp));
  step('rifle', () => buildRifle(B, sp.gun, sp));
  B.finish();
  const col = bakeAO(B, sp);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(B.normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(B.si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(B.sw, 4));
  g.setIndex(B.n > 65535 ? new THREE.Uint32BufferAttribute(B.idx, 1) : new THREE.Uint16BufferAttribute(B.idx, 1));
  g.computeBoundingSphere();
  g.userData.shared = true;              // cached: R.disposeObject() leaves it alone
  g.name = 'soldier_' + key;
  B.mark('end');
  const a = { geo: g, sp, k: sp.k, tris: B.idx.length / 3, gun: GUNS[sp.gun], parts: B.tally };
  assetCache.set(key, a);
  return a;
}

let autoSeed = 0;
/**
 * Build one soldier. Returns { mesh, rig }. `mesh` sits at the feet position;
 * its rotation.y is the facing yaw (facing −Z at 0).
 * kind: 'rifle' | 'sniper' | 'officer' | 'friendly'.
 * opts: { seed } picks the variant deterministically (default: spawn order),
 *       { variant } forces one.
 */
export function buildSoldier(kind = 'rifle', opts = {}) {
  if (!SOLDIER_VARIANTS[kind]) kind = 'rifle';
  const seed = opts.seed ?? autoSeed++;
  const nv = SOLDIER_VARIANTS[kind];
  const variant = (opts.variant ?? seed) % nv;          // consecutive spawns differ
  const A = soldierAsset(kind, variant);
  const bones = {}, list = [];
  for (let i = 0; i < NB; i++) { const b = new THREE.Bone(); b.name = SOLDIER_BONES[i]; bones[b.name] = b; list.push(b); }
  for (let i = 0; i < NB; i++) {
    const p = BIND[i], par = PAR[i], k = A.k;
    if (par >= 0) { const pp = BIND[par]; list[i].position.set((p[0] - pp[0]) * k, (p[1] - pp[1]) * k, (p[2] - pp[2]) * k); list[par].add(list[i]); }
    else list[i].position.set(p[0] * k, p[1] * k, p[2] * k);
  }
  list[HIPS].updateMatrixWorld(true); list[WEAPON].updateMatrixWorld(true);
  const mesh = new THREE.SkinnedMesh(A.geo, soldierMaterial());
  mesh.add(list[HIPS], list[WEAPON]);
  mesh.bind(new THREE.Skeleton(list));
  mesh.name = 'soldier_' + kind;
  // fixed local bounds that hold every pose (standing, kneeling, any death fall);
  // grown by the rig when a dropped rifle is left behind a dragged body
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.75, 0), 2.05);
  mesh.frustumCulled = true;
  const rig = new SoldierRig(bones, { list, k: A.k, gun: A.gun, mesh, kind, variant, seed, helmet: A.sp.head === 'ssh' || A.sp.head === 'modern', radio: (A.sp.extra || []).includes('radio') });
  return { mesh, rig };
}
/** Stats for tools and the dev viewer. */
export function soldierStats(kind, variant = 0) { const A = soldierAsset(kind, variant); return { tris: A.tris, verts: A.geo.attributes.position.count, bones: NB, k: A.k, parts: A.parts }; }

// ───────────────────────────── rig ──────────────────────────────────────
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();
const _d = new THREE.Vector3(), _bd = new THREE.Vector3(), _u = new THREE.Vector3(), _w = new THREE.Vector3(), _h = new THREE.Vector3(), _t = new THREE.Vector3(), _el = new THREE.Vector3();
const _G = new THREE.Vector3(), _A = new THREE.Vector3(), _P = new THREE.Vector3(), _pole = new THREE.Vector3(), _tg = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const _qw = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _e = new THREE.Euler();
const _pw = new THREE.Vector3(), _pa = new THREE.Vector3(), _pc = new THREE.Vector3();
const _a0 = new THREE.Vector3(), _a1 = new THREE.Vector3(), _J = new THREE.Vector3();
const QI = new THREE.Quaternion();

function eulerQ(q, x, y, z) { return q.setFromEuler(_e.set(x, y, z, 'YXZ')); }
function wrapA(a) { while (a > PI) a -= TAU; while (a < -PI) a += TAU; return a; }
/** polynomial smooth minimum: never above min(a, b), rounds the corner over ±s */
function smin(a, b, s) { const h = clamp01(0.5 + 0.5 * (b - a) / s); return b + (a - b) * h - s * h * (1 - h); }
const minjerk = (s) => s * s * s * (10 + s * (6 * s - 15));

// ── locomotion. Real-gait numbers: a relaxed patrol walk at 1.4 m/s is ~110
// steps/min with each foot down 60 % of the cycle; a combat run at 4.4 m/s is
// ~170 steps/min with ~0.22 s of ground contact and a flight phase.
const G_ON = 0.32, G_OFF = 0.16;          // m/s: start stepping in rhythm / stop once the foot in the air lands
const RUN_LO = 2.7, RUN_HI = 3.7;         // m/s: the band where the walk turns into a run
const HEEL = 0.055, BALL = 0.13;          // heel and ball of the foot from the ankle, along the sole
const REACH = (THIGH + SHANK) * 0.985;    // the furthest a leg is ever asked to stretch
const STEP_ERR = 0.085;                   // m (+0.25 m per rad of yaw): a standing foot this far off its spot steps

function makeChain(off1, off2, restBend) {
  const l1 = off1.length(), l2 = off2.length();
  const dir = off1.clone().normalize();
  const H0 = new THREE.Vector3().crossVectors(dir, restBend).normalize();
  const Z0 = new THREE.Vector3().crossVectors(H0, dir);
  const m0t = new THREE.Matrix4().makeBasis(H0, dir, Z0).transpose();
  return { l1, l2, m0t };
}

/**
 * Two-bone IK: from `root` reach `target`, bending towards `pole`. Writes the
 * world rotations of both bones (q1, q2) and leaves the middle joint in _el.
 */
function solve2(c, root, target, pole, q1, q2) {
  _d.subVectors(target, root);
  let d = _d.length();
  const dirT = _d.multiplyScalar(1 / Math.max(d, 1e-6));
  d = clamp(d, Math.abs(c.l1 - c.l2) + 1e-3, (c.l1 + c.l2) * 0.9995);
  _bd.copy(pole).addScaledVector(dirT, -pole.dot(dirT));
  if (_bd.lengthSq() < 1e-10) _bd.set(dirT.y, -dirT.x, 0.3);
  _bd.normalize();
  const ca = clamp((c.l1 * c.l1 + d * d - c.l2 * c.l2) / (2 * c.l1 * d), -1, 1), sa = Math.sqrt(1 - ca * ca);
  _u.copy(dirT).multiplyScalar(ca).addScaledVector(_bd, sa);
  _el.copy(root).addScaledVector(_u, c.l1);
  _w.copy(root).addScaledVector(dirT, d).sub(_el).normalize();
  _h.crossVectors(dirT, _bd).normalize();
  _m.makeBasis(_h, _u, _t.crossVectors(_h, _u)).multiply(c.m0t); q1.setFromRotationMatrix(_m);
  _m.makeBasis(_h, _w, _t.crossVectors(_h, _w)).multiply(c.m0t); q2.setFromRotationMatrix(_m);
}

// probes for the death fall: bone, local offset, radius
const PROBES = [[HEAD, 0, 0.043, -0.014, 0.11], [CHEST, 0, 0.05, -0.01, 0.135], [SPINE, 0, 0.0, 0.0, 0.12], [HIPS, 0, -0.02, 0, 0.125]];
// whole-body probes (torso, gear, limbs) used to keep every part above the ground during and after the fall
const LIMB_PROBES = [
  [CHEST, 0, -0.1, -0.15, 0.05], [CHEST, 0, 0.0, 0.12, 0.05], [HIPS, 0, -0.06, 0.1, 0.07],
  [SHIN_L, 0, 0, 0, 0.06], [SHIN_R, 0, 0, 0, 0.06], [FOOT_L, 0, -0.055, 0.06, 0.03], [FOOT_L, 0, -0.05, -0.17, 0.035], [FOOT_R, 0, -0.055, 0.06, 0.03], [FOOT_R, 0, -0.05, -0.17, 0.035],
  [FORE_L, 0, 0, 0, 0.045], [FORE_R, 0, 0, 0, 0.045], [HAND_L, -SA * 0.06, -CA * 0.06, 0, 0.045], [HAND_R, SA * 0.06, -CA * 0.06, 0, 0.045], [HAND_L, 0, 0, 0, 0.035], [HAND_R, 0, 0, 0, 0.035],
];
const RADIO_PROBE = [CHEST, 0.02, -0.03, 0.18, 0.08];

/**
 * Code-driven animation. Call set* to describe what the soldier is doing and
 * update(dt) once per frame. Allocation-free after construction.
 *
 * Feet are planted in the world: a foot on the ground stays exactly where it
 * landed (the rig reads its mesh's position and yaw every frame, so starts,
 * stops, shoves and turns never slide a foot), and a foot in the air swings
 * from where it left the ground to where the hip will be over it next. The
 * rhythm advances with the distance actually covered; standing, a foot that
 * ends up too far from its spot (he turned, was pushed, changed stance) steps.
 */
export class SoldierRig {
  constructor(bones, info = {}) {
    this.b = bones;
    this.list = info.list || SOLDIER_BONES.map((n) => bones[n]);
    this.k = info.k || 1; this.gun = info.gun || GUNS.ak; this.mesh = info.mesh || null; this.kind = info.kind || 'rifle';
    this.helmet = !!info.helmet; this.radio = !!info.radio;
    this.rs = ((info.seed || 0) * 747796405 + 2891336453) >>> 0;
    this.wp = []; this.wq = []; this.d0 = [];
    for (let i = 0; i < NB; i++) { this.wp.push(new THREE.Vector3()); this.wq.push(new THREE.Quaternion()); this.d0.push(new THREE.Quaternion()); }
    const L = this.list;
    this.legC = makeChain(L[SHIN_L].position, L[FOOT_L].position, new THREE.Vector3(0, 0, -1));
    this.armCL = makeChain(L[FORE_L].position, L[HAND_L].position, new THREE.Vector3(0, 0, 1));
    this.armCR = makeChain(L[FORE_R].position, L[HAND_R].position, new THREE.Vector3(0, 0, 1));
    // hand bind frames (grip, along, palm) as matrices, transposed
    this.hbR = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(SA, -CA, 0), new THREE.Vector3(-CA, -SA, 0)).transpose();
    this.hbL = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-SA, -CA, 0), new THREE.Vector3(CA, -SA, 0)).transpose();
    this.hc = new THREE.Vector3(HEAD_C[0] * this.k, HEAD_C[1] * this.k, HEAD_C[2] * this.k);
    // ankle targets (mesh frame) and foot pitch / yaw / roll per side, the leg IK's input
    this.fA = [new THREE.Vector3(), new THREE.Vector3()]; this.fP = [0, 0]; this.fY = [0, 0]; this.fR = [0, 0];
    this.wpW = new THREE.Vector3(); this.wqW = new THREE.Quaternion();     // weapon pose (mesh space)
    this.dW0p = new THREE.Vector3(); this.dW0q = new THREE.Quaternion(); this.dW1p = new THREE.Vector3(); this.dW1q = new THREE.Quaternion();
    this.dropW = new THREE.Vector3(); this.dropYaw = 0; this.dropPos = new THREE.Vector3(); this.dropSet = false;
    this.d0hp = new THREE.Vector3();
    this.ph = this._rnd(); this.t = this._rnd() * 10;
    this.speed = 0;
    this.aim = 0; this.aimTarget = 0; this.aimPitch = 0; this.pitchS = 0;
    this.crouch = 0; this.crouchTarget = 0; this.stun = 0; this.stunW = 0;
    this.flinch = 0; this.flX = 0; this.flZ = 0; this.kick = 0; this.shootHold = 0;
    this.scan = 0; this.scanTarget = 0; this.scanT = 1 + this._rnd() * 3; this.shift = this._rnd() * 6;
    this.dead = false; this.deathT = 0; this.deathDir = 1; this.dv = 0; this.dside = 1; this.settled = false; this.lift = 0;
    this.hx = 0; this.hy = 1.62; this.hz = 0;
    // personal style: cadence, stance, toe-out, sway, bob, posture, how loosely he carries the rifle
    this.stCad = 0.95 + 0.1 * this._rnd(); this.stWid = (this._rnd() - 0.5) * 0.024; this.stToe = 0.05 + 0.08 * this._rnd();
    this.stSway = 0.8 + 0.4 * this._rnd(); this.stBob = 0.85 + 0.3 * this._rnd(); this.stPost = (this._rnd() - 0.45) * 0.06;
    this.stLag = 0.75 + 0.5 * this._rnd(); this.stHead = (this._rnd() - 0.5) * 0.05;
    // what he is told: speed, velocity in his frame, turn rate, where he is about to look, the ground
    this.cmdV = 0; this.cmdX = 0; this.cmdZ = 0; this.cmdW = 0; this.cmdHas = false; this.lookOff = 0; this.lookHas = false;
    this.treadmill = false; this.ground = null;
    // odometry: his feet position and yaw in the ground frame (the world, or a treadmill belt)
    this.odo = false; this.bx = 0; this.by = 0; this.bz = 0; this.byaw = 0; this.yc = 1; this.ys = 0;
    this.mvx = 0; this.mvz = 0; this.vx = 0; this.vz = 0; this.ax = 0; this.az = 0; this.yr = 0; this.spd = 0;
    // gait
    this.gait = false; this.gw = 0; this.back = false; this.twist = 0; this.duty = 0.6; this.fc = 0.9; this.bladeW = 0;
    this.gp = { h: 0, land: 0, toe: 0, mid: 0, ff: 0.15, ho: 0.6, lam: 0.5, rb: 0, wid: 0.08, toeOut: 0.1, aim: 0, kneel: 0 };
    // feet: footprint on the ground (ground frame) or a swing from one footprint to the next
    this.fpx = [0, 0]; this.fpy = [0, 0]; this.fpz = [0, 0]; this.fyw = [0, 0]; this.fsp = [0, 0]; this.fsr = [0, 0];
    this.fpc = [0, 0]; this.flf = [0, 0]; this.piv = [0, 0]; this.fage = [0, 0]; this.fu = [0, 0]; this.over = [false, false];
    this.sw = [-1, -1]; this.sdur = [0, 0]; this.sh = [0, 0]; this.sx = [0, 0]; this.sy0 = [0, 0]; this.sz = [0, 0]; this.syw = [0, 0]; this.sp = [0, 0];
    this.ssp = [0, 0]; this.ssr = [0, 0]; this.tsp = [0, 0]; this.tsr = [0, 0]; this.tsm = [false, false];
    this.tx = [0, 0]; this.ty = [0, 0]; this.tz = [0, 0]; this.tyw = [0, 0]; this.lp = [0, 0];
    this.stepT = 1; this.want = -1; this._sx = 0; this._sz = 0; this._syw = 0;
    // standing life
    this.wsb = 0; this.idleT = 3 + this._rnd() * 5; this.ivx = [0, 0]; this.ivz = [0, 0]; this.ivy = [0, 0];
    this.hxS = 0; this.hzS = 0; this.psiS = 0;
    // upper body: head lead, breathing, rifle lag (spring), grip fidget
    this.headLead = 0; this.ex = 0; this.bph = this._rnd() * 6;
    this.wo = [0, 0, 0, 0, 0]; this.wv = [0, 0, 0, 0, 0]; this.phy = -1; this.phv = 0; this.hay = 0;
    this.fidT = 0; this.fidN = 6 + this._rnd() * 8; this.fidK = 0;
    this.update(0);
  }
  _rnd() { this.rs = (Math.imul(this.rs, 1664525) + 1013904223) >>> 0; return this.rs / 4294967296; }

  /**
   * speed: m/s he travels at. One argument still works (straight ahead).
   * vx, vz: his planar velocity in his own frame (+x right, −z ahead); turn:
   * yaw rate (rad/s). Footfalls follow the mesh's real motion; these say where
   * the next steps should land.
   */
  setMove(speed, vx, vz, turn) {
    this.speed = speed || 0; this.cmdV = this.speed;
    if (vx !== undefined && vz !== undefined) { this.cmdHas = true; this.cmdX = vx; this.cmdZ = vz; }
    else { this.cmdHas = false; this.cmdX = 0; this.cmdZ = -this.speed; }
    this.cmdW = turn || 0;
  }
  /** Where he is about to look, as a yaw offset from his facing (rad); null: his eyes follow his turning. */
  setLook(off) { this.lookHas = off !== null && off !== undefined && Number.isFinite(off); this.lookOff = this.lookHas ? off : 0; }
  /** Terrain height under a world point (x, z) → y, so each foot lands on the ground under it (null: flat at the feet). */
  setGround(fn) { this.ground = typeof fn === 'function' ? fn : null; }
  setAim(on, pitch = 0) { this.aimTarget = on ? 1 : 0; this.aimPitch = pitch; }
  setCrouch(on) { this.crouchTarget = on ? 1 : 0; }
  setStun(on) { this.stun = on ? 1 : 0; }
  shoot() { this.kick = 1; this.shootHold = 0.9; }
  hit() { this.flinch = 1; this.flX = 0.6 + this._rnd() * 0.4; this.flZ = (this._rnd() - 0.5) * 1.2; }
  /** dir: +1 falls backward, −1 forward. Picks one of three falls (`variant` forces one: 0 back, 1 forward, 2 crumple). */
  die(dir = 1, variant) {
    if (this.dead) return;
    this.dead = true; this.deathT = 0; this.deathDir = dir; this.settled = false; this.lift = 0;
    const r = this._rnd();
    this.dv = variant ?? (dir >= 0 ? (r < 0.62 ? 0 : 2) : (r < 0.62 ? 1 : 2));   // 0 backward, 1 forward, 2 crumple
    this.dside = this._rnd() < 0.5 ? -1 : 1;
    for (let i = 0; i < NB; i++) this.d0[i].copy(this.list[i].quaternion);
    this.d0hp.copy(this.list[HIPS].position);
    this.dW0p.copy(this.list[WEAPON].position); this.dW0q.copy(this.list[WEAPON].quaternion);
    // where the rifle lands: beside the body, on its side
    const k = this.k, side = this.dside;
    const zLand = this.dv === 0 ? 0.35 : this.dv === 1 ? -0.55 : -0.2;
    this.dW1p.set(side * (0.42 + this._rnd() * 0.15) * k, 0.027, zLand * k);
    eulerQ(this.dW1q, 0, (this._rnd() - 0.5) * 1.2 + (this.dv === 0 ? 0.3 : -0.3) * side, side * PI / 2);
    this.dropSet = false;
  }
  /** World height of the head centre above the feet (for AI eye height). */
  headHeight() { return this.hy; }
  /**
   * Head centre in the soldier mesh's local frame (feet at the origin, facing
   * −Z, before the mesh's yaw). Valid right after update(); computed by
   * forward kinematics, so it needs neither rendering nor matrixWorld.
   */
  headLocal(out) { out.x = this.hx; out.y = this.hy; out.z = this.hz; return out; }
  /** Bench / debug: one foot's state (planted or swing progress, footprint in the ground frame, rock pitch). */
  footInfo(si, out) {
    out.planted = this.sw[si] < 0; out.swing = this.sw[si]; out.x = this.fpx[si]; out.y = this.fpy[si]; out.z = this.fpz[si];
    out.yaw = this.fyw[si]; out.pitch = this.fpc[si] + (this.flf[si] > Math.abs(this.fpc[si]) ? (this.gp.toe < 0 ? -1 : 1) * this.flf[si] - this.fpc[si] : 0);
    return out;
  }

  // forward kinematics for one bone (parent must be done)
  _fk(i) {
    const b = this.list[i], p = PAR[i];
    if (p < 0) { this.wq[i].copy(b.quaternion); this.wp[i].copy(b.position); return; }
    this.wq[i].multiplyQuaternions(this.wq[p], b.quaternion);
    this.wp[i].copy(b.position).applyQuaternion(this.wq[p]).add(this.wp[p]);
  }
  /** set a bone's local rotation from a desired world rotation */
  _setWorld(i, qWorld) {
    _qi.copy(this.wq[PAR[i]]).invert();
    this.list[i].quaternion.multiplyQuaternions(_qi, qWorld);
    this.wq[i].copy(qWorld);
    this.wp[i].copy(this.list[i].position).applyQuaternion(this.wq[PAR[i]]).add(this.wp[PAR[i]]);
  }
  _headCentre() {
    this._fk(NECK); this._fk(HEAD);
    _v1.copy(this.hc).applyQuaternion(this.wq[HEAD]).add(this.wp[HEAD]);
    this.hx = _v1.x; this.hy = _v1.y; this.hz = _v1.z;
  }

  /** Leg IK to the ankle target with foot rotation (yaw, pitch, roll in the mesh frame). Never asks for more leg than there is. */
  _leg(side, target, pitch, yaw, roll, poleX, poleY, poleZ) {
    const LEG = side < 0 ? LEG_L : LEG_R, SH = side < 0 ? SHIN_L : SHIN_R, FT = side < 0 ? FOOT_L : FOOT_R;
    this._fk(LEG);
    _v3.subVectors(target, this.wp[LEG]);
    const d = _v3.length(), R = REACH * this.k;
    if (d > R) target.copy(this.wp[LEG]).addScaledVector(_v3, R / d);
    _pole.set(poleX, poleY, poleZ);
    solve2(this.legC, this.wp[LEG], target, _pole, _q1, _q2);
    this._setWorld(LEG, _q1);
    this._setWorld(SH, _q2);
    eulerQ(_q3, pitch, yaw, roll);
    this._setWorld(FT, _q3);
  }

  /**
   * Arm IK so the hand grips a cylinder centred at `pg` with axis `ga`.
   * The roll round the axis follows the arm (minimum twist); `bias` nudges it.
   */
  _arm(side, pg, ga, poleX, poleY, poleZ, bias) {
    const CL = side < 0 ? CLAV_L : CLAV_R, AR = side < 0 ? ARM_L : ARM_R, FO = side < 0 ? FORE_L : FORE_R, HA = side < 0 ? HAND_L : HAND_R;
    this._fk(CL); this._fk(AR);
    // along = shoulder → grip, made perpendicular to the grip axis
    _A.subVectors(pg, this.wp[AR]).normalize();
    if (bias) _A.addScaledVector(bias, 0.6);
    _A.addScaledVector(ga, -_A.dot(ga)).normalize();
    if (side > 0) _P.crossVectors(ga, _A); else _P.crossVectors(_A, ga);
    const k = this.k;
    _tg.copy(pg).addScaledVector(_P, -GRIP_OFF[0] * k).addScaledVector(_A, -GRIP_OFF[1] * k);
    _pole.set(poleX, poleY, poleZ);
    solve2(side < 0 ? this.armCL : this.armCR, this.wp[AR], _tg, _pole, _q1, _q2);
    this._setWorld(AR, _q1);
    this._setWorld(FO, _q2);
    _m.makeBasis(ga, _A, _P).multiply(side < 0 ? this.hbL : this.hbR);
    _q3.setFromRotationMatrix(_m);
    this._setWorld(HA, _q3);
  }

  // ── locomotion helpers ────────────────────────────────────────────────
  /** Read the mesh's motion (or integrate the treadmill), smooth velocity / acceleration / turn rate. */
  _odometry(dt) {
    const m = this.mesh;
    const yaw = m ? m.rotation.y : this.byaw + this.cmdW * dt;
    const py = m ? m.position.y : 0;
    let px, pz;
    if (m && !this.treadmill) { px = m.position.x; pz = m.position.z; }
    else {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      px = this.bx + (this.cmdX * c + this.cmdZ * s) * dt; pz = this.bz + (-this.cmdX * s + this.cmdZ * c) * dt;
    }
    const dx = px - this.bx, dz = pz - this.bz, dyaw = wrapA(yaw - this.byaw), d = Math.hypot(dx, dz);
    const jump = !this.odo || d > Math.max(0.6, 15 * dt) || Math.abs(dyaw) > 1.3;
    this.bx = px; this.bz = pz; this.by = py; this.byaw = yaw; this.yc = Math.cos(yaw); this.ys = Math.sin(yaw);
    if (jump) {        // spawned, teleported or snapped round: stand where he is now
      this.odo = true; this.mvx = this.mvz = this.ax = this.az = this.yr = 0;
      this.vx = this.cmdHas ? this.cmdX : 0; this.vz = this.cmdHas ? this.cmdZ : 0;
      this._plantAll();
      return;
    }
    if (dt <= 0) return;
    const c = this.yc, s = this.ys;
    const lx = (dx * c - dz * s) / dt, lz = (dx * s + dz * c) / dt;
    const a = 1 - Math.exp(-10 * dt);
    this.mvx += (lx - this.mvx) * a; this.mvz += (lz - this.mvz) * a;
    this.yr += (dyaw / dt - this.yr) * (1 - Math.exp(-12 * dt));
    // gait velocity: what the caller says he is doing (smoother), else what the mesh did
    const gx = this.cmdHas ? this.cmdX : this.mvx, gz = this.cmdHas ? this.cmdZ : this.mvz;
    const ovx = this.vx, ovz = this.vz, b = 1 - Math.exp(-14 * dt);
    this.vx += (gx - this.vx) * b; this.vz += (gz - this.vz) * b;
    const e = 1 - Math.exp(-6 * dt);
    this.ax += ((this.vx - ovx) / dt - this.ax) * e; this.az += ((this.vz - ovz) / dt - this.az) * e;
  }
  /** mesh frame → ground frame is a rotation by the yaw; this is the inverse, into `out` */
  _local(x, y, z, out) { const dx = x - this.bx, dz = z - this.bz; return out.set(dx * this.yc - dz * this.ys, y - this.by, dx * this.ys + dz * this.yc); }
  /**
   * Ankle point (ground frame) of a foot whose flat footprint is at (x, y, z)
   * with yaw, rocked by `p`: toe up about the heel (p > 0), heel up about the ball (p < 0).
   */
  _ankle(x, y, z, yaw, p, out) {
    const k = this.k, c = Math.cos(p), s = Math.sin(p);
    let ay, az;
    if (p >= 0) { ay = (ANKLE_H * c + HEEL * s) * k; az = (HEEL * (1 - c) + ANKLE_H * s) * k; }
    else { ay = (ANKLE_H * c - BALL * s) * k; az = (-BALL * (1 - c) + ANKLE_H * s) * k; }
    out.x = x + az * Math.sin(yaw); out.y = y + ay; out.z = z + az * Math.cos(yaw);
    return out;
  }
  /** Where a standing foot belongs (mesh frame) → _sx, _sz, _syw: relaxed, braced to aim (ax), with an idle shuffle. */
  _standTarget(si, ax) {
    const k = this.k, iv = 1 - ax;
    if (si) {
      this._sx = (lerp(0.11, 0.15, ax) + this.stWid * 0.5) * k + this.ivx[1] * iv;
      this._sz = lerp(0.035, 0.13, ax) * k + this.ivz[1] * iv;
      this._syw = lerp(-0.16, -0.7, ax) - (this.stToe - 0.09) + this.ivy[1] * iv;
    } else {
      this._sx = -(lerp(0.11, 0.12, ax) + this.stWid * 0.5) * k + this.ivx[0] * iv;
      this._sz = lerp(-0.02, -0.17, ax) * k + this.ivz[0] * iv;
      this._syw = lerp(0.14, -0.12, ax) + (this.stToe - 0.09) + this.ivy[0] * iv;
    }
  }
  /** terrain pitch / roll under a footprint (toe up on an up-slope, right side up when the ground rises to the right) */
  _slope(x, z, yaw, si, target) {
    const g = this.ground, f = 0.12 * this.k, c = Math.cos(yaw), s = Math.sin(yaw);
    const p = clamp(Math.atan2((g(x - s * f, z - c * f) - g(x + s * f, z + c * f)) || 0, 2 * f), -0.35, 0.35);
    const r = clamp(Math.atan2((g(x + c * f, z - s * f) - g(x - c * f, z + s * f)) || 0, 2 * f), -0.3, 0.3);
    if (target) { this.tsp[si] = p; this.tsr[si] = r; } else { this.fsp[si] = p; this.fsr[si] = r; }
  }
  _plant(si, x, z, yaw) {
    this.fpx[si] = x; this.fpz[si] = z; this.fyw[si] = yaw; this.sw[si] = -1; this.sdur[si] = 0;
    this.fage[si] = 0; this.flf[si] = 0; this.over[si] = false;
    if (this.ground) { this.fpy[si] = this.by + clamp((this.ground(x, z) - this.by) || 0, -0.45, 0.45); this._slope(x, z, yaw, si, false); }
    else { this.fpy[si] = this.by; this.fsp[si] = 0; this.fsr[si] = 0; }
  }
  /** both feet straight under him at their standing spots (spawn, teleport) */
  _plantAll() {
    for (let si = 0; si < 2; si++) {
      this._standTarget(si, this.aim);
      this._plant(si, this.bx + this._sx * this.yc + this._sz * this.ys, this.bz - this._sx * this.ys + this._sz * this.yc, this.byaw + this._syw);
      this.fpc[si] = 0;
    }
    this.gait = false; this.gw = 0;
  }
  /** a foot leaves the ground from where its ankle is now (heel up if it was rocking on the ball) */
  _lift(si, dur) {
    let p = this.fpc[si];
    if (this.flf[si] > Math.abs(p)) p = (this.gp.toe < 0 ? -1 : 1) * this.flf[si];
    this._ankle(this.fpx[si], this.fpy[si], this.fpz[si], this.fyw[si], p, _a0);
    this.sx[si] = _a0.x; this.sy0[si] = _a0.y; this.sz[si] = _a0.z; this.syw[si] = this.fyw[si]; this.sp[si] = p;
    this.ssp[si] = this.tsp[si] = this.fsp[si]; this.ssr[si] = this.tsr[si] = this.fsr[si]; this.tsm[si] = false;
    this.tx[si] = this.fpx[si]; this.tz[si] = this.fpz[si]; this.tyw[si] = this.fyw[si];
    this.sw[si] = 0; this.sdur[si] = dur; this.sh[si] = this.gp.h; this.lp[si] = 0;
  }
  _land(si) {
    this._plant(si, this.tx[si], this.tz[si], this.tyw[si]);
    this.fpc[si] = this.lp[si];
    this.stepT = 0;
  }

  /** Step scheduling: the walking / running rhythm, or steps on the spot when standing. */
  _steps(dt, vS, mvS) {
    const P = this.gp, duty = this.duty, fc = this.fc;
    if (!this.gait && vS > G_ON) {
      // set off: a foot already in the air carries on, else the one further behind steps first
      this.gait = true;
      let first = this.sw[0] >= 0 ? 0 : this.sw[1] >= 0 ? 1 : -1;
      const prog = first >= 0 ? clamp01(this.sw[first]) : 0;
      if (first < 0) {
        const wx = this.vx * this.yc + this.vz * this.ys, wz = -this.vx * this.ys + this.vz * this.yc;
        const d0 = (this.fpx[0] - this.bx) * wx + (this.fpz[0] - this.bz) * wz, d1 = (this.fpx[1] - this.bx) * wx + (this.fpz[1] - this.bz) * wz;
        first = d0 <= d1 ? 0 : 1;
        this._lift(first, 0);
      }
      this.sdur[first] = 0;
      const u = duty + prog * (1 - duty);
      this.ph = first ? (u + 0.5) % 1 : u;
      this.fu[0] = this.ph; this.fu[1] = (this.ph + 0.5) % 1;
    }
    // swings on a timer (steps on the spot, a foot left out of reach) run in either mode
    for (let si = 0; si < 2; si++) if (this.sw[si] >= 0 && this.sdur[si] > 0) { this.sw[si] += dt / this.sdur[si]; if (this.sw[si] >= 1) this._land(si); }
    if (this.gait) {
      const stopping = vS < G_OFF;
      const rh0 = this.sw[0] >= 0 && this.sdur[0] === 0, rh1 = this.sw[1] >= 0 && this.sdur[1] === 0;
      if (stopping && !rh0 && !rh1) this.gait = false;
      else {
        // the cycle advances with the distance actually covered (and always finishes a step in the air)
        const ratio = vS > 0.05 ? clamp(mvS / vS, 0.4, 1.6) : 1;
        let dph = fc * dt * ratio;
        if ((rh0 || rh1) && vS < 0.6) dph = Math.max(dph, (1 - duty) * dt / 0.42);
        this.ph = (this.ph + dph) % 1;
        for (let si = 0; si < 2; si++) {
          const u = (this.ph + (si ? 0.5 : 0)) % 1, wrapped = u < this.fu[si] - 0.5;
          this.fu[si] = u;
          if (this.sw[si] >= 0) {
            if (this.sdur[si] > 0) continue;
            if (wrapped) this._land(si);
            else this.sw[si] = Math.max(this.sw[si], clamp01((u - duty) / (1 - duty)));
          } else if (u >= duty && !stopping && !wrapped && this.fage[si] > 0.05 && !(this.sw[1 - si] >= 0 && this.sdur[1 - si] > 0)) {
            this._lift(si, 0);
            this.sw[si] = clamp01((u - duty) / (1 - duty));
          } else if (this.over[si] && this.sw[1 - si] < 0) {
            // left behind (he slowed or turned and the stance outlived the leg): bring the rhythm forward, it goes now
            // (never while the other foot is in the air: that would cut its swing short)
            if (u < duty) { this.ph = (this.ph + duty - u) % 1; this.fu[si] = duty; }
            this._lift(si, 0);
          }
        }
      }
    }
    if (!this.gait) {
      // standing: the foot furthest from its spot (turned, shoved, new stance, an idle shuffle) steps there
      this.stepT += dt;
      if (this.sw[0] < 0 && this.sw[1] < 0 && this.stepT > 0.07 && P.kneel < 0.05) {
        let best = -1, be = STEP_ERR;
        for (let si = 0; si < 2; si++) {
          this._standTarget(si, P.aim);
          const dx = this.fpx[si] - this.bx, dz = this.fpz[si] - this.bz;
          const lx = dx * this.yc - dz * this.ys, lz = dx * this.ys + dz * this.yc;
          let e = Math.hypot(lx - this._sx, lz - this._sz) + 0.25 * Math.abs(wrapA(this.fyw[si] - this.byaw - this._syw));
          if (this.want === si || this.over[si]) e += 1;
          if (e > be) { be = e; best = si; }
        }
        if (best >= 0) {
          this._lift(best, clamp(0.42 - Math.min(be, 1) * 0.45, 0.26, 0.4));
          this.sh[best] = (0.045 + 0.05 * Math.min(1, be * 2)) * this.k;
          if (this.want === best) this.want = -1;
        }
      }
    }
  }

  /** a foot on the ground: rolls heel → flat → heel off → toe off in rhythm, flat when standing */
  _standFoot(si, dt) {
    const P = this.gp;
    let pt = 0;
    if (this.gait && this.spd >= G_OFF) {
      const s = clamp01(this.fu[si] / this.duty);
      if (s < P.ff) pt = P.land * (1 - ease3(s / P.ff));
      else if (s > P.ho) { const q = (s - P.ho) / (1 - P.ho); pt = P.toe * q * q; }
    } else this.flf[si] = Math.max(0, this.flf[si] - 4 * dt);
    if (!this.gait && P.kneel < 0.05) {
      // turning faster than the feet can step: the planted foot pivots on its ball, heel just off the ground
      this._standTarget(si, P.aim);
      const err = wrapA(this.byaw + this._syw - this.fyw[si]), ex = Math.abs(err) - 0.55;
      if (ex > 0) {
        const f = BALL * this.k, bx = this.fpx[si] - Math.sin(this.fyw[si]) * f, bz = this.fpz[si] - Math.cos(this.fyw[si]) * f;
        this.fyw[si] += Math.sign(err) * Math.min(ex, 7 * dt);
        this.fpx[si] = bx + Math.sin(this.fyw[si]) * f; this.fpz[si] = bz + Math.cos(this.fyw[si]) * f;
        this.piv[si] = 0.15;
      }
      if (this.piv[si] > 0) { this.piv[si] -= dt; pt = -0.22; }
    }
    const rate = (this.gait ? 16 : this.piv[si] > 0 ? 10 : 5) * dt;
    this.fpc[si] += clamp(pt - this.fpc[si], -rate, rate);
    this.fage[si] += dt;
    let p = this.fpc[si];
    if (this.flf[si] > Math.abs(p)) p = (P.toe < 0 ? -1 : 1) * this.flf[si];
    this._ankle(this.fpx[si], this.fpy[si], this.fpz[si], this.fyw[si], p, _a0);
    this._local(_a0.x, _a0.y, _a0.z, this.fA[si]);
    this.fP[si] = p + this.fsp[si]; this.fY[si] = wrapA(this.fyw[si] - this.byaw); this.fR[si] = this.fsr[si];
  }

  /** a foot in the air: from where it left the ground to where the hip will be over it, lifted on the way */
  _swingFoot(si, aimE) {
    const P = this.gp, side = si ? 1 : -1, s = clamp01(this.sw[si]);
    const wx = this.vx * this.yc + this.vz * this.ys, wz = -this.vx * this.ys + this.vz * this.yc;
    let landP, midP, H;
    if (this.sdur[si] === 0) {
      // in rhythm: land so that the hip is over the foot part-way through its stance (lam)
      const tRem = (1 - s) * (1 - this.duty) / this.fc, lead = tRem + this.duty / this.fc * P.lam;
      const pel = this.byaw + clamp(this.yr * (tRem + 0.5 * this.duty / this.fc), -0.7, 0.7) + this.twist + this.bladeW;
      const c = Math.cos(pel), sn = Math.sin(pel), ox = side * P.wid;
      // along the arc he is turning on, not the tangent (the average heading over the lead time)
      const th = clamp(this.yr * lead * 0.5, -0.8, 0.8), ct = Math.cos(th), st = Math.sin(th);
      this.tx[si] = this.bx + (wx * ct + wz * st) * lead + ox * c; this.tz[si] = this.bz + (-wx * st + wz * ct) * lead - ox * sn;
      this.tyw[si] = pel - side * P.toeOut;
      landP = P.land; midP = P.mid; H = P.h;
    } else {
      // a step on the spot: back to its standing place, turned the way he is turning
      const tRem = (1 - s) * this.sdur[si], yawF = this.byaw + clamp(this.yr * tRem * 0.9, -0.5, 0.5);
      this._standTarget(si, aimE);
      const c = Math.cos(yawF), sn = Math.sin(yawF);
      this.tx[si] = this.bx + wx * tRem + this._sx * c + this._sz * sn; this.tz[si] = this.bz + wz * tRem - this._sx * sn + this._sz * c;
      this.tyw[si] = yawF + this._syw;
      landP = 0.06; midP = -0.15; H = this.sh[si];
    }
    const g = this.ground;
    const ty = g ? this.by + clamp((g(this.tx[si], this.tz[si]) - this.by) || 0, -0.45, 0.45) : this.by;
    this.ty[si] = ty;
    if (g && !this.tsm[si] && s > 0.5) { this._slope(this.tx[si], this.tz[si], this.tyw[si], si, true); this.tsm[si] = true; }
    this._ankle(this.tx[si], ty, this.tz[si], this.tyw[si], landP, _a1);
    const rb = P.rb, e = minjerk(rb > 0.01 ? Math.pow(s, 1 + 0.35 * rb) : s), ev = ease3(s);
    let lift = H * Math.sin(PI * Math.pow(s, lerp(0.85, 0.9, rb)));
    let x = lerp(this.sx[si], _a1.x, e), z = lerp(this.sz[si], _a1.z, e);
    if (rb > 0.01 && this.sdur[si] === 0) {
      // running: after toe-off the heel comes up behind towards the seat, then the knee drives through
      const kick = rb * Math.sin(PI * clamp01(s / 0.62)), vl = Math.hypot(wx, wz) || 1;
      lift += kick * 0.13 * this.k;
      x -= wx / vl * kick * 0.14 * this.k; z -= wz / vl * kick * 0.14 * this.k;
    }
    const y = lerp(this.sy0[si], _a1.y, ev) + lift;
    const pit = s < 0.5 ? lerp(this.sp[si], midP, ease3(s * 2)) : lerp(midP, landP, ease3(s * 2 - 1));
    this.lp[si] = landP;
    this._local(x, y, z, this.fA[si]);
    this.fP[si] = pit + lerp(this.ssp[si], this.tsp[si], ev);
    this.fY[si] = wrapA(this.syw[si] + wrapA(this.tyw[si] - this.syw[si]) * ev - this.byaw);
    this.fR[si] = lerp(this.ssr[si], this.tsr[si], ev);
  }

  /** highest the hips may sit so the leg (joint at hips + J) still reaches the ankle target */
  _reachY(fa, jx, jz, jy, R) { const dx = fa.x - jx, dz = fa.z - jz, h2 = R * R - dx * dx - dz * dz; return fa.y - jy + (h2 > 0 ? Math.sqrt(h2) : 0); }

  /** the rifle is held, not welded: a damped spring driven by the body's acceleration, bob and turning */
  _weaponLag(dt, hy) {
    if (dt <= 0) return;
    if (this.phy < 0) { this.phy = hy; this.phv = 0; }
    const hv = (hy - this.phy) / dt, ha = (hv - this.phv) / dt;
    this.phy = hy; this.phv = hv;
    this.hay = damp(this.hay, clamp(ha, -30, 30), 12, dt);
    const g = 0.55 * this.stLag, ax = this.ax + this.yr * this.vz;     // sideways acceleration includes turning
    const F0 = -ax * g, F1 = -this.hay * g, F2 = -this.az * g;
    const T3 = -clamp(this.yr * 0.035, -0.08, 0.08), T4 = clamp(this.hay * 0.004, -0.05, 0.05);
    const n = dt > 0.02 ? Math.ceil(dt / 0.02) : 1, h = dt / n, wo = this.wo, wv = this.wv;
    for (let i = 0; i < n; i++) {
      wv[0] += (F0 - 160 * wo[0] - 16 * wv[0]) * h; wo[0] += wv[0] * h;
      wv[1] += (F1 - 160 * wo[1] - 16 * wv[1]) * h; wo[1] += wv[1] * h;
      wv[2] += (F2 - 160 * wo[2] - 16 * wv[2]) * h; wo[2] += wv[2] * h;
      wv[3] += (120 * (T3 - wo[3]) - 14 * wv[3]) * h; wo[3] += wv[3] * h;
      wv[4] += (120 * (T4 - wo[4]) - 14 * wv[4]) * h; wo[4] += wv[4] * h;
    }
    const lim = 0.035 * this.k;
    for (let i = 0; i < 3; i++) wo[i] = clamp(wo[i], -lim, lim);
  }

  update(dt) {
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
    this.t += dt;
    if (this.dead) { this._death(dt); return; }
    const L = this.list, k = this.k;
    // ── blends
    this.aim = damp(this.aim, this.aimTarget, 6, dt);
    this.pitchS = damp(this.pitchS, this.aimPitch, 6, dt);
    this.crouch = damp(this.crouch, this.crouchTarget, 5.5, dt);
    this.stunW = damp(this.stunW, this.stun, 4, dt);
    this.flinch = Math.max(0, this.flinch - dt * 3.0);
    this.kick = Math.max(0, this.kick - dt * 8);
    this.shootHold = Math.max(0, this.shootHold - dt);
    this._odometry(dt);

    // ── what the legs do: speed, direction against the facing, gait character
    const vS = Math.hypot(this.vx, this.vz), mvS = Math.hypot(this.mvx, this.mvz);
    this.spd = vS;
    const alpha = vS > 0.04 ? Math.atan2(this.vx, -this.vz) : 0, absA = Math.abs(alpha);
    if (this.back) { if (absA < 1.85 || vS < 0.1) this.back = false; } else if (absA > 2.05 && vS > 0.15) this.back = true;
    // the hips turn part-way into the direction of travel (up to ~55°); the chest keeps facing ahead
    const aRel = this.back ? wrapA(alpha - PI) : alpha;
    this.twist = damp(this.twist, clamp(-(this.back ? 0.5 : 0.62) * aRel, -0.95, 0.95) * sstep(0.15, 0.7, vS), 5, dt);
    const aP = alpha + this.twist, cf = Math.cos(aP), sfa = Math.sin(aP);
    const wS = sfa * sfa, wF = cf > 0 ? cf * cf : 0, wB = cf < 0 ? cf * cf : 0;
    const stun = this.stunW, cr = this.crouch, g1 = this.gw;
    const rb = sstep(RUN_LO, RUN_HI, vS) * (1 - 0.7 * wB);
    const aimE = Math.max(this.aim * (1 - 0.75 * rb * g1), Math.min(1, this.shootHold * 3) * (1 - stun)) * (1 - stun);
    const glide = this.aim * (1 - rb) * (1 - stun);          // aimed walk: the cautious search advance
    const kneel = cr * (1 - g1);
    const fl = this.flinch * this.flinch;
    // cadence and duty factor (share of the cycle a foot is down)
    const cW = (1.17 + 0.475 * vS) * (1 + 0.07 * glide) * (1 + 0.22 * wS + 0.15 * wB);
    const cR = (2.6 + 0.075 * vS) * (1 + 0.1 * wS + 0.1 * wB);
    this.fc = clamp(lerp(cW, cR, rb), 1.3, 3.4) * this.stCad * 0.5;         // gait cycles per second
    const duty = this.duty = lerp(clamp(0.645 - 0.03 * vS, 0.56, 0.63), 0.29, rb);
    const P = this.gp;
    P.h = lerp((0.075 + 0.02 * vS) * (1 - 0.35 * glide), 0.3, rb) * (1 - 0.3 * wS * (1 - rb) - 0.35 * wB) * k;
    P.land = wF * lerp(0.3 - 0.06 * glide, 0.12, rb) + wS * 0.03 - wB * 0.26;
    P.toe = wF * lerp(-0.55 + 0.15 * glide, -0.95, rb) - wS * 0.25 + wB * 0.22;
    P.mid = wF * lerp(0.06, -0.45, rb) + wS * 0.02 - wB * 0.12;
    P.ff = lerp(0.15, 0.12, rb); P.ho = lerp(0.58 + 0.1 * glide, 0.42, rb); P.lam = lerp(0.4, 0.36, rb); P.rb = rb;
    P.wid = (lerp(0.078, 0.06, rb) + 0.05 * wS * (1 - rb) + this.stWid) * k;
    P.toeOut = this.stToe * (1 - 0.6 * rb); P.aim = aimE; P.kneel = kneel;
    this._steps(dt, vS, mvS);
    this.gw = damp(this.gw, this.gait ? 1 : 0, this.gait ? 7 : 4, dt);
    for (let si = 0; si < 2; si++) { if (this.sw[si] >= 0) this._swingFoot(si, aimE); else this._standFoot(si, dt); }

    // ── idle life: weight shift, small re-balancing steps, looking round, breathing
    const still = (1 - g1) * (1 - aimE) * (1 - stun) * (1 - kneel);
    if (still > 0.6) this.idleT -= dt;
    if (this.idleT <= 0) {
      this.idleT = 5 + this._rnd() * 8;
      const si = this._rnd() < 0.5 ? 0 : 1;
      this.ivx[si] = (this._rnd() - 0.5) * 0.06 * k; this.ivz[si] = (this._rnd() - 0.5) * 0.1 * k; this.ivy[si] = (this._rnd() - 0.5) * 0.25;
      this.wsb = (this._rnd() - 0.5) * 1.2; this.want = si;
    }
    this.scanT -= dt;
    if (this.scanT <= 0) { this.scanT = 1.6 + this._rnd() * 3.4; this.scanTarget = this._rnd() < 0.3 ? 0 : (this._rnd() - 0.5) * 1.3; }
    this.scan = damp(this.scan, this.scanTarget * (1 - aimE) * (1 - g1 * 0.7) * (1 - stun), 2.2, dt);
    const shiftS = Math.sin(this.t * 0.55 + this.shift) * (1 - g1) * (1 - aimE * 0.7) * (1 - kneel);
    const exT = rb * g1;
    this.ex = damp(this.ex, exT, exT > this.ex ? 0.5 : 0.1, dt);              // winded after a run, settling over seconds
    this.bph += dt * (1.7 + 1.8 * this.ex);
    const breath = Math.sin(this.bph) * (0.012 + 0.016 * this.ex);
    // grip adjust now and then while standing at ease
    if (still > 0.6 && this.fidT <= 0) { this.fidN -= dt; if (this.fidN <= 0) { this.fidN = 7 + this._rnd() * 9; this.fidT = 0.9; this.fidK = this._rnd() < 0.5 ? 0 : 1; } }
    if (this.fidT > 0) this.fidT = Math.max(0, this.fidT - dt);
    const fid = this.fidT > 0 ? Math.sin(PI * (1 - this.fidT / 0.9)) * (1 - aimE) : 0;

    // ── hips: over the support foot standing; in rhythm, bob, sway, drop on the swing side, rotate with the legs
    let sxW = 0, szW = 0, ws = 0, fyl = 0;
    for (let si = 0; si < 2; si++) {
      this._standTarget(si, aimE);
      const w = (this.sw[si] < 0 ? 1 : 0.1) * (1 + (si ? 1 : -1) * this.wsb * still);
      sxW += w * this.fA[si].x; szW += w * (this.fA[si].z - this._sz); ws += w;
      fyl += wrapA(this.fY[si] - this._syw);
    }
    this.hxS = damp(this.hxS, sxW / ws * 0.55, 6, dt); this.hzS = damp(this.hzS, szW / ws * 0.4, 6, dt);
    const blade = -0.34 * aimE * (1 - kneel) - 0.3 * kneel;
    this.psiS = damp(this.psiS, blade + clamp(0.4 * fyl, -0.8, 0.8), 10, dt);   // the hips lag with the feet when he turns on the spot
    const amp = g1 * sstep(0.15, 1.1, vS), ph = this.ph;
    const bob = amp * this.stBob * lerp(0.008 * (1 - 0.65 * glide), -0.03, rb) * Math.cos(4 * PI * (ph - duty * 0.5)) * k;
    const swayG = -amp * this.stSway * (0.022 * (1 - rb) + 0.007 + 0.01 * wS * (1 - rb)) * Math.cos(TAU * (ph - duty * 0.5)) * k;
    const yawOsc = -amp * lerp(0.075, 0.11, rb) * Math.cos(TAU * ph);
    const rollOsc = -amp * this.stSway * lerp(0.06, 0.035, rb) * Math.cos(TAU * (ph - duty * 0.3));
    // leaning into acceleration, braking and turns (the whole body, not countered by the spine)
    const accF = clamp(this.az * 0.032, -0.12, 0.1), accS = clamp(-this.ax * 0.03, -0.08, 0.08) * g1;
    const turnL = clamp(vS * this.yr * 0.04, -0.14, 0.14) * g1;
    this.bladeW = -0.34 * aimE * 0.4 * (1 - kneel);
    const hipsYaw = lerp(this.psiS, this.twist + yawOsc + this.bladeW, g1);
    const hipsRollG = rollOsc + (this.hxS * 1.2 / k + shiftS * 0.05) * (1 - g1);
    const hipsPitch = -(0.03 * g1 + 0.09 * rb * g1 + 0.05 * kneel + 0.03 * aimE + 0.04 * glide * g1) + 0.12 * stun + accF;
    const hx = (this.hxS + shiftS * 0.012 * k) * (1 - g1) + swayG;
    const hz = (-0.025 * aimE * (1 - g1) - 0.035 * rb * g1 + 0.02 * kneel) * k + this.hzS * (1 - g1);
    let hy0 = (0.966 - 0.022 * aimE * (1 - g1) - g1 * (0.03 + 0.04 * rb) * sstep(0.2, 1, vS) - glide * g1 * 0.045 - cr * g1 * 0.22 - fl * 0.03 * this.flX - stun * 0.05) * k + bob;
    hy0 = lerp(hy0, 0.548 * k, kneel);
    // kneeling: the feet go to the kneel (right knee down, toes curled), lifted on the way
    if (kneel > 0.001) {
      const lb = Math.sin(PI * kneel) * 0.05 * k;
      _tg.set(-0.12 * k, ANKLE_H * k, -0.40 * k); this.fA[0].lerp(_tg, kneel); this.fA[0].y += lb * 0.6;
      this.fP[0] = lerp(this.fP[0], 0, kneel); this.fY[0] = lerp(this.fY[0], -0.15, kneel); this.fR[0] *= 1 - kneel;
      _tg.set(0.15 * k, 0.105 * k, 0.37 * k); this.fA[1].lerp(_tg, kneel); this.fA[1].y += lb;
      this.fP[1] = lerp(this.fP[1], -1.2, kneel); this.fY[1] = lerp(this.fY[1], -0.35, kneel); this.fR[1] *= 1 - kneel;
    }
    L[HIPS].position.set(hx, hy0, hz);
    eulerQ(L[HIPS].quaternion, hipsPitch, hipsYaw, hipsRollG + turnL + accS);
    this._fk(HIPS);
    // keep every planted foot reachable: first by rocking a trailing foot onto its ball, then by lowering the hips
    let hyMax = 1e9;
    const R = REACH * k;
    for (let si = 0; si < 2; si++) {
      if (this.sw[si] >= 0 && kneel < 0.5) continue;
      _J.set((si ? 1 : -1) * HIPX * k, -0.045 * k, 0).applyQuaternion(this.wq[HIPS]);
      let lim = this._reachY(this.fA[si], hx + _J.x, hz + _J.z, _J.y, R);
      // (only a foot behind the hip in the way he is going, in the second half of its stance)
      if (lim < hy0 && this.gait && kneel < 0.05 && this.sw[si] < 0 && Math.abs(P.toe) > 0.1 && this.fu[si] > 0.5 * duty
        && (this.fA[si].x - hx - _J.x) * this.vx + (this.fA[si].z - hz - _J.z) * this.vz < 0) {
        const dir = P.toe < 0 ? -1 : 1;
        let mag = Math.max(Math.abs(this.fpc[si]), this.flf[si]);
        for (let it = 0; it < 12 && lim < hy0 && mag < 1.15; it++) {
          mag += 0.05;
          this._ankle(this.fpx[si], this.fpy[si], this.fpz[si], this.fyw[si], dir * mag, _a0);
          this._local(_a0.x, _a0.y, _a0.z, this.fA[si]);
          lim = this._reachY(this.fA[si], hx + _J.x, hz + _J.z, _J.y, R);
        }
        this.flf[si] = mag; this.fP[si] = dir * mag + this.fsp[si];
      }
      const ex = this.fA[si].x - hx - _J.x, ez = this.fA[si].z - hz - _J.z;
      const along = vS > 0.05 ? (ex * this.vx + ez * this.vz) / vS : 0, across = vS > 0.05 ? Math.abs(ex * this.vz - ez * this.vx) / vS : 0;
      if (this.gait && this.sw[si] < 0 && kneel < 0.05 && this.fage[si] > 0.1 && ((along < 0 && this.flf[si] > 1.1) || across > 0.25 * k)) {
        // a planted foot left behind (already on its toes) or out to the side in a tight turn, that will be out of
        // reach within ~3 frames even with a 6 cm dip, lifts now rather than the hips sinking or the leg tearing it up
        const dy = hy0 - 0.06 * k + _J.y - this.fA[si].y, rmax = Math.sqrt(Math.max(0, R * R - dy * dy));
        const dh = Math.hypot(ex, ez);
        if (dh > rmax - vS * dt * 3 - 0.01 * k) this.over[si] = true;
      }
      const drop = this.gait ? 0.12 * k : 0.3 * k;       // in rhythm a foot that far out lifts next frame rather than the hips sinking
      if (lim < hy0 - drop) { lim = hy0 - drop; if (this.sw[si] < 0) this.over[si] = true; }
      hyMax = Math.min(hyMax, lim);
    }
    const hy = smin(hy0, hyMax, 0.03 * k);
    this.dbgHy0 = hy0; this.dbgHy = hy;
    L[HIPS].position.y = hy;
    this._fk(HIPS);

    // ── spine / chest: ribcage counter-rotation, lean, breathing, flinch, stun, aim pitch
    const pitch = this.pitchS * aimE;
    const chestYawW = lerp(-0.45 * yawOsc, -0.27 * (1 - kneel * 0.3), aimE);
    const twist = chestYawW - hipsYaw + this.scan * 0.15;
    const leanF = -(0.05 * g1 + 0.12 * rb * g1) * sstep(0.2, 1.2, vS) - 0.04 * aimE + 0.06 * kneel * (1 - aimE) + this.stPost * (1 - 0.6 * aimE) - 0.04 * glide * g1;
    eulerQ(L[SPINE].quaternion, leanF * 0.5 + pitch * 0.25 + fl * 0.22 * this.flX - 0.25 * stun + breath * 0.3, twist * 0.4, -hipsRollG * 0.6 + fl * 0.18 * this.flZ);
    eulerQ(L[CHEST].quaternion, leanF * 0.5 + pitch * 0.35 + breath + fl * 0.16 * this.flX + this.kick * 0.06 * aimE - 0.18 * stun, twist * 0.6, -hipsRollG * 0.3 + fl * 0.1 * this.flZ + stun * 0.06 * Math.sin(this.t * 3.1));
    this._fk(SPINE); this._fk(CHEST);

    // ── weapon pose (mesh space), anchored on the chest
    const cp = this.wp[CHEST];
    // carry: low ready (muzzle down-left, across the body), swinging with the shoulders; at a run, port arms
    const cyw = chestYawW + 0.05 * Math.sin(TAU * ph) * amp;
    const port = rb * g1 * (1 - aimE);
    eulerQ(_qc, -0.62 - 0.1 * rb * g1 + 0.12 * fid * (1 - this.fidK), 0.62 + cyw, -0.35 + 0.15 * fid * (1 - this.fidK));
    if (port > 0.001) { eulerQ(_q4, 0.55, 0.95 + cyw, 0.2); _qc.slerp(_q4, port); }
    _pc.set(lerp(0.135, 0.11, port), lerp(-0.20, -0.16, port) + 0.025 * fid * (1 - this.fidK), lerp(-0.235, -0.25, port)).multiplyScalar(k);
    _pc.applyAxisAngle(_v5.set(0, 1, 0), cyw).add(cp);
    _pc.y += 0.012 * Math.sin(TAU * 2 * ph) * amp * k;
    // aim: shouldered, sights at the eye line, follows pitch
    eulerQ(_qa, pitch + this.kick * 0.07 + fl * -0.25, 0.015 * Math.sin(this.t * 0.9) * (1 - g1), 0);
    _pa.set(0.105, 0.205 - 0.01 * kneel, -0.395).multiplyScalar(k);
    _v5.set(1, 0, 0); _pa.applyAxisAngle(_v5, pitch * 0.85);
    _pa.add(cp); _pa.z += this.kick * 0.03 * k;
    _pw.lerpVectors(_pc, _pa, aimE);
    this.wqW.slerpQuaternions(_qc, _qa, aimE);
    // held, not welded: lags and sways with the body's motion (much less when shouldered)
    this._weaponLag(dt, hy);
    const lagW = 1 - 0.75 * aimE;
    _v4.set(this.wo[0], this.wo[1], this.wo[2]).multiplyScalar(lagW).applyAxisAngle(_v5.set(0, 1, 0), cyw);
    _pw.add(_v4);
    eulerQ(_q4, this.wo[4] * lagW, this.wo[3] * lagW, 0); this.wqW.multiply(_q4);
    // stunned: hanging from the right hand, muzzle down
    if (stun > 0.001) {
      eulerQ(_q4, -1.15, 0.25, -0.2);
      _v4.set(0.2, -0.33, -0.12).multiplyScalar(k).add(cp);
      _pw.lerp(_v4, stun); this.wqW.slerp(_q4, stun);
    }
    L[WEAPON].position.copy(_pw); L[WEAPON].quaternion.copy(this.wqW);
    this._fk(WEAPON);
    this.wpW.copy(_pw);

    // ── clavicles: shrug the gun shoulder when aiming, reach forward with the support side, breathe
    // right: +y forward, +z up; left: −y forward, −z up
    const br = breath * 0.8 * (1 - aimE * 0.5);
    eulerQ(L[CLAV_R].quaternion, 0, 0.04 * aimE - 0.1 * this.kick * aimE, 0.09 * aimE - 0.04 * stun + br);
    eulerQ(L[CLAV_L].quaternion, 0, -0.26 * aimE - 0.1 * (1 - aimE), -0.03 * aimE - 0.18 * stun - br);
    // ── arms: right hand on the pistol grip, left on the handguard (or the face when stunned)
    const g = this.gun;
    const wq = this.wq[WEAPON], wpos = this.wp[WEAPON];
    _G.set(g.gripAxis[0], g.gripAxis[1], g.gripAxis[2]).applyQuaternion(wq);
    _v1.set(0, 0, -1).applyQuaternion(wq);      // weapon forward: nudges the trigger hand to wrap from behind
    _v2.set(1, -1.2, 0.5).applyQuaternion(this.wq[CHEST]);
    _v2.lerp(_v3.set(1.1, -0.5, 0.3).applyQuaternion(this.wq[CHEST]), aimE);
    this._arm(1, wpos, _G, _v2.x, _v2.y, _v2.z, _v1);
    // support hand: slide along the rail until it is within reach
    this._fk(CLAV_L); this._fk(ARM_L);
    _v3.set(0, 0, 1).applyQuaternion(wq);       // rail direction (+z back)
    _v4.set(0, g.rail[0], 0).applyQuaternion(wq).add(wpos);        // rail origin at z = 0
    const sh = this.wp[ARM_L], Ra = (UPPER + LOWER) * k + 0.07 * k;
    _v5.subVectors(_v4, sh);
    const bq = _v5.dot(_v3), cq = _v5.lengthSq() - Ra * Ra, disc = bq * bq - cq;
    let s = g.rail[3] + 0.05 * fid * this.fidK;
    if (disc > 0) { const r0 = -bq - Math.sqrt(disc), r1 = -bq + Math.sqrt(disc); s = clamp(s, r0, r1); }
    else s = -bq;
    s = clamp(s, g.rail[1], g.rail[2] + 0.06);
    _tg.copy(_v4).addScaledVector(_v3, s);
    _G.set(0, 0, -1).applyQuaternion(wq);
    if (stun > 0.5) {
      // hand to the face: grip "cylinder" just in front of the eyes, axis across
      this._headCentre();
      _tg.set(this.hx + 0.01 * k, this.hy + 0.0, this.hz - 0.1 * k);
      _G.set(-1, 0.3, 0).normalize();
      this._arm(-1, _tg, _G, -1, -0.6, 0.2, null);
    } else {
      _v2.set(-0.7, -1, 0.2).applyQuaternion(this.wq[CHEST]);
      this._arm(-1, _tg, _G, _v2.x, _v2.y, _v2.z, null);
    }

    // ── head and neck: steady in space, turning into corners and towards where he is about to look
    // before the body follows; cheek weld when aiming, flinch snap
    const lead = this.lookHas ? clamp(this.lookOff, -1.2, 1.2) * 0.6 : clamp(this.yr * 0.25, -0.6, 0.6);
    this.headLead = damp(this.headLead, lead * (1 - stun) * (1 - 0.6 * aimE), 6, dt);
    const hYaw = this.scan * 0.85 + 0.06 * aimE + this.headLead;
    const hPitch = pitch * 0.9 - 0.18 * aimE + fl * 0.35 * this.flX - 0.55 * stun + 0.04 * Math.sin(this.t * 0.37) * (1 - aimE) * (1 - g1)
      + 0.06 * rb * g1 + this.stHead * (1 - aimE) - accF * 0.5;
    const hRoll = -0.16 * aimE + fl * 0.2 * this.flZ;
    eulerQ(_qw, hPitch, hYaw, hRoll);
    _qi.copy(this.wq[CHEST]).invert();
    _q4.multiplyQuaternions(_qi, _qw);                         // relative to the chest
    L[NECK].quaternion.slerpQuaternions(QI, _q4, 0.45);
    this._fk(NECK);
    _qi.copy(L[NECK].quaternion).invert();
    L[HEAD].quaternion.multiplyQuaternions(_qi, _q4);
    this._headCentre();

    // ── legs: knees between the foot's and the hips' facing, a little out; the kneeling knee down-forward
    for (let si = 0; si < 2; si++) {
      const side = si ? 1 : -1, fy = this.fY[si], ky = (fy + hipsYaw) * 0.5;
      this._leg(side, this.fA[si], this.fP[si], fy, this.fR[si], -Math.sin(ky) + side * 0.15, side > 0 ? -0.8 * kneel : 0, -Math.cos(ky));
    }
  }

  // ── death falls ───────────────────────────────────────────────────────
  _death(dt) {
    const L = this.list, k = this.k, sd = this.dside;
    if (this.settled) { this._weaponDrop(); return; }
    const dur = this.dv === 0 ? 1.05 : this.dv === 1 ? 1.1 : 1.55;
    this.deathT = Math.min(1, this.deathT + dt / dur);
    const t = this.deathT, w = sstep(0, 0.22, t);
    // pose curves: hips pitch, roll, yaw; hips height and travel; spine/neck; limbs
    let hp, hr, hyw, hy, hz, hx, sp, sc, nh, ny, legL, legR, shL, shR;
    if (this.dv === 0) {           // backward: pivot on the heels
      const a = t < 0.18 ? 0.25 * ease3(t / 0.18) : 0.25 + (PI / 2 - 0.25) * Math.pow(clamp01((t - 0.18) / 0.62), 1.7);
      const ab = a + 0.05 * Math.sin(PI * clamp01((t - 0.8) / 0.2)) * (t > 0.8 ? 1 : 0);
      const R = (0.9 - 0.08 * Math.sin(PI * clamp01(t / 0.8))) * k;
      hp = ab; hr = sd * 0.12 * t; hyw = sd * 0.25 * t;
      hy = Math.cos(ab) * R; hz = 0.05 * k + Math.sin(ab) * R; hx = sd * 0.05 * k * t;
      sp = -0.12 * Math.sin(PI * clamp01(t / 0.7)) + 0.04 * t; sc = 0.05 * t;
      nh = lerp(-0.35, 0.05, sstep(0.5, 0.95, t)); ny = sd * 0.75 * sstep(0.7, 1, t);
      legL = [0.25 * Math.sin(PI * clamp01(t / 0.8)) - 0.02, sd * 0.25 * t, -0.12 * t]; legR = [0.12 * Math.sin(PI * clamp01(t / 0.7)) + 0.05 * t, sd * 0.2 * t, 0.15 * t];
      shL = -0.55 * Math.sin(PI * clamp01(t / 0.85)) - 0.08 * t; shR = -0.4 * Math.sin(PI * clamp01(t / 0.75)) - 0.25 * t;
    } else if (this.dv === 1) {    // forward: knees give, then topple onto the front
      const a = t < 0.25 ? 0.18 * ease3(t / 0.25) : 0.18 + (PI / 2 - 0.2) * Math.pow(clamp01((t - 0.25) / 0.58), 1.6);
      const R = (0.9 - 0.12 * sstep(0, 0.4, t) + 0.06 * sstep(0.5, 1, t)) * k;
      hp = -a; hr = sd * 0.15 * t; hyw = sd * 0.3 * t;
      hy = Math.cos(a) * R + 0.0; hz = -0.12 * k * t - Math.sin(a) * R; hx = 0;
      sp = -0.15 * sstep(0, 0.5, t) + 0.17 * sstep(0.7, 1, t); sc = 0.02;
      nh = lerp(0.15, 0.25, t); ny = sd * 1.25 * sstep(0.55, 1, t);
      legL = [0.35 * Math.sin(PI * clamp01(t / 0.7)) - 0.04 * t, -sd * 0.12 * t, -0.08 * t]; legR = [0.2 * Math.sin(PI * clamp01(t / 0.75)) + 0.03 * t, -sd * 0.1 * t, 0.1 * t];
      shL = -0.9 * Math.sin(PI * clamp01(t / 0.75)) - 0.12 * t; shR = -0.7 * Math.sin(PI * clamp01(t / 0.7)) - 0.35 * t;
    } else {                       // crumple: legs fold, drops, slumps onto the side
      const drop = sstep(0, 0.45, t), fall = sstep(0.35, 0.95, t);
      hp = -0.35 * drop - 1.0 * fall; hr = sd * (0.15 * drop + 1.05 * fall); hyw = sd * 0.35 * fall;
      hy = lerp(0.93 * k, 0.5 * k, drop) * (1 - fall) + 0.12 * k * fall; hz = -0.12 * k * drop - 0.25 * k * fall; hx = sd * 0.18 * k * fall;
      sp = -0.3 * drop + 0.15 * fall; sc = -0.15 * drop + 0.05 * fall;
      nh = 0.35 * drop - 0.1 * fall; ny = sd * 0.6 * fall;
      legL = [1.35 * drop - 0.55 * fall, sd * 0.1, -0.1 * drop]; legR = [1.15 * drop - 0.2 * fall, sd * 0.1, 0.12 * drop];
      shL = -2.1 * drop + 0.7 * fall; shR = -1.9 * drop + 0.3 * fall;
    }
    // hips (position from the curve, blended in from where he stood)
    _v1.set(hx, hy, hz);
    L[HIPS].position.lerpVectors(this.d0hp, _v1, w);
    eulerQ(_q1, hp, hyw, hr); L[HIPS].quaternion.slerpQuaternions(this.d0[HIPS], _q1, w);
    eulerQ(_q1, sp, 0, -sd * 0.05 * t); L[SPINE].quaternion.slerpQuaternions(this.d0[SPINE], _q1, w);
    eulerQ(_q1, sc, sd * 0.08 * t, 0); L[CHEST].quaternion.slerpQuaternions(this.d0[CHEST], _q1, w);
    eulerQ(_q1, nh * 0.4, ny * 0.4, 0); L[NECK].quaternion.slerpQuaternions(this.d0[NECK], _q1, w);
    eulerQ(_q1, nh * 0.6, ny * 0.6, 0); L[HEAD].quaternion.slerpQuaternions(this.d0[HEAD], _q1, w);
    // ground: lift if any torso probe would dip below the ground; settle onto it at the end
    this._fk(HIPS); this._fk(SPINE); this._fk(CHEST); this._fk(NECK); this._fk(HEAD);
    let low = 9;
    for (const p of PROBES) {
      _v2.set(p[1] * k, p[2] * k, p[3] * k).applyQuaternion(this.wq[p[0]]).add(this.wp[p[0]]);
      const r = (p[0] === HEAD && this.helmet ? p[4] + 0.02 : p[4]) * k;
      low = Math.min(low, _v2.y - r);
    }
    let corr = low < 0 ? -low : 0;
    const settle = sstep(0.82, 1, t);
    if (low > 0) corr = -low * settle;
    L[HIPS].position.y += corr;
    this._fk(HIPS); this._fk(SPINE); this._fk(CHEST); this._headCentre();
    // limbs: FK flail during the fall, then two-bone IK onto ground targets
    const gL = sstep(0.5, 0.93, t);
    _v3.set(0, -1, 0).applyQuaternion(this.wq[HIPS]); _v3.y = 0;            // towards the feet, on the ground
    if (_v3.lengthSq() < 1e-6) _v3.set(0, 0, -1); _v3.normalize();
    _v4.set(1, 0, 0).applyQuaternion(this.wq[HIPS]); _v4.y = 0;             // body right, on the ground
    if (_v4.lengthSq() < 1e-6) _v4.set(1, 0, 0); _v4.normalize();
    _P.set(0, 0, -1).applyQuaternion(this.wq[HIPS]); _P.y = 0;              // body front, on the ground
    if (_P.lengthSq() < 1e-6) _P.copy(_v3); _P.normalize();
    eulerQ(_q1, legL[0], legL[1], legL[2] - 0.05); L[LEG_L].quaternion.slerpQuaternions(this.d0[LEG_L], _q1, w);
    eulerQ(_q1, legR[0], legR[1], legR[2] + 0.05); L[LEG_R].quaternion.slerpQuaternions(this.d0[LEG_R], _q1, w);
    eulerQ(_q1, Math.min(0, shL), 0, 0); L[SHIN_L].quaternion.slerpQuaternions(this.d0[SHIN_L], _q1, w);
    eulerQ(_q1, Math.min(0, shR), 0, 0); L[SHIN_R].quaternion.slerpQuaternions(this.d0[SHIN_R], _q1, w);
    eulerQ(_q1, 0.35 * t + (this.dv === 0 ? 0.25 * t : 0), 0, 0); L[FOOT_L].quaternion.slerpQuaternions(this.d0[FOOT_L], _q1, w); L[FOOT_R].quaternion.slerpQuaternions(this.d0[FOOT_R], _q1, w);
    const LL = (THIGH + SHANK) * k;
    for (let si = 0; si < 2; si++) {
      const side = si === 0 ? -1 : 1, LG = side < 0 ? LEG_L : LEG_R, SH = side < 0 ? SHIN_L : SHIN_R, FT = side < 0 ? FOOT_L : FOOT_R;
      this._fk(LG); this._fk(SH); this._fk(FT);
      if (gL > 0.001) {
        const hj = this.wp[LG];
        if (this.dv === 0) { _tg.copy(hj).addScaledVector(_v3, 0.93 * LL).addScaledVector(_v4, side * 0.13 * k); _pole.set(0, 1, 0).addScaledVector(_v4, side * 0.5); }
        else if (this.dv === 1) { _tg.copy(hj).addScaledVector(_v3, 0.95 * LL).addScaledVector(_v4, side * 0.1 * k); _pole.copy(_v4).multiplyScalar(side); }
        else { _tg.copy(hj).addScaledVector(_v3, (side === sd ? 0.5 : 0.62) * LL).addScaledVector(_P, (side === sd ? 0.5 : 0.36) * LL); _pole.copy(_P); }
        _tg.y = clamp(hj.y - 0.04 * k, 0.078 * k, 0.4);
        solve2(this.legC, hj, _tg, _pole, _q1, _q2);
        _q3.copy(this.wq[LG]).slerp(_q1, gL); this._setWorld(LG, _q3);
        _q3.copy(this.wq[SH]).slerp(_q2, gL); this._setWorld(SH, _q3);
        this._fk(FT);
      }
    }
    // arms: flail out and up, then lay the hands on the ground with the elbows flat
    const fla = Math.sin(PI * clamp01(t / 0.75));
    eulerQ(_q1, 0.1, 0, 0.3 * sd); L[CLAV_L].quaternion.slerpQuaternions(this.d0[CLAV_L], _q1, w * 0.5);
    eulerQ(_q1, 0.1, 0, -0.3 * sd); L[CLAV_R].quaternion.slerpQuaternions(this.d0[CLAV_R], _q1, w * 0.5);
    const reach = (UPPER + LOWER) * k * 0.9;
    for (let si = 0; si < 2; si++) {
      const side = si === 0 ? -1 : 1, CL = side < 0 ? CLAV_L : CLAV_R, AR = side < 0 ? ARM_L : ARM_R, FO = side < 0 ? FORE_L : FORE_R, HA = side < 0 ? HAND_L : HAND_R;
      this._fk(CL);
      eulerQ(_q1, (this.dv === 0 ? 0.9 : 1.4) * fla, 0, side * (0.5 + 0.6 * fla)); L[AR].quaternion.slerpQuaternions(this.d0[AR], _q1, w);
      _q1.setFromAxisAngle(_v5.set(-CA, -side * SA, 0), -0.4 * fla - 0.3);      // elbow hinge (bend forward)
      L[FO].quaternion.slerpQuaternions(this.d0[FO], _q1, w);
      L[HA].quaternion.slerpQuaternions(this.d0[HA], QI, w * 0.7);
      this._fk(AR); this._fk(FO); this._fk(HA);
      if (gL > 0.001) {
        const sh = this.wp[AR];
        // out to the side and up beside the head (back, face down); crumpled: under / in front
        let out = 0.8, up = 0.35, fr = 0;
        if (this.dv === 1) { out = 0.55; up = 0.6; }
        else if (this.dv === 2) { out = side === sd ? 0.2 : 0.55; up = side === sd ? 0.1 : -0.25; fr = side === sd ? 0.75 : 0.5; }
        _tg.copy(sh).addScaledVector(_v4, side * out * reach).addScaledVector(_v3, -up * reach).addScaledVector(_P, fr * reach);
        _tg.y = clamp(sh.y - 0.12 * k, 0.045 * k, 0.4);
        _v2.subVectors(_tg, sh); const dl = _v2.length(); if (dl > reach) _tg.copy(sh).addScaledVector(_v2, reach / dl);
        _pole.copy(_v3).addScaledVector(_v4, side * 0.4); _pole.y = 0;      // elbow towards the feet, flat on the ground
        solve2(side < 0 ? this.armCL : this.armCR, sh, _tg, _pole, _q1, _q2);
        _q3.copy(this.wq[AR]).slerp(_q1, gL); this._setWorld(AR, _q3);
        _q3.copy(this.wq[FO]).slerp(_q2, gL); this._setWorld(FO, _q3);
        this._fk(HA);
      }
    }
    // never below the ground: lift the whole body by the deepest probe
    let lowAll = 9;
    const probe = (p) => {
      _v2.set(p[1] * k, p[2] * k, p[3] * k).applyQuaternion(this.wq[p[0]]).add(this.wp[p[0]]);
      lowAll = Math.min(lowAll, _v2.y - p[4] * k);
    };
    for (const p of LIMB_PROBES) probe(p);
    for (const p of PROBES) probe(p);
    if (this.radio) probe(RADIO_PROBE);
    if (lowAll < 0) {
      L[HIPS].position.y -= lowAll;
      for (let i = 0; i < NB; i++) if (i !== WEAPON) this.wp[i].y -= lowAll;
      this.hy -= lowAll;
    }
    this._weaponDrop();
    if (t >= 1) this.settled = true;
  }

  /** The rifle leaves the hands, falls and lies on its side; a dragged body leaves it behind. */
  _weaponDrop() {
    const L = this.list, t = this.deathT;
    if (!this.settled) {
      const f = clamp01((t - 0.08) / 0.55), e = f * f;
      _v1.lerpVectors(this.dW0p, this.dW1p, sstep(0, 1, f));
      _v1.y = lerp(this.dW0p.y, this.dW1p.y, e) + 0.12 * this.k * Math.sin(PI * f) * (1 - f);
      if (f >= 1) _v1.y = this.dW1p.y + 0.02 * this.k * Math.max(0, Math.sin(PI * clamp01((t - 0.63) / 0.15)));
      L[WEAPON].position.copy(_v1);
      L[WEAPON].quaternion.slerpQuaternions(this.dW0q, this.dW1q, sstep(0, 0.9, f));
      this._fk(WEAPON);
      return;
    }
    // settled: keep the rifle where it fell in the world even if the body is dragged
    const m = this.mesh;
    if (!m) return;
    if (!this.dropSet) {
      this.dropSet = true;
      const c = Math.cos(m.rotation.y), s = Math.sin(m.rotation.y), p = this.dW1p;
      this.dropPos.set(m.position.x + p.x * c + p.z * s, m.position.y + p.y, m.position.z - p.x * s + p.z * c);
      this.dropYaw = m.rotation.y;
    }
    const dx = this.dropPos.x - m.position.x, dz = this.dropPos.z - m.position.z;
    const c = Math.cos(-m.rotation.y), s = Math.sin(-m.rotation.y);
    L[WEAPON].position.set(dx * c + dz * s, this.dropPos.y - m.position.y, -dx * s + dz * c);
    _q1.setFromAxisAngle(_v5.set(0, 1, 0), this.dropYaw - m.rotation.y);
    L[WEAPON].quaternion.multiplyQuaternions(_q1, this.dW1q);
    // grow the culling sphere to hold both the body and the rifle
    const bs = m.boundingSphere;
    if (bs) {
      const wx = L[WEAPON].position.x, wz = L[WEAPON].position.z, d = Math.hypot(wx, wz);
      if (d > 0.8) { bs.center.set(wx * 0.5, 0.5, wz * 0.5); bs.radius = d * 0.5 + 2.0; }
      else { bs.center.set(0, 0.75, 0); bs.radius = 2.05; }
    }
  }
}
