/**
 * TSL node-material port of bevelStrokeMaterial.js, for the WebGPU backend.
 *
 * Same fragment logic as the GLSL version (a flat SDF disc with a stroke ring,
 * plus a focus visual of inner disc + outer ring with a transparent gap) —
 * re-expressed in TSL so it compiles to WGSL under WebGPURenderer (and to GLSL
 * on its WebGL2 fallback). The math is line-for-line equivalent to the GLSL.
 *
 * Position is the caller's concern (set `material.positionNode`), exactly as
 * the GLSL version leaves placement to the mesh's instanceMatrix. Per-instance
 * color / alpha / focus arrive as TSL attribute nodes (e.g. a storage buffer's
 * `.toAttribute()`), the WebGPU analogue of the GLSL instanced attributes.
 */
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  uv, length, smoothstep, mix, max, select, fwidth, uniform, color, float, varying,
} from 'three/tsl';

// Focus-ring geometry (mirror utils/focusDotSizing.ts in fingertip):
//   inner disc 0..INNER_END, transparent gap INNER_END..GAP_END, outer ring GAP_END..1
//   OUTER_RATIO = 1 + GAP_RATIO(0.4) + RING_RATIO(0.3) = 1.7
const INNER_END = 1.0 / 1.7;
const GAP_END = 1.4 / 1.7;

export function createBevelStrokeNodeMaterial({
  instanceColor,
  instanceAlpha,
  instanceFocus,
  strokeColor = '#111',
  strokeWidthFraction = 0.05,
}) {
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });

  const uStrokeColor = uniform(color(strokeColor));
  const uStrokeWidth = uniform(float(strokeWidthFraction));

  // Per-instance values arrive as vertex-stage storage reads (element(instanceIndex));
  // carry them to the fragment stage as varyings. (toAttribute would work too but
  // each one costs a vertex buffer, and WebGPU caps those at 8.)
  const vColor = varying(instanceColor);
  const vAlpha = varying(instanceAlpha);
  const vFocus = varying(instanceFocus);

  const dist = length(uv().sub(0.5)).mul(2.0);
  const edge = fwidth(dist);

  // Focus visual: inner disc + outer ring (transparent gap between).
  const innerCov = float(1).sub(smoothstep(float(INNER_END).sub(edge), float(INNER_END).add(edge), dist));
  const ringInner = smoothstep(float(GAP_END).sub(edge), float(GAP_END).add(edge), dist);
  const ringOuter = float(1).sub(smoothstep(float(1).sub(edge), float(1), dist));
  const focusCoverage = max(innerCov, ringInner.mul(ringOuter));

  // Normal visual: AA disc with a stroke ring blended near the edge.
  const discCoverage = float(1).sub(smoothstep(float(1).sub(edge), float(1), dist));
  const strokeStart = float(1).sub(uStrokeWidth);
  const strokeMix = smoothstep(strokeStart.sub(edge), strokeStart.add(edge), dist);
  const normalColor = mix(vColor, uStrokeColor, strokeMix);

  const isFocus = vFocus.greaterThan(0.5);
  material.colorNode = select(isFocus, vColor, normalColor);
  material.opacityNode = select(isFocus, focusCoverage, discCoverage).mul(vAlpha);

  material.userData.uStrokeColor = uStrokeColor;
  material.userData.uStrokeWidth = uStrokeWidth;
  return material;
}
