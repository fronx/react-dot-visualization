import React, { useMemo } from 'react';
import { Line } from '@react-three/drei';

/**
 * Renders graph edges as Line2 primitives.
 * - edges: array of {source, target, strength}
 * - dataMap: Map<id, {x, y}>
 * - edgeColor: CSS color string
 * - edgeOpacity: base opacity multiplier (0-1)
 */
export function R3FEdges({ edges, dataMap, edgeColor = '#999', edgeOpacity = 0.3 }) {
  // Group all edges into a single set of line segments for performance
  const segments = useMemo(() => {
    const result = [];
    for (const edge of edges) {
      const src = dataMap.get(edge.source);
      const tgt = dataMap.get(edge.target);
      if (!src || !tgt) continue;
      const opacity = Math.min(1, edge.strength * edge.strength * edgeOpacity);
      if (opacity < 0.01) continue;
      result.push({ src, tgt, opacity, strength: edge.strength });
    }
    return result;
  }, [edges, dataMap, edgeOpacity]);

  if (segments.length === 0) return null;

  // For performance, render all edges with the same opacity as a single Line batch
  // Group by similar opacity bands to minimize draw calls
  const opacityBands = new Map();
  for (const seg of segments) {
    const band = Math.round(seg.opacity * 10) / 10; // bucket to 0.1 increments
    if (!opacityBands.has(band)) opacityBands.set(band, []);
    opacityBands.get(band).push(seg);
  }

  return (
    <>
      {[...opacityBands.entries()].map(([opacity, segs]) => {
        // Each segment needs its own points array for Line
        return segs.map((seg, i) => (
          <Line
            key={`${opacity}-${i}`}
            points={[[seg.src.x, seg.src.y, 0], [seg.tgt.x, seg.tgt.y, 0]]}
            color={edgeColor}
            lineWidth={seg.strength}
            opacity={opacity}
            transparent
          />
        ));
      })}
    </>
  );
}
