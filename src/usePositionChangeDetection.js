import { useCallback } from 'react';

// Helper function to check if two numbers are equal after rounding to 2 decimal places
export const isWithinTolerance = (a, b) => {
  return Math.round(a * 100) === Math.round(b * 100);
};

/**
 * Pure comparison: have any dot positions (x, y) or identities (id) changed?
 * Size changes are intentionally excluded — they are handled by the
 * decollision scheduler's radiusOverrides trigger, not the data effect.
 */
export function hasPositionsChanged(newData, oldData, _defaultSize) {
  if (newData.length !== oldData.length) return true;

  for (let i = 0; i < newData.length; i++) {
    const newItem = newData[i];
    const oldItem = oldData[i];

    if (newItem.id !== oldItem.id ||
      !isWithinTolerance(newItem.x, oldItem.x) ||
      !isWithinTolerance(newItem.y, oldItem.y)) {
      return true;
    }
  }
  return false;
}

/**
 * Hook to detect if positions have changed between data updates
 *
 * @param {number} defaultSize - Default dot size to use for comparison
 * @returns {Function} - hasPositionsChanged(newData, oldData)
 */
export function usePositionChangeDetection(defaultSize) {
  return useCallback((newData, oldData) => {
    return hasPositionsChanged(newData, oldData, defaultSize);
  }, [defaultSize]);
}
