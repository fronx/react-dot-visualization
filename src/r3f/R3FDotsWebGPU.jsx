/**
 * GPU-resident dots layer for the WebGPU backend of DotVisualizationR3F.
 *
 * The WebGPU counterpart to R3FDots. Where R3FDots writes per-instance matrices
 * on the CPU each frame, this layer keeps everything on the GPU: per-instance
 * position/color/alpha/focus/scale live in storage buffers, the decollision sim
 * (the validated TSL kernels) runs in-shader and writes the positions buffer,
 * and the bevel-stroke node material reads it via element(instanceIndex) — zero
 * readback during animation, no CPU-side per-instance work.
 *
 * Decollision is driven by the shared useDecollisionScheduler (in the parent),
 * via a GPU executor + a request channel (gpuControlRef). The scheduler owns
 * every decision — base vs. constraint, the position cache, go-through-base
 * transitions; this layer only executes them on the GPU:
 *   - a 'sim' request seeds the positions buffer, builds the spatial-hash
 *     collide pipeline for the launch radii, steps the kernels in-shader until
 *     the velocity metric converges, then reads positions back ONCE at settle.
 *   - a 'lerp' request snapshots the live positions, uploads the cached target,
 *     and mixes from→target in-shader each frame (zero per-frame copy).
 * Focus therefore animates from the current settled layout (or a cached one),
 * never from the raw UMAP cloud — matching the Canvas/WebGL scheduler exactly.
 *
 * Appearance (fill/opacity/scale/focus) is resolved through the shared rules in
 * dotAppearance.js — the same source of truth R3FDots uses — so hover, dim, and
 * focus behave identically across backends; only the upload mechanism differs.
 */
import React, { useMemo, useEffect, useRef } from 'react';
import * as THREE from 'three/webgpu';
import { useFrame, useThree } from '@react-three/fiber';
import { Fn, instanceIndex, vec3, instancedArray, positionLocal, uniform, select, float, max } from 'three/tsl';
import { easeCubicOut } from 'd3';
import { createBevelStrokeNodeMaterial, createPulseDiscNodeMaterial } from './bevelStrokeNodeMaterial.js';
import {
  createDensityRenderTarget, createSplatScene, createDensityResolveMesh,
  densityFadeForProjectedPx, BANDWIDTH_PX,
} from './densityField.js';
import { computeGridParams } from '../decollision-webgpu.js';
import {
  buildCountBins, buildScanStep, buildPlaceParticles, buildCollideSpatial,
  buildApply, buildMeasureMaxVelocitySquared, buildClearAtomicU32,
} from '../decollision-tsl.js';
import {
  resolveBaseSize, resolveScale, resolveFill, resolveOpacity, resolveFocus,
} from './dotAppearance.js';
import { usePulseAnimation } from '../usePulseAnimation.js';
import { calculateAdaptiveRingRadius } from '../pulseRingUtils.js';
import { CAMERA_FOV_DEGREES } from './cameraUtils.js';

// Safety caps in solver iterations — the velocity fixpoint (see the convergence
// metric below) normally settles a run earlier. Several iterations per frame
// keep wall-clock convergence practical on large samples maps while letting the
// render loop breathe between batches.
export const BASE_MAX_SOLVER_ITERATIONS = 2400;
export const CONSTRAINT_MAX_SOLVER_ITERATIONS = 1200;
const SOLVER_ITERATIONS_PER_FRAME = 4;
const CONVERGENCE_CHECK_FRAME_INTERVAL = 8;
const CONVERGENCE_METRIC_SCALE = 1000000;
const CONVERGED_MAX_VELOCITY = 0.002;
const CONVERGED_MAX_VELOCITY_SQUARED_U32 = Math.ceil(
  CONVERGED_MAX_VELOCITY * CONVERGED_MAX_VELOCITY * CONVERGENCE_METRIC_SCALE,
);

// Distinct grids to keep compiled at once (per seed). Focuses overwhelmingly
// share one grid; a handful of distinct cellSizes (big dots, the bumped-set
// drill-in) add entries. The cap bounds the compiled-pipeline + bin-buffer
// footprint instead of leaking one set per launch.
const MAX_SIM_CACHE = 12;

const CAMERA_FOV_RAD = CAMERA_FOV_DEGREES * (Math.PI / 180);
const TAN_HALF_FOV = Math.tan(CAMERA_FOV_RAD / 2);
// Min on-screen dot radius (device px); mirrors ColoredDots' MIN_BITMAP_RADIUS.
// Keeps sub-pixel dots from winking out when zoomed far out (a quad smaller
// than a pixel misses every pixel center). Clamped in-shader against pxPerWorld.
const MIN_SCREEN_PX = 1.5;

const EMPTY_STYLE = {};
const EMPTY_RADIUS_OVERRIDES = new Map();
const _color = new THREE.Color();
const NO_HOVER_INDEX = 0xffffffff; // out of range: matches no instance

