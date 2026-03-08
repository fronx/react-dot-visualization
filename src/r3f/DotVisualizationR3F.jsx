import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { Canvas } from '@react-three/fiber';
import { R3FScene } from './R3FScene.jsx';
import { decollisioning } from '../decollisioning.js';
import { getDotSize } from '../dotUtils.js';
import { CAMERA_FOV_DEGREES, computeFitZ } from './cameraUtils.js';

/**
 * Drop-in replacement for DotVisualization using R3F (WebGL) rendering.
 *
 * Supports the same core props:
 *   data, edges, dotStyles, defaultColor, defaultSize, defaultOpacity
 *   dotStroke, dotStrokeWidth, hoverSizeMultiplier, hoverOpacity
 *   edgeColor, edgeOpacity
 *   onHover, onLeave, onClick, onBackgroundClick, onDragStart
 *   enableDecollisioning, positionsAreIntermediate, cacheKey
 *   className, style, children
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
    positionsAreIntermediate = false,
    cacheKey = 'default',
    className = '',
    style = {},
    children,
  } = props;

  const [processedData, setProcessedData] = useState([]);
  const [hoveredId, setHoveredId] = useState(null);

  const decollisionSimRef = useRef(null);
  const memoizedPositions = useRef(new Map());
  const prevCacheKeyRef = useRef(cacheKey);
  const cameraInitialized = useRef(false);
  const cameraRef = useRef(null); // for imperative API

  // Clear memoized positions when cache key changes
  useEffect(() => {
    if (prevCacheKeyRef.current !== cacheKey) {
      memoizedPositions.current.clear();
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
      // Decollision disabled: restore memoized decollided positions if available
      if (memoizedPositions.current.size > 0) {
        const restored = valid.map(item => {
          const memo = memoizedPositions.current.get(item.id);
          return memo ? { ...item, x: memo.x, y: memo.y } : item;
        });
        setProcessedData(restored);
      } else {
        setProcessedData(valid);
      }
      return;
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
      setProcessedData(restored);
      return;
    }

    const fnDotSize = (item) => getDotSize(item, dotStyles, defaultSize);
    const sim = decollisioning(
      valid,
      (nodes) => setProcessedData([...nodes]),
      fnDotSize,
      (finalNodes) => {
        // Memoize results
        for (const node of finalNodes) {
          const original = valid.find(v => v.id === node.id);
          memoizedPositions.current.set(node.id, {
            inputX: original?.x ?? node.x,
            inputY: original?.y ?? node.y,
            x: node.x,
            y: node.y,
          });
        }
        onDecollisionComplete?.(finalNodes);
      }
    );
    decollisionSimRef.current = sim;

    return () => {
      if (decollisionSimRef.current) {
        decollisionSimRef.current.stop();
        decollisionSimRef.current = null;
      }
    };
  }, [data, cacheKey, enableDecollisioning, positionsAreIntermediate]);

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

  // Imperative handle — implements the DotVisualization API surface
  useImperativeHandle(ref, () => ({
    zoomToVisible: async () => {
      cameraInitialized.current = false;
    },
    getVisibleDotCount: () => processedData.length,
    // Stubs for methods not yet implemented in the R3F renderer
    getZoomTransform: () => null,
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
      className={`dot-visualization-r3f ${className}`}
      style={{ width: '100%', height: '100%', position: 'relative', ...style }}
    >
      <Canvas
        style={{ position: 'absolute', inset: 0 }}
        camera={{
          fov: CAMERA_FOV_DEGREES,
          near: 0.01,
          far: 100000,
          position: [0, 0, 65],
        }}
        gl={{ antialias: true }}
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
          cameraInitialized={cameraInitialized}
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
