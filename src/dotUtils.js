import * as d3 from 'd3';

/**
 * Shared utilities for dot sizing, positioning, and styling to maintain consistency
 * between ColoredDots and InteractionLayer components
 */

/**
 * Gets the synchronized position for a dot, preferring D3-applied positions over data positions.
 * This ensures visual dots and interaction zones stay aligned during decollision.
 * 
 * @param {Object} item - The data item with original x,y coordinates
 * @param {string} elementId - The DOM element ID to check for D3-applied positions
 * @returns {Object} - Object with { x, y } coordinates to use
 */
export function getSyncedPosition(item, elementId) {
  const element = d3.select(`#${elementId}`);
  
  // Default to data positions
  let x = item.x;
  let y = item.y;
  
  // If element exists and has D3-applied positions, use those instead
  if (!element.empty()) {
    const currentCx = element.attr('cx');
    const currentCy = element.attr('cy');
    
    if (currentCx !== null) x = parseFloat(currentCx);
    if (currentCy !== null) y = parseFloat(currentCy);
  }
  
  return { x, y };
}

/**
 * Gets the synchronized position for an interaction layer dot by checking
 * the corresponding colored dot's position.
 * 
 * @param {Object} item - The data item with original x,y coordinates  
 * @param {Function} dotId - Function to generate element IDs
 * @returns {Object} - Object with { x, y } coordinates to use
 */
export function getSyncedInteractionPosition(item, dotId) {
  const coloredDotId = dotId(0, item); // ColoredDots uses index 0
  return getSyncedPosition(item, coloredDotId);
}

/**
 * Gets the effective size for a dot, checking dotStyles first, then item.size, then defaultSize
 * @param {Object} item - The data item
 * @param {Map} dotStyles - Map of custom styles by item ID
 * @param {number} defaultSize - Default size fallback
 * @returns {number} The effective size for the dot
 */
export function getDotSize(item, dotStyles, defaultSize) {
  // Check if there's a custom size in dotStyles first
  const customStyles = dotStyles.get(item.id);
  if (customStyles && customStyles.r !== undefined) {
    return customStyles.r;
  }
  return item.size || defaultSize;
}

/**
 * Updates dot attributes via D3, ensuring consistent positioning and sizing
 * @param {Object} item - The data item
 * @param {string} elementId - DOM element ID
 * @param {Object} position - {x, y} coordinates
 * @param {number} size - Dot radius
 * @param {Object} additionalAttrs - Additional attributes to apply
 */
export function updateDotAttributes(item, elementId, position, size, additionalAttrs = {}) {
  const element = d3.select(`#${elementId}`);
  
  if (!element.empty()) {
    const baseAttrs = {
      cx: position.x,
      cy: position.y,
      r: size
    };
    
    const allAttrs = { ...baseAttrs, ...additionalAttrs };
    
    Object.entries(allAttrs).forEach(([attr, value]) => {
      element.attr(attr, value);
    });
  }
}

/**
 * Updates colored dot with full styling including custom dotStyles
 * @param {Object} item - The data item
 * @param {string} elementId - DOM element ID
 * @param {Object} position - {x, y} coordinates
 * @param {number} size - Dot radius
 * @param {string} color - Fill color
 * @param {string} stroke - Stroke color
 * @param {number} strokeWidth - Stroke width
 * @param {Map} dotStyles - Custom styles map
 */
export function updateColoredDotAttributes(item, elementId, position, size, color, stroke, strokeWidth, dotStyles) {
  const element = d3.select(`#${elementId}`);
  
  if (!element.empty()) {
    const baseAttrs = {
      r: size,
      cx: position.x,
      cy: position.y,
      fill: color,
      stroke: stroke,
      strokeWidth: strokeWidth,
      filter: '',
      opacity: 0.7,
    };

    const customAttrs = dotStyles.get(item.id) || {};
    const mergedAttrs = { ...baseAttrs, ...customAttrs };

    Object.entries(mergedAttrs).forEach(([attr, value]) => {
      element.attr(attr, value);
    });
  }
}