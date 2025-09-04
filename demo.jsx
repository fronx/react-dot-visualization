import React, { useState, useMemo, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import * as jdenticon from 'jdenticon';
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
  const [hoverSizeMultiplier, setHoverSizeMultiplier] = useState(1.5);
  const [hoverOpacity, setHoverOpacity] = useState(1.0);
  const [useImages, setUseImages] = useState(false);
  const [patternType, setPatternType] = useState('normal');
  const [imageMode, setImageMode] = useState('identicons'); // 'identicons' or 'bitmaps'
  const [showHoverImages, setShowHoverImages] = useState(false); // Show hover image switching
  const containerRef = useRef(null);

  // Cache for image providers
  const [imageCache, setImageCache] = useState(new Map());
  const [hoverImageCache, setHoverImageCache] = useState(new Map());

  // Measure container size once
  useEffect(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    }
  }, []);

  // Generate identicon SVG content directly (not as data URI)
  const generateSvgContent = (dotId) => {
    const size = patternType === 'large' ? 64 : 32;
    return jdenticon.toSvg(`dot-${dotId}`, size);
  };

  // Sample bitmap image URLs for demo (in real apps, these would be actual album covers)
  const sampleBitmapUrls = [
    'https://picsum.photos/64/64?random=1',
    'https://picsum.photos/64/64?random=2',
    'https://picsum.photos/64/64?random=3',
    'https://picsum.photos/64/64?random=4',
    'https://picsum.photos/64/64?random=5',
    'https://picsum.photos/64/64?random=6',
    'https://picsum.photos/64/64?random=7',
    'https://picsum.photos/64/64?random=8'
  ];

  const generateBitmapUrl = (dotId) => {
    return sampleBitmapUrls[dotId % sampleBitmapUrls.length];
  };

  // Generate random data that fills the actual container
  const [data, setData] = useState([]);
  const panelWidth = 220;

  useEffect(() => {
    if (containerSize.width > 0) {
      const newData = Array.from({ length: 150 }, (_, i) => ({
        id: i,
        x: Math.random() * containerSize.width,
        y: Math.random() * containerSize.height,
        color: `hsl(${Math.random() * 360}, 70%, 50%)`,
        name: `Point ${i}`,
        value: Math.round(Math.random() * 100),
        // Add individual sizes to some dots for testing
        size: i < 10 ? Math.random() * 20 + 5 : undefined, // first 10 dots have random individual sizes
      }));

      setData(newData);

      // Preload images into cache based on current mode
      const newImageCache = new Map();
      const newHoverCache = new Map();

      newData.forEach(item => {
        if (imageMode === 'identicons') {
          // For identicons, we can generate them synchronously
          newImageCache.set(item.id, `data:image/svg+xml,${encodeURIComponent(generateSvgContent(item.id))}`);
          if (showHoverImages) {
            // Use larger identicon for hover
            const hoverSize = patternType === 'large' ? 128 : 64;
            const hoverSvg = jdenticon.toSvg(`dot-${item.id}`, hoverSize);
            newHoverCache.set(item.id, `data:image/svg+xml,${encodeURIComponent(hoverSvg)}`);
          }
        } else if (imageMode === 'bitmaps') {
          // For bitmaps, use sample URLs
          newImageCache.set(item.id, generateBitmapUrl(item.id));
          if (showHoverImages) {
            // Use higher resolution for hover
            newHoverCache.set(item.id, sampleBitmapUrls[item.id % sampleBitmapUrls.length].replace('64/64', '128/128'));
          }
        }
      });

      setImageCache(newImageCache);
      setHoverImageCache(newHoverCache);
    }
  }, [containerSize, patternType, imageMode, showHoverImages]);

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

    // Update image caches for new dots
    setImageCache(prevCache => {
      const newCache = new Map(prevCache);
      newDots.forEach(dot => {
        if (imageMode === 'identicons') {
          newCache.set(dot.id, `data:image/svg+xml,${encodeURIComponent(generateSvgContent(dot.id))}`);
        } else if (imageMode === 'bitmaps') {
          newCache.set(dot.id, generateBitmapUrl(dot.id));
        }
      });
      return newCache;
    });

    if (showHoverImages) {
      setHoverImageCache(prevCache => {
        const newCache = new Map(prevCache);
        newDots.forEach(dot => {
          if (imageMode === 'identicons') {
            const hoverSize = patternType === 'large' ? 128 : 64;
            const hoverSvg = jdenticon.toSvg(`dot-${dot.id}`, hoverSize);
            newCache.set(dot.id, `data:image/svg+xml,${encodeURIComponent(hoverSvg)}`);
          } else if (imageMode === 'bitmaps') {
            newCache.set(dot.id, sampleBitmapUrls[dot.id % sampleBitmapUrls.length].replace('64/64', '128/128'));
          }
        });
        return newCache;
      });
    }

    console.log('Added 7 new dots outside current bounds');
  };

  // Image provider functions
  const imageProvider = (id) => imageCache.get(id);
  const hoverImageProvider = showHoverImages ? (id) => hoverImageCache.get(id) : undefined;

  return (
    <div className="demo">
      <h1>React Dot Visualization Demo</h1>

      <div className="instructions">
        <strong>🎯 Try the new ImageProvider features!</strong><br />
        • <strong>Performance-Optimized Images:</strong> Images are loaded once via providers, not on every position update<br />
        • <strong>Image Types:</strong> Choose between generated identicons or sample photos<br />
        • <strong>Hover Image Switching:</strong> Enable to show different/higher resolution images on hover<br />
        • <strong>Click a dot:</strong> Desaturates all other dots<br />
        • <strong>Click background:</strong> Resets all styles to original colors<br />
        • <strong>Zoom:</strong> Ctrl/Cmd + mouse wheel (or trackpad pinch)<br />
        • <strong>Pan:</strong> Mouse wheel or trackpad scroll<br />
        • <strong>Add Dots:</strong> Use the button in the left panel (images are automatically cached for new dots)
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
            <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '8px' }}>Visual Settings</div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', marginBottom: '8px' }}>
              <input
                type="checkbox"
                checked={useImages}
                onChange={(e) => setUseImages(e.target.checked)}
              />
              Show Images in Dots
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', marginBottom: '8px' }}>
              <input
                type="checkbox"
                checked={showHoverImages}
                onChange={(e) => setShowHoverImages(e.target.checked)}
                disabled={!useImages}
              />
              Hover Image Switching
            </label>

            <div style={{ fontSize: '11px', marginBottom: '6px' }}>Image Type:</div>
            <select
              value={imageMode}
              onChange={(e) => setImageMode(e.target.value)}
              style={{ width: '100%', padding: '4px', fontSize: '11px', marginBottom: '8px' }}
              disabled={!useImages}
            >
              <option value="identicons">Generated Identicons</option>
              <option value="bitmaps">Sample Photos</option>
            </select>

            <div style={{ fontSize: '11px', marginBottom: '6px' }}>Identicon Size:</div>
            <select
              value={patternType}
              onChange={(e) => setPatternType(e.target.value)}
              style={{ width: '100%', padding: '4px', fontSize: '11px', marginBottom: '8px' }}
              disabled={!useImages || imageMode !== 'identicons'}
            >
              <option value="normal">Normal Size (32px)</option>
              <option value="large">Large Size (64px)</option>
            </select>

            <div style={{ fontSize: '11px', marginBottom: '6px' }}>Size Multiplier: {hoverSizeMultiplier}x</div>
            <input
              type="range"
              value={hoverSizeMultiplier}
              onChange={(e) => setHoverSizeMultiplier(Number(e.target.value))}
              min="1.25"
              max="3"
              step="0.25"
              style={{ width: '100%', marginBottom: '12px' }}
            />

            <div style={{ fontSize: '11px', marginBottom: '6px' }}>Hover Opacity: {hoverOpacity}</div>
            <input
              type="range"
              value={hoverOpacity}
              onChange={(e) => setHoverOpacity(Number(e.target.value))}
              min="0.1"
              max="1.0"
              step="0.1"
              style={{ width: '100%', marginBottom: '12px' }}
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
          hoverSizeMultiplier={hoverSizeMultiplier}
          hoverOpacity={hoverOpacity}
          useImages={useImages}
          imageProvider={imageProvider}
          hoverImageProvider={hoverImageProvider}
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