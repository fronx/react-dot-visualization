import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useDecollisionScheduler } from '../src/useDecollisionScheduler.js';
import { DecollisionCacheManager } from '../src/useDecollisionCache.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let dom = null;
let root = null;

function setupRoot() {
  dom = new JSDOM('<!doctype html><div id="root"></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const container = document.getElementById('root');
  root = createRoot(container);
}

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = null;
  }
  dom?.window.close();
  dom = null;
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.HTMLElement;
});

function makeCacheOnlyPositions(positions) {
  return positions.map((p) => ({ ...p }));
}

describe('useDecollisionScheduler WebGPU base cache bridge', () => {
  test('base completion can populate cache without publishing CPU positions to onBaseReady', async () => {
    setupRoot();

    const cache = new DecollisionCacheManager();
    const sourceData = [{ id: 'a', x: 1, y: 2 }];
    const settledBase = makeCacheOnlyPositions([{ id: 'a', x: 8, y: 13 }]);
    let runRequest = null;
    let publicBaseReadyArg = 'not-called';
    let syncedFinalData = null;

    const executor = {
      runSimulation(request) {
        runRequest = request;
        setTimeout(() => request.onComplete(settledBase, { cacheOnly: true }), 0);
        return { stop() {} };
      },
      runAnimation() {
        throw new Error('base cold-start should not animate');
      },
    };

    function Harness() {
      const dataRef = useRef(sourceData);
      const processedDataRef = useRef([]);
      const liveTransitionDataRef = useRef(null);
      const radiusOverrides = useMemo(() => new Map(), []);

      useDecollisionScheduler({
        dataRef,
        processedDataRef,
        liveTransitionDataRef,
        cache,
        positionsAreIntermediate: false,
        constraintKey: '',
        radiusOverrides,
        defaultSize: 2,
        onUpdateNodes: () => {},
        onBaseReady: (finalData) => { publicBaseReadyArg = finalData; },
        onConstraintReady: () => {},
        syncDecollisionState: (finalData) => { syncedFinalData = finalData; },
        onSimulationRunningChange: () => {},
        executor,
      });

      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(runRequest.constraintKey, '');
    assert.equal(runRequest.readbackPositionsOnComplete, true);
    assert.equal(publicBaseReadyArg, null);
    assert.equal(syncedFinalData, settledBase);
    assert.deepEqual(cache.cache.get('').get('a'), { x: 8, y: 13 });
  });
});
