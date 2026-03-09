/**
 * Decide which positions should be used when cancelling an in-flight decollision run.
 *
 * Invariant:
 * - Never re-sync from launch-time snapshot positions.
 * - Only sync from the latest published live transition frame.
 */
export function chooseCancelSyncPositions({ livePositions, snapshotPositions }) {
  // snapshotPositions is intentionally ignored to prevent stale layout re-sync.
  void snapshotPositions;

  if (Array.isArray(livePositions) && livePositions.length > 0) {
    return livePositions;
  }

  return null;
}

/**
 * Decide whether the decollision effect should launch and in which mode.
 *
 * Invariants:
 * - Never launch hidden catch-up while positions are intermediate.
 * - Skip work when decollision is disabled and memoized positions already exist.
 */
export function chooseDecollisionLaunchMode({
  enableDecollisioning,
  positionsAreIntermediate,
  hasMemoizedPositions
}) {
  if (enableDecollisioning) {
    return 'run-active';
  }

  if (positionsAreIntermediate) {
    return 'skip-intermediate';
  }

  if (hasMemoizedPositions) {
    return 'skip-cached';
  }

  return 'run-catchup';
}

/**
 * Decide if new incoming positions should queue another decollision pass.
 *
 * Invariant:
 * - Only queue when a decollision run is currently active and incoming positions changed.
 */
export function shouldQueueDecollisionRetry({
  enableDecollisioning,
  hasActiveSnapshot,
  positionsChanged
}) {
  return Boolean(enableDecollisioning && hasActiveSnapshot && positionsChanged);
}

/**
 * Execute decollision cancellation in a deterministic order and with exclusive outcomes.
 *
 * Outcomes:
 * - `sync-live`: simulation stopped and synced from live positions.
 * - `clear-only`: simulation stopped and decollision refs cleared (no position overwrite).
 * - `noop`: no simulation to cancel.
 */
export function cancelDecollisionWithInvariants({
  simulation,
  debugLog,
  livePositions,
  snapshotPositions,
  syncDecollisionState,
  clearDecollisionState
}) {
  if (!simulation) {
    return 'noop';
  }

  if (typeof debugLog === 'function') {
    debugLog('Cancelling ongoing decollision');
  }

  simulation.stop();

  const positionsToSync = chooseCancelSyncPositions({
    livePositions,
    snapshotPositions
  });

  if (positionsToSync) {
    syncDecollisionState(positionsToSync);
    return 'sync-live';
  }

  clearDecollisionState();
  return 'clear-only';
}
