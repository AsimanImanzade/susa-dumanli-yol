/**
 * pickup-models.js — the things the player finds on the ground and the things
 * he throws, modelled in code to the standard of the first-person weapons.
 *
 *   buildPickupModel(type, o)   a ground pickup resting on y = 0, with a soft glint
 *   buildItemModel(kind)        a thrown / held item (frag, smoke, flash, stone,
 *                               tknife, c4) or the ejected shell, origin at its centre
 *
 * Everything uses ONE shared MeshStandardMaterial (pickupMaterial) so a pickup
 * is a single draw call plus its glint sprite. Per vertex the geometry carries
 *   color  albedo with edge wear and baked ambient occlusion (the ground too)
 *   pbr    roughness, metalness, detail amount, detail repeats per metre
 *   sel    weights of the four detail channels (metal, weave, grain, wood)
 *   duv    box-projected detail UVs in metres
 *   uvm    markings atlas UV + weight (stencils, labels, zips, perforations)
 * and the shader patch turns those into albedo / roughness / bump detail and
 * paint. Without scene.environment it lights metal from the hemisphere light
 * (so steel is never black); with one it uses three's own IBL.
 * Geometry is built lazily on first use and cached per type, so twenty pickups
 * of one type share one geometry and the one material. Modelling primitives
 * come from weapon-models.js (KIT) and so do the guns and the suppressor shapes.
 *
 * Coordinates: metres, +Y up. Pickups are built where they lie: centred on
 * the origin in X/Z, resting on y = 0.
 */
import * as THREE from 'three';
import { KIT, SUPPRESSORS, buildWorldWeapon } from './weapon-models.js';

const { TAU, PI, clamp01, lerp, sstep, h3, pnoise, pfbm, noise3, scratchMask, mapP, flipTris, creaseNormals, hashRows,
  side, lathe, revolve, torus, loft, rbox, Occ, aoAt } = KIT;

// ───────────────────────────── surfaces ─────────────────────────────
// r roughness, m metalness, d detail amount, s detail repeats per metre, sel detail channels [metal, weave, grain, wood]
const SURF = {
  paint: { r: 0.6, m: 0, d: 0.5, s: 7, sel: [0.4, 0, 0.6, 0] },       // painted steel: orange peel and fine scratches
  steel: { r: 0.42, m: 0.85, d: 0.55, s: 9, sel: [1, 0, 0, 0] },
  bright: { r: 0.32, m: 0.9, d: 0.45, s: 9, sel: [1, 0, 0, 0] },
  blued: { r: 0.38, m: 0.8, d: 0.5, s: 9, sel: [1, 0, 0, 0] },
  brass: { r: 0.3, m: 1, d: 0.35, s: 16, sel: [1, 0, 0, 0] },
  alu: { r: 0.36, m: 0.85, d: 0.35, s: 14, sel: [0.6, 0, 0.4, 0] },
  cloth: { r: 0.95, m: 0, d: 0.95, s: 11, sel: [0, 1, 0, 0] },        // cordura, canvas
  web: { r: 0.8, m: 0, d: 0.9, s: 20, sel: [0, 1, 0, 0] },            // nylon webbing
  cord: { r: 0.85, m: 0, d: 0.9, s: 34, sel: [0, 1, 0, 0] },          // paracord
  film: { r: 0.45, m: 0, d: 0.35, s: 5, sel: [0, 0, 1, 0] },          // wrapper film
  paper: { r: 0.9, m: 0, d: 0.45, s: 8, sel: [0, 0.3, 0.7, 0] },
  plastic: { r: 0.5, m: 0, d: 0.3, s: 10, sel: [0, 0, 1, 0] },
  rubber: { r: 0.85, m: 0, d: 0.35, s: 10, sel: [0, 0, 1, 0] },
  wood: { r: 0.6, m: 0, d: 1, s: 4, sel: [0, 0, 0, 1] },
  glass: { r: 0.05, m: 0, d: 0, s: 1, sel: [0, 0, 0, 0] },
  stone: { r: 0.9, m: 0, d: 0.95, s: 5, sel: [0.25, 0, 0.75, 0] },
};

// ───────────────────────────── textures ─────────────────────────────
let DETAIL = null;
/** One tiling RGBA detail texture (linear): R metal grain + scratches, G weave, B fine grain, A wood. */
function detailTex() {
  if (DETAIL) return DETAIL;
  const N = 256, d = new Uint8Array(N * N * 4), scr = scratchMask(N, 360, 5);
  for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++, i += 4) {
    const u = x / N, v = y / N;
    // metal: directional grain, mottling, scratches, the odd pit
    const g = pnoise(u, v, 128, 8, 1), mo = pfbm(u, v, 4, 4, 2, 2), pit = h3(x, y, 3);
    const r = 0.5 + (g - 0.5) * 0.22 + (mo - 0.5) * 0.3 + scr[y * N + x] * 0.45 - (pit > 0.988 ? 0.3 : 0);
    // plain weave, 48 threads a tile, uneven threads and slubs
    const F = 48, cx = Math.floor(u * F), cy = Math.floor(v * F), fu = u * F - cx, fv = v * F - cy, over = ((cx + cy) & 1) === 0;
    const hw = over ? 0.25 + 0.75 * Math.sin(PI * fu) * (0.75 + 0.25 * Math.sin(PI * fv)) : 0.25 + 0.75 * Math.sin(PI * fv) * (0.75 + 0.25 * Math.sin(PI * fu));
    const gw = hw * (0.88 + h3(over ? cx : cy, over ? 1 : 2, 7) * 0.2) * (0.9 + pnoise(u, v, 6, 6, 9) * 0.2);
    // fine grain: orange peel and speckle
    const b = 0.5 + (pfbm(u, v, 20, 20, 2, 11) - 0.5) * 0.75 + (h3(x, y, 12) - 0.5) * 0.3;
    // wood: streaks along u, growth rings, pores
    const warp = pfbm(u, v, 2, 3, 2, 21), streak = pfbm(u, v, 3, 48, 2, 22), ring = 0.5 + 0.5 * Math.sin((v * 6 + warp * 1.6) * TAU);
    const a = 0.5 + (streak - 0.5) * 0.9 + (ring - 0.5) * 0.3 - (pnoise(u, v, 6, 192, 23) < 0.2 ? 0.12 : 0);
    d[i] = clamp01(r) * 255; d[i + 1] = clamp01(gw) * 255; d[i + 2] = clamp01(b) * 255; d[i + 3] = clamp01(a) * 255;
  }
  const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  DETAIL = t;
  return t;
}

