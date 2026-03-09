import React, { useEffect, useState, useRef, useCallback, useImperativeHandle, useMemo, forwardRef } from 'react';
import * as d3 from 'd3';
import ColoredDots from './ColoredDots.jsx';
import InteractionLayer from './InteractionLayer.jsx';
import ClusterLabels from './ClusterLabels.jsx';
import EdgeLayer from './EdgeLayer.jsx';
import { countVisibleDots } from './utils.js';
import { ZoomManager } from './ZoomManager.js';
import { useDebug } from './useDebug.js';
import { useLatest } from './useLatest.js';
import { useStableCallback } from './useStableCallback.js';
import { useDotHoverHandlers } from './useDotHoverHandlers.js';
import { useStablePositions } from './useStablePositions.js';
import { usePositionChangeDetection } from './usePositionChangeDetection.js';
import { decollisioning } from './decollisioning.js';
import { getDotSize } from './dotUtils.js'
import {
  cancelDecollisionWithInvariants,
  chooseDecollisionLaunchMode,
  shouldQueueDecollisionRetry
} from './decollisionStateMachine.js';

const EMPTY_RADIUS_OVERRIDES = new Map();

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
    enableDecollisioning = true,
    decollisionEngine = 'auto',
    isIncrementalUpdate = false,
    transitionDuration = 350,
    transitionEasing = d3.easeCubicOut,
    positionsAreIntermediate = false,
    viewBoxSmoothingR = 0.5,
    viewBoxSmoothingQ = 3,
    viewBoxTransitionDuration = 1500,
    cacheKey = 'default',
    zoomExtent = [0.5, 20],
    margin = 0.1,
    dotStroke = "#111",
    dotStrokeWidth = 0.2,
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
    initialTransform = null,
    children,
    backgroundChildren,
    foregroundChildren,
    ...otherProps
  } = props;

  const [processedData, setProcessedData] = useState([]);
  const [containerDimensions, setContainerDimensions] = useState(null);

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
  const { stablePositions, updateStablePositions, clearStablePositions, shouldUseStablePositions } = useStablePositions();
  const hasPositionsChanged = usePositionChangeDetection(defaultSize);

  // Block hover only when dragging (not during wheel zoom)
  const isZooming = isDragging;

  // Manage hover state and callbacks
  const { hoveredDotId, handleDotHover, handleDotLeave, clearHover } = useDotHoverHandlers(onHover, onLeave);

  // Track when data changes during decollision (the "point of no return" logic)
  const decollisionSnapshotRef = useRef(null);
  const pendingDecollisionRef = useRef(false);
  const decollisionSimRef = useRef(null);

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
  const memoizedPositions = useRef(new Map()); // Store final positions after collision detection
  const previousDataRef = useRef([]);
  const didInitialAutoFitRef = useRef(false);
  const autoZoomTimeoutRef = useRef(null);
  const prevCacheKeyRef = useRef(cacheKey);
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

  // Keep latest dotStyles without triggering decollision simulation restarts
  const dotStylesRef = useLatest(dotStyles);

  // Clear memoized positions when cache key changes (application state change)
  //
  // Use case: If your application has state that affects dot sizes (e.g., selecting
  // a subset of dots to highlight by making them larger), you can pass a cacheKey
  // that encodes that state. When the state changes, this effect clears the
  // memoizedPositions cache, allowing decollision to run fresh with the new sizes.
  //
  // Example: cacheKey="playlist:123:open" when playlist is selected, "default" otherwise
  useEffect(() => {
    if (prevCacheKeyRef.current !== cacheKey) {
      memoizedPositions.current.clear();
      prevCacheKeyRef.current = cacheKey;
    }
  }, [cacheKey]);


  const zoomToVisible = useCallback(async (duration = 0, easing = d3.easeCubicInOut, dataOverride = null, marginOverride = null, updateExtents = true) => {
    if (!zoomManager.current) return false;
    const dataToUse = dataOverride || processedData;
    const options = { duration, easing, updateExtents };
    if (marginOverride !== null) {
      options.margin = marginOverride;
    }
    return await zoomManager.current.zoomToVisible(dataToUse, options);
  }, [processedData]);

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

  // Process data and set up initial state
  useEffect(() => {
    if (!data || data.length === 0) {
      setProcessedData([]);
      return;
    }

    // console.log('DotVisualization incoming data:', data[0]?.x, data[0]?.y, "previousDataRef.current:", previousDataRef.current[0]?.x, previousDataRef.current[0]?.y);

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

    // Check if positions have changed compared to original input data
    const positionsChanged = previousDataRef.current.length === 0 ||
      hasPositionsChanged(validData, previousDataRef.current);

    let processedValidData = validData;

    // If fresh input arrives while a decollision run is active, queue another pass.
    if (shouldQueueDecollisionRetry({
      enableDecollisioning,
      hasActiveSnapshot: Boolean(decollisionSnapshotRef.current),
      positionsChanged
    })) {
      pendingDecollisionRef.current = true;
    }

    // Seed from shared cross-renderer cache on first mount so we immediately show
    // decollisioned positions without a catch-up simulation.
    let seededFromSharedCache = false;
    if (sharedPositionCache?.current?.size > 0 && memoizedPositions.current.size === 0 && !positionsAreIntermediate) {
      for (const item of validData) {
        const cached = sharedPositionCache.current.get(item.id);
        if (cached) memoizedPositions.current.set(item.id, { x: cached.x, y: cached.y });
      }
      seededFromSharedCache = memoizedPositions.current.size > 0;
    }

    // Restore memoized positions when positions haven't changed (or when seeded from shared cache)
    if ((!positionsChanged || seededFromSharedCache) && memoizedPositions.current.size > 0 && !positionsAreIntermediate) {
      // If positions haven't changed and positions are stable, restore memoized decollisioned positions
      // console.log('📍 Restoring memoized positions for', validData.length, 'dots');
      processedValidData = validData.map(item => {
        const memoizedPos = memoizedPositions.current.get(item.id);
        if (memoizedPos) {
          return { ...item, x: memoizedPos.x, y: memoizedPos.y };
        }
        return item;
      });
    } else {
      if (positionsAreIntermediate) {
        // console.log('📍 Positions are intermediate - using raw positions from simulation');
      }
    }

    // Auto-zoom to new content if enabled (using ZoomManager)
    // Skip auto-zoom during incremental updates - viewBox smoothing handles it
    if (autoZoomToNewContent && zoomManager.current && !isIncrementalUpdate) {
      zoomManager.current.checkAutoZoom(validData, {
        autoZoomToNewContent,
        autoZoomDuration
      });
    } else if (!autoZoomToNewContent && zoomManager.current) {
      // When auto-zoom is disabled, still do initial zoom for first data
      // Check if this is the first data (no previous data)
      if (!previousDataRef.current?.length && validData.length > 0) {
        zoomManager.current.initZoom(validData);
      } else {
        // Update zoom extents for subsequent data changes
        zoomManager.current.updateZoomExtentsForData(validData);
      }
    }

    // Store original input data for future comparisons
    previousDataRef.current = validData.map(item => ({ ...item })); // Deep copy of validData!! This is important!
    // Store processed data (either original or with restored positions)
    dataRef.current = processedValidData;

    // Conditional rendering based on update type:
    // - Incremental updates: Keep rendering stable positions while decollision runs
    // - Full renders: Render new data directly, show animation
    if (shouldUseStablePositions(isIncrementalUpdate)) {
      // Incremental: Don't update processedData yet, keep rendering stable old positions
      // The decollision effect will update both stablePositions and processedData when complete
    } else {
      // Full render: Update immediately to show animation
      setProcessedData(processedValidData);
      if (!isIncrementalUpdate) {
        clearStablePositions();
      }
    }

    // Update visible dot count when data changes
    updateVisibleDotCount();

  }, [data, margin, ensureIds, hasPositionsChanged, positionsAreIntermediate, autoZoomToNewContent, autoZoomDuration, isIncrementalUpdate]);

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

  // Shared primitive for syncing decollision state back to React
  // This ensures both completion and cancellation paths keep state synchronized
  const syncDecollisionState = useCallback((finalData) => {
    // Clear refs
    decollisionSnapshotRef.current = null;
    pendingDecollisionRef.current = false;
    decollisionSimRef.current = null;
    liveTransitionDataRef.current = null;

    // Only sync positions if we have data (meaning rendering actually happened)
    if (finalData) {
      memoizedPositions.current.clear();
      for (const node of finalData) {
        memoizedPositions.current.set(node.id, { x: node.x, y: node.y });
      }
      updateStablePositions(finalData, isIncrementalUpdate);
      setProcessedData(finalData);
    }
  }, [isIncrementalUpdate]);

  // Create stable callback references for the D3 simulation.
  // The D3 force simulation is a long-running animation that should not restart when
  // callbacks change. These stable wrappers ensure the simulation keeps running while
  // always calling the latest version of each callback. Without this, callback changes
  // from re-renders would restart the simulation, causing dots to jump back to start.
  const stableOnUpdateNodes = useStableCallback(onUpdateNodes);
  const stableOnDecollisionComplete = useStableCallback(onDecollisionComplete);

  // Decollision state machine with "point of no return" logic
  //
  // This effect manages the D3 force simulation lifecycle:
  // 1. Takes a snapshot of current data when simulation starts
  // 2. Runs simulation to completion using the snapshot (ignoring new data during flight)
  // 3. On completion, checks if new data arrived (via pendingDecollisionRef)
  // 4. Parent can re-enable decollision if needsAnotherCycle is true
  //
  // Why snapshot? The D3 simulation mutates node positions over time. If we used live
  // data, React re-renders could cause the simulation to restart mid-flight with different
  // data, creating visual glitches. The snapshot ensures atomic "launch -> animate -> land".
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const launchMode = chooseDecollisionLaunchMode({
      enableDecollisioning,
      positionsAreIntermediate,
      hasMemoizedPositions: memoizedPositions.current.size > 0
    });

    if (launchMode === 'skip-intermediate' || launchMode === 'skip-cached') {
      decollisionSnapshotRef.current = null;
      pendingDecollisionRef.current = false;
      return;
    }

    // For incremental updates, use dataRef.current (new positions) even though processedData shows stable positions
    // For full renders, use processedData (which is the same as dataRef.current)
    const sourceData = isIncrementalUpdate ? dataRef.current : processedData;

    if (!sourceData.length) {
      decollisionSnapshotRef.current = null;
      pendingDecollisionRef.current = false;
      return;
    }

    // Snapshot data at launch time
    const dataSnapshot = [...sourceData];
    decollisionSnapshotRef.current = dataSnapshot;
    pendingDecollisionRef.current = false;

    const fnDotSize = (item) => {
      return getDotSize(item, dotStylesRef.current, defaultSize);
    }

    // Build transition config for incremental updates
    const transitionConfig = isIncrementalUpdate ? {
      enabled: true,
      stablePositions: stablePositions.length > 0 ? stablePositions : processedData,
      duration: transitionDuration,
      easing: transitionEasing || d3.easeCubicOut,
    } : null;

    // Catch-up mode: renderer mounted fresh (no memoized positions) but decollision
    // phase already passed. Run silently — no intermediate frames — to avoid competing
    // state updates between the tick callbacks and the data effect.
    const isCatchUp = launchMode === 'run-catchup';
    const skipFrames = isCatchUp || isIncrementalUpdate;

    let cancelled = false;
    const simulation = decollisioning(dataSnapshot, (nodes) => {
      if (cancelled) return;
      stableOnUpdateNodes(nodes);
    }, fnDotSize, (finalData) => {
      if (cancelled) return;
      debugLog('Decollision complete - syncing React state');

      // Check if new data arrived while simulation was running
      const needsAnotherCycle = pendingDecollisionRef.current;

      // Sync state using shared primitive
      syncDecollisionState(finalData);

      // Write back to shared cache so the other renderer can seed from it on mount
      if (sharedPositionCache?.current) {
        sharedPositionCache.current.clear();
        for (const node of finalData) {
          sharedPositionCache.current.set(node.id, { x: node.x, y: node.y });
        }
      }

      // Notify parent, including whether more work is pending
      stableOnDecollisionComplete(finalData, needsAnotherCycle);
    }, skipFrames, transitionConfig, {
      engine: decollisionEngine,
      shouldPublishIntermediate: () => !(isDraggingRef.current || interactionActiveRef.current)
    });

    // Store simulation reference for potential cancellation
    decollisionSimRef.current = simulation;

    return () => {
      cancelled = true;
      simulation.stop();
      if (decollisionSimRef.current === simulation) {
        decollisionSimRef.current = null;
      }
      if (decollisionSnapshotRef.current === dataSnapshot) {
        decollisionSnapshotRef.current = null;
        pendingDecollisionRef.current = false;
      }
      liveTransitionDataRef.current = null;
    };
  }, [enableDecollisioning, decollisionEngine, processedData.length, isIncrementalUpdate, defaultSize, useCanvas, positionsAreIntermediate]);


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


  // Cancel any ongoing decollision animation, preserving current positions
  const cancelDecollision = useCallback(() => {
    cancelDecollisionWithInvariants({
      simulation: decollisionSimRef.current,
      debugLog,
      livePositions: liveTransitionDataRef.current,
      snapshotPositions: decollisionSnapshotRef.current,
      syncDecollisionState,
      clearDecollisionState: () => {
        decollisionSimRef.current = null;
        decollisionSnapshotRef.current = null;
        pendingDecollisionRef.current = false;
        liveTransitionDataRef.current = null;
        pendingInteractionFlushRef.current = false;
      }
    });
  }, [debugLog, syncDecollisionState]);

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
    getVisibleDotCount: () => visibleDotCount,
    updateVisibleDotCount,
    getZoomTransform: () => zoomManager.current?.getCurrentTransform(),
    cancelDecollision,
    getCurrentPositions,
  }), [zoomToVisible, visibleDotCount, updateVisibleDotCount, cancelDecollision, getCurrentPositions]);

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
            isDecollisioning={enableDecollisioning}
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
            isDecollisioning={enableDecollisioning}
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
