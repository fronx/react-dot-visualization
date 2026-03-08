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

const CAMERA_FOV_RAD = CAMERA_FOV_DEGREES * (Math.PI / 180);
const EMPTY_RADIUS_OVERRIDES = new Map();

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
    isIncrementalUpdate = false,
    transitionDuration = 500,
    transitionEasing = d3.easeCubicOut,
    positionsAreIntermediate = false,
    cacheKey = 'default',
    radiusOverrides = EMPTY_RADIUS_OVERRIDES,
    sharedPositionCache = null,
    initialTransform = null,
    className = '',
    style = {},
    children,
  } = props;

  const [processedData, setProcessedData] = useState([]);
  const [hoveredId, setHoveredId] = useState(null);

  const decollisionSimRef = useRef(null);
  const memoizedPositions = useRef(new Map());
  const stablePositionsRef = useRef([]);
  const dotStylesRef = useRef(dotStyles);
  const defaultSizeRef = useRef(defaultSize);
  const onDecollisionCompleteRef = useRef(onDecollisionComplete);
  const prevCacheKeyRef = useRef(cacheKey);
  const cameraInitialized = useRef(false);

  // Camera state for zoom/pan persistence across renderer switches.
  const cameraStateRef = useRef(null);
  // Container ref for measuring dimensions when computing D3-compatible zoom transform.
  const containerRef = useRef(null);

  useEffect(() => {
    dotStylesRef.current = dotStyles;
  }, [dotStyles]);

  useEffect(() => {
    defaultSizeRef.current = defaultSize;
  }, [defaultSize]);

  useEffect(() => {
    onDecollisionCompleteRef.current = onDecollisionComplete;
  }, [onDecollisionComplete]);

  // Clear memoized positions when cache key changes
  useEffect(() => {
    if (prevCacheKeyRef.current !== cacheKey) {
      memoizedPositions.current.clear();
      stablePositionsRef.current = [];
      prevCacheKeyRef.current = cacheKey;
    }
  }, [cacheKey]);

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

    if (!enableDecollisioning && memoizedPositions.current.size > 0) {
      // Decollision disabled and we have cached results: restore them
      const restored = valid.map(item => {
        const memo = memoizedPositions.current.get(item.id);
        return memo ? { ...item, x: memo.x, y: memo.y } : item;
      });
      stablePositionsRef.current = restored.map((node) => ({ ...node }));
      setProcessedData(restored);
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

    // Catch-up mode: renderer mounted fresh while global decollision phase already passed.
    // Run silently (no intermediate frames) to avoid competing state updates.
    const isCatchUp = !enableDecollisioning && memoizedPositions.current.size === 0;

    // Incremental updates keep rendering previously stable positions while decollision runs.
    if (!isCatchUp) {
      if (isIncrementalUpdate && stablePositionsRef.current.length > 0) {
        setProcessedData(stablePositionsRef.current);
      } else if (!isIncrementalUpdate) {
        // Full renders stream intermediate positions.
        setProcessedData(valid);
      }
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

    const skipFrames = isCatchUp || isIncrementalUpdate;
    const sim = decollisioning(
      valid,
      (nodes) => setProcessedData([...nodes]),
      fnDotSize,
      (finalNodes) => {
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
      transitionConfig
    );
    decollisionSimRef.current = sim;

    return () => {
      if (decollisionSimRef.current) {
        decollisionSimRef.current.stop();
        decollisionSimRef.current = null;
      }
    };
  }, [
    data,
    cacheKey,
    enableDecollisioning,
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

  // Imperative handle — implements the DotVisualization API surface
  useImperativeHandle(ref, () => ({
    zoomToVisible: async () => {
      cameraInitialized.current = false;
    },
    getVisibleDotCount: () => processedData.length,
    getZoomTransform: () => {
      const cam = cameraStateRef.current;
      if (!cam || !containerRef.current) return null;
      const { width: W, height: H } = containerRef.current.getBoundingClientRect();
      if (!W || !H) return null;
      // Convert Three.js camera position to D3-equivalent zoom transform {x, y, k}.
      // cam.y is world Y (up+), which is the negation of data Y (down+).
      const k = H / (cam.z * 2 * Math.tan(CAMERA_FOV_RAD / 2));
      return {
        x: W / 2 - cam.x * k,
        y: H / 2 + cam.y * k, // H/2 - (-cam.y) * k = H/2 + cam.y * k
        k,
      };
    },
    updateVisibleDotCount: () => {},
    cancelDecollision: () => {
      if (decollisionSimRef.current) {
        decollisionSimRef.current.stop();
        decollisionSimRef.current = null;
      }
    },
    getCurrentPositions: () => processedData,
  }), [processedData]);

  return (
    <div
      ref={containerRef}
      className={`dot-visualization-r3f ${className}`}
      style={{ width: '100%', height: '100%', position: 'relative', ...style }}
    >
      <Canvas
        style={{ position: 'absolute', inset: 0 }}
        dpr={[1, 1.5]}
        camera={{
          fov: CAMERA_FOV_DEGREES,
          near: 0.01,
          far: 100000,
          position: [0, 0, 65],
        }}
        gl={{ antialias: false, powerPreference: 'high-performance' }}
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
