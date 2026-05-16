import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import * as d3 from 'd3';
import { Canvas } from '@react-three/fiber';
import { R3FScene } from './R3FScene.jsx';
import { decollisioning } from '../decollisioning.js';
import { getDotSize } from '../dotUtils.js';
import { CAMERA_FOV_DEGREES } from './cameraUtils.js';
import { boundsForData, computeFitTransformToVisible } from '../utils.js';

const CAMERA_FOV_RAD = CAMERA_FOV_DEGREES * (Math.PI / 180);
const EMPTY_RADIUS_OVERRIDES = new Map();

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
    data = [],
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
    edgeColor = '#999',
    edgeOpacity = 0.3,
    showEdges = true,
    onHover,
    onLeave,
    onClick,
    onBackgroundClick,
    onDragStart,
    onDecollisionComplete,
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
  } = props;

  // Initialize with the input data (filtered for finite coords) so the very
  // first paint shows dots at their real positions. Without this seed,
  // `processedData = []` on render 1 made R3FDots fall through to its
  // `count = data.length || 1` path and render one identity-matrix instance
  // at world origin — the "rogue centered dot" symptom.
  const [processedData, setProcessedData] = useState(() => {
    if (!data || data.length === 0) return [];
    const out = [];
    for (let i = 0; i < data.length; i += 1) {
      const item = data[i];
      if (typeof item.x === 'number' && typeof item.y === 'number'
          && Number.isFinite(item.x) && Number.isFinite(item.y)) {
        out.push(item.id !== undefined ? item : { ...item, id: i });
      }
    }
    return out;
  });
  const [hoveredId, setHoveredId] = useState(null);

  const decollisionSimRef = useRef(null);
  const memoizedPositions = useRef(new Map());
  const stablePositionsRef = useRef([]);
  const dotStylesRef = useRef(dotStyles);
  const defaultSizeRef = useRef(defaultSize);
  const onDecollisionCompleteRef = useRef(onDecollisionComplete);
  const prevConstraintKeyRef = useRef(constraintKey);
  const cameraInitialized = useRef(false);

  // Camera state for zoom/pan persistence across renderer switches.
  const cameraStateRef = useRef(null);
  // Container ref for measuring dimensions when computing D3-compatible zoom transform.
  const containerRef = useRef(null);
  // Ref to programmatically set camera position from outside the Canvas.
  const setCameraPositionRef = useRef(null);

  useEffect(() => {
    dotStylesRef.current = dotStyles;
  }, [dotStyles]);

  useEffect(() => {
    defaultSizeRef.current = defaultSize;
  }, [defaultSize]);

  useEffect(() => {
    onDecollisionCompleteRef.current = onDecollisionComplete;
  }, [onDecollisionComplete]);

  // Clear memoized positions when constraint key changes
  useEffect(() => {
    if (prevConstraintKeyRef.current !== constraintKey) {
      memoizedPositions.current.clear();
      stablePositionsRef.current = [];
      prevConstraintKeyRef.current = constraintKey;
    }
  }, [constraintKey]);

  // Validate and assign IDs
  const ensureIds = useCallback((d) =>
    d.map((item, i) => ({ ...item, id: item.id !== undefined ? item.id : i })),
    []
  );

  // Run decollision when data changes
  useEffect(() => {
    if (!data || data.length === 0) {
      setProcessedData([]);
      stablePositionsRef.current = [];
      return;
    }

    const withIds = ensureIds(data);
    const valid = withIds.filter(item => typeof item.x === 'number' && typeof item.y === 'number');
    if (valid.length === 0) return;

    // Stop any running simulation
    if (decollisionSimRef.current) {
      decollisionSimRef.current.stop();
      decollisionSimRef.current = null;
    }

    if (positionsAreIntermediate) {
      setProcessedData(valid);
      return;
    }

    if (!enableDecollisioning) {
      // Match Canvas: when decollision is disabled, render input positions as-is
      // and never run a simulation. Restore memoized results if any so positions
      // stay stable across re-renders.
      const positioned = memoizedPositions.current.size > 0
        ? valid.map(item => {
            const memo = memoizedPositions.current.get(item.id);
            return memo ? { ...item, x: memo.x, y: memo.y } : item;
          })
        : valid;
      stablePositionsRef.current = positioned.map(node => ({ ...node }));
      setProcessedData(positioned);
      return;
    }

    // Seed from shared cross-renderer cache on first mount so we can immediately
    // show decollisioned positions without running a catch-up simulation.
    if (sharedPositionCache?.current?.size > 0 && memoizedPositions.current.size === 0) {
      for (const item of valid) {
        const cached = sharedPositionCache.current.get(item.id);
        if (cached) {
          memoizedPositions.current.set(item.id, {
            inputX: item.x,
            inputY: item.y,
            x: cached.x,
            y: cached.y,
          });
        }
      }
    }

    // Check if positions changed vs memoized
    const allMemoized = valid.every(item => {
      const memo = memoizedPositions.current.get(item.id);
      return memo && Math.abs(memo.inputX - item.x) < 0.001 && Math.abs(memo.inputY - item.y) < 0.001;
    });

    if (allMemoized && memoizedPositions.current.size === valid.length) {
      const restored = valid.map(item => {
        const memo = memoizedPositions.current.get(item.id);
        return { ...item, x: memo.x, y: memo.y };
      });
      stablePositionsRef.current = restored.map((node) => ({ ...node }));
      setProcessedData(restored);
      return;
    }

    // Incremental updates keep rendering previously stable positions while decollision runs.
    if (isIncrementalUpdate && stablePositionsRef.current.length > 0) {
      setProcessedData(stablePositionsRef.current);
    } else if (!isIncrementalUpdate) {
      // Full renders stream intermediate positions.
      setProcessedData(valid);
    }

    const fnDotSize = (item) => getDotSize(item, dotStylesRef.current, defaultSizeRef.current);
    const inputById = new Map(valid.map((item) => [item.id, item]));
    const transitionConfig = isIncrementalUpdate
      ? {
          enabled: true,
          stablePositions: stablePositionsRef.current.length > 0
            ? stablePositionsRef.current
            : valid,
          duration: transitionDuration,
          easing: transitionEasing,
        }
      : null;

    const skipFrames = isIncrementalUpdate;
    let cancelled = false;
    const sim = decollisioning(
      valid,
      (nodes) => {
        if (cancelled) return;
        setProcessedData([...nodes]);
      },
      fnDotSize,
      (finalNodes) => {
        if (cancelled) return;
        // Memoize results
        for (const node of finalNodes) {
          const original = inputById.get(node.id);
          memoizedPositions.current.set(node.id, {
            inputX: original?.x ?? node.x,
            inputY: original?.y ?? node.y,
            x: node.x,
            y: node.y,
          });
        }
        stablePositionsRef.current = finalNodes.map((node) => ({ ...node }));
        // Write back to shared cache so the other renderer can seed from it on mount
        if (sharedPositionCache?.current) {
          sharedPositionCache.current.clear();
          for (const node of finalNodes) {
            sharedPositionCache.current.set(node.id, { x: node.x, y: node.y });
          }
        }
        onDecollisionCompleteRef.current?.(finalNodes);
      },
      skipFrames,
      transitionConfig,
      { engine: decollisionEngine }
    );
    decollisionSimRef.current = sim;

    return () => {
      cancelled = true;
      sim.stop();
      if (decollisionSimRef.current === sim) {
        decollisionSimRef.current = null;
      }
    };
  }, [
    data,
    constraintKey,
    enableDecollisioning,
    decollisionEngine,
    isIncrementalUpdate,
    transitionDuration,
    transitionEasing,
    positionsAreIntermediate,
  ]);

  const handleHoverChange = useCallback((id, item) => {
    setHoveredId(id);
    if (id !== null) {
      onHover?.(item);
    } else {
      onLeave?.();
    }
  }, [onHover, onLeave]);

  const handleDotClick = useCallback((item, event) => {
    onClick?.(item, event);
  }, [onClick]);

  const handleBackgroundClick = useCallback((event) => {
    onBackgroundClick?.(event);
  }, [onBackgroundClick]);

  const handleCameraStateChange = useCallback((state) => {
    cameraStateRef.current = state;
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
      const dataToUse = dataOverride || processedData;
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
    getVisibleDotCount: () => processedData.length,
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
      const dataToUse = dataOverride || processedData;
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
      if (decollisionSimRef.current) {
        decollisionSimRef.current.stop();
        decollisionSimRef.current = null;
      }
    },
    getCurrentPositions: () => processedData,
  }), [processedData, defaultSize, computeFit, d3ToCamera, occludeLeft, occludeRight, occludeTop, occludeBottom]);

  return (
    <div
      ref={containerRef}
      className={`dot-visualization-r3f ${className}`}
      style={{ width: '100%', height: '100%', position: 'relative', ...style }}
    >
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
          onHoverChange={handleHoverChange}
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
          onCameraStateChange={handleCameraStateChange}
          setCameraRef={setCameraPositionRef}
        />
      </Canvas>

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
