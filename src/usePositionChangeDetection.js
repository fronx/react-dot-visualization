import { useCallback } from 'react';

// Helper function to check if two numbers are equal after rounding to 2 decimal places
const isWithinTolerance = (a, b) => {
  return Math.round(a * 100) === Math.round(b * 100);
};

/**
 * Hook to detect if positions have changed between data updates
 *
 * @param {number} defaultSize - Default dot size to use for comparison
 * @returns {Function} - hasPositionsChanged(newData, oldData)
 */
export function usePositionChangeDetection(defaultSize) {
  const hasPositionsChanged = useCallback((newData, oldData) => {
    if (newData.length !== oldData.length) return true;

    for (let i = 0; i < newData.length; i++) {
      const newItem = newData[i];
      const oldItem = oldData[i];

      if (newItem.id !== oldItem.id ||
        !isWithinTolerance(newItem.x, oldItem.x) ||
        !isWithinTolerance(newItem.y, oldItem.y) ||
        (newItem.size || defaultSize) !== (oldItem.size || defaultSize)) {
        return true;
      }
    }
    return false;
  }, [defaultSize]);

  return hasPositionsChanged;
}
