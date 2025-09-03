import React from 'react';

const ImagePatterns = ({ data, useImages }) => {
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

  const renderBitmapPattern = (item) => {
    return (
      <pattern
        key={`pattern-${item.id}`}
        id={`image-pattern-${item.id}`}
        patternUnits="objectBoundingBox"
        patternContentUnits="objectBoundingBox"
        width="1"
        height="1"
      >
        <image
          href={item.imageUrl}
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
        .filter(item => item.svgContent || item.imageUrl)
        .map((item) => {
          if (item.svgContent) {
            return renderSvgPattern(item);
          } else if (item.imageUrl) {
            return renderBitmapPattern(item);
          }
          return null;
        })}
    </defs>
  );
};

export default ImagePatterns;