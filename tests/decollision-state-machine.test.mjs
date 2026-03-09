import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseCancelSyncPositions,
  chooseDecollisionLaunchMode,
  shouldQueueDecollisionRetry,
  cancelDecollisionWithInvariants
} from '../src/decollisionStateMachine.js';

describe('decollision cancel state-machine invariants', () => {
  test('chooseDecollisionLaunchMode skips hidden catch-up for intermediate positions', () => {
    const mode = chooseDecollisionLaunchMode({
      enableDecollisioning: false,
      positionsAreIntermediate: true,
      hasMemoizedPositions: false
    });

    assert.equal(mode, 'skip-intermediate');
  });

  test('chooseDecollisionLaunchMode skips when cache exists and decollision is disabled', () => {
    const mode = chooseDecollisionLaunchMode({
      enableDecollisioning: false,
      positionsAreIntermediate: false,
      hasMemoizedPositions: true
    });

    assert.equal(mode, 'skip-cached');
  });

  test('chooseDecollisionLaunchMode runs catch-up only for stable uncached positions', () => {
    const mode = chooseDecollisionLaunchMode({
      enableDecollisioning: false,
      positionsAreIntermediate: false,
      hasMemoizedPositions: false
    });

    assert.equal(mode, 'run-catchup');
  });

  test('chooseDecollisionLaunchMode runs active decollision when enabled', () => {
    const mode = chooseDecollisionLaunchMode({
      enableDecollisioning: true,
      positionsAreIntermediate: true,
      hasMemoizedPositions: true
    });

    assert.equal(mode, 'run-active');
  });

  test('shouldQueueDecollisionRetry queues only for changed positions during active decollision', () => {
    assert.equal(
      shouldQueueDecollisionRetry({
        enableDecollisioning: true,
        hasActiveSnapshot: true,
        positionsChanged: true
      }),
      true
    );

    assert.equal(
      shouldQueueDecollisionRetry({
        enableDecollisioning: false,
        hasActiveSnapshot: true,
        positionsChanged: true
      }),
      false
    );

    assert.equal(
      shouldQueueDecollisionRetry({
        enableDecollisioning: true,
        hasActiveSnapshot: false,
        positionsChanged: true
      }),
      false
    );

    assert.equal(
      shouldQueueDecollisionRetry({
        enableDecollisioning: true,
        hasActiveSnapshot: true,
        positionsChanged: false
      }),
      false
    );
  });

  test('chooseCancelSyncPositions prefers live positions when both live and snapshot exist', () => {
    const live = [{ id: 'a', x: 10, y: 20 }];
    const snapshot = [{ id: 'a', x: 0, y: 0 }];

    const selected = chooseCancelSyncPositions({
      livePositions: live,
      snapshotPositions: snapshot
    });

    assert.equal(selected, live);
  });

  test('chooseCancelSyncPositions never falls back to snapshot-only data', () => {
    const snapshot = [{ id: 'a', x: 0, y: 0 }];
    const selected = chooseCancelSyncPositions({
      livePositions: null,
      snapshotPositions: snapshot
    });

    assert.equal(selected, null);
  });

  test('cancelDecollisionWithInvariants syncs from live positions and does not clear state', () => {
    let stopCount = 0;
    let clearCount = 0;
    let synced = null;

    const result = cancelDecollisionWithInvariants({
      simulation: { stop: () => { stopCount++; } },
      debugLog: () => {},
      livePositions: [{ id: 'n', x: 1, y: 2 }],
      snapshotPositions: [{ id: 'n', x: 0, y: 0 }],
      syncDecollisionState: (positions) => { synced = positions; },
      clearDecollisionState: () => { clearCount++; }
    });

    assert.equal(result, 'sync-live');
    assert.equal(stopCount, 1);
    assert.equal(clearCount, 0);
    assert.deepEqual(synced, [{ id: 'n', x: 1, y: 2 }]);
  });

  test('cancelDecollisionWithInvariants clears state when no live positions exist', () => {
    let stopCount = 0;
    let clearCount = 0;
    let syncCount = 0;

    const result = cancelDecollisionWithInvariants({
      simulation: { stop: () => { stopCount++; } },
      debugLog: () => {},
      livePositions: null,
      snapshotPositions: [{ id: 'n', x: 0, y: 0 }],
      syncDecollisionState: () => { syncCount++; },
      clearDecollisionState: () => { clearCount++; }
    });

    assert.equal(result, 'clear-only');
    assert.equal(stopCount, 1);
    assert.equal(syncCount, 0);
    assert.equal(clearCount, 1);
  });

  test('cancelDecollisionWithInvariants is noop when no simulation is active', () => {
    let clearCount = 0;
    let syncCount = 0;

    const result = cancelDecollisionWithInvariants({
      simulation: null,
      debugLog: () => {},
      livePositions: [{ id: 'n', x: 1, y: 2 }],
      snapshotPositions: [{ id: 'n', x: 0, y: 0 }],
      syncDecollisionState: () => { syncCount++; },
      clearDecollisionState: () => { clearCount++; }
    });

    assert.equal(result, 'noop');
    assert.equal(syncCount, 0);
    assert.equal(clearCount, 0);
  });
});
