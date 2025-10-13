import { useState } from 'react';
import { useStableCallback } from './useStableCallback.js';

/**
 * Hook for managing dot hover state and callbacks
 *
 * @param {Function} onHover - Optional callback when hovering over a dot
 * @param {Function} onLeave - Optional callback when leaving a dot
 * @returns {Object} { hoveredDotId, handleDotHover, handleDotLeave, clearHover }
 */
export function useDotHoverHandlers(onHover, onLeave) {
  const [hoveredDotId, setHoveredDotId] = useState(null);

  // Use useStableCallback to prevent recreation during rapid hovering
  const handleDotHover = useStableCallback((item, event) => {
    if (item) {
      setHoveredDotId(prevId => prevId === item.id ? prevId : item.id);
    }
    if (onHover) {
      onHover(item, event);
    }
  });

  const handleDotLeave = useStableCallback((item, event) => {
    setHoveredDotId(null);
    if (onLeave) {
      onLeave(item, event);
    }
  });

  // Clear hover state without triggering callbacks (for internal use like window blur)
  const clearHover = useStableCallback(() => {
    setHoveredDotId(null);
  });

  return {
    hoveredDotId,
    handleDotHover,
    handleDotLeave,
    clearHover
  };
}