// markings atlas: stencils, labels, zips, perforations. Regions are shelf-packed;
// `wrap` regions (cylinders) are drawn twice side by side so a triangle across the seam still finds paint.
const AW = 1024, AH = 1024;
let rnd = 1;
const rand = () => ((rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0) / 4294967296);
const FONT = 'Arial, Helvetica, sans-serif';
/** Stencilled text: condensed capitals, bridges cut through closed letters, paint worn at random. */
function stencil(g, text, x, y, size, color, o = {}) {
  g.save();
  g.font = `${o.weight || 700} ${size}px ${FONT}`; g.textBaseline = 'middle'; g.fillStyle = color;
  const sx = o.sx ?? 0.82, w = g.measureText(text).width * sx;
  let cx = o.align === 'left' ? x : x - w / 2;
  for (const ch of text) {
    const cw = g.measureText(ch).width * sx;
    g.save(); g.translate(cx, y); g.scale(sx, 1); g.fillText(ch, 0, 0); g.restore();
    if (o.bridge !== false && 'OQDBPRA0469ƏÖ8'.includes(ch)) g.clearRect(cx + cw * 0.46, y - size * 0.6, Math.max(1, size * 0.07), size * 1.2);
    cx += cw;
  }
  g.restore();
}
function print(g, text, x, y, size, color, o = {}) {
  g.save(); g.font = `${o.weight || 600} ${size}px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = o.align || 'center'; g.fillStyle = color;
  g.translate(x, y); g.scale(o.sx ?? 0.9, 1); g.fillText(text, 0, 0); g.restore();
}
function worn(g, w, h, n, k = 1) {
  g.save(); g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < n; i++) { g.globalAlpha = 0.3 + rand() * 0.7; const s = (0.6 + rand() * 2.2) * k; g.fillRect(rand() * w, rand() * h, s, s * (0.5 + rand())); }
  g.restore();
}
const MARK_DEFS = {
  ammoLid: [384, 192, (g, w, h) => {
    stencil(g, '7,62×39', w / 2, 62, 66, '#d9c682'); stencil(g, 'PS · 440 ƏD.', w / 2, 120, 34, '#d9c682');
    stencil(g, 'PARTİYA 17-20 · 2020', w / 2, 162, 22, '#d9c682', { bridge: false }); worn(g, w, h, 900);
  }],
  ammoSide: [384, 192, (g, w, h) => {
    stencil(g, 'PATRONLAR', w / 2, 64, 50, '#d9c682'); stencil(g, '7,62×39 PS', w / 2, 118, 32, '#d9c682');
    g.fillStyle = '#d9c682'; g.fillRect(40, 150, w - 80, 9); worn(g, w, h, 800);
  }],
  medFlap: [192, 192, (g, w, h) => {
    g.fillStyle = '#ece8dc'; const a = 0.2 * w, b = 0.62 * w;
    g.fillRect((w - a) / 2, (h - b) / 2, a, b); g.fillRect((w - b) / 2, (h - a) / 2, b, a);
    g.strokeStyle = 'rgba(30,30,24,0.85)'; g.lineWidth = 3; g.setLineDash([7, 5]); g.strokeRect(10, 10, w - 20, h - 20);
    worn(g, w, h, 120, 0.8);
  }],
  zip: [512, 24, (g, w, h) => {
    for (let i = 0; i < 160; i++) { const x = (i + 0.5) / 160 * w; g.fillStyle = i % 2 ? '#8c8c86' : '#6f6f6a'; g.fillRect(x - 1.1, 3, 2.2, h - 6); }
  }, true],
  dressing: [320, 160, (g, w, h) => {
    print(g, 'SARĞI PAKETİ', w / 2, 34, 30, '#2e2a1c', { weight: 800 }); print(g, 'STERİL · FƏRDİ', w / 2, 70, 20, '#2e2a1c');
    g.fillStyle = 'rgba(46,42,28,0.8)'; for (let i = 0; i < 3; i++) g.fillRect(52, 92 + i * 9, w - 104 - i * 40, 3);
    g.setLineDash([6, 4]); g.strokeStyle = '#2e2a1c'; g.lineWidth = 2; g.beginPath(); g.moveTo(w - 46, 14); g.lineTo(w - 46, h - 14); g.stroke();
    print(g, '◄ AÇ', w - 70, h - 22, 16, '#2e2a1c'); worn(g, w, h, 160, 0.7);
  }],
  plate: [160, 96, (g, w, h) => {
    g.fillStyle = '#d8d5c8'; g.fillRect(4, 4, w - 8, h - 8);
    print(g, 'SİNİF IV', w / 2, 30, 26, '#1d1d1a', { weight: 800 }); print(g, 'ÖN · 25×30 sm', w / 2, 60, 16, '#1d1d1a');
    g.fillStyle = '#1d1d1a'; g.fillRect(20, 76, w - 40, 3); worn(g, w, h, 90, 0.8);
  }],
  tqTag: [96, 48, (g, w, h) => { g.fillStyle = '#e4e2da'; g.fillRect(0, 0, w, h); print(g, 'VAXT:', 30, 17, 15, '#1c1c1c', { weight: 800 }); g.fillStyle = '#1c1c1c'; g.fillRect(10, 34, w - 20, 2); }],
  battery: [256, 96, (g, w, h) => {
    g.fillStyle = '#e6e2d4'; g.fillRect(0, 0, w, h); g.fillStyle = '#3d6a4a'; g.fillRect(0, 0, w, 22); g.fillRect(0, h - 14, w, 14);
    print(g, '1,5 V · AA · 4 ƏD.', w / 2, 52, 30, '#1e1f1c', { weight: 800 });
  }],
  oil: [288, 100, (g, w, h) => {
    g.fillStyle = '#ddd8c6'; g.fillRect(0, 8, w, h - 16); g.fillStyle = '#7a2a1e'; g.fillRect(0, 8, w, 14);
    print(g, 'SİLAH YAĞI', w * 0.3, 52, 26, '#222', { weight: 800 }); print(g, '100 ml', w * 0.3, 78, 16, '#222');
    print(g, 'SİLAH YAĞI', w * 0.8, 52, 26, '#222', { weight: 800 });
  }, true],
  smoke: [512, 158, (g, w, h) => {
    g.fillStyle = '#e2e0d6'; g.fillRect(0, 22, w, 16); g.fillRect(0, h - 38, w, 16);
    stencil(g, 'TÜSTÜ', w * 0.25, h / 2, 46, '#e2e0d6'); stencil(g, 'TÜSTÜ', w * 0.75, h / 2, 46, '#e2e0d6');
    print(g, 'AĞ · 60 s', w * 0.5, h / 2 + 4, 16, '#e2e0d6'); worn(g, w, h, 500);
  }, true],
  smokeTop: [64, 64, (g) => { g.fillStyle = '#151513'; for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + 0.4; g.beginPath(); g.arc(32 + Math.cos(a) * 20, 32 + Math.sin(a) * 20, 5, 0, TAU); g.fill(); } }],
  flash: [400, 160, (g, w, h) => {
    for (let row = 0; row < 3; row++) for (let i = 0; i < 12; i++) {
      const x = (i + 0.5 + (row % 2) * 0.5) / 12 * w, y = 58 + row * 28;
      g.fillStyle = 'rgba(150,152,150,0.9)'; g.beginPath(); g.arc(x, y, 8.5, 0, TAU); g.fill();
      g.fillStyle = '#0c0c0c'; g.beginPath(); g.arc(x, y, 6.2, 0, TAU); g.fill();
    }
    g.fillStyle = '#c9a634'; g.fillRect(0, 14, w, 14);
    print(g, 'SƏS-İŞIQ', w * 0.3, h - 14, 18, '#d8d6cc', { weight: 800 }); print(g, 'SƏS-İŞIQ', w * 0.8, h - 14, 18, '#d8d6cc', { weight: 800 });
  }, true],
  c4: [320, 160, (g, w, h) => {
    stencil(g, 'PARTLAYICI MADDƏ', w / 2, 46, 30, '#d6bf4a'); stencil(g, '0,4 KQ', w / 2, 92, 34, '#d6bf4a');
    print(g, 'P-17 · 03', w / 2, 132, 18, '#d6bf4a'); worn(g, w, h, 400);
  }],
  rx: [100, 70, (g, w, h) => {
    const gr = g.createRadialGradient(24, 26, 0, 24, 26, 13); gr.addColorStop(0, '#ff6a50'); gr.addColorStop(0.5, '#b0170e'); gr.addColorStop(1, 'rgba(60,8,6,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(24, 26, 13, 0, TAU); g.fill();
    g.fillStyle = '#7d7f80'; g.fillRect(56, 16, 26, 20); g.fillStyle = '#26282a'; g.fillRect(60, 19, 9, 14);
    print(g, 'I / O', 69, 52, 13, '#b8b8b0');
  }],
  tagSvd: [128, 74, (g, w, h) => { tagBase(g, w, h); stencil(g, 'SVD', 72, 40, 40, '#1d1c18'); }],
  tagAkm: [128, 74, (g, w, h) => { tagBase(g, w, h); stencil(g, 'AKM', 72, 40, 40, '#1d1c18'); }],
  tagPm: [128, 74, (g, w, h) => { tagBase(g, w, h); stencil(g, 'PM', 72, 40, 42, '#1d1c18'); }],
};
function tagBase(g, w, h) { g.fillStyle = 'rgba(40,32,20,0.9)'; g.beginPath(); g.arc(16, h / 2, 6, 0, TAU); g.fill(); g.fillStyle = 'rgba(120,100,70,0.35)'; g.fillRect(28, 64, w - 40, 2); }
const REG = {};
let MARKS = null;
function layoutMarks() {
  if (REG.ammoLid) return;
  let x = 0, y = 0, row = 0;
  for (const [id, [w, h, , wrap]] of Object.entries(MARK_DEFS)) {
    const aw = Math.ceil(w * (wrap ? 1.25 : 1)) + 8;
    if (x + aw > AW) { x = 0; y += row + 8; row = 0; }
    REG[id] = { x: x + 4, y: y + 4, w, h, wrap: !!wrap };
    x += aw; row = Math.max(row, h);
  }
}
function marksTex() {
  if (MARKS) return MARKS;
  layoutMarks();
  const c = document.createElement('canvas'); c.width = AW; c.height = AH;
  const g = c.getContext('2d');
  rnd = 7;
  for (const [id, [, , draw]] of Object.entries(MARK_DEFS)) {
    const R = REG[id];
    for (const off of R.wrap ? [0, R.w] : [0]) {
      g.save(); g.beginPath(); g.rect(R.x, R.y, R.wrap ? R.w * 1.25 : R.w, R.h); g.clip(); g.translate(R.x + off, R.y);
      draw(g, R.w, R.h); g.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.premultiplyAlpha = true; t.anisotropy = 4;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  MARKS = t;
  return t;
}
/** Atlas UV of the point (s, t) ∈ [0,1]² of a region (t = 0 at its bottom); s may run past 1 on a wrap region. */
function regionUV(R, s, t, out, k) {
  out[k] = (R.x + s * R.w) / AW;
  out[k + 1] = 1 - (R.y + (1 - t) * R.h) / AH;
}

// ───────────────────────────── material ─────────────────────────────
const PERTURB = `
vec3 pkPerturb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
  vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) );
  vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) );
  vec3 R1 = cross( vSigmaY, surf_norm );
  vec3 R2 = cross( surf_norm, vSigmaX );
  float fDet = dot( vSigmaX, R1 ) * faceDirection;
  vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
  return normalize( abs( fDet ) * surf_norm - vGrad );
}`;
// no environment map: metal still reflects the sky / ground of the hemisphere light (and the ambient)
const FAKE_ENV = `
#if ! defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
{
  vec3 pkR = normalize( mix( reflect( - geometryViewDir, geometryNormal ), geometryNormal, material.roughness * material.roughness ) );
  vec3 pkE = getAmbientLightIrradiance( ambientLightColor );
  #if ( NUM_HEMI_LIGHTS > 0 )
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
    pkE += getHemisphereLightIrradiance( hemisphereLights[ i ], pkR );
  }
  #pragma unroll_loop_end
  #endif
  radiance += pkE * RECIPROCAL_PI * uFakeEnv;
}
#endif`;

let MATERIAL = null;
/** The one material every pickup and item shares. */
export function pickupMaterial() {
  if (MATERIAL) return MATERIAL;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1 });
  const uniforms = { uDetail: { value: detailTex() }, uMarks: { value: marksTex() }, uBump: { value: 0.9 }, uFakeEnv: { value: 1 } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 duv;\nattribute vec4 pbr;\nattribute vec4 sel;\nattribute vec3 uvm;\nvarying vec2 vDuv;\nvarying vec4 vPbr;\nvarying vec4 vSel;\nvarying vec3 vUvm;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvDuv = duv * pbr.w; vPbr = pbr; vSel = sel; vUvm = uvm;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;\nuniform sampler2D uMarks;\nuniform float uBump;\nuniform float uFakeEnv;\nvarying vec2 vDuv;\nvarying vec4 vPbr;\nvarying vec4 vSel;\nvarying vec3 vUvm;\nfloat pkH = 0.5;\nfloat pkMk = 0.0;' + PERTURB)
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec4 pkD = texture2D( uDetail, vDuv );
    pkH = dot( pkD, vSel ) + 0.5 * ( 1.0 - dot( vSel, vec4( 1.0 ) ) );
    vec4 pkM = texture2D( uMarks, vUvm.xy ) * vUvm.z;
    pkMk = pkM.a;
    diffuseColor.rgb = diffuseColor.rgb * ( 1.0 - pkM.a ) + pkM.rgb;
    diffuseColor.rgb *= 1.0 + ( pkH - 0.5 ) * vPbr.z * 0.8;
  }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix( clamp( roughness * vPbr.x * ( 1.0 + ( 0.5 - pkH ) * vPbr.z * 0.5 ), 0.04, 1.0 ), 0.72, pkMk );')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * vPbr.y * ( 1.0 - pkMk );')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n\tnormal = pkPerturb( - vViewPosition, normal, vec2( dFdx( pkH ), dFdy( pkH ) ) * vPbr.z * uBump, faceDirection );')
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n' + FAKE_ENV);
  };
  m.customProgramCacheKey = () => 'pickup-pbr-1';
  m.userData.uniforms = uniforms;
  MATERIAL = m;
  return m;
}

