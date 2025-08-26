import React, { useEffect, useState, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import * as d3 from 'd3';
import ColoredDots from './ColoredDots.jsx';
import InteractionLayer from './InteractionLayer.jsx';
import ClusterLabels from './ClusterLabels.jsx';
import EdgeLayer from './EdgeLayer.jsx';
import { boundsForData, computeOcclusionAwareViewBox, computeFitTransformToVisible, shouldAutoZoomToNewContent, computeAbsoluteExtent, unionExtent, setAbsoluteExtent, updateZoomExtentForData } from './utils.js';


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
    zoomExtent = [0.5, 20],
    margin = 0.1,
    dotStroke = "#111",
    dotStrokeWidth = 0.2,
    defaultColor = null,
    defaultSize = 2,
    dotStyles = new Map(),
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
    ...otherProps
  } = props;

  const [processedData, setProcessedData] = useState([]);
  const [viewBox, setViewBox] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isWheelActive, setIsWheelActive] = useState(false);
  const [isZoomSetupComplete, setIsZoomSetupComplete] = useState(false);

  // Block hover when actively interacting
  const isZooming = isDragging || isWheelActive;

  const zoomRef = useRef(null);
  const contentRef = useRef(null);
  const transform = useRef(null);
  const zoomHandler = useRef(null);
  const baseScaleRef = useRef(null);
  const wheelTimeoutRef = useRef(null);
  const dataRef = useRef([]);
  const memoizedPositions = useRef(new Map()); // Store final positions after collision detection
  const previousDataRef = useRef([]);
  const didInitialAutoFitRef = useRef(false);
  const autoZoomTimeoutRef = useRef(null);
  const lastDataBoundsRef = useRef(null);

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

  // Apply zoom/pan transform to both d3 zoom handler and content
  const applyTransform = useCallback((newTransform) => {
    if (!zoomHandler.current || !zoomRef.current) return;

    d3.select(zoomRef.current).call(zoomHandler.current.transform, newTransform);
    transform.current = newTransform;
    if (contentRef.current) {
      contentRef.current.setAttribute("transform", newTransform.toString());
    }
  }, []);

  const zoomToVisible = useCallback((duration = 0, easing = d3.easeCubicInOut, dataOverride = null) => {
    const dataToUse = dataOverride || processedData;
    if (!zoomRef.current || !zoomHandler.current || !viewBox || !dataToUse.length) return false;
    const rect = zoomRef.current.getBoundingClientRect();
    const bounds = boundsForData(dataToUse, defaultSize);
    const fit = computeFitTransformToVisible(bounds, viewBox, rect, {
      left: occludeLeft, right: occludeRight, top: occludeTop, bottom: occludeBottom
    }, fitMargin);
    if (!fit) return false;
    const next = d3.zoomIdentity.translate(fit.x, fit.y).scale(fit.k);

    // --- NEW: compute next absolute extent from proposed baseScale = fit.k
    const newAbsExtent = computeAbsoluteExtent(zoomExtent, fit.k);
    const oldAbsExtent = zoomHandler.current ? zoomHandler.current.scaleExtent() : null;
    const widenedExtent = unionExtent(oldAbsExtent, newAbsExtent);

    // Helper to finalize base and extent
    const finalizeBaseAndExtent = () => {
      baseScaleRef.current = fit.k;
      setAbsoluteExtent(zoomHandler.current, newAbsExtent);
    };

    if (duration > 0) {
      // --- NEW: widen before the animation so it can't be clamped mid-flight
      setAbsoluteExtent(zoomHandler.current, widenedExtent);

      const currentTransform = transform.current || d3.zoomIdentity;
      const interpolator = d3.interpolateZoom(
        [currentTransform.x, currentTransform.y, viewBox[2] / currentTransform.k],
        [next.x, next.y, viewBox[2] / next.k]
      );

      d3.select(zoomRef.current)
        .transition()
        .duration(duration)
        .ease(easing)
        .tween('zoom', () => {
          return (t) => {
            const [x, y, scale] = interpolator(t);
            const k = viewBox[2] / scale;
            const interpolatedTransform = d3.zoomIdentity.translate(x, y).scale(k);
            d3.select(zoomRef.current).property('__zoom', interpolatedTransform);
            transform.current = interpolatedTransform;
            if (contentRef.current) {
              contentRef.current.setAttribute('transform', interpolatedTransform.toString());
            }
          };
        })
        .on('end', () => {
          // Ensure final state + finalize extents
          transform.current = next;
          d3.select(zoomRef.current).property('__zoom', next);
          if (contentRef.current) {
            contentRef.current.setAttribute('transform', next.toString());
          }
          finalizeBaseAndExtent();  // --- NEW
        })
        .on('interrupt', () => {
          // On interrupt, derive base from current transform, not target
          const sel = d3.select(zoomRef.current);
          const cur = sel.property('__zoom') || transform.current || d3.zoomIdentity;
          baseScaleRef.current = cur.k;
          const abs = computeAbsoluteExtent(zoomExtent, baseScaleRef.current);
          setAbsoluteExtent(zoomHandler.current, abs);
        });
    } else {
      // Immediate transform path
      setAbsoluteExtent(zoomHandler.current, widenedExtent);
      applyTransform(next);
      finalizeBaseAndExtent(); // --- NEW
    }
    return true;
  }, [processedData, viewBox, occludeLeft, occludeRight, occludeTop, occludeBottom, fitMargin, applyTransform, zoomExtent]);

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

    // console.log('🔍 DotVisualization Data Processing:', {
    //   previousCount: previousDataRef.current.length,
    //   newCount: validData.length,
    //   positionsChanged,
    //   memoizedPositionsCount: memoizedPositions.current.size,
    //   firstFewIds: validData.slice(0, 3).map(d => d.id)
    // });

    let processedValidData = validData;

    // If positions haven't changed and positions are stable, restore memoized decollisioned positions
    if (!positionsChanged && memoizedPositions.current.size > 0 && !positionsAreIntermediate) {
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

    // Initialize viewBox once (occlusion-aware; then freeze)
    if (!viewBox) {
      const rect = zoomRef.current?.getBoundingClientRect?.();
      if (rect && rect.width > 0 && rect.height > 0) {
        const bounds = boundsForData(validData, defaultSize);
        const vb = computeOcclusionAwareViewBox(bounds, { width: rect.width, height: rect.height }, {
          left: occludeLeft, right: occludeRight, top: occludeTop, bottom: occludeBottom
        }, margin);
        console.log('Initialized viewBox:', vb);
        if (vb) setViewBox(vb);
      }
    }

    // Calculate current data bounds
    const currentBounds = validData.length > 0 ? boundsForData(validData, defaultSize) : null;

    // Auto-zoom to new content if enabled
    if (autoZoomToNewContent && currentBounds && viewBox && lastDataBoundsRef.current) {
      const shouldAutoZoom = shouldAutoZoomToNewContent(
        validData,
        lastDataBoundsRef.current,
        viewBox,
        transform.current || d3.zoomIdentity,
        defaultSize
      );

      if (shouldAutoZoom) {
        zoomToVisible(autoZoomDuration, d3.easeCubicInOut, validData);
      }
    } else if (!autoZoomToNewContent) {
      // When auto-zoom is disabled, still update zoom extents to allow manual zoom out
      // to see all data when new content is added outside current bounds
      const rect = zoomRef.current?.getBoundingClientRect();
      const occlusion = { left: occludeLeft, right: occludeRight, top: occludeTop, bottom: occludeBottom };
      updateZoomExtentForData(zoomHandler.current, validData, viewBox, rect, occlusion, zoomExtent, fitMargin, defaultSize);
    }

    // Store original input data for future comparisons
    previousDataRef.current = validData.map(item => ({ ...item })); // Deep copy of validData!! This is important!
    // Store processed data (either original or with restored positions)
    dataRef.current = processedValidData;
    setProcessedData(processedValidData);

    // Update last data bounds for auto-zoom detection
    if (currentBounds) {
      lastDataBoundsRef.current = currentBounds;
    }

  }, [data, margin, ensureIds, hasPositionsChanged, positionsAreIntermediate, autoZoomToNewContent, autoZoomDuration]);

  // Initialize zoom handler (browser-only)
  useEffect(() => {
    if (typeof window !== 'undefined' && !zoomHandler.current) {
      zoomHandler.current = d3.zoom();
      // Don't set a safety net extent here - let it be set properly based on actual data
      // The initial extent will be set when data is processed
    }
  }, []);

  // Set up zoom behavior
  useEffect(() => {
    if (!processedData.length || !zoomRef.current || typeof window === 'undefined' || !zoomHandler.current) {
      return;
    }

    const handleDragStart = (event) => {
      setIsDragging(true);
      if (onZoomStart) onZoomStart(event);
    };

    const handleDragEnd = (event) => {
      setIsDragging(false);
      if (onZoomEnd) onZoomEnd(event);
    };

    const handleWheel = () => {
      setIsWheelActive(true);

      // Clear existing timeout
      if (wheelTimeoutRef.current) {
        clearTimeout(wheelTimeoutRef.current);
      }

      // Set a short debounce for wheel events
      wheelTimeoutRef.current = setTimeout(() => {
        setIsWheelActive(false);
        wheelTimeoutRef.current = null;
      }, 100);
    };

    const onZoom = (event) => {
      event.preventDefault();
      handleWheel(); // Track wheel activity

      const selection = d3.select(zoomRef.current);
      const currentZoom = selection.property("__zoom")?.k || 1;

      if (event.ctrlKey) {
        // Use mouse wheel + ctrl key, or trackpad pinch to zoom
        const nextZoom = currentZoom * Math.pow(2, -event.deltaY * 0.01);
        zoomHandler.current.scaleTo(selection, nextZoom, d3.pointer(event));
      } else {
        // Pan with mouse wheel or trackpad
        // Calculate pan speed relative to viewport size, not coordinate scale
        const svgRect = zoomRef.current.getBoundingClientRect();
        const viewBoxWidth = viewBox[2];
        const viewBoxHeight = viewBox[3];

        // Scale pan speed based on viewBox to viewport ratio
        const panSensitivity = 1.0; // Adjust this to fine-tune pan speed
        const panSpeedX = (viewBoxWidth / svgRect.width) * panSensitivity;
        const panSpeedY = (viewBoxHeight / svgRect.height) * panSensitivity;

        zoomHandler.current.translateBy(
          selection,
          -(event.deltaX * panSpeedX / currentZoom),
          -(event.deltaY * panSpeedY / currentZoom)
        );
      }

      transform.current = selection.property("__zoom");
      if (contentRef.current) {
        contentRef.current.setAttribute("transform", transform.current.toString());
      }
    };

    zoomHandler.current
      .on("start", handleDragStart)
      .on("end", handleDragEnd);

    d3.select(zoomRef.current)
      .call(zoomHandler.current)
      .on("wheel.zoom", onZoom);

    setIsZoomSetupComplete(true);

    return () => {
      if (wheelTimeoutRef.current) {
        clearTimeout(wheelTimeoutRef.current);
      }
      setIsZoomSetupComplete(false);
    };
  }, [processedData, zoomExtent, onZoomStart, onZoomEnd, viewBox]);


  // Decolliding dots
  useEffect(() => {
    // console.log('Decolliding Dots:', {
    //   enableDecollisioning,
    //   processedDataLength: processedData.length,
    //   willRunCollision: enableDecollisioning && processedData.length > 0
    // });

    if (!enableDecollisioning || !processedData.length || typeof window === 'undefined') {
      return;
    }

    // console.log('Decolliding dots');

    let tick = 0;
    const simulationData = processedData.map(d => ({ ...d }));
    const dots0 = d3.selectAll('#colored-dots circle').data(simulationData);
    const dots1 = d3.selectAll('#interaction-layer circle').data(simulationData);

    const simulation = d3.forceSimulation(simulationData)
      .alpha(1)
      .alphaMin(0.01)
      .alphaDecay(0.01)
      .force('collide', d3.forceCollide().radius(item => (item.size || defaultSize)))
      .on('tick', () => {
        tick += 1;
        const updateFrequency = Math.min(10, Math.ceil(tick / 10));

        if (tick % updateFrequency === 0) {
          dots0
            .attr('cx', d => d.x)
            .attr('cy', d => d.y)
            .each(d => {
              memoizedPositions.current.set(d.id, { x: d.x, y: d.y });
            });
          dots1
            .attr('cx', d => d.x)
            .attr('cy', d => d.y);
        }
      })
      .on('end', () => {
        dots0
          .attr('cx', d => d.x)
          .attr('cy', d => d.y)
          .each(d => {
            memoizedPositions.current.set(d.id, { x: d.x, y: d.y });
          });
        dots1
          .attr('cx', d => d.x)
          .attr('cy', d => d.y);

        console.log('Decollided dots:', memoizedPositions.current.size);
        if (onDecollisionComplete) {
          // Create final positions array with updated coordinates from decollision
          const finalPositions = processedValidData.map(item => {
            const memoizedPos = memoizedPositions.current.get(item.id);
            if (memoizedPos) {
              return { ...item, x: memoizedPos.x, y: memoizedPos.y };
            }
            return item;
          });
          onDecollisionComplete(finalPositions);
        }
      });

    return () => {
      simulation.stop();
    };
  }, [processedData, enableDecollisioning, defaultSize]);


  // Handle mouse leave to reset interaction states
  const handleMouseLeave = () => {
    setIsDragging(false);
    setIsWheelActive(false);
    if (wheelTimeoutRef.current) {
      clearTimeout(wheelTimeoutRef.current);
      wheelTimeoutRef.current = null;
    }
  };

  // Keep extents in sync when zoomExtent prop changes
  useEffect(() => {
    if (!zoomHandler.current) return;
    if (baseScaleRef.current == null) return; // wait for first fit

    const newExtentFromBase = computeAbsoluteExtent(zoomExtent, baseScaleRef.current);
    const currentExtent = zoomHandler.current.scaleExtent();

    // Only update if there's no current extent, or if the new extent is more permissive
    // (allows more zoom out) than the current one. This prevents overriding extents
    // that were carefully calculated for larger data ranges.
    const hasNoExtent = !currentExtent || currentExtent[0] === 0 && currentExtent[1] === Infinity;
    const isMorePermissive = !hasNoExtent && newExtentFromBase[0] < currentExtent[0];

    if (hasNoExtent || isMorePermissive) {
      setAbsoluteExtent(zoomHandler.current, newExtentFromBase);
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
  }), [zoomToVisible]);

  // Auto-fit to visible region
  useEffect(() => {
    // Only run once; do not auto-fit again after first successful fit
    if (didInitialAutoFitRef.current) return;
    if (!autoFitToVisible) return;
    if (!viewBox || !zoomRef.current || !zoomHandler.current) return;
    if (!processedData.length) return; // wait until data and zoom binding are ready
    if (!isZoomSetupComplete) return; // wait until zoom behavior is fully set up

    // Defer to next microtask to ensure DOM/layout is up to date
    Promise.resolve().then(() => {
      const ok = zoomToVisible();
      console.log('zoomed to visible, ok: ', ok);
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
      <g ref={contentRef}>
        {(edges && edges.length > 0) && (
          <EdgeLayer
            edges={edges}
            data={processedData}
            edgeOpacity={edgeOpacity}
            edgeColor={edgeColor}
            strokeWidth={dotStroke}
          />
        )}
        <ColoredDots
          data={processedData}
          dotId={dotId}
          stroke={dotStroke}
          strokeWidth={dotStrokeWidth}
          defaultColor={defaultColor}
          defaultSize={defaultSize}
          dotStyles={dotStyles}
        />
        <ClusterLabels
          data={processedData}
          clusters={clusters}
          clusterKey={clusterKey}
          renderCluster={renderCluster}
          hoveredCluster={hoveredCluster}
          onClusterHover={onClusterHover}
          onClusterLeave={onClusterLeave}
        />
        <InteractionLayer
          data={processedData}
          dotId={dotId}
          onHover={onHover}
          onLeave={onLeave}
          onClick={onClick}
          onBackgroundClick={onBackgroundClick}
          onDragStart={onDragStart}
          isZooming={isZooming}
          defaultSize={defaultSize}
          dotStyles={dotStyles}
        />
      </g>
    </svg>
  );
});

export default DotVisualization;