import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hasPositionsChanged, isWithinTolerance, detectDotSizeChange } from '../src/usePositionChangeDetection.js';

describe('isWithinTolerance — rounding-based equality', () => {
  test('identical values → true', () => {
    assert.strictEqual(isWithinTolerance(1.0, 1.0), true);
  });

  test('values within 0.005 tolerance → true', () => {
    assert.strictEqual(isWithinTolerance(1.001, 1.004), true);
  });

  test('values that differ after rounding to 2dp → false', () => {
    assert.strictEqual(isWithinTolerance(1.001, 1.009), false);
  });

  test('large values with small relative difference → true', () => {
    assert.strictEqual(isWithinTolerance(48.1002, 48.1047), true);
  });

  test('zero and near-zero → true', () => {
    assert.strictEqual(isWithinTolerance(0.0, 0.004), true);
  });
});

describe('hasPositionsChanged — detects actual position changes', () => {
  const defaultSize = 2;

  test('identical data → false', () => {
    const data = [
      { id: 'a', x: 10, y: 20, size: 0.5 },
      { id: 'b', x: 30, y: 40, size: 0.5 },
    ];
    assert.strictEqual(hasPositionsChanged(data, data, defaultSize), false);
  });

  test('empty arrays → false', () => {
    assert.strictEqual(hasPositionsChanged([], [], defaultSize), false);
  });

  test('different lengths → true', () => {
    const oldData = [{ id: 'a', x: 1, y: 2 }];
    const newData = [{ id: 'a', x: 1, y: 2 }, { id: 'b', x: 3, y: 4 }];
    assert.strictEqual(hasPositionsChanged(newData, oldData, defaultSize), true);
  });

  test('x position changed → true', () => {
    const oldData = [{ id: 'a', x: 10.0, y: 20.0 }];
    const newData = [{ id: 'a', x: 15.0, y: 20.0 }];
    assert.strictEqual(hasPositionsChanged(newData, oldData, defaultSize), true);
  });

  test('y position changed → true', () => {
    const oldData = [{ id: 'a', x: 10.0, y: 20.0 }];
    const newData = [{ id: 'a', x: 10.0, y: 25.0 }];
    assert.strictEqual(hasPositionsChanged(newData, oldData, defaultSize), true);
  });

  test('id changed → true', () => {
    const oldData = [{ id: 'a', x: 10, y: 20 }];
    const newData = [{ id: 'b', x: 10, y: 20 }];
    assert.strictEqual(hasPositionsChanged(newData, oldData, defaultSize), true);
  });

  test('position change within tolerance → false', () => {
    const oldData = [{ id: 'a', x: 48.1002, y: 20.0 }];
    const newData = [{ id: 'a', x: 48.1040, y: 20.0 }];
    assert.strictEqual(hasPositionsChanged(newData, oldData, defaultSize), false);
  });

  test('old is empty, new has data → true (first render)', () => {
    const newData = [{ id: 'a', x: 10, y: 20 }];
    assert.strictEqual(hasPositionsChanged(newData, [], defaultSize), true);
  });
});

describe('hasPositionsChanged — size changes do NOT count as position changes', () => {
  const defaultSize = 2;

  test('size-only change → false (the bug fix)', () => {
    const oldData = [{ id: 'a', x: 48.1002, y: 20.0, size: 0.1867 }];
    const newData = [{ id: 'a', x: 48.1002, y: 20.0, size: 0.1992 }];
    assert.strictEqual(hasPositionsChanged(newData, oldData, defaultSize), false);
  });

  test('size change from undefined to explicit → false', () => {
    const oldData = [{ id: 'a', x: 10, y: 20 }];
    const newData = [{ id: 'a', x: 10, y: 20, size: 0.5 }];
    assert.strictEqual(hasPositionsChanged(newData, oldData, defaultSize), false);
  });

  test('size change from explicit to undefined → false', () => {
    const oldData = [{ id: 'a', x: 10, y: 20, size: 0.5 }];
    const newData = [{ id: 'a', x: 10, y: 20 }];
    assert.strictEqual(hasPositionsChanged(newData, oldData, defaultSize), false);
  });

  test('size + position change → true (position wins)', () => {
    const oldData = [{ id: 'a', x: 10, y: 20, size: 0.5 }];
    const newData = [{ id: 'a', x: 15, y: 25, size: 0.8 }];
    assert.strictEqual(hasPositionsChanged(newData, oldData, defaultSize), true);
  });

  test('multiple dots with only sizes changed → false', () => {
    const oldData = [
      { id: 'a', x: 10, y: 20, size: 0.1865 },
      { id: 'b', x: 30, y: 40, size: 0.1865 },
      { id: 'c', x: 50, y: 60, size: 0.1865 },
    ];
    const newData = [
      { id: 'a', x: 10, y: 20, size: 0.1992 },
      { id: 'b', x: 30, y: 40, size: 0.1992 },
      { id: 'c', x: 50, y: 60, size: 0.1992 },
    ];
    assert.strictEqual(hasPositionsChanged(newData, oldData, defaultSize), false);
  });
});

