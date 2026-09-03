import { describe, test } from 'node:test';
import assert from 'node:assert';
import { createPointerMotion } from '../src/pointerMotion.js';

describe('createPointerMotion', () => {
  test('first sample has no history and reads as slow', () => {
    const m = createPointerMotion();
    assert.deepStrictEqual(m.sample(10, 10, 100), { speed: 0, slow: true });
  });

  test('a sweep reads as fast, a creep reads as slow', () => {
    const m = createPointerMotion({ slowPxPerMs: 0.3 });
    m.sample(0, 0, 0);
    let last;
    for (let i = 1; i <= 5; i++) last = m.sample(i * 20, 0, i * 16); // 1.25 px/ms
    assert.strictEqual(last.slow, false);
    for (let i = 1; i <= 8; i++) last = m.sample(100 + i, 0, 80 + i * 16); // 0.06 px/ms
    assert.strictEqual(last.slow, true);
  });

  test('smoothing: one jittery fast event does not flip a slow pointer', () => {
    const m = createPointerMotion({ slowPxPerMs: 0.3 });
    m.sample(0, 0, 0);
    for (let i = 1; i <= 6; i++) m.sample(i, 0, i * 16);
    const jitter = m.sample(20, 0, 7 * 16); // 0.8 px/ms instant, averaged with ~0.06
    assert.strictEqual(jitter.slow, false);
    assert.ok(jitter.speed < 0.8, 'the instant value is damped');
    assert.strictEqual(m.sample(21, 0, 8 * 16).slow, true);
  });

  test('zero elapsed time is ignored, not divided by', () => {
    const m = createPointerMotion();
    m.sample(0, 0, 5);
    const r = m.sample(50, 50, 5);
    assert.strictEqual(Number.isFinite(r.speed), true);
    assert.strictEqual(r.slow, true);
  });

  test('reset forgets the previous position', () => {
    const m = createPointerMotion();
    m.sample(0, 0, 0);
    m.sample(100, 0, 16);
    m.reset();
    assert.deepStrictEqual(m.sample(500, 500, 32), { speed: 0, slow: true });
  });

  test('constant time per sample: a hundred thousand samples allocate nothing observable', () => {
    const m = createPointerMotion();
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) m.sample(i % 500, (i * 7) % 300, i * 8);
    const perSample = (performance.now() - t0) / 100_000;
    assert.ok(perSample < 0.005, `expected < 5µs per sample, got ${(perSample * 1000).toFixed(2)}µs`);
  });
});
