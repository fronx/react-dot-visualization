import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decollisioning } from '../src/decollisioning.js';

function makeRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeNodes(count, spread = 120, seed = 7) {
  const rand = makeRng(seed);
  const nodes = [];
  for (let i = 0; i < count; i++) {
    // Dense center cluster with mild jitter to force many collisions.
    const rx = (rand() - 0.5) * spread;
    const ry = (rand() - 0.5) * spread;
    nodes.push({ id: `n-${i}`, x: rx * 0.15, y: ry * 0.15 });
  }
  return nodes;
}

function getBounds(nodes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function allFinite(nodes) {
  return nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
}

function runDecollision({
  data,
  fnDotSize = () => 3.5,
  skipIntermediateFrames = false,
  transitionConfig = null,
  runtimeOptions = {}
}) {
  return new Promise((resolve, reject) => {
    let completed = false;
    let sim = null;
    const timeout = setTimeout(() => {
      sim?.stop?.();
      if (!completed) {
        reject(new Error('decollision timeout'));
      }
    }, 8000);

    try {
      sim = decollisioning(
        data,
        () => {},
        fnDotSize,
        (finalData) => {
          completed = true;
          clearTimeout(timeout);
          sim?.stop?.();
          resolve(finalData);
        },
        skipIntermediateFrames,
        transitionConfig,
        runtimeOptions
      );
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

function withNavigatorGpu(gpu, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { gpu },
    configurable: true,
    writable: true
  });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (descriptor) {
        Object.defineProperty(globalThis, 'navigator', descriptor);
      } else {
        delete globalThis.navigator;
      }
    });
}

describe('decollisioning regression invariants', () => {
  test('cpu decollision keeps graph spread and finite positions', async () => {
    const initial = makeNodes(240);
    const start = getBounds(initial);
    const finalData = await runDecollision({
      data: initial,
      runtimeOptions: { engine: 'cpu', alphaDecay: 0.18, alphaMin: 0.03 }
    });
    const end = getBounds(finalData);

    assert.equal(allFinite(finalData), true, 'all positions must be finite');
    assert.ok(end.width > start.width * 0.4, `width collapsed too much: ${end.width} vs ${start.width}`);
    assert.ok(end.height > start.height * 0.4, `height collapsed too much: ${end.height} vs ${start.height}`);
  });

  test('cpu decollision + transition path keeps non-collapsed final result', async () => {
    const initial = makeNodes(180, 100, 13);
    const stable = initial.map((n) => ({ ...n }));
    const start = getBounds(initial);

    const finalData = await runDecollision({
      data: initial,
      skipIntermediateFrames: true,
      transitionConfig: {
        enabled: true,
        stablePositions: stable,
        duration: 1,
        easing: (t) => t
      },
      runtimeOptions: { engine: 'cpu', alphaDecay: 0.2, alphaMin: 0.04 }
    });
    const end = getBounds(finalData);

    assert.equal(allFinite(finalData), true, 'all positions must be finite');
    assert.ok(end.width > start.width * 0.4, `width collapsed too much: ${end.width} vs ${start.width}`);
    assert.ok(end.height > start.height * 0.4, `height collapsed too much: ${end.height} vs ${start.height}`);
  });

  test('auto engine falls back to cpu when gpu adapter is unavailable', async () => {
    const initial = makeNodes(160, 80, 21);
    const start = getBounds(initial);

    await withNavigatorGpu(
      {
        requestAdapter: async () => null
      },
      async () => {
        const finalData = await runDecollision({
          data: initial,
          runtimeOptions: { engine: 'auto', alphaDecay: 0.2, alphaMin: 0.04 }
        });
        const end = getBounds(finalData);

        assert.equal(allFinite(finalData), true, 'all positions must be finite');
        assert.ok(end.width > start.width * 0.4, `width collapsed too much: ${end.width} vs ${start.width}`);
        assert.ok(end.height > start.height * 0.4, `height collapsed too much: ${end.height} vs ${start.height}`);
      }
    );
  });
});
