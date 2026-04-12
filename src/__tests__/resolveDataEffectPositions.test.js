import { describe, it, expect } from 'vitest';
import { resolveDataEffectPositions } from '../DotVisualization.jsx';
import { hasPositionsChanged } from '../usePositionChangeDetection.js';

const dot = (id, x, y, size) => ({ id, x, y, size });

// Simulates the old hasPositionsChanged that included size in the comparison.
// This was the behavior before the fix.
function hasPositionsChangedWithSize(newData, oldData, defaultSize = 2) {
  if (newData.length !== oldData.length) return true;
  for (let i = 0; i < newData.length; i++) {
    const n = newData[i], o = oldData[i];
    if (n.id !== o.id ||
      Math.round(n.x * 100) !== Math.round(o.x * 100) ||
      Math.round(n.y * 100) !== Math.round(o.y * 100) ||
      (n.size || defaultSize) !== (o.size || defaultSize)) {
      return true;
    }
  }
  return false;
}

describe('resolveDataEffectPositions — size-only change regression', () => {
  // Scenario from the bug: UMAP settles at size 0.1867, decollision runs,
  // then dotRadius:collection-switch restores saved radius 0.1992.
  // The data arrives with same x/y but different size.
  const rawX = 48.1002;
  const decollisionedX = 48.1547;
  const workerSize = 0.1867;
  const savedSize = 0.1992;

  const previousData = [
    dot('a', rawX, 20.0, workerSize),
    dot('b', 30.0, 40.0, workerSize),
  ];

  const newDataWithSizeChange = [
    dot('a', rawX, 20.0, savedSize),
    dot('b', 30.0, 40.0, savedSize),
  ];

  const decollisionedCache = new Map([
    ['a', { x: decollisionedX, y: 20.05 }],
    ['b', { x: 30.03, y: 40.02 }],
  ]);

  const previousProcessedData = [
    dot('a', decollisionedX, 20.05, workerSize),
    dot('b', 30.03, 40.02, workerSize),
  ];

  it('BUG: old hasPositionsChanged treats size-only change as position change', () => {
    expect(hasPositionsChangedWithSize(newDataWithSizeChange, previousData)).toBe(true);
  });

  it('FIX: new hasPositionsChanged ignores size changes', () => {
    expect(hasPositionsChanged(newDataWithSizeChange, previousData)).toBe(false);
  });

  it('BUG REPRODUCTION: size-only change overwrites decollisioned positions with raw UMAP', () => {
    const { processedData, positionsChanged } = resolveDataEffectPositions({
      validData: newDataWithSizeChange,
      previousData,
      positionsAreIntermediate: false,
      cachedPositions: decollisionedCache,
      previousProcessedData,
      hasPositionsChangedFn: hasPositionsChangedWithSize,
    });

    expect(positionsChanged).toBe(true);
    expect(processedData[0].x).toBe(rawX);
    expect(processedData[0].x).not.toBe(decollisionedX);
  });

  it('FIX VERIFIED: size-only change preserves decollisioned positions from cache', () => {
    const { processedData, positionsChanged } = resolveDataEffectPositions({
      validData: newDataWithSizeChange,
      previousData,
      positionsAreIntermediate: false,
      cachedPositions: decollisionedCache,
      previousProcessedData,
      hasPositionsChangedFn: hasPositionsChanged,
    });

    expect(positionsChanged).toBe(false);
    expect(processedData[0].x).toBe(decollisionedX);
    expect(processedData[0].y).toBe(20.05);
    expect(processedData[1].x).toBe(30.03);
    expect(processedData[0].size).toBe(savedSize);
  });

  it('FIX VERIFIED: falls back to previousProcessedData when cache is empty', () => {
    const { processedData } = resolveDataEffectPositions({
      validData: newDataWithSizeChange,
      previousData,
      positionsAreIntermediate: false,
      cachedPositions: null,
      previousProcessedData,
      hasPositionsChangedFn: hasPositionsChanged,
    });

    expect(processedData[0].x).toBe(decollisionedX);
    expect(processedData[0].size).toBe(savedSize);
  });
});

