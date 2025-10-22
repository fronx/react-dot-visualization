import { useState, useCallback } from 'react';

/**
 * Hook to manage stable positions for incremental updates
 *
 * Stable positions are the final decollisioned positions that we keep rendering
 * during incremental updates while new positions are being calculated in the background.
 *
 * @returns {Object} - { stablePositions, updateStablePositions, clearStablePositions, shouldUseStablePositions }
 */
export function useStablePositions() {
  const [stablePositions, setStablePositions] = useState([]);

  const updateStablePositions = useCallback((finalData, isIncremental) => {
    setStablePositions([...finalData]);

    if (isIncremental) {
      console.log('[INCREMENTAL COMPLETE] Saved stable positions', {
        count: finalData.length
      });
    } else {
      console.log('[FULL RENDER COMPLETE] Saved stable positions for future incremental updates', {
        count: finalData.length
      });
    }
  }, []);

  const clearStablePositions = useCallback(() => {
    setStablePositions([]);
  }, []);

  const shouldUseStablePositions = useCallback((isIncrementalUpdate) => {
    return isIncrementalUpdate && stablePositions.length > 0;
  }, [stablePositions.length]);

  return {
    stablePositions,
    updateStablePositions,
    clearStablePositions,
    shouldUseStablePositions
  };
}
