/**
 * Tests for the shared hover/leave dispatcher.
 *
 * The contract both renderers must produce:
 *   onHover(item)  — entered a dot
 *   onLeave(item)  — left a dot, still inside the rendering zone
 *   onLeave(null)  — left the rendering zone
 *   onHoveredIdChange(id | null) — hovered id changed (for visual state)
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { createHoverDispatcher } from '../src/hoverDispatch.js';

function recorder() {
  const calls = [];
  return {
    calls,
    callbacks: {
      onHover: (item) => calls.push(['hover', item?.id ?? null]),
      onLeave: (item) => calls.push(['leave', item?.id ?? null]),
      onHoveredIdChange: (id) => calls.push(['id', id]),
    },
  };
}

const A = { id: 'a' };
const B = { id: 'b' };

describe('createHoverDispatcher', () => {
  test('entering a dot from empty space fires hover + id change, no leave', () => {
    const r = recorder();
    const d = createHoverDispatcher(r.callbacks);
    d.move(A);
    assert.deepStrictEqual(r.calls, [['id', 'a'], ['hover', 'a']]);
  });

  test('leaving a dot into a gap fires per-dot leave (truthy item), not zone leave', () => {
    const r = recorder();
    const d = createHoverDispatcher(r.callbacks);
    d.move(A);
    r.calls.length = 0;
    d.move(null); // moved into empty space, still inside the zone
    assert.deepStrictEqual(r.calls, [['id', null], ['leave', 'a']]);
  });

  test('dot-to-dot fires leave(old) then hover(new)', () => {
    const r = recorder();
    const d = createHoverDispatcher(r.callbacks);
    d.move(A);
    r.calls.length = 0;
    d.move(B);
    assert.deepStrictEqual(r.calls, [['id', 'b'], ['leave', 'a'], ['hover', 'b']]);
  });

  test('repeated move over the same dot is a no-op', () => {
    const r = recorder();
    const d = createHoverDispatcher(r.callbacks);
    d.move(A);
    r.calls.length = 0;
    d.move(A);
    assert.deepStrictEqual(r.calls, []);
  });

  test('repeated move over empty space is a no-op (no leave storm)', () => {
    const r = recorder();
    const d = createHoverDispatcher(r.callbacks);
    d.move(null);
    d.move(null);
    assert.deepStrictEqual(r.calls, []);
  });

  test('leaveZone fires zone leave (null) regardless of what was hovered', () => {
    const r = recorder();
    const d = createHoverDispatcher(r.callbacks);
    d.move(A);
    r.calls.length = 0;
    d.leaveZone();
    assert.deepStrictEqual(r.calls, [['id', null], ['leave', null]]);
  });

  test('leaveZone from empty space still fires zone leave', () => {
    const r = recorder();
    const d = createHoverDispatcher(r.callbacks);
    d.move(A);
    d.move(null); // now over a gap, hovered id already null
    r.calls.length = 0;
    d.leaveZone();
    assert.deepStrictEqual(r.calls, [['id', null], ['leave', null]]);
  });

  test('move after leaveZone re-enters cleanly', () => {
    const r = recorder();
    const d = createHoverDispatcher(r.callbacks);
    d.move(A);
    d.leaveZone();
    r.calls.length = 0;
    d.move(A);
    assert.deepStrictEqual(r.calls, [['id', 'a'], ['hover', 'a']]);
  });

  test('callbacks are read live (host can mutate the object)', () => {
    const calls = [];
    const cb = { onHover: () => calls.push('first') };
    const d = createHoverDispatcher(cb);
    d.move(A);
    cb.onHover = () => calls.push('second');
    d.move(B);
    assert.deepStrictEqual(calls, ['first', 'second']);
  });
});
