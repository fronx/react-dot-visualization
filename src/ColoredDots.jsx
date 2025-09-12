import React, { useEffect, useRef, useCallback } from 'react';
import * as d3 from 'd3';
import { getDotSize, getSyncedPosition, updateColoredDotAttributes } from './dotUtils.js';
import ImagePatterns from './ImagePatterns.jsx';
import { PrioritizedList } from './PrioritizedList.js';
import { useDebug } from './useDebug.js';

const ColoredDots = React.memo((props) => {
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
    debug = false
  } = props;
  
  const debugLog = useDebug(debug);
  const canvasRef = useRef(null);
  const lastZoomLevel = useRef(1);
  const renderTimeoutRef = useRef(null);
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

  // Shared drawing function using d3.path pattern - works with both Canvas and SVG
  const drawDot = (context, item, index, useRawPosition = false) => {
    // For canvas, use raw data positions; for SVG, use synced positions
    const position = useRawPosition ? { x: item.x, y: item.y } : getSyncedPosition(item, dotId(0, item));
    const size = getSize(item);
    const radius = size / 2;
    
    // Use d3.path pattern: create path commands that work for both contexts
    context.moveTo(position.x + radius, position.y);
    context.arc(position.x, position.y, radius, 0, 2 * Math.PI);
    return context;
  };

  // Render all dots using shared drawing function
  const renderDots = (canvasContext = null) => {
    if (useCanvas && canvasContext) {
      // Canvas rendering: use raw positions, let CSS transforms handle zoom/pan
      data.forEach((item, index) => {
        const opacity = getOpacity(item);
        const fill = getColor(item, index); // Canvas uses solid colors only
        
        canvasContext.globalAlpha = opacity;
        canvasContext.fillStyle = fill;
        canvasContext.strokeStyle = stroke;
        canvasContext.lineWidth = strokeWidth;
        
        canvasContext.beginPath();
        drawDot(canvasContext, item, index, true); // useRawPosition = true
        canvasContext.fill();
        if (strokeWidth > 0) {
          canvasContext.stroke();
        }
      });
    } else {
      // SVG rendering: use existing system with synced positions
      data.forEach((item, index) => {
        const elementId = dotId(0, item);
        const position = getSyncedPosition(item, elementId);
        const size = getSize(item);
        const fill = getFill(item, index);
        const opacity = getOpacity(item);
        const isHovered = hoveredDotId === item.id;
        
        updateColoredDotAttributes(item, elementId, position, size, fill, stroke, strokeWidth, opacity, dotStyles, isHovered);
      });
    }
  };

  const setupCanvas = (zoomScale = 1) => {
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
    
    // Calculate adaptive resolution multiplier based on zoom level
    // No upper limit - truly adaptive to any zoom level
    const minResolutionMultiplier = 1; // Min 1x resolution to avoid sub-pixel rendering
    const adaptiveMultiplier = Math.max(zoomScale, minResolutionMultiplier);
    const effectiveDpr = dpr * adaptiveMultiplier;
    
    // Set canvas internal size 
    canvas.width = width * effectiveDpr;
    canvas.height = height * effectiveDpr;
    
    // Scale context to maintain consistent logical coordinate system
    context.scale(effectiveDpr, effectiveDpr);
    
    // Clear canvas
    context.clearRect(0, 0, width, height);
    
    debugLog('Canvas setup:', { 
      width, 
      height, 
      zoomScale,
      adaptiveMultiplier, 
      canvasSize: `${canvas.width}x${canvas.height}`,
      memoryMB: ((canvas.width * canvas.height * 4) / (1024 * 1024)).toFixed(1)
    });
    return context;
  };

  // Only re-render canvas if zoom changed by more than 20% to avoid excessive renders
  const hasSignificantZoomChange = (oldZoom, newZoom) => {
    if (!oldZoom || !newZoom) return true;
    const ratio = Math.max(oldZoom, newZoom) / Math.min(oldZoom, newZoom);
    return ratio > 1.2; // 20% threshold
  };

  /**
   * Debounce canvas re-renders during zoom operations (150ms delay)
   * 
   * Why: Zoom events fire rapidly (10-60+/sec), causing performance issues
   * and stuttering when re-rendering high-resolution canvas on every event
   * 
   * Remove if: Canvas rendering becomes much faster, users need immediate
   * feedback, or 150ms delay feels laggy for precision work
   */
  const scheduleZoomRender = useCallback((zoomScale) => {
    if (!useCanvas) return;
    
    // Clear any pending render to reset debounce timer
    if (renderTimeoutRef.current) {
      clearTimeout(renderTimeoutRef.current);
    }
    
    // Schedule new render with debounce delay
    renderTimeoutRef.current = setTimeout(() => {
      debugLog('Zoom-triggered canvas render:', { zoomScale, dataLength: data.length });
      // Use requestAnimationFrame to defer heavy canvas operations
      requestAnimationFrame(() => {
        const context = setupCanvas(zoomScale);
        if (context) {
          renderDots(context);
          lastZoomLevel.current = zoomScale;
        }
      });
    }, 150); // 150ms debounce - balance between responsiveness and performance
  }, [useCanvas, data, setupCanvas, renderDots]);

  // Canvas rendering for data/style changes (immediate)
  useEffect(() => {
    if (useCanvas) {
      debugLog('Immediate canvas render:', { dataLength: data.length });
      const currentZoom = zoomTransform?.k || 1;
      const context = setupCanvas(currentZoom);
      if (context) {
        renderDots(context);
        lastZoomLevel.current = currentZoom;
      }
    } else {
      // Reset canvas dimensions when switching away from canvas mode
      canvasDimensionsRef.current = null;
    }
    // Canvas re-renders immediately on data/style changes
  }, [data, stroke, strokeWidth, defaultColor, defaultSize, defaultOpacity, hoveredDotId, hoverSizeMultiplier, hoverOpacity, useImages, useCanvas]);

  // Canvas rendering for zoom changes (debounced)
  useEffect(() => {
    if (useCanvas && zoomTransform) {
      const currentZoom = zoomTransform.k;
      
      // Re-render if zoom changed significantly (now truly adaptive)
      if (hasSignificantZoomChange(lastZoomLevel.current, currentZoom)) {
        scheduleZoomRender(currentZoom);
      }
    }
  }, [zoomTransform?.k, useCanvas, scheduleZoomRender]);


  // Cleanup: Clear any pending debounced renders when component unmounts
  // This prevents memory leaks and "setState on unmounted component" warnings
  useEffect(() => {
    return () => {
      if (renderTimeoutRef.current) {
        clearTimeout(renderTimeoutRef.current);
        renderTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!useCanvas) {
      debugLog('SVG render:', { dataLength: data.length });
      renderDots();
    }
    // SVG needs all dependencies including dotStyles for positioning
  }, [data, dotStyles, dotId, stroke, strokeWidth, defaultColor, defaultSize, defaultOpacity, hoveredDotId, hoverSizeMultiplier, hoverOpacity, useImages, imageProvider, hoverImageProvider, useCanvas]);

  if (useCanvas) {
    return (
      <foreignObject x="0" y="0" width="100%" height="100%">
        <canvas
          ref={canvasRef}
          style={{ 
            width: '100%', 
            height: '100%',
            display: 'block',
            pointerEvents: 'none' // Let SVG handle interactions
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
});

export default ColoredDots;