import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import * as d3 from 'd3';
import { getDotSize, getSyncedPosition, updateColoredDotAttributes } from './dotUtils.js';
import ImagePatterns from './ImagePatterns.jsx';
import { PrioritizedList } from './PrioritizedList.js';
import { useDebug } from './useDebug.js';
import { buildSpatialIndex, findDotAtPosition, useCanvasInteractions } from './canvasInteractions.js';
import { transformToCSSPixels } from './utils.js';

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
    zoomTransform = null,
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
    isZooming = false
  } = props;

  const debugLog = useDebug(debug);
  const canvasRef = useRef(null);
  const canvasDimensionsRef = useRef(null);

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
    if (hoveredDotId === item.id) {
      return baseSize * hoverSizeMultiplier;
    }
    return baseSize;
  };

  const getOpacity = (item) => {
    return hoveredDotId === item.id ? hoverOpacity : defaultOpacity;
  };

  // Unified function to compute final styles for both SVG and Canvas
  const computeFinalStyles = (item, index, isCanvas = false) => {
    const baseStyles = {
      fill: isCanvas ? getColor(item, index) : getFill(item, index), // Canvas can't use SVG patterns
      stroke: stroke,
      strokeWidth: strokeWidth,
      opacity: getOpacity(item),
      size: getSize(item)
    };

    // Apply custom dotStyles (same logic as updateColoredDotAttributes)
    const customStyles = dotStyles.get(item.id) || {};
    const mergedStyles = { ...baseStyles, ...customStyles };

    // Handle stroke-width vs strokeWidth property name differences
    if (customStyles['stroke-width'] !== undefined) {
      mergedStyles.strokeWidth = customStyles['stroke-width'];
    }

    // Hover opacity always takes precedence (same as updateColoredDotAttributes)
    const isHovered = hoveredDotId === item.id;
    if (isHovered) {
      mergedStyles.opacity = getOpacity(item); // This already handles hover opacity
    }

    return mergedStyles;
  };


  // Render all dots using shared drawing function
  const renderDots = (canvasContext = null, tOverride = null) => {
    if (useCanvas && canvasContext) {
      // console.log("renderDots");
      const t = tOverride || zoomTransform || { k: 1, x: 0, y: 0 };

      // Reset to identity
      canvasContext.setTransform(1, 0, 0, 1, 0, 0);
      // Re-apply base viewBox transform
      if (effectiveViewBox && canvasDimensionsRef.current) {
        const { width, height } = canvasDimensionsRef.current;
        const dpr = (window.devicePixelRatio || 1) * 2;
        const [vbX, vbY, vbW, vbH] = effectiveViewBox;
        const scaleX = (width / vbW) * dpr;
        const scaleY = (height / vbH) * dpr;
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
      // Mouse events give us CSS coordinates, so we need to convert dots to CSS space
      const cssTransform = transformToCSSPixels(t, effectiveViewBox, canvasDimensionsRef.current);
      const spatialIndex = buildSpatialIndex(data, getSize, cssTransform);
      if (spatialIndex) {
        canvasRef.current._spatialIndex = spatialIndex;
      }

      // Canvas rendering: use unified styling logic
      data.forEach((item, index) => {
        const styles = computeFinalStyles(item, index, true);
        const radius = styles.size;

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
      });
    } else {
      // SVG rendering: use unified styling logic
      data.forEach((item, index) => {
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
    } else {
      // Fallback: just apply DPR scaling
      context.setTransform(effectiveDpr, 0, 0, effectiveDpr, 0, 0);
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



  // Canvas rendering for data/style changes (NOT zoom)
  useEffect(() => {
    if (!useCanvas) { canvasDimensionsRef.current = null; return; }
    // console.log('🟣 ColoredDots canvas useEffect triggered - data length:', data.length, 'first item:', data[0]?.x?.toFixed(2), data[0]?.y?.toFixed(2), 'data ref:', data);
    debugLog('Immediate canvas render:', { dataLength: data.length });
    const ctx = setupCanvas();
    if (ctx) renderDots(ctx);
  }, [data, dotStyles, stroke, strokeWidth, defaultColor, defaultSize, defaultOpacity, hoveredDotId, hoverSizeMultiplier, hoverOpacity, useImages, useCanvas]);



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
  }, [data, dotStyles, dotId, stroke, strokeWidth, defaultColor, defaultSize, defaultOpacity, hoveredDotId, hoverSizeMultiplier, hoverOpacity, useImages, imageProvider, hoverImageProvider, useCanvas]);

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
    onDragStart
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