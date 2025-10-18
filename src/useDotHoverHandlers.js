import { useState } from 'react';
import { useStableCallback } from './useStableCallback.js';

/**
 * Hook for managing dot hover state and callbacks
 *
 * @param {Function} onHover - Optional callback when hovering over a dot
 * @param {Function} onLeave - Optional callback when leaving a dot
 * @returns {Object} { hoveredDotId, handleDotHover, handleDotLeave, clearHover }
 *
 * Note: When moving the mouse extremely rapidly across many dots (e.g., fast sweeping gestures),
 * React's state update queue can overflow, causing "Maximum update depth exceeded" errors.
 * The guards below (prevId === item.id check) prevent unnecessary state updates, which helps,
 * but cannot prevent the sheer volume of setState calls when hundreds of hover/leave events
 * fire in rapid succession. This is an accepted edge case that doesn't affect normal usage.
 */
export function useDotHoverHandlers(onHover, onLeave) {
  const [hoveredDotId, setHoveredDotId] = useState(null);

  // Use useStableCallback to prevent recreation during rapid hovering
  const handleDotHover = useStableCallback((item, event) => {
    if (item) {
      // Guard: only update state if the hovered dot actually changed
      setHoveredDotId(prevId => prevId === item.id ? prevId : item.id);
    }
    if (onHover) {
      onHover(item, event);
    }
  });

  const handleDotLeave = useStableCallback((item, event) => {
    // Guard: only update state if not already null
    setHoveredDotId(prevId => prevId === null ? prevId : null);
    if (onLeave) {
      onLeave(item, event);
    }
  });

  // Clear hover state without triggering callbacks (for internal use like window blur)
  const clearHover = useStableCallback(() => {
    // Guard: only update state if not already null
    setHoveredDotId(prevId => prevId === null ? prevId : null);
  });

  return {
    hoveredDotId,
    handleDotHover,
    handleDotLeave,
    clearHover
  };
}
