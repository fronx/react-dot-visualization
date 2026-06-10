/**
 * Pure-logic tests for the keyframe-chain player (src/r3f/keyframePlayer.js):
 * easing resolution, the global-clock → segment/fraction mapping, and the
 * CPU-side driver behavior (segment-boundary buffer writes, t-uniform values,
 * done timing) against fake buffers + a recording `gl`. The GPU half — real
 * kernels, real readbacks — lives in tests/keyframes-webgpu.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { easeCubicOut, easeCubicInOut } from 'd3';
import {
  resolveKeyframeEasing, keyframePhase, createKeyframePlayer,
} from '../src/r3f/keyframePlayer.js';

test('resolveKeyframeEasing: named easings resolve; unknown/missing fall back to linear', () => {
  assert.equal(resolveKeyframeEasing('linear')(0.3), 0.3);
  assert.equal(resolveKeyframeEasing('ease-out')(0.5), easeCubicOut(0.5));
  assert.equal(resolveKeyframeEasing('ease-in-out')(0.5), easeCubicInOut(0.5));
  assert.equal(resolveKeyframeEasing(undefined)(0.7), 0.7);
  assert.equal(resolveKeyframeEasing('bounce')(0.7), 0.7);
});

test('keyframePhase maps the eased clock to segment index + local fraction', () => {
  assert.deepEqual(keyframePhase(0, 3), { segment: 0, fraction: 0 });
  assert.deepEqual(keyframePhase(0.5, 3), { segment: 1, fraction: 0.5 });
  assert.deepEqual(keyframePhase(0.5, 2), { segment: 1, fraction: 0 });
  // At e=1 the index clamps to the last segment with fraction exactly 1, so
  // the final mix dispatch lands bit-equal on the last keyframe.
  assert.deepEqual(keyframePhase(1, 3), { segment: 2, fraction: 1 });
  assert.deepEqual(keyframePhase(1, 1), { segment: 0, fraction: 1 });
});

function fakeAttr(n) {
  return { value: { array: new Float32Array(n), needsUpdate: false } };
}

function makeFakeHarness(N) {
  const buffers = { N, fromPos: fakeAttr(N * 2), targetPos: fakeAttr(N * 2) };
  const dispatches = [];
  const tU = { value: 0 };
  const mixKernel = { name: 'mix' };
  const gl = { compute(node) { dispatches.push({ node, t: tU.value }); } };
  return { buffers, dispatches, tU, mixKernel, gl };
}

function frame(N, fill) {
  const f = new Float32Array(N * 2);
  f.fill(fill);
  return f;
}

test('chain driver: one segment load per boundary, one mix dispatch per step, done at the t=1 step', () => {
  const N = 2;
  const { buffers, dispatches, tU, mixKernel, gl } = makeFakeHarness(N);
  const frames = [frame(N, 1), frame(N, 2), frame(N, 3)]; // 2 segments
  const player = createKeyframePlayer({
    gl, buffers, mixKernel, tU, frames, duration: 100, easing: 'linear', startMs: 1000,
  });

  // t=0 → segment 0 loaded (frames[0]→frames[1]), fraction 0.
  assert.equal(player.step(1000), false);
  assert.deepEqual(Array.from(buffers.fromPos.value.array), Array.from(frames[0]));
  assert.deepEqual(Array.from(buffers.targetPos.value.array), Array.from(frames[1]));
  assert.equal(buffers.fromPos.value.needsUpdate, true);
  assert.equal(dispatches.at(-1).t, 0);

  // t=0.25 → still segment 0, fraction 0.5; no re-write of the segment buffers.
  buffers.fromPos.value.needsUpdate = false;
  buffers.targetPos.value.needsUpdate = false;
  assert.equal(player.step(1025), false);
  assert.equal(buffers.fromPos.value.needsUpdate, false);
  assert.equal(buffers.targetPos.value.needsUpdate, false);
  assert.equal(dispatches.at(-1).t, 0.5);

  // t=0.75 → segment 1 (frames[1]→frames[2]), fraction 0.5.
  assert.equal(player.step(1075), false);
  assert.deepEqual(Array.from(buffers.fromPos.value.array), Array.from(frames[1]));
  assert.deepEqual(Array.from(buffers.targetPos.value.array), Array.from(frames[2]));
  assert.equal(dispatches.at(-1).t, 0.5);

  // t=1 → done, final dispatch at fraction exactly 1 on the last segment.
  assert.equal(player.step(1100), true);
  assert.equal(dispatches.at(-1).t, 1);
  assert.deepEqual(Array.from(buffers.targetPos.value.array), Array.from(frames[2]));
  assert.equal(dispatches.length, 4); // exactly one mix dispatch per step
  assert.ok(dispatches.every((d) => d.node === mixKernel));
});

test('chain driver: stepping at a fixed cadence completes within one frame of the requested duration', () => {
  const N = 1;
  const { buffers, tU, mixKernel, gl } = makeFakeHarness(N);
  const frames = [frame(N, 0), frame(N, 1)];
  const duration = 200;
  const startMs = 5000;
  const player = createKeyframePlayer({ gl, buffers, mixKernel, tU, frames, duration, startMs });
  let now = startMs;
  let done = false;
  while (!done) {
    done = player.step(now);
    if (!done) now += 16;
  }
  const overshoot = now - (startMs + duration);
  assert.ok(overshoot >= 0 && overshoot < 16, `completed ${overshoot}ms past the requested duration`);
});

test('chain driver: a single-frame chain leaves fromPos untouched (caller snapshots live positions)', () => {
  const N = 2;
  const { buffers, dispatches, tU, mixKernel, gl } = makeFakeHarness(N);
  buffers.fromPos.value.array.fill(9); // stands in for the GPU snapshot
  const frames = [frame(N, 4)];
  const player = createKeyframePlayer({
    gl, buffers, mixKernel, tU, frames, duration: 100, startMs: 0,
  });
  assert.equal(player.step(50), false);
  assert.deepEqual(Array.from(buffers.fromPos.value.array), [9, 9, 9, 9]);
  assert.deepEqual(Array.from(buffers.targetPos.value.array), Array.from(frames[0]));
  assert.equal(dispatches.at(-1).t, 0.5);
  assert.equal(player.step(100), true);
  assert.equal(dispatches.at(-1).t, 1);
});

test('chain driver: the named easing shapes the global clock, not the per-segment fraction', () => {
  const N = 1;
  const { dispatches, buffers, tU, mixKernel, gl } = makeFakeHarness(N);
  const frames = [frame(N, 0), frame(N, 1), frame(N, 2)]; // 2 segments
  const player = createKeyframePlayer({
    gl, buffers, mixKernel, tU, frames, duration: 100, easing: 'ease-out', startMs: 0,
  });
  player.step(50); // t=0.5 → e=easeCubicOut(0.5)=0.875 → pos=1.75 → segment 1, fraction 0.75
  assert.deepEqual(Array.from(buffers.fromPos.value.array), Array.from(frames[1]));
  assert.deepEqual(Array.from(buffers.targetPos.value.array), Array.from(frames[2]));
  assert.ok(Math.abs(dispatches.at(-1).t - 0.75) < 1e-12);
});
