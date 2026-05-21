/**
 * GPU-resident dots layer for the WebGPU backend of DotVisualizationR3F.
 *
 * The WebGPU counterpart to R3FDots. Where R3FDots writes per-instance matrices
 * on the CPU each frame, this layer keeps everything on the GPU: per-instance
 * position/color/alpha/focus/scale live in storage buffers, the decollision sim
 * (the validated TSL kernels) runs in-shader each frame and writes the positions
 * buffer, and the bevel-stroke node material reads it via element(instanceIndex)
 * — zero readback, no CPU-side per-instance work.
 *
 * Appearance (fill/opacity/scale/focus) is resolved through the shared rules in
 * dotAppearance.js — the same source of truth R3FDots uses — so hover, dim, and
 * focus behave identically across backends; only the upload mechanism differs.
 */
import React, { useMemo, useEffect, useRef } from 'react';
import * as THREE from 'three/webgpu';
import { useFrame, useThree } from '@react-three/fiber';
import { instanceIndex, vec3, instancedArray, positionLocal, uniform, select, float, max } from 'three/tsl';
import { createBevelStrokeNodeMaterial, createPulseDiscNodeMaterial } from './bevelStrokeNodeMaterial.js';
import { computeGridParams } from '../decollision-webgpu.js';
import {
  buildCountBins, buildScanStep, buildPlaceParticles, buildCollideSpatial,
  buildApply, buildClearAtomicU32,
} from '../decollision-tsl.js';
import {
  resolveBaseSize, resolveScale, resolveFill, resolveOpacity, resolveFocus,
} from './dotAppearance.js';
import { usePulseAnimation } from '../usePulseAnimation.js';
import { calculateAdaptiveRingRadius } from '../pulseRingUtils.js';
import { CAMERA_FOV_DEGREES } from './cameraUtils.js';

const ALPHA_DECAY = 0.0228; // d3-force defaults
const ALPHA_MIN = 0.001;
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

// Per-instance appearance: color/alpha/focus/scale. Lives in its own buffers so
// restyling (hover, selection, pulse, semantic colors) writes these in place
// without touching the position buffers or resetting the decollision alpha.
// `scale` is the *render* size (base size × hover) and is separate from the
// physics radii buffer, so hover enlargement never perturbs the sim. Seeded at
// build so the first paint is correct (the restyle effect runs after commit).
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

