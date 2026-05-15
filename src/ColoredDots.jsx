import React, { useEffect, useMemo, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import * as d3 from 'd3';
import { getSyncedPosition, updateColoredDotAttributes } from './dotUtils.js';
import ImagePatterns from './ImagePatterns.jsx';
import { PrioritizedList } from './PrioritizedList.js';
import { useDebug } from './useDebug.js';
import { buildSpatialIndex, findDotAtPosition, useCanvasInteractions } from './canvasInteractions.js';
import { transformToCSSPixels } from './utils.js';
import { usePulseAnimation } from './usePulseAnimation.js';
import { useCache } from './useCache.js';
import { calculateAdaptiveRingRadius } from './pulseRingUtils.js';

const EMPTY_RADIUS_OVERRIDES = new Map();

const ColoredDots = React.memo(forwardRef((props, ref) => {
  const {
    data = [],
    dotId,
    stroke = "#111",
    strokeWidth = 0.2,
    strokeWidthFraction = null,
    defaultColor = null,
    defaultSize = 2,
    defaultOpacity = 0.7,
    dotStyles = new Map(),
    radiusOverrides = EMPTY_RADIUS_OVERRIDES,
    hoveredDotId = null,
    hoverSizeMultiplier = 1.5,
    hoverOpacity = 1.0,
    useImages = false,
    imageProvider,
    hoverImageProvider,
    visibleDotCount = null,
    useCanvas = false,
    renderMargin = 0,
    getZoomTransform = null,
    effectiveViewBox = null,
    containerDimensions = null,
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
  // Transform the bitmap was last drawn at. Used by applyGpuTransform to
  // derive a CSS-only delta during pan/zoom interactions.
  const lastDrawnTransformRef = useRef(null);

  // Backdrop layer: a low-res canvas covering the entire data bounding box.
  // Sits behind the main canvas at all times; only visible when the user
  // pans/zooms outside the area covered by the (higher-res) main bitmap.
  // Its "baseline" is identity, so its CSS transform is just the current
  // d3-zoom transform, adjusted for the canvas origin.
  const backdropRef = useRef(null);
  const [dataBBox, setDataBBox] = useState(null);

  // Canvas covers a region slightly larger than the visible viewBox so the
  // GPU-pan CSS shift can reveal pre-drawn dots at the edges. The SVG clips
  // the overflow until then.
  //
  // We cap by bitmap *memory* rather than by margin directly: the requested
  // renderMargin is honored when it fits in the budget, otherwise we silently
  // shrink it so the canvas stays within reach of the browser's per-element
  // memory limits. Without this, a Retina 4K display + margin=1.0 would try
  // to allocate ~1.2 GB of bitmap and crash the tab.
  const MAX_BITMAP_BYTES = 256 * 1024 * 1024;
  const extendedViewBox = useMemo(() => {
    if (!effectiveViewBox) return null;
    const requested = renderMargin || 0;
    if (requested === 0) return effectiveViewBox;

    let m = requested;
    if (containerDimensions) {
      const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1) * 2;
      const visiblePixels = containerDimensions.width * dpr * containerDimensions.height * dpr;
      const maxAreaMultiplier = (MAX_BITMAP_BYTES / 4) / visiblePixels;
      if (maxAreaMultiplier > 1) {
        const maxLinear = Math.sqrt(maxAreaMultiplier);
        const maxM = (maxLinear - 1) / 2;
        if (m > maxM) {
          m = Math.max(0, maxM);
          debugLog(`renderMargin ${requested} capped to ${m.toFixed(2)} by ${(MAX_BITMAP_BYTES / 1024 / 1024).toFixed(0)} MB bitmap budget`);
        }
      } else {
        m = 0;
        debugLog(`renderMargin disabled: viewport alone exceeds bitmap budget`);
      }
    }
    const [vbX, vbY, vbW, vbH] = effectiveViewBox;
    // Snap the canvas's SVG-coord position and size to integers so the
    // foreignObject (and the canvas inside it) doesn't start at a fractional
    // SVG coordinate. Fractional SVG coords map to fractional screen pixels
    // via the viewBox→element scale, which is a known source of consistent
    // 1–2 px offsets when CSS transforms are applied.
    const minX = Math.round(vbX - m * vbW);
    const minY = Math.round(vbY - m * vbH);
    const maxX = Math.round(vbX + (1 + m) * vbW);
    const maxY = Math.round(vbY + (1 + m) * vbH);
    return [minX, minY, maxX - minX, maxY - minY];
  }, [effectiveViewBox, renderMargin, containerDimensions, debugLog]);

  // Style cache - invalidates when any style-affecting prop changes
  const styleCache = useCache([
    data, dotStyles, radiusOverrides, stroke, strokeWidth, defaultColor, defaultSize, defaultOpacity,
    hoverSizeMultiplier, hoverOpacity, useImages, imageProvider, hoverImageProvider
  ], {
    debug,
    name: 'ColoredDots.styles'
  });

  // Pulse animation hook
  // Note: We can't pass liveTransitionDataRef here since it's in DotVisualization, not ColoredDots
  // Instead, the pulse callback will use whatever data is currently in the 'data' prop
  // This is acceptable because pulse animations are visual effects that don't need frame-perfect sync
  const getPulseMultipliers = usePulseAnimation(dotStyles, useCanvas ? () => {
    // During decollision, DotVisualization pushes live positions directly via
    // renderCanvasWithData(). Skip pulse-triggered redraws to avoid dual writers
    // competing between processedData and live transition frames.
    if (isDecollisioning) return;
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

  const getPulseData = (item, index, baseColor) => {
    const resolvedColor = baseColor ?? getColor(item, index);
    return getPulseMultipliers(item.id, resolvedColor);
  };

  const getSize = (item, index, pulseData) => {
    const customStyles = dotStyles.get(item.id);
    const baseSize = customStyles?.r ?? radiusOverrides.get(item.id) ?? item.size ?? defaultSize;
    const resolvedPulseData = pulseData ?? getPulseData(item, index);
    const { sizeMultiplier } = resolvedPulseData;
    let finalSize = baseSize * sizeMultiplier;

    if (hoveredDotId === item.id) {
      // Check for per-dot hover multiplier override
      const effectiveHoverMultiplier = customStyles?.hoverSizeMultiplier ?? hoverSizeMultiplier;
      finalSize *= effectiveHoverMultiplier;
    }
    return finalSize;
  };

  const getOpacity = (item, index, pulseData) => {
    const baseOpacity = hoveredDotId === item.id ? hoverOpacity : defaultOpacity;
    const resolvedPulseData = pulseData ?? getPulseData(item, index);
    const { opacityMultiplier } = resolvedPulseData;
    return baseOpacity * opacityMultiplier;
  };

  const getEffectiveColor = (_item, _index, pulseData) => {
    return pulseData.color;
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
        const baseColor = getColor(item, index);
        const pulseData = getPulseData(item, index, baseColor);
        const baseStyles = {
          fill: isCanvas ? getEffectiveColor(item, index, pulseData) : getFill(item, index),
          stroke: stroke,
          strokeWidth: strokeWidth,
          opacity: getOpacity(item, index, pulseData),
          size: getSize(item, index, pulseData),
          __pulseData: pulseData
        };

        // Apply custom dotStyles
        const mergedStyles = { ...baseStyles, ...customStyles };

        // Handle stroke-width vs strokeWidth property name differences
        if (customStyles['stroke-width'] !== undefined) {
          mergedStyles.strokeWidth = customStyles['stroke-width'];
        }

        // Hover opacity takes precedence ONLY if custom opacity is not set
        if (isHovered && customStyles.opacity === undefined) {
          mergedStyles.opacity = getOpacity(item, index, pulseData);
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

      // Drop any stale CSS transform left over from a prior gesture, and record
      // the transform we're about to draw at as the new baseline for the next.
      if (canvasRef.current) {
        canvasRef.current.style.transform = '';
      }
      lastDrawnTransformRef.current = { x: t.x, y: t.y, k: t.k };

      // Reset to identity
      canvasContext.setTransform(1, 0, 0, 1, 0, 0);
      // Re-apply base viewBox transform
      let viewBoxScale = 1;
      let canvasDPR = 1;
      if (extendedViewBox && canvasDimensionsRef.current) {
        const { width, height } = canvasDimensionsRef.current;
        const dpr = (window.devicePixelRatio || 1) * 2;
        canvasDPR = dpr; // Store DPR for accurate pixel calculations
        const [vbX, vbY, vbW, vbH] = extendedViewBox;
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
      if (extendedViewBox) {
        const [vbX, vbY, vbW, vbH] = extendedViewBox;
        canvasContext.clearRect(vbX, vbY, vbW, vbH);
      }

      // Build spatial index for mouse interaction in CSS pixel space.
      // Use extendedViewBox so canvas-local mouse positions in the margin map
      // correctly — the canvas covers the extended area, not just the visible one.
      const cssTransform = transformToCSSPixels(t, extendedViewBox, canvasDimensionsRef.current);

      // Spatial index lives in DATA-space (see canvasInteractions.js), so the
      // transform doesn't invalidate it — only dot positions themselves do.
      // Decollision counts because dots are physically moving each frame.
      const lastState = canvasRef.current._lastSpatialIndexState;
      const dataLength = dataToRender.length;
      const firstDotX = dataToRender[0]?.x;
      const firstDotY = dataToRender[0]?.y;
      const lastDotX = dataToRender[dataToRender.length - 1]?.x;
      const lastDotY = dataToRender[dataToRender.length - 1]?.y;

      const shouldRebuildSpatialIndex = isDecollisioning || !lastState ||
        lastState.dataLength !== dataLength ||
        lastState.firstDotX !== firstDotX ||
        lastState.firstDotY !== firstDotY ||
        lastState.lastDotX !== lastDotX ||
        lastState.lastDotY !== lastDotY;

      if (shouldRebuildSpatialIndex) {
        const spatialIndex = buildSpatialIndex(dataToRender, getSize);
        if (spatialIndex) {
          canvasRef.current._spatialIndex = spatialIndex;
          canvasRef.current._lastSpatialIndexState = {
            dataLength,
            firstDotX,
            firstDotY,
            lastDotX,
            lastDotY,
          };

          if (debug && process.env.NODE_ENV === 'development' && Math.random() < 0.05) {
            console.log('[ColoredDots] Rebuilt spatial index (data changed)');
          }
        }
      }

      // Stash the current CSS-pixel transform every render so hover handlers
      // can invert mouse coords into data-space at query time. Pointer write,
      // not a rebuild.
      canvasRef.current._cssTransform = cssTransform;

      // Canvas rendering: use unified styling logic
      const drawDot = (item, index) => {
        const styles = computeFinalStyles(item, index, true);
        const { __pulseData, ...renderStyles } = styles;
        const pulseData = __pulseData ?? getPulseData(item, index);
        const radius = Math.min(renderStyles.size, maxDotRadius);

        // Allow custom renderer to override default drawing
        if (customDotRenderer) {
          const didRender = customDotRenderer(canvasContext, item, renderStyles, {
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

          canvasContext.globalAlpha = pulseData.ringData.opacity * renderStyles.opacity;
          canvasContext.fillStyle = pulseData.ringData.color;
          canvasContext.beginPath();
          canvasContext.arc(item.x, item.y, ringRadius, 0, 2 * Math.PI);
          canvasContext.fill();
        }

        // Draw main dot
        canvasContext.globalAlpha = renderStyles.opacity;
        canvasContext.fillStyle = renderStyles.fill;
        canvasContext.strokeStyle = renderStyles.stroke;
        const effectiveStrokeWidth = strokeWidthFraction != null ? radius * strokeWidthFraction : renderStyles.strokeWidth;
        canvasContext.lineWidth = effectiveStrokeWidth;

        canvasContext.beginPath();
        canvasContext.arc(item.x, item.y, radius, 0, 2 * Math.PI);
        canvasContext.fill();
        if (effectiveStrokeWidth > 0) {
          if (renderStyles.strokeDasharray) {
            canvasContext.setLineDash(renderStyles.strokeDasharray);
          }
          canvasContext.stroke();
          if (renderStyles.strokeDasharray) {
            canvasContext.setLineDash([]);
          }
        }
      };

      // Viewport culling: skip dots outside the canvas's covered area.
      // Uses extendedViewBox so the margin gets populated with pre-drawn dots
      // (so GPU-pan can reveal them at the edges without redrawing).
      const [vbX, vbY, vbW, vbH] = extendedViewBox || [0, 0, 100, 100];
      const visibleBounds = {
        left: (vbX - t.x) / t.k,
        right: (vbX + vbW - t.x) / t.k,
        top: (vbY - t.y) / t.k,
        bottom: (vbY + vbH - t.y) / t.k
      };

      // Max dot radius: 15% of visible viewport height in data units.
      // Prevents dots from filling the screen during volatile early UMAP frames
      // when zoom-to-fit has zoomed in tight but dot sizing hasn't adjusted yet.
      const visibleHeight = visibleBounds.bottom - visibleBounds.top;
      const maxDotRadius = Math.abs(visibleHeight) * 0.075; // diameter = 15%

      // Draw all non-hovered dots first, then hovered dot last (on top)
      let hoveredItem = null;
      let hoveredIndex = -1;
      let culledCount = 0;

      dataToRender.forEach((item, index) => {
        // Viewport culling: skip dots that are completely outside visible bounds
        const radius = getSize(item, index);
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

    // Set up coordinate system to cover the extended viewBox so dots in the
    // GPU-pan margin land inside the canvas bitmap, not clipped off the edge.
    if (extendedViewBox) {
      const [vbX, vbY, vbW, vbH] = extendedViewBox;

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
    if (extendedViewBox) {
      const [vbX, vbY, vbW, vbH] = extendedViewBox;
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



  // Reset canvas dimensions cache when the extended viewBox changes (resize
  // or renderMargin change — both alter the canvas's on-screen size).
  useEffect(() => {
    if (useCanvas && extendedViewBox) {
      canvasDimensionsRef.current = null;
      debugLog('Canvas dimensions cache cleared for viewBox change');
    }
  }, [extendedViewBox, useCanvas]);

  // Backdrop: render the full dataset once at low resolution, sized to the
  // data bounding box. Updates only when data identity/length changes, so
  // it's basically free during pan/zoom. The CSS transform applied during
  // interaction mirrors the d3-zoom transform exactly (computed in the ref
  // method below), keeping it pixel-aligned with the foreground.
  useEffect(() => {
    if (!useCanvas || !data || data.length === 0 || !backdropRef.current) {
      return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let maxRadius = 0;
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      if (typeof d.x !== 'number' || typeof d.y !== 'number') continue;
      if (d.x < minX) minX = d.x;
      if (d.x > maxX) maxX = d.x;
      if (d.y < minY) minY = d.y;
      if (d.y > maxY) maxY = d.y;
      const r = (d.size || defaultSize) / 2;
      if (r > maxRadius) maxRadius = r;
    }
    if (!isFinite(minX)) return;

    // Expand the bbox by the largest dot radius so edges aren't clipped.
    const pad = maxRadius * 2;
    const bbox = {
      minX: minX - pad,
      minY: minY - pad,
      width: Math.max(1, maxX - minX + 2 * pad),
      height: Math.max(1, maxY - minY + 2 * pad),
    };

    // 2048 max dim gives 4× the spatial resolution of 1024 — fewer
    // sub-pixel issues at zoom-out, at the cost of ~16 MB instead of 4 MB.
    const MAX_DIM = 2048;
    const aspect = bbox.width / bbox.height;
    const bitW = aspect >= 1 ? MAX_DIM : Math.max(1, Math.round(MAX_DIM * aspect));
    const bitH = aspect >= 1 ? Math.max(1, Math.round(MAX_DIM / aspect)) : MAX_DIM;

    const canvas = backdropRef.current;
    canvas.width = bitW;
    canvas.height = bitH;
    const ctx = canvas.getContext('2d');
    const scaleX = bitW / bbox.width;
    const scaleY = bitH / bbox.height;
    ctx.setTransform(scaleX, 0, 0, scaleY, -bbox.minX * scaleX, -bbox.minY * scaleY);
    ctx.clearRect(bbox.minX, bbox.minY, bbox.width, bbox.height);

    // Enforce a minimum bitmap-pixel radius so naturally-tiny dots (e.g.,
    // ~0.7 world units at 50k count) don't render at sub-pixel size on the
    // backdrop. Without this, the backdrop bitmap is functionally empty —
    // CSS-shrinking it during zoom-out then shows the page background
    // through it, defeating the whole "always-on lower layer" contract.
    const MIN_BITMAP_RADIUS = 1.5;
    const minWorldRadius = MIN_BITMAP_RADIUS / Math.min(scaleX, scaleY);

    // Simplified draw — no pulse rings, hover, or custom renderer. This is
    // the "always visible at the edges" backdrop, not the primary surface.
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      if (typeof d.x !== 'number' || typeof d.y !== 'number') continue;
      const r = Math.max((d.size || defaultSize) / 2, minWorldRadius);
      ctx.fillStyle = d.color || defaultColor || '#666';
      ctx.globalAlpha = defaultOpacity;
      ctx.beginPath();
      ctx.arc(d.x, d.y, r, 0, 2 * Math.PI);
      ctx.fill();
    }

    setDataBBox(bbox);

    // Apply the current zoom transform to the backdrop NOW so it lands at
    // the right place on first paint. Without this, the backdrop's CSS
    // transform stays empty until the first user gesture — which means at
    // mount, the backdrop sits at its raw foreignObject coords (in world
    // units, often way outside the SVG viewBox) and is invisible.
    if (typeof getZoomTransform === 'function') {
      const transform = getZoomTransform();
      if (transform && canvas) {
        const s = transform.k;
        const tx = transform.x + bbox.minX * (s - 1);
        const ty = transform.y + bbox.minY * (s - 1);
        canvas.style.transformOrigin = '0 0';
        canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
      }
    }

    debugLog('Backdrop rendered:', { dots: data.length, bbox, bitmap: `${bitW}x${bitH}` });
  }, [useCanvas, data, defaultSize, defaultColor, defaultOpacity, debugLog, getZoomTransform]);

  // Canvas rendering for data/style changes (NOT zoom, NOT hover)
  // Note: hoveredDotId, hoverSizeMultiplier, hoverOpacity intentionally excluded from deps
  // Hover changes are reflected in renderDots() via closure, but don't trigger full redraws
  // This prevents flickering during hover
  useEffect(() => {
    if (!useCanvas) { canvasDimensionsRef.current = null; return; }
    // Decollision path owns canvas writes through renderCanvasWithData().
    // Skipping this effect avoids flicker from stale processedData redraws.
    if (isDecollisioning) return;

    debugLog('Canvas effect render:', { dataLength: data.length, isDecollisioning });
    const ctx = setupCanvas();
    if (ctx) renderDots(ctx, getZoomTransform?.());
  }, [data, dotStyles, radiusOverrides, stroke, strokeWidth, defaultColor, defaultSize, defaultOpacity, useImages, useCanvas, customDotRenderer, isDecollisioning]);

  // Hover-only repaint. Without this, canvas hover updates rely entirely on
  // the pulse rAF loop, which is dormant when no dot has a `pulse` config —
  // i.e. the canvas never repaints on hover for non-pulsing apps. Same paint
  // mechanism (setupCanvas + renderDots) the pulse path uses, just triggered
  // by hover state instead of rAF. Skipped during decollision so we don't
  // race renderCanvasWithData(); skipped when the pulse loop is already
  // running so we don't double-paint.
  useEffect(() => {
    if (!useCanvas) return;
    if (isDecollisioning) return;
    // Pulse loop is already redrawing each frame; skip to avoid dual writers.
    let pulseDotCount = 0;
    for (const [, style] of dotStyles) if (style?.pulse) pulseDotCount++;
    if (pulseDotCount > 0) return;

    const ctx = setupCanvas();
    if (ctx) renderDots(ctx, getZoomTransform?.());
  }, [hoveredDotId, useCanvas, isDecollisioning, dotStyles]);



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
    // GPU-pan/zoom: apply CSS transform on the canvas element so the existing
    // bitmap is shifted/scaled on the compositor instead of redrawn. Returns
    // false if no baseline yet (caller should redraw instead).
    //
    // Coordinates: the canvas lives inside `<foreignObject>`, so its own CSS
    // pixel space equals viewBox units (the foreignObject width/height
    // attributes define the inner HTML viewport size). The SVG viewBox→screen
    // mapping is applied AFTER the CSS transform on the canvas, so we use the
    // d3-zoom transform deltas directly — no cssW/vbW scaling here, or the
    // SVG would apply it a second time.
    //
    // The origin we subtract is the *canvas's* viewBox origin, which is the
    // extendedViewBox top-left when renderMargin > 0 (the canvas covers a
    // slightly larger area than the visible viewBox).
    applyGpuTransform: (currentTransform) => {
      if (!useCanvas || !canvasRef.current) return false;
      const base = lastDrawnTransformRef.current;
      if (!base || !extendedViewBox) return false;
      const [vbX, vbY] = extendedViewBox;
      const s = currentTransform.k / base.k;
      const tx = (currentTransform.x - vbX) - s * (base.x - vbX);
      const ty = (currentTransform.y - vbY) - s * (base.y - vbY);
      const el = canvasRef.current;
      el.style.transformOrigin = '0 0';
      el.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
      return true;
    },
    clearGpuTransform: () => {
      if (canvasRef.current) {
        canvasRef.current.style.transform = '';
      }
    },
    // Backdrop's "baseline" is identity (drawn in world coords), so the CSS
    // transform is just the current d3-zoom transform — adjusted for the
    // backdrop canvas's origin in viewBox coords (dataBBox.minX/minY).
    applyBackdropTransform: (transform) => {
      const el = backdropRef.current;
      if (!el || !dataBBox) return;
      const s = transform.k;
      const tx = transform.x + dataBBox.minX * (s - 1);
      const ty = transform.y + dataBBox.minY * (s - 1);
      el.style.transformOrigin = '0 0';
      el.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    },
    // True if the foreground bitmap no longer covers the visible viewport
    // with a safety margin, or the scale has changed enough that the
    // CSS-stretched bitmap is visibly blurry. When this returns false,
    // skip the settle redraw — the GPU layer is already showing the correct
    // content and a fresh paint isn't needed yet.
    foregroundNeedsRedraw: (transform) => {
      const base = lastDrawnTransformRef.current;
      if (!base || !extendedViewBox || !effectiveViewBox) return true;

      const s = transform.k / base.k;
      // Scale change >10% — the CSS-stretched bitmap is too blurry at this
      // zoom relative to its rendered resolution; refresh for crispness.
      if (Math.abs(s - 1) > 0.10) return true;

      const [exVbX, exVbY, exVbW, exVbH] = extendedViewBox;
      const tx = (transform.x - exVbX) - s * (base.x - exVbX);
      const ty = (transform.y - exVbY) - s * (base.y - exVbY);
      // ViewBox extent of the foreground bitmap after the GPU CSS transform.
      const bitmapLeft = exVbX + tx;
      const bitmapTop = exVbY + ty;
      const bitmapRight = exVbX + exVbW * s + tx;
      const bitmapBottom = exVbY + exVbH * s + ty;

      const [vbX, vbY, vbW, vbH] = effectiveViewBox;
      // Require a quarter-viewport safety strip between visible edges and
      // bitmap edges — gives some pan headroom before the next redraw.
      const safetyX = vbW * 0.25;
      const safetyY = vbH * 0.25;

      return (
        vbX < bitmapLeft + safetyX ||
        vbX + vbW > bitmapRight - safetyX ||
        vbY < bitmapTop + safetyY ||
        vbY + vbH > bitmapBottom - safetyY
      );
    },
    findDotAtPosition: (mouseX, mouseY) => {
      if (!useCanvas) return null;
      const index = canvasRef.current?._spatialIndex;
      const transform = canvasRef.current?._cssTransform;
      if (!index || !transform) return null;
      return findDotAtPosition(mouseX, mouseY, transform, index);
    }
  }), [useCanvas, setupCanvas, renderDots, findDotAtPosition, extendedViewBox, dataBBox]);


  useEffect(() => {
    if (!useCanvas) {
      // console.log('🟣 ColoredDots SVG useEffect triggered - data length:', data.length, 'first item:', data[0]?.x?.toFixed(2), data[0]?.y?.toFixed(2));
      debugLog('SVG render:', { dataLength: data.length });
      renderDots();
    }
    // SVG needs all dependencies including dotStyles for positioning
  }, [data, dotStyles, radiusOverrides, dotId, stroke, strokeWidth, defaultColor, defaultSize, defaultOpacity, hoveredDotId, hoverSizeMultiplier, hoverOpacity, useImages, imageProvider, hoverImageProvider, useCanvas, customDotRenderer]);

  // Canvas interaction handlers using utility hook
  const canvasInteractionHandlers = useCanvasInteractions({
    enabled: useCanvas,
    isZooming,
    getSpatialIndex: () => canvasRef.current?._spatialIndex,
    getTransform: () => canvasRef.current?._cssTransform,
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
    // The foreignObject covers the *extended* viewBox so the canvas inside it
    // includes a margin around the visible area. The SVG's viewBox stays at
    // the visible region, so anything outside it gets clipped — until GPU-pan
    // shifts the canvas and reveals the pre-rendered margin at the edges.
    const vb = extendedViewBox || [0, 0, 1000, 1000];

    return (
      <>
        {/* Backdrop: low-res, full-dataset, drawn behind the main canvas.
            Fills the edges when GPU-pan crosses the main canvas's margin.
            Rendered first so it sits behind in SVG paint order. */}
        {dataBBox && (
          <foreignObject
            x={dataBBox.minX}
            y={dataBBox.minY}
            width={dataBBox.width}
            height={dataBBox.height}
          >
            <canvas
              ref={backdropRef}
              style={{
                width: '100%',
                height: '100%',
                display: 'block',
                willChange: 'transform',
                pointerEvents: 'none',
              }}
            />
          </foreignObject>
        )}
        <foreignObject x={vb[0]} y={vb[1]} width={vb[2]} height={vb[3]}>
          <canvas
            ref={canvasRef}
            {...canvasInteractionHandlers}
            style={{
              width: '100%',
              height: '100%',
              display: 'block',
              // Keep the canvas permanently on its own compositor layer so that
              // toggling `style.transform` between empty and a value during
              // GPU-pan/zoom doesn't trigger a layer promotion/demotion, which
              // can shift the canvas by 1–2 px on settle.
              willChange: 'transform',
              pointerEvents: useCanvas ? 'auto' : 'none' // Enable interactions for canvas mode
            }}
          />
        </foreignObject>
      </>
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
            r={getSize(item, index)}
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
