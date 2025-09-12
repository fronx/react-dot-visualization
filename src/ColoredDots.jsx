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
    effectiveViewBox = null,
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


  // Render all dots using shared drawing function
  const renderDots = (canvasContext = null) => {
    if (useCanvas && canvasContext) {
      const t = zoomTransform || { k: 1, x: 0, y: 0 };
      
      // Apply zoom transform on top of the base DPR scaling
      // This should now match SVG zoom behavior exactly
      canvasContext.transform(t.k, 0, 0, t.k, t.x, t.y);
      
      // Canvas rendering: use raw positions with transform applied
      data.forEach((item, index) => {
        const opacity = getOpacity(item);
        const fill = getColor(item, index); // Canvas uses solid colors only
        const size = getSize(item);
        const radius = size / 2;
        
        canvasContext.globalAlpha = opacity;
        canvasContext.fillStyle = fill;
        canvasContext.strokeStyle = stroke;
        canvasContext.lineWidth = strokeWidth;
        
        canvasContext.beginPath();
        canvasContext.arc(item.x, item.y, radius, 0, 2 * Math.PI);
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
  const scheduleZoomRender = useCallback(() => {
    if (!useCanvas) return;
    
    // Clear any pending render to reset debounce timer
    if (renderTimeoutRef.current) {
      clearTimeout(renderTimeoutRef.current);
    }
    
    // Schedule new render with debounce delay
    renderTimeoutRef.current = setTimeout(() => {
      debugLog('Zoom-triggered canvas render:', { zoomK: zoomTransform?.k, dataLength: data.length });
      // Use requestAnimationFrame to defer heavy canvas operations
      requestAnimationFrame(() => {
        const context = setupCanvas();
        if (context) {
          renderDots(context);
        }
      });
    }, 150); // 150ms debounce - balance between responsiveness and performance
  }, [useCanvas, data, zoomTransform, setupCanvas, renderDots]);

  // Canvas rendering for data/style changes (immediate)
  useEffect(() => {
    if (useCanvas) {
      debugLog('Immediate canvas render:', { dataLength: data.length });
      const context = setupCanvas();
      if (context) {
        renderDots(context);
      }
    } else {
      // Reset canvas dimensions when switching away from canvas mode
      canvasDimensionsRef.current = null;
    }
    // Canvas re-renders immediately on data/style changes
  }, [data, stroke, strokeWidth, defaultColor, defaultSize, defaultOpacity, hoveredDotId, hoverSizeMultiplier, hoverOpacity, useImages, useCanvas, zoomTransform]);

  // Canvas rendering for zoom changes (debounced)
  useEffect(() => {
    if (useCanvas && zoomTransform) {
      const currentZoom = zoomTransform.k;
      
      // Re-render if zoom changed significantly
      if (hasSignificantZoomChange(lastZoomLevel.current, currentZoom)) {
        scheduleZoomRender();
        lastZoomLevel.current = currentZoom;
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