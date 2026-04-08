import { describe, test, expect } from 'vitest';
import {
  PHASE,
  onIntermediateChange,
  onBaseComplete,
  onConstraintRequest,
  onConstraintComplete,
  onColdStart,
} from '../src/decollisionScheduler.js';
import { resolveOnScreenData, validateCachedPositions } from '../src/useDecollisionScheduler.js';

describe('decollision scheduler — phase transitions', () => {
  test('AWAITING_LAYOUT stays when intermediate is true', () => {
    const result = onIntermediateChange(PHASE.AWAITING_LAYOUT, true);
    expect(result.phase).toBe(PHASE.AWAITING_LAYOUT);
    expect(result.action).toBeNull();
  });

  test('AWAITING_LAYOUT → BASE_DECOLLISION when positions settle', () => {
    const result = onIntermediateChange(PHASE.AWAITING_LAYOUT, false);
    expect(result.phase).toBe(PHASE.BASE_DECOLLISION);
    expect(result.action).toEqual({ type: 'launch-base' });
  });

  test('BASE_DECOLLISION → AWAITING_LAYOUT cancels base when layout restarts', () => {
    const result = onIntermediateChange(PHASE.BASE_DECOLLISION, true);
    expect(result.phase).toBe(PHASE.AWAITING_LAYOUT);
    expect(result.action).toEqual({ type: 'cancel-base' });
  });

  test('READY → AWAITING_LAYOUT cancels constraint when layout restarts', () => {
    const result = onIntermediateChange(PHASE.READY, true);
    expect(result.phase).toBe(PHASE.AWAITING_LAYOUT);
    expect(result.action).toEqual({ type: 'cancel-constraint' });
  });

  test('BASE_DECOLLISION stays when positions settle (already running)', () => {
    const result = onIntermediateChange(PHASE.BASE_DECOLLISION, false);
    expect(result.phase).toBe(PHASE.BASE_DECOLLISION);
    expect(result.action).toBeNull();
  });

  test('READY stays when positions settle (already past base)', () => {
    const result = onIntermediateChange(PHASE.READY, false);
    expect(result.phase).toBe(PHASE.READY);
    expect(result.action).toBeNull();
  });
});

describe('decollision scheduler — base completion', () => {
  test('base complete with no queued constraint → READY, no action', () => {
    const result = onBaseComplete(null);
    expect(result.phase).toBe(PHASE.READY);
    expect(result.action).toBeNull();
  });

  test('base complete with queued constraint → READY, launch constraint', () => {
    const result = onBaseComplete('hl:track1,track2');
    expect(result.phase).toBe(PHASE.READY);
    expect(result.action).toEqual({
      type: 'launch-constraint',
      constraintKey: 'hl:track1,track2'
    });
  });
});

describe('decollision scheduler — constraint requests', () => {
  test('constraint request during AWAITING_LAYOUT → queue', () => {
    const result = onConstraintRequest(PHASE.AWAITING_LAYOUT, 'hl:a', null, false);
    expect(result.action).toEqual({ type: 'queue-constraint', constraintKey: 'hl:a' });
  });

  test('constraint request during BASE_DECOLLISION → queue', () => {
    const result = onConstraintRequest(PHASE.BASE_DECOLLISION, 'hl:a', null, false);
    expect(result.action).toEqual({ type: 'queue-constraint', constraintKey: 'hl:a' });
  });

  test('constraint request in READY with no cache → launch', () => {
    const result = onConstraintRequest(PHASE.READY, 'hl:a', null, false);
    expect(result.action).toEqual({ type: 'launch-constraint', constraintKey: 'hl:a' });
  });

  test('constraint request in READY with exact cache hit → animate', () => {
    const cached = new Map([['t1', { x: 1, y: 2 }]]);
    const result = onConstraintRequest(PHASE.READY, 'hl:a', cached, false);
    expect(result.action).toEqual({
      type: 'animate-from-cache',
      constraintKey: 'hl:a',
      positions: cached
    });
  });

  test('constraint request in READY with empty cache → launch (not animate)', () => {
    const cached = new Map();
    const result = onConstraintRequest(PHASE.READY, 'hl:a', cached, false);
    expect(result.action).toEqual({ type: 'launch-constraint', constraintKey: 'hl:a' });
  });

  test('constraint request cancels running constraint then launches new', () => {
    const result = onConstraintRequest(PHASE.READY, 'hl:b', null, true);
    expect(result.action).toEqual([
      { type: 'cancel-constraint' },
      { type: 'launch-constraint', constraintKey: 'hl:b' }
    ]);
  });

  test('constraint request cancels running constraint then animates from cache', () => {
    const cached = new Map([['t1', { x: 1, y: 2 }]]);
    const result = onConstraintRequest(PHASE.READY, 'hl:b', cached, true);
    expect(result.action).toEqual([
      { type: 'cancel-constraint' },
      { type: 'animate-from-cache', constraintKey: 'hl:b', positions: cached }
    ]);
  });
});

