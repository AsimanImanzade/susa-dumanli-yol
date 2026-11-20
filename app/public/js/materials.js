/**
 * materials.js — the world material factory.
 *
 * worldMaterial(texName, opts) → MeshStandardMaterial using the procedural
 * colour map, its matching normal map and its ORM map (cavity AO, roughness,
 * metalness) from textures.js. Vertex colours stay on because the static
 * batches and the terrain tint with them.
 *
 * Rain: render.js calls setWetness(0..1) from the act's rain amount; every
 * live world material lowers its roughness by a per-surface amount, so
 * cobbles and concrete pick up sheen from lamps and the sky while plaster
 * and leaves barely change.
 */
import * as THREE from 'three';
import { TEX, TEX_NORMAL, TEX_ORM } from './textures.js';

/** n: normal strength · ao: aoMap intensity · metal: use the ORM metalness · wet: how much rain smooths it */
const LOOK = {
  stone: { n: 1, ao: 0.9, wet: 0.5 }, plaster: { n: 0.9, ao: 0.8, wet: 0.25 }, cobble: { n: 1, ao: 1, wet: 1 },
  rock: { n: 1.1, ao: 0.9, wet: 0.5 }, forest: { n: 0.9, ao: 0.8, wet: 0.35 }, dirt: { n: 0.8, ao: 0.8, wet: 0.8 },
  roof: { n: 1, ao: 0.6, metal: true, wet: 0.6 }, wood: { n: 0.9, ao: 0.8, wet: 0.4 }, concrete: { n: 0.8, ao: 0.7, wet: 0.8 },
  metal: { n: 0.7, ao: 0.6, metal: true, wet: 0.6 }, cloth: { n: 0.7, ao: 0.6, wet: 0.2 }, dark: { n: 0.4, ao: 0.4, wet: 0.3 },
  bark: { n: 1, ao: 0.9, wet: 0.4 },
};
const live = new Set();
let wetness = 0;

function applyWet(m) { m.roughness = m.userData.baseRough * (1 - wetness * m.userData.wet * 0.5); }

/**
 * texName: a TEX key, or null for an untextured vertex-coloured surface.
 * opts: { side, roughness (base multiplier), normalScale, metalness }
 */
export function worldMaterial(texName, opts = {}) {
  const L = LOOK[texName] || {}, map = (texName && TEX[texName]) || null;
  // an image file from the manifest replaces the colour only; the procedural relief would not line up with it
  const proc = map && !map.userData.file;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, map, side: opts.side ?? THREE.FrontSide,
    roughness: opts.roughness ?? (map ? 1 : 0.72), metalness: opts.metalness ?? 0 });
  if (proc && TEX_ORM[texName]) {
    m.roughnessMap = m.aoMap = TEX_ORM[texName];
    m.aoMapIntensity = L.ao ?? 0.8;
    if (L.metal && opts.metalness === undefined) { m.metalnessMap = TEX_ORM[texName]; m.metalness = 1; }
  }
  if (proc && TEX_NORMAL[texName]) {
    m.normalMap = TEX_NORMAL[texName];
    const k = (L.n ?? 1) * (opts.normalScale ?? 1);
    m.normalScale.set(k, k);
  }
  m.userData.baseRough = m.roughness; m.userData.wet = L.wet ?? 0.5;
  applyWet(m);
  live.add(m);
  m.addEventListener('dispose', () => live.delete(m));
  return m;
}

/** 0 dry … 1 soaked; cheap (a uniform per material), safe to call every frame. */
export function setWetness(w) {
  if (Math.abs(w - wetness) < 0.01) return;
  wetness = w;
  for (const m of live) applyWet(m);
}