function scanIterations(n) {
  if (n <= 1) return 0;
  let iters = Math.ceil(Math.log2(n));
  if (iters % 2 === 1) iters += 1;
  return iters;
}

// Persistent per-seed buffers: position/velocity for the sim, plus from/target
// scratch for the GPU lerp. Created once per point set (data identity) and kept
// across constraint changes — so focus restyle never re-seeds positions. Seeded
// from the raw input (worldY = -item.y) so the first paint shows real positions
// before the base decollision runs.
function buildSeedBuffers(data) {
  const N = data.length;
  const pos = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    pos[i * 2] = data[i].x;
    pos[i * 2 + 1] = -data[i].y;
  }
  return {
    N,
    positions: instancedArray(pos, 'vec2'),
    velocities: instancedArray(new Float32Array(N * 2), 'vec2'),
    fromPos: instancedArray(new Float32Array(N * 2), 'vec2'),
    targetPos: instancedArray(new Float32Array(N * 2), 'vec2'),
  };
}

// Grid-derived cache key: two launches whose grid params match can share one set
// of compute pipelines + bin buffers. Focuses seed from the same base layout, so
// they almost always share a grid (cellSize is usually the UMAP-spacing-driven
// targetCellSize, unaffected by one enlarged dot) — which is what lets us reuse
// instead of leaking a fresh pipeline per click.
function gridSignature(g) {
  return `${g.gridDimX}x${g.gridDimY}|${g.cellSize.toFixed(4)}|${g.gridMinX.toFixed(3)},${g.gridMinY.toFixed(3)}`;
}

// Build the spatial-hash collide pipeline for a grid. The result is cached by
// gridSignature and reused across launches (see startJob) — its `radii` buffer
// is rewritten in place per launch, so the pipeline never needs rebuilding for a
// new focus. Positions/velocities are the persistent seed buffers; the radii +
// bin scratch live here.
function buildSimResources({ N, positions, velocities }, grid, radiiArray) {
  const len = grid.numBins + 1;
  const radii = instancedArray(radiiArray, 'float');
  const nextVel = instancedArray(new Float32Array(N * 2), 'vec2');
  const binCount = instancedArray(new Uint32Array(len), 'uint').toAtomic();
  const scratch = instancedArray(new Uint32Array(len), 'uint');
  const placeCounter = instancedArray(new Uint32Array(grid.numBins), 'uint').toAtomic();
  const sortedIndices = instancedArray(new Uint32Array(N), 'uint');
  const maxVelocitySquared = instancedArray(new Uint32Array(1), 'uint').toAtomic();

  const scanSteps = [];
  const iters = scanIterations(len);
  for (let s = 0; s < iters; s++) {
    const a2b = s % 2 === 0;
    scanSteps.push(buildScanStep({
      src: a2b ? binCount : scratch, dst: a2b ? scratch : binCount,
      srcAtomic: a2b, dstAtomic: !a2b, step: 1 << s, length: len,
    }));
  }

  const clearBin = buildClearAtomicU32({ buffer: binCount, length: len });
  const clearPlace = buildClearAtomicU32({ buffer: placeCounter, length: grid.numBins });
  const countBins = buildCountBins({ positions, velocities, binCount, grid, count: N });
  const place = buildPlaceParticles({ positions, velocities, binCount, placeCounter, sortedIndices, grid, count: N });
  // Full strength every tick (strength: 1): d3.forceCollide and the standalone
  // WGSL collide both resolve overlaps at full strength and stop on a run
  // clock, not a tapering force. Here the per-launch iteration cap is that clock.
  const collide = buildCollideSpatial({ positions, velocities, radii, nextVel, binCount, sortedIndices, grid, count: N, strength: 1 });
  const apply = buildApply({ positions, velocities, nextVel, count: N, velocityRetain: 0.6 });
  const clearMetric = buildClearAtomicU32({ buffer: maxVelocitySquared, length: 1 });
  const measureVelocity = buildMeasureMaxVelocitySquared({ velocities, maxVelocitySquared, count: N, scale: CONVERGENCE_METRIC_SCALE });

  return {
    radii, // exposed so a cache hit can rewrite radii without rebuilding the pipeline
    clearBin, clearPlace, countBins, scanSteps, place, collide, apply, clearMetric, measureVelocity,
    maxVelocitySquared,
    // Released wholesale on cache eviction / seed change / unmount (see
    // disposeSimResources): the storage buffers free their GPUBuffers, the compute
    // nodes free their pipeline + bindings + node-builder cache. The shared seed
    // positions/velocities are excluded — they outlive any single sim.
    ownedBuffers: [radii, nextVel, binCount, scratch, placeCounter, sortedIndices, maxVelocitySquared],
    computeNodes: [clearBin, clearPlace, countBins, ...scanSteps, place, collide, apply, clearMetric, measureVelocity],
  };
}

