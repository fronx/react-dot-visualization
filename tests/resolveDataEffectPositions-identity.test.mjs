import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDataEffectPositions } from '../src/resolveDataEffectPositions.js';
import { hasPositionsChanged } from '../src/usePositionChangeDetection.js';

// A dataKey change means the incoming data is a different layout, not an edit
// of the current one. Every restoration branch (cache, R9 shrink-hold) must be
// skipped: restoring the outgoing constellation's coordinates feeds them to
// the decollision sim and to zoomToVisible, so the map keeps showing and
// framing the old layout until a remount (wdtdx55qjq, 2026-08-09 — offline
// toggle / drive-disconnect shrink at 272k -> 266k, fit off by dx=13 dk=14%).

const dot = (id, x, y) => ({ id, x, y, size: 0.5 });

test('identity change on a shrink commits the new layout, not the R9 hold', () => {
  const previousData = [dot('a', 1, 2), dot('b', 3, 4), dot('c', 5, 6)];
  const previousProcessed = [dot('a', 1.1, 2.1), dot('b', 3.1, 4.1), dot('c', 5.1, 6.1)];
  const newLayout = [dot('a', 40, 50), dot('b', 60, 70)];

  const { processedData, positionsChanged } = resolveDataEffectPositions({
    validData: newLayout,
    previousData,
    positionsAreIntermediate: false,
    cachedPositions: null,
    previousProcessedData: previousProcessed,
    hasPositionsChangedFn: hasPositionsChanged,
    dataIdentityChanged: true,
  });

  assert.equal(positionsChanged, true);
  assert.equal(processedData[0].x, 40);
  assert.equal(processedData[1].x, 60);
});

test('identity change skips the cache restore even when coordinates match', () => {
  const previousData = [dot('a', 1, 2), dot('b', 3, 4)];
  const cache = new Map([['a', { x: 1.1, y: 2.1 }], ['b', { x: 3.1, y: 4.1 }]]);

  const { processedData } = resolveDataEffectPositions({
    validData: [dot('a', 1, 2), dot('b', 3, 4)],
    previousData,
    positionsAreIntermediate: false,
    cachedPositions: cache,
    previousProcessedData: [dot('a', 1.1, 2.1), dot('b', 3.1, 4.1)],
    hasPositionsChangedFn: hasPositionsChanged,
    dataIdentityChanged: true,
  });

  assert.equal(processedData[0].x, 1);
  assert.equal(processedData[1].x, 3);
});

test('same-identity shrink keeps the R9 on-screen hold', () => {
  const previousData = [dot('a', 1, 2), dot('b', 3, 4), dot('c', 5, 6)];
  const previousProcessed = [dot('a', 1.1, 2.1), dot('b', 3.1, 4.1), dot('c', 5.1, 6.1)];

  const { processedData } = resolveDataEffectPositions({
    validData: [dot('a', 1, 2), dot('b', 3, 4)],
    previousData,
    positionsAreIntermediate: false,
    cachedPositions: null,
    previousProcessedData: previousProcessed,
    hasPositionsChangedFn: hasPositionsChanged,
    dataIdentityChanged: false,
  });

  assert.equal(processedData[0].x, 1.1);
  assert.equal(processedData[1].x, 3.1);
});

test('omitting the flag behaves as same-identity (Canvas callers unchanged)', () => {
  const previousData = [dot('a', 1, 2), dot('b', 3, 4), dot('c', 5, 6)];
  const previousProcessed = [dot('a', 1.1, 2.1), dot('b', 3.1, 4.1), dot('c', 5.1, 6.1)];

  const { processedData } = resolveDataEffectPositions({
    validData: [dot('a', 1, 2), dot('b', 3, 4)],
    previousData,
    positionsAreIntermediate: false,
    cachedPositions: null,
    previousProcessedData: previousProcessed,
    hasPositionsChangedFn: hasPositionsChanged,
  });

  assert.equal(processedData[0].x, 1.1);
});
