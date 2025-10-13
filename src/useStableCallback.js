import { useCallback } from 'react';
import { useLatest } from './useLatest.js';

/**
 * Returns a stable callback reference that always calls the latest version of the function.
 *
 * This is useful for long-running effects (animations, simulations, subscriptions) that need
 * to call callbacks without restarting when those callbacks change.
 *
 * Unlike useCallback, the returned function reference never changes, but it always invokes
 * the most recent version of the provided callback.
 *
 * @param {Function} callback - The callback function to stabilize
 * @returns {Function} A stable function reference that calls the latest callback version
 *
 * @example
 * // Without useStableCallback - effect restarts whenever callback changes:
 * useEffect(() => {
 *   const simulation = startSimulation(onUpdate);
 *   return () => simulation.stop();
 * }, [onUpdate]); // ❌ Restarts simulation when onUpdate changes
 *
 * @example
 * // With useStableCallback - effect never restarts:
 * const stableOnUpdate = useStableCallback(onUpdate);
 * useEffect(() => {
 *   const simulation = startSimulation(stableOnUpdate);
 *   return () => simulation.stop();
 * }, []); // ✅ Simulation runs uninterrupted, but always calls latest onUpdate
 */
export function useStableCallback(callback) {
  const callbackRef = useLatest(callback);

  // Return a stable function that never changes identity
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((...args) => {
    return callbackRef.current?.(...args);
  }, []); // Empty deps - this function reference never changes
}
