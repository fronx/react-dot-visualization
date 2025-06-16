import React, { useEffect, useState, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import * as d3 from 'd3';
import ColoredDots from './ColoredDots.jsx';
import InteractionLayer from './InteractionLayer.jsx';
import ClusterLabels from './ClusterLabels.jsx';
import { calculateViewBox } from './utils.js';

// Helper function to check if two numbers are equal after rounding to 2 decimal places
const isWithinTolerance = (a, b) => {
  return Math.round(a * 100) === Math.round(b * 100);
};

const DotVisualization = forwardRef((props, ref) => {
  const {
    data = [],
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
    onZoomStart,
    onZoomEnd,
    enableDecollisioning = true,
    zoomExtent = [0.7, 10],
    margin = 0.1,
    dotStroke = "#111",
    dotStrokeWidth = 0.2,
    defaultColor = null,
    defaultSize = 2,
    dotStyles = new Map(),
    className = "",
    style = {},
    ...otherProps
  } = props;

  const [processedData, setProcessedData] = useState([]);
  const [viewBox, setViewBox] = useState([0, 0, 100, 100]);
  const [isZooming, setIsZooming] = useState(false);

  const zoomRef = useRef(null);
  const contentRef = useRef(null);
  const transform = useRef(null);
  const zoomHandler = useRef(d3.zoom());
  const zoomTimerRef = useRef(null);
  const dataRef = useRef([]);
  const memoizedPositions = useRef(new Map()); // Store final positions after collision detection
  const previousDataRef = useRef([]);

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

    // If positions haven't changed, restore memoized decollisioned positions
    if (!positionsChanged && memoizedPositions.current.size > 0) {
      console.log('📍 Restoring memoized positions for', validData.length, 'dots');
      processedValidData = validData.map(item => {
        const memoizedPos = memoizedPositions.current.get(item.id);
        if (memoizedPos) {
          return { ...item, x: memoizedPos.x, y: memoizedPos.y };
        }
        return item;
      });
    } else {
      // console.log('Positions changed, running collision detection');
    }

    // Calculate viewBox (use original positions for consistent bounds)
    const calculatedViewBox = calculateViewBox(validData, margin);
    setViewBox(calculatedViewBox);

    // Store original input data for future comparisons
    previousDataRef.current = validData.map(item => ({ ...item })); // Deep copy of validData!! This is important!
    // Store processed data (either original or with restored positions)
    dataRef.current = processedValidData;
    setProcessedData(processedValidData);

  }, [data, margin, ensureIds, hasPositionsChanged]);

  // Set up zoom behavior
  useEffect(() => {
    if (!processedData.length || !zoomRef.current) {
      return;
    }

    const zoomStarted = (event) => {
      setIsZooming(true);
      if (onZoomStart) onZoomStart(event);

      if (zoomTimerRef.current !== null) {
        clearTimeout(zoomTimerRef.current);
      }
      zoomTimerRef.current = setTimeout(() => {
        setIsZooming(false);
        if (onZoomEnd) onZoomEnd(event);
        zoomTimerRef.current = null;
      }, 250);
    };

    const onZoom = (event) => {
      event.preventDefault();

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
      .scaleExtent(zoomExtent)
      .on("start", zoomStarted);

    d3.select(zoomRef.current)
      .call(zoomHandler.current)
      .on("wheel.zoom", onZoom);

    return () => {
      if (zoomTimerRef.current) {
        clearTimeout(zoomTimerRef.current);
      }
    };
  }, [processedData, zoomExtent, onZoomStart, onZoomEnd]);


  // Decolliding dots
  useEffect(() => {
    // console.log('Decolliding Dots:', {
    //   enableDecollisioning,
    //   processedDataLength: processedData.length,
    //   willRunCollision: enableDecollisioning && processedData.length > 0
    // });

    if (!enableDecollisioning || !processedData.length) {
      return;
    }

    // console.log('Decolliding dots');

    let tick = 0;
    const dots0 = d3.selectAll('#colored-dots circle').data(processedData);
    const dots1 = d3.selectAll('#interaction-layer circle').data(processedData);

    const simulation = d3.forceSimulation(processedData)
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
      });

    return () => {
      simulation.stop();
    };
  }, [processedData, enableDecollisioning, defaultSize]);


  if (!processedData.length) {
    return null;
  }

  return (
    <svg
      ref={zoomRef}
      className={`dot-visualization ${className}`}
      viewBox={viewBox.join(' ')}
      style={{
        width: '100%',
        height: '100%',
        ...style
      }}
      {...otherProps}
    >
      <g ref={contentRef}>
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