// instancedArray storage buffers and compute nodes are NOT reclaimed by dropping
// their JS reference. A storage buffer's GPUBuffer is freed only via
// Attributes.delete (geometry attributes get this through a dispose event;
// standalone storage buffers have none); a compute node's pipeline + bindings +
// node-builder cache are freed only when the node fires 'dispose' (the listener
// Renderer.compute registers). So every GPU resource this component creates
// imperatively — sim buffers/kernels, seed/cosmetic/ring buffers, dot meshes —
// must be released by hand on replacement/unmount or it leaks for the renderer's
// lifetime (R3F never disposes <primitive> objects either).
function disposeStorageBuffers(gl, nodes) {
  const attributes = gl._attributes; // frees the GPUBuffer and updates renderer.info
  for (const node of nodes) {
    const attr = node?.value;
    if (!attr) continue;
    if (attributes) attributes.delete(attr);
    else if (gl.backend?.get(attr)?.buffer) gl.backend.destroyAttribute(attr);
  }
}

function disposeComputeNodes(nodes) {
  for (const node of nodes) node?.dispose?.();
}

function disposeSimResources(gl, sim) {
  if (!sim) return;
  disposeStorageBuffers(gl, sim.ownedBuffers);
  disposeComputeNodes(sim.computeNodes);
}

function disposeMesh(mesh) {
  if (!mesh) return;
  mesh.dispose?.(); // InstancedMesh.dispose frees instanceMatrix/instanceColor; no-op on plain Mesh
  mesh.geometry?.dispose?.();
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) material?.dispose?.();
}

async function readbackMaxVelocitySquared(renderer, metricBuffer) {
  const arrayBuffer = await renderer.getArrayBufferAsync(metricBuffer.value);
  return new Uint32Array(arrayBuffer)[0] ?? 0;
}

// Two trivial kernels for the GPU lerp: snapshot the live positions into fromPos
// (one GPU→GPU copy at transition start), then mix fromPos→targetPos by a uniform
// t each frame. No per-frame CPU↔GPU copy — just the t uniform.
function buildLerpKernels({ N, positions, fromPos, targetPos }, tU) {
  const snapshot = Fn(() => {
    fromPos.element(instanceIndex).assign(positions.element(instanceIndex));
  })().compute(N);
  const mixStep = Fn(() => {
    const i = instanceIndex;
    const a = fromPos.element(i);
    const b = targetPos.element(i);
    positions.element(i).assign(a.mul(float(1).sub(tU)).add(b.mul(tU)));
  })().compute(N);
  return { snapshot, mixStep };
}

// Per-instance appearance: color/alpha/focus/scale. Lives in its own buffers so
// restyling (hover, selection, pulse, semantic colors) writes these in place
// without touching the position buffers. `scale` is the *render* size (base size
// × hover) and is separate from the physics radii, so hover never perturbs the
// sim. Seeded at build so the first paint is correct (the restyle effect runs
// after commit).
function buildCosmeticBuffers(N, data, opts) {
  const cosmetic = {
    colors: instancedArray(new Float32Array(N * 3), 'vec3'),
    alphas: instancedArray(new Float32Array(N), 'float'),
    focus: instancedArray(new Float32Array(N), 'float'),
    scales: instancedArray(new Float32Array(N), 'float'),
  };
  writeCosmetics(cosmetic, data, opts);
  return cosmetic;
}

// Resolve fill/opacity/focus/scale for every dot via the shared appearance
// rules (dotAppearance.js) and upload them. Identical rule set to R3FDots'
// applyDotStylesToInstances — the renderers differ only in the write target.
function writeCosmetics(cosmetic, data, opts) {
  const {
    defaultColor, defaultSize, defaultOpacity, dotStyles, radiusOverrides,
    hoveredId, hoverSizeMultiplier, hoverOpacity,
  } = opts;
  const colAttr = cosmetic.colors.value;
  const alphaAttr = cosmetic.alphas.value;
  const focusAttr = cosmetic.focus.value;
  const scaleAttr = cosmetic.scales.value;
  const col = colAttr.array;
  const alpha = alphaAttr.array;
  const focus = focusAttr.array;
  const scale = scaleAttr.array;
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    const style = (dotStyles && dotStyles.get(item.id)) || EMPTY_STYLE;
    const isHovered = item.id === hoveredId;
    const baseSize = resolveBaseSize(item, style, radiusOverrides, defaultSize);
    _color.set(resolveFill(item, style, defaultColor));
    col[i * 3] = _color.r; col[i * 3 + 1] = _color.g; col[i * 3 + 2] = _color.b;
    alpha[i] = resolveOpacity(style, isHovered, hoverOpacity, defaultOpacity);
    focus[i] = resolveFocus(style);
    scale[i] = resolveScale(baseSize, isHovered, hoverSizeMultiplier);
  }
  colAttr.needsUpdate = true;
  alphaAttr.needsUpdate = true;
  focusAttr.needsUpdate = true;
  scaleAttr.needsUpdate = true;
}

