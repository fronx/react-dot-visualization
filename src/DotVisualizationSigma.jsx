import React, { useEffect, useRef, useCallback, useState } from 'react';

// Check if we're in a browser environment
const isBrowser = typeof window !== 'undefined';

// SSR-safe component
const DotVisualizationSigma = (props) => {
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  // Don't render on server
  if (!isBrowser || !isClient) {
    return <div className={props.className} style={props.style} />;
  }

  return <DotVisualizationSigmaClient {...props} />;
};

// Separate client-only component with dynamic imports
const DotVisualizationSigmaClient = (props) => {
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
  const [Sigma, setSigma] = useState(null);
  const [Graph, setGraph] = useState(null);

  // Dynamic import of sigma and graphology
  useEffect(() => {
    const loadLibraries = async () => {
      const [sigmaModule, graphModule] = await Promise.all([
        import('sigma'),
        import('graphology')
      ]);
      setSigma(() => sigmaModule.default);
      setGraph(() => graphModule.default);
    };
    loadLibraries();
  }, []);

  // Auto-generate IDs if missing
  const ensureIds = useCallback((data) => {
    return data.map((item, index) => ({
      ...item,
      id: item.id !== undefined ? item.id : index
    }));
  }, []);

  // Fast RGB to hex conversion using bitwise operations
  const rgbToHex = useCallback((r, g, b) => {
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }, []);

  // Convert color to hex format for Sigma
  const toHexColor = useCallback((color) => {
    if (!color) return '#3498db';
    if (typeof color === 'string' && color.startsWith('#')) return color;
    
    // Handle rgb() and rgba() formats (both old and new CSS syntax)
    const rgbMatch = color.match(/rgba?\((\d+)(?:,\s*|\s+)(\d+)(?:,\s*|\s+)(\d+)(?:(?:,\s*|\s*\/\s*)[\d.]+)?\)/);
    if (rgbMatch) {
      const [, r, g, b] = rgbMatch;
      return rgbToHex(parseInt(r), parseInt(g), parseInt(b));
    }
    
    // For CSS color names, use DOM parsing (fallback)
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return rgbToHex(r, g, b);
    } catch (e) {
      return color; // Return original if conversion fails
    }
  }, [rgbToHex]);

  // Create graph from data
  const createGraph = useCallback((processedData) => {
    if (!Graph) return null;
    const graph = new Graph();

    processedData.forEach((item) => {
      if (typeof item.x !== 'number' || typeof item.y !== 'number') {
        return;
      }

      const nodeId = String(item.id);
      const customStyle = dotStyles.get(item.id) || {};
      const color = toHexColor(customStyle.color || item.color || defaultColor);
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
  }, [Graph, defaultColor, defaultSize, dotStyles, toHexColor]);

  // Initialize Sigma (only when data changes significantly)
  useEffect(() => {
    if (!data || data.length === 0 || !containerRef.current || !Sigma || !Graph) {
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

    console.log('sigmaRef.current', sigmaRef.current);
    console.log('containerRef.current', containerRef.current, 'dimensions:', containerRef.current?.getBoundingClientRect());
    
    // Only recreate Sigma if it doesn't exist
    if (!sigmaRef.current) {
      // Validate container has dimensions
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.height === 0 || rect.width === 0) {
        console.warn('Container has no dimensions, deferring Sigma creation');
        return;
      }

      try {
        // Create new Sigma renderer
        const sigma = new Sigma(graph, containerRef.current, {
        renderLabels: false,
        renderEdgeLabels: false,
        hideEdgesOnMove: false,
        hideLabelsOnMove: false,
        enableEdgeEvents: false,
        enableNodeEvents: true,
        zIndex: true,
        hoverRenderer: null, // Disable the hover renderer completely

        // Node renderer settings
        nodeReducer: (node, data) => ({
          ...data,
          size: data.size,
          color: data.color,
          label: ''
        })
      });

        sigmaRef.current = sigma;
        console.log('Created new Sigma instance');
      } catch (error) {
        console.error('Failed to create Sigma instance:', error);
        return;
      }

      // Disable hover highlighting by clearing hover state
      const sigma = sigmaRef.current;
      sigma.on("enterNode", () => {
        if (sigma.hoveredNode) sigma.hoveredNode = null;
      });

      sigma.on("enterEdge", () => {
        if (sigma.hoveredEdge) sigma.hoveredEdge = null;
      });
    } else {
      // Update existing Sigma with new graph
      sigmaRef.current.setGraph(graph);
    }

    // Cleanup function
    return () => {
      if (sigmaRef.current) {
        sigmaRef.current.kill();
        sigmaRef.current = null;
      }
    };
  }, [data, Sigma, Graph]);

  // Set up event handlers separately to avoid recreating Sigma
  useEffect(() => {
    if (!sigmaRef.current) return;

    console.log('setting up event handlers for sigmaRef.current', sigmaRef);
    const sigma = sigmaRef.current;

    // Clear existing listeners
    sigma.removeAllListeners();

    // Disable hover highlighting by clearing hover state
    sigma.on("enterNode", () => {
      if (sigma.hoveredNode) sigma.hoveredNode = null;
    });

    sigma.on("enterEdge", () => {
      if (sigma.hoveredEdge) sigma.hoveredEdge = null;
    });

    // Set up event handlers
    if (onHover) {
      sigma.on('enterNode', ({ node }) => {
        const nodeData = graphRef.current.getNodeAttributes(node);
        onHover(nodeData.originalData);
      });
    }

    if (onLeave) {
      sigma.on('leaveNode', ({ node }) => {
        const nodeData = graphRef.current.getNodeAttributes(node);
        onLeave(nodeData.originalData);
      });
    }

    if (onClick) {
      sigma.on('clickNode', ({ node }) => {
        const nodeData = graphRef.current.getNodeAttributes(node);
        onClick(nodeData.originalData);
      });
    }

    if (onBackgroundClick) {
      sigma.on('clickStage', (event) => {
        onBackgroundClick(event);
      });
    }

    // Refresh to apply any changes
    sigma.refresh();
  }, [onHover, onLeave, onClick, onBackgroundClick]);

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
      const color = toHexColor(customStyle.color || originalData.color || defaultColor);
      const size = customStyle.size || originalData.size || defaultSize;

      graph.setNodeAttribute(nodeId, 'color', color);
      graph.setNodeAttribute(nodeId, 'size', size);
    });

    sigmaRef.current.refresh();
  }, [dotStyles, defaultColor, defaultSize, toHexColor]);

  // Show loading state while libraries are loading
  if (!Sigma || !Graph) {
    return (
      <div
        className={`dot-visualization-sigma ${className}`}
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...style
        }}
        {...otherProps}
      >
        Loading...
      </div>
    );
  }

  return (
    <div
      className={`dot-visualization-sigma-wrapper ${className}`}
      style={{
        width: '100%',
        height: '100%',
        minHeight: '400px', // Fallback minimum
        flex: 1, // Take available space in flex containers
        display: 'flex',
        flexDirection: 'column',
        ...style
      }}
      {...otherProps}
    >
      <div
        ref={containerRef}
        className="dot-visualization-sigma"
        style={{
          flex: 1,
          width: '100%',
          minHeight: 0 // Allow flex child to shrink
        }}
      />
    </div>
  );
};

export default DotVisualizationSigma;