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
    forbiddenBits: 0,
    alternativeForbiddenBits: [],
    requiredAnyBits: 0,
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

const PITCHED = 1 << 24;
const NEUTRAL = 1 << 25;
const packed = (kind, pitches, status) => (kind | (pitches << 8) | status) >>> 0;

test('combines category membership, forbidden pitches and known status', () => {
  const filter = {
    values: new Uint32Array(1), includedValues: 1 << 2,
    forbiddenBits: (~0b101 & 4095) << 8, requiredAnyBits: PITCHED,
  };
  assert.equal(categoricalValueMatches(packed(2, 1, PITCHED), filter), true);
  assert.equal(categoricalValueMatches(packed(2, 5, PITCHED), filter), true);
  assert.equal(categoricalValueMatches(packed(2, 3, PITCHED), filter), false);
  assert.equal(categoricalValueMatches(packed(1, 1, PITCHED), filter), false);
  assert.equal(categoricalValueMatches(packed(2, 0, 0), filter), false);
  assert.equal(categoricalValueMatches(packed(2, 0, NEUTRAL), filter), false);
  assert.equal(categoricalValueMatches(packed(2, 0, NEUTRAL), {
    ...filter, requiredAnyBits: PITCHED | NEUTRAL,
  }), true);
  assert.equal(categoricalValueMatches(packed(2, 0, 0), {
    ...filter, forbiddenBits: 0, requiredAnyBits: 0,
  }), true);
});

test('accepts any complete forbidden-bit alternative without flattening them into a union', () => {
  const filter = {
    values: new Uint32Array(1), includedValues: 1 << 2,
    forbiddenBits: (~0b101 & 4095) << 8,
    alternativeForbiddenBits: [(~0b110 & 4095) << 8],
    requiredAnyBits: PITCHED,
  };
  assert.equal(categoricalValueMatches(packed(2, 0b101, PITCHED), filter), true);
  assert.equal(categoricalValueMatches(packed(2, 0b110, PITCHED), filter), true);
  assert.equal(categoricalValueMatches(packed(2, 0b111, PITCHED), filter), false);
});

test('bit constraints use unsigned 32-bit values including bit 31', () => {
  const filter = { values: new Uint32Array(1), includedValues: 1, requiredAnyBits: -2147483648 };
  assert.equal(normalizeCategoricalFilter(filter).requiredAnyBits, 0x80000000);
  assert.equal(categoricalValueMatches(0x80000000, filter), true);
  assert.equal(categoricalValueMatches(0, filter), false);
  assert.equal(categoricalValueMatches(0x80000000, { ...filter, forbiddenBits: -2147483648 }), false);
  assert.equal(categoricalValueMatches(0x80000000, { ...filter, enabled: false }), true);
});

test('sparse updates preserve all packed bits', () => {
  const attribute = fakeAttribute(2);
  const values = new Uint32Array([packed(2, 4095, PITCHED), 0x80000000]);
  updateCategoricalValueBuffer(attribute, { values }, 2, true);
  values[0] = packed(1, 0, NEUTRAL);
  attribute.ranges = [];
  assert.equal(updateCategoricalValueBuffer(attribute, { values, changedIndices: [0] }, 2), 1);
  assert.deepEqual([...attribute.array], [...values]);
  assert.deepEqual(attribute.ranges, [{ start: 0, count: 1 }]);
});
