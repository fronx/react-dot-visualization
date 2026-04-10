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
    // Confirm the old function would have returned true for size-only changes
    expect(hasPositionsChangedWithSize(newDataWithSizeChange, previousData)).toBe(true);
  });

  it('FIX: new hasPositionsChanged ignores size changes', () => {
    expect(hasPositionsChanged(newDataWithSizeChange, previousData)).toBe(false);
  });

  it('BUG REPRODUCTION: size-only change overwrites decollisioned positions with raw UMAP', () => {
    // With the old comparison, the data effect skips cache restore
    // and commits raw positions — this is the visual snap the user sees
    const { processedData, positionsChanged } = resolveDataEffectPositions({
      validData: newDataWithSizeChange,
      previousData,
      positionsAreIntermediate: false,
      cachedPositions: decollisionedCache,
      previousProcessedData,
      hasPositionsChangedFn: hasPositionsChangedWithSize,
      hasCache: true,
    });

    expect(positionsChanged).toBe(true);
    // Raw positions committed — decollisioned positions lost!
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
      hasCache: true,
    });

    expect(positionsChanged).toBe(false);
    // Decollisioned positions preserved!
    expect(processedData[0].x).toBe(decollisionedX);
    expect(processedData[0].y).toBe(20.05);
    expect(processedData[1].x).toBe(30.03);
    // Size from the new data is preserved (not overwritten by cache)
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
      hasCache: true,
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
      hasCache: true,
    });

    expect(positionsChanged).toBe(true);
    // New raw positions committed — cache is stale for new layout
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
      hasCache: true,
    });

    // During intermediate, raw positions are used (layout still running)
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
      hasCache: true,
    });

    expect(positionsChanged).toBe(true);
    expect(processedData[0].x).toBe(10.0);
  });
});

describe('resolveDataEffectPositions — hasCache guard prevents stale fallback', () => {
  const dot = (id, x, y, size) => ({ id, x, y, size });

  it('without hasCache, unchanged data falls back to previousProcessedData (stale constraint positions)', () => {
    // After healing animation completes, processedDataRef has base positions.
    // But if hasCache is false/missing, the function should NOT restore from
    // previousProcessedData — it should use raw validData instead.
    const basePositions = [dot('a', 10.0, 20.0, 0.5)];
    const constraintPositions = [dot('a', 12.0, 22.0, 0.5)];

    // hasCache=false: no cache system → use raw positions, don't fall back
    const { processedData } = resolveDataEffectPositions({
      validData: basePositions,
      previousData: basePositions,
      positionsAreIntermediate: false,
      cachedPositions: null,
      previousProcessedData: constraintPositions,
      hasPositionsChangedFn: hasPositionsChanged,
      hasCache: false,
    });

    // Should use raw validData, NOT fall back to stale constraint positions
    expect(processedData[0].x).toBe(10.0);
    expect(processedData[0].x).not.toBe(12.0);
  });

  it('with hasCache, unchanged data restores from previousProcessedData when cache misses', () => {
    const rawPositions = [dot('a', 10.0, 20.0, 0.5)];
    const decollisionedPositions = [dot('a', 10.05, 20.03, 0.5)];

    const { processedData } = resolveDataEffectPositions({
      validData: rawPositions,
      previousData: rawPositions,
      positionsAreIntermediate: false,
      cachedPositions: null,
      previousProcessedData: decollisionedPositions,
      hasPositionsChangedFn: hasPositionsChanged,
      hasCache: true,
    });

    // With cache system present, fallback to previousProcessedData is safe
    expect(processedData[0].x).toBe(10.05);
  });
});
