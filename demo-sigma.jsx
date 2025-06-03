import React, { useState, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import DotVisualizationSigma from './src/DotVisualizationSigma.jsx';

const App = () => {
  const [hoveredDot, setHoveredDot] = useState(null);
  const [clickedDot, setClickedDot] = useState(null);
  const [dotStyles, setDotStyles] = useState(new Map());

  // Generate random data in normalized coordinates (Sigma works well with this range)
  const data = useMemo(() => {
    return Array.from({ length: 150 }, (_, i) => ({
      id: i,
      x: (Math.random() - 0.5) * 100, // Range from -50 to 50
      y: (Math.random() - 0.5) * 100, // Range from -50 to 50
      color: `hsl(${Math.random() * 360}, 70%, 50%)`,
      name: `Point ${i}`,
      value: Math.round(Math.random() * 100),
      size: 3 + Math.random() * 7 // Random size between 3-10
    }));
  }, []);

  const handleClick = (item) => {
    setClickedDot(item);
    console.log('Clicked item:', item);
    
    // Desaturate all other dots
    const newStyles = new Map();
    data.forEach(dot => {
      if (dot.id !== item.id) {
        newStyles.set(dot.id, {
          color: '#ccc',
          size: 2
        });
      } else {
        newStyles.set(dot.id, {
          color: item.color,
          size: 15
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
      <h1>React Dot Visualization Sigma Demo</h1>

      <div className="sigma-info">
        <strong>✨ Sigma.js Version!</strong><br/>
        This version uses Sigma.js for WebGL rendering with built-in zoom/pan controls.
        Much simpler code and better performance for large datasets.
      </div>

      <div className="instructions">
        <strong>🎯 Try the features!</strong><br/>
        • <strong>Click a dot:</strong> Highlights selected dot and dims others<br/>
        • <strong>Click background:</strong> Resets all styles to original colors<br/>
        • <strong>Zoom:</strong> Mouse wheel or trackpad pinch (built-in Sigma controls)<br/>
        • <strong>Pan:</strong> Click and drag to pan around<br/>
        • <strong>Hover:</strong> Move mouse over dots
      </div>

      <div className="viz">
        <DotVisualizationSigma
          data={data}
          onHover={setHoveredDot}
          onLeave={() => setHoveredDot(null)}
          onClick={handleClick}
          onBackgroundClick={handleBackgroundClick}
          dotStyles={dotStyles}
          defaultSize={5}
        />
      </div>

      {hoveredDot && (
        <div className="hover-info">
          {hoveredDot.name}: {hoveredDot.value}
        </div>
      )}

      {clickedDot && (
        <div style={{
          position: 'fixed',
          bottom: '20px',
          left: '20px',
          background: 'rgba(0,0,0,0.9)',
          color: 'white',
          padding: '10px',
          borderRadius: '4px',
          fontSize: '12px',
          zIndex: 1000
        }}>
          Selected: {clickedDot.name} (Value: {clickedDot.value})
        </div>
      )}
    </div>
  );
};

// Render
const root = createRoot(document.getElementById('root'));
root.render(<App />);