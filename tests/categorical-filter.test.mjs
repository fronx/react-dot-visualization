import test from 'node:test';
import assert from 'node:assert/strict';
import {
  categoricalValueMatches,
  makeCategoricalValueBuffer,
  normalizeCategoricalFilter,
  updateCategoricalValueBuffer,
} from '../src/r3f/categoricalFilter.js';

test('extracts a packed category and tests its included-value bit', () => {
  const filter = {
    values: new Uint8Array([0]),
    includedValues: 1 << 2,
    valueMask: 0b11,
    valueShift: 2,
  };
  assert.equal(categoricalValueMatches(0b1001, filter), true);
  assert.equal(categoricalValueMatches(0b0101, filter), false);
  assert.equal(categoricalValueMatches(0b1001, { ...filter, enabled: false }), true);
  assert.equal(categoricalValueMatches(33, { ...filter, valueMask: 0xff, valueShift: 0 }), false);
});

test('normalizes filter uniforms without changing resident values', () => {
  const values = new Uint8Array([1, 2, 3]);
  assert.deepEqual(normalizeCategoricalFilter({
    values,
    includedValues: -1,
    valueMask: 3,
    valueShift: 99,
    dimOpacity: 2,
  }), {
    enabled: true,
    includedValues: 0xffffffff,
    valueMask: 3,
    valueShift: 31,
    dimOpacity: 1,
  });
  assert.deepEqual([...makeCategoricalValueBuffer({ values }, 5)], [1, 2, 3, 0, 0]);
});

function fakeAttribute(length) {
  return {
    array: new Uint32Array(length),
    ranges: [],
    needsUpdate: false,
    addUpdateRange(start, count) { this.ranges.push({ start, count }); },
  };
}

test('uploads resident values once, then applies sparse deltas by index', () => {
  const attribute = fakeAttribute(4);
  const values = new Uint8Array([1, 2, 0, 1]);
  assert.equal(updateCategoricalValueBuffer(attribute, { values }, 4, true), 4);
  assert.deepEqual([...attribute.array], [1, 2, 0, 1]);
  assert.deepEqual(attribute.ranges, [{ start: 0, count: 4 }]);

  attribute.ranges = [];
  attribute.needsUpdate = false;
  values[1] = 1;
  values[3] = 2;
  assert.equal(updateCategoricalValueBuffer(attribute, {
    values,
    changedIndices: new Uint32Array([1, 3]),
  }, 4), 2);
  assert.deepEqual([...attribute.array], [1, 1, 0, 2]);
  assert.deepEqual(attribute.ranges, [
    { start: 1, count: 1 },
    { start: 3, count: 1 },
  ]);
});
