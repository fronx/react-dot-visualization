import React, { useEffect } from 'react';
import * as d3 from 'd3';
import { getDotSize, getSyncedPosition, updateColoredDotAttributes } from './dotUtils.js';
import ImagePatterns from './ImagePatterns.jsx';
import { PrioritizedList } from './PrioritizedList.js';
import { useDebug } from './useDebug.js';

const ColoredDots = React.memo((props) => {
  const {
    data = [],
    dotId,
    stroke = "#111",
    strokeWidth = 0.2,
    defaultColor = null,
    defaultSize = 2,
    defaultOpacity = 0.7,
    dotStyles = new Map(),
    hoveredDotId = null,
    hoverSizeMultiplier = 1.5,
    hoverOpacity = 1.0,
    useImages = false,
    imageProvider,
    hoverImageProvider,
    visibleDotCount = null,
    debug = false
  } = props;
  
  const debugLog = useDebug(debug);
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
      const hoverImageUrl = shouldUseHoverImage ? hoverImageProvider(item.id, visibleDotCount) : undefined;
      const regularImageUrl = imageProvider ? imageProvider(item.id, visibleDotCount) : item.imageUrl;

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
    if (hoveredDotId === item.id) {
      return baseSize * hoverSizeMultiplier;
    }
    return baseSize;
  };

  const getOpacity = (item) => {
    return hoveredDotId === item.id ? hoverOpacity : defaultOpacity;
  };

  useEffect(() => {
    data.forEach((item, index) => {
      const elementId = dotId(0, item);
      const position = getSyncedPosition(item, elementId);
      const size = getSize(item);
      const fill = getFill(item, index);
      const opacity = getOpacity(item);
      const isHovered = hoveredDotId === item.id;

      updateColoredDotAttributes(item, elementId, position, size, fill, stroke, strokeWidth, opacity, dotStyles, isHovered);
    });
  }, [data, dotStyles, dotId, stroke, strokeWidth, defaultColor, defaultSize, defaultOpacity, hoveredDotId, hoverSizeMultiplier, hoverOpacity, useImages, imageProvider, hoverImageProvider]);

  return (
    <g id="colored-dots">
      <ImagePatterns
        data={data}
        useImages={useImages}
        imageProvider={imageProvider}
        hoverImageProvider={hoverImageProvider}
        visibleDotCount={visibleDotCount}
      />
      <PrioritizedList data={data} prioritizedId={hoveredDotId}>
        {(item, index) => (
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
        )}
      </PrioritizedList>
    </g>
  );
});

export default ColoredDots;