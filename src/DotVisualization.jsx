import React, { useEffect, useState, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import * as d3 from 'd3';
import ColoredDots from './ColoredDots.jsx';
import InteractionLayer from './InteractionLayer.jsx';
import ClusterLabels from './ClusterLabels.jsx';
import EdgeLayer from './EdgeLayer.jsx';
import { boundsForData, computeOcclusionAwareViewBox, countVisibleDots } from './utils.js';
import { ZoomManager } from './ZoomManager.js';
import { useDebug } from './useDebug.js';
import { useLatest } from './useLatest.js';
import { useStableCallback } from './useStableCallback.js';
import { useDotHoverHandlers } from './useDotHoverHandlers.js';
import { decollisioning } from './decollisioning.js';
import { getDotSize } from './dotUtils.js'

// Helper function to check if two numbers are equal after rounding to 2 decimal places
const isWithinTolerance = (a, b) => {
  return Math.round(a * 100) === Math.round(b * 100);
};

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
    enableDecollisioning = true,
    positionsAreIntermediate = false,
    cacheKey = 'default',
    zoomExtent = [0.5, 20],
    margin = 0.1,
    dotStroke = "#111",
    dotStrokeWidth = 0.2,
    defaultColor = null,
    defaultSize = 2,
    defaultOpacity = 0.7,
    dotStyles = new Map(),
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
    ...otherProps
  } = props;

  const [processedData, setProcessedData] = useState([]);
  const [viewBox, setViewBox] = useState(null);
  const [containerDimensions, setContainerDimensions] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isZoomSetupComplete, setIsZoomSetupComplete] = useState(false);
  const [visibleDotCount, setVisibleDotCount] = useState(0);

  // Block hover only when dragging (not during wheel zoom)
  const isZooming = isDragging;

  // Manage hover state and callbacks
  const { hoveredDotId, handleDotHover, handleDotLeave, clearHover } = useDotHoverHandlers(onHover, onLeave);

  const zoomRef = useRef(null);
  const contentRef = useRef(null);
  const coloredDotsRef = useRef(null);
  const zoomManager = useRef(null);

  // Track when data changes during decollision (the "point of no return" logic)
  const decollisionSnapshotRef = useRef(null);
  const pendingDecollisionRef = useRef(false);

  // Keep latest values accessible in closures without triggering re-runs
  const isDraggingRef = useLatest(isDragging);
  const viewBoxRef = useLatest(viewBox);
  const onZoomStartRef = useLatest(onZoomStart);
  const onZoomEndRef = useLatest(onZoomEnd);

  const debugLog = useDebug(debug);

  // Function to update visible dot count
  const updateVisibleDotCount = useCallback(() => {
    if (!processedData.length || !viewBox || !zoomManager.current) return;

    const currentTransform = zoomManager.current.getCurrentTransform();
    if (!currentTransform) return;

    const count = countVisibleDots(processedData, currentTransform, viewBox, defaultSize);
    setVisibleDotCount(count);
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
      console.log('Cache key changed:', prevCacheKeyRef.current, '->', cacheKey);
      console.log('Cleared memoized positions (cache invalidated)');
      memoizedPositions.current.clear();
      prevCacheKeyRef.current = cacheKey;
    }
  }, [cacheKey]);

  // Check if only non-positional properties have changed
  const hasPositionsChanged = useCallback((newData, oldData) => {
    if (newData.length !== oldData.length) return true;

    for (let i = 0; i < newData.length; i++) {
      const newItem = newData[i];
      const oldItem = oldData[i];

      if (newItem.id !== oldItem.id ||
        !isWithinTolerance(newItem.x, oldItem.x) ||
        !isWithinTolerance(newItem.y, oldItem.y) ||
        (newItem.size || defaultSize) !== (oldItem.size || defaultSize)) {
        // console.log('different newItem:', newItem, 'oldItem:', oldItem, 'isWithinTolerance(newItem.x, oldItem.x):', isWithinTolerance(newItem.x, oldItem.x), 'isWithinTolerance(newItem.y, oldItem.y):', isWithinTolerance(newItem.y, oldItem.y));
        // console.log('newItem.x:', newItem.x, 'oldItem.x:', oldItem.x, 'newItem.y:', newItem.y, 'oldItem.y:', oldItem.y);
        return true;
      }
    }
    return false;
  }, [defaultSize]);


  const zoomToVisible = useCallback(async (duration = 0, easing = d3.easeCubicInOut, dataOverride = null, marginOverride = null) => {
    if (!zoomManager.current) return false;
    const dataToUse = dataOverride || processedData;
    const options = { duration, easing };
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

    // Restore memoized positions when positions haven't changed and we're not in intermediate state
    if (!positionsChanged && memoizedPositions.current.size > 0 && !positionsAreIntermediate) {
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

    // Initialize viewBox using container dimensions
    if (!viewBox && containerDimensions) {
      const bounds = boundsForData(validData, defaultSize);
      const vb = computeOcclusionAwareViewBox(bounds, containerDimensions, {
        left: occludeLeft, right: occludeRight, top: occludeTop, bottom: occludeBottom
      }, margin);
      debugLog('Initialized viewBox:', vb);
      if (vb) setViewBox(vb);
    }

    // Calculate current data bounds
    const currentBounds = validData.length > 0 ? boundsForData(validData, defaultSize) : null;

    // Auto-zoom to new content if enabled (using ZoomManager)
    if (autoZoomToNewContent && zoomManager.current) {
      zoomManager.current.checkAutoZoom(validData, {
        autoZoomToNewContent,
        autoZoomDuration
      });
    } else if (!autoZoomToNewContent && zoomManager.current) {
      // When auto-zoom is disabled, still update zoom extents
      zoomManager.current.updateZoomExtentsForData(validData);
    }

    // Store original input data for future comparisons
    previousDataRef.current = validData.map(item => ({ ...item })); // Deep copy of validData!! This is important!
    // Store processed data (either original or with restored positions)
    dataRef.current = processedValidData;
    setProcessedData(processedValidData);

    // Update data bounds in ZoomManager for auto-zoom detection
    if (zoomManager.current && currentBounds) {
      zoomManager.current.updateDataBounds(validData);
    }

    // Update visible dot count when data changes
    updateVisibleDotCount();

  }, [data, margin, ensureIds, hasPositionsChanged, positionsAreIntermediate, autoZoomToNewContent, autoZoomDuration]);

  // Initialize and set up zoom behavior with ZoomManager
  useEffect(() => {
    if (!processedData.length || !zoomRef.current || typeof window === 'undefined') {
      return;
    }

    // Create canvas renderer function
    const canvasRenderer = (transform) => {
      if (useCanvas && coloredDotsRef.current) {
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
        defaultSize,
        fitMargin,
        occludeLeft,
        occludeRight,
        occludeTop,
        occludeBottom,
        useCanvas,
        onZoomStart: (event) => {
          setIsDragging(true);
          if (onZoomStartRef.current) onZoomStartRef.current(event);
        },
        onZoomEnd: (event) => {
          setIsDragging(false);
          updateCountOnTransformChangeRef.current();
          if (onZoomEndRef.current) onZoomEndRef.current(event);
        },
        onTransformChange: () => updateCountOnTransformChangeRef.current()
      });
    } else {
      // Update config when props change
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
    }

    // Set viewBox if available
    if (viewBox) {
      zoomManager.current.setViewBox(viewBox);
    }

    // Initialize zoom behavior
    zoomManager.current.initialize();

    // Add global event listeners
    const handleGlobalMouseUp = () => {
      if (isDraggingRef.current) {
        setIsDragging(false);
      }
    };

    const handleWindowBlur = () => {
      debugLog('🔍 Window blur - resetting all states');
      clearHover();
      setIsDragging(false);
      if (onLeave) {
        onLeave(null, null);
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
      }
      setIsZoomSetupComplete(false);
    };
  }, [processedData, zoomExtent, viewBox, useCanvas, defaultSize, fitMargin, occludeLeft, occludeRight, occludeTop, occludeBottom]);

  // Handle container resize - update container dimensions and viewBox when window resizes
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

          // If we have data, recalculate viewBox for the new container size
          if (processedData.length > 0) {
            const bounds = boundsForData(processedData, defaultSize);
            const vb = computeOcclusionAwareViewBox(bounds, newDimensions, {
              left: occludeLeft, right: occludeRight, top: occludeTop, bottom: occludeBottom
            }, margin);

            // Only update viewBox if it actually changed
            // Use ref to get current viewBox to avoid dependency issues
            const currentViewBox = viewBoxRef.current;
            if (vb && (!currentViewBox ||
              vb[0] !== currentViewBox[0] || vb[1] !== currentViewBox[1] ||
              vb[2] !== currentViewBox[2] || vb[3] !== currentViewBox[3])) {
              debugLog('Updated viewBox for new container size:', vb);
              setViewBox(vb);
            }
          }
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
  }, [processedData, defaultSize, occludeLeft, occludeRight, occludeTop, occludeBottom, margin]);

  // Re-render canvas when viewBox changes to fix distortion during resize
  useEffect(() => {
    if (useCanvas && coloredDotsRef.current && zoomManager.current && viewBox) {
      const currentTransform = zoomManager.current.getCurrentTransform();
      if (currentTransform) {
        coloredDotsRef.current.renderCanvasWithTransform(currentTransform);
      }
    }
  }, [viewBox, useCanvas]);

  // Callback for decollisioning updates - wrapped to prevent infinite loops
  const onUpdateNodes = useCallback((nodes) => {
    if (useCanvas && coloredDotsRef.current) {
      // Update canvas directly with custom data without triggering React re-render
      const currentTransform = zoomManager.current?.getCurrentTransform();
      coloredDotsRef.current.renderCanvasWithData(nodes, currentTransform);
      nodes.forEach(node => {
        memoizedPositions.current.set(node.id, { x: node.x, y: node.y });
      });
    } else {
      // For SVG mode, update DOM directly
      const dots0 = d3.selectAll('#colored-dots circle').data(nodes);
      const dots1 = d3.selectAll('#interaction-layer circle').data(nodes);
      dots0.attr('cx', d => d.x).attr('cy', d => d.y);
      dots1.attr('cx', d => d.x).attr('cy', d => d.y);
    }
  }, [useCanvas]);

  // Create stable callback references for the D3 simulation.
  // The D3 force simulation is a long-running animation that should not restart when
  // callbacks change. These stable wrappers ensure the simulation keeps running while
  // always calling the latest version of each callback. Without this, callback changes
  // from re-renders would restart the simulation, causing dots to jump back to start.
  const stableOnUpdateNodes = useStableCallback(onUpdateNodes);
  const stableOnDecollisionComplete = useStableCallback(onDecollisionComplete);

  // Detect when data changes during active decollision
  // This effect watches for new data arriving while a simulation is in flight
  useEffect(() => {
    if (enableDecollisioning && decollisionSnapshotRef.current &&
        processedData.length > decollisionSnapshotRef.current.length) {
      debugLog('New data detected during decollision - marking for retry');
      pendingDecollisionRef.current = true;
    }
  }, [processedData, enableDecollisioning, debugLog]);

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
    if (!enableDecollisioning || !processedData.length || typeof window === 'undefined') {
      decollisionSnapshotRef.current = null;
      pendingDecollisionRef.current = false;
      return;
    }

    // Snapshot data at launch time
    const dataSnapshot = [...processedData];
    decollisionSnapshotRef.current = dataSnapshot;
    pendingDecollisionRef.current = false;

    const fnDotSize = (item) => {
      return getDotSize(item, dotStylesRef.current, defaultSize);
    }

    const simulation = decollisioning(dataSnapshot, stableOnUpdateNodes, fnDotSize, (finalData) => {
      debugLog('Decollision complete - syncing React state');

      // Check if new data arrived while simulation was running
      const needsAnotherCycle = pendingDecollisionRef.current;

      // Clear snapshot and pending flags
      decollisionSnapshotRef.current = null;
      pendingDecollisionRef.current = false;

      // Update React state with final positions
      setProcessedData(finalData);

      // Notify parent, including whether more work is pending
      stableOnDecollisionComplete(finalData, needsAnotherCycle);
    });

    return () => {
      simulation.stop();
      decollisionSnapshotRef.current = null;
    };
  }, [enableDecollisioning, defaultSize, useCanvas]);


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
    };
  }, []);


  useImperativeHandle(ref, () => ({
    zoomToVisible,
    getVisibleDotCount: () => visibleDotCount,
    updateVisibleDotCount,
    getZoomTransform: () => zoomManager.current?.getCurrentTransform(),
  }), [zoomToVisible, visibleDotCount, updateVisibleDotCount]);

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

      {/* Vector layer that gets the full d3 zoom transform */}
      <g ref={contentRef} id="vector-layer">
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
    </svg>
  );
});

export default DotVisualization;