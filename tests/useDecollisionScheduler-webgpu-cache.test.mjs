import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, useRef } from 'react';
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

describe('useDecollisionScheduler WebGPU base cache bridge', () => {
  test('WebGPU base snapshot lets clear-focus animate without CPU base cache', async () => {
    setupRoot();

    const cache = new DecollisionCacheManager();
    const sourceData = [{ id: 'a', x: 1, y: 2 }];
    let baseSnapshotAvailable = false;
    const simRequests = [];
    const animationRequests = [];
    let constraintKey = '';
    let radiusOverrides = new Map();

    const executor = {
      canSnapshotPositions: true,
      hasPositionSnapshot(key) {
        return key === '' && baseSnapshotAvailable;
      },
      runSimulation(request) {
        simRequests.push(request);
        setTimeout(() => {
          if (request.constraintKey === '') {
            baseSnapshotAvailable = true;
            request.onComplete(null, { gpuSnapshotKey: '' });
          } else {
            request.onComplete(null);
          }
        }, 0);
        return { stop() {} };
      },
      runAnimation(request) {
        animationRequests.push(request);
        setTimeout(() => request.onComplete(null, { gpuSnapshotKey: request.targetSnapshotKey }), 0);
        return { stop() {} };
      },
    };

    function Harness() {
      const dataRef = useRef(sourceData);
      const processedDataRef = useRef([]);
      const liveTransitionDataRef = useRef(null);

      useDecollisionScheduler({
        dataRef,
        processedDataRef,
        liveTransitionDataRef,
        cache,
        positionsAreIntermediate: false,
        constraintKey,
        radiusOverrides,
        defaultSize: 2,
        onUpdateNodes: () => {},
        onBaseReady: () => {},
        onConstraintReady: () => {},
        syncDecollisionState: () => {},
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

    assert.equal(simRequests[0].constraintKey, '');
    assert.equal(simRequests[0].snapshotOnCompleteKey, '');
    assert.equal(cache.cache.get(''), null);

    constraintKey = 'focus:a';
    radiusOverrides = new Map([['a', 12]]);
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(simRequests[1].constraintKey, 'focus:a');

    constraintKey = '';
    radiusOverrides = new Map();
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(animationRequests.length, 1);
    assert.equal(animationRequests[0].targetSnapshotKey, '');
    assert.equal(animationRequests[0].target, null);
    assert.equal(simRequests.length, 2);
  });
});