// Read the GPU positions back to the CPU. Positions are world convention
// (worldY = -item.y; see buildSeedBuffers), so the inverse negation restores
// viewBox-space y for the caller. `template` supplies the id/order (the launch's
// sourceData), so the index→item mapping stays valid.
async function readbackPositions(renderer, positionsBuffer, template) {
  const arrayBuffer = await renderer.getArrayBufferAsync(positionsBuffer.value);
  const pos = new Float32Array(arrayBuffer);
  const out = new Array(template.length);
  let nonFinite = 0;
  for (let i = 0; i < template.length; i++) {
    const x = pos[i * 2];
    const y = -pos[i * 2 + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      out[i] = { ...template[i], x, y };
    } else {
      // The GPU sim can diverge a dot to NaN (e.g. two dots at the exact same
      // spot normalize a zero vector). Keep its finite seed so a single NaN
      // doesn't poison boundsForData and every fit/zoom that reads it.
      out[i] = template[i];
      nonFinite++;
    }
  }
  if (nonFinite > 0) console.warn(`[r3f-webgpu] readback kept seed for ${nonFinite}/${template.length} non-finite settled positions`);
  return out;
}

// Bevel-stroke dot mesh: per-instance color/alpha/focus/scale from `cosmetic`
// and position from `buffers`, indexed by `indexNode`. The main mesh indexes by
// instanceIndex; the hover overlay reuses this with a fixed uniform index.
// `scaleMul` lets the main mesh collapse the hovered instance to zero size.
function buildDotMesh(indexNode, count, { cosmetic, buffers, dotStroke, dotStrokeWidthFraction, scaleMul, pxPerWorldU }) {
  const material = createBevelStrokeNodeMaterial({
    instanceColor: cosmetic.colors.element(indexNode),
    instanceAlpha: cosmetic.alphas.element(indexNode),
    instanceFocus: cosmetic.focus.element(indexNode),
    strokeColor: dotStroke,
    strokeWidthFraction: dotStrokeWidthFraction,
  });
  // Floor the render radius at MIN_SCREEN_PX device px so dots don't vanish at
  // sub-pixel size when zoomed out. Clamp the base scale *before* scaleMul so
  // the hover-collapse-to-zero trick (scaleMul=0) still hides the main-mesh dot.
  const baseScale = max(cosmetic.scales.element(indexNode), float(MIN_SCREEN_PX).div(pxPerWorldU));
  const scale = scaleMul ? baseScale.mul(scaleMul) : baseScale;
  const pos = buffers.positions.element(indexNode);
  material.positionNode = vec3(positionLocal.xy.mul(scale.mul(2.0)).add(pos), 0);
  const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, count);
  m.frustumCulled = false;
  return m;
}