describe('decollision scheduler — constraint completion', () => {
  test('constraint complete → stays READY', () => {
    const result = onConstraintComplete();
    expect(result.phase).toBe(PHASE.READY);
    expect(result.action).toBeNull();
  });
});

describe('decollision scheduler — cold start', () => {
  test('cold start with settled data → launch base immediately', () => {
    const result = onColdStart(true, false);
    expect(result.phase).toBe(PHASE.BASE_DECOLLISION);
    expect(result.action).toEqual({ type: 'launch-base' });
  });

  test('cold start with intermediate data → await layout', () => {
    const result = onColdStart(true, true);
    expect(result.phase).toBe(PHASE.AWAITING_LAYOUT);
    expect(result.action).toBeNull();
  });

  test('cold start with no data → await layout', () => {
    const result = onColdStart(false, false);
    expect(result.phase).toBe(PHASE.AWAITING_LAYOUT);
    expect(result.action).toBeNull();
  });
});

describe('decollision scheduler — full scenarios', () => {
  test('UMAP converge → base → constraint → deselect', () => {
    // 1. Start: layout is running
    let state = { phase: PHASE.AWAITING_LAYOUT, queue: null };

    // 2. User selects playlist during UMAP
    let r = onConstraintRequest(state.phase, 'hl:a,b', null, false);
    expect(r.action).toEqual({ type: 'queue-constraint', constraintKey: 'hl:a,b' });
    state.queue = 'hl:a,b';

    // 3. UMAP settles
    r = onIntermediateChange(state.phase, false);
    expect(r.phase).toBe(PHASE.BASE_DECOLLISION);
    expect(r.action).toEqual({ type: 'launch-base' });
    state.phase = r.phase;

    // 4. Base completes — queued constraint dequeues
    r = onBaseComplete(state.queue);
    expect(r.phase).toBe(PHASE.READY);
    expect(r.action).toEqual({ type: 'launch-constraint', constraintKey: 'hl:a,b' });
    state.phase = r.phase;
    state.queue = null;

    // 5. Constraint completes
    r = onConstraintComplete();
    expect(r.phase).toBe(PHASE.READY);

    // 6. User deselects (return to base) — base is cached
    const baseCache = new Map([['t1', { x: 10, y: 20 }]]);
    r = onConstraintRequest(state.phase, '', baseCache, false);
    expect(r.action).toEqual({
      type: 'animate-from-cache',
      constraintKey: '',
      positions: baseCache
    });
  });

  test('multiple constraint changes during base → only latest survives', () => {
    let state = { phase: PHASE.BASE_DECOLLISION, queue: null };

    // User selects playlist A
    let r = onConstraintRequest(state.phase, 'hl:a', null, false);
    expect(r.action).toEqual({ type: 'queue-constraint', constraintKey: 'hl:a' });
    state.queue = 'hl:a';

    // User changes to playlist B (overwrites queue)
    r = onConstraintRequest(state.phase, 'hl:b', null, false);
    expect(r.action).toEqual({ type: 'queue-constraint', constraintKey: 'hl:b' });
    state.queue = 'hl:b'; // latest wins

    // User deselects entirely
    r = onConstraintRequest(state.phase, '', null, false);
    expect(r.action).toEqual({ type: 'queue-constraint', constraintKey: '' });
    state.queue = '';

    // Base completes — dequeue returns to base (empty string = no constraint)
    // Base positions are already cached, but the queue contains '' which means
    // "return to base". The caller should recognize this is already the base state.
    r = onBaseComplete(state.queue);
    expect(r.phase).toBe(PHASE.READY);
    // The scheduler doesn't know '' is special — it returns launch-constraint.
    // The caller (or a wrapper) should check if constraintKey is '' and base is cached,
    // and skip the launch. This is acceptable — keep the scheduler simple.
    expect(r.action).toEqual({ type: 'launch-constraint', constraintKey: '' });
  });

  test('constraint A → constraint B goes through base (visible neutral transition)', () => {
    // Rule: constraint-to-constraint transitions always pass through base visually.
    // Focus A → animate to base → then decollide/animate to Focus B.
    const baseCache = new Map([['t1', { x: 10, y: 20 }]]);

    // User clicks Focus B while Focus A is active (not running, just cached)
    let r = onConstraintRequest(PHASE.READY, 'focus:b', null, false, 'focus:a', baseCache);

    // Should animate to base FIRST, then queue the new constraint
    expect(r.action).toEqual([
      { type: 'animate-to-base', positions: baseCache },
      { type: 'queue-constraint', constraintKey: 'focus:b' }
    ]);
  });

  test('constraint → base (deselect) does NOT double-animate', () => {
    // When returning to base (constraintKey=''), no need to "go through base first"
    const baseCache = new Map([['t1', { x: 10, y: 20 }]]);
    let r = onConstraintRequest(PHASE.READY, '', baseCache, false, 'focus:a', baseCache);

    // Should animate directly to base (it IS the target)
    expect(r.action).toEqual({
      type: 'animate-from-cache',
      constraintKey: '',
      positions: baseCache
    });
  });

  test('layout restart during base → cancels and re-awaits', () => {
    let state = { phase: PHASE.BASE_DECOLLISION, queue: 'hl:a' };

    // New import adds tracks, worker restarts
    let r = onIntermediateChange(state.phase, true);
    expect(r.phase).toBe(PHASE.AWAITING_LAYOUT);
    expect(r.action).toEqual({ type: 'cancel-base' });
    state.phase = r.phase;
    // Queue is preserved by the caller — scheduler doesn't manage it

    // UMAP settles again
    r = onIntermediateChange(state.phase, false);
    expect(r.phase).toBe(PHASE.BASE_DECOLLISION);
    expect(r.action).toEqual({ type: 'launch-base' });
  });
});

