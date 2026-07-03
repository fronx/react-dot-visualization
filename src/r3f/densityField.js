/**
 * Density-field "lens" for the WebGPU samples map (zoomed-out / dense regime).
 *
 * Why: at small projected size the dot cloud is denser than the pixel grid, so
 * drawing N hard sprites point-samples a sub-pixel signal → aliasing ("fizz").
 * The fix (per Splatterplots / GPU-KDE — see fingertip docs/research) is to
 * estimate a band-limited density field and shade THAT, recomputed per frame so
 * it survives live data.
 *
 * Two GPU pieces, both reading the same storage buffers as R3FDotsWebGPU:
 *   1. Splat pass — each point contributes a Gaussian kernel of (OKLab·w, w) into
 *      a signed-float render target via additive (One/One) blending.
 *      rgb = Σ(OKLabᵢ·wᵢ), a = Σwᵢ. Color is carried in OKLab so the mean is a
 *      perceptual mean (RGB averaging lets one channel dominate — Splatterplots
 *      Fig. 7). Kernel radius is a screen-space bandwidth (px → world via
 *      pxPerWorld), the band-limiter.
 *   2. Resolve — a fullscreen quad samples the RT, divides for the mean OKLab
 *      (Σ/Σw) and interpolates background → mean-hue by density (capped, never
 *      white). Crossfaded with the crisp dots by zoom (densityFade).
 *
 * MVP: single set, per-point colors, mix bg→mean in OKLab. Deferred: independent
 * density→L via OKLCH, JFA contours, explicit outlier sampling.
 */
import * as THREE from 'three/webgpu';
import {
  instanceIndex, positionLocal, vec3, vec4, float, exp, pow, max as tslMax,
  length, texture, screenUV, uv, varying, sRGBTransferOETF, mix, clamp, select,
} from 'three/tsl';
import { semanticColorNode, semanticAlphaNode } from './semanticScoreKernels.js';

// Tunables (eyeball these first).
// CRISPNESS: the kernel's effective sigma ≈ BANDWIDTH_PX / √(2·SPLAT_K) device px.
// Band-limiting (no fizz) only needs sigma ≳ 1px; bigger just over-blurs. Lower
// BANDWIDTH_PX = crisper; below ~2px the aliasing/fizz starts to return.
export const BANDWIDTH_PX = 3;    // kernel quad radius in device px → sigma ≈ 1.06px here
export const SPLAT_K = 4.0;       // Gaussian sharpness inside the quad: g = exp(-K·d²)
export const DENSITY_GAIN = 0.6;  // how fast density saturates toward the mean hue (higher = denser reads sooner)
// Crossfade band, in projected dot radius (device px): full density below LO, full dots above HI.
export const FADE_PX_LO = 3.0;
export const FADE_PX_HI = 6.0;

// ── OKLab (Björn Ottosson) ────────────────────────────────────────────────
const CBRT = float(1 / 3);
function linearToOKLab(c) {
  const r = c.x, g = c.y, b = c.z;
  const l = r.mul(0.4122214708).add(g.mul(0.5363325363)).add(b.mul(0.0514459929));
  const m = r.mul(0.2119034982).add(g.mul(0.6806995451)).add(b.mul(0.1073969566));
  const s = r.mul(0.0883024619).add(g.mul(0.2817188376)).add(b.mul(0.6299787005));
  const l_ = pow(l.max(0.0), CBRT);
  const m_ = pow(m.max(0.0), CBRT);
  const s_ = pow(s.max(0.0), CBRT);
  return vec3(
    l_.mul(0.2104542553).add(m_.mul(0.7936177850)).sub(s_.mul(0.0040720468)),
    l_.mul(1.9779984951).sub(m_.mul(2.4285922050)).add(s_.mul(0.4505937099)),
    l_.mul(0.0259040371).add(m_.mul(0.7827717662)).sub(s_.mul(0.8086757660)),
  );
}
function oklabToLinear(lab) {
  const L = lab.x, a = lab.y, b = lab.z;
  const l_ = L.add(a.mul(0.3963377774)).add(b.mul(0.2158037573));
  const m_ = L.sub(a.mul(0.1055613458)).sub(b.mul(0.0638541728));
  const s_ = L.sub(a.mul(0.0894841775)).sub(b.mul(1.2914855480));
  const l = l_.mul(l_).mul(l_);
  const m = m_.mul(m_).mul(m_);
  const s = s_.mul(s_).mul(s_);
  return vec3(
    l.mul(4.0767416621).sub(m.mul(3.3077115913)).add(s.mul(0.2309699292)),
    l.mul(-1.2684380046).add(m.mul(2.6097574011)).sub(s.mul(0.3413193965)),
    l.mul(-0.0041960863).sub(m.mul(0.7034186147)).add(s.mul(1.7076147010)),
  ).max(0.0);
}

