import React from 'react';

const ImagePatterns = ({ data, useImages, imageProvider, hoverImageProvider, visibleDotCount }) => {
  if (!useImages) return null;

  const renderSvgPattern = (item) => {
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(item.svgContent, 'image/svg+xml');
    const svgElement = svgDoc.querySelector('svg');
    const viewBox = svgElement?.getAttribute('viewBox') || '0 0 32 32';
    const svgInnerHTML = svgElement?.innerHTML || '';
    
    return (
      <pattern
        key={`pattern-${item.id}`}
        id={`image-pattern-${item.id}`}
        patternUnits="objectBoundingBox"
        width="1"
        height="1"
        viewBox={viewBox}
      >
        <g dangerouslySetInnerHTML={{ __html: svgInnerHTML }} />
      </pattern>
    );
  };

  const renderBitmapPattern = (item, imageUrl, patternId) => {
    return (
      <pattern
        key={patternId}
        id={patternId}
        patternUnits="objectBoundingBox"
        patternContentUnits="objectBoundingBox"
        width="1"
        height="1"
      >
        <image
          href={imageUrl}
          x="0"
          y="0"
          width="1"
          height="1"
          preserveAspectRatio="xMidYMid meet"
        />
      </pattern>
    );
  };

  return (
    <defs>
      {data
        .filter(item => {
          // Check if item has SVG content or if any provider has an image for this item
          const providerImageUrl = imageProvider ? imageProvider(item.id, visibleDotCount) : undefined;
          const hoverProviderImageUrl = hoverImageProvider ? hoverImageProvider(item.id, visibleDotCount) : undefined;
          return item.svgContent || item.imageUrl || providerImageUrl || hoverProviderImageUrl;
        })
        .flatMap((item) => {
          const patterns = [];
          
          if (item.svgContent) {
            patterns.push(renderSvgPattern(item));
          } else {
            // Regular image pattern
            const imageUrl = imageProvider ? imageProvider(item.id, visibleDotCount) : item.imageUrl;
            if (imageUrl) {
              patterns.push(renderBitmapPattern(item, imageUrl, `image-pattern-${item.id}`));
            }
            
            // Hover image pattern (if different from regular image)
            const hoverImageUrl = hoverImageProvider ? hoverImageProvider(item.id, visibleDotCount) : undefined;
            if (hoverImageUrl && hoverImageUrl !== imageUrl) {
              patterns.push(renderBitmapPattern(item, hoverImageUrl, `image-pattern-hover-${item.id}`));
            }
          }
          
          return patterns.filter(Boolean);
        })}
    </defs>
  );
};

export default ImagePatterns;