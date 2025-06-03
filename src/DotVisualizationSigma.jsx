import React, { useEffect, useRef, useCallback } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';

const DotVisualizationSigma = (props) => {
  const {
    data = [],
    clusters = [],
    clusterKey = (item) => item.cluster_level_0,
    onHover,
    onLeave,
    onClick,
    onBackgroundClick,
    defaultColor = '#3498db',
    defaultSize = 5,
    dotStyles = new Map(),
    className = "",
    style = {},
    ...otherProps
  } = props;

  const containerRef = useRef(null);
  const sigmaRef = useRef(null);
  const graphRef = useRef(null);

  // Auto-generate IDs if missing
  const ensureIds = useCallback((data) => {
    return data.map((item, index) => ({
      ...item,
      id: item.id !== undefined ? item.id : index
    }));
  }, []);

  // Create graph from data
  const createGraph = useCallback((processedData) => {
    const graph = new Graph();

    processedData.forEach((item) => {
      if (typeof item.x !== 'number' || typeof item.y !== 'number') {
        return;
      }

      const nodeId = String(item.id);
      const customStyle = dotStyles.get(item.id) || {};
      const color = customStyle.color || item.color || defaultColor;
      const size = customStyle.size || item.size || defaultSize;

      graph.addNode(nodeId, {
        x: item.x,
        y: item.y,
        size: size,
        color: color,
        label: item.label || '',
        originalData: item
      });
    });

    return graph;
  }, [defaultColor, defaultSize, dotStyles]);

  // Initialize and update Sigma
  useEffect(() => {
    if (!data || data.length === 0 || !containerRef.current) {
      return;
    }

    // Process data
    const dataWithIds = ensureIds(data);
    const validData = dataWithIds.filter(item =>
      typeof item.x === 'number' && typeof item.y === 'number'
    );

    if (validData.length === 0) {
      console.warn('DotVisualizationSigma: No valid data items found. Each item must have x and y properties.');
      return;
    }

    // Create or update graph
    const graph = createGraph(validData);
    graphRef.current = graph;

    // Clean up existing Sigma instance
    if (sigmaRef.current) {
      sigmaRef.current.kill();
    }

    // Create new Sigma renderer
    const sigma = new Sigma(graph, containerRef.current, {
      renderLabels: false,
      renderEdgeLabels: false,
      hideEdgesOnMove: false,
      hideLabelsOnMove: false,
      enableEdgeEvents: false,
      enableNodeEvents: true,
      zIndex: true,
      
      // Node renderer settings
      nodeReducer: (node, data) => ({
        ...data,
        size: data.size,
        color: data.color,
        label: ''
      })
    });

    sigmaRef.current = sigma;

    // Set up event handlers
    if (onHover) {
      sigma.on('enterNode', ({ node }) => {
        const nodeData = graph.getNodeAttributes(node);
        onHover(nodeData.originalData);
      });
    }

    if (onLeave) {
      sigma.on('leaveNode', ({ node }) => {
        const nodeData = graph.getNodeAttributes(node);
        onLeave(nodeData.originalData);
      });
    }

    if (onClick) {
      sigma.on('clickNode', ({ node }) => {
        const nodeData = graph.getNodeAttributes(node);
        onClick(nodeData.originalData);
      });
    }

    if (onBackgroundClick) {
      sigma.on('clickStage', (event) => {
        onBackgroundClick(event);
      });
    }

    // Initial render
    sigma.refresh();

    // Cleanup function
    return () => {
      if (sigmaRef.current) {
        sigmaRef.current.kill();
        sigmaRef.current = null;
      }
    };
  }, [data, ensureIds, createGraph, onHover, onLeave, onClick, onBackgroundClick]);

  // Update node styles when dotStyles change
  useEffect(() => {
    if (!sigmaRef.current || !graphRef.current) {
      return;
    }

    const graph = graphRef.current;
    
    // Update node attributes based on dotStyles
    graph.forEachNode((nodeId, attributes) => {
      const originalData = attributes.originalData;
      const customStyle = dotStyles.get(originalData.id) || {};
      const color = customStyle.color || originalData.color || defaultColor;
      const size = customStyle.size || originalData.size || defaultSize;

      graph.setNodeAttribute(nodeId, 'color', color);
      graph.setNodeAttribute(nodeId, 'size', size);
    });

    sigmaRef.current.refresh();
  }, [dotStyles, defaultColor, defaultSize]);

  return (
    <div
      ref={containerRef}
      className={`dot-visualization-sigma ${className}`}
      style={{
        width: '100%',
        height: '100%',
        ...style
      }}
      {...otherProps}
    />
  );
};

export default DotVisualizationSigma;