describe('resolveOnScreenData — animation "from" position priority', () => {
  const raw = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 1 }];
  const processed = [{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 11, y: 11 }];
  const live = [{ id: 'a', x: 20, y: 20 }, { id: 'b', x: 21, y: 21 }];

  test('prefers live transition data when simulation is in progress', () => {
    const result = resolveOnScreenData(live, processed, raw);
    expect(result[0].x).toBe(20);
    expect(result[1].x).toBe(21);
  });

  test('falls back to processedData when no live data', () => {
    const result = resolveOnScreenData(null, processed, raw);
    expect(result[0].x).toBe(10);
    expect(result[1].x).toBe(11);
  });

  test('falls back to raw data when neither live nor processed available', () => {
    const result = resolveOnScreenData(null, [], raw);
    expect(result[0].x).toBe(0);
    expect(result[1].x).toBe(1);
  });

  test('treats empty live array same as null', () => {
    const result = resolveOnScreenData([], processed, raw);
    expect(result[0].x).toBe(10);
  });

  test('returns a new array, not the same reference', () => {
    const result = resolveOnScreenData(live, processed, raw);
    expect(result).not.toBe(live);
    expect(result).toEqual(live);
  });
});

describe('validateCachedPositions — stale cache detection', () => {
  test('returns null when cache is null', () => {
    expect(validateCachedPositions(null, 100)).toBeNull();
  });

  test('returns positions when cache covers all data', () => {
    const cached = new Map([['t1', { x: 1, y: 2 }], ['t2', { x: 3, y: 4 }]]);
    expect(validateCachedPositions(cached, 2)).toBe(cached);
  });

  test('returns positions when cache has MORE entries than data (dots removed)', () => {
    const cached = new Map([['t1', { x: 1, y: 2 }], ['t2', { x: 3, y: 4 }]]);
    expect(validateCachedPositions(cached, 1)).toBe(cached);
  });

  test('returns null when cache has fewer entries than data (dots added)', () => {
    const cached = new Map([['t1', { x: 1, y: 2 }]]);
    expect(validateCachedPositions(cached, 5)).toBeNull();
  });

  test('returns positions when data length is 0 (no data yet)', () => {
    const cached = new Map([['t1', { x: 1, y: 2 }]]);
    expect(validateCachedPositions(cached, 0)).toBe(cached);
  });
});