export function R3FDotsWebGPU({
  data,
  dotStyles,
  radiusOverrides = EMPTY_RADIUS_OVERRIDES,
  defaultSize = 6,
  defaultColor = null,
  defaultOpacity = 0.7,
  dotStroke = '#111',
  dotStrokeWidthFraction = 0.1,
  hoveredId = null,
  hoverSizeMultiplier = 1.5,
  hoverOpacity = 1.0,
  gpuControlRef = null,
}) {
  const gl = useThree((s) => s.gl);

  const cosmeticOpts = {
    defaultColor, defaultSize, defaultOpacity, dotStyles, radiusOverrides,
    hoveredId, hoverSizeMultiplier, hoverOpacity,
  };

  // Seed identity: changes only when the positional content (length + coords)
  // changes — NOT when sizes/colors do. fingertip recomputes `data` (new array,
  // same coords) whenever radii/folderColors resolve or a paint input changes;
  // keying the buffers on the reference would destroy the sim mid-flight on
  // every such churn (the scheduler is one-shot and wouldn't relaunch). Hashing
  // x/y keeps the GPU buffers alive across cosmetic re-renders.
  const seedKey = useMemo(() => {
    if (!data || data.length === 0) return 'empty';
    let h = (2166136261 ^ data.length) >>> 0;
    for (let i = 0; i < data.length; i++) {
      h = Math.imul(h ^ ((data[i].x * 8192) | 0), 16777619);
      h = Math.imul(h ^ ((data[i].y * 8192) | 0), 16777619);
    }
    return h >>> 0;
  }, [data]);

  // Persistent per-seed buffers — rebuilt only when the seed identity changes
  // (new point set / streaming flush / re-projection), never on cosmetic restyle
  // or focus. buildSeedBuffers reads only x/y/length, all captured by seedKey.
  const buffers = useMemo(
    () => (data && data.length ? buildSeedBuffers(data) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seedKey],
  );
  useEffect(() => () => {
    if (buffers) disposeStorageBuffers(gl, [buffers.positions, buffers.velocities, buffers.fromPos, buffers.targetPos]);
  }, [buffers, gl]);

  // Cosmetic buffers sized to the seed, seeded with the current style, rewritten
  // in place on restyle — so hover/selection/pulse/focus never touch positions.
  const cosmetic = useMemo(
    () => (buffers && data && data.length
      ? buildCosmeticBuffers(buffers.N, data, cosmeticOpts)
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buffers],
  );
  useEffect(() => {
    if (cosmetic && data && data.length) {
      writeCosmetics(cosmetic, data, cosmeticOpts);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cosmetic, data, defaultColor, defaultSize, defaultOpacity, dotStyles,
      radiusOverrides, hoveredId, hoverSizeMultiplier, hoverOpacity]);
  useEffect(() => () => {
    if (cosmetic) disposeStorageBuffers(gl, [cosmetic.colors, cosmetic.alphas, cosmetic.focus, cosmetic.scales]);
  }, [cosmetic, gl]);

  // Hovered instance index, read in-shader by the main mesh (to drop it) and the overlay (to redraw it on top).
  const hoveredIndexU = useMemo(() => uniform(NO_HOVER_INDEX, 'uint'), []);

  // Device px per world unit at the dot plane (z=0), refreshed each frame so the
  // min-screen-size clamp in buildDotMesh tracks zoom. Seeded large so dots are
  // not enlarged on the first frame, before the real value lands.
  const pxPerWorldU = useMemo(() => uniform(float(1e6)), []);
  const bandwidthPxU = useMemo(() => uniform(float(BANDWIDTH_PX)), []);
  const densityFadeU = useMemo(() => uniform(float(0)), []);

  // GPU lerp: t uniform + snapshot/mix kernels over the persistent buffers.
  const tU = useMemo(() => uniform(float(0)), []);
  const lerpKernels = useMemo(
    () => (buffers ? buildLerpKernels(buffers, tU) : null),
    [buffers, tU],
  );
  useEffect(() => () => {
    if (lerpKernels) disposeComputeNodes([lerpKernels.snapshot, lerpKernels.mixStep]);
  }, [lerpKernels]);

  // ── Decollision job state, driven by the scheduler's request channel ──────
  // jobRef holds the current GPU job ({ mode: 'idle' | 'sim' | 'lerp' | 'settling' }
  // plus its resources/clock). handledReqId tracks which request we've consumed.
  // settledRef caches the last settled CPU positions for the pulse ring.
  const jobRef = useRef({ mode: 'idle' });
  const handledReqId = useRef(0);
  const settledRef = useRef(null);

  // Per-seed cache of sim resources keyed by grid signature. Reused across
  // launches (a focus rewrites the radii buffer in place) so we don't leak a
  // fresh pipeline + bin buffers per click. Fresh Map per seed: old resources
  // referencing the previous buffers are dropped wholesale on a new seed.
  const simCache = useMemo(() => new Map(), [buffers]);
  // Free every cached sim's buffers + compute pipelines when the seed changes or
  // the component unmounts. The active job's sim is always still in this map, so
  // this only runs once the seed — and thus every job built against it — has been
  // superseded; GPU work already submitted against these resources still
  // completes, per WebGPU's buffer-lifetime guarantee.
  useEffect(() => () => {
    for (const sim of simCache.values()) disposeSimResources(gl, sim);
    simCache.clear();
  }, [simCache, gl]);

  // A job is tagged with the buffers it was built against (see startJob); the
  // useFrame loop skips stepping a job whose buffers no longer match the live
  // ones (a seed changed under it). We deliberately do NOT reset the job in a
  // [buffers] effect: React flushes that effect asynchronously, and R3F's frame
  // loop can run a frame *before* it — which would reset the job the loop just
  // started on mount. Gating inside useFrame is synchronous with the loop.

  // Start the GPU job named by a scheduler request. Side effects (buffer writes,
  // pipeline build) run here, on the frame the request is first seen.
  const startJob = (req) => {
    if (!buffers) return;
    if (req.type === 'stop') {
      jobRef.current = { mode: 'idle' };
      return;
    }
    if (req.type === 'sim') {
      const { sourceData, fnDotSize, onComplete } = req;
      const maxIterations = Number.isFinite(req.maxIterations)
        ? Math.max(1, Math.floor(req.maxIterations))
        : BASE_MAX_SOLVER_ITERATIONS;
      const N = buffers.N;
      // Seed positions from sourceData (raw cloud for base; the cached base
      // layout with one enlarged dot for a constraint), zero velocities, and
      // build this launch's radii + grid nodes — all in one pass over sourceData.
      const posArr = buffers.positions.value.array;
      const velArr = buffers.velocities.value.array;
      const radiiArray = new Float32Array(N);
      const nodes = new Array(N);
      for (let i = 0; i < N; i++) {
        const src = sourceData[i];
        const x = src.x;
        const y = -src.y;
        posArr[i * 2] = x; posArr[i * 2 + 1] = y;
        velArr[i * 2] = 0; velArr[i * 2 + 1] = 0;
        const r = fnDotSize ? Number(fnDotSize(src)) : resolveBaseSize(src, EMPTY_STYLE, radiusOverrides, defaultSize);
        radiiArray[i] = Number.isFinite(r) ? Math.max(0.0001, r) : 0.0001;
        nodes[i] = { x, y };
      }
      buffers.positions.value.needsUpdate = true;
      buffers.velocities.value.needsUpdate = true;
      // Reuse a cached pipeline when the grid matches (the common case for
      // focuses); otherwise build one and cap the cache so pipelines don't pile up.
      const grid = computeGridParams(nodes, radiiArray);
      const sig = gridSignature(grid);
      let sim = simCache.get(sig);
      if (sim) {
        sim.radii.value.array.set(radiiArray);
        sim.radii.value.needsUpdate = true;
        simCache.delete(sig); simCache.set(sig, sim); // mark most-recently-used
      } else {
        sim = buildSimResources(buffers, grid, radiiArray);
        simCache.set(sig, sim);
        if (simCache.size > MAX_SIM_CACHE) {
          const oldestKey = simCache.keys().next().value;
          disposeSimResources(gl, simCache.get(oldestKey));
          simCache.delete(oldestKey);
        }
      }
      jobRef.current = {
        mode: 'sim',
        buffers,
        sim,
        frameBatches: 0,
        iterations: 0,
        maxIterations,
        metricPending: false,
        onComplete,
        template: sourceData,
        jobId: req.id,
      };
      return;
    }
    if (req.type === 'lerp') {
      const { target, duration, onComplete } = req;
      const N = buffers.N;
      const tgt = buffers.targetPos.value.array;
      for (let i = 0; i < N; i++) {
        tgt[i * 2] = target[i].x;
        tgt[i * 2 + 1] = -target[i].y;
      }
      buffers.targetPos.value.needsUpdate = true;
      if (lerpKernels) gl.compute(lerpKernels.snapshot); // fromPos = live positions
      jobRef.current = {
        mode: 'lerp',
        buffers,
        t0: performance.now(),
        duration: Math.max(1, duration),
        onComplete,
        target,
        jobId: req.id,
      };
      return;
    }
  };

  const settleSimJob = (job) => {
    if (!job || job.mode !== 'sim') return;
    job.mode = 'settling'; // stop stepping; await the one-shot position readback
    const jobId = job.jobId;
    const onComplete = job.onComplete;
    readbackPositions(gl, buffers.positions, job.template).then((settled) => {
      if (jobRef.current.jobId !== jobId) return; // superseded by a newer launch
      settledRef.current = settled;
      jobRef.current = { mode: 'idle' };
      onComplete?.(settled);
    });
  };

  // Consume the latest request, then step the current job. One useFrame owns the
  // GPU decollision; the density-RT render below reads the positions it writes.
  useFrame(() => {
    const channel = gpuControlRef && gpuControlRef.current;
    if (channel && channel.request && channel.request.id !== handledReqId.current) {
      handledReqId.current = channel.request.id;
      startJob(channel.request);
    }

    const job = jobRef.current;
    // Skip a job whose seed changed under it; the scheduler relaunches against
    // the new buffers (and that launch's startJob retags job.buffers).
    if (job.buffers && job.buffers !== buffers) return;
    if (job.mode === 'sim') {
      const p = job.sim;
      const remaining = Math.max(0, job.maxIterations - job.iterations);
      const iterationsThisFrame = Math.min(SOLVER_ITERATIONS_PER_FRAME, remaining);
      for (let step = 0; step < iterationsThisFrame; step++) {
        gl.compute(p.clearBin);
        gl.compute(p.clearPlace);
        gl.compute(p.countBins);
        for (let i = 0; i < p.scanSteps.length; i++) gl.compute(p.scanSteps[i]);
        gl.compute(p.place);
        gl.compute(p.collide);
        gl.compute(p.apply);
        job.iterations += 1;
      }
      job.frameBatches += 1;

      if (job.iterations >= job.maxIterations) {
        settleSimJob(job);
        return;
      }

      const shouldCheck = !job.metricPending
        && job.frameBatches % CONVERGENCE_CHECK_FRAME_INTERVAL === 0;
      if (shouldCheck) {
        gl.compute(p.clearMetric);
        gl.compute(p.measureVelocity);
        job.metricPending = true;
        const jobId = job.jobId;
        readbackMaxVelocitySquared(gl, p.maxVelocitySquared).then((metric) => {
          const current = jobRef.current;
          if (current.jobId !== jobId || current.mode !== 'sim') return;
          current.metricPending = false;
          if (metric <= CONVERGED_MAX_VELOCITY_SQUARED_U32) {
            settleSimJob(current);
          }
        });
      }
      return;
    }
    if (job.mode === 'lerp') {
      const t = (performance.now() - job.t0) / job.duration;
      tU.value = Math.min(1, easeCubicOut(Math.min(1, t)));
      if (lerpKernels) gl.compute(lerpKernels.mixStep);
      if (t >= 1) {
        settledRef.current = job.target;
        const onComplete = job.onComplete;
        jobRef.current = { mode: 'idle' };
        onComplete?.(job.target);
      }
    }
  });

  // ── Density-field "lens" (zoomed-out anti-aliasing) ───────────────────────
  const densityRT = useMemo(() => createDensityRenderTarget(2, 2), []);
  useEffect(() => () => densityRT.dispose(), [densityRT]);

  const splat = useMemo(() => {
    if (!buffers || !cosmetic) return null;
    return createSplatScene({
      count: buffers.N, positions: buffers.positions,
      colors: cosmetic.colors, alphas: cosmetic.alphas,
      pxPerWorldU, bandwidthPxU,
    });
  }, [buffers, cosmetic, pxPerWorldU, bandwidthPxU]);
  useEffect(() => () => disposeMesh(splat?.mesh), [splat]);

  const densityMesh = useMemo(
    () => createDensityResolveMesh({ densityRT, densityFadeU }),
    [densityRT, densityFadeU],
  );
  useEffect(() => () => disposeMesh(densityMesh), [densityMesh]);

  useFrame((state) => {
    const dpr = state.gl.getPixelRatio();
    const pxPerWorld = (state.size.height / (2 * state.camera.position.z * TAN_HALF_FOV)) * dpr;
    pxPerWorldU.value = pxPerWorld;
    // Crossfade by the projected size of a typical dot: dots when large, density when small.
    densityFadeU.value = densityFadeForProjectedPx(defaultSize * pxPerWorld);

    if (!splat) return;
    const w = Math.max(1, Math.round(state.size.width * dpr));
    const h = Math.max(1, Math.round(state.size.height * dpr));
    if (densityRT.width !== w || densityRT.height !== h) densityRT.setSize(w, h);

    const prevTarget = state.gl.getRenderTarget();
    state.gl.setRenderTarget(densityRT);
    state.gl.setClearColor(0x000000, 0);
    state.gl.clear();
    state.gl.render(splat.scene, state.camera);
    state.gl.setRenderTarget(prevTarget);
  });

  const mesh = useMemo(() => {
    if (!buffers || !cosmetic) return null;
    // Collapse the hovered instance to zero size so it draws once: the overlay
    // redraws it on top (the canvas renderer draws the hovered dot last).
    const scaleMul = select(instanceIndex.equal(hoveredIndexU), float(0), float(1));
    return buildDotMesh(instanceIndex, buffers.N, { cosmetic, buffers, dotStroke, dotStrokeWidthFraction, scaleMul, pxPerWorldU });
  }, [buffers, cosmetic, dotStroke, dotStrokeWidthFraction, hoveredIndexU, pxPerWorldU]);
  useEffect(() => () => disposeMesh(mesh), [mesh]);

  // Redraw the hovered dot after the main mesh (renderOrder 1) so it sits on top
  // of overlapping dots, matching the canvas renderer.
  const hoverMesh = useMemo(() => {
    if (!buffers || !cosmetic) return null;
    const m = buildDotMesh(hoveredIndexU, 1, { cosmetic, buffers, dotStroke, dotStrokeWidthFraction, pxPerWorldU });
    m.renderOrder = 1;
    m.visible = false;
    return m;
  }, [buffers, cosmetic, dotStroke, dotStrokeWidthFraction, hoveredIndexU, pxPerWorldU]);
  useEffect(() => () => disposeMesh(hoverMesh), [hoverMesh]);

  // ── Pulse (ring + dot size/opacity oscillation) ──────────────────────────
  // Same machinery as R3FDots: usePulseAnimation drives a phase clock, this
  // useFrame reads it and writes pulsing dots' size/opacity into the cosmetic
  // buffers + drives a separate ring layer.
  const getPulseState = usePulseAnimation(dotStyles, undefined, false, true);
  const pulseIds = useMemo(() => {
    const ids = [];
    if (dotStyles) for (const [id, style] of dotStyles) if (style?.pulse) ids.push(id);
    return ids;
  }, [dotStyles]);
  const pulseKey = pulseIds.join('|');
  const idToIndex = useMemo(() => {
    const m = new Map();
    if (data) for (let i = 0; i < data.length; i++) m.set(data[i].id, i);
    return m;
  }, [data]);

  // Hide the overlay when nothing is hovered; resetting the index also
  // un-collapses the previously-hovered instance in the main mesh.
  useEffect(() => {
    if (!hoverMesh) return;
    const idx = hoveredId != null ? idToIndex.get(hoveredId) : undefined;
    if (idx === undefined) {
      hoveredIndexU.value = NO_HOVER_INDEX;
      hoverMesh.visible = false;
      return;
    }
    hoveredIndexU.value = idx;
    hoverMesh.visible = true;
  }, [hoverMesh, hoveredId, idToIndex, hoveredIndexU]);

  const ringBuffers = useMemo(() => {
    const count = pulseIds.length;
    if (count === 0) return { count: 0 };
    return {
      count,
      positions: instancedArray(new Float32Array(count * 2), 'vec2'),
      scales: instancedArray(new Float32Array(count), 'float'),
      colors: instancedArray(new Float32Array(count * 3), 'vec3'),
      alphas: instancedArray(new Float32Array(count), 'float'),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulseKey]);
  useEffect(() => () => {
    if (ringBuffers.count) disposeStorageBuffers(gl, [ringBuffers.positions, ringBuffers.scales, ringBuffers.colors, ringBuffers.alphas]);
  }, [ringBuffers, gl]);

  const ringMesh = useMemo(() => {
    if (!ringBuffers.count) return null;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = createPulseDiscNodeMaterial({
      instanceColor: ringBuffers.colors.element(instanceIndex),
      instanceAlpha: ringBuffers.alphas.element(instanceIndex),
    });
    const rp = ringBuffers.positions.element(instanceIndex);
    const rs = ringBuffers.scales.element(instanceIndex);
    material.positionNode = vec3(positionLocal.xy.mul(rs.mul(2.0)).add(rp), -0.1);
    const m = new THREE.InstancedMesh(geometry, material, ringBuffers.count);
    m.frustumCulled = false;
    m.renderOrder = -1; // behind the dots
    return m;
  }, [ringBuffers]);
  useEffect(() => () => disposeMesh(ringMesh), [ringMesh]);

  useFrame((state) => {
    if (!cosmetic || pulseIds.length === 0) return;
    const scaleArr = cosmetic.scales.value.array;
    const alphaArr = cosmetic.alphas.value.array;
    const dpr = state.gl.getPixelRatio();
    const viewBoxScale = (state.size.height / (2 * state.camera.position.z * TAN_HALF_FOV)) * dpr;
    const rb = ringBuffers;
    const ringPos = rb.count ? rb.positions.value.array : null;
    const ringScale = rb.count ? rb.scales.value.array : null;
    const ringCol = rb.count ? rb.colors.value.array : null;
    const ringAlpha = rb.count ? rb.alphas.value.array : null;
    let dotDirty = false;

    for (let j = 0; j < pulseIds.length; j++) {
      const id = pulseIds[j];
      const idx = idToIndex.get(id);
      if (idx === undefined) continue;
      const item = data[idx];
      const style = dotStyles.get(id) || EMPTY_STYLE;
      const isHovered = id === hoveredId;
      const baseSize = resolveBaseSize(item, style, radiusOverrides, defaultSize);
      const baseScale = resolveScale(baseSize, isHovered, hoverSizeMultiplier);
      const baseAlpha = resolveOpacity(style, isHovered, hoverOpacity, defaultOpacity);
      const fill = resolveFill(item, style, defaultColor);
      const ps = getPulseState(id, fill);

      scaleArr[idx] = baseScale * ps.sizeMultiplier;
      alphaArr[idx] = baseAlpha * ps.opacityMultiplier;
      dotDirty = true;

      if (!ringPos) continue;
      if (ps.ringData) {
        const ringRadius = calculateAdaptiveRingRadius({
          radius: baseSize,
          animationPhase: ps.ringData.animationPhase,
          viewBoxScale,
          zoomScale: 1,
          targetPixels: ps.ringData.options?.targetPixels,
          minRatio: ps.ringData.options?.minRatio,
          canvasDPR: dpr,
        });
        const settled = settledRef.current;
        const pos = (settled && settled[idx]) ? settled[idx] : item;
        ringPos[j * 2] = pos.x; ringPos[j * 2 + 1] = -pos.y;
        ringScale[j] = ringRadius;
        _color.set(ps.ringData.color || fill);
        ringCol[j * 3] = _color.r; ringCol[j * 3 + 1] = _color.g; ringCol[j * 3 + 2] = _color.b;
        ringAlpha[j] = ps.ringData.opacity;
      } else {
        ringAlpha[j] = 0;
      }
    }

    if (dotDirty) {
      cosmetic.scales.value.needsUpdate = true;
      cosmetic.alphas.value.needsUpdate = true;
    }
    if (rb.count) {
      rb.positions.value.needsUpdate = true;
      rb.scales.value.needsUpdate = true;
      rb.colors.value.needsUpdate = true;
      rb.alphas.value.needsUpdate = true;
    }
  });

  if (!mesh) return null;
  return (
    <>
      <primitive object={mesh} />
      {hoverMesh && <primitive object={hoverMesh} />}
      {ringMesh && <primitive object={ringMesh} />}
      <primitive object={densityMesh} />
    </>
  );
}
