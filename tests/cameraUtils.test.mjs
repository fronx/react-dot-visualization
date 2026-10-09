import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readFileSync } from 'node:fs';
import {
  CAMERA_FOV_DEGREES, PAN_DRAG_THRESHOLD_PX, cameraForCanvasChange, createPanHandler, capTransformScale, classifyWheelGesture, computeZoomOutCapZ,
  maxScaleForDotRadius, minCameraZForDotRadius,
} from '../src/r3f/cameraUtils.js';
import { padBounds, renderedBounds } from '../src/utils.js';

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
  test('is exported for consumers layering gestures over the canvas', () => {
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

describe('cameraForCanvasChange', () => {
  const tan = Math.tan((CAMERA_FOV_DEGREES * Math.PI / 180) / 2);
  const onScreen = (camera, rect, [wx, wy]) => {
    const pixelsPerUnit = rect.height / (2 * camera.z * tan);
    return [rect.left + rect.width / 2 + (wx - camera.x) * pixelsPerUnit, rect.top + rect.height / 2 - (wy - camera.y) * pixelsPerUnit];
  };
  const camera = { x: 40, y: -30, z: 900 };
  const from = { left: 300, top: 120, width: 1000, height: 700 };
  const dots = [[40, -30], [0, 0], [95, -80], [-20, 15]];
  const assertDotsStay = (to) => {
    const next = cameraForCanvasChange(camera, from, to);
    for (const dot of dots) {
      const [x0, y0] = onScreen(camera, from, dot);
      const [x1, y1] = onScreen(next, to, dot);
      assert.ok(Math.abs(x1 - x0) < 1e-6 && Math.abs(y1 - y0) < 1e-6, `${dot} moved from ${x0},${y0} to ${x1},${y1}`);
    }
  };

  test('dragging the right edge keeps every dot still', () => assertDotsStay({ ...from, width: 1180 }));
  test('dragging the left edge keeps every dot still', () => assertDotsStay({ ...from, left: 220, width: 1080 }));
  test('dragging the bottom edge keeps every dot still and the scale', () => assertDotsStay({ ...from, height: 520 }));
  test('dragging the top edge keeps every dot still and the scale', () => assertDotsStay({ ...from, top: 20, height: 800 }));
  test('dragging a corner keeps every dot still', () => assertDotsStay({ left: 350, top: 120, width: 950, height: 860 }));
  test('a canvas that moves inside its window keeps every dot still', () => assertDotsStay({ ...from, left: 100, width: 1200 }));

  test('an origin shift the size change cannot explain moves dots by at most the size change', () => {
    // The window also moved 400px right since the last reading, unseen; it grew 10px on the right.
    const to = { ...from, left: 700, width: 1010 };
    const next = cameraForCanvasChange(camera, from, to);
    const expected = cameraForCanvasChange(camera, from, { ...from, width: 1010 });
    assert.deepEqual(next, expected);
  });
});

describe('renderedBounds', () => {
  test('reads a world-convention buffer (y negated) back into data space', () => {
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
  test('never receives the zoom-out cap as maxDistance', () => {
    const source = readFileSync(new URL('../src/r3f/R3FCamera.jsx', import.meta.url), 'utf8');
    assert.match(source, /maxDistance=\{CAMERA_Z_MAX\}/);
    assert.doesNotMatch(source, /maxDistance=\{maxZ\}/);
  });
});

describe('dot-size zoom limit', () => {
  test('the closest camera and the largest scale draw the largest dot at the limit', () => {
    const tan = Math.tan((CAMERA_FOV_DEGREES * Math.PI / 180) / 2);
    const z = minCameraZForDotRadius(2, 600, 24);
    assert.ok(Math.abs((2 * 600) / (2 * z * tan) - 24) < 1e-9);
    const k = maxScaleForDotRadius(2, 600, 24);
    assert.ok(Math.abs(2 * k * (600 / 100) - 24) < 1e-9);
    assert.equal(minCameraZForDotRadius(2, 600, null), 0);
    assert.equal(maxScaleForDotRadius(2, 600, null), Infinity);
  });
});

describe('capTransformScale', () => {
  test('zooms out about the centre, leaving a transform under the cap alone', () => {
    const t = { k: 8, x: -300, y: -100 };
    const centre = { x: 60, y: 40 };
    const capped = capTransformScale(t, 2, centre);
    assert.equal(capped.k, 2);
    // The data point under the centre stays under it.
    const atCentre = (tr) => [(centre.x - tr.x) / tr.k, (centre.y - tr.y) / tr.k];
    assert.deepEqual(atCentre(capped), atCentre(t));
    assert.equal(capTransformScale(t, 10, centre), t);
  });
});

describe('createPanHandler', () => {
  const press = (canPan) => {
    const handlers = {};
    const canvas = {
      style: {},
      addEventListener: (type, fn) => { handlers[type] = fn; },
      removeEventListener: () => {},
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
    };
    const calls = { pan: 0, click: 0 };
    createPanHandler({
      canvas, getCameraZ: () => 10, onPan: () => { calls.pan += 1; }, onClick: () => { calls.click += 1; },
      ...(canPan ? { canPan } : {}),
    });
    const at = (x) => ({ button: 0, clientX: x, clientY: 0 });
    return { calls, down: (x) => handlers.mousedown(at(x)), move: (x) => handlers.mousemove(at(x)), up: (x) => handlers.mouseup(at(x)) };
  };

  test('pans a drag and clicks a press that stays put', () => {
    const drag = press();
    drag.down(0); drag.move(PAN_DRAG_THRESHOLD_PX + 10); drag.up(PAN_DRAG_THRESHOLD_PX + 10);
    assert.deepEqual(drag.calls, { pan: 1, click: 0 });
    const click = press();
    click.down(0); click.up(0);
    assert.deepEqual(click.calls, { pan: 0, click: 1 });
  });

  test('canPan false keeps the camera still, and the drag is still no click', () => {
    const drag = press(() => false);
    drag.down(0); drag.move(PAN_DRAG_THRESHOLD_PX + 10); drag.move(PAN_DRAG_THRESHOLD_PX + 40); drag.up(PAN_DRAG_THRESHOLD_PX + 40);
    assert.deepEqual(drag.calls, { pan: 0, click: 0 });
  });
});
