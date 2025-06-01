import React from 'react';

const InteractionLayer = React.memo((props) => {
  const {
    data = [],
    dotId,
    onHover,
    onLeave,
    onClick,
    isZooming = false,
    defaultSize = 2
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