describe('detectDotSizeChange — base size guard', () => {
  const defaultSize = 2;
  const dot = (id, x, y, size) => (size === undefined ? { id, x, y } : { id, x, y, size });

  test('identical data → null', () => {
    const data = [dot('a', 10, 20, 0.19), dot('b', 30, 40, 0.19)];
    assert.strictEqual(detectDotSizeChange(data, data.map(d => ({ ...d })), defaultSize), null);
  });

  test('the R11 incident delta (0.1867 → 0.1992) → grew', () => {
    const oldData = [dot('a', 48.1002, 20.0, 0.1867)];
    const newData = [dot('a', 48.1002, 20.0, 0.1992)];
    assert.strictEqual(detectDotSizeChange(newData, oldData, defaultSize), 'grew');
  });

  test('size decrease → shrank', () => {
    const oldData = [dot('a', 10, 20, 0.1992)];
    const newData = [dot('a', 10, 20, 0.1867)];
    assert.strictEqual(detectDotSizeChange(newData, oldData, defaultSize), 'shrank');
  });

  test('any shrink dominates mixed growth (raw reseed needed)', () => {
    const oldData = [dot('a', 10, 20, 0.2), dot('b', 30, 40, 0.2)];
    const newData = [dot('a', 10, 20, 0.3), dot('b', 30, 40, 0.1)];
    assert.strictEqual(detectDotSizeChange(newData, oldData, defaultSize), 'shrank');
  });

  test('sub-1%-relative delta → null (below tolerance)', () => {
    const oldData = [dot('a', 10, 20, 0.2000)];
    const newData = [dot('a', 10, 20, 0.2015)];
    assert.strictEqual(detectDotSizeChange(newData, oldData, defaultSize), null);
  });

  test('just over 1% relative delta → detected', () => {
    const oldData = [dot('a', 10, 20, 0.2000)];
    const newData = [dot('a', 10, 20, 0.2030)];
    assert.strictEqual(detectDotSizeChange(newData, oldData, defaultSize), 'grew');
  });

  test('undefined sizes fall back to defaultSize (matches makeDotSizeFn)', () => {
    const oldData = [dot('a', 10, 20)];
    const newData = [dot('a', 10, 20, 2)];
    assert.strictEqual(detectDotSizeChange(newData, oldData, defaultSize), null);
  });

  test('undefined → smaller explicit size → shrank', () => {
    const oldData = [dot('a', 10, 20)];
    const newData = [dot('a', 10, 20, 0.5)];
    assert.strictEqual(detectDotSizeChange(newData, oldData, defaultSize), 'shrank');
  });

  test('size 0 treated as defaultSize (|| semantics, matches the sim)', () => {
    const oldData = [dot('a', 10, 20, 0)];
    const newData = [dot('a', 10, 20, 2)];
    assert.strictEqual(detectDotSizeChange(newData, oldData, defaultSize), null);
  });

  test('different lengths → null (count detection owns this)', () => {
    const oldData = [dot('a', 10, 20, 0.2)];
    const newData = [dot('a', 10, 20, 0.4), dot('b', 30, 40, 0.4)];
    assert.strictEqual(detectDotSizeChange(newData, oldData, defaultSize), null);
  });

  test('different ids at same index → null (not comparable)', () => {
    const oldData = [dot('a', 10, 20, 0.2)];
    const newData = [dot('b', 10, 20, 0.4)];
    assert.strictEqual(detectDotSizeChange(newData, oldData, defaultSize), null);
  });
});
