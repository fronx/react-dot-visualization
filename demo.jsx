import React, { useState, useMemo, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import DotVisualization from './src/DotVisualization.jsx';

const App = () => {
  const [hoveredDot, setHoveredDot] = useState(null);
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
      x: Math.random() * containerSize.width,
      y: Math.random() * containerSize.height,
      name: `Point ${i}`,
      value: Math.round(Math.random() * 100)
    }));
  }, [containerSize]);

  return (
    <div className="demo">
      <h1>React Dot Visualization Demo</h1>

      <div className="instructions">
        <strong>🎯 This works completely out of the box!</strong><br/>
        • <strong>Zoom:</strong> Ctrl/Cmd + mouse wheel (or trackpad pinch)<br/>
        • <strong>Pan:</strong> Mouse wheel or trackpad scroll<br/>
        • <strong>Hover:</strong> Move mouse over dots<br/>
        • No custom zoom handlers needed!
      </div>

      <div className="viz" ref={containerRef}>
        <DotVisualization
          data={data}
          onHover={setHoveredDot}
          onLeave={() => setHoveredDot(null)}
          defaultSize={10}
          margin={0.05} // Optional: smaller margin to fill more of the container
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