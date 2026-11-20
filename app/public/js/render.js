/**
 * render.js — renderer, environment (fog, sky, night → dawn light, image-based
 * ambient), rain, pooled lamp lights, quality tiers with dynamic resolution,
 * and one post-processing pass.
 *
 * Frame: world → HDR render target (MSAA on Medium/High) → first-person view
 * model drawn on top with a cleared depth buffer (so the gun never pokes
 * through walls) → full-screen pass at canvas resolution: contrast-adaptive
 * sharpen (which also restores detail when the target is rendered below
 * canvas size), AgX tone mapping, then night vision, low-health blur, flash,
 * damage vignette and motion blur.
 */
import * as THREE from 'three';
import { G, clamp01, lerp } from './ctx.js';
import { TEX } from './textures.js';
import { createVmEnvironment } from './weapon-models.js';
import { setWetness } from './materials.js';

/**
 * dpr: cap on the canvas pixel ratio · scale: render-target size relative to
 * the canvas · samples: MSAA · shadowMap/shadowR: map size and half-width (m)
 * of the sun's shadow box · sharpen: CAS strength.
 */
const QUALITY = {
  low: { dpr: 1, scale: 0.75, samples: 0, shadows: false, shadowMap: 0, shadowR: 40, rain: 500, lamps: 2, far: 170, sharpen: 0.5 },
  medium: { dpr: 1.5, scale: 1, samples: 4, shadows: true, shadowMap: 1024, shadowR: 38, rain: 1100, lamps: 4, far: 230, sharpen: 0.35 },
  high: { dpr: 2, scale: 1, samples: 4, shadows: true, shadowMap: 2048, shadowR: 45, rain: 1800, lamps: 5, far: 300, sharpen: 0.3 },
};
const TIERS = ['low', 'medium', 'high'];
/** dynamic-resolution steps, multiplied onto the tier's scale */
const DYN = [1, 0.87, 0.75, 0.64];

