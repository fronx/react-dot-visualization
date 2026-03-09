import { useState, useCallback, useRef } from 'react';

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
  // Mirror length in a ref so shouldUseStablePositions has a stable identity
  // and doesn't force effects that depend on it to re-run
  const stableLengthRef = useRef(0);

  const updateStablePositions = useCallback((finalData, isIncremental) => {
    stableLengthRef.current = finalData.length;
    setStablePositions([...finalData]);
  }, []);

  const clearStablePositions = useCallback(() => {
    stableLengthRef.current = 0;
    setStablePositions([]);
  }, []);

  // Stable identity — reads length from ref, never changes
  const shouldUseStablePositions = useCallback((isIncrementalUpdate) => {
    return isIncrementalUpdate && stableLengthRef.current > 0;
  }, []);

  return {
    stablePositions,
    updateStablePositions,
    clearStablePositions,
    shouldUseStablePositions
  };
}
