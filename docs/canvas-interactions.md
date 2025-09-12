# Canvas Interactions: Problem and Solution

## Problem Statement

During the migration from SVG to canvas rendering, we need to replace the dual-layer interaction system with an efficient mouse-to-dot collision detection system.

### Current SVG Approach
- **Two layers**: ColoredDots (visual) + InteractionLayer (transparent circles for mouse events)
- **Pros**: Browser handles hit detection automatically
- **Cons**: Duplicates geometry, doesn't scale well, incompatible with canvas rendering

### Canvas Challenge
Canvas is an immediate-mode graphics API with no retained scene graph, so we need to:
1. Track which dots are under the mouse cursor at any given position
2. Handle zoom/pan transformations correctly
3. Maintain performance with thousands of dots
4. Keep the system in sync with the rendering pipeline

## Recommended Solution: Spatial Hash Grid

### Core Strategy
Build a spatial index **during canvas rendering** that maps screen pixel regions to dots. This eliminates duplicate computation and ensures perfect synchronization with the visual representation.

### Implementation Overview

#### 1. Spatial Index Generation
```javascript
const buildSpatialIndex = (transform, canvasWidth, canvasHeight) => {
  const CELL_SIZE = 20; // pixels - tune based on typical dot density
  const spatialGrid = new Map();
  
  data.forEach((item) => {
    const size = getSize(item);
    const radius = size / 2;
    
    // Transform to screen coordinates (same as rendering)
    const screenX = (item.x * transform.k) + transform.x;
    const screenY = (item.y * transform.k) + transform.y;
    const screenRadius = radius * transform.k;
    
    // Add to all overlapping grid cells
    const minCellX = Math.floor((screenX - screenRadius) / CELL_SIZE);
    const maxCellX = Math.floor((screenX + screenRadius) / CELL_SIZE);
    const minCellY = Math.floor((screenY - screenRadius) / CELL_SIZE);
    const maxCellY = Math.floor((screenY + screenRadius) / CELL_SIZE);
    
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const key = `${cellX},${cellY}`;
        if (!spatialGrid.has(key)) spatialGrid.set(key, []);
        spatialGrid.get(key).push({
          item,
          screenX,
          screenY,
          screenRadius
        });
      }
    }
  });
  
  return { spatialGrid, cellSize: CELL_SIZE };
};
```

#### 2. Hit Testing
```javascript
const findDotAtPosition = (mouseX, mouseY, spatialIndex) => {
  const { spatialGrid, cellSize } = spatialIndex;
  const cellX = Math.floor(mouseX / cellSize);
  const cellY = Math.floor(mouseY / cellSize);
  const key = `${cellX},${cellY}`;
  
  const candidates = spatialGrid.get(key) || [];
  
  // Distance-based collision detection
  for (const candidate of candidates) {
    const dx = mouseX - candidate.screenX;
    const dy = mouseY - candidate.screenY;
    const distanceSquared = dx * dx + dy * dy;
    const radiusSquared = candidate.screenRadius * candidate.screenRadius;
    
    if (distanceSquared <= radiusSquared) {
      return candidate.item;
    }
  }
  
  return null;
};
```

#### 3. Integration with Rendering
```javascript
// In ColoredDots.jsx renderDots function
const renderDots = (canvasContext = null, tOverride = null) => {
  const t = tOverride || zoomTransform || { k: 1, x: 0, y: 0 };
  
  if (useCanvas && canvasContext) {
    // Build spatial index during rendering pass
    const spatialIndex = buildSpatialIndex(t, canvasDimensionsRef.current.width, canvasDimensionsRef.current.height);
    
    // Store for mouse event handlers
    canvasRef.current._spatialIndex = spatialIndex;
    
    // Render dots using same transform...
    data.forEach((item, index) => {
      // Canvas rendering code
    });
  }
};
```

#### 4. Mouse Event Handling
```javascript
const handleCanvasMouseMove = (event) => {
  if (!canvasRef.current._spatialIndex) return;
  
  const rect = canvasRef.current.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;
  
  const hitDot = findDotAtPosition(mouseX, mouseY, canvasRef.current._spatialIndex);
  
  if (hitDot !== currentHoveredDot) {
    if (currentHoveredDot && onLeave) onLeave(currentHoveredDot);
    if (hitDot && onHover) onHover(hitDot);
    currentHoveredDot = hitDot;
  }
};
```

## Benefits

### Performance
- **O(1) spatial lookups** instead of O(n) linear searches
- **No duplicate geometry** - single rendering pass builds both visuals and interaction data
- **Efficient memory usage** - only stores references to existing dot objects
- **Scales to thousands of dots** - grid size is independent of dot count

### Accuracy
- **Pixel-perfect hit detection** - uses exact screen coordinates from rendering
- **Zoom/pan aware** - automatically accounts for current viewport transform  
- **Synchronized with visuals** - impossible for interaction and rendering to get out of sync

### Maintainability
- **Single source of truth** - one rendering function handles both visuals and interactions
- **No SVG/Canvas hybrid** - eliminates the complexity of coordinating two rendering systems
- **Extensible** - can easily add features like closest-dot detection, multi-selection, etc.

## Implementation Considerations

### Cell Size Tuning
- **Small cells (10-15px)**: Better for dense dot clusters, higher memory usage
- **Large cells (25-30px)**: Better for sparse layouts, more collision checks per lookup
- **Dynamic sizing**: Could adjust based on average dot size or zoom level

### Handle Edge Cases
- **Overlapping dots**: Return topmost (last rendered) or implement z-order priority
- **Zoom boundaries**: Ensure spatial grid covers visible viewport plus some margin
- **Empty regions**: Grid cells with no dots return empty arrays (fast)

### Memory Management
- **Rebuild on zoom/pan**: Index is lightweight and fast to regenerate
- **Cleanup on unmount**: Clear stored spatial index references
- **Viewport culling**: Only index dots that could potentially be visible

## Files to Modify

1. **`src/ColoredDots.jsx`**: Add spatial index generation to `renderDots()` function
2. **`src/DotVisualization.jsx`**: Update canvas mode to use spatial index for mouse events, remove InteractionLayer conditionally
3. **`src/InteractionLayer.jsx`**: Add canvas interaction mode or skip entirely for canvas rendering

This approach eliminates the dual-layer system while providing more accurate and performant interactions than the current SVG approach.