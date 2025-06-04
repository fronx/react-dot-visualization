import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';

const ColoredDots = React.memo((props) => {
  const {
    data = [],
    dotId,
    stroke = "#111",
    strokeWidth = 0.2,
    defaultColor = null,
    defaultSize = 2,
    dotStyles = new Map()
  } = props;

  // Store original attributes for restoration
  const originalAttrs = useRef(new Map());

  const getColor = (item, index) => {
    if (item.color) return item.color;
    if (defaultColor) return defaultColor;
    // Use d3 color scale as fallback
    const colorScale = d3.scaleSequential(d3.interpolatePlasma)
      .domain([0, data.length - 1]);
    return colorScale(index);
  };

  const getSize = (item) => {
    return item.size || defaultSize;
  };

  // Apply SVG attributes using d3 for direct DOM updates
  useEffect(() => {
    // Process each dot
    data.forEach((item, index) => {
      const elementId = dotId(0, item);
      const element = d3.select(`#${elementId}`);

      if (!element.empty()) {
        // Start with base attributes from the data
        const baseAttrs = {
          r: getSize(item),
          cx: item.x,
          cy: item.y,
          fill: getColor(item, index),
          stroke: stroke,
          'stroke-width': strokeWidth,
          filter: '',
          opacity: 0.7,
        };

        // Merge with custom attributes if any exist for this dot
        const customAttrs = dotStyles.get(item.id) || {};
        const mergedAttrs = { ...baseAttrs, ...customAttrs };

        // Apply all attributes at once
        Object.entries(mergedAttrs).forEach(([attr, value]) => {
          element.attr(attr, value);
        });
      }
    });
  }, [data, dotStyles, dotId, stroke, strokeWidth, defaultColor, defaultSize]);

  return (
    <g id="colored-dots">
      {data.map((item, index) => (
        <circle
          id={dotId(0, item)}
          key={dotId(0, item)}
          r={getSize(item)}
          cx={item.x}
          cy={item.y}
          fill={getColor(item, index)}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      ))}
    </g>
  );
});

export default ColoredDots;