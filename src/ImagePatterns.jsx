import React from 'react';

const ImagePatterns = ({ data, useImages }) => {
  if (!useImages) return null;

  const renderSvgPattern = (item) => {
    console.log('Creating SVG pattern for item', item.id, 'with svgContent length:', item.svgContent?.length);
    
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
    console.log('Creating bitmap pattern for item', item.id, 'with imageUrl:', item.imageUrl);
    
    return (
      <pattern
        key={`pattern-${item.id}`}
        id={`image-pattern-${item.id}`}
        patternUnits="objectBoundingBox"
        width="1"
        height="1"
      >
        <image
          href={item.imageUrl}
          x="0"
          y="0"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid slice"
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