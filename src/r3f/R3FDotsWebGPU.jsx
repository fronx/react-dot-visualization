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
import React, { useMemo, useEffect, useRef } from 'react';
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

// Physics radius matches R3FDots: radiusOverride ?? item.size ?? defaultSize.
// `dotStyles.r` (focus enlargement) is mirrored into radiusOverrides by the
// caller, so it reaches the sim through that path — the physics buffers never
// read dotStyles, which is what lets cosmetic style churn skip a rebuild.
function physicsRadius(item, { defaultSize, radiusOverrides }) {
  const baseSize = radiusOverrides?.get(item.id) ?? item.size ?? defaultSize;
  return Math.max(0.0001, baseSize);
}

// Build the position/velocity/grid storage buffers + the simulation's static
// inputs (radii, sort scratch). Positions use R3FDots' world convention
// (worldY = -item.y) and seed the GPU sim from the raw, un-decollided input —
// the spread the decollision animates away from. Rebuilt only when the point
// set or its physical sizes change, never on cosmetic restyle, so the alpha
// schedule (created alongside, in `pipeline`) runs once to completion instead
// of restarting on every hover/selection/pulse frame.
function buildPhysicsBuffers(data, { defaultSize, radiusOverrides }) {
  const N = data.length;
  const pos = new Float32Array(N * 2);
  const rad = new Float32Array(N);
  const nodes = new Array(N);

  for (let i = 0; i < N; i++) {
    const item = data[i];
    const x = item.x;
    const y = -item.y;
    pos[i * 2] = x; pos[i * 2 + 1] = y;
    nodes[i] = { x, y };
    rad[i] = physicsRadius(item, { defaultSize, radiusOverrides });
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
  };
}

// Per-instance appearance: color/alpha/focus-ring. Lives in its own buffers so
// restyling (hover, selection, pulse, semantic colors) writes these in place
// without touching the position buffers or resetting the decollision alpha.
// Seeded from the current style at build time so the first paint is correct
// (the in-place rewrite on restyle runs after commit, too late for frame 1).
function buildCosmeticBuffers(N, data, opts) {
  const cosmetic = {
    colors: instancedArray(new Float32Array(N * 3), 'vec3'),
    alphas: instancedArray(new Float32Array(N), 'float'),
    focus: instancedArray(new Float32Array(N), 'float'),
  };
  writeCosmetics(cosmetic, data, opts);
  return cosmetic;
}

// Read the settled GPU positions back to the CPU once the sim has come to
// rest. Positions are stored in world convention (worldY = -item.y; see
// buildPhysicsBuffers), so the inverse negation restores viewBox-space y for
// the caller. With decollisioning off the GPU never ran, so the seed IS final.
async function readSettledData(renderer, buffers, data, decollisioned) {
  if (!decollisioned) return data;
  const arrayBuffer = await renderer.getArrayBufferAsync(buffers.positions.value);
  const pos = new Float32Array(arrayBuffer);
  const out = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = { ...data[i], x: pos[i * 2], y: -pos[i * 2 + 1] };
  }
  return out;
}

function writeCosmetics(cosmetic, data, { defaultColor, dotStyles }) {
  const colAttr = cosmetic.colors.value;
  const alphaAttr = cosmetic.alphas.value;
  const focusAttr = cosmetic.focus.value;
  const col = colAttr.array;
  const alpha = alphaAttr.array;
  const focus = focusAttr.array;
  const tmp = new THREE.Color();
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    const style = dotStyles && dotStyles.get(item.id);
    tmp.set(style?.fill ?? item.color ?? defaultColor ?? '#888');
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    alpha[i] = style?.opacity != null ? Number(style.opacity) : 1;
    focus[i] = style?.focusRing ? 1 : 0;
  }
  colAttr.needsUpdate = true;
  alphaAttr.needsUpdate = true;
  focusAttr.needsUpdate = true;
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
  onSettle,
}) {
  const gl = useThree((s) => s.gl);

  // Physics buffers rebuild only when the point set or its sizes change —
  // seeding the sim from raw positions and (via `pipeline`) resetting the
  // alpha schedule. Cosmetic restyle deliberately does NOT invalidate these.
  const buffers = useMemo(
    () => (data && data.length ? buildPhysicsBuffers(data, { defaultSize, radiusOverrides }) : null),
    [data, defaultSize, radiusOverrides],
  );

  // Cosmetic buffers are sized to the physics buffers, seeded with the current
  // style, and rewritten in place on restyle — so hover/selection/pulse never
  // restart the decollision. The seed-at-build deps intentionally exclude
  // dotStyles/defaultColor: the effect below handles restyle without a rebuild.
  const cosmetic = useMemo(
    () => (buffers && data && data.length
      ? buildCosmeticBuffers(buffers.N, data, { defaultColor, dotStyles })
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buffers],
  );
  useEffect(() => {
    if (cosmetic && data && data.length) {
      writeCosmetics(cosmetic, data, { defaultColor, dotStyles });
    }
  }, [cosmetic, data, defaultColor, dotStyles]);

  const mesh = useMemo(() => {
    if (!buffers || !cosmetic) return null;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = createBevelStrokeNodeMaterial({
      instanceColor: cosmetic.colors.element(instanceIndex),
      instanceAlpha: cosmetic.alphas.element(instanceIndex),
      instanceFocus: cosmetic.focus.element(instanceIndex),
      strokeColor: dotStroke,
      strokeWidthFraction: dotStrokeWidthFraction,
    });
    const instPos = buffers.positions.element(instanceIndex);
    const instRad = buffers.radii.element(instanceIndex);
    material.positionNode = vec3(positionLocal.xy.mul(instRad.mul(2.0)).add(instPos), 0);
    const m = new THREE.InstancedMesh(geometry, material, buffers.N);
    m.frustumCulled = false;
    return m;
  }, [buffers, cosmetic, dotStroke, dotStrokeWidthFraction]);

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

  // One-shot GPU→CPU readback at settle. The sim is GPU-resident, so the CPU
  // has no idea where the dots ended up — camera-fit, hover, and click all
  // need those positions. Reset whenever the physics buffers rebuild (new
  // point set), so each fresh decollision fires its own settle.
  const settleFiredRef = useRef(false);
  useEffect(() => { settleFiredRef.current = false; }, [buffers]);

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
      return;
    }
    if (settleFiredRef.current || !onSettle || !buffers || !data?.length) return;
    settleFiredRef.current = true;
    readSettledData(gl, buffers, data, enableDecollisioning).then(onSettle);
  });

  if (!mesh) return null;
  return <primitive object={mesh} />;
}
