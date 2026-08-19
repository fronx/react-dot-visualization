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
 * Detect a base-size change on otherwise-identical data: same length, same
 * ids, but a different effective radius (item.size, defaulting like the
 * sim's makeDotSizeFn) beyond the 2-decimal tolerance.
 *
 * Returns 'shrank' if any dot's size decreased (the sim must reseed from raw
 * input — collision is repulsive-only and cannot contract a spread layout),
 * 'grew' if sizes only increased (safe to reseed from on-screen positions),
 * or null when sizes are unchanged or the data isn't comparable (different
 * length or ids — those cases are covered by count/position detection).
 *
 * Tolerance is relative (1% of the larger radius), not the positional
 * 2-decimal rounding: sizes live at ~0.2 world units where an absolute
 * 0.005 window would swallow real changes, and sub-1% radius deltas are
 * not worth a re-simulation.
 */
export const SIZE_CHANGE_TOLERANCE = 0.01;

export function detectDotSizeChange(newData, oldData, defaultSize) {
  if (newData.length !== oldData.length) return null;
  let grew = false;
  for (let i = 0; i < newData.length; i++) {
    const newItem = newData[i];
    const oldItem = oldData[i];
    if (newItem.id !== oldItem.id) return null;
    const newSize = newItem.size || defaultSize;
    const oldSize = oldItem.size || defaultSize;
    if (Math.abs(newSize - oldSize) <= SIZE_CHANGE_TOLERANCE * Math.max(newSize, oldSize)) continue;
    if (newSize < oldSize) return 'shrank';
    grew = true;
  }
  return grew ? 'grew' : null;
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
