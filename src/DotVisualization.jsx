import { useEffect, useState, useRef, useCallback, useImperativeHandle, useMemo, forwardRef } from 'react';
import * as d3 from 'd3';
import ColoredDots from './ColoredDots.jsx';
import InteractionLayer from './InteractionLayer.jsx';
import ClusterLabels from './ClusterLabels.jsx';
import EdgeLayer from './EdgeLayer.jsx';
import { countVisibleDots } from './utils.js';
import { ZoomManager } from './ZoomManager.js';
import { useDebug } from './useDebug.js';
import { useLatest } from './useLatest.js';
import { useDotHoverHandlers } from './useDotHoverHandlers.js';
import { useStablePositions } from './useStablePositions.js';
import { usePositionChangeDetection } from './usePositionChangeDetection.js';
import { useDecollisionScheduler } from './useDecollisionScheduler.js';

const EMPTY_RADIUS_OVERRIDES = new Map();

/**
 * Pure decision logic extracted from the data effect.
 *
 * Given new data, previous data, cache state, and flags, determines
 * what processedData should be committed. This is the core logic that
 * decides whether to restore decollisioned positions or use raw input.
 *
 * @param {Object} params
 * @param {Array} params.validData - New data with raw positions
 * @param {Array} params.previousData - Data from the previous render (for change detection)
 * @param {boolean} params.positionsAreIntermediate - Whether layout is still running
 * @param {Map|null} params.cachedPositions - Decollisioned positions from cache
 * @param {Array} params.previousProcessedData - Last committed processedData
 * @param {Function} params.hasPositionsChangedFn - Position comparison function
 * @returns {{ processedData: Array, positionsChanged: boolean }}
 */
export function resolveDataEffectPositions({
  validData,
  previousData,
  positionsAreIntermediate,
  cachedPositions,
  previousProcessedData,
  hasPositionsChangedFn,
}) {
  const positionsChanged = previousData.length === 0 ||
    hasPositionsChangedFn(validData, previousData);

  let processedData = validData;

  // When positions haven't changed and layout is settled, restore
  // decollisioned positions from cache to prevent snapping to raw UMAP.
  // The hasCache guard preserves the original behavior: without a cache
  // system, raw positions are used (no fallback to previousProcessedData).
  if (!positionsChanged && !positionsAreIntermediate) {
    processedData = restoreDecollisionedPositions(
      validData,
      cachedPositions,
      previousProcessedData,
    );
  }

  // ── R9: Data shrunk — keep on-screen positions, let scheduler animate ──
  // When dots are removed (data shrunk, not positions moved), preserve
  // current decollisioned positions for remaining dots. The scheduler's
  // Trigger 2 will animate the constraint-to-base transition smoothly.
  // Safe for imports: import operations only add dots, never remove them.
  const dataShrunk = positionsChanged && previousData.length > 0
    && validData.length < previousData.length;
  if (dataShrunk && !positionsAreIntermediate) {
    processedData = restoreDecollisionedPositions(
      validData,
      null, // skip cache — fall through to previousProcessedData
      previousProcessedData,
    );
  }

  return { processedData, positionsChanged };
}

/**
 * Restore decollisioned x/y positions onto fresh data items.
 *
 * Priority: cache hit > previous processedData > raw input (no-op).
 * The processedData fallback handles the case where the cache was just
 * cleared (e.g. scopeKey changed) but the underlying positions are unchanged.
 */
export function restoreDecollisionedPositions(validData, cachedPositions, previousProcessedData) {
  if (cachedPositions && cachedPositions.size > 0) {
    return validData.map(item => {
      const pos = cachedPositions.get(item.id);
      return pos ? { ...item, x: pos.x, y: pos.y } : item;
    });
  }
  if (previousProcessedData && previousProcessedData.length > 0) {
    const posMap = new Map(previousProcessedData.map(p => [p.id, p]));
    return validData.map(item => {
      const prev = posMap.get(item.id);
      return prev ? { ...item, x: prev.x, y: prev.y } : item;
    });
  }
  return validData;
}

