import React, { useEffect } from 'react';
import * as d3 from 'd3';
import { getDotSize, getSyncedPosition, updateColoredDotAttributes } from './dotUtils.js';

const ColoredDots = React.memo((props) => {
  const {
    data = [],
    dotId,
    stroke = "#111",
    strokeWidth = 0.2,
    defaultColor = null,
    defaultSize = 2,
    dotStyles = new Map(),
    hoveredDotId = null,
    hoverSizeEnabled = false,
    hoverSizeMultiplier = 1.5
  } = props;
  const getColor = (item, index) => {
    if (item.color) return item.color;
    if (defaultColor) return defaultColor;
    // Use d3 color scale as fallback
    const colorScale = d3.scaleSequential(d3.interpolatePlasma)
      .domain([0, data.length - 1]);
    return colorScale(index);
  };

  const getSize = (item) => {
    const baseSize = getDotSize(item, dotStyles, defaultSize);
    if (hoverSizeEnabled && hoveredDotId === item.id) {
      return baseSize * hoverSizeMultiplier;
    }
    return baseSize;
  };

  useEffect(() => {
    data.forEach((item, index) => {
      const elementId = dotId(0, item);
      const position = getSyncedPosition(item, elementId);
      const size = getSize(item);
      const color = getColor(item, index);
      
      updateColoredDotAttributes(item, elementId, position, size, color, stroke, strokeWidth, dotStyles);
    });
  }, [data, dotStyles, dotId, stroke, strokeWidth, defaultColor, defaultSize, hoveredDotId, hoverSizeEnabled, hoverSizeMultiplier]);

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