import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CAMERA_MOVE_MAX_FRAME_MS,
  cameraMoveMode,
  cameraPositionFromTransform,
  createCameraMoveProgress,
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

describe('camera move progress', () => {
  const FRAME_MS = 16;
  const MOVE_MS = 500;

  /** Progress at every frame from `fromMs` on, until the move is complete. */
  function framesUntilDone(progress, fromMs) {
    const seen = [];
    for (let now = fromMs; seen.at(-1) !== 1; now += FRAME_MS) seen.push(progress(now));
    return seen;
  }

  test('follows real time while frames arrive on time', () => {
    const progress = createCameraMoveProgress(1000, MOVE_MS);
    assert.equal(progress(1000 + FRAME_MS), FRAME_MS / MOVE_MS);
    assert.equal(progress(1000 + 2 * FRAME_MS), (2 * FRAME_MS) / MOVE_MS);
    assert.equal(framesUntilDone(progress, 1000 + 3 * FRAME_MS).at(-1), 1);
  });

  test('a stalled main thread delays the move instead of skipping it', () => {
    const progress = createCameraMoveProgress(1000, MOVE_MS);
    progress(1000 + FRAME_MS);
    const afterStall = progress(1000 + FRAME_MS + 700);
    assert.equal(afterStall, (FRAME_MS + CAMERA_MOVE_MAX_FRAME_MS) / MOVE_MS);
    const remaining = framesUntilDone(progress, 1000 + FRAME_MS + 700 + FRAME_MS);
    const visible = remaining.filter((t) => t > 0.2 && t < 0.8);
    assert.ok(visible.length >= 15, `${visible.length} frames between 20% and 80% after the stall`);
  });

  test('a stall before the first frame costs the move no more than the cap', () => {
    const progress = createCameraMoveProgress(1000, MOVE_MS);
    assert.equal(progress(1000 + 690), CAMERA_MOVE_MAX_FRAME_MS / MOVE_MS);
  });

  test('never runs backwards and stays complete', () => {
    const progress = createCameraMoveProgress(1000, MOVE_MS);
    const before = progress(1000 + FRAME_MS);
    assert.equal(progress(1000), before);
    assert.equal(framesUntilDone(progress, 1000 + 2 * FRAME_MS).at(-1), 1);
    assert.equal(progress(1000 + 10_000), 1);
  });
});
