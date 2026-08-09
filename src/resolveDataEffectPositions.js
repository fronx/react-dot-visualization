/**
 * Pure decision logic extracted from the data effect.
 *
 * Given new data, previous data, cache state, and flags, determines
 * what processedData should be committed. This is the core logic that
 * decides whether to restore decollisioned positions or use raw input.
 *
 * @param {Object} params
 * @param {Array} params.validData - New data with raw positions
 * @param {Array} params.previousData - Data from the previous render (for change detection)
 * @param {boolean} params.positionsAreIntermediate - Whether layout is still running
 * @param {Map|null} params.cachedPositions - Decollisioned positions from cache
 * @param {Array} params.previousProcessedData - Last committed processedData
 * @param {Function} params.hasPositionsChangedFn - Position comparison function
 * @param {boolean} [params.dataIdentityChanged] - The caller's dataKey changed:
 *   this is a different layout, not an edit of the current one
 * @returns {{ processedData: Array, positionsChanged: boolean }}
 */
export function resolveDataEffectPositions({
  validData,
  previousData,
  positionsAreIntermediate,
  cachedPositions,
  previousProcessedData,
  hasPositionsChangedFn,
  dataIdentityChanged = false,
}) {
  // A changed data identity means every previously committed coordinate
  // describes the OUTGOING layout. Restoring them (the cache branch or R9's
  // shrink-hold below) would feed the old constellation to the decollision
  // sim and to zoomToVisible, so the map keeps the old layout and both the
  // auto-fit and a manual Zoom-to-fit frame it until a remount. Callers
  // without a dataKey never set this and keep the behavior below.
  if (dataIdentityChanged) {
    return { processedData: validData, positionsChanged: true };
  }

  const positionsChanged = previousData.length === 0 ||
    hasPositionsChangedFn(validData, previousData);

  let processedData = validData;

  // When positions haven't changed and layout is settled, restore
  // decollisioned positions from cache to prevent snapping to raw UMAP.
  // The hasCache guard preserves the original behavior: without a cache
  // system, raw positions are used (no fallback to previousProcessedData).
  if (!positionsChanged && !positionsAreIntermediate) {
    processedData = restoreDecollisionedPositions(
      validData,
      cachedPositions,
      previousProcessedData,
    );
  }

  // ── R9: Data shrunk — keep on-screen positions, let scheduler animate ──
  // When dots are removed (data shrunk, not positions moved), preserve
  // current decollisioned positions for remaining dots. The scheduler's
  // Trigger 2 will animate the constraint-to-base transition smoothly.
  // Safe for imports: import operations only add dots, never remove them.
  const dataShrunk = positionsChanged && previousData.length > 0
    && validData.length < previousData.length;
  if (dataShrunk && !positionsAreIntermediate) {
    processedData = restoreDecollisionedPositions(
      validData,
      null, // skip cache — fall through to previousProcessedData
      previousProcessedData,
    );
  }

  return { processedData, positionsChanged };
}

/**
 * Restore decollisioned x/y positions onto fresh data items.
 *
 * Priority: cache hit > previous processedData > raw input (no-op).
 * The processedData fallback handles the case where the cache was just
 * cleared (e.g. scopeKey changed) but the underlying positions are unchanged.
 */
export function restoreDecollisionedPositions(validData, cachedPositions, previousProcessedData) {
  if (cachedPositions && cachedPositions.size > 0) {
    return validData.map(item => {
      const pos = cachedPositions.get(item.id);
      return pos ? { ...item, x: pos.x, y: pos.y } : item;
    });
  }
  if (previousProcessedData && previousProcessedData.length > 0) {
    const posMap = new Map(previousProcessedData.map(p => [p.id, p]));
    return validData.map(item => {
      const prev = posMap.get(item.id);
      return prev ? { ...item, x: prev.x, y: prev.y } : item;
    });
  }
  return validData;
}
