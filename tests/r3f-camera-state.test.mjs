import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  cameraMoveMode,
  cameraPositionFromTransform,
  isFiniteCameraPosition,
  resolveInitialCameraPosition,
} from '../src/r3f/cameraState.js';

const DATA = [
  { id: 'a', x: -2, y: -1 },
  { id: 'b', x: 4, y: 3 },
];

describe('R3F camera validity', () => {
  test('waits for a drawable viewport instead of manufacturing a non-finite initial camera', () => {
    const initialTransform = { x: 10, y: 20, k: 0.8 };
    assert.equal(resolveInitialCameraPosition({
      data: DATA,
      size: { width: 0, height: 0 },
      initialTransform,
    }), null);

    const ready = resolveInitialCameraPosition({
      data: DATA,
      size: { width: 800, height: 600 },
      initialTransform,
    });
    assert.equal(isFiniteCameraPosition(ready), true);
  });

  test('ignores a corrupt saved transform and uses the finite fit target', () => {
    const fit = { x: 3, y: -4, z: 50 };
    assert.deepEqual(resolveInitialCameraPosition({
      data: DATA,
      size: { width: 800, height: 600 },
      initialTransform: { x: Number.NaN, y: 0, k: 1 },
      computeFitTarget: () => fit,
    }), fit);
  });

  test('rejects invalid transform conversion inputs', () => {
    assert.equal(cameraPositionFromTransform(
      { x: 0, y: 0, k: 1 },
      { width: 800, height: 0 },
    ), null);
    assert.equal(cameraPositionFromTransform(
      { x: 0, y: 0, k: Number.NaN },
      { width: 800, height: 600 },
    ), null);
  });

  test('snaps a valid fit target when the animation start camera is corrupt', () => {
    const target = { x: 3, y: -4, z: 50 };
    assert.equal(cameraMoveMode({
      start: { x: Number.NaN, y: Number.NaN, z: Number.NaN },
      target,
      duration: 500,
    }), 'instant');
    assert.equal(cameraMoveMode({ start: target, target, duration: 500 }), 'animate');
    assert.equal(cameraMoveMode({
      start: target,
      target: { x: Number.NaN, y: 0, z: 50 },
      duration: 500,
    }), 'reject');
  });
});
