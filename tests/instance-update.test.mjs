/**
 * Correctness test for applyDotStylesToInstances.
 *
 * Asserts that the delta path produces byte-identical buffer state to
 * the full path across the per-click cascade (click → neighbours →
 * playing). If this passes, wiring delta into R3FDots is safe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDotStylesToInstances } from '../src/r3f/instanceUpdate.js';

const N = 1024;

function buildData(n) {
  const data = new Array(n);
  for (let i = 0; i < n; i++) {
    data[i] = {
      id: 's' + i,
      x: (i % 64) * 0.7,
      y: ((i / 64) | 0) * 0.7,
      size: 1.0,
      color: '#7c6fff',
    };
  }
  return data;
}

function freshBuffers(n) {
  return {
    matrix: new Float32Array(16 * n),
    color: new Float32Array(3 * n),
    alpha: new Float32Array(n),
    focus: new Float32Array(n),
  };
}

const DEFAULTS = {
  defaultColor: '#7c6fff',
  defaultSize: 1.0,
  defaultOpacity: 1.0,
  hoverOpacity: 1.0,
  hoverSizeMultiplier: 1.5,
};
const EMPTY = new Map();

function buildCascade() {
  const dotStylesClick = new Map();
  dotStylesClick.set('s100', { r: 2.0, opacity: 1, fill: '#ffffff', focusRing: true });
  const radiusOverridesClick = new Map();
  radiusOverridesClick.set('s100', 2.0);

  const dotStylesNeighbours = new Map(dotStylesClick);
  for (let i = 0; i < 20; i++) {
    dotStylesNeighbours.set('s' + (200 + i), { opacity: 1 });
  }

  const dotStylesPlaying = new Map(dotStylesNeighbours);
  const lockedWithPulse = {
    ...dotStylesNeighbours.get('s100'),
    pulse: { duration: 1250, sizeRange: 0.3, ringEffect: true,
      ringTargetPixels: 42, ringMinRatio: 3.0 },
  };
  dotStylesPlaying.set('s100', lockedWithPulse);
  const pulseDotsPlaying = new Map();
  pulseDotsPlaying.set('s100', lockedWithPulse.pulse);

  return {
    initial: { dotStyles: EMPTY, pulseDots: EMPTY, radiusOverrides: EMPTY },
    click: { dotStyles: dotStylesClick, pulseDots: EMPTY, radiusOverrides: radiusOverridesClick },
    neighbours: { dotStyles: dotStylesNeighbours, pulseDots: EMPTY, radiusOverrides: radiusOverridesClick },
    playing: { dotStyles: dotStylesPlaying, pulseDots: pulseDotsPlaying, radiusOverrides: radiusOverridesClick },
  };
}

function runFull(data, cascade) {
  const buffers = freshBuffers(data.length);
  let result;
  for (const phase of [cascade.initial, cascade.click, cascade.neighbours, cascade.playing]) {
    result = applyDotStylesToInstances({
      data, ...phase, defaults: DEFAULTS, hoveredId: null,
      buffers, ringBuffers: null,
    });
  }
  return { buffers, result };
}

function runDelta(data, cascade) {
  const buffers = freshBuffers(data.length);
  let result = applyDotStylesToInstances({
    data, ...cascade.initial, defaults: DEFAULTS, hoveredId: null,
    buffers, ringBuffers: null,
  });
  let prev = {
    data, ...cascade.initial, defaults: DEFAULTS, hoveredId: null,
    dotInfoById: result.dotInfoById,
    dynamicDots: result.dynamicDots,
    dynamicDotsById: result.dynamicDotsById,
  };
  for (const phase of [cascade.click, cascade.neighbours, cascade.playing]) {
    result = applyDotStylesToInstances({
      data, ...phase, defaults: DEFAULTS, hoveredId: null,
      buffers, ringBuffers: null, prev,
    });
    prev = {
      data, ...phase, defaults: DEFAULTS, hoveredId: null,
      dotInfoById: result.dotInfoById,
      dynamicDots: result.dynamicDots,
      dynamicDotsById: result.dynamicDotsById,
    };
  }
  return { buffers, result };
}

function assertFloatArrayEqual(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length mismatch`);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      assert.fail(`${label}: differ at index ${i}: ${actual[i]} vs ${expected[i]}`);
    }
  }
}

test('delta path matches full path byte-for-byte across cascade', () => {
  const data = buildData(N);
  const cascade = buildCascade();

  const full = runFull(data, cascade);
  const delta = runDelta(data, cascade);

  assertFloatArrayEqual(delta.buffers.matrix, full.buffers.matrix, 'matrix');
  assertFloatArrayEqual(delta.buffers.color, full.buffers.color, 'color');
  assertFloatArrayEqual(delta.buffers.alpha, full.buffers.alpha, 'alpha');
  assertFloatArrayEqual(delta.buffers.focus, full.buffers.focus, 'focus');

  assert.equal(delta.result.dotInfoById.size, full.result.dotInfoById.size, 'dotInfoById size');
  for (const [id, fullInfo] of full.result.dotInfoById) {
    const deltaInfo = delta.result.dotInfoById.get(id);
    assert.ok(deltaInfo, `dotInfoById missing id ${id}`);
    assert.equal(deltaInfo.index, fullInfo.index, `${id} index`);
    assert.equal(deltaInfo.x, fullInfo.x, `${id} x`);
    assert.equal(deltaInfo.y, fullInfo.y, `${id} y`);
    assert.equal(deltaInfo.baseScale, fullInfo.baseScale, `${id} baseScale`);
    assert.equal(deltaInfo.baseOpacity, fullInfo.baseOpacity, `${id} baseOpacity`);
    assert.equal(deltaInfo.customOpacity, fullInfo.customOpacity, `${id} customOpacity`);
  }

  assert.equal(delta.result.dynamicDotsById.size, full.result.dynamicDotsById.size, 'dynamicDotsById size');
  for (const [id, fullDyn] of full.result.dynamicDotsById) {
    const deltaDyn = delta.result.dynamicDotsById.get(id);
    assert.ok(deltaDyn, `dynamicDotsById missing id ${id}`);
    assert.equal(deltaDyn.index, fullDyn.index, `${id} dyn index`);
    assert.equal(deltaDyn.baseScale, fullDyn.baseScale, `${id} dyn baseScale`);
    assert.equal(deltaDyn.baseFill, fullDyn.baseFill, `${id} dyn baseFill`);
    assert.equal(deltaDyn.baseOpacity, fullDyn.baseOpacity, `${id} dyn baseOpacity`);
  }
  assert.equal(delta.result.dynamicDots.length, full.result.dynamicDots.length, 'dynamicDots length');
});

test('delta path matches full path with ringBuffers', () => {
  const data = buildData(N);
  const cascade = buildCascade();

  const fullBuffers = freshBuffers(data.length);
  const fullRing = { matrix: new Float32Array(16 * N), color: new Float32Array(3 * N) };
  let fullResult;
  for (const phase of [cascade.initial, cascade.click, cascade.neighbours, cascade.playing]) {
    fullResult = applyDotStylesToInstances({
      data, ...phase, defaults: DEFAULTS, hoveredId: null,
      buffers: fullBuffers, ringBuffers: fullRing,
    });
  }

  const deltaBuffers = freshBuffers(data.length);
  const deltaRing = { matrix: new Float32Array(16 * N), color: new Float32Array(3 * N) };
  let deltaResult = applyDotStylesToInstances({
    data, ...cascade.initial, defaults: DEFAULTS, hoveredId: null,
    buffers: deltaBuffers, ringBuffers: deltaRing,
  });
  let prev = {
    data, ...cascade.initial, defaults: DEFAULTS, hoveredId: null,
    dotInfoById: deltaResult.dotInfoById,
    dynamicDots: deltaResult.dynamicDots,
    dynamicDotsById: deltaResult.dynamicDotsById,
  };
  for (const phase of [cascade.click, cascade.neighbours, cascade.playing]) {
    deltaResult = applyDotStylesToInstances({
      data, ...phase, defaults: DEFAULTS, hoveredId: null,
      buffers: deltaBuffers, ringBuffers: deltaRing, prev,
    });
    prev = {
      data, ...phase, defaults: DEFAULTS, hoveredId: null,
      dotInfoById: deltaResult.dotInfoById,
      dynamicDots: deltaResult.dynamicDots,
      dynamicDotsById: deltaResult.dynamicDotsById,
    };
  }

  assertFloatArrayEqual(deltaRing.color, fullRing.color, 'ringColor');
  // Note: ringMatrix in the delta path is intentionally NOT rewritten
  // (positions unchanged across delta updates). The initial mount full
  // path establishes ring matrices for all dots; delta only updates
  // ringColor. So we compare matrices only for the locked dot's position
  // which was set during initial mount — they should match.
  assertFloatArrayEqual(deltaRing.matrix, fullRing.matrix, 'ringMatrix');
});

test('full path used when data ref changes (positions changed)', () => {
  const data1 = buildData(N);
  const cascade = buildCascade();
  const buffers = freshBuffers(data1.length);

  // Initial mount.
  let result = applyDotStylesToInstances({
    data: data1, ...cascade.click, defaults: DEFAULTS, hoveredId: null,
    buffers, ringBuffers: null,
  });
  const prev = {
    data: data1, ...cascade.click, defaults: DEFAULTS, hoveredId: null,
    dotInfoById: result.dotInfoById,
    dynamicDots: result.dynamicDots,
    dynamicDotsById: result.dynamicDotsById,
  };

  // New data array with shifted positions.
  const data2 = data1.map((d) => ({ ...d, x: d.x + 10, y: d.y + 10 }));
  result = applyDotStylesToInstances({
    data: data2, ...cascade.neighbours, defaults: DEFAULTS, hoveredId: null,
    buffers, ringBuffers: null, prev,
  });

  // Should have rebuilt fully — position columns reflect new x/y.
  // Compare via Float32 round-trip since the buffer is Float32Array.
  const f32 = new Float32Array(1);
  const cast = (v) => { f32[0] = v; return f32[0]; };
  for (let i = 0; i < data2.length; i++) {
    const off = i * 16;
    assert.equal(buffers.matrix[off + 12], cast(data2[i].x), `dot ${i} matrix.x`);
    assert.equal(buffers.matrix[off + 13], cast(-data2[i].y), `dot ${i} matrix.y`);
  }
});
