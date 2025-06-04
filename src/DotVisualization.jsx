import React, { useEffect, useState, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import * as d3 from 'd3';
import ColoredDots from './ColoredDots.jsx';
import InteractionLayer from './InteractionLayer.jsx';
import ClusterLabels from './ClusterLabels.jsx';
import { calculateViewBox } from './utils.js';

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
    onZoomStart,
    onZoomEnd,
    enableCollisionDetection = true,
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

    // Calculate viewBox
    const calculatedViewBox = calculateViewBox(validData, margin);
    setViewBox(calculatedViewBox);

    // Store processed data
    dataRef.current = validData;
    setProcessedData(validData);

  }, [data, margin, ensureIds]);

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

  // Collision detection force simulation
  useEffect(() => {
    if (!enableCollisionDetection || !processedData.length) {
      return;
    }

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
            .attr('cy', d => d.y);
          dots1
            .attr('cx', d => d.x)
            .attr('cy', d => d.y);
        }
      })
      .on('end', () => {
        dots0
          .attr('cx', d => d.x)
          .attr('cy', d => d.y);
        dots1
          .attr('cx', d => d.x)
          .attr('cy', d => d.y);
      });

    return () => {
      simulation.stop();
    };
  }, [processedData, enableCollisionDetection, defaultSize]);

  // Expose setDotColors method via ref
  useImperativeHandle(ref, () => ({
    setDotColors: (colorMap) => {
      if (!colorMap || typeof colorMap !== 'object') {
        console.warn('DotVisualization.setDotColors: colorMap must be an object');
        return;
      }

      // Update colors directly in the DOM without re-rendering
      Object.entries(colorMap).forEach(([itemId, color]) => {
        const elementId = dotId(0, { id: itemId });
        const element = d3.select(`#${elementId}`);
        if (!element.empty() && color) {
          element.attr('fill', color);
        }
      });
    }
  }), [dotId]);

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
          isZooming={isZooming}
          defaultSize={defaultSize}
          dotStyles={dotStyles}
        />
      </g>
    </svg>
  );
});

export default DotVisualization;