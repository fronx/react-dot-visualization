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
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vUv = uv;
    #ifdef USE_INSTANCING_COLOR
      vColor = instanceColor;
    #else
      vColor = vec3(1.0);
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  uniform float uStrokeWidth;
  uniform vec3 uStrokeColor;
  varying vec2 vUv;
  varying vec3 vColor;

  void main() {
    vec2 c = vUv - 0.5;
    float dist = length(c) * 2.0;

    if (dist > 1.0) discard;

    float strokeStart = 1.0 - uStrokeWidth;
    vec3 color = dist > strokeStart ? uStrokeColor : vColor;
    gl_FragColor = vec4(color, 1.0);
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
  });
}

export function updateMaterialStroke(material, strokeColor, strokeWidth) {
  const color = new THREE.Color(strokeColor);
  material.uniforms.uStrokeColor.value.set(color.r, color.g, color.b);
  material.uniforms.uStrokeWidth.value = strokeWidth;
}
