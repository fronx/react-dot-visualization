/**
 * Headless Dawn tests for the GPU keyframe-chain player (the 'keyframes' job
 * in R3FDotsWebGPU): the production lerp kernels (src/r3f/lerpKernels.js)
 * driven by the production chain driver (src/r3f/keyframePlayer.js) on a
 * headless WebGPURenderer, with position readbacks asserted against a CPU
 * oracle.
 *
 * Frames are packed RENDER-SPACE coords ([x0, y0, …], N*2) — the player copies
 * them verbatim into fromPos/targetPos; no y negation happens anywhere in this
 * path (the 'lerp' job's data-space {x, y} targets are the ones that negate).
 * These tests pin that convention: the readbacks are compared against the raw
 * frame data.
 *
 * Dawn-Node quirks (see decollision-webgpu.test.mjs): tests live at top level
 * (describe() SIGSEGVs), one `create([])` per process (tslShims does it at
 * module load), and each test builds its own renderer/device. Unlike the
 * .check.mjs runners, this file finalizes under node --test because each test
 * disposes its renderer AND destroys the Dawn device — a live device keeps the
 * event loop alive forever (verified: without destroy(), node --test hangs).
 */
import './tslShims.mjs'; // must be first — sets navigator.gpu/self/rAF before three loads
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instancedArray, uniform, float } from 'three/tsl';
import { makeRenderer, readbackF32 } from './tslHeadless.mjs';
import { buildLerpKernels } from '../src/r3f/lerpKernels.js';
import { createKeyframePlayer, jumpToLastKeyframe } from '../src/r3f/keyframePlayer.js';

// Mirrors the persistent per-seed buffers + lerp kernels R3FDotsWebGPU builds
// (buildSeedBuffers + buildLerpKernels); only the sim-only velocities buffer
// is omitted.
async function makeHarness(N, seedPositions = null) {
  const renderer = await makeRenderer();
  const buffers = {
    N,
    positions: instancedArray(seedPositions ? new Float32Array(seedPositions) : new Float32Array(N * 2), 'vec2'),
    basePos: instancedArray(new Float32Array(N * 2), 'vec2'),
    fromPos: instancedArray(new Float32Array(N * 2), 'vec2'),
    targetPos: instancedArray(new Float32Array(N * 2), 'vec2'),
  };
  const tU = uniform(float(0));
  const kernels = buildLerpKernels(buffers, tU);
  return {
    renderer, buffers, tU, kernels,
    async positions() {
      return new Float32Array(await readbackF32(renderer, buffers.positions, N * 2));
    },
    dispose() {
      const device = renderer.backend?.device;
      renderer.dispose();
      device?.destroy(); // required for node --test to finalize (see header)
    },
  };
}

function makeFrames(N, count, seed = 1337) {
  let s = seed;
  const rand = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return Array.from({ length: count }, () => {
    const f = new Float32Array(N * 2);
    for (let i = 0; i < f.length; i++) f[i] = rand() * 20 - 10;
    return f;
  });
}

// CPU oracle for the chain at an eased global clock value: the same
// segment/fraction mapping + mix the kernels compute.
function oracleAt(frames, eased) {
  const segmentCount = frames.length - 1;
  const pos = eased * segmentCount;
  const i = Math.min(Math.floor(pos), segmentCount - 1);
  const f = pos - i;
  const a = frames[i];
  const b = frames[i + 1];
  const out = new Float32Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = a[k] * (1 - f) + b[k] * f;
  return out;
}

function assertApproxEqual(got, expected, tol = 1e-4) {
  assert.equal(got.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(got[i] - expected[i]) <= tol,
      `[${i}]: GPU ${got[i]} vs oracle ${expected[i]}`,
    );
  }
}

test('keyframe chain: mid-animation readbacks match the segment-lerp oracle', async () => {
  const N = 64;
  const h = await makeHarness(N);
  try {
    const frames = makeFrames(N, 4); // 3 segments
    const duration = 300;
    const startMs = 1000;
    const player = createKeyframePlayer({
      gl: h.renderer, buffers: h.buffers, mixKernel: h.kernels.mixStep, tU: h.tU,
      frames, duration, easing: 'linear', startMs,
    });
    // Sample mid-segment in each of the three segments.
    for (const elapsed of [50, 150, 250]) {
      assert.equal(player.step(startMs + elapsed), false);
      assertApproxEqual(await h.positions(), oracleAt(frames, elapsed / duration));
    }
  } finally {
    h.dispose();
  }
});

