import './tslShims.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Fn, instanceIndex, instancedArray, select, uint, uniform } from 'three/tsl';
import { makeRenderer, readbackU32 } from './tslHeadless.mjs';
import { categoricalMatchNode, categoricalValueMatches } from '../src/r3f/categoricalFilter.js';

test('GPU bit constraints match CPU across uniform-only changes to resident data', async () => {
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
  const uniforms = Object.fromEntries(
    ['includedValues', 'valueMask', 'valueShift', 'forbiddenBits', 'requiredAnyBits']
      .map(key => [`${key}U`, uniform(uint(0))]),
  );
  const kernel = Fn(() => {
    output.element(instanceIndex).assign(select(
      categoricalMatchNode(resident.element(instanceIndex), uniforms), uint(1), uint(0),
    ));
  })().compute(values.length);
  try {
    for (const constraints of [
      { forbiddenBits: (~5 & 4095) << 8, requiredAnyBits: pitched },
      { forbiddenBits: (~5 & 4095) << 8, requiredAnyBits: pitched | neutral },
      { forbiddenBits: 4095 << 8, requiredAnyBits: pitched | neutral },
      { forbiddenBits: 0, requiredAnyBits: 0 },
      { forbiddenBits: 0, requiredAnyBits: 0x80000000 },
      { forbiddenBits: 0x80000000, requiredAnyBits: 0 },
    ]) {
      const input = { values, includedValues: 1 << 2, valueMask: 255, valueShift: 0, ...constraints };
      for (const key of Object.keys(uniforms)) uniforms[key].value = input[key.slice(0, -1)] >>> 0;
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
