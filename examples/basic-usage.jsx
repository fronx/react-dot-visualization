import React, { useState } from 'react';
import { DotVisualization } from '../src';

// Example data - replace with your own
const generateSampleData = (count = 100) => {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    x: Math.random() * 1000,
    y: Math.random() * 1000,
    size: Math.random() * 5 + 2,
    color: `hsl(${Math.random() * 360}, 70%, 50%)`,
    // Custom data for your application
    name: `Point ${i}`,
    value: Math.random() * 100
  }));
};

const BasicExample = () => {
  const [hoveredItem, setHoveredItem] = useState(null);
  const [clickedItem, setClickedItem] = useState(null);
  const [dotStyles, setDotStyles] = useState(new Map());
  const data = generateSampleData(150);

  const handleHover = (item, event) => {
    setHoveredItem(item);
    // Highlight hovered dot
    setDotStyles(prev => new Map(prev).set(item.id, {
      fill: 'red',
      stroke: '#333',
      'stroke-width': '2'
    }));
  };

  const handleLeave = (item, event) => {
    setHoveredItem(null);
    // Remove highlight
    setDotStyles(prev => {
      const newStyles = new Map(prev);
      newStyles.delete(item.id);
      return newStyles;
    });
  };

  const handleClick = (item, event) => {
    setClickedItem(item);
    console.log('Clicked item:', item);
  };

  const handleBackgroundClick = (event) => {
    setClickedItem(null);
    console.log('Clicked background');
  };

  const handleZoomStart = () => {
    console.log('Zoom started');
  };

  const handleZoomEnd = () => {
    console.log('Zoom ended');
  };

  return (
    <div style={{ width: '100%', height: '600px', position: 'relative' }}>
      <DotVisualization
        data={data}
        onHover={handleHover}
        onLeave={handleLeave}
        onClick={handleClick}
        onBackgroundClick={handleBackgroundClick}
        onZoomStart={handleZoomStart}
        onZoomEnd={handleZoomEnd}
        enableCollisionDetection={true}
        zoomExtent={[0.5, 20]}
        margin={0.3}
        dotStroke="#333"
        dotStrokeWidth={0.5}
        dotStyles={dotStyles}
        style={{ border: '1px solid #ccc' }}
      />
      
      {/* Display hovered item info */}
      {hoveredItem && (
        <div
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            background: 'rgba(0,0,0,0.8)',
            color: 'white',
            padding: '8px',
            borderRadius: '4px',
            fontSize: '12px'
          }}
        >
          <div><strong>{hoveredItem.name}</strong></div>
          <div>Value: {hoveredItem.value.toFixed(2)}</div>
          <div>Position: ({hoveredItem.x.toFixed(1)}, {hoveredItem.y.toFixed(1)})</div>
        </div>
      )}

      {/* Display clicked item info */}
      {clickedItem && (
        <div
          style={{
            position: 'absolute',
            bottom: 10,
            left: 10,
            background: 'rgba(0,100,200,0.9)',
            color: 'white',
            padding: '12px',
            borderRadius: '4px',
            fontSize: '14px'
          }}
        >
          <div><strong>Selected: {clickedItem.name}</strong></div>
          <div>Value: {clickedItem.value.toFixed(2)}</div>
          <button
            onClick={() => setClickedItem(null)}
            style={{
              marginTop: '8px',
              background: 'transparent',
              border: '1px solid white',
              color: 'white',
              padding: '4px 8px',
              borderRadius: '2px',
              cursor: 'pointer'
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
};

export default BasicExample;