const POST_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const POST_FS = `
precision highp float;
uniform sampler2D tScene; uniform sampler2D tPrev;
uniform float uNV, uBlur, uFlash, uDamage, uTime, uMotion, uDesat, uExposure, uVignette, uScope, uSharp, uSat;
uniform vec2 uTexel;
uniform vec3 uTint;
varying vec2 vUv;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
// contrast-adaptive sharpening (after AMD FidelityFX CAS): the limiter works on a
// compressed copy so HDR highlights do not switch it off; the weights apply to linear colour
vec3 cas(vec2 uv){
  vec3 c = texture2D(tScene, uv).rgb;
  if (uSharp <= 0.001) return c;
  vec3 a = texture2D(tScene, uv - vec2(0.0, uTexel.y)).rgb, b = texture2D(tScene, uv - vec2(uTexel.x, 0.0)).rgb;
  vec3 d = texture2D(tScene, uv + vec2(uTexel.x, 0.0)).rgb, e = texture2D(tScene, uv + vec2(0.0, uTexel.y)).rgb;
  vec3 mn = min(min(min(a, b), min(d, e)), c), mx = max(max(max(a, b), max(d, e)), c);
  mn /= 1.0 + mn; mx /= 1.0 + mx;
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
  vec3 w = -amp * mix(0.125, 0.2, uSharp);
  return max((c + (a + b + d + e) * w) / (1.0 + 4.0 * w), 0.0);
}
// AgX (Troy Sobotka's, as in three.js): keeps dark values close to linear, rolls highlights off instead of clipping
vec3 agxCurve(vec3 x){ vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }
vec3 agx(vec3 c){
  const mat3 toRec2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 fromRec2020 = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  c = inset * (toRec2020 * c);
  c = clamp((log2(max(c, vec3(1e-10))) + 12.47393) / 16.49999, 0.0, 1.0);
  c = outset * agxCurve(c);
  c = pow(max(c, vec3(0.0)), vec3(2.2));
  return clamp(fromRec2020 * c, 0.0, 1.0);
}
void main(){
  vec2 uv = vUv;
  vec3 c = cas(uv);
  if (uBlur > 0.001) {                      // radial blur: low health, concussion
    vec2 d = (uv - 0.5) * uBlur * 0.035;
    c = (c + texture2D(tScene, uv - d).rgb + texture2D(tScene, uv - d*2.0).rgb
           + texture2D(tScene, uv + d).rgb + texture2D(tScene, uv - d*3.0).rgb) / 5.0;
  }
  if (uMotion > 0.001) c = mix(c, texture2D(tPrev, uv).rgb, uMotion);
  c *= uExposure;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));     // scene light before tone mapping: the intensifier sees this
  // AgX toe sits below linear under ~0.02, which would crush the night acts; keep the darks linear (max() stays continuous)
  // (0.88: AgX lifts mid-tones ~12% over the old clamp; this keeps each act about as bright as it was)
  c *= 0.88;
  c = max(agx(c), min(c, vec3(0.1)));
  c = max(mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, uSat), 0.0);   // AgX desaturates; give a little back
  if (uNV > 0.001) {                        // image intensifier: gain, green phosphor, grain
    float g = pow(lum, 0.55) * 2.6 + 0.03;
    g += (hash(uv * 480.0 + uTime * 60.0) - 0.5) * 0.14;
    g *= 0.92 + 0.08 * sin(uv.y * 900.0);
    vec3 nv = vec3(0.12, 1.0, 0.24) * g;
    float tube = smoothstep(0.78, 0.5, length((uv - 0.5) * vec2(1.25, 1.0)));
    c = mix(c, nv * tube, uNV);
  }
  c = mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))), uDesat);
  c *= uTint;
  float r = length(uv - 0.5);
  c *= 1.0 - uVignette * smoothstep(0.35, 0.85, r);
  c = mix(c, vec3(0.45, 0.02, 0.02), uDamage * smoothstep(0.25, 0.8, r));
  c = mix(c, vec3(1.0), uFlash);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

const SKY_VS = `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position, 0.0); gl_Position = projectionMatrix * vec4(p.xyz, 1.0); gl_Position.z = gl_Position.w; }`;
const SKY_FS = `
precision highp float;
uniform vec3 uTop, uHorizon, uGlow, uSunDir; uniform float uGlowAmt;
varying vec3 vDir;
void main(){
  float h = clamp(vDir.y * 1.6 + 0.08, 0.0, 1.0);
  vec3 c = mix(uHorizon, uTop, pow(h, 0.6));
  float s = max(0.0, dot(normalize(vDir), normalize(uSunDir)));
  c += uGlow * (pow(s, 6.0) * 0.55 + pow(s, 60.0) * 0.9) * uGlowAmt * (1.0 - h * 0.6);
  gl_FragColor = vec4(c, 1.0);
}`;

/** Environment presets per act. Colours follow the style formula's palette. */
export const ENV = {
  forest: { sky: 0x0a0f14, horizon: 0x141c22, fog: 0x121a20, fogDensity: 0.036, ambient: 0x5a6c7c, ambientI: 0.62,
    sun: 0x8fa6c4, sunI: 0.42, sunDir: [0.4, 0.8, 0.3], glow: 0x000000, glowAmt: 0, light: 0.2, rain: 0, exposure: 1.15 },
  cliffs: { sky: 0x0b1118, horizon: 0x18222a, fog: 0x151e25, fogDensity: 0.024, ambient: 0x7186a0, ambientI: 1.0,
    sun: 0x9db2cc, sunI: 0.46, sunDir: [-0.3, 0.8, 0.4], glow: 0x000000, glowAmt: 0, light: 0.22, rain: 0, exposure: 1.15 },
  streets: { sky: 0x1b242c, horizon: 0x353f46, fog: 0x2e383f, fogDensity: 0.03, ambient: 0x8090a0, ambientI: 0.72,
    sun: 0xa9b8c8, sunI: 0.5, sunDir: [0.5, 0.6, -0.4], glow: 0x6a5a48, glowAmt: 0.25, light: 0.34, rain: 0.6, exposure: 1.1 },
  dawnStart: { sky: 0x2a3440, horizon: 0x5d5c5a, fog: 0x4a5055, fogDensity: 0.026, ambient: 0x93a0aa, ambientI: 0.8,
    sun: 0xd9b48c, sunI: 0.6, sunDir: [0.7, 0.22, -0.5], glow: 0xd8935a, glowAmt: 0.7, light: 0.5, rain: 0.25, exposure: 1.05 },
  dawnEnd: { sky: 0x5f7892, horizon: 0xd0a888, fog: 0x9b9a94, fogDensity: 0.011, ambient: 0xb8bcc0, ambientI: 0.95,
    sun: 0xffd2a0, sunI: 1.15, sunDir: [0.7, 0.42, -0.5], glow: 0xffb66e, glowAmt: 1.2, light: 0.85, rain: 0, exposure: 1.0 },
};

const _col = new THREE.Color(), _col2 = new THREE.Color(), _white = new THREE.Color(1, 1, 1);
const _rgt = new THREE.Vector3(), _up = new THREE.Vector3(), _p = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);

/**
 * World image-based ambient: a tiny equirect sky (zenith, horizon band, dark
 * ground, a soft glow where the sun or moon is) that three converts to PMREM.
 * Only hue and relative brightness are painted; the act's light level drives
 * scene.environmentIntensity, so nights stay dark.
 */
function createWorldEnvironment() {
  const W = 128, H = 64, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping; tex.colorSpace = THREE.SRGBColorSpace;
  const top = new THREE.Color(), hor = new THREE.Color(), gnd = new THREE.Color(), key = new THREE.Color(), tmp = new THREE.Color();
  const css = (c, k) => '#' + tmp.copy(c).multiplyScalar(k).getHexString();
  let last = '';
  return {
    texture: tex,
    /** colours are linear and may be any brightness; returns true when the map was redrawn */
    sync(skyC, horC, gndC, sunC, sunDir, sunAmt) {
      const m = Math.max(skyC.r, skyC.g, skyC.b, horC.r, horC.g, horC.b, 1e-4);
      top.copy(skyC).multiplyScalar(1 / m).lerp(_white, 0.15); hor.copy(horC).multiplyScalar(1 / m).lerp(_white, 0.15);
      gnd.copy(gndC); gnd.multiplyScalar(0.5 / Math.max(gnd.r, gnd.g, gnd.b, 1e-4));
      key.copy(sunC); key.multiplyScalar(1 / Math.max(key.r, key.g, key.b, 1e-4));
      const q = (c) => `${Math.round(c.r * 24)},${Math.round(c.g * 24)},${Math.round(c.b * 24)}`;
      const k = `${q(top)}|${q(hor)}|${q(gnd)}|${q(key)}|${Math.round(sunDir.x * 12)},${Math.round(sunDir.y * 12)},${Math.round(sunDir.z * 12)}|${Math.round(sunAmt * 12)}`;
      if (k === last) return false;
      last = k;
      const gr = g.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, css(top, 0.55)); gr.addColorStop(0.42, css(tmp.copy(top).lerp(hor, 0.6), 0.75)); gr.addColorStop(0.5, css(hor, 0.9));
      gr.addColorStop(0.52, css(gnd, 0.5)); gr.addColorStop(1, css(gnd, 0.2));
      g.globalCompositeOperation = 'source-over'; g.fillStyle = gr; g.fillRect(0, 0, W, H);
      // sun / moon glow at its equirect position (three: u = atan(z, x) / 2π + 0.5, v = asin(y) / π + 0.5, row 0 = up)
      const u = Math.atan2(sunDir.z, sunDir.x) / (Math.PI * 2) + 0.5, v = Math.asin(clamp01(sunDir.y)) / Math.PI + 0.5;
      g.globalCompositeOperation = 'lighter';
      for (const dx of [-W, 0, W]) {
        const x = u * W + dx, y = (1 - v) * H, rr = H * 0.32, grd = g.createRadialGradient(x, y, 0, x, y, rr);
        grd.addColorStop(0, css(key, 0.9 * sunAmt)); grd.addColorStop(0.25, css(key, 0.35 * sunAmt)); grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
      }
      g.globalCompositeOperation = 'source-over';
      tex.needsUpdate = true; tex.needsPMREMUpdate = true;
      return true;
    },
  };
}

export const R = {
  quality: 'medium', q: QUALITY.medium,
  post: { nv: 0, blur: 0, flash: 0, damage: 0, motion: 0, desat: 0, vignette: 0.25, scope: 0 },
  env: null, lamps: [], lampLights: [], fogDensity: 0.03, lightLevel: 0.3,
  width: 1, height: 1,
  /** current dynamic-resolution step (index into DYN) and the resulting render-target scale */
  dyn: 0, renderScale: 1,

  init(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.autoClear = false;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    G.renderer = renderer; G.canvas = canvas;
    this.renderer = renderer;
    // a multisampled half-float target needs float colour buffers; without them MSAA is skipped
    this.msaaOK = renderer.capabilities.isWebGL2 !== false && renderer.extensions.has('EXT_color_buffer_float');

    G.scene = new THREE.Scene();
    G.scene.fog = new THREE.FogExp2(0x121a20, 0.03);
    G.camera = new THREE.PerspectiveCamera(75, 1, 0.08, 260);
    G.camera.rotation.order = 'YXZ';
    G.scene.add(G.camera);

    // view-model scene: its own camera with a fixed FOV so the gun doesn't stretch with the game FOV
    G.vmScene = new THREE.Scene();
    G.vmCamera = new THREE.PerspectiveCamera(55, 1, 0.01, 10);
    this.vmHemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.vmSun = new THREE.DirectionalLight(0xffffff, 0.8);
    this.vmSun.position.set(0.4, 1, 0.6);
    this.vmFlash = new THREE.PointLight(0xffc27a, 0, 3);
    this.vmFlash.position.set(0.1, -0.05, -0.8);
    G.vmScene.add(this.vmHemi, this.vmSun, this.vmFlash);
    // PBR view-model reflections: a small procedural PMREM environment, re-tinted in setEnv()
    this.vmEnv = createVmEnvironment(renderer);
    G.vmScene.environment = this.vmEnv.texture;
    // world image-based ambient, re-tinted from the act's sky in setEnv()
    this.worldEnv = createWorldEnvironment();
    G.scene.environment = this.worldEnv.texture;

    // world lights
    this.hemi = new THREE.HemisphereLight(0x8090a0, 0x2a2a26, 0.7);
    this.sun = new THREE.DirectionalLight(0xffffff, 0.5);
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 160;
    G.scene.add(this.hemi, this.sun, this.sun.target);
    this.flashLight = new THREE.PointLight(0xffc27a, 0, 16, 1.6);      // world muzzle flash / explosions
    G.scene.add(this.flashLight);
    this.flashT = 0;

    // sky dome
    this.skyMat = new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: { uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uGlowAmt: { value: 0 } } });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), this.skyMat);
    this.sky.frustumCulled = false; this.sky.renderOrder = -10;
    G.scene.add(this.sky);

    // post
    this.postScene = new THREE.Scene();
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postMat = new THREE.ShaderMaterial({ vertexShader: POST_VS, fragmentShader: POST_FS, depthTest: false, depthWrite: false,
      uniforms: { tScene: { value: null }, tPrev: { value: null }, uNV: { value: 0 }, uBlur: { value: 0 }, uFlash: { value: 0 }, uDamage: { value: 0 },
        uTime: { value: 0 }, uMotion: { value: 0 }, uDesat: { value: 0 }, uExposure: { value: 1 }, uVignette: { value: 0.25 }, uScope: { value: 0 },
        uSharp: { value: 0.3 }, uSat: { value: 1.12 }, uTexel: { value: new THREE.Vector2(1, 1) }, uTint: { value: new THREE.Color(1, 1, 1) } } });
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat));

    this._buildRain();
    const tier = this.isAuto() ? this.detectTier() : G.settings.quality;
    if (this.isAuto() && G.settings) G.settings.quality = tier;
    G.texDetail = tier === 'low' ? 'low' : 'high';     // textures.js reads this when it builds the set
    this.setQuality(tier);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  },

  /** No explicit choice in Settings yet (or "Auto" picked): the tier is chosen and adjusted by the game. */
  isAuto() { return !G.settings || G.settings.qualityAuto !== false; },

  /** First guess from the GPU's name; the frame-time watcher in render() corrects it downwards if needed. */
  detectTier() {
    let name = '';
    try {
      const gl = this.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch { /* unknown GPU */ }
    this.gpu = name;
    const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent || '');
    if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)) return 'low';
    if (!mobile && /apple m\d|apple gpu|rtx|gtx (9[6-9]0|1[0-9]{3})|radeon (rx|pro)|radeon\(tm\) rx|arc\(tm\) a|arc a\d|quadro|titan/i.test(name)) return 'high';
    if (mobile || /mali|adreno|powervr|videocore|intel.*\b(hd|uhd) graphics\b/i.test(name)) return 'low';
    return 'medium';                                   // Iris Xe, integrated Radeon, unknown
  },

  setQuality(name) {
    this.quality = QUALITY[name] ? name : 'medium';
    this.q = QUALITY[this.quality];
    const r = this.renderer, q = this.q;
    r.shadowMap.enabled = q.shadows;
    this.sun.castShadow = q.shadows;
    if (q.shadows) {
      const sh = this.sun.shadow, sc = sh.camera;
      if (sh.mapSize.x !== q.shadowMap) { sh.mapSize.set(q.shadowMap, q.shadowMap); if (sh.map) { sh.map.dispose(); sh.map = null; } }
      sc.left = -q.shadowR; sc.right = q.shadowR; sc.top = q.shadowR; sc.bottom = -q.shadowR; sc.updateProjectionMatrix();
      this.shadowTexel = (2 * q.shadowR) / q.shadowMap;
      // depth bias stays tiny; normal offset of ~1 texel removes acne on bumpy Standard surfaces without peter-panning
      sh.bias = -0.0003; sh.normalBias = this.shadowTexel * 0.9;
    }
    G.camera.far = q.far; G.camera.updateProjectionMatrix();
    // lamp light pool
    for (const l of this.lampLights) G.scene.remove(l);
    this.lampLights = [];
    for (let i = 0; i < q.lamps; i++) {
      const l = new THREE.PointLight(0xffc98a, 0, 14, 1.4);
      G.scene.add(l); this.lampLights.push(l);
    }
    this._lampTimer = 0;
    if (this.rain) this.rain.geometry.setDrawRange(0, q.rain * 2);
    G.scene.traverse((o) => { if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) m.needsUpdate = true; } });
    this.dyn = 0; this._perf = null;
    this.resize();
  },

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.q.dpr);
    this.width = w; this.height = h;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this._allocTargets();
    G.camera.aspect = w / h; G.camera.updateProjectionMatrix();
    G.vmCamera.aspect = w / h; G.vmCamera.updateProjectionMatrix();
  },

  /** (Re)build the two HDR scene targets at canvas size × tier scale × dynamic step. */
  _allocTargets() {
    const cw = this.renderer.domElement.width, ch = this.renderer.domElement.height;
    this.renderScale = this.q.scale * DYN[this.dyn];
    const pw = Math.max(2, Math.floor(cw * this.renderScale)), ph = Math.max(2, Math.floor(ch * this.renderScale));
    if (this.rtA && this.rtA.width === pw && this.rtA.height === ph) return;
    for (const k of ['rtA', 'rtB']) { if (this[k]) this[k].dispose(); }
    const opts = { samples: this.msaaOK ? this.q.samples : 0, depthBuffer: true, type: THREE.HalfFloatType };
    this.rtA = new THREE.WebGLRenderTarget(pw, ph, opts);
    this.rtB = new THREE.WebGLRenderTarget(pw, ph, opts);
    this.postMat.uniforms.uTexel.value.set(1 / pw, 1 / ph);
  },

  /**
   * Dynamic resolution. Frame time is averaged over ~1 s windows while a
   * mission runs. Two bad windows (< ~48 fps) step the render scale down;
   * five good ones (≥ ~57 fps) step it back up, but not for 20 s after a
   * drop. In Auto mode, still slow at the lowest step → drop a whole tier.
   * An explicit choice in Settings keeps its tier; only the scale moves.
   */
  _adapt(now) {
    const p = this._perf || (this._perf = { last: now, acc: 0, n: 0, bad: 0, good: 0, hold: 0 });
    const dt = now - p.last;
    p.last = now;
    if (!G.playing || G.paused || dt > 120 || document.hidden) { p.acc = p.n = 0; return; }
    p.acc += dt; p.n++;
    if (p.acc < 1000) return;
    const avg = p.acc / p.n;
    p.acc = p.n = 0;
    if (avg > 21) { p.bad++; p.good = 0; } else if (avg < 17.6) { p.good++; p.bad = 0; } else { p.bad = 0; p.good = 0; }
    if (p.bad >= 2) {
      p.bad = 0; p.hold = now + 20000;
      if (this.dyn < DYN.length - 1) { this.dyn++; this._allocTargets(); }
      else if (this.isAuto() && this.quality !== 'low') {
        const t = TIERS[TIERS.indexOf(this.quality) - 1];
        G.settings.quality = t; this.setQuality(t);
      }
    } else if (p.good >= 5 && this.dyn > 0 && now > p.hold) { p.good = 0; this.dyn--; this._allocTargets(); }
  },

  /** Apply an environment preset, or a blend of two (t = 0..1). */
  setEnv(a, b, t = 0) {
    const A = typeof a === 'string' ? ENV[a] : a, B = b ? (typeof b === 'string' ? ENV[b] : b) : A;
    const mixC = (ka) => _col.set(A[ka]).lerp(_col2.set(B[ka]), t);
    const s = G.scene;
    s.fog.color.copy(mixC('fog'));
    this.fogDensity = lerp(A.fogDensity, B.fogDensity, t);
    s.fog.density = this.fogDensity;
    this.renderer.setClearColor(s.fog.color, 1);
    this.skyMat.uniforms.uTop.value.copy(mixC('sky'));
    this.skyMat.uniforms.uHorizon.value.copy(mixC('horizon'));
    this.skyMat.uniforms.uGlow.value.copy(mixC('glow'));
    this.skyMat.uniforms.uGlowAmt.value = lerp(A.glowAmt, B.glowAmt, t);
    const d = [0, 1, 2].map((i) => lerp(A.sunDir[i], B.sunDir[i], t));
    this.sunDir = new THREE.Vector3(d[0], d[1], d[2]).normalize();
    this.skyMat.uniforms.uSunDir.value.copy(this.sunDir);
    this.hemi.color.copy(mixC('ambient')); this.hemi.groundColor.copy(_col.multiplyScalar(0.45));
    this.hemi.intensity = lerp(A.ambientI, B.ambientI, t) * 1.6;
    this.sun.color.copy(mixC('sun')); this.sun.intensity = lerp(A.sunI, B.sunI, t) * 1.8;
    this.vmHemi.color.copy(this.hemi.color); this.vmHemi.groundColor.copy(this.hemi.groundColor); this.vmHemi.intensity = Math.max(1.7, this.hemi.intensity * 1.2);
    this.vmSun.color.copy(this.sun.color); this.vmSun.intensity = Math.max(1.3, this.sun.intensity * 0.9);
    this.lightLevel = lerp(A.light, B.light, t);
    // view-model environment follows the act's light: re-tinted only when the colours change, dimmer at night
    if (this.vmEnv.sync(this.vmHemi.color, this.vmHemi.groundColor, this.vmSun.color)) G.vmScene.environment = this.vmEnv.texture;
    G.vmScene.environmentIntensity = 0.02 + Math.pow(this.lightLevel, 1.5) * 0.95;
    // world ambient from the same sky: low at night so wet stone and metal glint without lifting the dark
    const glow = lerp(A.glowAmt, B.glowAmt, t);
    this.worldEnv.sync(this.skyMat.uniforms.uTop.value, this.skyMat.uniforms.uHorizon.value, this.hemi.groundColor, this.sun.color, this.sunDir, 0.35 + glow * 0.5);
    s.environmentIntensity = 0.03 + Math.pow(this.lightLevel, 1.5) * 0.25;
    this.rainAmt = lerp(A.rain, B.rain, t);
    setWetness(clamp01(this.rainAmt * 1.7));
    this.exposure = lerp(A.exposure, B.exposure, t);
    this.env = { A, B, t };
  },

  /** 0..1 fog thickness for the stealth maths (0.01 clear … 0.04 pea soup). */
  fogFactor() { return clamp01((this.fogDensity - 0.008) / 0.032); },

  /** Lamps registered by the level: { x,y,z, r, i, color } — the nearest few get a real light. */
  setLamps(lamps) { this.lamps = lamps; this._lampTimer = 0; },

  /** Brief warm light at a world position (muzzle flash, explosion). */
  flashAt(x, y, z, intensity = 6, dist = 14, dur = 0.06) {
    this.flashLight.position.set(x, y, z);
    this.flashLight.intensity = intensity * 8; this.flashLight.distance = dist;
    this.flashT = dur; this.flashDur = dur;
  },
  vmFlashKick(v) { this.vmFlash.intensity = v * 5; },

  _buildRain() {
    const max = QUALITY.high.rain;
    const pos = new Float32Array(max * 6);
    this.rainSeed = new Float32Array(max * 3);
    for (let i = 0; i < max * 3; i++) this.rainSeed[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xaab4bc, transparent: true, opacity: 0.32, depthWrite: false }));
    this.rain.frustumCulled = false; this.rain.visible = false;
    G.scene.add(this.rain);
  },

  update(dt, time) {
    const cam = G.camera.position;
    this.sky.position.copy(cam); this.sky.scale.setScalar(G.camera.far * 0.9);
    // sun follows the player so its shadow frustum stays centred; the centre is snapped to
    // whole shadow texels in light space so shadow edges do not shimmer as the player moves
    const sd = this.sunDir || UP;
    _p.copy(cam);
    if (this.q.shadows && this.shadowTexel) {
      const tx = this.shadowTexel;
      _rgt.crossVectors(UP, sd).normalize(); _up.crossVectors(sd, _rgt);
      const a = Math.round(cam.dot(_rgt) / tx) * tx, b = Math.round(cam.dot(_up) / tx) * tx;
      _p.copy(_rgt).multiplyScalar(a).addScaledVector(_up, b).addScaledVector(sd, cam.dot(sd));
    }
    this.sun.target.position.copy(_p);
    this.sun.position.copy(_p).addScaledVector(sd, 70);

    // rain: recycle streaks inside a box around the camera
    const amt = this.rainAmt || 0;
    this.rain.visible = amt > 0.02;
    if (this.rain.visible) {
      const n = Math.floor(this.q.rain * amt), p = this.rain.geometry.attributes.position.array, sdd = this.rainSeed;
      const box = 26, hgt = 16, fall = time * 17;
      for (let i = 0; i < n; i++) {
        const x = cam.x + ((sdd[i * 3] * box + cam.x * -1) % box + box) % box - box / 2 + 0;
        const z = cam.z + ((sdd[i * 3 + 2] * box + cam.z * -1) % box + box) % box - box / 2 + 0;
        const y = cam.y + hgt / 2 - ((sdd[i * 3 + 1] * hgt + fall) % hgt);
        const k = i * 6;
        p[k] = x; p[k + 1] = y; p[k + 2] = z; p[k + 3] = x + 0.03; p[k + 4] = y - 0.55; p[k + 5] = z;
      }
      this.rain.geometry.setDrawRange(0, n * 2);
      this.rain.geometry.attributes.position.needsUpdate = true;
    }

    // lamp pool: every 0.4 s hand the real lights to the nearest lamps
    this._lampTimer = (this._lampTimer || 0) - dt;
    if (this._lampTimer <= 0) {
      this._lampTimer = 0.4;
      const ls = this.lamps;
      for (const l of ls) { const dx = l.x - cam.x, dz = l.z - cam.z; l._d = dx * dx + dz * dz; }
      const sorted = ls.length > this.lampLights.length ? [...ls].sort((a, b) => a._d - b._d) : ls;
      for (let i = 0; i < this.lampLights.length; i++) {
        const light = this.lampLights[i], l = sorted[i];
        if (l && l._d < 60 * 60 && !l.off) { light.position.set(l.x, l.y, l.z); light.color.set(l.color || 0xffc98a); light.intensity = l.i * 26; light.distance = l.r * 1.25; light._lamp = l; }
        else { light.intensity = 0; light._lamp = null; }
      }
    }
    for (const light of this.lampLights) if (light._lamp && light._lamp.flicker) light.intensity = light._lamp.i * 26 * (0.82 + Math.sin(time * 11 + light._lamp.x) * 0.1 + Math.sin(time * 23) * 0.08);

    if (this.flashT > 0) { this.flashT -= dt; if (this.flashT <= 0) this.flashLight.intensity = 0; }
    this.vmFlash.intensity = Math.max(0, this.vmFlash.intensity - dt * 90);
  },

  render(time) {
    this._adapt(performance.now());
    const r = this.renderer, u = this.postMat.uniforms, p = this.post;
    r.info.autoReset = false; r.info.reset();     // count draw calls across all three passes
    // swap history
    const cur = this.rtA, prev = this.rtB; this.rtA = prev; this.rtB = cur;
    r.setRenderTarget(cur);
    r.clear(true, true, false);
    r.render(G.scene, G.overrideCamera || G.camera);
    if (!G.overrideCamera && G.vmVisible !== false) {
      r.clearDepth();
      r.render(G.vmScene, G.vmCamera);
    }
    r.setRenderTarget(null);
    u.tScene.value = cur.texture; u.tPrev.value = prev.texture;
    u.uNV.value = p.nv; u.uBlur.value = p.blur; u.uFlash.value = clamp01(p.flash); u.uDamage.value = clamp01(p.damage);
    u.uTime.value = time % 1000; u.uMotion.value = clamp01(p.motion) * 0.55; u.uDesat.value = clamp01(p.desat);
    u.uExposure.value = (this.exposure || 1); u.uVignette.value = p.vignette;
    // sharpen harder when the target is below canvas size; not under night vision (it would sharpen the grain)
    u.uSharp.value = Math.min(1, this.q.sharpen * (1 + (1 - this.renderScale) * 1.5)) * (1 - clamp01(p.nv));
    r.render(this.postScene, this.postCam);
  },

  /** Free everything attached to the scene by a level. */
  disposeObject(obj) {
    obj.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    });
    if (obj.parent) obj.parent.remove(obj);
  },
  info() { const i = this.renderer.info; return { calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, tex: i.memory.textures, scale: +this.renderScale.toFixed(2), q: this.quality }; },
};
void TEX;
