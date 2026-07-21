import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { classifyWheelGesture } from '../src/r3f/cameraUtils.js';

describe('classifyWheelGesture', () => {
  test('keeps the meta-or-alt default backward compatible', () => {
    assert.equal(classifyWheelGesture({ ctrlKey: false, metaKey: true, altKey: false }), 'scroll-zoom');
    assert.equal(classifyWheelGesture({ ctrlKey: false, metaKey: false, altKey: true }), 'scroll-zoom');
  });

  test('can reserve Option by selecting Command-only scroll zoom', () => {
    assert.equal(classifyWheelGesture({ ctrlKey: false, metaKey: true, altKey: false }, 'meta'), 'scroll-zoom');
    assert.equal(classifyWheelGesture({ ctrlKey: false, metaKey: false, altKey: true }, 'meta'), 'scroll-pan');
  });

  test('always preserves ctrl-key pinch classification', () => {
    assert.equal(classifyWheelGesture({ ctrlKey: true, metaKey: false, altKey: false }, 'meta'), 'pinch');
  });
});
