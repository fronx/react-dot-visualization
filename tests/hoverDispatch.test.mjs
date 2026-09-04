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
      onHoverRest: (item) => calls.push(['rest', item?.id ?? null]),
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

  test('rest fires once for the hovered dot and never with nothing hovered', () => {
    const r = recorder();
    const d = createHoverDispatcher(r.callbacks);
    d.rest();
    d.move(A);
    r.calls.length = 0;
    d.rest();
    d.rest();
    assert.deepStrictEqual(r.calls, [['rest', 'a']]);
  });

  test('a new hover re-arms rest; zone leave disarms it', () => {
    const r = recorder();
    const d = createHoverDispatcher(r.callbacks);
    d.move(A);
    d.rest();
    d.move(B);
    r.calls.length = 0;
    d.rest();
    assert.deepStrictEqual(r.calls, [['rest', 'b']]);
    d.leaveZone();
    r.calls.length = 0;
    d.rest();
    assert.deepStrictEqual(r.calls, []);
  });

  test('restMs arms a dwell timer per hover-in; it fires rest for the dot still hovered', () => {
    const r = recorder();
    const pending = [];
    const timers = { setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clearTimeout: (id) => { pending[id - 1] = null; } };
    const d = createHoverDispatcher(r.callbacks, { restMs: 150, timers });
    d.move(A);
    assert.strictEqual(pending.filter(Boolean).length, 1);
    assert.strictEqual(pending[0].ms, 150);
    r.calls.length = 0;
    pending[0].fn();
    assert.deepStrictEqual(r.calls, [['rest', 'a']]);
  });

  test('moving to another dot or leaving the zone cancels the pending dwell', () => {
    const r = recorder();
    const pending = [];
    const timers = { setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clearTimeout: (id) => { pending[id - 1] = null; } };
    const d = createHoverDispatcher(r.callbacks, { restMs: () => 100, timers });
    d.move(A);
    d.move(B);
    assert.strictEqual(pending[0], null, 'A dwell cancelled');
    d.leaveZone();
    assert.strictEqual(pending[1], null, 'B dwell cancelled');
    assert.deepStrictEqual(r.calls.filter((c) => c[0] === 'rest'), []);
  });

  test('empty space beside the dot pauses its dwell; re-entry resumes the remainder', () => {
    const r = recorder();
    const pending = [];
    let clock = 0;
    const timers = { now: () => clock, setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clearTimeout: (id) => { pending[id - 1] = null; } };
    const d = createHoverDispatcher(r.callbacks, { restMs: 150, timers });
    d.move(A);
    clock = 60;
    d.move(null);
    assert.strictEqual(pending[0], null, 'dwell paused, not running in the gap');
    assert.strictEqual(d.restCandidate, A, 'A stays the candidate');
    clock = 1000;
    d.move(A);
    const resumed = pending.filter(Boolean);
    assert.strictEqual(resumed.length, 1);
    assert.strictEqual(resumed[0].ms, 90, 'only the time on the dot counted');
    r.calls.length = 0;
    resumed[0].fn();
    assert.deepStrictEqual(r.calls, [['rest', 'a']]);
    d.rest();
    assert.deepStrictEqual(r.calls, [['rest', 'a']], 'idempotent');
  });

  test('a slow brush across sparse dots never rests: gaps do not count, the next dot resets', () => {
    const r = recorder();
    const pending = [];
    let clock = 0;
    const timers = { now: () => clock, setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clearTimeout: (id) => { pending[id - 1] = null; } };
    const d = createHoverDispatcher(r.callbacks, { restMs: 150, timers });
    d.move(A); clock = 50; d.move(null); clock = 400; d.move(B); clock = 450; d.move(null); clock = 800; d.move(A);
    assert.deepStrictEqual(r.calls.filter((c) => c[0] === 'rest'), []);
    assert.strictEqual(pending.filter(Boolean).length, 1, 'only the fresh A dwell is live');
    assert.strictEqual(pending.filter(Boolean)[0].ms, 150, 'a re-entered dot after another dot starts fresh');
  });

  test('rest() beside a dot (nearly still in the gap) settles the last dot entered', () => {
    const r = recorder();
    const d = createHoverDispatcher(r.callbacks);
    d.move(A);
    d.move(null);
    r.calls.length = 0;
    d.rest();
    assert.deepStrictEqual(r.calls, [['rest', 'a']]);
  });

  test('restMs 0 arms nothing (canvas path default)', () => {
    const r = recorder();
    let armed = 0;
    const d = createHoverDispatcher(r.callbacks, { timers: { setTimeout: () => { armed++; return 1; }, clearTimeout: () => {} } });
    d.move(A);
    assert.strictEqual(armed, 0);
  });

  test('still beside the dot for restMs rests it; moving on resets; another dot cancels', () => {
    const r = recorder();
    const pending = [];
    let clock = 0;
    const timers = { now: () => clock, setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clearTimeout: (id) => { pending[id - 1] = null; } };
    const d = createHoverDispatcher(r.callbacks, { restMs: 150, timers });
    d.move(A);
    clock = 20; d.move(null);
    const live = () => pending.map((p, i) => (p ? i : null)).filter((i) => i !== null);
    assert.strictEqual(live().length, 1, 'going off-dot arms the stillness timer without a further move');
    d.pointerMoved(); d.pointerMoved();
    assert.strictEqual(live().length, 1, 'one stillness timer live after two moves');
    r.calls.length = 0;
    pending[live()[0]].fn();
    assert.deepStrictEqual(r.calls, [['rest', 'a']]);
    // a fresh dot after that: the stillness timer for A cannot fire for B
    d.pointerMoved(); d.move(B); d.move(null); d.pointerMoved();
    r.calls.length = 0;
    const armedForB = pending[live()[0]];
    d.move(A); // entered another dot before the timer fires
    armedForB.fn?.();
    assert.deepStrictEqual(r.calls.filter((c) => c[0] === 'rest'), []);
  });

  test('pointerMoved arms nothing while on a dot, with no candidate, or once rested', () => {
    const r = recorder();
    let armed = 0;
    const timers = { setTimeout: () => { armed++; return 1; }, clearTimeout: () => {} };
    const d = createHoverDispatcher(r.callbacks, { restMs: 150, timers });
    d.pointerMoved();
    assert.strictEqual(armed, 0, 'no candidate');
    d.move(A);
    const afterHover = armed;
    d.pointerMoved();
    assert.strictEqual(armed, afterHover, 'on a dot the dwell timer owns it');
    d.rest();
    d.move(null);
    d.pointerMoved();
    assert.strictEqual(armed, afterHover, 'already rested');
  });
});