const DotVisualization = forwardRef((props, ref) => {
  const {
    data = [],
    edges = [],
    clusters = [],
    clusterKey = (item) => item.cluster_level_0,
    renderCluster,
    hoveredCluster,
    onClusterHover,
    onClusterLeave,
    onHover,
    onLeave,
    onClick,
    onContextMenu,
    onBackgroundClick,
    onDragStart,
    dragIcon,
    onZoomStart,
    onZoomEnd,
    onDecollisionComplete,
    sharedPositionCache = null,
    enableDecollisioning = true,
    decollisionEngine = 'auto',
    isIncrementalUpdate = false,
    transitionDuration = 350,
    transitionEasing = d3.easeCubicOut,
    positionsAreIntermediate = false,
    viewBoxSmoothingR = 0.5,
    viewBoxSmoothingQ = 3,
    viewBoxTransitionDuration = 1500,
    scopeKey = 'default',
    constraintKey = '',
    zoomExtent = [0.5, 20],
    scrollZoomModifier = 'meta-or-alt',
    margin = 0.1,
    dotStroke = "#111",
    dotStrokeWidth = 0.2,
    dotStrokeWidthFraction = null,
    defaultColor = null,
    defaultSize = 2,
    defaultOpacity = 0.7,
    dotStyles = new Map(),
    radiusOverrides = EMPTY_RADIUS_OVERRIDES,
    useImages = false,
    imageProvider,
    hoverImageProvider,
    customDotRenderer = null,
    edgeOpacity = 0.3,
    edgeColor = "#999",
    className = "",
    style = {},
    occludeLeft = 0,
    occludeRight = 0,
    occludeTop = 0,
    occludeBottom = 0,
    autoFitToVisible = false,
    fitMargin = 0.9,
    autoZoomToNewContent = false,
    autoZoomDuration = 200,
    hoverSizeMultiplier = 1.5,
    hoverOpacity = 1.0,
    useCanvas = false,
    gpuPanZoom = false,
    renderMargin = 0,
    blockHoverDuringInteraction = false,
    pausePulseDuringInteraction = false,
    debug = false,
    sendMetrics = false,
    initialTransform = null,
    children,
    backgroundChildren,
    foregroundChildren,
    ...otherProps
  } = props;

  const [processedData, setProcessedData] = useState([]);
  const [containerDimensions, setContainerDimensions] = useState(null);
  const [isSimulationRunning, setIsSimulationRunning] = useState(false);

  // Fixed viewBox with aspect ratio matching container
  // World coordinates are separate from camera framing.
  // Memoizing prevents referential churn that can retrigger heavy effects.
  const viewBox = useMemo(() => {
    if (!containerDimensions) {
      return [0, 0, 100, 100]; // Default square until container measured
    }

    const aspectRatio = containerDimensions.width / containerDimensions.height;
    const baseHeight = 100;
    const baseWidth = baseHeight * aspectRatio;

    return [0, 0, baseWidth, baseHeight];
  }, [containerDimensions]);
  const [isDragging, setIsDragging] = useState(false);
  const [isZoomSetupComplete, setIsZoomSetupComplete] = useState(false);
  const [visibleDotCount, setVisibleDotCount] = useState(0);

  // Refs - must be declared before hooks that use them
  const zoomRef = useRef(null);
  const contentRef = useRef(null);
  const coloredDotsRef = useRef(null);
  const zoomManager = useRef(null);

  // Position transition hooks
  const { updateStablePositions, clearStablePositions, shouldUseStablePositions } = useStablePositions();
  const hasPositionsChanged = usePositionChangeDetection(defaultSize);

  // Block hover only when dragging (not during wheel zoom)
  const isZooming = isDragging;

  // Manage hover state and callbacks
  const { hoveredDotId, handleDotHover, handleDotLeave, clearHover } = useDotHoverHandlers(onHover, onLeave);

  // Scheduler ref (set after useDecollisionScheduler call below)
  const schedulerRef = useRef(null);

  // Keep latest values accessible in closures without triggering re-runs
  const isDraggingRef = useLatest(isDragging);
  const onZoomStartRef = useLatest(onZoomStart);
  const onZoomEndRef = useLatest(onZoomEnd);
  const onLeaveRef = useLatest(onLeave);

  const debugLog = useDebug(debug);

  // GPU-pan/zoom: during an active gesture, apply CSS transforms to the
  // canvas element instead of redrawing. The bitmap stays put on the GPU
  // compositor and the browser shifts/scales it; once interaction goes
  // idle (see markInteractionActive's settle path) we redraw at the final
  // transform and reset CSS. Kept in a ref so the canvasRenderer closure
  // created in the init effect picks up live values.
  const gpuPanZoomRef = useLatest(gpuPanZoom);

  // Function to update visible dot count
  const updateVisibleDotCount = useCallback(() => {
    if (!processedData.length || !viewBox || !zoomManager.current) return;

    const currentTransform = zoomManager.current.getCurrentTransform();
    if (!currentTransform) return;

    const count = countVisibleDots(processedData, currentTransform, viewBox, defaultSize);
    setVisibleDotCount(prev => prev === count ? prev : count);
    debugLog('Visible dots:', count);
  }, [processedData, viewBox, defaultSize, debugLog]);

  // Track transform changes to automatically update visible count  
  const prevTransformRef = useRef(null);
  const updateCountOnTransformChange = useCallback(() => {
    if (!zoomManager.current) return;

    const current = zoomManager.current.getCurrentTransform();
    const prev = prevTransformRef.current;

    if (!current) return;

    // Check if transform actually changed
    if (!prev || prev.k !== current.k || prev.x !== current.x || prev.y !== current.y) {
      prevTransformRef.current = { k: current.k, x: current.x, y: current.y };
      updateVisibleDotCount();
    }
  }, [updateVisibleDotCount]);

  // Keep latest callback accessible without triggering re-runs
  const updateCountOnTransformChangeRef = useLatest(updateCountOnTransformChange);

  const dataRef = useRef([]);
  const processedDataRef = useRef([]);
  const constraintKeyRef = useLatest(constraintKey);
  const previousDataRef = useRef([]);
  const didInitialAutoFitRef = useRef(false);
  const autoZoomTimeoutRef = useRef(null);
  const interactionActiveRef = useRef(false);
  const interactionIdleTimerRef = useRef(null);
  // Mirror of `interactionActiveRef` as React state, flipped only on the
  // rising and falling edges of a gesture — not per zoom event. Lets effects
  // and hooks react to "interaction started/ended" without polling. Costs
  // two re-renders per gesture; the ref is still the synchronous source.
  const [interactionActive, setInteractionActive] = useState(false);

  const markInteractionActive = useCallback(() => {
    if (!interactionActiveRef.current) {
      interactionActiveRef.current = true;
      setInteractionActive(true);
    }
    if (interactionIdleTimerRef.current) {
      clearTimeout(interactionIdleTimerRef.current);
    }
    // ~2 frames. Short enough that the settle fires almost immediately when
    // the user stops, so the bitmap is always near-current and the GPU layer
    // only ever shows a small CSS delta. Long enough that natural inter-event
    // gaps (~16 ms on trackpad/drag, faster than this) don't trip a settle
    // mid-burst. No bifurcation for zoom vs pan — same window works for both.
    const SETTLE_IDLE_MS = 32;
    interactionIdleTimerRef.current = setTimeout(() => {
      interactionActiveRef.current = false;
      setInteractionActive(false);
      interactionIdleTimerRef.current = null;
      // GPU mode: now that the gesture has settled, redraw the canvas at the
      // current transform so the next gesture starts from a fresh baseline
      // with no leftover CSS skew on the element.
      if (gpuPanZoomRef.current && coloredDotsRef.current) {
        const t = zoomManager.current?.getCurrentTransform();
        if (t) {
          // Skip the foreground redraw when the existing bitmap still covers
          // the visible viewport and the scale hasn't changed much. Small pans
          // at any zoom level stay within the over-rendered margin, so they
          // don't need fresh content — the GPU layer already shows the right
          // pixels and a redraw would just block input for ~30 ms.
          const needsRedraw = coloredDotsRef.current.foregroundNeedsRedraw?.(t);
          if (needsRedraw !== false) {
            if (liveTransitionDataRef.current) {
              coloredDotsRef.current.renderCanvasWithData(liveTransitionDataRef.current, t);
            } else {
              coloredDotsRef.current.renderCanvasWithTransform(t);
            }
          }
          // Sync backdrop *after* any foreground redraw so its coverage
          // check uses the fresh baseline. Typically hides the backdrop
          // post-settle since the foreground now covers the viewport.
          coloredDotsRef.current.syncBackdrop?.(t);
        }
      }
    }, SETTLE_IDLE_MS);
  }, []);




  const zoomToVisible = useCallback(async (duration = 0, easing = d3.easeCubicInOut, dataOverride = null, marginOverride = null, updateExtents = true, maxScale = Infinity) => {
    if (!zoomManager.current) return false;
    const dataToUse = dataOverride || processedData;
    const options = { duration, easing, updateExtents, maxScale };
    if (marginOverride !== null) {
      options.margin = marginOverride;
    }
    return await zoomManager.current.zoomToVisible(dataToUse, options);
  }, [processedData]);

  const getFitTransform = useCallback((dataOverride = null, marginOverride = null) => {
    if (!zoomManager.current) return null;
    const dataToUse = dataOverride || processedData;
    const options = {};
    if (marginOverride !== null) {
      options.margin = marginOverride;
    }
    return zoomManager.current.getFitTransform(dataToUse, options);
  }, [processedData]);

  const setZoomTransform = useCallback((transform, options = {}) => {
    if (!zoomManager.current || !transform) return false;
    const { direct = true } = options;
    if (direct) {
      zoomManager.current.applyTransformDirect(
        d3.zoomIdentity.translate(transform.x, transform.y).scale(transform.k)
      );
    } else {
      zoomManager.current.applyTransformViaZoomHandler(
        d3.zoomIdentity.translate(transform.x, transform.y).scale(transform.k)
      );
    }
    return true;
  }, []);

  // Generate unique dot IDs
  const dotId = useCallback((layer, item) => {
    return `dot-${layer}-${item.id}`;
  }, []);

  // Stable getter so children that use this in an effect dep list don't
  // re-run on every parent render (zoomManager is a mutable ref).
  const getZoomTransform = useCallback(
    () => zoomManager.current?.getCurrentTransform() || d3.zoomIdentity,
    []
  );

  // Auto-generate IDs if missing
  const ensureIds = useCallback((data) => {
    return data.map((item, index) => ({
      ...item,
      id: item.id !== undefined ? item.id : index
    }));
  }, []);

  // Process data and set up initial state.
  // With the scheduler, this effect no longer handles constraint transitions or
  // decollision retry queuing. It validates data, checks scope changes, restores
  // cached positions on unchanged re-renders, and manages auto-zoom.
  useEffect(() => {
    if (!data || data.length === 0) {
      setProcessedData([]);
      processedDataRef.current = [];
      return;
    }

    // Auto-generate IDs and validate required fields
    const dataWithIds = ensureIds(data);
    const validData = dataWithIds.filter(item =>
      typeof item.x === 'number' &&
      typeof item.y === 'number'
    );

    if (validData.length === 0) {
      console.warn('DotVisualization: No valid data items found. Each item must have x and y properties.');
      return;
    }

    // ── Scope change detection ──────────────────────────────────────────────
    // Clear cache on scope changes (collection/checkpoint switch, refresh).
    // Constraint transitions are handled by the scheduler, not this effect.
    let scopeChangedThisRender = false;
    if (sharedPositionCache) {
      scopeChangedThisRender = sharedPositionCache.checkScope(scopeKey);
      if (scopeChangedThisRender && schedulerRef.current) {
        // Order matters: the scheduler reads `dataRef.current` synchronously
        // while resolving the constraint request. If we leave dataRef
        // pointing at the previous render's processedValidData, the
        // simulation seeds from a layout decollided against the OLD sizes —
        // and since collision is repulsive-only, smaller new sizes find no
        // overlap to resolve and dots stay spread out forever. Point dataRef
        // at the raw input first so the seed reflects the new sizes.
        dataRef.current = validData;
        // When scope changes, the base cache entry is lost. Request a base
        // re-decollision so that future constraint deselections can animate
        // back to base positions. Without this, deselection falls through to
        // launch-constraint — but decollision is repulsive-only and can't
        // close gaps left by enlarged playlist dots.
        schedulerRef.current.decollideForConstraint('');
      }
    }

    // ── Data count change → re-decollide ───────────────────────────────────
    // Adding or removing dots invalidates the cached base layout: new dots
    // sit at raw positions on top of existing ones. Seed from raw input so
    // the sim resolves overlaps for the full set.
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

    // ── Position resolution: detect changes, restore cache if unchanged ────
    const { processedData: processedValidData } = resolveDataEffectPositions({
      validData,
      previousData: previousDataRef.current,
      positionsAreIntermediate,
      cachedPositions: sharedPositionCache?.cache.get(constraintKeyRef.current) ?? null,
      previousProcessedData: processedDataRef.current,
      hasPositionsChangedFn: hasPositionsChanged,
    });

    // Auto-zoom to new content if enabled (using ZoomManager)
    // Skip auto-zoom during incremental updates - viewBox smoothing handles it
    if (autoZoomToNewContent && zoomManager.current && !isIncrementalUpdate) {
      zoomManager.current.checkAutoZoom(validData, {
        autoZoomToNewContent,
        autoZoomDuration
      });
    } else if (!autoZoomToNewContent && zoomManager.current) {
      // When auto-zoom is disabled, still do initial zoom for first data
      if (!previousDataRef.current?.length && validData.length > 0) {
        zoomManager.current.initZoom(validData);
      } else {
        // Update zoom extents for subsequent data changes
        zoomManager.current.updateZoomExtentsForData(validData);
      }
    }

    // Store original input data for future comparisons
    previousDataRef.current = validData.map(item => ({ ...item })); // Deep copy!
    // For non-scope-change renders, point dataRef at the cache-restored
    // positions so subsequent operations (hover hit-tests, constraint sims)
    // see the visible layout, not raw UMAP. Scope-change renders set dataRef
    // earlier — see the scope-change block above — so the just-launched
    // base re-decollision can seed from raw input.
    if (!scopeChangedThisRender) {
      dataRef.current = processedValidData;
    }

    // Conditional rendering based on update type:
    // - Incremental updates OR intermediate full re-renders: keep stable positions on screen
    // - Settled full renders: apply immediately
    //
    // During import, periodic full re-renders arrive while positionsAreIntermediate is true.
    // Without this guard, those full renders snap processedData to raw UMAP positions,
    // causing a visual jump. By keeping stable positions, we let the scheduler handle
    // the smooth transition when layout finally settles.
    const keepStable = shouldUseStablePositions(isIncrementalUpdate || positionsAreIntermediate, constraintKeyRef.current, validData.length);
    if (keepStable) {
      // Keep rendering stable old positions — scheduler will transition when ready
    } else {
      // Full render with settled positions: apply immediately
      setProcessedData(processedValidData);
      processedDataRef.current = processedValidData;
      if (!isIncrementalUpdate) {
        clearStablePositions();
      }
    }

    // Update visible dot count when data changes
    updateVisibleDotCount();

  }, [data, margin, ensureIds, hasPositionsChanged, positionsAreIntermediate, autoZoomToNewContent, autoZoomDuration, isIncrementalUpdate, scopeKey]);

  // Initialize and set up zoom behavior with ZoomManager once.
  useEffect(() => {
    if (!zoomRef.current || typeof window === 'undefined') {
      return;
    }

    // Create canvas renderer function
    const canvasRenderer = (transform) => {
      if (!coloredDotsRef.current) return;

      // Backdrop layer (full-dataset low-res) tracks the d3 transform on
      // every event in GPU mode and shows itself only when the CSS-shifted
      // foreground bitmap no longer covers the viewport. Hidden otherwise
      // so its low-res dots don't bleed through the foreground's semi-
      // transparent dots.
      if (gpuPanZoomRef.current) {
        coloredDotsRef.current.syncBackdrop?.(transform);
      }

      // GPU path: during an active gesture (or rapid wheel ticks), shift/scale
      // the existing bitmap via CSS instead of redrawing. The compositor
      // handles it on the GPU, so per-frame cost is independent of dot count.
      // The settle redraw fires from markInteractionActive's idle timer.
      if (gpuPanZoomRef.current && interactionActiveRef.current) {
        if (coloredDotsRef.current.applyGpuTransform(transform)) return;
      }

      // Use live transition data if available (during decollision), otherwise fall back to normal render
      if (liveTransitionDataRef.current) {
        coloredDotsRef.current.renderCanvasWithData(liveTransitionDataRef.current, transform);
      } else {
        coloredDotsRef.current.renderCanvasWithTransform(transform);
      }
    };

    // Initialize ZoomManager
    if (!zoomManager.current) {
      zoomManager.current = new ZoomManager({
        zoomRef,
        contentRef,
        canvasRenderer,
        zoomExtent,
        scrollZoomModifier,
        defaultSize,
        fitMargin,
        occludeLeft,
        occludeRight,
        occludeTop,
        occludeBottom,
        useCanvas,
        initialTransform,
        onZoomStart: (event) => {
          markInteractionActive();
          setIsDragging(prev => prev ? prev : true);
          if (onZoomStartRef.current) onZoomStartRef.current(event);
        },
        onZoomEnd: (event) => {
          markInteractionActive();
          setIsDragging(prev => prev ? false : prev);
          updateCountOnTransformChangeRef.current();
          if (onZoomEndRef.current) onZoomEndRef.current(event);
        },
        onTransformChange: () => {
          markInteractionActive();
          updateCountOnTransformChangeRef.current();
        }
      });
    }

    // Initialize zoom behavior
    zoomManager.current.initialize();

    // Add global event listeners
    const handleGlobalMouseUp = () => {
      if (isDraggingRef.current) {
        setIsDragging(prev => prev ? false : prev);
      }
    };

    const handleWindowBlur = () => {
      debugLog('🔍 Window blur - resetting all states');
      clearHover();
      setIsDragging(prev => prev ? false : prev);
      if (onLeaveRef.current) {
        onLeaveRef.current(null, null);
      }
    };

    document.addEventListener('mouseup', handleGlobalMouseUp);
    window.addEventListener('blur', handleWindowBlur);

    setIsZoomSetupComplete(true);

    return () => {
      document.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('blur', handleWindowBlur);
      if (zoomManager.current) {
        zoomManager.current.destroy();
        zoomManager.current = null;
      }
    };
  }, []);

  // Keep zoom config and viewBox in sync without reinitializing listeners/handlers.
  useEffect(() => {
    if (!zoomManager.current) return;

    zoomManager.current.updateConfig({
      zoomExtent,
      scrollZoomModifier,
      defaultSize,
      fitMargin,
      occludeLeft,
      occludeRight,
      occludeTop,
      occludeBottom,
      useCanvas
    });

    if (viewBox) {
      zoomManager.current.setViewBox(viewBox);
    }
  }, [zoomExtent, scrollZoomModifier, viewBox, useCanvas, defaultSize, fitMargin, occludeLeft, occludeRight, occludeTop, occludeBottom]);

  // Handle container resize. ResizeObserver fires on any size change of the
  // SVG's layout box — window resize, parent flex/grid reflow, sibling
  // appearing/disappearing — not just window-level events. Critical for
  // hover correctness: `viewBox` is derived from `containerDimensions`, and
  // a stale viewBox makes the spatial-index transform wrong, which displaces
  // hit-tests against the visibly-painted dots. Pre-ResizeObserver code only
  // listened on `window.resize`, which silently missed layout-only resizes.
  useEffect(() => {
    if (!zoomRef.current) return;
    if (typeof ResizeObserver === 'undefined') return;

    const updateContainerDimensions = () => {
      const rect = zoomRef.current?.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const next = { width: rect.width, height: rect.height };
      // Functional setState avoids the stale-closure check on
      // `containerDimensions` that the previous deps:[] effect had.
      setContainerDimensions((prev) =>
        prev && prev.width === next.width && prev.height === next.height ? prev : next
      );
    };

    // Initial measurement so we have dimensions before the first paint;
    // the observer's first fire will follow shortly after attachment.
    updateContainerDimensions();

    const observer = new ResizeObserver(updateContainerDimensions);
    observer.observe(zoomRef.current);

    return () => observer.disconnect();
  }, []);

  // Re-render canvas when viewBox changes to fix distortion during resize
  useEffect(() => {
    if (useCanvas && coloredDotsRef.current && zoomManager.current && viewBox) {
      const currentTransform = zoomManager.current.getCurrentTransform();
      if (currentTransform) {
        // Use live transition data if available during decollision
        if (liveTransitionDataRef.current) {
          coloredDotsRef.current.renderCanvasWithData(liveTransitionDataRef.current, currentTransform);
        } else {
          coloredDotsRef.current.renderCanvasWithTransform(currentTransform);
        }
      }
    }
  }, [viewBox, useCanvas]);

  // Track live transition data for canvas renderer during decollision
  const liveTransitionDataRef = useRef(null);
  const pendingInteractionFlushRef = useRef(false);

  // Callback for decollisioning updates - wrapped to prevent infinite loops
  const onUpdateNodes = useCallback((nodes) => {
    // Store live transition data for other render paths to use
    liveTransitionDataRef.current = nodes;

    // During active zoom/pan, skip decollision repaints to keep interaction snappy.
    if (isDraggingRef.current || interactionActiveRef.current) {
      pendingInteractionFlushRef.current = true;
      return;
    }

    pendingInteractionFlushRef.current = false;

    if (useCanvas && coloredDotsRef.current) {
      // Update canvas directly with custom data without triggering React re-render
      const currentTransform = zoomManager.current?.getCurrentTransform();
      coloredDotsRef.current.renderCanvasWithData(nodes, currentTransform);
    } else {
      // For SVG mode, update DOM directly
      const dots0 = d3.selectAll('#colored-dots circle').data(nodes);
      const dots1 = d3.selectAll('#interaction-layer circle').data(nodes);
      dots0.attr('cx', d => d.x).attr('cy', d => d.y);
      dots1.attr('cx', d => d.x).attr('cy', d => d.y);
    }
  }, [useCanvas, isDraggingRef]);

  // Flush one deferred decollision frame right after interaction ends.
  useEffect(() => {
    if (isDragging || !pendingInteractionFlushRef.current) return;
    const nodes = liveTransitionDataRef.current;
    if (!nodes) return;

    pendingInteractionFlushRef.current = false;
    if (useCanvas && coloredDotsRef.current) {
      const currentTransform = zoomManager.current?.getCurrentTransform();
      coloredDotsRef.current.renderCanvasWithData(nodes, currentTransform);
    } else {
      const dots0 = d3.selectAll('#colored-dots circle').data(nodes);
      const dots1 = d3.selectAll('#interaction-layer circle').data(nodes);
      dots0.attr('cx', d => d.x).attr('cy', d => d.y);
      dots1.attr('cx', d => d.x).attr('cy', d => d.y);
    }
  }, [isDragging, useCanvas]);

  // Shared primitive for syncing decollision state back to React.
  // Called by the scheduler when a simulation completes (base or constraint).
  const syncDecollisionState = useCallback((finalData) => {
    liveTransitionDataRef.current = null;
    if (finalData) {
      updateStablePositions(finalData, constraintKeyRef.current);
      setProcessedData(finalData);
      processedDataRef.current = finalData;
    }
  }, []);

  // ── Decollision scheduler ─────────────────────────────────────────────────
  // Replaces the old decollision useEffect. The scheduler owns the simulation
  // lifecycle imperatively — no effect deps for positionsAreIntermediate or
  // constraintKey. Base decollision runs automatically when layout settles.
  // Constraint decollision is requested by the app via decollideForConstraint().
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
    // Don't forward the constraintKey arg — the app's handleDecollisionComplete
    // interprets the second arg as needsAnotherCycle (boolean).
    onConstraintReady: (finalData) => onDecollisionComplete?.(finalData),
    syncDecollisionState,
    onSimulationRunningChange: setIsSimulationRunning,
    sendMetrics,
    isDraggingRef,
    interactionActiveRef,
    enabled: enableDecollisioning,
  });
  schedulerRef.current = scheduler;

  // Handle mouse leave to reset interaction states
  const handleMouseLeave = () => {
    debugLog('🔍 Mouse leave - resetting interaction states');
    setIsDragging(false);
    clearHover(); // Clear hover state when mouse leaves container
    // Also call the original onLeave callback to notify parent
    if (onLeave) {
      onLeave(null, null);
    }
  };

  // Handle background hover to clear stuck hover states
  const handleBackgroundHover = () => {
    if (hoveredDotId !== null) {
      debugLog('🔍 Background hover - clearing stuck hover state');
      clearHover();
      if (onLeave) {
        onLeave(null, null);
      }
    }
  };

  // Keep extents in sync when zoomExtent prop changes (handled by ZoomManager)
  useEffect(() => {
    if (zoomManager.current) {
      zoomManager.current.updateConfig({ zoomExtent });
    }
  }, [zoomExtent]);

  // Cleanup auto-zoom timeout on unmount
  useEffect(() => {
    return () => {
      if (autoZoomTimeoutRef.current) {
        clearTimeout(autoZoomTimeoutRef.current);
      }
      if (interactionIdleTimerRef.current) {
        clearTimeout(interactionIdleTimerRef.current);
      }
    };
  }, []);


  // Cancel any ongoing decollision animation
  const cancelDecollision = useCallback(() => {
    schedulerRef.current?.cancelSimulation();
    liveTransitionDataRef.current = null;
  }, []);

  // Get current positions (including any in-progress decollision positions)
  const getCurrentPositions = useCallback(() => {
    // Return the current data ref which has the most up-to-date positions
    // This includes any intermediate decollision positions
    return dataRef.current.map(item => ({
      id: item.id,
      x: item.x,
      y: item.y
    }));
  }, []);

  useImperativeHandle(ref, () => ({
    zoomToVisible,
    getFitTransform,
    setZoomTransform,
    getVisibleDotCount: () => visibleDotCount,
    updateVisibleDotCount,
    getZoomTransform: () => zoomManager.current?.getCurrentTransform(),
    cancelDecollision,
    getCurrentPositions,
    decollideForConstraint: (key) => schedulerRef.current?.decollideForConstraint(key),
    getSchedulerPhase: () => schedulerRef.current?.phase,
  }), [zoomToVisible, getFitTransform, setZoomTransform, visibleDotCount, updateVisibleDotCount, cancelDecollision, getCurrentPositions]);

  // Auto-fit to visible region
  useEffect(() => {
    // Only run once; do not auto-fit again after first successful fit
    if (didInitialAutoFitRef.current) return;
    if (!autoFitToVisible) return;
    if (!viewBox || !zoomRef.current || !zoomManager.current) return;
    if (!processedData.length) return; // wait until data and zoom binding are ready
    if (!isZoomSetupComplete) return; // wait until zoom behavior is fully set up

    // Defer to next microtask to ensure DOM/layout is up to date
    Promise.resolve().then(() => {
      const ok = zoomToVisible();
      debugLog('zoomed to visible, ok: ', ok);
      if (ok) {
        didInitialAutoFitRef.current = true;
      }
    });
  }, [
    autoFitToVisible,
    viewBox,                // run when initial viewBox appears or changes
    occludeLeft, occludeRight, occludeTop, occludeBottom,
    fitMargin,              // if margin changes, recompute
    zoomToVisible,
    processedData,
    isZoomSetupComplete     // wait for zoom behavior to be fully configured
  ]);


  const effectiveViewBox = (viewBox && viewBox.length === 4) ? viewBox : [0, 0, 1, 1];
  if (!processedData.length || typeof window === 'undefined') {
    return (
      <svg
        ref={zoomRef}
        className={`dot-visualization ${className}`}
        viewBox={effectiveViewBox.join(' ')}
        style={{ width: '100%', height: '100%', ...style }}
        onMouseLeave={handleMouseLeave}
        {...otherProps}
      />
    );
  }

  return (
    <svg
      ref={zoomRef}
      className={`dot-visualization ${className}`}
      viewBox={effectiveViewBox.join(' ')}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        ...style
      }}
      onMouseLeave={handleMouseLeave}
      {...otherProps}
    >
      {/* Background click area - outside transformed group so it always covers full SVG */}
      <rect
        x={effectiveViewBox[0]}
        y={effectiveViewBox[1]}
        width={effectiveViewBox[2]}
        height={effectiveViewBox[3]}
        fill="transparent"
        onClick={onBackgroundClick}
        onMouseMove={handleBackgroundHover}
        style={{
          pointerEvents: 'fill',
          // Debug outline to visualize click area (remove after testing)
          stroke: debug ? 'red' : 'none',
          strokeWidth: debug ? 2 : 0,
          strokeDasharray: debug ? '5,5' : 'none'
        }}
      />
      {/* Canvas layer as a sibling, not inside the transformed group */}
      {useCanvas && (
        <g id="canvas-layer">
          <ColoredDots
            ref={coloredDotsRef}
            data={processedData}
            dotId={dotId}
            stroke={dotStroke}
            strokeWidth={dotStrokeWidth}
            strokeWidthFraction={dotStrokeWidthFraction}
            defaultColor={defaultColor}
            defaultSize={defaultSize}
            defaultOpacity={defaultOpacity}
            dotStyles={dotStyles}
            radiusOverrides={radiusOverrides}
            hoveredDotId={hoveredDotId}
            hoverSizeMultiplier={hoverSizeMultiplier}
            hoverOpacity={hoverOpacity}
            useImages={useImages}
            imageProvider={imageProvider}
            hoverImageProvider={hoverImageProvider}
            customDotRenderer={customDotRenderer}
            visibleDotCount={visibleDotCount}
            useCanvas={useCanvas}
            gpuPanZoom={gpuPanZoom}
            renderMargin={renderMargin}
            blockHoverDuringInteraction={blockHoverDuringInteraction}
            pausePulseDuringInteraction={pausePulseDuringInteraction}
            interactionActive={interactionActive}
            getZoomTransform={getZoomTransform}
            debug={debug}
            effectiveViewBox={effectiveViewBox}
            containerDimensions={containerDimensions}
            onHover={handleDotHover}
            onLeave={handleDotLeave}
            onClick={onClick}
            onContextMenu={onContextMenu}
            onBackgroundClick={onBackgroundClick}
            onDragStart={onDragStart}
            isZooming={isZooming}
            isInteractionActive={() => interactionActiveRef.current}
            isDecollisioning={isSimulationRunning}
          />
        </g>
      )}

      {/* Transformed content layer - contains background, vector content, and foreground */}
      <g ref={contentRef} id="content-layer">
        {/* Background layer - renders before dots */}
        {(backgroundChildren || children) && (
          <g id="background-layer" pointerEvents="none">
            {backgroundChildren || children}
          </g>
        )}

        {/* Vector layer for edges and SVG dots */}
        <g id="vector-layer">
        {(edges && edges.length > 0) && (
          <EdgeLayer
            edges={edges}
            data={processedData}
            edgeOpacity={edgeOpacity}
            edgeColor={edgeColor}
            strokeWidth={dotStrokeWidth}
            debug={debug}
          />
        )}
        {/* SVG mode dots stay in the vector layer */}
        {!useCanvas && (
          <ColoredDots
            data={processedData}
            dotId={dotId}
            stroke={dotStroke}
            strokeWidth={dotStrokeWidth}
            defaultColor={defaultColor}
            defaultSize={defaultSize}
            defaultOpacity={defaultOpacity}
            dotStyles={dotStyles}
            radiusOverrides={radiusOverrides}
            hoveredDotId={hoveredDotId}
            hoverSizeMultiplier={hoverSizeMultiplier}
            hoverOpacity={hoverOpacity}
            useImages={useImages}
            imageProvider={imageProvider}
            hoverImageProvider={hoverImageProvider}
            customDotRenderer={customDotRenderer}
            visibleDotCount={visibleDotCount}
            useCanvas={useCanvas}
            debug={debug}
            isDecollisioning={isSimulationRunning}
          />
        )}
        <ClusterLabels
          data={processedData}
          clusters={clusters}
          clusterKey={clusterKey}
          renderCluster={renderCluster}
          hoveredCluster={hoveredCluster}
          onClusterHover={onClusterHover}
          onClusterLeave={onClusterLeave}
          debug={debug}
        />
        {!useCanvas && (
          <InteractionLayer
            data={processedData}
            dotId={dotId}
            onHover={handleDotHover}
            onLeave={handleDotLeave}
            onClick={onClick}
            onBackgroundClick={onBackgroundClick}
            onDragStart={onDragStart}
            isZooming={isZooming}
            defaultSize={defaultSize}
            dotStyles={dotStyles}
            hoveredDotId={hoveredDotId}
            hoverSizeMultiplier={hoverSizeMultiplier}
            debug={debug}
          />
        )}

          {/* Invisible cushion so the group has a sensible bbox */}
          <rect
            x={effectiveViewBox[0] - effectiveViewBox[2]}
            y={effectiveViewBox[1] - effectiveViewBox[3]}
            width={effectiveViewBox[2] * 3}
            height={effectiveViewBox[3] * 3}
            fill="none"
            pointerEvents="none"
          />
        </g>

        {/* Foreground layer - renders on top of dots (e.g., overlays, dimming effects) */}
        {foregroundChildren && (
          <g id="foreground-layer">
            {foregroundChildren}
          </g>
        )}
      </g>
    </svg>
  );
});

export default DotVisualization;