// Read the settled GPU positions back to the CPU once the sim has come to
// rest. Positions are stored in world convention (worldY = -item.y; see
// buildPhysicsBuffers), so the inverse negation restores viewBox-space y for
// the caller. With decollisioning off the GPU never ran, so the seed IS final.
async function readSettledData(renderer, buffers, data, decollisioned) {
  if (!decollisioned) return data;
  const arrayBuffer = await renderer.getArrayBufferAsync(buffers.positions.value);
  const pos = new Float32Array(arrayBuffer);
  const out = new Array(data.length);
  let nonFinite = 0;
  for (let i = 0; i < data.length; i++) {
    const x = pos[i * 2];
    const y = -pos[i * 2 + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      out[i] = { ...data[i], x, y };
    } else {
      // The GPU sim can diverge a dot to NaN (e.g. two dots at the exact same
      // spot normalize a zero vector). Keep its finite seed position so
      // processedData stays clean — a single NaN poisons boundsForData and
      // every fit/zoom that reads it.
      out[i] = data[i];
      nonFinite++;
    }
  }
  if (nonFinite > 0) console.warn(`[r3f-webgpu] readback kept seed for ${nonFinite}/${data.length} non-finite settled positions`);
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
  enableDecollisioning = true,
  onSettle,
}) {
  const gl = useThree((s) => s.gl);

  const cosmeticOpts = {
    defaultColor, defaultSize, defaultOpacity, dotStyles, radiusOverrides,
    hoveredId, hoverSizeMultiplier, hoverOpacity,
  };

  // Physics buffers rebuild only when the point set or its sizes change —
  // seeding the sim from raw positions and (via `pipeline`) resetting the
  // alpha schedule. Cosmetic restyle deliberately does NOT invalidate these.
  const buffers = useMemo(
    () => (data && data.length ? buildPhysicsBuffers(data, { defaultSize, radiusOverrides }) : null),
    [data, defaultSize, radiusOverrides],
  );

  // Cosmetic buffers are sized to the physics buffers, seeded with the current
  // style, and rewritten in place on restyle — so hover/selection/pulse never
  // restart the decollision. The seed-at-build deps intentionally exclude the
  // style inputs: the effect below handles restyle without a rebuild.
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

  // Hovered instance index, read in-shader by the main mesh (to drop it) and the overlay (to redraw it on top).
  const hoveredIndexU = useMemo(() => uniform(NO_HOVER_INDEX, 'uint'), []);

  // Device px per world unit at the dot plane (z=0), refreshed each frame so the
  // min-screen-size clamp in buildDotMesh tracks zoom. Seeded large so dots are
  // not enlarged on the first frame, before the real value lands.
  const pxPerWorldU = useMemo(() => uniform(float(1e6)), []);
  useFrame((state) => {
    pxPerWorldU.value = (state.size.height / (2 * state.camera.position.z * TAN_HALF_FOV)) * state.gl.getPixelRatio();
  });

  const mesh = useMemo(() => {
    if (!buffers || !cosmetic) return null;
    // Collapse the hovered instance to zero size so it draws once: the overlay
    // redraws it on top (the canvas renderer draws the hovered dot last).
    const scaleMul = select(instanceIndex.equal(hoveredIndexU), float(0), float(1));
    return buildDotMesh(instanceIndex, buffers.N, { cosmetic, buffers, dotStroke, dotStrokeWidthFraction, scaleMul, pxPerWorldU });
  }, [buffers, cosmetic, dotStroke, dotStrokeWidthFraction, hoveredIndexU, pxPerWorldU]);

  // Redraw the hovered dot after the main mesh (renderOrder 1) so it sits on top
  // of overlapping dots, matching the canvas renderer.
  const hoverMesh = useMemo(() => {
    if (!buffers || !cosmetic) return null;
    const m = buildDotMesh(hoveredIndexU, 1, { cosmetic, buffers, dotStroke, dotStrokeWidthFraction, pxPerWorldU });
    m.renderOrder = 1;
    m.visible = false;
    return m;
  }, [buffers, cosmetic, dotStroke, dotStrokeWidthFraction, hoveredIndexU, pxPerWorldU]);

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

  // Settled positions cached for the pulse ring (which needs CPU positions to
  // place its disc behind the playing dot). Set once at readback.
  const settledRef = useRef(null);

  // One-shot GPU→CPU readback at settle. The sim is GPU-resident, so the CPU
  // has no idea where the dots ended up — camera-fit, hover, click, and the
  // pulse ring all need those positions. Reset whenever the physics buffers
  // rebuild (new point set), so each fresh decollision fires its own settle.
  const settleFiredRef = useRef(false);
  useEffect(() => { settleFiredRef.current = false; settledRef.current = null; }, [buffers]);

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
    if (settleFiredRef.current || !buffers || !data?.length) return;
    settleFiredRef.current = true;
    readSettledData(gl, buffers, data, enableDecollisioning).then((settled) => {
      settledRef.current = settled;
      onSettle?.(settled);
    });
  });

  // ── Pulse (ring + dot size/opacity oscillation) ──────────────────────────
  // Same machinery as R3FDots: usePulseAnimation drives a phase clock, this
  // useFrame reads it and writes pulsing dots' size/opacity into the cosmetic
  // buffers + drives a separate ring layer. Renderer-agnostic timing/sizing
  // (usePulseAnimation, calculateAdaptiveRingRadius) is reused as-is.
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
    </>
  );
}