describe('resolveDataEffectPositions — position changes still detected', () => {
  it('actual position change skips cache (correct behavior)', () => {
    const previousData = [dot('a', 10.0, 20.0, 0.5)];
    const newData = [dot('a', 15.0, 25.0, 0.5)];
    const cache = new Map([['a', { x: 12.0, y: 22.0 }]]);

    const { processedData, positionsChanged } = resolveDataEffectPositions({
      validData: newData,
      previousData,
      positionsAreIntermediate: false,
      cachedPositions: cache,
      previousProcessedData: [dot('a', 12.0, 22.0, 0.5)],
      hasPositionsChangedFn: hasPositionsChanged,
    });

    expect(positionsChanged).toBe(true);
    expect(processedData[0].x).toBe(15.0);
    expect(processedData[0].y).toBe(25.0);
  });

  it('intermediate positions skip cache restore (correct behavior)', () => {
    const previousData = [dot('a', 10.0, 20.0, 0.5)];
    const newData = [dot('a', 10.0, 20.0, 0.5)];
    const cache = new Map([['a', { x: 12.0, y: 22.0 }]]);

    const { processedData } = resolveDataEffectPositions({
      validData: newData,
      previousData,
      positionsAreIntermediate: true,
      cachedPositions: cache,
      previousProcessedData: [dot('a', 12.0, 22.0, 0.5)],
      hasPositionsChangedFn: hasPositionsChanged,
    });

    expect(processedData[0].x).toBe(10.0);
  });

  it('first render (empty previousData) uses raw positions', () => {
    const newData = [dot('a', 10.0, 20.0, 0.5)];
    const cache = new Map([['a', { x: 12.0, y: 22.0 }]]);

    const { processedData, positionsChanged } = resolveDataEffectPositions({
      validData: newData,
      previousData: [],
      positionsAreIntermediate: false,
      cachedPositions: cache,
      previousProcessedData: [],
      hasPositionsChangedFn: hasPositionsChanged,
    });

    expect(positionsChanged).toBe(true);
    expect(processedData[0].x).toBe(10.0);
  });
});

describe('resolveDataEffectPositions — R9: data shrunk preserves on-screen positions', () => {
  it('keeps decollisioned positions when dots are removed', () => {
    const previousData = [dot('a', 1, 2), dot('b', 3, 4), dot('c', 5, 6)];
    const previousProcessed = [dot('a', 1.1, 2.1), dot('b', 3.1, 4.1), dot('c', 5.1, 6.1)];
    // dot 'c' removed — data shrunk
    const newData = [dot('a', 1, 2), dot('b', 3, 4)];

    const { processedData } = resolveDataEffectPositions({
      validData: newData,
      previousData,
      positionsAreIntermediate: false,
      cachedPositions: null,
      previousProcessedData: previousProcessed,
      hasPositionsChangedFn: hasPositionsChanged,
    });

    // Remaining dots keep their decollisioned (on-screen) positions
    expect(processedData[0].x).toBe(1.1);
    expect(processedData[0].y).toBe(2.1);
    expect(processedData[1].x).toBe(3.1);
    expect(processedData[1].y).toBe(4.1);
  });

  it('does NOT preserve positions when existing dots moved (import refine)', () => {
    const previousData = [dot('a', 1, 2), dot('b', 3, 4)];
    const previousProcessed = [dot('a', 1.1, 2.1), dot('b', 3.1, 4.1)];
    // Same count, but positions changed — import refine
    const newData = [dot('a', 2, 3), dot('b', 4, 5)];

    const { processedData } = resolveDataEffectPositions({
      validData: newData,
      previousData,
      positionsAreIntermediate: false,
      cachedPositions: null,
      previousProcessedData: previousProcessed,
      hasPositionsChangedFn: hasPositionsChanged,
    });

    // New refined positions committed, not stale decollisioned
    expect(processedData[0].x).toBe(2);
    expect(processedData[1].x).toBe(4);
  });

  it('does NOT preserve positions during intermediate layout', () => {
    const previousData = [dot('a', 1, 2), dot('b', 3, 4), dot('c', 5, 6)];
    const previousProcessed = [dot('a', 1.1, 2.1), dot('b', 3.1, 4.1), dot('c', 5.1, 6.1)];
    const newData = [dot('a', 1, 2), dot('b', 3, 4)];

    const { processedData } = resolveDataEffectPositions({
      validData: newData,
      previousData,
      positionsAreIntermediate: true,
      cachedPositions: null,
      previousProcessedData: previousProcessed,
      hasPositionsChangedFn: hasPositionsChanged,
    });

    // During intermediate layout, raw positions are committed
    expect(processedData[0].x).toBe(1);
    expect(processedData[1].x).toBe(3);
  });
});
