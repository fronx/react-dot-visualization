import * as THREE from 'three';

/**
 * Bevel/dome shader with stroke ring support.
 * Each dot is rendered as a hemisphere lit from top-left,
 * with a stroke ring near the edge.
 *
 * uStrokeWidth: fraction of radius (0-1) for the stroke ring.
 *               e.g. 0.05 = 5% of radius
 * uStrokeColor: RGB color of the stroke ring
 */
const vertexShader = /* glsl */`
  attribute float instanceAlpha;
  attribute float instanceFocus;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFocus;
  void main() {
    vUv = uv;
    #ifdef USE_INSTANCING_COLOR
      vColor = instanceColor;
    #else
      vColor = vec3(1.0);
    #endif
    vAlpha = instanceAlpha;
    vFocus = instanceFocus;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

// Focus-ring geometry constants (mirror utils/focusDotSizing.ts in fingertip):
//   inner disc spans 0..INNER_END
//   gap (transparent) spans INNER_END..GAP_END
//   outer ring spans GAP_END..1.0
//   OUTER_RATIO = 1 + GAP_RATIO(0.4) + RING_RATIO(0.3) = 1.7
const fragmentShader = /* glsl */`
  uniform float uStrokeWidth;
  uniform vec3 uStrokeColor;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFocus;

  void main() {
    vec2 c = vUv - 0.5;
    float dist = length(c) * 2.0;
    float edgeFalloff = fwidth(dist);

    float coverage;
    vec3 color;

    if (vFocus > 0.5) {
      // Focus visual: inner disc + outer ring with transparent gap.
      const float INNER_END = 1.0 / 1.7;        // ≈ 0.5882
      const float GAP_END = 1.4 / 1.7;          // ≈ 0.8235
      float innerCoverage = 1.0 - smoothstep(INNER_END - edgeFalloff, INNER_END + edgeFalloff, dist);
      float ringInner = smoothstep(GAP_END - edgeFalloff, GAP_END + edgeFalloff, dist);
      float ringOuter = 1.0 - smoothstep(1.0 - edgeFalloff, 1.0, dist);
      coverage = max(innerCoverage, ringInner * ringOuter);
      color = vColor;
    } else {
      coverage = 1.0 - smoothstep(1.0 - edgeFalloff, 1.0, dist);
      float strokeStart = 1.0 - uStrokeWidth;
      float strokeMix = smoothstep(strokeStart - edgeFalloff, strokeStart + edgeFalloff, dist);
      color = mix(vColor, uStrokeColor, strokeMix);
    }

    float alpha = coverage * vAlpha;
    if (alpha <= 0.0) discard;

    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

export function createBevelStrokeMaterial(strokeColor = '#111', strokeWidth = 0.05) {
  const color = new THREE.Color(strokeColor);
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uStrokeWidth: { value: strokeWidth },
      uStrokeColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
    },
    transparent: true,
    depthWrite: false,
  });
}

export function updateMaterialStroke(material, strokeColor, strokeWidth) {
  const color = new THREE.Color(strokeColor);
  material.uniforms.uStrokeColor.value.set(color.r, color.g, color.b);
  material.uniforms.uStrokeWidth.value = strokeWidth;
}

const pulseDiscVertex = /* glsl */`
  attribute float instanceAlpha;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vUv = uv;
    #ifdef USE_INSTANCING_COLOR
      vColor = instanceColor;
    #else
      vColor = vec3(1.0);
    #endif
    vAlpha = instanceAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const pulseDiscFragment = /* glsl */`
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = vUv - 0.5;
    float dist = length(c) * 2.0;
    float edgeFalloff = fwidth(dist);
    float coverage = 1.0 - smoothstep(1.0 - edgeFalloff, 1.0, dist);
    float alpha = coverage * vAlpha;
    if (alpha <= 0.0) discard;
    gl_FragColor = vec4(vColor, alpha);
    #include <colorspace_fragment>
  }
`;

export function createPulseDiscMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: pulseDiscVertex,
    fragmentShader: pulseDiscFragment,
    transparent: true,
    depthWrite: false,
  });
}