export function createDensityRenderTarget(width, height) {
  const rt = new THREE.RenderTarget(Math.max(1, width), Math.max(1, height), {
    type: THREE.HalfFloatType, // signed float — OKLab a/b channels go negative
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.minFilter = THREE.LinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  return rt;
}

// Splat material: additive accumulation of (OKLab·w, w) per point, where the
// weight w = perDotAlpha · gaussian. Weighting by alpha means filtered/dimmed
// dots contribute proportionally less density (α≈0 → nothing).
function createSplatMaterial({ positions, colors, alphas, semantic = null, entryRamp = null, pxPerWorldU, bandwidthPxU }) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false });
  // True additive accumulation (src·1 + dst·1) for color AND weight — NOT
  // AdditiveBlending, which premultiplies rgb by srcAlpha.
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneFactor;
  m.blendEquationAlpha = THREE.AddEquation;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneFactor;

  const pos = positions.element(instanceIndex);
  const radiusWorld = bandwidthPxU.div(pxPerWorldU);
  m.positionNode = vec3(positionLocal.xy.mul(radiusWorld.mul(2.0)).add(pos), 0);

  const dist = length(uv().sub(0.5)).mul(2.0); // 0 at center → 1 at quad edge
  const g = exp(dist.mul(dist).mul(-SPLAT_K));
  // Per-vertex (constant across the quad), interpolated: OKLab color + dot alpha.
  // When semantic scoring is active, use the same score buffer/range as the
  // crisp dot material; otherwise the zoomed-out density layer would hide the
  // by-vibe result even though the dot layer was correctly scored.
  const baseColor = colors.element(instanceIndex);
  const baseAlpha = alphas.element(instanceIndex);
  const score = semantic ? semantic.scores.element(instanceIndex) : null;
  const color = semantic ? semanticColorNode(baseColor, score, semantic) : baseColor;
  const semanticAlpha = semantic ? semanticAlphaNode(baseAlpha, score, semantic) : baseAlpha;
  // Data-swap entry ramp (opt-in; see R3FDotsWebGPU): newcomers contribute
  // density proportionally to the same ramp the crisp dot layer applies.
  const alphaBase = entryRamp
    ? semanticAlpha.mul(mix(entryRamp.progressU, float(1), entryRamp.ramp0.element(instanceIndex)))
    : semanticAlpha;
  const lab = varying(linearToOKLab(color));
  const alpha = varying(alphaBase);
  const w = g.mul(alpha);
  // Colour is weighted by α a SECOND time so the resolve's Σ(OKLab·α²·g)/Σ(α·g)
  // carries the dim as a lightness attenuation (≈ OKLab·α for a uniform region).
  // With a single α the resolve divides it straight back out and dimmed regions
  // paint at full lightness — the "dimmed greys read light when zoomed out" bug.
  // Matched dots (α=1) are unchanged.
  m.colorNode = lab.mul(w).mul(alpha);  // rgb accumulates Σ(OKLabᵢ·αᵢ²·gᵢ)
  m.opacityNode = w;                    // a accumulates Σ(αᵢ·gᵢ)  (the density weight)
  return m;
}

// One InstancedMesh in a private scene; rendered to the density RT each frame.
export function createSplatScene({ count, positions, colors, alphas, semantic = null, entryRamp = null, pxPerWorldU, bandwidthPxU }) {
  const material = createSplatMaterial({ positions, colors, alphas, semantic, entryRamp, pxPerWorldU, bandwidthPxU });
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, count);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { scene, mesh };
}

// Fullscreen quad that resolves the RT into the shaded density field. Its
// vertexNode bypasses the camera (always covers NDC); fragment samples by
// screenUV. Whole-layer opacity = densityFade (the zoom crossfade).
export function createDensityResolveMesh({ densityRT, densityFadeU }) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false });
  m.vertexNode = vec4(positionLocal.xy.mul(2.0), 0.0, 1.0); // plane(1,1) ±0.5 → ±1 NDC

  const d = texture(densityRT.texture, screenUV);
  const w = d.a;
  const meanLab = d.rgb.div(tslMax(w, float(1e-4)));        // Σ(OKLab·w)/Σw — perceptual mean hue
  const bright = float(1.0).sub(exp(w.mul(-DENSITY_GAIN))); // 0..1, saturating with density

  // Color = the mean hue; the dark background shows through where empty via the
  // density-dependent alpha (so the layer never tints the whole map). "Denser =
  // brighter" falls out of more-opaque-over-dark. Crossfade by zoom on top.
  m.colorNode = sRGBTransferOETF(oklabToLinear(meanLab));
  m.opacityNode = bright.mul(densityFadeU);

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;        // composite over the crisp dots
  mesh.raycast = () => null;
  return mesh;
}

// fade = 1 when dots project small (zoomed out → show density), 0 when large.
export function densityFadeForProjectedPx(projectedRadiusPx) {
  const t = (projectedRadiusPx - FADE_PX_LO) / (FADE_PX_HI - FADE_PX_LO);
  const c = Math.min(1, Math.max(0, t));
  const s = c * c * (3 - 2 * c); // smoothstep
  return 1 - s;
}
