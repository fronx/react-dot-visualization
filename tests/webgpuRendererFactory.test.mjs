import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleFlightWebGpuRendererFactory } from '../src/r3f/webgpuRendererFactory.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSingleFlightWebGpuRendererFactory', () => {
  test('coalesces concurrent renderer init calls', async () => {
    const gate = deferred();
    let constructCount = 0;
    let initCount = 0;

    class FakeRenderer {
      constructor(options) {
        constructCount += 1;
        this.options = options;
      }

      async init() {
        initCount += 1;
        await gate.promise;
        this.initialized = true;
      }
    }

    const createRenderer = createSingleFlightWebGpuRendererFactory({
      Renderer: FakeRenderer,
      rendererOptions: { depth: false, powerPreference: 'low-power' },
    });

    const first = createRenderer({ canvas: 'a', antialias: true, powerPreference: 'high-performance' });
    const second = createRenderer({ canvas: 'b' });

    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(constructCount, 1);
    assert.equal(initCount, 1);

    gate.resolve();
    const renderer = await first;

    assert.equal(await second, renderer);
    assert.equal(renderer.initialized, true);
    assert.deepEqual(renderer.options, {
      canvas: 'a',
      antialias: true,
      powerPreference: 'low-power',
      depth: false,
    });
    assert.equal(createRenderer({ canvas: 'c' }), first);
  });

  test('clears the pending renderer after failed init so a later call can retry', async () => {
    const initError = new Error('init failed');
    const instances = [];

    class FakeRenderer {
      constructor(options) {
        this.options = options;
        instances.push(this);
      }

      async init() {
        if (instances.length === 1) throw initError;
        this.initialized = true;
      }
    }

    const createRenderer = createSingleFlightWebGpuRendererFactory({ Renderer: FakeRenderer });
    const failed = createRenderer({ canvas: 'first' });

    await assert.rejects(failed, initError);

    const retried = createRenderer({ canvas: 'second' });
    assert.notEqual(retried, failed);

    const renderer = await retried;
    assert.equal(instances.length, 2);
    assert.equal(renderer.initialized, true);
    assert.deepEqual(renderer.options, { canvas: 'second' });
  });
});
