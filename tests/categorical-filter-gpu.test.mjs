import './tslShims.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Fn, instanceIndex, instancedArray, select, uint, uniform } from 'three/tsl';
import { makeRenderer, readbackU32 } from './tslHeadless.mjs';
import {
  MAX_CATEGORICAL_CLAUSES,
  categoricalMatchNode,
  categoricalValueMatches,
} from '../src/r3f/categoricalFilter.js';

test('GPU clause matching matches CPU across uniform-only changes to resident data', async () => {
  const renderer = await makeRenderer();
  const pitched = 1 << 24;
  const neutral = 1 << 25;
  const values = new Uint32Array([
    2 | (1 << 8) | pitched, 2 | (5 << 8) | pitched,
    2 | (3 << 8) | pitched, 1 | (1 << 8) | pitched,
    2, 2 | neutral, 2 | 0x80000000,
  ]);
  const resident = instancedArray(values, 'uint');
  const output = instancedArray(new Uint32Array(values.length), 'uint');
  const uniformKeys = ['includedValues', 'valueMask', 'valueShift', 'clauseCount'];
  for (let i = 0; i < MAX_CATEGORICAL_CLAUSES; i += 1) uniformKeys.push(`clause${i}Clear`, `clause${i}Any`);
  const uniforms = Object.fromEntries(uniformKeys.map(key => [`${key}U`, uniform(uint(0))]));
  const kernel = Fn(() => {
    output.element(instanceIndex).assign(select(
      categoricalMatchNode(resident.element(instanceIndex), uniforms), uint(1), uint(0),
    ));
  })().compute(values.length);
  try {
    for (const clauses of [
      [],
      [{ clear: (~5 & 4095) << 8 }],
      [{ any: pitched | neutral }],
      [
        { clear: (~5 & 4095) << 8, any: pitched },
        { clear: (~6 & 4095) << 8, any: pitched },
        { any: neutral },
      ],
      [{ any: 1 << 0 }, { any: 1 << 1 }, { any: 1 << 2 }, { any: 1 << 3 }, { any: pitched }],
      [{ any: 0x80000000 }],
      [{ clear: 0x80000000 }],
    ]) {
      const input = { values, includedValues: 1 << 2, valueMask: 255, valueShift: 0, clauses };
      const truncated = clauses.slice(0, MAX_CATEGORICAL_CLAUSES);
      uniforms.clauseCountU.value = truncated.length;
      for (let i = 0; i < MAX_CATEGORICAL_CLAUSES; i += 1) {
        uniforms[`clause${i}ClearU`].value = (truncated[i]?.clear ?? 0) >>> 0;
        uniforms[`clause${i}AnyU`].value = (truncated[i]?.any ?? 0) >>> 0;
      }
      uniforms.includedValuesU.value = input.includedValues >>> 0;
      uniforms.valueMaskU.value = input.valueMask >>> 0;
      uniforms.valueShiftU.value = input.valueShift >>> 0;
      await renderer.computeAsync(kernel);
      assert.deepEqual([...await readbackU32(renderer, output)],
        [...values].map(value => Number(categoricalValueMatches(value, input))));
    }
  } finally {
    kernel.dispose();
    // Dawn's external device retains its event loop after renderer disposal.
    const device = renderer.backend?.device;
    renderer.dispose();
    device?.destroy();
  }
});
