import React, { useEffect } from 'react';
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

  // Apply custom styles using d3 for direct DOM updates
  useEffect(() => {
    // Clear custom CSS styles
    d3.selectAll('#colored-dots circle').each(function() {
      const element = d3.select(this);
      element.node().style.cssText = '';
    });

    // Apply new CSS styles
    dotStyles.forEach((styles, itemId) => {
      const elementId = dotId(0, { id: itemId });
      const element = d3.select(`#${elementId}`);
      if (!element.empty()) {
        Object.entries(styles).forEach(([prop, value]) => {
          element.style(prop, value);
        });
      }
    });
  }, [dotStyles, dotId]);

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