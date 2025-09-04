import { useDebug } from './useDebug.js';

const EdgeLayer = ({
  edges = [],
  data,
  edgeOpacity = 0.3,
  edgeColor = '#999',
  strokeWidth = 1,
  debug = false
}) => {
  const debugLog = useDebug(debug);
  // Create a map of node positions by ID for quick lookup
  const nodeMap = new Map();
  data.forEach(node => {
    nodeMap.set(node.id, { x: node.x, y: node.y });
  });

  return (
    <g id="edge-layer" style={{ pointerEvents: 'none' }}>
      {edges.map((edge, index) => {
        const source = nodeMap.get(edge.source);
        const target = nodeMap.get(edge.target);

        if (!source || !target) return null;

        return (
          <line
            key={`edge-${index}`}
            x1={source.x}
            y1={source.y}
            x2={target.x}
            y2={target.y}
            stroke={edgeColor}
            strokeOpacity={edge.strength * edge.strength * edgeOpacity}
            strokeWidth={edge.strength * strokeWidth}
          />
        );
      })}
    </g>
  );
};

export default EdgeLayer;