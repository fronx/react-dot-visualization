import React, { useState, useMemo, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import DotVisualization from './src/DotVisualization.jsx';

const App = () => {
  const [hoveredDot, setHoveredDot] = useState(null);
  const [clickedDot, setClickedDot] = useState(null);
  const [dotStyles, setDotStyles] = useState(new Map());
  const [containerSize, setContainerSize] = useState({ width: 640, height: 400 });
  const containerRef = useRef(null);

  // Measure container size once
  useEffect(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    }
  }, []);

  // Generate random data that fills the actual container
  const [data, setData] = useState([]);

  useEffect(() => {
    if (containerSize.width > 0) {
      setData(Array.from({ length: 150 }, (_, i) => ({
        id: i,
        x: Math.random() * containerSize.width,
        y: Math.random() * containerSize.height,
        color: `hsl(${Math.random() * 360}, 70%, 50%)`,
        name: `Point ${i}`,
        value: Math.round(Math.random() * 100)
      })));
    }
  }, [containerSize]);

  const handleClick = (item) => {
    setClickedDot(item);
    console.log('Clicked item:', item);

    // Desaturate all other dots
    const newStyles = new Map();
    data.forEach(dot => {
      if (dot.id !== item.id) {
        newStyles.set(dot.id, {
          fill: '#ccc',
          stroke: '#999',
          'stroke-width': '0.5'
        });
      }
    });
    setDotStyles(newStyles);
  };

  const handleBackgroundClick = () => {
    setClickedDot(null);
    console.log('Clicked background - resetting styles');

    // Reset all styles by clearing the map
    setDotStyles(new Map());
  };

  const handleAddDots = () => {
    if (data.length === 0) return;

    // Calculate current bounds
    const bounds = data.reduce((acc, dot) => ({
      minX: Math.min(acc.minX, dot.x),
      minY: Math.min(acc.minY, dot.y),
      maxX: Math.max(acc.maxX, dot.x),
      maxY: Math.max(acc.maxY, dot.y)
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;

    // Generate 7 new dots outside current bounds
    const newDots = Array.from({ length: 7 }, (_, i) => {
      const id = data.length + i;

      // Position outside bounds - extend by 30%
      const extendX = width * 0.3;
      const extendY = height * 0.3;

      return {
        id,
        x: bounds.minX - extendX + Math.random() * (width + 2 * extendX),
        y: bounds.minY - extendY + Math.random() * (height + 2 * extendY),
        color: '#666', // Gray color
        name: `Added Point ${id}`,
        value: Math.round(Math.random() * 100)
      };
    });

    setData(prevData => [...prevData, ...newDots]);
    console.log('Added 7 new dots outside current bounds');
  };

  return (
    <div className="demo">
      <h1>React Dot Visualization Demo</h1>

      <div className="instructions">
        <strong>🎯 Try the new features!</strong><br />
        • <strong>Click a dot:</strong> Desaturates all other dots<br />
        • <strong>Click background:</strong> Resets all styles to original colors<br />
        • <strong>Zoom:</strong> Ctrl/Cmd + mouse wheel (or trackpad pinch)<br />
        • <strong>Pan:</strong> Mouse wheel or trackpad scroll<br />
        • <strong>Hover:</strong> Move mouse over dots<br />
        • <strong>Add Dots:</strong> <button onClick={handleAddDots} style={{ padding: '4px 8px', marginLeft: '8px' }}>Add 7 Gray Dots</button>
      </div>

      <div className="viz" ref={containerRef}>
        <DotVisualization
          data={data}
          onHover={setHoveredDot}
          onLeave={() => setHoveredDot(null)}
          onClick={handleClick}
          onBackgroundClick={handleBackgroundClick}
          dotStyles={dotStyles}
          defaultSize={10}
          margin={0.05}
        />
      </div>

      {hoveredDot && (
        <div className="hover-info">
          {hoveredDot.name}: {hoveredDot.value}<br />
          x: {Math.round(hoveredDot.x * 100) / 100}, y: {Math.round(hoveredDot.y * 100) / 100}
        </div>
      )}
    </div>
  );
};

// Render
const root = createRoot(document.getElementById('root'));
root.render(<App />);