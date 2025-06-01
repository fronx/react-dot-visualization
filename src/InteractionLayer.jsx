import React, { useEffect } from 'react';
import * as d3 from 'd3';

const InteractionLayer = React.memo((props) => {
  const {
    data = [],
    dotId,
    onHover,
    onLeave,
    onClick,
    isZooming = false,
    defaultSize = 2,
    dotStyles = new Map()
  } = props;

  const getSize = (item) => {
    return item.size || defaultSize;
  };

  const handleMouseEnter = (e, item) => {
    if (!isZooming && onHover) {
      onHover(item, e);
    }
  };

  const handleMouseLeave = (e, item) => {
    if (!isZooming && onLeave) {
      onLeave(item, e);
    }
  };

  const handleClick = (e, item) => {
    if (onClick) {
      onClick(item, e);
    }
  };

  // Apply custom styles to interaction layer dots
  useEffect(() => {
    dotStyles.forEach((styles, itemId) => {
      const elementId = dotId(1, { id: itemId });
      const element = d3.select(`#${elementId}`);
      if (!element.empty()) {
        Object.entries(styles).forEach(([prop, value]) => {
          if (prop === 'r' || prop === 'cx' || prop === 'cy') {
            element.attr(prop, value);
          }
        });
      }
    });
  }, [dotStyles, dotId]);

  return (
    <g id="interaction-layer">
      {data.map((item) => (
        <circle
          id={dotId(1, item)}
          key={dotId(1, item)}
          r={getSize(item)}
          cx={item.x}
          cy={item.y}
          fill="transparent"
          style={{ cursor: onClick ? 'pointer' : 'default' }}
          onClick={(e) => handleClick(e, item)}
          onMouseEnter={(e) => handleMouseEnter(e, item)}
          onMouseLeave={(e) => handleMouseLeave(e, item)}
        />
      ))}
    </g>
  );
});

export default InteractionLayer;