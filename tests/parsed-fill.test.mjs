// A dot's fill reaches the colour buffers through parsedFill, which parses each
// distinct CSS string once. It must give the same RGB three's own parse gives,
// for every string form a consumer passes, on the first ask and on every later one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { parsedFill } from '../src/r3f/dotAppearance.js';

const FORMS = ['#6b7280', '#fff', 'rgb(12, 200, 99)', 'hsl(210, 60%, 45%)', 'rebeccapurple'];

test('parsedFill matches three’s parse for each colour form, first and repeated', () => {
  for (const fill of FORMS) {
    const expected = new THREE.Color(fill);
    for (let ask = 0; ask < 2; ask++) {
      const rgb = parsedFill(fill);
      assert.deepEqual([rgb.r, rgb.g, rgb.b], [expected.r, expected.g, expected.b], fill);
    }
  }
});

test('parsedFill stays correct past its bound (a per-dot gradient palette)', () => {
  const grey = (i) => `rgb(${i % 256}, ${(i >> 8) % 256}, 7)`;
  for (let i = 0; i < 40_000; i++) parsedFill(grey(i));
  for (const i of [0, 16_383, 16_384, 39_999]) {
    const expected = new THREE.Color(grey(i));
    const rgb = parsedFill(grey(i));
    assert.deepEqual([rgb.r, rgb.g, rgb.b], [expected.r, expected.g, expected.b], grey(i));
  }
});
