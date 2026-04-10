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
  hasCache,
}) {
  const positionsChanged = previousData.length === 0 ||
    hasPositionsChangedFn(validData, previousData);

  let processedData = validData;

  // When positions haven't changed and layout is settled, restore
  // decollisioned positions from cache to prevent snapping to raw UMAP.
  // The hasCache guard preserves the original behavior: without a cache
  // system, raw positions are used (no fallback to previousProcessedData).
  if (!positionsChanged && !positionsAreIntermediate && hasCache) {
    processedData = restoreDecollisionedPositions(
      validData,
      cachedPositions,
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
    onBackgroundClick,
    onDragStart,
    dragIcon,
    onZoomStart,
    onZoomEnd,
    onDecollisionComplete,
    sharedPositionCache = null,
    enableDecollisioning = true, // unused by canvas renderer (scheduler handles it), kept for R3F compat
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

  const markInteractionActive = useCallback(() => {
    interactionActiveRef.current = true;
    if (interactionIdleTimerRef.current) {
      clearTimeout(interactionIdleTimerRef.current);
    }
    interactionIdleTimerRef.current = setTimeout(() => {
      interactionActiveRef.current = false;
      interactionIdleTimerRef.current = null;
    }, 120);
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
    if (sharedPositionCache) {
      sharedPositionCache.checkScope(scopeKey);
    }

    // ── Position resolution: detect changes, restore cache if unchanged ────
    const { processedData: processedValidData } = resolveDataEffectPositions({
      validData,
      previousData: previousDataRef.current,
      positionsAreIntermediate,
      cachedPositions: sharedPositionCache?.cache.get(constraintKeyRef.current) ?? null,
      previousProcessedData: processedDataRef.current,
      hasPositionsChangedFn: hasPositionsChanged,
      hasCache: !!sharedPositionCache,
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
    // Store processed data for the scheduler to read
    dataRef.current = processedValidData;

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
      if (coloredDotsRef.current) {
        // Use live transition data if available (during decollision), otherwise fall back to normal render
        if (liveTransitionDataRef.current) {
          coloredDotsRef.current.renderCanvasWithData(liveTransitionDataRef.current, transform);
        } else {
          coloredDotsRef.current.renderCanvasWithTransform(transform);
        }
      }
    };

    // Initialize ZoomManager
    if (!zoomManager.current) {
      zoomManager.current = new ZoomManager({
        zoomRef,
        contentRef,
        canvasRenderer,
        zoomExtent,
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
  }, [zoomExtent, viewBox, useCanvas, defaultSize, fitMargin, occludeLeft, occludeRight, occludeTop, occludeBottom]);

  // Handle container resize - update container dimensions when window resizes
  useEffect(() => {
    if (!zoomRef.current || typeof window === 'undefined') {
      return;
    }

    const updateContainerDimensions = () => {
      const rect = zoomRef.current?.getBoundingClientRect?.();
      if (rect && rect.width > 0 && rect.height > 0) {
        const newDimensions = { width: rect.width, height: rect.height };

        // Only update if dimensions actually changed
        const dimensionsChanged = !containerDimensions ||
          containerDimensions.width !== newDimensions.width ||
          containerDimensions.height !== newDimensions.height;

        if (dimensionsChanged) {
          setContainerDimensions(newDimensions);
        }
      }
    };

    // Initial measurement
    updateContainerDimensions();

    // Listen for window resize
    window.addEventListener('resize', updateContainerDimensions);

    return () => {
      window.removeEventListener('resize', updateContainerDimensions);
    };
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
            getZoomTransform={() => zoomManager.current?.getCurrentTransform() || d3.zoomIdentity}
            debug={debug}
            effectiveViewBox={effectiveViewBox}
            containerDimensions={containerDimensions}
            onHover={handleDotHover}
            onLeave={handleDotLeave}
            onClick={onClick}
            onBackgroundClick={onBackgroundClick}
            onDragStart={onDragStart}
            isZooming={isZooming}
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
