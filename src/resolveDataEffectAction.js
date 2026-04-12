/**
 * Decide how the data effect should handle incoming data.
 *
 * @param {boolean} keepStable - Stable positions exist and key matches (from shouldUseStablePositions)
 * @param {boolean} isIncrementalUpdate - Incremental update (e.g., discovery dots arriving)
 * @param {boolean} hasProcessedData - Whether processedDataRef.current has data
 * @param {boolean} dataGrew - Whether validData.length > processedDataRef.current.length
 * @returns {'hold-stable' | 'hold-incremental' | 'apply' | 'apply-and-clear'}
 */
export function resolveDataEffectAction(keepStable, isIncrementalUpdate, hasProcessedData, dataGrew) {
  if (keepStable) return 'hold-stable';
  if (isIncrementalUpdate && hasProcessedData && dataGrew) return 'hold-incremental';
  if (!isIncrementalUpdate) return 'apply-and-clear';
  return 'apply';
}
