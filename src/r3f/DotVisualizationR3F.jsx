import React, {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import * as d3 from 'd3';
import { Canvas } from '@react-three/fiber';
import { WebGPURenderer } from 'three/webgpu';
import { R3FScene, CameraInitializer, HoverDetector, CameraSetter, CameraReporter } from './R3FScene.jsx';
import { R3FCamera } from './R3FCamera.jsx';
import { R3FDotsWebGPU, BASE_MAX_SOLVER_ITERATIONS, CONSTRAINT_MAX_SOLVER_ITERATIONS } from './R3FDotsWebGPU.jsx';
import { makeGpuExecutor } from './gpuDecollisionExecutor.js';
import { CAMERA_FOV_DEGREES } from './cameraUtils.js';
import { boundsForData, computeFitTransformToVisible } from '../utils.js';
import { useDecollisionScheduler } from '../useDecollisionScheduler.js';
import { useStablePositions } from '../useStablePositions.js';
import { usePositionChangeDetection } from '../usePositionChangeDetection.js';
import { resolveDataEffectPositions } from '../DotVisualization.jsx';
import { useLatest } from '../useLatest.js';

const CAMERA_FOV_RAD = CAMERA_FOV_DEGREES * (Math.PI / 180);
const EMPTY_RADIUS_OVERRIDES = new Map();

// Filter to finite-coordinate items and assign fallback ids. Shared by the
// initial processedData seed and the WebGPU seed memo so both produce the same
// ids/ordering for metadata, picking, and explicit callback payloads.
function validateData(data) {
  if (!data || data.length === 0) return [];
  let out = null;
  for (let i = 0; i < data.length; i += 1) {
    const item = data[i];
    const valid = typeof item.x === 'number' && typeof item.y === 'number'
      && Number.isFinite(item.x) && Number.isFinite(item.y);
    const needsFallbackId = valid && item.id === undefined;
    if (!valid || needsFallbackId) {
      if (!out) out = data.slice(0, i);
      if (valid) out.push({ ...item, id: i });
    } else if (out) {
      out.push(item);
    }
  }
  return out ?? data;
}

// Match DotVisualization's viewBox convention: height = 100, width = 100 *
// (W/H). Data positions, initialTransform, and the {x, y, k} transforms
// exchanged through the imperative handle all live in this space, so R3F
// and Canvas can be used interchangeably and transformToCSSPixels works
// the same way against either.
const R3F_VIEWBOX_HEIGHT = 100;
const viewBoxForContainer = (rect) => [
  0,
  0,
  R3F_VIEWBOX_HEIGHT * (rect.width / rect.height),
  R3F_VIEWBOX_HEIGHT,
];

/**
 * Drop-in replacement for DotVisualization using R3F (WebGL) rendering.
 *
 * Supports the same core props:
 *   data, edges, dotStyles, defaultColor, defaultSize, defaultOpacity
 *   dotStroke, dotStrokeWidth, hoverSizeMultiplier, hoverOpacity
 *   edgeColor, edgeOpacity
 *   onHover, onLeave, onClick, onBackgroundClick, onDragStart
 *   enableDecollisioning, isIncrementalUpdate, positionsAreIntermediate, cacheKey
 *   initialTransform, className, style, children
 */
const DotVisualizationR3F = forwardRef(function DotVisualizationR3F(props, ref) {
  const {
    backend = 'webgl',
    data = [],
    dataKey = null,
    streamingPositions = null,
    edges = [],
    dotStyles = new Map(),
    defaultColor = null,
    defaultSize = 2,
    defaultOpacity = 0.7,
    dotStroke = '#111',
    // Fraction of dot radius (0-1). e.g. 0.05 = 5%, 0.15 = 15%.
    // Unlike DotVisualization's dotStrokeWidth (world units), this is unitless.
    dotStrokeWidthFraction = 0.05,
    hoverSizeMultiplier = 1.5,
    hoverOpacity = 1.0,
    blockHoverDuringInteraction = false,
    edgeColor = '#999',
    edgeOpacity = 0.3,
    showEdges = true,
    onHover,
    onLeave,
    onClick,
    onBackgroundClick,
    onDragStart,
    onDecollisionComplete,
    onDecollisionVisualComplete,
    enableDecollisioning = true,
    decollisionEngine = 'auto',
    isIncrementalUpdate = false,
    transitionDuration = 500,
    transitionEasing = d3.easeCubicOut,
    positionsAreIntermediate = false,
    scopeKey = 'default',
    constraintKey = '',
    radiusOverrides = EMPTY_RADIUS_OVERRIDES,
    sharedPositionCache = null,
    initialTransform = null,
    occludeLeft = 0,
    occludeRight = 0,
    occludeTop = 0,
    occludeBottom = 0,
    className = '',
    style = {},
    children,
    sceneChildren,
    // R3F render-loop mode for the WebGPU Canvas. Default 'always' (continuous
    // 60fps). A consumer can pass 'never'/'demand' to stop the continuous render
    // when the map isn't meaningfully visible (e.g. behind a loading overlay, or
    // while an off-thread GPU layout compute needs the GPU) — rendering 100k+
    // dots into a covered/hidden canvas otherwise starves that compute.
    frameloop = 'always',
    // WebGPU-only: how many solver iterations to submit per rendered frame.
    // Defaults to R3FDotsWebGPU's historical value; large non-interactive maps
    // can raise this to avoid stretching cheap GPU work across congested frames.
    webgpuSolverIterationsPerFrame = undefined,
    // WebGPU-only: soft CPU submit budget for solver work in each frame.
    // The GPU work is async, but this prevents command submission from growing
    // past a bounded slice of the frame when the renderer is already busy.
    webgpuSolverFrameBudgetMs = undefined,
    // WebGPU-only: for base solves, stop after RDV's known-good visual minimum
    // iteration count instead of synchronizing the GPU queue for a convergence
    // metric readback. Constraint/focus solves still use the metric.
    webgpuBaseFixedIterations = false,
    // WebGPU-only: emit decollision timing diagnostics to console.
    webgpuDecollisionDebug = false,
  } = props;

  // Initialize with the input data (filtered for finite coords) so the very
  // first paint shows dots at their real positions. Without this seed,
  // `processedData = []` on render 1 made R3FDots fall through to its
  // `count = data.length || 1` path and render one identity-matrix instance
  // at world origin — the "rogue centered dot" symptom.
  // The WebGPU branch reads `webgpuSeedData` instead, so skip the duplicate
  // full validateData pass at mount when it would never be read.
  const [processedData, setProcessedData] = useState(() =>
    backend === 'webgpu' ? [] : validateData(data),
  );
  const [hoveredId, setHoveredId] = useState(null);

  // The WebGPU dots layer is seeded from the validated input and then owns
  // position animation on the GPU. The React data surface in the WebGPU branch
  // is metadata/order only; settled positions stay out of React state so clients
  // cannot accidentally depend on a huge hidden CPU mirror.
  const webgpuSeedData = useMemo(() => validateData(data), [data]);
  const controlData = backend === 'webgpu' ? webgpuSeedData : processedData;

  const cameraInitialized = useRef(false);

  // Switching backend remounts the Canvas with a fresh camera, so let the new
  // camera re-fit. Done at render time (not in an effect) so it lands before
  // the freshly-mounted CameraInitializer's fit effect reads the flag.
  const prevBackendRef = useRef(backend);
  if (prevBackendRef.current !== backend) {
    prevBackendRef.current = backend;
    cameraInitialized.current = false;
  }

  // Camera state for zoom/pan persistence across renderer switches.
  const cameraStateRef = useRef(null);
  // Container ref for measuring dimensions when computing D3-compatible zoom transform.
  const containerRef = useRef(null);
  // Ref to programmatically set camera position from outside the Canvas.
  const setCameraPositionRef = useRef(null);

  // ── Decollision plumbing ─────────────────────────────────────────────────
  // Same refs Canvas uses, so `useDecollisionScheduler` drives both renderers
  // identically. `liveTransitionDataRef` carries per-tick simulation frames;
  // R3FDots reads that ref directly instead of receiving those frames through
  // React state.
  const dataRef = useRef([]);
  const processedDataRef = useRef([]);
  const liveTransitionDataRef = useRef(null);
  const previousDataRef = useRef([]);
  const schedulerRef = useRef(null);
  const constraintKeyRef = useLatest(constraintKey);

  // R3F owns its own pan/zoom (camera-space, not d3-zoom), so the scheduler's
  // "skip publishing intermediate frames during interaction" gate is a no-op
  // here. The refs still need to exist for the scheduler's API.
  const alwaysFalseRef = useRef(false);

  // WebGPU command channel: the GPU executor (below) writes sim/lerp requests
  // here; R3FDotsWebGPU consumes them inside its useFrame and runs the work on
  // the GPU. A plain ref object decouples the scheduler (here, outside the
  // Canvas) from the GPU work (inside it), race-free against the lazy mount.
  const gpuControlRef = useRef({ request: null });
  // Pick channel: R3FDotsWebGPU publishes a GPU pick fn here, HoverDetector
  // drives it. Lets WebGPU hit-test against the live position buffer (so hover/
  // click track the moving dots during decollision) instead of a CPU spatial
  // grid built from the settled layout.
  const pickControlRef = useRef(null);
  // True while the camera is being dragged. R3FCamera flips it on pan
  // start/end; HoverDetector reads it (when blockHoverDuringInteraction is on)
  // to suppress hover acquisition during a pan.
  const interactionRef = useRef(false);
  // HoverDetector publishes its pick logic here; R3FCamera's pan handler invokes
  // it on a genuine click (the single click-vs-drag authority).
  const clickControlRef = useRef(null);
  const gpuExecutor = useMemo(
    () => makeGpuExecutor(gpuControlRef, {
      baseMaxIterations: BASE_MAX_SOLVER_ITERATIONS,
      constraintMaxIterations: CONSTRAINT_MAX_SOLVER_ITERATIONS,
      solverIterationsPerFrame: webgpuSolverIterationsPerFrame,
      solverFrameBudgetMs: webgpuSolverFrameBudgetMs,
      baseFixedIterations: webgpuBaseFixedIterations,
    }),
    [webgpuBaseFixedIterations, webgpuSolverFrameBudgetMs, webgpuSolverIterationsPerFrame],
  );

  const { updateStablePositions, shouldUseStablePositions } = useStablePositions();
  const hasPositionsChanged = usePositionChangeDetection(defaultSize);

  // Scheduler callback: every simulation tick pushes new node positions in.
  // Do NOT setState — that re-renders R3FDots and forces its full instance-
  // matrix rebuild for all dots, 60 times per second. Canvas avoids this by
  // calling `renderCanvasWithData` imperatively; R3F's equivalent is the
  // useFrame loop inside R3FDots, which reads `liveTransitionDataRef` per
  // frame and updates only the instance positions. State only changes at
  // simulation completion via `syncDecollisionState`. WebGPU completion is
  // GPU-owned and does not publish settled positions through React state.
  const onUpdateNodes = useCallback((nodes) => {
    liveTransitionDataRef.current = nodes;
  }, []);

  // Scheduler callback: simulation settled (base or constraint complete).
  // updateStablePositions is intentionally skipped here: R3F never reads the
  // resulting `stablePositions` state (only Canvas does). Calling it on every
  // sim completion would spread+setState a 67k array for no consumer.
  const syncDecollisionState = useCallback((finalData) => {
    liveTransitionDataRef.current = null;
    if (finalData) {
      processedDataRef.current = finalData;
      if (backend !== 'webgpu') {
        setProcessedData(finalData);
      }
    }
  }, [backend]);

  // Data effect — mirrors Canvas's data effect minus the zoom/auto-fit pieces.
  // Validates input, detects scope/length changes (which need a fresh base
  // decollision), restores cached positions on unchanged re-renders, and
  // hands off to the scheduler for actual simulation.
  useEffect(() => {
    if (!data || data.length === 0) {
      processedDataRef.current = [];
      if (backend !== 'webgpu') {
        setProcessedData([]);
      }
      return;
    }

    const validData = validateData(data);
    if (validData.length === 0) return;

    let scopeChangedThisRender = false;
    if (sharedPositionCache) {
      scopeChangedThisRender = sharedPositionCache.checkScope(scopeKey);
      if (scopeChangedThisRender && schedulerRef.current) {
        dataRef.current = validData;
        schedulerRef.current.decollideForConstraint('');
      }
    }

    const prevLength = previousDataRef.current?.length ?? 0;
    if (
      !scopeChangedThisRender &&
      schedulerRef.current &&
      prevLength > 0 &&
      prevLength !== validData.length
    ) {
      dataRef.current = validData;
      schedulerRef.current.decollideForConstraint('');
    }

    const { processedData: processedValidData } = resolveDataEffectPositions({
      validData,
      previousData: previousDataRef.current,
      positionsAreIntermediate,
      cachedPositions: sharedPositionCache?.cache.get(constraintKeyRef.current) ?? null,
      previousProcessedData: processedDataRef.current,
      hasPositionsChangedFn: hasPositionsChanged,
    });

    previousDataRef.current = positionsAreIntermediate
      ? validData
      : validData.map(item => ({ ...item }));
    if (!scopeChangedThisRender) {
      dataRef.current = processedValidData;
    }

    const keepStable = shouldUseStablePositions(
      isIncrementalUpdate || positionsAreIntermediate,
      constraintKeyRef.current,
      validData.length,
    );
    if (!keepStable) {
      processedDataRef.current = processedValidData;
      if (backend !== 'webgpu') {
        setProcessedData(processedValidData);
      }
    }
  }, [
    backend,
    data,
    scopeKey,
    isIncrementalUpdate,
    positionsAreIntermediate,
    sharedPositionCache,
    hasPositionsChanged,
    shouldUseStablePositions,
    constraintKeyRef,
  ]);

  const scheduler = useDecollisionScheduler({
    dataRef,
    processedDataRef,
    liveTransitionDataRef,
    cache: sharedPositionCache,
    positionsAreIntermediate,
    constraintKey,
    radiusOverrides,
    decollisionEngine,
    defaultSize,
    onUpdateNodes,
    onBaseReady: onDecollisionComplete,
    onConstraintReady: (finalData) => onDecollisionComplete?.(finalData),
    syncDecollisionState,
    onSimulationRunningChange: () => {},
    sendMetrics: false,
    isDraggingRef: alwaysFalseRef,
    interactionActiveRef: alwaysFalseRef,
    enabled: enableDecollisioning,
    // WebGPU runs decollision on the GPU via this executor (sim + lerp stay in
    // GPU buffers, no per-frame readback); CPU/WebGL use the default executor.
    executor: backend === 'webgpu' ? gpuExecutor : null,
  });

  schedulerRef.current = scheduler;

  const handleDotClick = useCallback((item, event) => {
    onClick?.(item, event);
  }, [onClick]);

  const handleBackgroundClick = useCallback((event) => {
    onBackgroundClick?.(event);
  }, [onBackgroundClick]);

  const handleCameraStateChange = useCallback((state) => {
    cameraStateRef.current = state;
  }, []);

  // Camera-report plumbing for the webgpu branch (R3FScene supplies its own for
  // the WebGL branch). R3FCamera calls handleTransformChange on every pan/zoom;
  // CameraReporter wires reportCameraRef to push the live camera position into
  // cameraStateRef so getZoomTransform stays current.
  const reportCameraRef = useRef(null);
  const handleTransformChange = useCallback(() => {
    reportCameraRef.current?.();
  }, []);

  // Convert a viewBox-space D3 transform {x, y, k} to a Three.js camera
  // position. The transform lives in the same coordinate space Canvas's
  // ZoomManager uses ([0, 0, 100*aspect, 100]); the camera-world frame
  // numerically matches viewBox coords with Y negated when data is placed
  // (`_dummy.position.set(item.x, -item.y, 0)` in R3FDots), so this conversion
  // is the algebraic inverse of getZoomTransform below.
  const d3ToCamera = useCallback((transform, W, H) => {
    const { x, y, k } = transform;
    const vbH = R3F_VIEWBOX_HEIGHT;
    const vbW = (W / H) * vbH;
    const cx = (vbW / 2 - x) / k;
    const cy = (y - vbH / 2) / k;
    const cz = vbH / (k * 2 * Math.tan(CAMERA_FOV_RAD / 2));
    return { x: cx, y: cy, z: Math.max(0.5, Math.min(5000, cz)) };
  }, []);

  // Compute the viewBox-space fit transform honoring occlusion. Shares the
  // math + convention with Canvas's ZoomManager.
  const computeFit = useCallback((dataToUse, margin) => {
    if (!containerRef.current || !dataToUse?.length) return null;
    const rect = containerRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const bounds = boundsForData(dataToUse, defaultSize);
    const viewBox = viewBoxForContainer(rect);
    const occlusion = { left: occludeLeft, right: occludeRight, top: occludeTop, bottom: occludeBottom };
    return computeFitTransformToVisible(bounds, viewBox, rect, occlusion, margin);
  }, [defaultSize, occludeLeft, occludeRight, occludeTop, occludeBottom]);

  const getCpuPositionData = useCallback(() => {
    const refData = processedDataRef.current;
    return refData?.length ? refData : controlData;
  }, [controlData]);

  // Initial-fit camera target for CameraInitializer's bounds-fit branch.
  // Reuses the occlusion-aware computeFit + d3ToCamera pipeline that
  // zoomToVisible uses, so the first paint centers identically to Canvas's
  // autoFitToVisible (which honors occludeLeft/Right/Top/Bottom) instead of
  // centering the raw centroid on the full canvas.
  const computeInitialFitTarget = useCallback(() => {
    if (!containerRef.current) return null;
    const fit = computeFit(controlData, 0.9);
    if (!fit) return null;
    const rect = containerRef.current.getBoundingClientRect();
    return d3ToCamera(fit, rect.width, rect.height);
  }, [computeFit, d3ToCamera, controlData]);

  // Imperative handle — implements the DotVisualization API surface
  useImperativeHandle(ref, () => ({
    zoomToVisible: async (
      duration = 0,
      easing = d3.easeCubicInOut,
      dataOverride = null,
      marginOverride = null,
      _updateExtents = true,
      maxScale = Infinity
    ) => {
      if (!containerRef.current || !setCameraPositionRef.current) return false;
      const dataToUse = dataOverride || getCpuPositionData();
      const margin = marginOverride ?? 0.9;
      const fit = computeFit(dataToUse, margin);
      if (!fit) return false;

      const rect = containerRef.current.getBoundingClientRect();
      const W = rect.width, H = rect.height;

      // Cap k at maxScale; re-center bounds in the visible (occlusion-aware)
      // region at the capped k. Done in viewBox-space — mirrors the
      // Canvas ZoomManager's matching block so behavior stays in lockstep.
      let { k, x, y } = fit;
      if (k > maxScale) {
        k = maxScale;
        const bounds = boundsForData(dataToUse, defaultSize);
        const cx = (bounds.minX + bounds.maxX) / 2;
        const cy = (bounds.minY + bounds.maxY) / 2;
        const [vbX, vbY, vbW, vbH] = viewBoxForContainer(rect);
        const sx = W / vbW;
        const sy = H / vbH;
        const visWpx = Math.max(1, W - occludeLeft - occludeRight);
        const visHpx = Math.max(1, H - occludeTop - occludeBottom);
        const visCxVb = vbX + (occludeLeft + visWpx / 2) / sx;
        const visCyVb = vbY + (occludeTop + visHpx / 2) / sy;
        x = visCxVb - k * cx;
        y = visCyVb - k * cy;
      }

      const target = d3ToCamera({ x, y, k }, W, H);

      if (duration <= 0) {
        setCameraPositionRef.current(target.x, target.y, target.z);
        cameraStateRef.current = { ...target };
        return true;
      }

      // Animated ease from current camera to target. Linear interpolation in
      // camera-position space with the easing applied to t.
      const startCam = cameraStateRef.current
        ? { ...cameraStateRef.current }
        : { x: target.x, y: target.y, z: target.z };
      const t0 = performance.now();
      return new Promise((resolve) => {
        const tick = () => {
          const elapsed = performance.now() - t0;
          const t = Math.min(1, elapsed / duration);
          const e = easing(t);
          const cx = startCam.x + (target.x - startCam.x) * e;
          const cy = startCam.y + (target.y - startCam.y) * e;
          const cz = startCam.z + (target.z - startCam.z) * e;
          setCameraPositionRef.current(cx, cy, cz);
          cameraStateRef.current = { x: cx, y: cy, z: cz };
          if (t < 1) requestAnimationFrame(tick);
          else resolve(true);
        };
        requestAnimationFrame(tick);
      });
    },
    getVisibleDotCount: () => getCpuPositionData().length,
    getZoomTransform: () => {
      const cam = cameraStateRef.current;
      if (!cam || !containerRef.current) return null;
      const { width: W, height: H } = containerRef.current.getBoundingClientRect();
      if (!W || !H) return null;
      // Inverse of d3ToCamera: return the viewBox-space {x, y, k} that
      // Canvas's ZoomManager would produce for the same camera position.
      const vbH = R3F_VIEWBOX_HEIGHT;
      const vbW = (W / H) * vbH;
      const k = vbH / (cam.z * 2 * Math.tan(CAMERA_FOV_RAD / 2));
      return {
        x: vbW / 2 - cam.x * k,
        y: cam.y * k + vbH / 2,
        k,
      };
    },
    getFitTransform: (dataOverride = null, marginOverride = null) => {
      const dataToUse = dataOverride || getCpuPositionData();
      const margin = marginOverride ?? 0.9;
      return computeFit(dataToUse, margin);
    },
    setZoomTransform: (transform, _options = {}) => {
      if (!containerRef.current || !setCameraPositionRef.current) return false;
      const { width: W, height: H } = containerRef.current.getBoundingClientRect();
      if (!W || !H || !transform.k) return false;
      const target = d3ToCamera(transform, W, H);
      setCameraPositionRef.current(target.x, target.y, target.z);
      cameraStateRef.current = { ...target };
      return true;
    },
    updateVisibleDotCount: () => {},
    cancelDecollision: () => {
      scheduler.cancelSimulation();
    },
    getCurrentPositions: () => getCpuPositionData(),
  }), [getCpuPositionData, defaultSize, computeFit, d3ToCamera, occludeLeft, occludeRight, occludeTop, occludeBottom, scheduler]);

  return (
    <div
      ref={containerRef}
      className={`dot-visualization-r3f ${className}`}
      style={{ width: '100%', height: '100%', position: 'relative', ...style }}
    >
      {backend === 'webgpu' ? (
        // `flat linear` make the dots blend in gamma space, matching the 2D
        // canvas / WebGL paths. By default R3F sets outputColorSpace=sRGB +
        // ACESFilmic toneMapping, which makes WebGPURenderer draw into a linear
        // float intermediate and sRGB-encode in a post pass — so transparency
        // blends in LINEAR space and reads dark/over-saturated (three.js #33104).
        // `linear` (outputColorSpace=LinearSRGB) + `flat` (NoToneMapping) drop
        // that intermediate; the dot materials sRGB-encode their own color
        // (createBevelStrokeNodeMaterial / createPulseDiscNodeMaterial), so the
        // GPU blends already-encoded values = gamma space, like the GLSL path's
        // inline `#include <colorspace_fragment>`.
        <Canvas
          style={{ position: 'absolute', inset: 0 }}
          flat
          linear
          frameloop={frameloop}
          dpr={[1, 2]}
          camera={{
            fov: CAMERA_FOV_DEGREES,
            near: 0.01,
            far: 100000,
            position: [0, 0, 65],
          }}
          gl={async (props) => {
            // depth:false — flat 2D scene writes no depth (materials are
            // depthWrite:false, layering is renderOrder). Also dodges a three
            // r184 stale-depth-attachment-on-resize bug that intermittently
            // blanks the graph (see memory: webgpu-depth-stale-on-resize).
            const renderer = new WebGPURenderer({ ...props, depth: false });
            await renderer.init();
            return renderer;
          }}
        >
          <CameraInitializer
            data={controlData}
            initialized={cameraInitialized}
            initialTransform={initialTransform}
            computeFitTarget={computeInitialFitTarget}
            onInit={handleCameraStateChange}
          />
          <CameraReporter reportRef={reportCameraRef} onCameraStateChange={handleCameraStateChange} />
          <CameraSetter setCameraRef={setCameraPositionRef} />
          <R3FCamera onTransformChange={handleTransformChange} data={controlData} interactionRef={interactionRef} clickControlRef={clickControlRef} />
          <R3FDotsWebGPU
            data={webgpuSeedData}
            dataKey={dataKey}
            streamingPositions={streamingPositions}
            dotStyles={dotStyles}
            radiusOverrides={radiusOverrides}
            defaultSize={defaultSize}
            defaultColor={defaultColor}
            defaultOpacity={defaultOpacity}
            dotStroke={dotStroke}
            dotStrokeWidthFraction={dotStrokeWidthFraction}
            hoveredId={hoveredId}
            hoverSizeMultiplier={hoverSizeMultiplier}
            hoverOpacity={hoverOpacity}
            positionsAreIntermediate={positionsAreIntermediate}
            decollisionEnabled={enableDecollisioning}
            decollisionDebug={webgpuDecollisionDebug}
            onDecollisionVisualComplete={onDecollisionVisualComplete}
            gpuControlRef={gpuControlRef}
            pickControlRef={pickControlRef}
          />
          <HoverDetector
            data={controlData}
            radiusOverrides={radiusOverrides}
            defaultSize={defaultSize}
            hoverSizeMultiplier={hoverSizeMultiplier}
            onHover={onHover}
            onLeave={onLeave}
            onHoveredIdChange={setHoveredId}
            onDotClick={handleDotClick}
            onBackgroundClick={handleBackgroundClick}
            pickControlRef={pickControlRef}
            interactionRef={blockHoverDuringInteraction ? interactionRef : null}
            clickControlRef={clickControlRef}
          />
          {/* In-scene overlay (e.g. ClusterLabels3D) — rendered inside the R3F
              scene so it can read the camera/zoom via useThree/useFrame. */}
          {sceneChildren}
        </Canvas>
      ) : (
        <Canvas
          style={{ position: 'absolute', inset: 0 }}
          dpr={[1, 2]}
          camera={{
            fov: CAMERA_FOV_DEGREES,
            near: 0.01,
            far: 100000,
            position: [0, 0, 65],
          }}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
        >
          <R3FScene
            data={processedData}
            edges={edges}
            dotStyles={dotStyles}
            defaultColor={defaultColor}
            defaultSize={defaultSize}
            defaultOpacity={defaultOpacity}
            dotStroke={dotStroke}
            dotStrokeWidthFraction={dotStrokeWidthFraction}
            hoveredId={hoveredId}
            onHover={onHover}
            onLeave={onLeave}
            onHoveredIdChange={setHoveredId}
            onDotClick={handleDotClick}
            onBackgroundClick={handleBackgroundClick}
            hoverSizeMultiplier={hoverSizeMultiplier}
            hoverOpacity={hoverOpacity}
            edgeColor={edgeColor}
            edgeOpacity={edgeOpacity}
            showEdges={showEdges}
            radiusOverrides={radiusOverrides}
            cameraInitialized={cameraInitialized}
            initialTransform={initialTransform}
            computeFitTarget={computeInitialFitTarget}
            onCameraStateChange={handleCameraStateChange}
            setCameraRef={setCameraPositionRef}
            liveTransitionDataRef={liveTransitionDataRef}
            blockHoverDuringInteraction={blockHoverDuringInteraction}
          />
          {sceneChildren}
        </Canvas>
      )}

      {/* Overlay children (e.g. labels, tooltips) */}
      {children && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {children}
        </div>
      )}
    </div>
  );
});

export default DotVisualizationR3F;
