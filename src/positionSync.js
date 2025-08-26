import * as d3 from 'd3';

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