// glint: a soft warm catch-light above the item. level.js pulses material.opacity
// (0.15 … 0.75); the shader turns that into a brief twinkle, fades it out close up,
// lets it carry a little further through fog than the item itself, and never tints it
// towards the fog colour. It is depth-tested, so walls and bushes hide it.
function glintShader(sh) {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vGD;')
    .replace('vec4 mvPosition = modelViewMatrix[ 3 ];', `vec4 mvPosition = modelViewMatrix[ 3 ];
	float gD = length( mvPosition.xyz );
	vGD = gD;
	float gK = 1.0 - min( 0.35, gD * 0.4 ) / max( gD, 1e-4 );
	mvPosition.xyz *= gK;`)
    .replace('vec2 scale = vec2( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ) );',
      'vec2 scale = vec2( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ) ) * gK * ( 1.0 + 1.4 * clamp( ( gD - 3.0 ) / 22.0, 0.0, 1.0 ) );');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vGD;')
    .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `float gO = clamp( ( opacity - 0.15 ) / 0.6, 0.0, 1.0 );
	vec4 diffuseColor = vec4( diffuse, ( 0.22 + 0.78 * gO * gO ) * smoothstep( 1.2, 3.2, vGD ) );`)
    .replace('#include <fog_fragment>', `#ifdef USE_FOG
	#ifdef FOG_EXP2
		float gF = 1.0 - exp( - fogDensity * fogDensity * 0.3 * vFogDepth * vFogDepth );
	#else
		float gF = smoothstep( fogNear, fogFar * 1.6, vFogDepth );
	#endif
	gl_FragColor.rgb *= 1.0 - gF;
#endif`);
}
let GLINT_TEX = null;
function glintTex() {
  if (GLINT_TEX) return GLINT_TEX;
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.1, 'rgba(255,250,236,0.8)'); gr.addColorStop(0.3, 'rgba(255,240,214,0.2)'); gr.addColorStop(1, 'rgba(255,240,214,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter';
  for (const [w, h] of [[S * 0.9, 1.4], [1.4, S * 0.62]]) {
    const l = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, Math.max(w, h) / 2);
    l.addColorStop(0, 'rgba(255,248,230,0.55)'); l.addColorStop(1, 'rgba(255,248,230,0)');
    g.fillStyle = l; g.fillRect(S / 2 - w / 2, S / 2 - h / 2, w, h);
  }
  GLINT_TEX = new THREE.CanvasTexture(c); GLINT_TEX.colorSpace = THREE.SRGBColorSpace;
  return GLINT_TEX;
}
/** A fresh glint material per pickup (level.js animates each one's opacity); they share texture and program. */
function glintMaterial() {
  const m = new THREE.SpriteMaterial({ map: glintTex(), color: 0xfff0d4, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
  m.onBeforeCompile = glintShader; m.customProgramCacheKey = () => 'pickup-glint-1';
  return m;
}

// ───────────────────────────── builder ─────────────────────────────
const _c = new THREE.Color(), _base = new THREE.Color(), _wc = new THREE.Color();
let _seed = 1;
const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

/** Per-triangle markings: the best of the mark specs by weight; fills out[9] = (u, v, w) × 3. */
const _mt = new Float32Array(9);
function markTri(marks, P, N, i, out) {
  let bw = 0.001; out.fill(0);
  for (const mk of marks) {
    const R = REG[mk.id]; let w = 0;
    if (mk.type === 'cyl') {
      const a = mk.a, r0 = mk.r0, r1 = mk.r1, ang = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const q = i + k * 3, dx = P[q] - mk.o[0], dy = P[q + 1] - mk.o[1], dz = P[q + 2] - mk.o[2];
        let an = Math.atan2(dx * r1.x + dy * r1.y + dz * r1.z, dx * r0.x + dy * r0.y + dz * r0.z); if (an < 0) an += TAU;
        ang[k] = an;
        const t = clamp01((dx * a.x + dy * a.y + dz * a.z) / mk.len + 0.5);
        const ww = mk.all ? 1 : 1 - sstep(0.45, 0.75, Math.abs(N[q] * a.x + N[q + 1] * a.y + N[q + 2] * a.z));
        _mt[k * 3 + 1] = t; _mt[k * 3 + 2] = ww; w += ww;
      }
      if (Math.max(...ang) - Math.min(...ang) > PI) for (let k = 0; k < 3; k++) if (ang[k] < PI) ang[k] += TAU;
      for (let k = 0; k < 3; k++) { const t = _mt[k * 3 + 1]; regionUV(R, ang[k] / TAU * (mk.turns || 1) % 1.2, t, _mt, k * 3); }
    } else {
      const n = mk.n;
      for (let k = 0; k < 3; k++) {
        const q = i + k * 3, dx = P[q] - mk.o[0], dy = P[q + 1] - mk.o[1], dz = P[q + 2] - mk.o[2];
        const s = clamp01((dx * mk.u.x + dy * mk.u.y + dz * mk.u.z) / mk.su + 0.5), t = clamp01((dx * mk.v.x + dy * mk.v.y + dz * mk.v.z) / mk.sv + 0.5);
        const ww = sstep(0.72, 0.9, N[q] * n.x + N[q + 1] * n.y + N[q + 2] * n.z);
        regionUV(R, s, t, _mt, k * 3); _mt[k * 3 + 2] = ww; w += ww;
      }
    }
    if (w > bw) { bw = w; out.set(_mt); }
  }
}
/** Normalise a mark spec (vectors, derived axes) once. */
function prepMark(mk) {
  if (mk._ok) return mk;
  const o = { ...mk, _ok: true, o: mk.o || [0, 0, 0] };
  if (mk.type === 'cyl') {
    o.a = V3(mk.axis).normalize(); o.r0 = V3(mk.ref).normalize(); o.r1 = new THREE.Vector3().crossVectors(o.a, o.r0).normalize();
  } else {
    o.u = V3(mk.u).normalize(); o.v = V3(mk.v).normalize(); o.n = new THREE.Vector3().crossVectors(o.u, o.v).normalize();
  }
  return o;
}
/** A mark spec seen through the matrix T (rigid). */
function xmark(mk, T) {
  const p = prepMark(mk), o = { ...p, o: V3(p.o).applyMatrix4(T).toArray() };
  const dir = (v) => v.clone().transformDirection(T);
  if (p.type === 'cyl') { o.a = dir(p.a); o.r0 = dir(p.r0); o.r1 = dir(p.r1); } else { o.u = dir(p.u); o.v = dir(p.v); o.n = dir(p.n); }
  return o;
}

/**
 * Accumulates primitives into one geometry. add(prim, surface, o):
 *   o.m        Matrix4 placing the primitive (mirrors handled)
 *   o.col      base colour (sRGB hex), or o.colFn(x, y, z, out) in the primitive's own coordinates
 *   o.wear     0..1 bare edges in o.wearCol; o.macro low-frequency colour variation
 *   o.crease   smoothing angle; o.grain detail grain axis ('x' | 'y' | 'z')
 *   o.rough / o.metal / o.det / o.scale override the surface
 *   o.mark     mark spec or list: { id, type: 'plane', o, u, v, su, sv } | { id, type: 'cyl', o, axis, ref, len, all? }
 */
class PB {
  constructor() { this.p = []; this.n = []; this.d = []; this.c = []; this.q = []; this.s = []; this.m = []; }
  add(pr, surf, o = {}) {
    const S = SURF[surf] || SURF.paint, src = pr.p, mt = o.m, P = new Float32Array(src.length);
    let L = src, W = pr.w;
    if (mt) {
      const e = mt.elements;
      for (let i = 0; i < src.length; i += 3) {
        const x = src[i], y = src[i + 1], z = src[i + 2];
        P[i] = e[0] * x + e[4] * y + e[8] * z + e[12]; P[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; P[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
      if (mt.determinant() < 0) { L = new Float32Array(src); W = W ? new Float32Array(W) : null; flipTris(P, W); flipTris(L, null); }
    } else P.set(src);
    const N = creaseNormals(P, o.crease ?? 34);
    const seed = _seed++, uo = h3(seed, 1, 2) * 3, vo = h3(seed, 3, 4) * 3, grain = o.grain || 'z';
    _base.set(o.col ?? 0x808080);
    if (o.wearCol !== undefined) _wc.set(o.wearCol);
    const wearK = o.wearCol !== undefined ? (o.wear ?? 0.5) : 0, macro = o.macro ?? 0.12;
    const marks = o.mark ? (Array.isArray(o.mark) ? o.mark : [o.mark]).map(prepMark) : null;
    const rough = o.rough ?? S.r, metal = o.metal ?? S.m, det = o.det ?? S.d, scale = o.scale ?? S.s, sel = S.sel, uvm = new Float32Array(9);
    for (let i = 0; i < P.length; i += 9) {
      const ux = L[i + 3] - L[i], uy = L[i + 4] - L[i + 1], uz = L[i + 5] - L[i + 2], vx = L[i + 6] - L[i], vy = L[i + 7] - L[i + 1], vz = L[i + 8] - L[i + 2];
      const ax = Math.abs(uy * vz - uz * vy), ay = Math.abs(uz * vx - ux * vz), az = Math.abs(ux * vy - uy * vx);
      let A, B;
      if (grain === 'z') { if (ax >= ay && ax >= az) { A = 2; B = 1; } else if (ay >= az) { A = 2; B = 0; } else { A = 0; B = 1; } }
      else if (grain === 'y') { if (ax >= ay && ax >= az) { A = 1; B = 2; } else if (az >= ay) { A = 1; B = 0; } else { A = 0; B = 2; } }
      else { if (ay >= ax && ay >= az) { A = 0; B = 2; } else if (az >= ax) { A = 0; B = 1; } else { A = 2; B = 1; } }
      if (marks) markTri(marks, P, N, i, uvm);
      for (let k = 0; k < 3; k++) {
        const q = i + k * 3, v = q / 3;
        this.p.push(P[q], P[q + 1], P[q + 2]); this.n.push(N[q], N[q + 1], N[q + 2]);
        this.d.push(L[q + A] + uo, L[q + B] + vo);
        if (o.colFn) o.colFn(L[q], L[q + 1], L[q + 2], _c); else _c.copy(_base);
        _c.multiplyScalar(1 + (noise3(P[q] * 28, P[q + 1] * 28, P[q + 2] * 28, seed & 63) - 0.5) * macro);
        if (wearK > 0 && W && W[v] > 0) _c.lerp(_wc, W[v] * wearK * (0.35 + 0.65 * sstep(0.25, 0.75, noise3(P[q] * 160, P[q + 1] * 160, P[q + 2] * 160, 7))));
        this.c.push(_c.r, _c.g, _c.b);
        this.q.push(rough, metal, det, scale);
        this.s.push(sel[0], sel[1], sel[2], sel[3]);
        this.m.push(uvm[k * 3], uvm[k * 3 + 1], uvm[k * 3 + 2]);
      }
    }
    return this;
  }
  /** Append an already built (indexed) geometry with AO in its colours: the guns. */
  addGeometry(geo, surf, o = {}) {
    const S = SURF[surf] || SURF.steel, P = geo.attributes.position.array, Nn = geo.attributes.normal.array, U = geo.attributes.uv.array, Cc = geo.attributes.color.array, I = geo.index.array;
    const tint = o.tint || [1, 1, 1];
    for (let j = 0; j < I.length; j++) {
      const v = I[j];
      this.p.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); this.n.push(Nn[v * 3], Nn[v * 3 + 1], Nn[v * 3 + 2]); this.d.push(U[v * 2], U[v * 2 + 1]);
      this.c.push(Cc[v * 3] * tint[0], Cc[v * 3 + 1] * tint[1], Cc[v * 3 + 2] * tint[2]);
      this.q.push(o.rough ?? S.r, o.metal ?? S.m, o.det ?? S.d, S.s); this.s.push(...S.sel); this.m.push(0, 0, 0);
    }
    return this;
  }
  /** Apply a matrix to everything added so far (positions and normals). */
  transform(T) {
    const e = new THREE.Matrix3().getNormalMatrix(T), v = new THREE.Vector3();
    for (let i = 0; i < this.p.length; i += 3) {
      v.set(this.p[i], this.p[i + 1], this.p[i + 2]).applyMatrix4(T); this.p[i] = v.x; this.p[i + 1] = v.y; this.p[i + 2] = v.z;
      v.set(this.n[i], this.n[i + 1], this.n[i + 2]).applyMatrix3(e).normalize(); this.n[i] = v.x; this.n[i + 1] = v.y; this.n[i + 2] = v.z;
    }
    return this;
  }
  bounds() {
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < this.p.length; i += 3) for (let k = 0; k < 3; k++) { const v = this.p[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    return [mn, mx];
  }
  /**
   * Weld, bake ambient occlusion and return { geo, min, max, tris }.
   * o.ground: centre on X/Z, rest on y = 0 and let the ground occlude too; o.sink lowers it a little after;
   * o.ao strength (0 = none, e.g. for the guns that bring their own); o.cell voxel size.
   */
  build(o = {}) {
    let [mn, mx] = this.bounds();
    if (o.ground || o.center) {
      const dx = -(mn[0] + mx[0]) / 2, dz = -(mn[2] + mx[2]) / 2, dy = o.ground ? -mn[1] : -(mn[1] + mx[1]) / 2;
      for (let i = 0; i < this.p.length; i += 3) { this.p[i] += dx; this.p[i + 1] += dy; this.p[i + 2] += dz; }
      [mn, mx] = this.bounds();
    }
    const nv = this.p.length / 3, aoK = o.ao ?? 0.8;
    let grid = null;
    if (aoK > 0) {
      const cell = o.cell ?? 0.003, pad = o.ground ? cell * 6 : 0;
      grid = new Occ([mn[0] - pad, mn[1], mn[2] - pad], [mx[0] + pad, mx[1], mx[2] + pad], cell);
      grid.mark(this.p);
      if (o.ground) {   // the ground is a slab below y = 0
        for (let k = 0; k < grid.nz; k++) for (let j = 0; j < grid.ny; j++) {
          if (grid.oy + (j + 0.5) * grid.c > -cell * 0.25) break;
          for (let i = 0; i < grid.nx; i++) grid.d[(k * grid.ny + j) * grid.nx + i] = 1;
        }
      }
    }
    const K = 22, rows = new Int32Array(nv * K);
    for (let v = 0; v < nv; v++) {
      const r = v * K;
      for (let k = 0; k < 3; k++) { rows[r + k] = Math.round(this.p[v * 3 + k] * 1e5); rows[r + 3 + k] = Math.round(this.n[v * 3 + k] * 1e3); rows[r + 6 + k] = Math.round(this.c[v * 3 + k] * 1e3); rows[r + 9 + k] = Math.round(this.m[v * 3 + k] * 1e4); }
      for (let k = 0; k < 2; k++) rows[r + 12 + k] = Math.round(this.d[v * 2 + k] * 1e4);
      for (let k = 0; k < 4; k++) { rows[r + 14 + k] = Math.round(this.q[v * 4 + k] * 1e3); rows[r + 18 + k] = Math.round(this.s[v * 4 + k] * 1e2); }
    }
    const { ids, first, count } = hashRows(rows, K, nv);
    const A = { position: [3, this.p], normal: [3, this.n], color: [3, this.c], uvm: [3, this.m], duv: [2, this.d], pbr: [4, this.q], sel: [4, this.s] };
    const g = new THREE.BufferGeometry();
    const out = {};
    for (const [name, [n]] of Object.entries(A)) out[name] = new Float32Array(count * n);
    for (let i = 0; i < count; i++) {
      const v = first[i];
      for (const [name, [n, src]] of Object.entries(A)) for (let k = 0; k < n; k++) out[name][i * n + k] = src[v * n + k];
      if (grid) {
        const P = out.position, Nn = out.normal;
        const occ = aoAt(grid, P[i * 3], P[i * 3 + 1], P[i * 3 + 2], Nn[i * 3], Nn[i * 3 + 1], Nn[i * 3 + 2], 8);
        const f = Math.max(0.22, 1 - aoK * Math.pow(occ, 0.85));
        out.color[i * 3] *= f; out.color[i * 3 + 1] *= f; out.color[i * 3 + 2] *= f;
      }
    }
    if (o.sink) for (let i = 0; i < count; i++) out.position[i * 3 + 1] -= o.sink;
    for (const [name, [n]] of Object.entries(A)) g.setAttribute(name, new THREE.BufferAttribute(out[name], n));
    const index = count > 65535 ? new Uint32Array(nv) : new Uint16Array(nv);
    for (let v = 0; v < nv; v++) index[v] = ids[v];
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return { geo: g, min: mn, max: mx, tris: nv / 3 };
  }
}
/** Everything added through the returned builder is placed by T (marks too). */
function under(pb, T) {
  return {
    add(pr, surf, o = {}) { return pb.add(pr, surf, { ...o, m: o.m ? T.clone().multiply(o.m) : T, mark: o.mark ? (Array.isArray(o.mark) ? o.mark : [o.mark]).map((k) => xmark(k, T)) : undefined }); },
  };
}

// matrices
const M4 = () => new THREE.Matrix4();
const Tr = (x, y, z) => M4().makeTranslation(x, y, z);
const Rx = (a) => M4().makeRotationX(a), Ry = (a) => M4().makeRotationY(a), Rz = (a) => M4().makeRotationZ(a);
const mul = (...ms) => ms.reduce((a, b) => a.multiply(b), M4());
/** Loft along +X: stations [x, w (along z), h (along y), r?]; centre line at (y, z). */
function slabX(st, cy, cz, o = {}) {
  return loft(st.map(([x, w, h, r, yy, zz]) => ({ c: [x, yy ?? cy, zz ?? cz], w, h, r: r ?? o.r ?? 0.002 })), { cap0: o.cap0 ?? 'round', cap1: o.cap1 ?? 'round', capD: o.capD ?? 0.002, cseg: o.cseg ?? 3, sseg: o.sseg ?? 0, disp: o.disp });
}
/** Closed cylinder along +Y from y0, radius r. */
const cylY = (r, y0, h, at = [0, 0, 0], seg = 12) => lathe([[0, 0], [r, 0], [r, h], [0, h]], { seg, axis: 'y', at: [at[0], at[1] + y0, at[2]] });
/** Loft along a polyline path with a rounded-rectangle section w × h (h along `up`). */
const strap = (pts, w, h, r, o = {}) => loft(pts.map((c, i) => ({ c, w: o.ws ? o.ws[i] : w, h, r, up: o.ups ? o.ups[i] : undefined })), { up: o.up || [0, 1, 0], cap0: o.cap0 ?? 'flat', cap1: o.cap1 ?? 'flat', cseg: o.cseg ?? 2, sseg: o.sseg ?? 0 });

// ───────────────────────────── items ─────────────────────────────
/** Lever, safety pin and ring of a grenade fuze on top of a body (fuze axis +Y, top of the body at y0, body radius at the lever rB(y)). */
function fuze(S, y0, rB, o = {}) {
  const st = o.steel ?? 0x666a62;
  S.add(lathe([[0, 0], [0.0098, 0], [0.0098, 0.007], [0.0088, 0.0085], [0.0088, 0.012]], { seg: 14, axis: 'y', at: [0, y0, 0] }), 'paint', { col: st, wear: 0.6, wearCol: 0xa6a8a0 });
  S.add(lathe([[0.0088, 0.0], [0.0108, 0.0005], [0.0108, 0.017], [0.0092, 0.0205], [0.004, 0.022], [0, 0.0222]], { seg: 14, axis: 'y', at: [0, y0 + 0.011, 0] }), 'paint', { col: st, wear: 0.6, wearCol: 0xa6a8a0 });
  const yt = y0 + 0.033, len = o.lever ?? 0.075;
  // lever ("spoon"): over the fuze top, then down the side of the body
  const pts = [[0.0, yt + 0.0003, 0], [0.006, yt + 0.0006, 0], [0.0105, yt - 0.0005, 0], [0.0128, yt - 0.006, 0], [0.013, y0 + 0.006, 0]];
  const ups = [[0, 1, 0], [0, 1, 0], [0.6, 0.8, 0], [1, 0.1, 0], [1, 0, 0]];
  for (let i = 1; i <= 5; i++) { const y = y0 - len * i / 5; pts.push([rB(y) + 0.0016, y, 0]); ups.push([1, 0, 0]); }
  S.add(strap(pts, 0.0125, 0.0013, 0.0005, { ups, cseg: 1 }), 'paint', { col: o.lever ? 0x5b6046 : st, wear: 0.7, wearCol: 0xa0a29a, crease: 40 });
  // pin through the fuze head, ring hanging off its end
  S.add(lathe([[0, -0.015], [0.0011, -0.015], [0.0011, 0.016], [0, 0.0162]], { seg: 6, axis: 'z', at: [0, y0 + 0.024, 0] }), 'bright', { col: 0x9a9c98 });
  S.add(torus(0.0115, 0.0012, 16, 5), 'bright', { col: 0x8c8e8a, m: mul(Tr(-0.004, y0 + 0.017, -0.0285), Ry(0.35), Rx(0.15)) });
}

/** F-1 pattern fragmentation grenade: segmented cast body, UZRGM fuze. Fuze up, origin at the centre. */
function fragModel(S) {
  const H = 0.086, rb = (f) => 0.0285 * Math.pow(Math.max(0, Math.sin(PI * (f + 0.004) / (H + 0.01))), 0.7);
  const fs = [0, 0.004, 0.009, 0.0125, 0.016, 0.023, 0.0265, 0.03, 0.037, 0.0405, 0.044, 0.051, 0.0545, 0.058, 0.065, 0.0685, 0.072, 0.078, 0.082, 0.086];
  const grooves = new Set([3, 6, 9, 12, 15]);
  const prof = (th, i) => {
    const col = i % 3 === 0 ? 0.0022 : 0;
    const out = [[0, 0]];
    fs.forEach((f, j) => {
      const r = Math.max(0.009, rb(f)), edge = f < 0.008 || f > 0.078;
      out.push([Math.max(0.008, r - (edge ? 0 : (grooves.has(j) ? 0.0024 : 0) + col)), f]);
    });
    out.push([0.0098, H + 0.001], [0, H + 0.001]);
    return out;
  };
  // revolve runs along −z; turn it so the fuze points up and the centre of the body sits at the origin
  const T = mul(Tr(0, -0.045, 0), Rx(PI / 2));
  S.add(revolve(prof, 24), 'paint', { col: 0x4b5237, wear: 0.55, wearCol: 0x6d6f62, crease: 50, m: T });
  fuze(S, H - 0.045, (y) => Math.max(0.0115, rb(y + 0.045)), { lever: 0.07 });
}

/** Cylindrical smoke / flash canister with a fuze, markings round the body. Fuze up, origin at the centre. */
function canisterModel(S, kind) {
  const smoke = kind === 'smoke', r = smoke ? 0.031 : 0.0285, H = smoke ? 0.118 : 0.11, y0 = -H / 2;
  const body = smoke ? 0x5a6350 : 0x3a3d3d;
  S.add(lathe([[0, 0], [r - 0.0025, 0], [r, 0.0025], [r, 0.006], [r - 0.0007, 0.0075], [r - 0.0007, H - 0.0075], [r, H - 0.006], [r, H - 0.0025], [r - 0.0025, H], [0.012, H], [0, H + 0.0004]], { seg: 22, axis: 'y', at: [0, y0, 0] }), 'paint',
    { col: body, wear: 0.6, wearCol: 0x8a8c84, crease: 40,
      mark: [{ id: smoke ? 'smoke' : 'flash', type: 'cyl', o: [0, smoke ? 0.0 : 0.002, 0], axis: [0, 1, 0], ref: [0, 0, 1], len: smoke ? 0.098 : 0.085 },
        ...(smoke ? [{ id: 'smokeTop', type: 'plane', o: [0, H / 2, 0], u: [1, 0, 0], v: [0, 0, -1], su: 0.05, sv: 0.05 }] : [])] });
  fuze(S, H / 2, () => r, { lever: smoke ? 0.08 : 0.075 });
}

/** A rounded field stone (seeded). */
function stoneModel(S, seed = 0, k = 1, m = null) {
  const pr = { p: KIT.trisOf(new THREE.IcosahedronGeometry(1, 2)), w: null };
  mapP(pr.p, (x, y, z, o) => {
    const l = Math.hypot(x, y, z), nx = x / l, ny = y / l, nz = z / l;
    const r = 1 + (noise3(nx * 1.8 + seed, ny * 1.8, nz * 1.8, 5 + seed) - 0.5) * 0.5 + (noise3(nx * 4.5, ny * 4.5 + seed, nz * 4.5, 9) - 0.5) * 0.12;
    o[0] = nx * r * 0.036 * k; o[1] = ny * r * 0.023 * k; o[2] = nz * r * 0.03 * k;
  });
  const a = new THREE.Color(0x7a766c), b = new THREE.Color(0x58544c);
  S.add(pr, 'stone', { m, crease: 70, macro: 0.25, colFn: (x, y, z, out) => out.copy(a).lerp(b, sstep(0.35, 0.7, noise3(x * 60 + seed, y * 60, z * 60, 3))) });
}

/** Throwing knife: one-piece spear-point blade, paracord-wrapped handle, lanyard hole. Blade along −Z, flats facing ±X, origin at the balance point. */
function tknifeModel(S, m0 = null) {
  const M = (m) => (m0 ? m0.clone().multiply(m) : m);
  const hole = []; for (let i = 0; i < 10; i++) { const a = -i / 10 * TAU; hole.push([-0.089 + Math.cos(a) * 0.0042, Math.sin(a) * 0.0042]); }
  const out = [[-0.1, -0.0085, 0.005], [-0.006, -0.0085], [0.004, -0.0118, 0.002], [0.06, -0.0138, 0.03], [0.142, 0.0, 0.0008], [0.06, 0.0138, 0.03], [0.004, 0.0118, 0.002], [-0.006, 0.0085], [-0.1, 0.0085, 0.005]];
  const steel = new THREE.Color(0x5e6267), edge = new THREE.Color(0xb2b6ba);
  S.add(side(out, 0.0042, { holes: [hole], bevel: 0.0016, seg: 2 }), 'steel', { m: M(Tr(0, 0, 0.03)), crease: 30, grain: 'z', wear: 0.5, wearCol: 0xc4c8cc,
    colFn: (x, y, z, o) => { const f = -z, half = f < 0 ? 0.0085 : f < 0.06 ? lerp(0.0118, 0.0138, f / 0.06) : lerp(0.0138, 0, (f - 0.06) / 0.082); o.copy(steel).lerp(edge, f > 0.002 ? sstep(0.55, 0.95, Math.abs(y) / Math.max(1e-4, half)) : 0); } });
  // paracord wrap: ridged turns along the handle
  const st = [];
  for (let i = 0; i <= 30; i++) { const f = lerp(-0.094, -0.012, i / 30), rid = i % 2 ? 0.0009 : 0; st.push({ c: [0, 0, -f + 0.03], w: 0.0098 + rid, h: 0.0205 + rid, r: 0.0045 }); }
  S.add(loft(st, { cap0: 'round', cap1: 'round', capD: 0.003, cseg: 3 }), 'cord', { m: M(M4()), col: 0x23251f, crease: 60, macro: 0.08 });
}

/** Demolition charge: wrapped block, two tape bands, detonator, wire, receiver. Bottom face at y = −0.03 (it is stuck to a surface along +Y). */
function c4Model(S) {
  const yb = -0.03, h = 0.042, cy = yb + h / 2;
  const blk = slabX([[-0.086, 0.088, h, 0.005], [-0.03, 0.09, h, 0.005], [0.03, 0.09, h, 0.005], [0.086, 0.088, h, 0.005]], cy, 0, { cseg: 3, sseg: 3, capD: 0.004 });
  mapP(blk.p, (x, y, z, o) => { const n = (noise3(x * 90, y * 90, z * 90, 4) - 0.5) * 0.0016; o[0] = x; o[1] = y + (y > cy ? n : 0); o[2] = z + n * 0.5; });
  S.add(blk, 'film', { col: 0x5b5f45, crease: 45, macro: 0.1, mark: { id: 'c4', type: 'plane', o: [0.012, yb + h, 0], u: [1, 0, 0], v: [0, 0, -1], su: 0.15, sv: 0.075 } });
  for (const x of [-0.062, 0.052]) S.add(slabX([[x - 0.011, 0.0915, h + 0.0016, 0.0055], [x + 0.011, 0.0915, h + 0.0016, 0.0055]], cy, 0, { cap0: 'flat', cap1: 'flat', cseg: 3 }), 'plastic', { col: 0x2c2d27, rough: 0.75, crease: 45 });
  // detonator in the +X end, wire to the receiver on top
  const dm = mul(Tr(0.08, cy + 0.004, 0.018), Rz(-0.35), Ry(PI / 2));
  S.add(lathe([[0, 0], [0.0036, 0], [0.0036, 0.046], [0.0028, 0.049], [0, 0.0495]], { seg: 10 }), 'alu', { m: dm, col: 0xb6b8b4, crease: 40 });
  S.add(lathe([[0.0016, 0.049], [0.0016, 0.056]], { seg: 6 }), 'rubber', { m: dm, col: 0x6a1a14 });
  const wire = [[0.126, cy + 0.024, 0.018], [0.13, cy + 0.034, 0.016], [0.118, yb + h + 0.012, 0.012], [0.08, yb + h + 0.008, 0.008], [0.046, yb + h + 0.009, 0.004], [0.03, yb + h + 0.01, 0.002]];
  S.add(strap(wire, 0.0024, 0.0024, 0.0012, { cseg: 2 }), 'plastic', { col: 0x6a1a14, crease: 60 });
  S.add(rbox(-0.006, yb + h + 0.0095, -0.006, 0.05, 0.019, 0.036, 0.004), 'plastic', { col: 0x1f2020, crease: 40, rough: 0.6, wear: 0.4, wearCol: 0x4a4b48,
    mark: { id: 'rx', type: 'plane', o: [-0.006, yb + h + 0.019, -0.006], u: [1, 0, 0], v: [0, 0, -1], su: 0.045, sv: 0.0315 } });
  S.add(lathe([[0, 0], [0.0019, 0], [0.0016, 0.034], [0, 0.0345]], { seg: 6, axis: 'y' }), 'rubber', { m: mul(Tr(-0.027, yb + h + 0.017, -0.019), Rz(0.5)), col: 0x1a1a1a });
}

/** Ejected case (bottle-necked, open mouth, primer), along Z, origin at its middle. */
function shellModel(S) {
  S.add(lathe([[0, 0.0003], [0.0015, 0.0003], [0.0016, 0], [0.0049, 0], [0.0049, 0.0012], [0.0041, 0.0016], [0.0041, 0.0028], [0.0049, 0.0032], [0.0046, 0.0175], [0.0037, 0.0198], [0.0037, 0.0242], [0.0031, 0.0242], [0.0031, 0.019]], { seg: 10 }),
    'brass', { col: 0xb48a42, m: Tr(0, 0, 0.012), crease: 40, macro: 0.06 });
}

// ───────────────────────────── pickups ─────────────────────────────
/** 7.62×39 round along −Z from its base at the origin. */
function cartridge(S, m) {
  S.add(lathe([[0, 0.0004], [0.0017, 0.0004], [0.0018, 0], [0.0056, 0], [0.0056, 0.0014], [0.0047, 0.0019], [0.0047, 0.0032], [0.0056, 0.0037], [0.0052, 0.029], [0.0043, 0.0325], [0.0043, 0.0386]], { seg: 9 }), 'brass', { m, col: 0xb8893e, macro: 0.06, crease: 40 });
  S.add(lathe([[0.0043, 0.0384], [0.0039, 0.0386], [0.0039, 0.042], [0.0034, 0.048], [0.0022, 0.053], [0.0008, 0.0558], [0, 0.0562]], { seg: 9 }), 'brass', { m, col: 0x8f5532, crease: 50 });
}

/** Steel ammunition tin: hinged lid with gasket, folding carry handle, cam latch, stencils; two loose rounds beside it. */
function ammoTin(S) {
  const OD = 0x4b5233, W = { wear: 0.75, wearCol: 0x85867a }, L = 0.29, D = 0.145, Hb = 0.158;
  const side = (s) => ({ id: 'ammoSide', type: 'plane', o: [0, 0.074, s * D / 2], u: [s, 0, 0], v: [0, 1, 0], su: 0.23, sv: 0.115 });
  const xs = (n, a, b) => Array.from({ length: n + 1 }, (_, i) => lerp(a, b, i / n));
  S.add(slabX(xs(6, -L / 2 + 0.006, L / 2 - 0.006).map((x) => [x, D, Hb, 0.007]), Hb / 2, 0, { capD: 0.006, sseg: 4 }), 'paint', { col: OD, ...W, grain: 'x', mark: [side(1), side(-1)] });
  for (const s of [-1, 1]) S.add(slabX([[-0.105, 0.0032, 0.085, 0.0012], [0.105, 0.0032, 0.085, 0.0012]], 0.074, s * (D / 2 + 0.0006), { capD: 0.0012, cseg: 2 }), 'paint', { col: OD, ...W, mark: side(s) });
  S.add(slabX([[-L / 2 + 0.003, D + 0.002, 0.005, 0.002], [L / 2 - 0.003, D + 0.002, 0.005, 0.002]], Hb + 0.0015, 0, { cap0: 'flat', cap1: 'flat', cseg: 2 }), 'rubber', { col: 0x1c1d1a });
  const ly = Hb + 0.0035 + 0.0115;
  S.add(slabX(xs(4, -L / 2 + 0.004, L / 2 - 0.004).map((x) => [x, D + 0.005, 0.023, 0.006]), ly, 0, { capD: 0.005, sseg: 3 }), 'paint', { col: OD, ...W, grain: 'x',
    mark: { id: 'ammoLid', type: 'plane', o: [0, ly + 0.0115, 0], u: [1, 0, 0], v: [0, 0, -1], su: 0.24, sv: 0.12 } });
  const top = ly + 0.0115;
  // hinge along the −X end
  S.add(lathe([[0, -0.052], [0.0045, -0.052], [0.0045, 0.052], [0, 0.052]], { seg: 10, at: [-L / 2 - 0.0035, Hb + 0.006, 0] }), 'paint', { col: OD, ...W });
  for (const z of [-0.035, 0.035]) S.add(rbox(-L / 2 - 0.0015, Hb - 0.006, z, 0.003, 0.026, 0.028, 0.001), 'paint', { col: OD, ...W });
  // cam latch on the +X end
  S.add(rbox(L / 2 + 0.0035, Hb - 0.02, 0, 0.0045, 0.07, 0.052, 0.0018), 'paint', { col: OD, ...W, m: Rz(-0.04) });
  S.add(lathe([[0, -0.024], [0.0042, -0.024], [0.0042, 0.024], [0, 0.024]], { seg: 10, at: [L / 2 + 0.004, Hb + 0.014, 0] }), 'paint', { col: OD, ...W });
  S.add(rbox(L / 2 + 0.0025, 0.088, 0, 0.004, 0.016, 0.03, 0.0012), 'paint', { col: OD, ...W });
  // carry handle folded flat on the lid, pivots at ±0.07, rubber grip
  for (const x of [-0.07, 0.07]) S.add(rbox(x, top + 0.004, 0, 0.012, 0.008, 0.024, 0.002), 'paint', { col: OD, ...W });
  const hp = [[-0.07, 0], [-0.068, -0.02], [-0.058, -0.04], [-0.04, -0.048], [0.04, -0.048], [0.058, -0.04], [0.068, -0.02], [0.07, 0]].map(([x, z]) => [x, top + 0.004, z]);
  S.add(strap(hp, 0.009, 0.0045, 0.0018), 'paint', { col: OD, ...W, crease: 50 });
  S.add(slabX([[-0.036, 0.016, 0.009, 0.0042], [0.036, 0.016, 0.009, 0.0042]], top + 0.0045, -0.048, { capD: 0.003 }), 'rubber', { col: 0x1d1e1b, crease: 50 });
  // loose rounds
  cartridge(S, mul(Tr(0.185, 0.0056, 0.045), Ry(0.5), Tr(0, 0, 0.028)));
  cartridge(S, mul(Tr(0.17, 0.0056, -0.025), Ry(-1.1), Tr(0, 0, 0.028)));
}

/** A suppressor lying on its open cloth wrap, with a paper tag naming the gun it fits. */
function supPickup(S, kind) {
  const sp = SUPPRESSORS[kind], len = sp.f1 - sp.f0;
  const col = { pistol: 0x7d6c4e, akm: 0x50553d, svd: 0x4a5047 }[kind], CL = len + 0.1, CW = kind === 'pistol' ? 0.1 : 0.115, th = 0.0035;
  const xs = Array.from({ length: 11 }, (_, i) => lerp(-CL / 2, CL / 2, i / 10));
  const sheet = slabX(xs.map((x) => [x, CW, th, 0.0013]), th / 2, 0, { cap0: 'flat', cap1: 'flat', cseg: 2, sseg: 6 });
  const wave = (x, z) => 0.0011 * (Math.sin(x * 41 + z * 17) * 0.6 + Math.sin(x * 13 - z * 29) * 0.4 + 1);
  mapP(sheet.p, (x, y, z, o) => { o[0] = x; o[1] = y + wave(x, z); o[2] = z; });
  S.add(sheet, 'cloth', { col, crease: 50 });
  for (const s of [-1, 1]) {   // hems
    const hem = slabX(xs.map((x) => [x, 0.007, th + 0.0016, 0.0012]), th / 2, s * (CW / 2 - 0.0035), { cap0: 'flat', cap1: 'flat', cseg: 2 });
    mapP(hem.p, (x, y, z, o) => { o[0] = x; o[1] = y + wave(x, z); o[2] = z; });
    S.add(hem, 'cloth', { col, crease: 50, macro: 0.08 });
  }
  // the rest of the wrap rolled up at −X, with two ties
  S.add(lathe([[0.004, -CW / 2], [0.013, -CW / 2 + 0.001], [0.0138, -CW / 2 + 0.004], [0.0138, CW / 2 - 0.004], [0.013, CW / 2 - 0.001], [0.004, CW / 2], [0.0038, -CW / 2]], { seg: 14, at: [-CL / 2 - 0.006, 0.0138, 0] }), 'cloth', { col, crease: 40 });
  for (const z of [-CW / 2 + 0.025, CW / 2 - 0.025]) S.add(strap([[-CL / 2 - 0.012, 0.027, z], [-CL / 2 + 0.006, 0.013, z + 0.002], [-CL / 2 + 0.03, th + 0.001, z + 0.006], [-CL / 2 + 0.07, th + 0.0009, z + 0.012]], 0.009, 0.0014, 0.0005), 'web', { col: 0x2b2c25, crease: 45 });
  // the can itself (the view model's shape), bore along X
  const cm = mul(Tr(0.006, th + sp.r + 0.0004, -0.006), Ry(-PI / 2 + 0.06), Tr(0, 0, (sp.f0 + sp.f1) / 2));
  S.add(revolve(sp.prof, 22), 'steel', { m: cm, col: sp.col, wear: 0.45, wearCol: 0x8a8e92, rough: 0.5, metal: 0.7 });
  // tag
  const tag = { svd: 'tagSvd', akm: 'tagAkm', pistol: 'tagPm' }[kind];
  const tz = CW / 2 - 0.022, tx = CL / 2 - 0.04;
  S.add(rbox(0, 0, 0, 0.046, 0.0011, 0.027, 0.0005), 'paper', { col: 0xc9b183, m: mul(Tr(tx, th + 0.0021, tz), Ry(0.35)),
    mark: { id: tag, type: 'plane', o: [tx, th + 0.0027, tz], u: [Math.cos(0.35), 0, -Math.sin(0.35)], v: [-Math.sin(0.35), 0, -Math.cos(0.35)], su: 0.046, sv: 0.027 } });
  S.add(strap([[tx - 0.024, th + 0.0022, tz + 0.006], [tx - 0.05, th + 0.0022, tz - 0.004], [0.006 + len / 2 - 0.03, th + 0.004, -0.006 + sp.r]], 0.0014, 0.0012, 0.0005), 'cord', { col: 0x8a7a5a });
}

/** Cleaning and repair kit: open canvas roll with a pocket, tools under elastic loops, gun oil, patches. */
function repairKit(S) {
  const CL = 0.28, CW = 0.18, th = 0.003, col = 0x5a5c43;
  const xs = Array.from({ length: 9 }, (_, i) => lerp(-CL / 2, CL / 2, i / 8));
  S.add(slabX(xs.map((x) => [x, CW, th, 0.0012]), th / 2, 0, { cap0: 'flat', cap1: 'flat', cseg: 2, sseg: 6 }), 'cloth', { col, crease: 50 });
  S.add(slabX(xs.map((x) => [x, 0.055, 0.0045, 0.0015]), 0.0035, CW / 2 - 0.028, { cap0: 'flat', cap1: 'flat', cseg: 2, sseg: 3 }), 'cloth', { col: 0x535540, crease: 50, macro: 0.08 });   // pocket
  S.add(lathe([[0.004, -CW / 2], [0.014, -CW / 2 + 0.001], [0.0145, -CW / 2 + 0.004], [0.0145, CW / 2 - 0.004], [0.014, CW / 2 - 0.001], [0.004, CW / 2], [0.0038, -CW / 2]], { seg: 14, at: [CL / 2 + 0.008, 0.0145, 0] }), 'cloth', { col, crease: 40 });
  const loop = (x, z, r) => S.add(strap([[x - 0.006, th, z - r - 0.004], [x, th + r * 1.5, z - r * 0.7], [x, th + r * 2 + 0.0015, z], [x, th + r * 1.5, z + r * 0.7], [x + 0.006, th, z + r + 0.004]], 0.011, 0.0014, 0.0005, { up: [1, 0, 0] }), 'web', { col: 0x24251f });
  // cleaning rod section
  const rodM = mul(Tr(0, th + 0.003, -0.06), Ry(PI / 2));
  S.add(lathe([[0, -0.115], [0.0029, -0.115], [0.003, 0.105], [0.0024, 0.11], [0.0024, 0.118], [0, 0.119]], { seg: 8 }), 'steel', { m: rodM, col: 0x8d9195, wear: 0.4, wearCol: 0xc0c4c8 });
  loop(-0.06, -0.06, 0.003); loop(0.07, -0.06, 0.003);
  // bore brush
  const brM = mul(Tr(-0.01, th + 0.0062, -0.028), Ry(PI / 2));
  S.add(lathe([[0, -0.06], [0.0024, -0.06], [0.0024, 0.03], [0, 0.031]], { seg: 8 }), 'brass', { m: brM, col: 0x8a7240 });
  S.add(revolve((th2, i) => { const b = i % 2 ? 0.0006 : 0; return [[0.0025, 0.03], [0.0058 + b, 0.0315], [0.0062 + b, 0.04], [0.0062 + b, 0.056], [0.0045, 0.06], [0, 0.0605]]; }, 18), 'brass', { m: mul(brM, Ry(PI), Tr(0, 0, 0.0)), col: 0x7a5f34, rough: 0.7, metal: 0.6 });
  loop(-0.05, -0.028, 0.0065);
  // combination screwdriver: plastic handle with flutes, steel shank
  const sdM = mul(Tr(0.0, th + 0.0095, 0.006), Ry(PI / 2 + 0.03));
  S.add(revolve((a) => { const fl = Math.cos(a * 8) > 0.6 ? -0.0011 : 0; return [[0, -0.07], [0.006, -0.0695], [0.0088 + fl, -0.066], [0.0092 + fl, -0.03], [0.0095 + fl, -0.012], [0.0078, -0.004], [0.004, 0]]; }, 24), 'plastic', { m: sdM, col: 0x6b2a1d, crease: 40, wear: 0.3, wearCol: 0x8a4a38 });
  S.add(lathe([[0.0026, -0.001], [0.0026, 0.055], [0.0016, 0.062], [0.0006, 0.063], [0, 0.063]], { seg: 8 }), 'steel', { m: sdM, col: 0x9a9ea2 });
  loop(-0.035, 0.006, 0.0095);
  // drift punch
  S.add(lathe([[0, -0.045], [0.0042, -0.045], [0.0042, 0.005], [0.0018, 0.018], [0.0018, 0.045], [0, 0.046]], { seg: 8 }), 'steel', { m: mul(Tr(0.02, th + 0.0042, 0.034), Ry(PI / 2)), col: 0x7b7f84, wear: 0.4, wearCol: 0xb8bcc0 });
  loop(0.01, 0.034, 0.0042);
  // patches
  for (let i = 0; i < 3; i++) S.add(rbox(0.095 + i * 0.002, th + 0.002 + i * 0.0025, 0.052 - i * 0.002, 0.042, 0.0022, 0.042, 0.0008), 'paper', { col: 0xd6d0bd, m: Ry(i * 0.15) });
  // gun oil, standing in the corner
  const ob = [-0.098, th, 0.052];
  S.add(lathe([[0, 0], [0.0165, 0], [0.0172, 0.003], [0.0172, 0.058], [0.0145, 0.066], [0.0075, 0.071], [0.0075, 0.075]], { seg: 18, axis: 'y', at: ob }), 'plastic', { col: 0x34452f, crease: 40,
    mark: { id: 'oil', type: 'cyl', o: [ob[0], ob[1] + 0.03, ob[2]], axis: [0, 1, 0], ref: [0, 0, 1], len: 0.036 } });
  S.add(revolve((a, i) => { const k = i % 2 ? 0.0004 : 0; return [[0.0082 + k, -0.0745], [0.0082 + k, -0.088], [0.0055, -0.0905], [0.002, -0.097], [0.0014, -0.104], [0, -0.1045]]; }, 16), 'plastic', { m: mul(Tr(ob[0], ob[1], ob[2]), Rx(-PI / 2)), col: 0x8e2a1c, crease: 40 });
}

/** Soft medical pouch lying on its back: puffed cordura, U-zip round the front panel, sewn cross patch, grab handle. */
function medkit(S) {
  const red = 0x7a2a24, W = 0.2, D = 0.135, H = 0.068;
  const bulge = (x, z) => 0.008 * (1 - Math.pow(x / (W / 2), 2)) * (1 - Math.pow(z / (D / 2), 2));
  const st = [];
  for (let i = 0; i <= 8; i++) { const x = lerp(-W / 2 + 0.012, W / 2 - 0.012, i / 8), e = 1 - 0.1 * Math.pow(Math.abs(x) / (W / 2), 6); st.push([x, D * e, H * e, 0.026]); }
  const body = slabX(st, H / 2, 0, { capD: 0.012, cseg: 4, sseg: 3 });
  mapP(body.p, (x, y, z, o) => { o[0] = x; o[1] = y + Math.max(0, bulge(x, z)) * (y / H) * 1.0; o[2] = z * (1 + 0.04 * Math.sin(PI * clamp01(y / H))); });
  S.add(body, 'cloth', { col: red, crease: 55, macro: 0.1 });
  const ty = (x, z) => H + Math.max(0, bulge(x, z));
  // U-zip: tape and teeth round the front panel
  const ax = 0.078, az = 0.04, rc = 0.018, path = [];
  const corner = (cx, cz, a0) => { for (let k = 0; k <= 4; k++) { const a = a0 + k / 4 * PI / 2; path.push([cx + Math.cos(a) * rc, cz + Math.sin(a) * rc]); } };
  corner(ax - rc, az - rc, 0); corner(-ax + rc, az - rc, PI / 2); corner(-ax + rc, -az + rc, PI); corner(ax - rc, -az + rc, 1.5 * PI);
  path.push(path[0]);
  S.add(strap(path.map(([x, z]) => [x, ty(x, z) + 0.0006, z]), 0.009, 0.0018, 0.0006), 'web', { col: 0x191a17, crease: 50,
    mark: { id: 'zip', type: 'cyl', o: [0, H, 0], axis: [0, 1, 0], ref: [0, 0, 1], len: 0.04, all: true } });
  // sliders and pulls at the front corner
  for (const [x, z, a] of [[ax - 0.004, -az + 0.012, 0.2], [ax - 0.012, -az + 0.003, 1.3]]) {
    S.add(rbox(0, 0, 0, 0.011, 0.0042, 0.007, 0.0015), 'steel', { col: 0x3c3e3e, m: mul(Tr(x, ty(x, z) + 0.0028, z), Ry(a)) });
    S.add(strap([[x, ty(x, z) + 0.003, z], [x + Math.cos(a) * 0.018, ty(x, z) + 0.0016, z - Math.sin(a) * 0.018], [x + Math.cos(a) * 0.03, ty(x, z) - 0.003, z - Math.sin(a) * 0.03]], 0.0045, 0.0025, 0.001), 'cord', { col: 0x1d1e1a });
  }
  // the patch: hook-and-loop field with a sewn cross on top
  S.add(rbox(-0.008, ty(0, 0) - 0.0003, 0.002, 0.074, 0.0016, 0.05, 0.0008), 'web', { col: 0x2a2b25 });
  S.add(rbox(-0.008, ty(0, 0) + 0.0009, 0.002, 0.052, 0.0012, 0.052, 0.003), 'cloth', { col: 0x4b5038, crease: 40,
    mark: { id: 'medFlap', type: 'plane', o: [-0.008, ty(0, 0) + 0.0015, 0.002], u: [1, 0, 0], v: [0, 0, -1], su: 0.052, sv: 0.052 } });
  // grab handle at −X
  S.add(strap([[-W / 2 + 0.004, H * 0.62, -0.02], [-W / 2 - 0.012, H * 0.6, -0.018], [-W / 2 - 0.02, H * 0.56, 0], [-W / 2 - 0.012, H * 0.6, 0.018], [-W / 2 + 0.004, H * 0.62, 0.02]], 0.016, 0.0025, 0.001), 'web', { col: 0x2b2c25 });
}

/** Two sealed field dressings, one on the other. */
function dressings(S) {
  const packet = (m) => {
    const st = [[-0.06, 0.07, 0.0028, 0.0012], [-0.054, 0.07, 0.0034, 0.0014], [-0.047, 0.068, 0.02, 0.008], [-0.036, 0.066, 0.029, 0.011], [0, 0.065, 0.031, 0.012], [0.036, 0.066, 0.029, 0.011], [0.047, 0.068, 0.02, 0.008], [0.054, 0.07, 0.0034, 0.0014], [0.06, 0.07, 0.0028, 0.0012]];
    const pr = slabX(st, 0.0155, 0, { cap0: 'flat', cap1: 'flat', cseg: 3, sseg: 2 });
    mapP(pr.p, (x, y, z, o) => { o[0] = x; o[1] = y < 0.0155 ? Math.max(y, 0.0155 - (0.0155 - y) * (Math.abs(x) > 0.05 ? 1 : 0.85)) : y; o[2] = z + (Math.abs(x) > 0.052 ? Math.sin(z * 900) * 0.0004 : 0); });
    S.add(pr, 'film', { m, col: 0x7b7556, crease: 45, macro: 0.1, mark: { id: 'dressing', type: 'plane', o: [0, 0.031, 0], u: [1, 0, 0], v: [0, 0, -1], su: 0.1, sv: 0.05 } });
  };
  packet(Tr(0, 0, 0));
  packet(mul(Tr(0.012, 0.0285, -0.006), Ry(0.42), Rz(0.025)));
}

/** Windlass tourniquet: strap loop on edge, rod in its housing, clip with a time tag, buckle, flat tail with a red tip. */
function tourniquet(S) {
  const a = 0.056, b = 0.036, H = 0.038, path = [], black = 0x1e1f1c;
  for (let i = 0; i <= 28; i++) { const t = i / 28 * TAU + 0.2; path.push([Math.cos(t) * a, H / 2, Math.sin(t) * b]); }
  S.add(strap(path, 0.0034, H, 0.0012, { cseg: 2 }), 'web', { col: black, crease: 50 });
  // windlass housing and rod on the +Z side
  S.add(rbox(0, H / 2, b + 0.004, 0.052, 0.03, 0.005, 0.002), 'plastic', { col: 0x262725, crease: 40, rough: 0.7 });
  S.add(rbox(0, H / 2 + 0.002, b + 0.0125, 0.104, 0.0095, 0.0115, 0.004), 'plastic', { col: 0x1b1c1b, crease: 40, rough: 0.65, wear: 0.3, wearCol: 0x4a4b48 });
  // clip on the −X end, white time tag on it
  const cm = mul(Tr(-a - 0.004, 0, 0), Ry(PI / 2));
  S.add(side([[0.0, 0.0, 0.002], [0.0, 0.034, 0.004], [-0.024, 0.034, 0.004], [-0.024, 0.026, 0.002], [-0.006, 0.026, 0.002], [-0.006, 0.008, 0.002], [-0.024, 0.008, 0.002], [-0.024, 0.0, 0.002]], 0.03, { bevel: 0.0012 }), 'plastic', { m: cm, col: 0x222321, crease: 40 });
  S.add(rbox(-a - 0.021, 0.0305, 0, 0.022, 0.0012, 0.026, 0.0004), 'paper', { col: 0xe2e0d8, mark: { id: 'tqTag', type: 'plane', o: [-a - 0.021, 0.031, 0], u: [0, 0, 1], v: [1, 0, 0], su: 0.026, sv: 0.013 } });
  // buckle on the +X end, tail through it, twisting flat onto the ground
  S.add(side([[0, 0, 0.002], [0.007, 0, 0.002], [0.007, 0.044, 0.002], [0, 0.044, 0.002]], 0.05, { holes: [[[0.002, 0.006], [0.005, 0.006], [0.005, 0.038], [0.002, 0.038]]], bevel: 0.001 }), 'plastic', { m: mul(Tr(a + 0.002, -0.003, 0), Ry(PI / 2), Tr(0, 0, 0)), col: 0x2a2b29, crease: 40 });
  const tail = [], ups = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10, x = a + 0.006 + t * 0.13, tw = sstep(0.05, 0.35, t);
    tail.push([x, lerp(H / 2, 0.0018, tw), 0.004 + Math.sin(t * 2.4) * 0.012]); ups.push([0, Math.cos(tw * PI / 2), -Math.sin(tw * PI / 2)]);
  }
  const red = new THREE.Color(0x8a1a14), blk = new THREE.Color(black);
  S.add(strap(tail, 0.0034, H, 0.0012, { ups, cseg: 2 }), 'web', { crease: 50, colFn: (x, y, z, o) => o.copy(x > a + 0.115 ? red : blk) });
}

/** Armour plate in a cordura cover: multi-curve, shooter's cut, label. Strike face up, edges on the ground. */
function plate(S) {
  const Lz = 0.31, W = 0.25, T = 0.024, st = [];
  for (let i = 0; i <= 12; i++) {
    const z = lerp(-Lz / 2, Lz / 2, i / 12), cut = Math.max(0, -z - (Lz / 2 - 0.06)), w = W - cut * 2 * (0.05 / 0.06);
    st.push({ c: [0, T / 2, z], w, h: T, r: 0.008 });
  }
  const pr = loft(st, { cap0: 'round', cap1: 'round', capD: 0.006, cseg: 3, sseg: 8 });
  mapP(pr.p, (x, y, z, o) => { o[0] = x; o[1] = y - x * x / (2 * 0.42) - z * z / (2 * 1.4); o[2] = z; });
  S.add(pr, 'cloth', { col: 0x7a684c, crease: 45, macro: 0.12, grain: 'z',
    mark: { id: 'plate', type: 'plane', o: [0, T, 0.08], u: [1, 0, 0], v: [0, 0, -1], su: 0.075, sv: 0.045 } });
}

/** Four AA cells with a paper band. */
function battery(S) {
  for (let i = 0; i < 4; i++) {
    const m = mul(Tr((i - 1.5) * 0.0143, 0.0071, 0), Tr(0, 0, 0.025));
    S.add(lathe([[0.0062, 0.0005], [0.0071, 0.0012], [0.0071, 0.0488], [0.0064, 0.0496]], { seg: 12 }), 'plastic', { m, crease: 40, colFn: (x, y, z, o) => o.set(-z > 0.04 ? 0xa9853c : 0x2b3a30) });
    S.add(lathe([[0, 0], [0.0062, 0], [0.0063, 0.0006]], { seg: 12 }), 'steel', { m, col: 0x9a9da0 });
    S.add(lathe([[0.0063, 0.0495], [0.0058, 0.0496], [0.0028, 0.0497], [0.0028, 0.0512], [0, 0.0513]], { seg: 12 }), 'steel', { m, col: 0xa4a7aa });
  }
  S.add(rbox(0, 0.0071, 0, 0.0592, 0.0152, 0.022, 0.003, { cseg: 2 }), 'paper', { col: 0xe0dccd, crease: 40,
    mark: { id: 'battery', type: 'plane', o: [0, 0.0147, 0], u: [1, 0, 0], v: [0, 0, -1], su: 0.058, sv: 0.022 } });
}

/** The gun lying on its left side (right side up), from weapon-models.js at ground detail. */
const GUN_SURF = { steel: 'steel', blued: 'blued', bright: 'bright', wood: 'wood', poly: 'plastic', grip: 'plastic', rubber: 'rubber', glass: 'glass', brass: 'brass', cloth: 'cloth', glove: 'rubber' };
function gunPickup(pb, id, sup) {
  const ww = buildWorldWeapon(id, { sup });
  const wood = id === 'svd' ? [0.27, 0.085, 0.042] : [0.24, 0.07, 0.034];   // laminate under varnish (the view-model wood texture's tone)
  for (const part of Object.values(ww.parts)) if (part) for (const { mat, geometry } of part) {
    pb.addGeometry(geometry, GUN_SURF[mat] || 'steel', mat === 'wood' ? { tint: wood } : mat === 'poly' ? { tint: [0.9, 0.9, 0.9] } : {});
    geometry.dispose();
  }
  pb.transform(mul(Ry(0.0), Rz(PI / 2 - 0.035)));
  // the ground darkens what rests on it
  return ww;
}

// ───────────────────────────── registry ─────────────────────────────
const lay = (pb) => pb;
/** Item builders (item space: origin at the centre). */
const ITEMS = {
  frag: (S) => fragModel(S),
  smoke: (S) => canisterModel(S, 'smoke'),
  flash: (S) => canisterModel(S, 'flash'),
  stone: (S) => stoneModel(S, 0),
  tknife: (S) => tknifeModel(S),
  c4: (S) => c4Model(S),
  shell: (S) => shellModel(S),
};
/** Pickup builders (ground space). */
const PICKUPS = {
  ammo: (pb) => ammoTin(pb),
  suppressor: (pb) => supPickup(pb, 'pistol'),
  akmsup: (pb) => supPickup(pb, 'akm'),
  svdsup: (pb) => supPickup(pb, 'svd'),
  repair: (pb) => repairKit(pb),
  medkit: (pb) => medkit(pb),
  bandage: (pb) => dressings(pb),
  tourniquet: (pb) => tourniquet(pb),
  plate: (pb) => plate(pb),
  battery: (pb) => battery(pb),
  frag: (pb) => fragModel(under(pb, mul(Rz(-PI / 2 + 0.1)))),
  smoke: (pb) => canisterModel(under(pb, Rz(-PI / 2)), 'smoke'),
  flash: (pb) => canisterModel(under(pb, Rz(-PI / 2)), 'flash'),
  c4: (pb) => c4Model(pb),
  stone: (pb) => { stoneModel(pb, 0, 1.15, Tr(0, 0, 0)); stoneModel(pb, 3.7, 0.85, mul(Tr(0.06, -0.004, 0.035), Ry(1.1), Rz(0.3))); },
  tknife: (pb) => tknifeModel(pb, mul(Rz(PI / 2), Rx(0.02))),
  crate: (pb) => { pb.add(rbox(0, 0.08, 0, 0.24, 0.16, 0.16, 0.006), 'paint', { col: 0x5a5a44, wear: 0.6, wearCol: 0x8a8a7a }); },
};
void lay;
export const PICKUP_TYPES = ['ammo', 'suppressor', 'akmsup', 'svdsup', 'repair', 'medkit', 'bandage', 'tourniquet', 'plate', 'battery', 'frag', 'smoke', 'flash', 'c4', 'stone', 'tknife', 'weapon_akm', 'weapon_ak74', 'weapon_svd'];
export const ITEM_KINDS = Object.keys(ITEMS);

const CACHE = new Map();
export const STATS = {};   // per key: { ms, tris } (dev viewer)

function pickupEntry(type, o = {}) {
  const key = type + (o.sup ? '+sup' : '');
  let e = CACHE.get(key);
  if (e) return e;
  const t0 = performance.now(), pb = new PB();
  let built;
  if (type.startsWith('weapon_')) {
    gunPickup(pb, type.slice(7), !!o.sup);
    built = pb.build({ ground: true, ao: 0, sink: 0.003 });
    groundShade(built.geo);
  } else {
    (PICKUPS[type] || PICKUPS.crate)(pb);
    built = pb.build({ ground: true, cell: type === 'plate' || type === 'repair' ? 0.004 : 0.003, sink: 0.002 });
  }
  const { min, max } = built;
  e = { geo: built.geo, glint: [(min[0] + max[0]) / 2, max[1] + 0.02, (min[2] + max[2]) / 2], size: Math.min(0.4, 0.22 + Math.max(max[0] - min[0], max[2] - min[2]) * 0.18), tris: built.tris };
  CACHE.set(key, e);
  STATS[key] = { ms: Math.round(performance.now() - t0), tris: built.tris };
  return e;
}
/** Contact darkening for geometry that brought its own AO (the guns): the lowest few centimetres. */
function groundShade(geo) {
  const P = geo.attributes.position.array, N = geo.attributes.normal.array, C = geo.attributes.color.array;
  for (let i = 0; i < P.length / 3; i++) {
    const y = P[i * 3 + 1] + 0.003, f = lerp(0.45, 1, sstep(0.0, 0.03, y)) * lerp(1, 0.75, clamp01(-N[i * 3 + 1]));
    C[i * 3] *= f; C[i * 3 + 1] *= f; C[i * 3 + 2] *= f;
  }
}

let _n = 0;
/**
 * A ground pickup: one mesh in the shared material, resting on y = 0, with a
 * glint sprite in userData.glow (level.js pulses its material's opacity).
 * o.sup: a gun with its suppressor fitted.
 */
export function buildPickupModel(type, o = {}) {
  const e = pickupEntry(type, o), mesh = new THREE.Mesh(e.geo, pickupMaterial());
  mesh.name = 'pickup_' + type;
  const k = ++_n;
  // lie naturally: a slight random tilt, and a yaw (level.js sets its own)
  mesh.rotation.set((h3(k, 1, 0) - 0.5) * 0.05, h3(k, 2, 0) * TAU, (h3(k, 3, 0) - 0.5) * 0.05);
  const glow = new THREE.Sprite(glintMaterial());
  glow.position.fromArray(e.glint); glow.scale.setScalar(e.size);
  glow.renderOrder = 2;
  mesh.add(glow);
  mesh.userData.glow = glow; mesh.userData.type = type;
  return mesh;
}

const ITEM_CACHE = new Map();
/** A thrown / held item or the ejected shell: one mesh in the shared material, origin at its centre. */
export function buildItemModel(kind) {
  let e = ITEM_CACHE.get(kind);
  if (!e) {
    const t0 = performance.now(), pb = new PB();
    (ITEMS[kind] || ((S) => S.add(rbox(0, 0, 0, 0.1, 0.1, 0.1, 0.004), 'paint', { col: 0x8a7a5a })))(pb);
    const b = pb.build({ center: kind !== 'c4' && kind !== 'frag' && kind !== 'smoke' && kind !== 'flash', cell: kind === 'shell' ? 0.0008 : 0.002, ao: kind === 'shell' ? 0.4 : 0.8 });
    e = { geo: b.geo, tris: b.tris };
    ITEM_CACHE.set(kind, e);
    STATS['item:' + kind] = { ms: Math.round(performance.now() - t0), tris: b.tris };
  }
  const m = new THREE.Mesh(e.geo, pickupMaterial());
  m.name = 'item_' + kind;
  return m;
}

/** Build every pickup and item now (dev viewer, warm-up). Returns the total milliseconds. */
export function prebuildAll() {
  const t0 = performance.now();
  pickupMaterial();
  for (const t of PICKUP_TYPES) pickupEntry(t);
  for (const k of ITEM_KINDS) buildItemModel(k);
  return Math.round(performance.now() - t0);
}
