/**
 * Canvas interaction utilities for efficient mouse-to-dot collision detection
 */
import { useRef } from 'react';

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
    const radius = size;

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
 * @param {Function} config.onBackgroundClick - Background click callback
 * @param {Function} config.onMouseDown - Mouse down callback
 * @param {Function} config.onMouseUp - Mouse up callback
 * @param {Function} config.onDoubleClick - Double click callback
 * @param {Function} config.onContextMenu - Context menu (right click) callback
 * @param {Function} config.onDragStart - Drag start callback
 * @returns {Object} Event handlers for canvas element
 */
export const useCanvasInteractions = (config) => {
  const {
    enabled = false,
    isZooming = false,
    getSpatialIndex,
    onHover,
    onLeave,
    onClick,
    onBackgroundClick,
    onMouseDown,
    onMouseUp,
    onDoubleClick,
    onContextMenu,
    onDragStart
  } = config;

  const currentHoveredDot = useRef(null);
  const dragState = useRef(null);

  // Constants for drag detection (from InteractionLayer.jsx)
  const DRAG_THRESHOLD = 5; // pixels

  // Helper function to get mouse position and hit dot
  const getMousePositionAndHit = (event) => {
    if (!enabled) {
      console.log('🔍 getMousePositionAndHit: not enabled');
      return { cssX: null, cssY: null, hitDot: null };
    }
    if (isZooming) {
      console.log('🔍 getMousePositionAndHit: isZooming=true, blocking');
      return { cssX: null, cssY: null, hitDot: null };
    }

    const spatialIndex = getSpatialIndex?.();
    if (!spatialIndex) {
      console.log('🔍 getMousePositionAndHit: no spatialIndex available');
      return { cssX: null, cssY: null, hitDot: null };
    }

    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;
    const hitDot = findDotAtPosition(cssX, cssY, spatialIndex);

    return { cssX, cssY, hitDot };
  };

  const handleMouseMove = (event) => {
    const { hitDot } = getMousePositionAndHit(event);

    // Handle drag state if we're currently dragging
    if (dragState.current) {
      const deltaX = Math.abs(event.clientX - dragState.current.startX);
      const deltaY = Math.abs(event.clientY - dragState.current.startY);
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (distance > DRAG_THRESHOLD) {
        dragState.current.hasMoved = true;
      }
    }

    // Handle hover state
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
    const { hitDot } = getMousePositionAndHit(event);

    if (hitDot && onClick) {
      onClick(hitDot, event);
    } else if (!hitDot && onBackgroundClick) {
      onBackgroundClick(event);
    }
  };

  const handleMouseDown = (event) => {
    const { hitDot } = getMousePositionAndHit(event);

    if (hitDot) {
      const startTime = Date.now();
      const startX = event.clientX;
      const startY = event.clientY;

      dragState.current = {
        item: hitDot,
        startTime,
        startX,
        startY,
        hasMoved: false
      };

      if (onMouseDown) {
        onMouseDown(hitDot, event);
      }
    }
  };

  const handleMouseUp = (event) => {
    const { hitDot } = getMousePositionAndHit(event);

    if (hitDot && onMouseUp) {
      onMouseUp(hitDot, event);
    }

    // Handle drag end logic
    if (dragState.current) {
      const timeDelta = Date.now() - dragState.current.startTime;
      const deltaX = Math.abs(event.clientX - dragState.current.startX);
      const deltaY = Math.abs(event.clientY - dragState.current.startY);
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      // If it was a drag and we have a drag start handler, simulate drag end
      if (dragState.current.hasMoved && distance > DRAG_THRESHOLD && onDragStart) {
        // Create synthetic drag end event for compatibility with SVG drag system
        const syntheticEvent = {
          ...event,
          type: 'dragend',
          target: event.currentTarget,
          currentTarget: event.currentTarget
        };
        // Note: onDragStart handles the full drag lifecycle in the SVG version
      }

      dragState.current = null;
    }
  };

  const handleDoubleClick = (event) => {
    const { hitDot } = getMousePositionAndHit(event);

    if (hitDot && onDoubleClick) {
      onDoubleClick(hitDot, event);
    }
  };

  const handleContextMenu = (event) => {
    const { hitDot } = getMousePositionAndHit(event);

    if (hitDot && onContextMenu) {
      event.preventDefault(); // Prevent browser context menu
      onContextMenu(hitDot, event);
    }
  };

  return {
    onMouseMove: handleMouseMove,
    onMouseLeave: handleMouseLeave,
    onClick: handleClick,
    onMouseDown: handleMouseDown,
    onMouseUp: handleMouseUp,
    onDoubleClick: handleDoubleClick,
    onContextMenu: handleContextMenu
  };
};