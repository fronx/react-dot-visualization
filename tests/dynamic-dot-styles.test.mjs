import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectChangedDynamicStyleIds,
  markAttributeIndicesForUpdate,
  mergeDotStyleMaps,
  resolveLayeredDotStyle,
} from '../src/r3f/dynamicDotStyles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('WebGPU parent does not merge the static map on transient changes', () => {
  const source = readFileSync(
    join(__dirname, '..', 'src', 'r3f', 'DotVisualizationR3F.jsx'),
    'utf8',
  );
  assert.match(
    source,
    /backend === 'webgpu'\s+\? dotStyles\s+: mergeDotStyleMaps\(dotStyles, dynamicDotStyles\)/,
  );
});

test('transient styles overlay static paint without discarding it', () => {
  const base = new Map([['kick', { fill: '#f00', r: 4, opacity: 0.35 }]]);
  const dynamic = new Map([['kick', { opacity: 1, pulse: { duration: 1250 } }]]);

  assert.deepEqual(resolveLayeredDotStyle('kick', base, dynamic), {
    fill: '#f00',
    r: 4,
    opacity: 1,
    pulse: { duration: 1250 },
  });
  assert.deepEqual(mergeDotStyleMaps(base, dynamic), new Map([[
    'kick',
    { fill: '#f00', r: 4, opacity: 1, pulse: { duration: 1250 } },
  ]]));
});

test('audible-owner transition visits only the old and new dots at map scale', () => {
  const count = 275_493;
  const idToIndex = new Map();
  for (let i = 0; i < count; i += 1) idToIndex.set(`s${i}`, i);

  const oldStyle = { opacity: 1, pulse: { duration: 1250 } };
  const newStyle = { opacity: 1, pulse: { duration: 1250 } };
  const previous = new Map([['s17', oldStyle]]);
  const next = new Map([['s275000', newStyle]]);
  const changedIds = collectChangedDynamicStyleIds(previous, next);
  const changedIndices = [...changedIds].map((id) => idToIndex.get(id));

  assert.equal(changedIds.size, 2);
  assert.deepEqual(changedIndices, [17, 275000]);
});

test('paused-state replacement updates one dot and marks exact upload ranges', () => {
  const previous = new Map([['kick', { opacity: 1, pulse: { ringTargetPixels: 42 } }]]);
  const next = new Map([['kick', { opacity: 1, pulse: { ringTargetPixels: 18 } }]]);
  const changed = collectChangedDynamicStyleIds(previous, next);
  assert.deepEqual([...changed], ['kick']);

  const attribute = {
    ranges: [],
    needsUpdate: false,
    addUpdateRange(start, count) {
      this.ranges.push({ start, count });
    },
  };
  assert.equal(markAttributeIndicesForUpdate(attribute, [91], 3), 1);
  assert.deepEqual(attribute.ranges, [{ start: 273, count: 3 }]);
  assert.equal(attribute.needsUpdate, true);
});

test('WebGPU keeps transient changes out of the full-restyle dependency lane', () => {
  const source = readFileSync(
    join(__dirname, '..', 'src', 'r3f', 'R3FDotsWebGPU.jsx'),
    'utf8',
  );
  // `invalidate` (R3F frame scheduling) is the only allowed callback: it
  // requests a paint without re-rendering React, so the transient lane stays
  // out of the full-restyle dependency path.
  assert.match(
    source,
    /usePulseAnimation\(pulseDotStyles, invalidate, false, true\)/,
  );
  assert.match(
    source,
    /collectChangedDynamicStyleIds\(previous, dynamicDotStyles\)/,
  );
  assert.match(
    source,
    /\[rdv-cosmetic\] dynamic changed=\$\{changedIds\.size\} uploaded=\$\{changedIndices\.length\}/,
  );
  assert.match(
    source,
    /\[cosmetic, data, defaultColor, defaultSize, defaultOpacity, dotStyles,\s+radiusOverrides/,
  );
  assert.doesNotMatch(
    source,
    /\[cosmetic, data, defaultColor, defaultSize, defaultOpacity, dotStyles,\s+dynamicDotStyles/,
  );
});
