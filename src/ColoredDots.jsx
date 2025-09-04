import React, { useEffect } from 'react';
import * as d3 from 'd3';
import { getDotSize, getSyncedPosition, updateColoredDotAttributes } from './dotUtils.js';
import ImagePatterns from './ImagePatterns.jsx';

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
    hoverSizeMultiplier = 1.5,
    useImages = false,
    imageProvider,
    hoverImageProvider
  } = props;
  const getColor = (item, index) => {
    if (item.color) return item.color;
    if (defaultColor) return defaultColor;
    // Use d3 color scale as fallback
    const colorScale = d3.scaleSequential(d3.interpolatePlasma)
      .domain([0, data.length - 1]);
    return colorScale(index);
  };

  const getFill = (item, index) => {
    if (useImages) {
      // Check if we should show hover image (if hoverImageProvider is available and item is hovered)
      const shouldUseHoverImage = hoverImageProvider && hoveredDotId === item.id;
      const hoverImageUrl = shouldUseHoverImage ? hoverImageProvider(item.id) : undefined;
      const regularImageUrl = imageProvider ? imageProvider(item.id) : item.imageUrl;
      
      // Determine which pattern to use
      if (shouldUseHoverImage && hoverImageUrl && hoverImageUrl !== regularImageUrl) {
        // Use hover pattern if it exists and is different from regular image
        return `url(#image-pattern-hover-${item.id})`;
      } else if (regularImageUrl || item.svgContent) {
        // Use regular pattern
        return `url(#image-pattern-${item.id})`;
      }
    }
    return getColor(item, index);
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
      const fill = getFill(item, index);
      
      updateColoredDotAttributes(item, elementId, position, size, fill, stroke, strokeWidth, dotStyles);
    });
  }, [data, dotStyles, dotId, stroke, strokeWidth, defaultColor, defaultSize, hoveredDotId, hoverSizeEnabled, hoverSizeMultiplier, useImages, imageProvider, hoverImageProvider]);

  let hoveredDotElement = null;

  return (
    <g id="colored-dots">
      <ImagePatterns 
        data={data} 
        useImages={useImages} 
        imageProvider={imageProvider}
        hoverImageProvider={hoverImageProvider}
      />
      {data.map((item, index) => {
        const circleElement = (
          <circle
            id={dotId(0, item)}
            key={dotId(0, item)}
            r={getSize(item)}
            cx={item.x}
            cy={item.y}
            fill={getFill(item, index)}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
        );
        
        // If this is the hovered dot, store it for later rendering
        if (hoveredDotId === item.id) {
          hoveredDotElement = circleElement;
          return null; // Skip rendering now
        }
        
        return circleElement;
      })}
      {/* Render the hovered dot last (on top) */}
      {hoveredDotElement}
    </g>
  );
});

export default ColoredDots;