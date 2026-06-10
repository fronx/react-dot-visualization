import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGpuExecutor } from '../src/r3f/gpuDecollisionExecutor.js';

// Guards the slider/re-layout regression: a base launch (constraintKey === '')
// must reseed from sourceData so a dot-size change re-spreads from the raw
// projection. A constraint launch (focus) seeds from the current GPU positions
// for speed. The bug was an unconditional `seedFromCurrentPositions: true`,
// which left base re-decollisions seeding from already-settled positions — the
// push-only collide solver then never moved a dot, so the slider only resized.

function makeExecutor() {
  const gpuControlRef = { current: { request: null, positionSnapshots: new Map() } };
  const executor = makeGpuExecutor(gpuControlRef, {
    baseMaxIterations: 100,
    constraintMaxIterations: 50,
    solverIterationsPerFrame: 4,
    solverFrameBudgetMs: 8,
    baseFixedIterations: 0,
  });
  return { executor, gpuControlRef };
}

const SOURCE = [{ id: 'a', x: 1, y: 2 }, { id: 'b', x: 3, y: 4 }];

test('base launch reseeds from source (seedFromCurrentPositions=false)', () => {
  const { executor, gpuControlRef } = makeExecutor();
  executor.runSimulation({ sourceData: SOURCE, fnDotSize: () => 1, constraintKey: '', onComplete() {} });
  const req = gpuControlRef.current.request;
  assert.equal(req.type, 'sim');
  assert.equal(req.constraintKey, '');
  assert.equal(req.seedFromCurrentPositions, false);
});

test('constraint launch seeds from current GPU positions (seedFromCurrentPositions=true)', () => {
  const { executor, gpuControlRef } = makeExecutor();
  executor.runSimulation({ sourceData: SOURCE, fnDotSize: () => 1, constraintKey: 'focus:a', onComplete() {} });
  const req = gpuControlRef.current.request;
  assert.equal(req.type, 'sim');
  assert.equal(req.constraintKey, 'focus:a');
  assert.equal(req.seedFromCurrentPositions, true);
});

test('runKeyframes issues a keyframes request: frames pass through verbatim, easing defaults to linear', () => {
  const { executor, gpuControlRef } = makeExecutor();
  const frames = [new Float32Array([1, 2, 3, 4]), new Float32Array([5, 6, 7, 8])];
  const onComplete = () => {};
  executor.runKeyframes({ frames, duration: 2000, onComplete });
  const req = gpuControlRef.current.request;
  assert.equal(req.type, 'keyframes');
  assert.equal(req.frames, frames); // verbatim — no copy, no y negation upstream
  assert.equal(req.duration, 2000);
  assert.equal(req.easing, 'linear');
  assert.equal(req.onComplete, onComplete);
});

test('a newer request supersedes a pending keyframes request; the stale handle stop() is a no-op', () => {
  const { executor, gpuControlRef } = makeExecutor();
  const handle = executor.runKeyframes({
    frames: [new Float32Array([1, 2, 3, 4])], duration: 1000, easing: 'ease-out', onComplete() {},
  });
  executor.runAnimation({ target: SOURCE, duration: 300, onComplete() {} });
  const newer = gpuControlRef.current.request;
  assert.equal(newer.type, 'lerp');
  handle.stop(); // superseded already — must not clobber the newer request
  assert.equal(gpuControlRef.current.request, newer);
});
