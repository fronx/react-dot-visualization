import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTemporaryRenderTarget } from '../src/r3f/renderTargetState.js';

function colorValue(color) {
  return typeof color === 'object' ? color.value : color;
}

function createFakeRenderer() {
  const calls = [];
  return {
    calls,
    target: 'screen',
    clearColor: 'old-clear',
    clearAlpha: 0.75,

    getRenderTarget() {
      calls.push(['getRenderTarget']);
      return this.target;
    },

    getClearAlpha() {
      calls.push(['getClearAlpha']);
      return this.clearAlpha;
    },

    getClearColor(out) {
      calls.push(['getClearColor']);
      out.value = this.clearColor;
    },

    setRenderTarget(target) {
      calls.push(['setRenderTarget', target]);
      this.target = target;
    },

    setClearColor(color, alpha) {
      calls.push(['setClearColor', colorValue(color), alpha]);
      this.clearColor = colorValue(color);
      this.clearAlpha = alpha;
    },
  };
}

describe('withTemporaryRenderTarget', () => {
  test('restores the previous target and clear state after rendering', () => {
    const gl = createFakeRenderer();
    const previousClearColor = {};

    const result = withTemporaryRenderTarget(gl, 'density-target', previousClearColor, () => {
      assert.equal(gl.target, 'density-target');
      assert.equal(gl.clearColor, 0x000000);
      assert.equal(gl.clearAlpha, 0);
      return 'rendered';
    });

    assert.equal(result, 'rendered');
    assert.equal(gl.target, 'screen');
    assert.equal(gl.clearColor, 'old-clear');
    assert.equal(gl.clearAlpha, 0.75);
    assert.deepEqual(gl.calls, [
      ['getRenderTarget'],
      ['getClearAlpha'],
      ['getClearColor'],
      ['setRenderTarget', 'density-target'],
      ['setClearColor', 0x000000, 0],
      ['setRenderTarget', 'screen'],
      ['setClearColor', 'old-clear', 0.75],
    ]);
  });

  test('restores renderer state when rendering throws', () => {
    const gl = createFakeRenderer();
    const previousClearColor = {};

    assert.throws(
      () => withTemporaryRenderTarget(gl, 'density-target', previousClearColor, () => {
        throw new Error('render failed');
      }),
      /render failed/,
    );

    assert.equal(gl.target, 'screen');
    assert.equal(gl.clearColor, 'old-clear');
    assert.equal(gl.clearAlpha, 0.75);
  });
});
