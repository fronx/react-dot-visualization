import { useState, useCallback, useRef } from 'react';

/**
 * Hook to manage stable positions for incremental updates.
 *
 * Stable positions are the final decollisioned positions that we keep rendering
 * during incremental updates while new positions are being calculated in the
 * background.
 *
 * Positions are tagged with the constraint key they were computed for. When the
 * constraint key changes (e.g. focus cleared, discovery removed), the positions
 * are no longer considered stable — the caller should apply new data immediately
 * rather than holding stale positions from a different state.
 */
export function useStablePositions() {
  const [stablePositions, setStablePositions] = useState([]);
  // Mirror length in a ref so shouldUseStablePositions has a stable identity
  // and doesn't force effects that depend on it to re-run
  const stableLengthRef = useRef(0);
  const stableKeyRef = useRef('');

  const updateStablePositions = useCallback((finalData, constraintKey) => {
    stableLengthRef.current = finalData.length;
    stableKeyRef.current = constraintKey ?? '';
    setStablePositions([...finalData]);
  }, []);

  const clearStablePositions = useCallback(() => {
    stableLengthRef.current = 0;
    stableKeyRef.current = '';
    setStablePositions([]);
  }, []);

  // Stable identity — reads from refs, never changes
  const shouldUseStablePositions = useCallback((isIncrementalUpdate, currentConstraintKey, currentDataLength) => {
    if (!isIncrementalUpdate || stableLengthRef.current === 0) return false;
    if (stableKeyRef.current !== (currentConstraintKey ?? '')) return false;
    if (currentDataLength < stableLengthRef.current) return false;
    return true;
  }, []);

  return {
    stablePositions,
    updateStablePositions,
    clearStablePositions,
    shouldUseStablePositions
  };
}
