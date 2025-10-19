import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import * as d3 from 'd3';
import { getDotSize, getSyncedPosition, updateColoredDotAttributes } from './dotUtils.js';
import ImagePatterns from './ImagePatterns.jsx';
import { PrioritizedList } from './PrioritizedList.js';
import { useDebug } from './useDebug.js';
import { buildSpatialIndex, findDotAtPosition, useCanvasInteractions } from './canvasInteractions.js';
import { transformToCSSPixels } from './utils.js';
import { usePulseAnimation } from './usePulseAnimation.js';
import { useCache } from './useCache.js';
import { calculateAdaptiveRingRadius } from './pulseRingUtils.js';

const ColoredDots = React.memo(forwardRef((props, ref) => {
  const {
    data = [],
    dotId,
    stroke = "#111",
    strokeWidth = 0.2,
    defaultColor = null,
    defaultSize = 2,
    defaultOpacity = 0.7,
    dotStyles = new Map(),
    hoveredDotId = null,
    hoverSizeMultiplier = 1.5,
    hoverOpacity = 1.0,
    useImages = false,
    imageProvider,
    hoverImageProvider,
    visibleDotCount = null,
    useCanvas = false,
    getZoomTransform = null,
    effectiveViewBox = null,
    debug = false,
    onHover,
    onLeave,
    onClick,
    onBackgroundClick,
    onMouseDown,
    onMouseUp,
    onDoubleClick,
    onContextMenu,
    onDragStart,
    isZooming = false,
    customDotRenderer = null,
    isDecollisioning = false
  } = props;

  const debugLog = useDebug(debug);
  const canvasRef = useRef(null);
  const canvasDimensionsRef = useRef(null);

  // Guard function to prevent React from interfering with D3 simulation
  // During decollision, the D3 force simulation has exclusive control over dot positions
  // and directly manipulates the canvas via renderCanvasWithData(). Any React-triggered
  // render would use stale position data and overwrite the simulation's progress.
  const shouldBlockRenderDuringDecollision = (reason) => {
    if (isDecollisioning) {
      debugLog(`Skipping ${reason} - D3 simulation has control`);
      return true;
    }
    return false;
  };

  // Style cache - invalidates when any style-affecting prop changes
  const styleCache = useCache([
    data, dotStyles, stroke, strokeWidth, defaultColor, defaultSize, defaultOpacity,
    hoverSizeMultiplier, hoverOpacity, useImages, imageProvider, hoverImageProvider
  ], {
    debug,
    name: 'ColoredDots.styles'
  });

  // Pulse animation hook
  const getPulseMultipliers = usePulseAnimation(dotStyles, useCanvas ? () => {
    if (shouldBlockRenderDuringDecollision('pulse animation render')) return;
    const ctx = setupCanvas();
    if (ctx) renderDots(ctx, getZoomTransform?.());
  } : null, debug);

  const getColor = (item, index) => {
    if (item.color) return item.color;
    if (defaultColor) return defaultColor;
    // Use d3 color scale as fallback
    const colorScale = d3.scaleSequential(d3.interpolatePlasma)
      .domain([0, data.length - 1]);
    return colorScale(index);
  };

  const getFill = (item, index) => {
    if (useImages) {
      // Check if we should show hover image (if hoverImageProvider is available and item is hovered)
      const shouldUseHoverImage = hoverImageProvider && hoveredDotId === item.id;
      const hoverImageUrl = shouldUseHoverImage ? hoverImageProvider(item.id, visibleDotCount) : undefined;
      const regularImageUrl = imageProvider ? imageProvider(item.id, visibleDotCount) : item.imageUrl;

      // Determine which pattern to use
      if (shouldUseHoverImage && hoverImageUrl && hoverImageUrl !== regularImageUrl) {
        // Use hover pattern if it exists and is different from regular image
        return `url(#image-pattern-hover-${item.id})`;
      } else if (regularImageUrl || item.svgContent) {
        // Use regular pattern
        return `url(#image-pattern-${item.id})`;
      }
    }
    return getColor(item, index);
  };

  const getSize = (item) => {
    const baseSize = getDotSize(item, dotStyles, defaultSize);
    const baseColor = getColor(item, data.indexOf(item));
    const { sizeMultiplier } = getPulseMultipliers(item.id, baseColor);
    let finalSize = baseSize * sizeMultiplier;

    if (hoveredDotId === item.id) {
      // Check for per-dot hover multiplier override
      const customStyles = dotStyles.get(item.id);
      const effectiveHoverMultiplier = customStyles?.hoverSizeMultiplier ?? hoverSizeMultiplier;
      finalSize *= effectiveHoverMultiplier;
    }
    return finalSize;
  };

  const getOpacity = (item) => {
    const baseOpacity = hoveredDotId === item.id ? hoverOpacity : defaultOpacity;
    const baseColor = getColor(item, data.indexOf(item));
    const { opacityMultiplier } = getPulseMultipliers(item.id, baseColor);
    return baseOpacity * opacityMultiplier;
  };

  const getEffectiveColor = (item, index) => {
    const baseColor = getColor(item, index);
    const { color } = getPulseMultipliers(item.id, baseColor);
    return color;
  };

  // Unified function to compute final styles for both SVG and Canvas
  const computeFinalStyles = (item, index, isCanvas = false) => {
    const customStyles = dotStyles.get(item.id) || {};
    const hasPulse = customStyles.pulse !== undefined;
    const isHovered = hoveredDotId === item.id;

    // Cache key includes hover state since it affects styles
    const cacheKey = `${item.id}_${isHovered ? 'h' : 'n'}`;

    // Use cache for non-pulsing dots
    return styleCache.getCached(
      cacheKey,
      () => {
        const baseStyles = {
          fill: isCanvas ? getEffectiveColor(item, index) : getFill(item, index),
          stroke: stroke,
          strokeWidth: strokeWidth,
          opacity: getOpacity(item),
          size: getSize(item)
        };

        // Apply custom dotStyles
        const mergedStyles = { ...baseStyles, ...customStyles };

        // Handle stroke-width vs strokeWidth property name differences
        if (customStyles['stroke-width'] !== undefined) {
          mergedStyles.strokeWidth = customStyles['stroke-width'];
        }

        // Hover opacity always takes precedence
        if (isHovered) {
          mergedStyles.opacity = getOpacity(item);
        }

        return mergedStyles;
      },
      hasPulse // Skip cache for pulsing dots (dynamic)
    );
  };


  // Render all dots using shared drawing function
  const renderDots = (canvasContext = null, tOverride = null, customData = null) => {
    const dataToRender = customData || data;
    if (useCanvas && canvasContext) {
      const t = tOverride || { k: 1, x: 0, y: 0 };

      // Reset to identity
      canvasContext.setTransform(1, 0, 0, 1, 0, 0);
      // Re-apply base viewBox transform
      let viewBoxScale = 1;
      let canvasDPR = 1;
      if (effectiveViewBox && canvasDimensionsRef.current) {
        const { width, height } = canvasDimensionsRef.current;
        const dpr = (window.devicePixelRatio || 1) * 2;
        canvasDPR = dpr; // Store DPR for accurate pixel calculations
        const [vbX, vbY, vbW, vbH] = effectiveViewBox;
        const scaleX = (width / vbW) * dpr;
        const scaleY = (height / vbH) * dpr;
        viewBoxScale = scaleX; // Store for ring calculations (includes DPR)
        const translateX = -vbX * scaleX;
        const translateY = -vbY * scaleY;
        canvasContext.setTransform(scaleX, 0, 0, scaleY, translateX, translateY);
      }
      // Now apply zoom
      canvasContext.transform(t.k, 0, 0, t.k, t.x, t.y);
      // Clear in viewBox coords after full transform reset
      if (effectiveViewBox) {
        const [vbX, vbY, vbW, vbH] = effectiveViewBox;
        canvasContext.clearRect(vbX, vbY, vbW, vbH);
      }

      // Build spatial index for mouse interaction in CSS pixel space
      // Only rebuild when data/transform actually change (use cheap checks only)
      const cssTransform = transformToCSSPixels(t, effectiveViewBox, canvasDimensionsRef.current);

      // Track last state - use ONLY cheap O(1) checks to minimize per-frame overhead
      const lastState = canvasRef.current._lastSpatialIndexState;

      // All checks are O(1): array length, array access, simple math, property reads
      const transformK = Math.round(t.k * 1000) / 1000; // Round to avoid float precision
      const transformX = Math.round(t.x);
      const transformY = Math.round(t.y);
      const dataLength = dataToRender.length;
      const firstDotX = dataToRender[0]?.x;
      const firstDotY = dataToRender[0]?.y;
      const lastDotX = dataToRender[dataToRender.length - 1]?.x;
      const lastDotY = dataToRender[dataToRender.length - 1]?.y;
      const canvasWidth = canvasDimensionsRef.current?.width;
      const canvasHeight = canvasDimensionsRef.current?.height;

      // Simple comparison - no expensive function calls, no indexOf(), no Map lookups
      const shouldRebuildSpatialIndex = !lastState ||
        lastState.dataLength !== dataLength ||
        lastState.firstDotX !== firstDotX ||
        lastState.firstDotY !== firstDotY ||
        lastState.lastDotX !== lastDotX ||
        lastState.lastDotY !== lastDotY ||
        lastState.transformK !== transformK ||
        lastState.transformX !== transformX ||
        lastState.transformY !== transformY ||
        lastState.canvasWidth !== canvasWidth ||
        lastState.canvasHeight !== canvasHeight ||
        lastState.isDecollisioning !== isDecollisioning;

      // Skip spatial index rebuilds during decollision to avoid conflicts with D3 simulation
      // The D3 simulation maintains live positions and directly manipulates the canvas.
      // Building a spatial index from React state during this time would capture stale positions.
      // When decollision completes, isDecollisioning changes and triggers a rebuild automatically.
      if (shouldRebuildSpatialIndex && !isDecollisioning) {
        const spatialIndex = buildSpatialIndex(dataToRender, getSize, cssTransform);
        if (spatialIndex) {
          canvasRef.current._spatialIndex = spatialIndex;
          canvasRef.current._lastSpatialIndexState = {
            dataLength,
            firstDotX,
            firstDotY,
            lastDotX,
            lastDotY,
            transformK,
            transformX,
            transformY,
            canvasWidth,
            canvasHeight,
            isDecollisioning
          };

          if (debug && process.env.NODE_ENV === 'development' && Math.random() < 0.05) {
            console.log('[ColoredDots] Rebuilt spatial index (data/transform changed)');
          }
        }
      }

      // Canvas rendering: use unified styling logic
      const drawDot = (item, index) => {
        const styles = computeFinalStyles(item, index, true);
        const baseColor = getColor(item, index);
        const pulseData = getPulseMultipliers(item.id, baseColor);
        const radius = styles.size;

        // Allow custom renderer to override default drawing
        if (customDotRenderer) {
          const didRender = customDotRenderer(canvasContext, item, styles, {
            radius,
            pulseData,
            isHovered: hoveredDotId === item.id,
            zoomScale: t.k,      // Pass zoom scale for zoom-aware effects
            viewBoxScale,        // Pass viewBox scale for accurate screen size calculations
            canvasDPR            // Pass canvas DPR for accurate CSS pixel calculations
          });
          if (didRender) return; // Skip default rendering if custom renderer handled it
        }

        // Draw pulsating ring first (if present)
        if (pulseData.ringData) {
          const ringRadius = calculateAdaptiveRingRadius({
            radius,
            animationPhase: pulseData.ringData.animationPhase,
            viewBoxScale,
            zoomScale: t.k,
            targetPixels: pulseData.ringData.options?.targetPixels,
            minRatio: pulseData.ringData.options?.minRatio,
            canvasDPR,
            debug
          });

          canvasContext.globalAlpha = pulseData.ringData.opacity * styles.opacity;
          canvasContext.fillStyle = pulseData.ringData.color;
          canvasContext.beginPath();
          canvasContext.arc(item.x, item.y, ringRadius, 0, 2 * Math.PI);
          canvasContext.fill();
        }

        // Draw main dot
        canvasContext.globalAlpha = styles.opacity;
        canvasContext.fillStyle = styles.fill;
        canvasContext.strokeStyle = styles.stroke;
        canvasContext.lineWidth = styles.strokeWidth;

        canvasContext.beginPath();
        canvasContext.arc(item.x, item.y, radius, 0, 2 * Math.PI);
        canvasContext.fill();
        if (styles.strokeWidth > 0) {
          canvasContext.stroke();
        }
      };

      // Viewport culling: calculate visible bounds to skip off-screen dots
      const [vbX, vbY, vbW, vbH] = effectiveViewBox || [0, 0, 100, 100];
      const visibleBounds = {
        left: (vbX - t.x) / t.k,
        right: (vbX + vbW - t.x) / t.k,
        top: (vbY - t.y) / t.k,
        bottom: (vbY + vbH - t.y) / t.k
      };

      // Draw all non-hovered dots first, then hovered dot last (on top)
      let hoveredItem = null;
      let hoveredIndex = -1;
      let culledCount = 0;

      dataToRender.forEach((item, index) => {
        // Viewport culling: skip dots that are completely outside visible bounds
        const radius = getSize(item);
        const isVisible =
          item.x + radius >= visibleBounds.left &&
          item.x - radius <= visibleBounds.right &&
          item.y + radius >= visibleBounds.top &&
          item.y - radius <= visibleBounds.bottom;

        if (!isVisible) {
          culledCount++;
          return; // Skip this dot entirely
        }

        if (hoveredDotId === item.id) {
          hoveredItem = item;
          hoveredIndex = index;
        } else {
          drawDot(item, index);
        }
      });

      // Draw hovered dot last (always draw hovered dot even if technically off-screen)
      if (hoveredItem) {
        drawDot(hoveredItem, hoveredIndex);
      }

      // Log culling stats occasionally (for performance monitoring)
      if (culledCount > 0 && Math.random() < 0.01) {
        debugLog(`Culled ${culledCount}/${dataToRender.length} off-screen dots (${((culledCount/dataToRender.length)*100).toFixed(1)}%)`);
      }
    } else {
      // SVG rendering: use unified styling logic
      dataToRender.forEach((item, index) => {
        const elementId = dotId(0, item);
        const position = getSyncedPosition(item, elementId);
        const styles = computeFinalStyles(item, index, false);
        const isHovered = hoveredDotId === item.id;

        // Use the unified styles but still call updateColoredDotAttributes for DOM manipulation
        updateColoredDotAttributes(item, elementId, position, styles.size, styles.fill, styles.stroke, styles.strokeWidth, styles.opacity, new Map(), isHovered);
      });
    }
  };

  const setupCanvas = () => {
    if (!useCanvas || !canvasRef.current) return null;

    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');

    // Use cached dimensions or initialize them once to avoid getBoundingClientRect() shifts
    if (!canvasDimensionsRef.current) {
      const rect = canvas.getBoundingClientRect();
      canvasDimensionsRef.current = {
        width: rect.width,
        height: rect.height
      };
      debugLog('Canvas dimensions initialized:', canvasDimensionsRef.current);
    }

    const { width, height } = canvasDimensionsRef.current;
    const dpr = window.devicePixelRatio || 1;

    // Keep canvas resolution capped at 2x screen to avoid memory issues
    const MAX_MULT = 2;
    const effectiveDpr = dpr * MAX_MULT;

    // Set canvas internal size 
    canvas.width = width * effectiveDpr;
    canvas.height = height * effectiveDpr;

    // Set up coordinate system to match the viewBox
    // Canvas pixels should map 1:1 to viewBox units, scaled by DPR for crisp rendering
    if (effectiveViewBox) {
      const [vbX, vbY, vbW, vbH] = effectiveViewBox;

      // Scale from canvas pixels to viewBox coordinates
      const scaleX = (width / vbW) * effectiveDpr;
      const scaleY = (height / vbH) * effectiveDpr;

      // Translate to account for viewBox origin
      const translateX = -vbX * scaleX;
      const translateY = -vbY * scaleY;

      context.setTransform(scaleX, 0, 0, scaleY, translateX, translateY);
      debugLog('Canvas transform set for viewBox:', { scaleX, scaleY, translateX, translateY });
    }

    // Clear canvas in viewBox coordinates
    if (effectiveViewBox) {
      const [vbX, vbY, vbW, vbH] = effectiveViewBox;
      context.clearRect(vbX, vbY, vbW, vbH);
    } else {
      context.clearRect(0, 0, width, height);
    }

    debugLog('Canvas setup:', {
      width,
      height,
      effectiveDpr,
      canvasSize: `${canvas.width}x${canvas.height}`,
      memoryMB: ((canvas.width * canvas.height * 4) / (1024 * 1024)).toFixed(1)
    });
    return context;
  };



  // Reset canvas dimensions cache when viewBox changes (for resize handling)
  useEffect(() => {
    if (useCanvas && effectiveViewBox) {
      // Clear cached dimensions so they get recalculated with new container size
      canvasDimensionsRef.current = null;
      debugLog('Canvas dimensions cache cleared for viewBox change');
    }
  }, [effectiveViewBox, useCanvas]);

  // Canvas rendering for data/style changes (NOT zoom, NOT hover)
  // Note: hoveredDotId, hoverSizeMultiplier, hoverOpacity intentionally excluded from deps
  // Hover changes are reflected in renderDots() via closure, but don't trigger full redraws
  // This prevents flickering during decollision when mouse moves over dots
  useEffect(() => {
    if (!useCanvas) { canvasDimensionsRef.current = null; return; }
    if (shouldBlockRenderDuringDecollision('canvas useEffect render')) return;

    debugLog('Immediate canvas render:', { dataLength: data.length });
    const ctx = setupCanvas();
    if (ctx) renderDots(ctx, getZoomTransform?.());
  }, [data, dotStyles, stroke, strokeWidth, defaultColor, defaultSize, defaultOpacity, useImages, useCanvas, customDotRenderer, isDecollisioning]);



  // Expose canvas rendering function and interaction methods to parent
  useImperativeHandle(ref, () => ({
    renderCanvas: () => {
      if (!useCanvas) return;
      const ctx = setupCanvas();
      if (ctx) {
        renderDots(ctx);
      }
    },
    renderCanvasWithTransform: (transform) => {
      if (!useCanvas) return;
      const ctx = setupCanvas();
      if (ctx) {
        renderDots(ctx, transform);
      }
    },
    renderCanvasWithData: (customData, transform) => {
      if (!useCanvas) return;
      const ctx = setupCanvas();
      if (ctx) {
        renderDots(ctx, transform, customData);
      }
    },
    findDotAtPosition: (mouseX, mouseY) => {
      if (!useCanvas || !canvasRef.current?._spatialIndex) return null;
      return findDotAtPosition(mouseX, mouseY, canvasRef.current._spatialIndex);
    }
  }), [useCanvas, setupCanvas, renderDots, findDotAtPosition]);


  useEffect(() => {
    if (!useCanvas) {
      // console.log('🟣 ColoredDots SVG useEffect triggered - data length:', data.length, 'first item:', data[0]?.x?.toFixed(2), data[0]?.y?.toFixed(2));
      debugLog('SVG render:', { dataLength: data.length });
      renderDots();
    }
    // SVG needs all dependencies including dotStyles for positioning
  }, [data, dotStyles, dotId, stroke, strokeWidth, defaultColor, defaultSize, defaultOpacity, hoveredDotId, hoverSizeMultiplier, hoverOpacity, useImages, imageProvider, hoverImageProvider, useCanvas, customDotRenderer]);

  // Canvas interaction handlers using utility hook
  const canvasInteractionHandlers = useCanvasInteractions({
    enabled: useCanvas,
    isZooming,
    getSpatialIndex: () => canvasRef.current?._spatialIndex,
    onHover,
    onLeave,
    onClick,
    onBackgroundClick,
    onMouseDown,
    onMouseUp,
    onDoubleClick,
    onContextMenu,
    onDragStart,
    debug
  });

  if (useCanvas) {
    // Position foreignObject at origin, but make it large enough to cover viewBox area
    // This way the canvas coordinate system matches the D3 zoom coordinate system
    const viewBoxX = effectiveViewBox ? effectiveViewBox[0] : 0;
    const viewBoxY = effectiveViewBox ? effectiveViewBox[1] : 0;
    const viewBoxW = effectiveViewBox ? effectiveViewBox[2] : 1000;
    const viewBoxH = effectiveViewBox ? effectiveViewBox[3] : 1000;

    // Canvas should start at viewBox origin and span the viewBox dimensions
    return (
      <foreignObject x={viewBoxX} y={viewBoxY} width={viewBoxW} height={viewBoxH}>
        <canvas
          ref={canvasRef}
          {...canvasInteractionHandlers}
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            pointerEvents: useCanvas ? 'auto' : 'none' // Enable interactions for canvas mode
          }}
        />
      </foreignObject>
    );
  }

  return (
    <g id="colored-dots">
      {/* Image patterns are only supported in SVG mode */}
      <ImagePatterns
        data={data}
        useImages={useImages}
        imageProvider={imageProvider}
        hoverImageProvider={hoverImageProvider}
        visibleDotCount={visibleDotCount}
      />
      <PrioritizedList data={data} prioritizedId={hoveredDotId}>
        {(item, index) => (
          <circle
            id={dotId(0, item)}
            key={dotId(0, item)}
            r={getSize(item)}
            cx={item.x}
            cy={item.y}
            fill={getFill(item, index)}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
        )}
      </PrioritizedList>
    </g>
  );
}));

export default ColoredDots;