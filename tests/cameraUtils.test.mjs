import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CAMERA_FOV_DEGREES, classifyWheelGesture, computeZoomOutCapZ } from '../src/r3f/cameraUtils.js';

describe('classifyWheelGesture', () => {
  test('keeps the meta-or-alt default backward compatible', () => {
    assert.equal(classifyWheelGesture({ ctrlKey: false, metaKey: true, altKey: false }), 'scroll-zoom');
    assert.equal(classifyWheelGesture({ ctrlKey: false, metaKey: false, altKey: true }), 'scroll-zoom');
  });

  test('can reserve Option by selecting Command-only scroll zoom', () => {
    assert.equal(classifyWheelGesture({ ctrlKey: false, metaKey: true, altKey: false }, 'meta'), 'scroll-zoom');
    assert.equal(classifyWheelGesture({ ctrlKey: false, metaKey: false, altKey: true }, 'meta'), 'scroll-pan');
  });

  test('always preserves ctrl-key pinch classification', () => {
    assert.equal(classifyWheelGesture({ ctrlKey: true, metaKey: false, altKey: false }, 'meta'), 'pinch');
  });
});

describe('PAN_DRAG_THRESHOLD_PX', () => {
  test('is exported for consumers layering gestures over the canvas', async () => {
    const { PAN_DRAG_THRESHOLD_PX } = await import('../src/r3f/cameraUtils.js');
    assert.equal(PAN_DRAG_THRESHOLD_PX, 4);
  });
});

describe('computeZoomOutCapZ', () => {
  // Live case, 2026-10-03: a 100-dot similarity map (data y -1.4..106.1) in a
  // 1265x666 canvas whose free area is 87..263 px tall once the HUD and an open
  // Sketchboard cover the bottom. The fit asked for z ~3470; a cap measured on
  // the whole canvas stopped the camera at ~1536 and drew the map 2.3x too big.
  const bounds = { minX: -0.3, maxX: 93.1, minY: -1.4, maxY: 106.1 };
  const size = { width: 1265, height: 666 };
  const occlusion = { top: 86, bottom: 404, left: 200, right: 232 };

  test('leaves room for a fit into the visible area', () => {
    assert.ok(computeZoomOutCapZ(bounds, size, occlusion, 0.4) > 3472);
  });

  test('equals the whole-canvas cap when nothing is covered', () => {
    const tan = Math.tan((CAMERA_FOV_DEGREES * Math.PI / 180) / 2);
    const z = computeZoomOutCapZ(bounds, size, {}, 0.4);
    assert.ok(Math.abs(z - (107.5 / 2 / 0.4) / tan) < 1e-6);
  });
});

describe('renderedBounds', () => {
  test('reads a world-convention buffer (y negated) back into data space', async () => {
    const { renderedBounds, padBounds } = await import('../src/utils.js');
    const b = renderedBounds(new Float32Array([1, -5, 3, 20, -2, 0]));
    assert.deepEqual(b, { minX: -2, maxX: 3, minY: -20, maxY: 5 });
    assert.deepEqual(padBounds(b, 1), { minX: -3, maxX: 4, minY: -21, maxY: 6 });
  });
});

describe('R3FCamera OrbitControls', () => {
  // OrbitControls.update() clamps the camera's distance to its target, which is
  // still the origin on the first frame after a placed camera; a cap passed here
  // moved a restored one-dot map's camera ~1300 px off, unreported (2026-10-03).
  // The wheel handler owns the zoom-out cap.
  test('never receives the zoom-out cap as maxDistance', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/r3f/R3FCamera.jsx', import.meta.url), 'utf8');
    assert.match(source, /maxDistance=\{CAMERA_Z_MAX\}/);
    assert.doesNotMatch(source, /maxDistance=\{maxZ\}/);
  });
});
