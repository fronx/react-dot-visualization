/**
 * GPU-resident dots layer for the WebGPU backend of DotVisualizationR3F.
 *
 * The WebGPU counterpart to R3FDots. Where R3FDots writes per-instance matrices
 * on the CPU each frame, this layer keeps everything on the GPU: per-instance
 * position/color/alpha/focus live in storage buffers, the decollision sim (the
 * validated TSL kernels) runs in-shader each frame and writes the positions
 * buffer, and the bevel-stroke node material reads it via element(instanceIndex)
 * — zero readback, no CPU-side per-instance work.
 *
 * Proven in webgpu-spike-entry.jsx; this is the same pipeline parameterized by
 * the `data`/`dotStyles` props instead of synthetic input.
 */
import React, { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { useFrame, useThree } from '@react-three/fiber';
import { instanceIndex, vec3, instancedArray, positionLocal, uniform } from 'three/tsl';
import { createBevelStrokeNodeMaterial } from './bevelStrokeNodeMaterial.js';
import { computeGridParams } from '../decollision-webgpu.js';
import {
  buildCountBins, buildScanStep, buildPlaceParticles, buildCollideSpatial,
  buildApply, buildClearAtomicU32,
} from '../decollision-tsl.js';

const ALPHA_DECAY = 0.0228; // d3-force defaults
const ALPHA_MIN = 0.001;

function scanIterations(n) {
  if (n <= 1) return 0;
  let iters = Math.ceil(Math.log2(n));
  if (iters % 2 === 1) iters += 1;
  return iters;
}

// Build the storage buffers + grid from data. Positions use R3FDots' world
// convention (worldY = -item.y). The dot radius matches R3FDots exactly:
// baseSize = customStyle.r ?? radiusOverride ?? item.size ?? defaultSize, used
// directly as the world-space circle radius (its quad is scaled to 2*radius).
function buildBuffers(data, { defaultSize, defaultColor, dotStyles, radiusOverrides }) {
  const N = data.length;
  const pos = new Float32Array(N * 2);
  const rad = new Float32Array(N);
  const col = new Float32Array(N * 3);
  const alpha = new Float32Array(N);
  const focus = new Float32Array(N);
  const nodes = new Array(N);
  const tmp = new THREE.Color();

  for (let i = 0; i < N; i++) {
    const item = data[i];
    const x = item.x;
    const y = -item.y;
    pos[i * 2] = x; pos[i * 2 + 1] = y;
    nodes[i] = { x, y };

    const style = dotStyles && dotStyles.get(item.id);
    const baseSize = style?.r ?? radiusOverrides?.get(item.id) ?? item.size ?? defaultSize;
    rad[i] = Math.max(0.0001, baseSize);
    tmp.set(style?.fill ?? item.color ?? defaultColor ?? '#888');
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    alpha[i] = style?.opacity != null ? Number(style.opacity) : 1;
    focus[i] = style?.focusRing ? 1 : 0;
  }

  const grid = computeGridParams(nodes, rad);
  const len = grid.numBins + 1;
  return {
    N,
    grid, len,
    positions: instancedArray(pos, 'vec2'),
    velocities: instancedArray(new Float32Array(N * 2), 'vec2'),
    radii: instancedArray(rad, 'float'),
    nextVel: instancedArray(N, 'vec2'),
    binCount: instancedArray(new Uint32Array(len), 'uint').toAtomic(),
    scratch: instancedArray(new Uint32Array(len), 'uint'),
    placeCounter: instancedArray(new Uint32Array(grid.numBins), 'uint').toAtomic(),
    sortedIndices: instancedArray(new Uint32Array(N), 'uint'),
    colors: instancedArray(col, 'vec3'),
    alphas: instancedArray(alpha, 'float'),
    focus: instancedArray(focus, 'float'),
  };
}

export function R3FDotsWebGPU({
  data,
  dotStyles,
  radiusOverrides,
  defaultSize = 6,
  defaultColor = '#888',
  dotStroke = '#111',
  dotStrokeWidthFraction = 0.1,
  enableDecollisioning = true,
}) {
  const gl = useThree((s) => s.gl);

  const buffers = useMemo(
    () => (data && data.length ? buildBuffers(data, { defaultSize, defaultColor, dotStyles, radiusOverrides }) : null),
    [data, defaultSize, defaultColor, dotStyles, radiusOverrides],
  );

  const mesh = useMemo(() => {
    if (!buffers) return null;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = createBevelStrokeNodeMaterial({
      instanceColor: buffers.colors.element(instanceIndex),
      instanceAlpha: buffers.alphas.element(instanceIndex),
      instanceFocus: buffers.focus.element(instanceIndex),
      strokeColor: dotStroke,
      strokeWidthFraction: dotStrokeWidthFraction,
    });
    const instPos = buffers.positions.element(instanceIndex);
    const instRad = buffers.radii.element(instanceIndex);
    material.positionNode = vec3(positionLocal.xy.mul(instRad.mul(2.0)).add(instPos), 0);
    const m = new THREE.InstancedMesh(geometry, material, buffers.N);
    m.frustumCulled = false;
    return m;
  }, [buffers, dotStroke, dotStrokeWidthFraction]);

  const pipeline = useMemo(() => {
    if (!buffers) return null;
    const { positions, velocities, radii, nextVel, binCount, scratch, placeCounter, sortedIndices, grid, len, N } = buffers;
    const scanSteps = [];
    const iters = scanIterations(len);
    for (let s = 0; s < iters; s++) {
      const a2b = s % 2 === 0;
      scanSteps.push(buildScanStep({
        src: a2b ? binCount : scratch, dst: a2b ? scratch : binCount,
        srcAtomic: a2b, dstAtomic: !a2b, step: 1 << s, length: len,
      }));
    }
    const alphaU = uniform(1);
    return {
      alphaU,
      clearBin: buildClearAtomicU32({ buffer: binCount, length: len }),
      clearPlace: buildClearAtomicU32({ buffer: placeCounter, length: grid.numBins }),
      countBins: buildCountBins({ positions, velocities, binCount, grid, count: N }),
      scanSteps,
      place: buildPlaceParticles({ positions, velocities, binCount, placeCounter, sortedIndices, grid, count: N }),
      collide: buildCollideSpatial({ positions, velocities, radii, nextVel, binCount, sortedIndices, grid, count: N, strength: 1, alpha: alphaU }),
      apply: buildApply({ positions, velocities, nextVel, count: N, velocityRetain: 0.6 }),
    };
  }, [buffers]);

  useFrame(() => {
    if (!pipeline) return;
    const p = pipeline;
    if (enableDecollisioning && p.alphaU.value > ALPHA_MIN) {
      gl.compute(p.clearBin);
      gl.compute(p.clearPlace);
      gl.compute(p.countBins);
      for (let i = 0; i < p.scanSteps.length; i++) gl.compute(p.scanSteps[i]);
      gl.compute(p.place);
      gl.compute(p.collide);
      gl.compute(p.apply);
      p.alphaU.value += (0 - p.alphaU.value) * ALPHA_DECAY;
    }
  });

  if (!mesh) return null;
  return <primitive object={mesh} />;
}
