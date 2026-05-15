/**
 * Canvas interaction utilities for efficient mouse-to-dot collision detection.
 *
 * The spatial index lives in DATA-SPACE coordinates (the same frame the
 * caller provides via `item.x` / `item.y`), so it is invariant under any
 * camera transform — pan, zoom, and viewBox changes do not invalidate it,
 * only data changes do. At query time the mouse position (CSS pixels)
 * runs through the inverse zoom transform once to land in the same frame
 * as the index.
 */
import { useRef } from 'react';
import { buildSpatialGrid, queryCell } from './spatialIndex.js';

/**
 * Build a data-space spatial hash grid for hover hit-testing.
 *
 * @param {Array} data - Items with `x`/`y` in data-space coordinates.
 * @param {Function} getSizeFunc - `(item, index) => radius` in data-space units.
 * @param {Object} [options]
 * @param {number} [options.cellSize] - Cell size in data-space units.
 *   Defaults to 4 × mean dot radius — keeps per-cell occupancy bounded
 *   when callers (like fingertip) scale dot radius as ~1/√N. Override
 *   when dot radii vary by more than ~10× across the dataset.
 * @returns {{ grid: Map, cellSize: number }} Spatial index.
 */
export const buildSpatialIndex = (data, getSizeFunc, options = {}) => {
  const entries = new Array(data.length);
  let radiusSum = 0;
  let radiusCount = 0;
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    const radius = getSizeFunc(item, i);
    entries[i] = { item, dataX: item.x, dataY: item.y, dataRadius: radius };
    if (Number.isFinite(radius)) {
      radiusSum += radius;
      radiusCount++;
    }
  }
  const meanRadius = radiusCount > 0 ? radiusSum / radiusCount : 1;
  const cellSize = options.cellSize ?? Math.max(1e-6, 4 * meanRadius);

  return buildSpatialGrid(entries, {
    cellSize,
    // Index at the sensitivity zone (2× radius), not the body. A dot whose
    // hover zone reaches into an adjacent cell is then still returned from
    // that cell's `queryCell` — closing the screen-space-era bug where the
    // index was scoped to body bounds while hits required 2×.
    getBounds: (entry) => {
      const reach = entry.dataRadius * 2;
      return {
        minX: entry.dataX - reach,
        maxX: entry.dataX + reach,
        minY: entry.dataY - reach,
        maxY: entry.dataY + reach,
      };
    },
  });
};

/**
 * Find the dot under a mouse position.
 *
 * @param {number} mouseX - CSS pixels relative to the canvas.
 * @param {number} mouseY - CSS pixels relative to the canvas.
 * @param {{ k: number, x: number, y: number }} transform - The CSS-pixel-space
 *   zoom transform (the same one used to draw the canvas content). Used to
 *   invert the mouse position into data-space.
 * @param {Object} spatialIndex - From `buildSpatialIndex`.
 * @returns {Object|null} The hit `item`, or null.
 */
export const findDotAtPosition = (mouseX, mouseY, transform, spatialIndex) => {
  if (!spatialIndex || !transform) return null;
  const dataX = (mouseX - transform.x) / transform.k;
  const dataY = (mouseY - transform.y) / transform.k;
  const candidates = queryCell(spatialIndex, dataX, dataY);

  let hitDot = null;
  let minDistanceSquared = Infinity;
  for (const candidate of candidates) {
    const dx = dataX - candidate.dataX;
    const dy = dataY - candidate.dataY;
    const distanceSquared = dx * dx + dy * dy;
    const sensitivityRadius = candidate.dataRadius * 2;
    const sensitivityRadiusSquared = sensitivityRadius * sensitivityRadius;

    if (distanceSquared <= sensitivityRadiusSquared && distanceSquared < minDistanceSquared) {
      minDistanceSquared = distanceSquared;
      hitDot = candidate.item;
    }
  }

  return hitDot;
};

/**
 * React hook for canvas mouse interactions.
 *
 * `getTransform` returns the CSS-pixel-space zoom transform — the same
 * frame `findDotAtPosition` inverts to find the data-space mouse point.
 *
 * @param {Object} config - Configuration object
 * @param {boolean} config.enabled - Whether interactions are enabled
 * @param {boolean} config.isZooming - Whether currently zooming (blocks interactions)
 * @param {Function} [config.isInteractionActive] - Getter for the d3-zoom interaction
 *   gate (true during pan/zoom gestures, false 32ms after the last event). Paired
 *   with `blockHoverDuringInteraction`.
 * @param {boolean} [config.blockHoverDuringInteraction] - When true, hover/leave
 *   dispatch is suppressed while `isInteractionActive()` returns true. Lets the
 *   consumer make pan/zoom and hover mutually exclusive — pairs with `gpuPanZoom`
 *   when the host's hover handler is expensive (IPC lookups, deep React cascades)
 *   and would otherwise jankify the gesture. Clicks still dispatch.
 * @param {Function} config.getSpatialIndex - Function to get current spatial index
 * @param {Function} config.getTransform - Function to get current CSS-pixel transform
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
    isInteractionActive = null,
    blockHoverDuringInteraction = false,
    getSpatialIndex,
    getTransform,
    onHover,
    onLeave,
    onClick,
    onBackgroundClick,
    onMouseDown,
    onMouseUp,
    onDoubleClick,
    onContextMenu,
    onDragStart,
    debug = false
  } = config;

  const currentHoveredDot = useRef(null);
  const dragState = useRef(null);

  // Constants for drag detection (from InteractionLayer.jsx)
  const DRAG_THRESHOLD = 5; // pixels

  // Helper function to get mouse position and hit dot
  const getMousePositionAndHit = (event) => {
    if (!enabled) {
      if (debug) {
        console.log('🔍 getMousePositionAndHit: not enabled');
      }
      return { cssX: null, cssY: null, hitDot: null };
    }
    if (isZooming) {
      if (debug) {
        console.log('🔍 getMousePositionAndHit: isZooming=true, blocking');
      }
      return { cssX: null, cssY: null, hitDot: null };
    }

    const spatialIndex = getSpatialIndex?.();
    const transform = getTransform?.();
    if (!spatialIndex || !transform) {
      if (debug) {
        console.log('🔍 getMousePositionAndHit: missing spatialIndex or transform');
      }
      return { cssX: null, cssY: null, hitDot: null };
    }

    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;
    const hitDot = findDotAtPosition(cssX, cssY, transform, spatialIndex);

    return { cssX, cssY, hitDot };
  };

  const handleMouseMove = (event) => {
    // Drag-state tracking must keep running so the click-vs-drag discriminator
    // at mouseup stays correct — independent of the hover gate below.
    if (dragState.current) {
      const deltaX = Math.abs(event.clientX - dragState.current.startX);
      const deltaY = Math.abs(event.clientY - dragState.current.startY);
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (distance > DRAG_THRESHOLD) {
        dragState.current.hasMoved = true;
      }
    }

    // Pan/zoom and hover are mutually exclusive when the consumer opts in.
    // Hover state stays frozen for the duration — no onHover or onLeave fires —
    // so the HUD doesn't blank on gesture start and re-populate on settle.
    if (blockHoverDuringInteraction && isInteractionActive?.()) return;

    const { hitDot } = getMousePositionAndHit(event);
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
