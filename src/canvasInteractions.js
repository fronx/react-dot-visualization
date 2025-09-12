/**
 * Canvas interaction utilities for efficient mouse-to-dot collision detection
 */

/**
 * Build a spatial hash grid for fast collision detection
 * @param {Array} data - Array of dot objects with x, y coordinates
 * @param {Function} getSizeFunc - Function to get dot size: (item) => size
 * @param {Object} transform - Current zoom transform {k, x, y}
 * @param {number} cellSize - Grid cell size in pixels (default: 20)
 * @returns {Object} Spatial index with grid and metadata
 */
export const buildSpatialIndex = (data, getSizeFunc, transform, cellSize = 20) => {
  const spatialGrid = new Map();

  data.forEach((item) => {
    const size = getSizeFunc(item);
    const radius = size / 2;

    // Transform to screen coordinates (same as rendering)
    const screenX = (item.x * transform.k) + transform.x;
    const screenY = (item.y * transform.k) + transform.y;
    const screenRadius = radius * transform.k;

    // Add to all overlapping grid cells
    const minCellX = Math.floor((screenX - screenRadius) / cellSize);
    const maxCellX = Math.floor((screenX + screenRadius) / cellSize);
    const minCellY = Math.floor((screenY - screenRadius) / cellSize);
    const maxCellY = Math.floor((screenY + screenRadius) / cellSize);

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

  return { spatialGrid, cellSize };
};

/**
 * Find dot at mouse position using spatial index
 * @param {number} mouseX - Mouse X coordinate in canvas pixels
 * @param {number} mouseY - Mouse Y coordinate in canvas pixels
 * @param {Object} spatialIndex - Spatial index from buildSpatialIndex
 * @returns {Object|null} Hit dot item or null
 */
export const findDotAtPosition = (mouseX, mouseY, spatialIndex) => {
  if (!spatialIndex) return null;

  const { spatialGrid, cellSize } = spatialIndex;
  const cellX = Math.floor(mouseX / cellSize);
  const cellY = Math.floor(mouseY / cellSize);
  const key = `${cellX},${cellY}`;

  const candidates = spatialGrid.get(key) || [];

  // Test each candidate dot for actual collision
  // Return the last one (topmost in render order)
  let hitDot = null;
  for (const candidate of candidates) {
    const dx = mouseX - candidate.screenX;
    const dy = mouseY - candidate.screenY;
    const distanceSquared = dx * dx + dy * dy;
    const radiusSquared = candidate.screenRadius * candidate.screenRadius;

    if (distanceSquared <= radiusSquared) {
      hitDot = candidate.item;
    }
  }

  return hitDot;
};

/**
 * React hook for canvas mouse interactions
 * @param {Object} config - Configuration object
 * @param {boolean} config.enabled - Whether interactions are enabled
 * @param {boolean} config.isZooming - Whether currently zooming (blocks interactions)
 * @param {Function} config.getSpatialIndex - Function to get current spatial index
 * @param {Function} config.onHover - Hover callback
 * @param {Function} config.onLeave - Leave callback  
 * @param {Function} config.onClick - Click callback
 * @returns {Object} Event handlers for canvas element
 */
export const useCanvasInteractions = (config) => {
  const {
    enabled = false,
    isZooming = false,
    getSpatialIndex,
    onHover,
    onLeave,
    onClick
  } = config;

  const currentHoveredDot = { current: null };

  const handleMouseMove = (event) => {
    if (!enabled || isZooming) return;

    const spatialIndex = getSpatialIndex?.();
    if (!spatialIndex) return;

    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();

    // Get mouse position in CSS pixels (this should match the canvas display size)
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;

    // Debug: log coordinates to understand the offset
    if (Math.random() < 0.02) { // Log occasionally to avoid spam
      const firstDot = spatialIndex.spatialGrid.values().next().value?.[0];
      // console.log('Canvas interaction debug:', {
      //   mouseCSS: { x: cssX, y: cssY },
      //   canvasDisplay: { width: rect.width, height: rect.height },
      //   canvasInternal: { width: canvas.width, height: canvas.height },
      //   firstDotScreen: firstDot ? { x: firstDot.screenX, y: firstDot.screenY } : null,
      //   transform: canvas._spatialIndexTransform
      // });
    }

    // Use CSS coordinates directly - the spatial index should be in screen pixel space
    const hitDot = findDotAtPosition(cssX, cssY, spatialIndex);

    if (hitDot !== currentHoveredDot.current) {
      if (currentHoveredDot.current && onLeave) {
        onLeave(currentHoveredDot.current, event);
      }
      if (hitDot && onHover) {
        onHover(hitDot, event);
      }
      currentHoveredDot.current = hitDot;
    }
  };

  const handleMouseLeave = (event) => {
    if (!enabled) return;
    if (currentHoveredDot.current && onLeave) {
      onLeave(currentHoveredDot.current, event);
    }
    currentHoveredDot.current = null;
  };

  const handleClick = (event) => {
    if (!enabled || isZooming) return;

    const spatialIndex = getSpatialIndex?.();
    if (!spatialIndex) return;

    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();

    // Get mouse position in CSS pixels
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;

    // Use CSS coordinates directly
    const hitDot = findDotAtPosition(cssX, cssY, spatialIndex);

    if (hitDot && onClick) {
      onClick(hitDot, event);
    }
  };

  return {
    onMouseMove: handleMouseMove,
    onMouseLeave: handleMouseLeave,
    onClick: handleClick
  };
};