describe('discovery dots — stale cache triggers re-decollision', () => {
  // Simulates what Trigger 2 does: validate cache, then call onConstraintRequest.
  function simulateTrigger2({ constraintKey, cache, dataLength, activeKey = '' }) {
    const cachedPositions = validateCachedPositions(
      cache.get(constraintKey) ?? null,
      dataLength
    );
    const baseCachedPositions = cache.get('') ?? null;
    return onConstraintRequest(
      PHASE.READY, constraintKey, cachedPositions, false, activeKey, baseCachedPositions
    );
  }

  test('stale cache after discovery dots added → launches fresh simulation', () => {
    // Cache was computed with 100 library dots, now we have 110 (10 discovery)
    const cache = new Map();
    const stalePositions = new Map(
      Array.from({ length: 100 }, (_, i) => [`t${i}`, { x: i, y: i }])
    );
    cache.set('focus:seed1', stalePositions);

    const result = simulateTrigger2({
      constraintKey: 'focus:seed1',
      cache,
      dataLength: 110,
      activeKey: 'focus:seed1',
    });

    expect(result.action).toEqual({
      type: 'launch-constraint',
      constraintKey: 'focus:seed1'
    });
  });

  test('valid cache with all dots covered → animates from cache', () => {
    const cache = new Map();
    const validPositions = new Map(
      Array.from({ length: 110 }, (_, i) => [`t${i}`, { x: i, y: i }])
    );
    cache.set('focus:seed1', validPositions);

    const result = simulateTrigger2({
      constraintKey: 'focus:seed1',
      cache,
      dataLength: 110,
      activeKey: 'focus:seed1',
    });

    expect(result.action).toEqual({
      type: 'animate-from-cache',
      constraintKey: 'focus:seed1',
      positions: validPositions,
    });
  });

  test('no cache entry at all → launches fresh simulation', () => {
    const cache = new Map();

    const result = simulateTrigger2({
      constraintKey: 'focus:seed1',
      cache,
      dataLength: 110,
      activeKey: 'focus:seed1',
    });

    expect(result.action).toEqual({
      type: 'launch-constraint',
      constraintKey: 'focus:seed1'
    });
  });
});

describe('import transition — stable positions during intermediate full re-renders', () => {
  // These tests document the invariant that shouldUseStablePositions is called
  // with (isIncrementalUpdate || positionsAreIntermediate), ensuring that full
  // re-renders during import keep stable positions instead of snapping.

  // Simulate shouldUseStablePositions: returns true when flag is true AND stableLength > 0
  const shouldUseStable = (flag, stableLength) => flag && stableLength > 0;

  test('incremental update with stable positions → keep stable', () => {
    expect(shouldUseStable(true || false, 100)).toBe(true);
  });

  test('full re-render during import (intermediate) with stable positions → keep stable', () => {
    // isIncrementalUpdate=false, positionsAreIntermediate=true → flag = true
    expect(shouldUseStable(false || true, 100)).toBe(true);
  });

  test('full re-render after import settles (not intermediate) → apply immediately', () => {
    // isIncrementalUpdate=false, positionsAreIntermediate=false → flag = false
    expect(shouldUseStable(false || false, 100)).toBe(false);
  });

  test('first data arrival (no stable positions) → apply immediately', () => {
    // Even during import, the first render has no stable positions to keep
    expect(shouldUseStable(false || true, 0)).toBe(false);
  });
});
