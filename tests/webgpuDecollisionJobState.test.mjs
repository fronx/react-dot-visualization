import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseBufferMismatchAction,
  shouldDeferRequestForBuffers,
} from '../src/r3f/webgpuDecollisionJobState.js';

describe('WebGPU decollision request buffer gating', () => {
  test('defers a growing sim request until live buffers catch up', () => {
    assert.equal(
      shouldDeferRequestForBuffers(
        { type: 'sim', sourceData: [{}, {}, {}, {}] },
        { N: 3 }
      ),
      true
    );
  });

  test('allows sim requests once buffers cover the request snapshot', () => {
    assert.equal(
      shouldDeferRequestForBuffers(
        { type: 'sim', sourceData: [{}, {}, {}] },
        { N: 3 }
      ),
      false
    );
  });

  test('defers a shrinking sim request until the smaller buffers commit', () => {
    // Starting it would walk startJob past sourceData's end (undefined.x,
    // 2026-08-08). Supersession — latest request wins in the channel — is what
    // prevents a stale request from deferring forever.
    assert.equal(
      shouldDeferRequestForBuffers(
        { type: 'sim', sourceData: [{}, {}] },
        { N: 3 }
      ),
      true
    );
  });

  test('ignores non-sim requests', () => {
    assert.equal(
      shouldDeferRequestForBuffers(
        { type: 'lerp', target: [{}, {}, {}, {}] },
        { N: 3 }
      ),
      false
    );
  });
});

describe('WebGPU decollision job buffer mismatch handling', () => {
  test('continues when the job is already bound to the live buffers', () => {
    const buffers = { N: 3 };

    assert.equal(
      chooseBufferMismatchAction(
        { mode: 'sim', buffers, jobId: 1 },
        { id: 1, sourceData: [{}, {}, {}] },
        buffers
      ),
      'continue'
    );
  });

  test('rebinds the same sim request when its sourceData covers the live buffers', () => {
    assert.equal(
      chooseBufferMismatchAction(
        { mode: 'sim', buffers: { N: 2 }, jobId: 7 },
        { id: 7, sourceData: [{}, {}, {}] },
        { N: 3 }
      ),
      'rebind'
    );
  });

  test('completes with live data when live buffers grew past the request snapshot', () => {
    assert.equal(
      chooseBufferMismatchAction(
        { mode: 'sim', buffers: { N: 2 }, jobId: 7 },
        { id: 7, sourceData: [{}, {}] },
        { N: 3 }
      ),
      'complete-live'
    );
  });

  test('completes with live data when live buffers disappear during the same request', () => {
    assert.equal(
      chooseBufferMismatchAction(
        { mode: 'sim', buffers: { N: 2 }, jobId: 7 },
        { id: 7, sourceData: [{}, {}] },
        null
      ),
      'complete-live'
    );
  });

  test('does not rebind superseded or non-sim jobs', () => {
    const liveBuffers = { N: 3 };

    assert.equal(
      chooseBufferMismatchAction(
        { mode: 'sim', buffers: { N: 2 }, jobId: 7 },
        { id: 8, sourceData: [{}, {}, {}] },
        liveBuffers
      ),
      'idle'
    );
    assert.equal(
      chooseBufferMismatchAction(
        { mode: 'lerp', buffers: { N: 2 }, jobId: 7 },
        { id: 7, sourceData: [{}, {}, {}] },
        liveBuffers
      ),
      'idle'
    );
  });
});
