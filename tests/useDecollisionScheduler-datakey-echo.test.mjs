import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useDecollisionScheduler } from '../src/useDecollisionScheduler.js';

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

describe('useDecollisionScheduler base-completion dataKey echo', () => {
  // Regression for the 2026-08-08 Refresh-recompute wedge: the parent's data
  // effect (registered BEFORE this hook in DotVisualizationR3F) fires
  // decollideForConstraint('') on a scope change in the very render that also
  // changed the dataKey prop. The launch must capture THAT render's dataKey —
  // an effect-updated ref still holds the outgoing layout's key at that
  // moment, and the settle derivation downstream rejects the completion.
  test('a base launched from an earlier-registered effect echoes the new dataKey', async () => {
    setupRoot();

    const settles = [];
    let baseSnapshotAvailable = false;
    const executor = {
      canSnapshotPositions: true,
      hasPositionSnapshot(key) {
        return key === '' && baseSnapshotAvailable;
      },
      invalidatePositionSnapshot(key) {
        if (key === '') baseSnapshotAvailable = false;
      },
      runSimulation(request) {
        setTimeout(() => {
          if (request.constraintKey === '') baseSnapshotAvailable = true;
          request.onComplete(null, request.constraintKey === '' ? { gpuSnapshotKey: '' } : undefined);
        }, 0);
        return { stop() {} };
      },
      runAnimation(request) {
        setTimeout(() => request.onComplete(null, { gpuSnapshotKey: request.targetSnapshotKey }), 0);
        return { stop() {} };
      },
    };

    // Stable across renders, as in a real refresh (no size change involved):
    // an unstable Map would fire the radiusOverrides trigger and add an
    // unrelated cancel+relaunch to the sequence under test.
    const stableOverrides = new Map();

    function Harness({ dataKey, data }) {
      const dataRef = useRef(data);
      const processedDataRef = useRef([]);
      const liveTransitionDataRef = useRef(null);
      const apiRef = useRef(null);
      const prevKeyRef = useRef(null);

      // Mirrors DotVisualizationR3F's data effect: registered before the
      // scheduler hook, re-decollides the base on a scope/dataKey change.
      useEffect(() => {
        const changed = prevKeyRef.current !== null && prevKeyRef.current !== dataKey;
        prevKeyRef.current = dataKey;
        dataRef.current = data;
        if (changed) apiRef.current.decollideForConstraint('');
      });

      apiRef.current = useDecollisionScheduler({
        dataRef,
        processedDataRef,
        liveTransitionDataRef,
        cache: null,
        positionsAreIntermediate: false,
        constraintKey: '',
        radiusOverrides: stableOverrides,
        defaultSize: 2,
        onUpdateNodes: () => {},
        onBaseReady: () => {},
        onConstraintReady: () => {},
        dataKey,
        onBaseSettled: (info) => settles.push(info.dataKey),
        syncDecollisionState: () => {},
        onSimulationRunningChange: () => {},
        executor,
      });
      return null;
    }

    const dataA = [{ id: 'a', x: 1, y: 2 }, { id: 'b', x: 3, y: 4 }];
    await act(async () => {
      root.render(React.createElement(Harness, { dataKey: 'layout-A', data: dataA }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(settles, ['layout-A']);

    // Same count, new layout identity — the Refresh-recompute shape.
    const dataB = [{ id: 'a', x: 5, y: 6 }, { id: 'b', x: 7, y: 8 }];
    await act(async () => {
      root.render(React.createElement(Harness, { dataKey: 'layout-B', data: dataB }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(settles, ['layout-A', 'layout-B']);
  });
});
