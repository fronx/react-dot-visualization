const EdgeLayer = ({ edges = [], data, edgeOpacity = 0.3, edgeColor = '#999' }) => {
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
            strokeWidth={edge.strength * 0.5}
          />
        );
      })}
    </g>
  );
};

export default EdgeLayer;