test('keyframe chain: completes within one frame of the duration; final positions bit-equal to the last keyframe', async () => {
  const N = 32;
  const h = await makeHarness(N);
  try {
    const frames = makeFrames(N, 5, 99);
    const duration = 200;
    const startMs = 4000;
    const player = createKeyframePlayer({
      gl: h.renderer, buffers: h.buffers, mixKernel: h.kernels.mixStep, tU: h.tU,
      frames, duration, easing: 'linear', startMs,
    });
    // Drive at a 16ms rAF cadence; done must fire on the first step at or past
    // startMs + duration — i.e. within one frame of the requested duration.
    let now = startMs;
    let done = false;
    while (!done) {
      done = player.step(now);
      if (!done) now += 16;
    }
    const overshoot = now - (startMs + duration);
    assert.ok(overshoot >= 0 && overshoot < 16, `completed ${overshoot}ms past the requested duration`);
    // The done step dispatched the mix at t exactly 1 → bit-equal landing.
    assert.deepStrictEqual(await h.positions(), frames[4]);
  } finally {
    h.dispose();
  }
});

test('keyframe chain: named easing applies to the global clock', async () => {
  const N = 16;
  const h = await makeHarness(N);
  try {
    const frames = makeFrames(N, 3, 7); // 2 segments
    const startMs = 0;
    const player = createKeyframePlayer({
      gl: h.renderer, buffers: h.buffers, mixKernel: h.kernels.mixStep, tU: h.tU,
      frames, duration: 100, easing: 'ease-out', startMs,
    });
    // t=0.5 → easeCubicOut(0.5) = 0.875 → segment 1, fraction 0.75.
    assert.equal(player.step(50), false);
    assertApproxEqual(await h.positions(), oracleAt(frames, 0.875));
    assert.equal(player.step(100), true);
    assert.deepStrictEqual(await h.positions(), frames[2]);
  } finally {
    h.dispose();
  }
});

test('single-frame chain: lerps from the current GPU positions to the frame', async () => {
  const N = 16;
  const seed = makeFrames(N, 1, 21)[0];
  const h = await makeHarness(N, seed);
  try {
    const [target] = makeFrames(N, 1, 22);
    // The 'keyframes' job snapshots fromPos from the live positions before the
    // first step when frames.length === 1 (same as the 'lerp' job's start).
    h.renderer.compute(h.kernels.snapshot);
    const player = createKeyframePlayer({
      gl: h.renderer, buffers: h.buffers, mixKernel: h.kernels.mixStep, tU: h.tU,
      frames: [target], duration: 200, easing: 'linear', startMs: 0,
    });
    assert.equal(player.step(100), false); // t=0.5
    const expected = new Float32Array(N * 2);
    for (let i = 0; i < expected.length; i++) expected[i] = seed[i] * 0.5 + target[i] * 0.5;
    assertApproxEqual(await h.positions(), expected);
    assert.equal(player.step(200), true);
    assert.deepStrictEqual(await h.positions(), target);
  } finally {
    h.dispose();
  }
});

test('duration <= 0: jumpToLastKeyframe lands bit-equal on the last frame immediately', async () => {
  const N = 16;
  const h = await makeHarness(N, makeFrames(N, 1, 5)[0]);
  try {
    const frames = makeFrames(N, 3, 6);
    jumpToLastKeyframe({
      gl: h.renderer, buffers: h.buffers, mixKernel: h.kernels.mixStep, tU: h.tU, frames,
    });
    assert.deepStrictEqual(await h.positions(), frames[2]);
  } finally {
    h.dispose();
  }
});

test('supersession: a new job mid-chain replaces the old one with no stale writes', async () => {
  const N = 24;
  const h = await makeHarness(N);
  try {
    const oldFrames = makeFrames(N, 4, 41);
    const newFrames = makeFrames(N, 3, 42);
    const oldPlayer = createKeyframePlayer({
      gl: h.renderer, buffers: h.buffers, mixKernel: h.kernels.mixStep, tU: h.tU,
      frames: oldFrames, duration: 300, easing: 'linear', startMs: 0,
    });
    oldPlayer.step(0);
    oldPlayer.step(150); // mid-chain, segment buffers hold oldFrames data
    // Supersede: in R3FDotsWebGPU a newer request replaces jobRef before the
    // frame driver runs, so the old player is never stepped again — and it has
    // no async work or pending callbacks that could write after this point.
    const newPlayer = createKeyframePlayer({
      gl: h.renderer, buffers: h.buffers, mixKernel: h.kernels.mixStep, tU: h.tU,
      frames: newFrames, duration: 100, easing: 'linear', startMs: 1000,
    });
    // The first step of the new chain fully overwrites the old segment data:
    // at t=0 positions land bit-equal on newFrames[0].
    assert.equal(newPlayer.step(1000), false);
    assert.deepStrictEqual(await h.positions(), newFrames[0]);
    // Mid- and end-of-chain readbacks track only the new chain.
    assert.equal(newPlayer.step(1075), false);
    assertApproxEqual(await h.positions(), oracleAt(newFrames, 0.75));
    assert.equal(newPlayer.step(1100), true);
    assert.deepStrictEqual(await h.positions(), newFrames[2]);
  } finally {
    h.dispose();
  }
});
