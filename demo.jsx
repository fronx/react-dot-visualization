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
  const data = useMemo(() => {
    return Array.from({ length: 150 }, (_, i) => ({
      id: i,
      x: Math.random() * containerSize.width,
      y: Math.random() * containerSize.height,
      color: `hsl(${Math.random() * 360}, 70%, 50%)`,
      name: `Point ${i}`,
      value: Math.round(Math.random() * 100)
    }));
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

  return (
    <div className="demo">
      <h1>React Dot Visualization Demo</h1>

      <div className="instructions">
        <strong>🎯 Try the new features!</strong><br/>
        • <strong>Click a dot:</strong> Desaturates all other dots<br/>
        • <strong>Click background:</strong> Resets all styles to original colors<br/>
        • <strong>Zoom:</strong> Ctrl/Cmd + mouse wheel (or trackpad pinch)<br/>
        • <strong>Pan:</strong> Mouse wheel or trackpad scroll<br/>
        • <strong>Hover:</strong> Move mouse over dots
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
          {hoveredDot.name}: {hoveredDot.value}
        </div>
      )}
    </div>
  );
};

// Render
const root = createRoot(document.getElementById('root'));
root.render(<App />);