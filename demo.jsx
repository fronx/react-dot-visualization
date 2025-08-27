import React, { useState, useMemo, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import DotVisualization from './src/DotVisualization.jsx';

const App = () => {
  const [hoveredDot, setHoveredDot] = useState(null);
  const [clickedDot, setClickedDot] = useState(null);
  const [dotStyles, setDotStyles] = useState(new Map());
  const [containerSize, setContainerSize] = useState({ width: 640, height: 400 });
  const [autoZoomEnabled, setAutoZoomEnabled] = useState(true);
  const [autoZoomDuration, setAutoZoomDuration] = useState(200);
  const [dotSize, setDotSize] = useState(10);
  const [newDotSize, setNewDotSize] = useState(100);
  const [hoverSizeEnabled, setHoverSizeEnabled] = useState(true);
  const [hoverSizeMultiplier, setHoverSizeMultiplier] = useState(1.5);
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
  const panelWidth = 220;

  useEffect(() => {
    if (containerSize.width > 0) {
      setData(Array.from({ length: 150 }, (_, i) => ({
        id: i,
        x: Math.random() * containerSize.width,
        y: Math.random() * containerSize.height,
        color: `hsl(${Math.random() * 360}, 70%, 50%)`,
        name: `Point ${i}`,
        value: Math.round(Math.random() * 100),
        // Add individual sizes to some dots for testing
        size: i < 10 ? Math.random() * 20 + 5 : undefined // first 10 dots have random individual sizes
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
        value: Math.round(Math.random() * 100),
        size: newDotSize // Use the controlled new dot size
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
        • <strong>Add Dots:</strong> Use the button in the left panel. Set "New Dots Size" slider first (auto-zoom will trigger if enabled)<br />
        • <strong>Dot Sizes:</strong> "Default Size" affects dots without individual sizes. "New Dots Size" controls size of added dots
      </div>

      <div className="viz" ref={containerRef} style={{ position: 'relative', width: '100%', height: '60vh' }}>
        <div
          className="demo-left-panel"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: panelWidth,
            height: '100%',
            background: 'rgba(255,255,255,0.55)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            borderRight: '1px solid rgba(0,0,0,0.06)',
            boxShadow: '2px 0 8px rgba(0,0,0,0.06)',
            zIndex: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 12,
          }}
        >
          <button onClick={handleAddDots} style={{ padding: '6px 10px', cursor: 'pointer' }}>
            + Add 7 Gray Dots
          </button>

          <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid rgba(0,0,0,0.1)' }}>
            <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '8px' }}>Dot Sizes</div>

            <div style={{ fontSize: '11px', marginBottom: '6px' }}>Default Size: {dotSize}</div>
            <input
              type="range"
              value={dotSize}
              onChange={(e) => setDotSize(Number(e.target.value))}
              min="1"
              max="200"
              step="1"
              style={{ width: '100%', marginBottom: '8px' }}
            />
            
            <div style={{ fontSize: '11px', marginBottom: '6px' }}>New Dots Size: {newDotSize}</div>
            <input
              type="range"
              value={newDotSize}
              onChange={(e) => setNewDotSize(Number(e.target.value))}
              min="1"
              max="200"
              step="1"
              style={{ width: '100%', marginBottom: '12px' }}
            />
          </div>

          <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid rgba(0,0,0,0.1)' }}>
            <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '8px' }}>Hover Effects</div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', marginBottom: '8px' }}>
              <input
                type="checkbox"
                checked={hoverSizeEnabled}
                onChange={(e) => setHoverSizeEnabled(e.target.checked)}
              />
              Enable Hover Size
            </label>

            <div style={{ fontSize: '11px', marginBottom: '6px' }}>Size Multiplier: {hoverSizeMultiplier}x</div>
            <input
              type="range"
              value={hoverSizeMultiplier}
              onChange={(e) => setHoverSizeMultiplier(Number(e.target.value))}
              min="1.25"
              max="3"
              step="0.25"
              style={{ width: '100%', marginBottom: '12px' }}
              disabled={!hoverSizeEnabled}
            />
          </div>

          <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid rgba(0,0,0,0.1)' }}>
            <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '8px' }}>Auto-Zoom Settings</div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', marginBottom: '8px' }}>
              <input
                type="checkbox"
                checked={autoZoomEnabled}
                onChange={(e) => setAutoZoomEnabled(e.target.checked)}
              />
              Enable Auto-Zoom
            </label>

            <div style={{ fontSize: '11px', marginBottom: '6px' }}>Duration (ms):</div>
            <input
              type="number"
              value={autoZoomDuration}
              onChange={(e) => setAutoZoomDuration(Number(e.target.value))}
              min="0"
              max="2000"
              step="50"
              style={{ width: '80px', padding: '4px', fontSize: '11px' }}
            />
          </div>
        </div>
        <DotVisualization
          data={data}
          onHover={setHoveredDot}
          onLeave={() => setHoveredDot(null)}
          onClick={handleClick}
          onBackgroundClick={handleBackgroundClick}
          dotStyles={dotStyles}
          defaultSize={dotSize}
          margin={0.05}
          style={{ position: 'absolute', inset: 0 }}
          occludeLeft={panelWidth}
          autoFitToVisible
          fitMargin={0.92}
          autoZoomToNewContent={autoZoomEnabled}
          autoZoomDuration={autoZoomDuration}
          hoverSizeEnabled={hoverSizeEnabled}
          hoverSizeMultiplier={hoverSizeMultiplier}
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