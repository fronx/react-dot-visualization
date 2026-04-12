import { describe, it, expect } from 'vitest';
import { DecollisionPositionCache } from '../DecollisionPositionCache.js';
import { DecollisionCacheManager, planCacheTransition } from '../useDecollisionCache.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

const pos = (id, x, y) => ({ id, x, y });

// ── DecollisionPositionCache ──────────────────────────────────────────────────

describe('DecollisionPositionCache', () => {
  it('stores and retrieves positions by key', () => {
    const cache = new DecollisionPositionCache();
    cache.store('base', [pos('a', 1, 2), pos('b', 3, 4)]);
    const result = cache.get('base');
    expect(result.size).toBe(2);
    expect(result.get('a')).toEqual({ x: 1, y: 2 });
  });

  it('returns null for unknown keys', () => {
    const cache = new DecollisionPositionCache();
    expect(cache.get('unknown')).toBeNull();
  });

  it('clear removes everything', () => {
    const cache = new DecollisionPositionCache();
    cache.store('', [pos('a', 1, 1)]);
    cache.store('x', [pos('a', 2, 2)]);
    cache.clear();
    expect(cache.has('')).toBe(false);
    expect(cache.has('x')).toBe(false);
  });

  it('evicts oldest transient when exceeding cap, keeping base', () => {
    const cache = new DecollisionPositionCache();
    cache.store('', [pos('a', 0, 0)]);
    for (let i = 1; i <= 6; i++) cache.store(`f:${i}`, [pos('a', i, i)]);
    expect(cache.has('')).toBe(true);
    expect(cache.has('f:1')).toBe(false);
    expect(cache.has('f:6')).toBe(true);
  });

  it('renameId moves position from old ID to new ID across all entries', () => {
    const cache = new DecollisionPositionCache();
    cache.store('', [pos('bc_1', 1, 2), pos('lib-2', 3, 4)]);
    cache.store('focus:abc', [pos('bc_1', 5, 6), pos('lib-2', 7, 8)]);

    cache.renameId('bc_1', 'lib-uuid-1');

    // Base entry: old ID gone, new ID present
    const base = cache.get('');
    expect(base.has('bc_1')).toBe(false);
    expect(base.get('lib-uuid-1')).toEqual({ x: 1, y: 2 });
    expect(base.get('lib-2')).toEqual({ x: 3, y: 4 });

    // Constraint entry: same rename
    const constraint = cache.get('focus:abc');
    expect(constraint.has('bc_1')).toBe(false);
    expect(constraint.get('lib-uuid-1')).toEqual({ x: 5, y: 6 });
  });

  it('renameId is a no-op when old ID does not exist', () => {
    const cache = new DecollisionPositionCache();
    cache.store('', [pos('a', 1, 1)]);
    cache.renameId('nonexistent', 'new-id');
    expect(cache.get('').size).toBe(1);
    expect(cache.get('').get('a')).toEqual({ x: 1, y: 1 });
  });
});

// ── DecollisionCacheManager.resolve ───────────────────────────────────────────

describe('DecollisionCacheManager.resolve', () => {
  it('returns unchanged when keys have not changed', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve('scope', '');
    const r = mgr.resolve('scope', '');
    expect(r.source).toBe('unchanged');
  });

  it('returns fresh and clears cache on scope change', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve('scope-1', '');
    mgr.store('', [pos('a', 1, 1)]);

    const r = mgr.resolve('scope-2', '');
    expect(r.source).toBe('fresh');
    expect(mgr.cache.has('')).toBe(false);
  });

  it('returns exact hit when constraint was previously stored', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve('s', '');
    mgr.store('', [pos('a', 1, 1)]);

    // Activate highlight
    const r1 = mgr.resolve('s', 'hl:x');
    expect(r1.source).toBe('base-fallback');

    mgr.store('hl:x', [pos('a', 5, 5)]);

    // Deactivate → exact hit on base
    const r2 = mgr.resolve('s', '');
    expect(r2.source).toBe('exact');
    expect(r2.positions.get('a')).toEqual({ x: 1, y: 1 });
  });

  it('falls back to base when incoming constraint is unknown', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve('s', '');
    mgr.store('', [pos('a', 1, 1)]);

    const r = mgr.resolve('s', 'focus:abc');
    expect(r.source).toBe('base-fallback');
    expect(r.positions.get('a')).toEqual({ x: 1, y: 1 });
  });

  it('returns fresh when nothing is cached', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve('s', '');
    const r = mgr.resolve('s', 'hl:x');
    expect(r.source).toBe('fresh');
  });
});

// ── Full interaction sequences ────────────────────────────────────────────────

describe('interaction sequences', () => {
  const SCOPE = 'collection:demo';
  const basePositions = [pos('a', 1, 1), pos('b', 2, 2), pos('c', 3, 3)];
  const highlightDecollided = [pos('a', 1.5, 1.5), pos('b', 4, 4), pos('c', 3, 3)];

  it('base → highlight → base round-trip restores exact positions', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    mgr.store('', basePositions);

    // Activate highlight
    const r1 = mgr.resolve(SCOPE, 'hl:a,b');
    expect(r1.source).toBe('base-fallback');
    mgr.store('hl:a,b', highlightDecollided);

    // Deactivate
    const r2 = mgr.resolve(SCOPE, '');
    expect(r2.source).toBe('exact');
    expect(r2.positions.get('a')).toEqual({ x: 1, y: 1 });
    expect(r2.positions.get('b')).toEqual({ x: 2, y: 2 });
  });

  it('focus:A → focus:B falls back to base, not raw UMAP', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    mgr.store('', basePositions);

    // Focus A
    const r1 = mgr.resolve(SCOPE, 'focus:A');
    expect(r1.source).toBe('base-fallback');
    mgr.store('focus:A', [pos('a', 10, 10), pos('b', 2, 2), pos('c', 3, 3)]);

    // Switch to focus B
    const r2 = mgr.resolve(SCOPE, 'focus:B');
    expect(r2.source).toBe('base-fallback');
    expect(r2.positions.get('a')).toEqual({ x: 1, y: 1 });
  });

  it('focus → base is an exact restore', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    mgr.store('', basePositions);

    mgr.resolve(SCOPE, 'focus:A');
    mgr.store('focus:A', [pos('a', 10, 10), pos('b', 2, 2), pos('c', 3, 3)]);

    const r = mgr.resolve(SCOPE, '');
    expect(r.source).toBe('exact');
    expect(r.positions.get('a')).toEqual({ x: 1, y: 1 });
  });

  it('re-selecting same playlist is an exact hit with pushed-apart positions', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    mgr.store('', basePositions);

    // First activation + decollision
    mgr.resolve(SCOPE, 'hl:a,b');
    mgr.store('hl:a,b', highlightDecollided);

    // Deactivate
    mgr.resolve(SCOPE, '');

    // Re-activate same playlist — exact hit with PUSHED-APART positions
    const r = mgr.resolve(SCOPE, 'hl:a,b');
    expect(r.source).toBe('exact');
    expect(r.positions.get('a')).toEqual({ x: 1.5, y: 1.5 });
    expect(r.positions.get('b')).toEqual({ x: 4, y: 4 });
  });

  it('repeated playlist cycles preserve correct positions (was a bug)', () => {
    // Previously, resolve() saved stale memoizedPositions over the store() result.
    // Now resolve() never writes — only store() does.
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    mgr.store('', basePositions);

    for (let cycle = 0; cycle < 5; cycle++) {
      // Activate
      const rActivate = mgr.resolve(SCOPE, 'hl:a,b');
      if (cycle === 0) {
        expect(rActivate.source).toBe('base-fallback');
      } else {
        expect(rActivate.source).toBe('exact');
        // Must be pushed-apart positions, not base
        expect(rActivate.positions.get('b')).toEqual({ x: 4, y: 4 });
      }
      mgr.store('hl:a,b', highlightDecollided);

      // Deactivate
      const rDeactivate = mgr.resolve(SCOPE, '');
      expect(rDeactivate.source).toBe('exact');
      expect(rDeactivate.positions.get('a')).toEqual({ x: 1, y: 1 });
    }
  });

  it('scope change wipes cache — subsequent restore is fresh', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    mgr.store('', basePositions);

    mgr.resolve('collection:other', '');
    expect(mgr.cache.has('')).toBe(false);

    const r = mgr.resolve('collection:other', 'hl:x');
    expect(r.source).toBe('fresh');
  });

  it('rapid: scope change then immediate highlight (base never stored)', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve('scope-old', '');
    mgr.store('', basePositions);

    // Scope changes — cache cleared
    mgr.resolve('scope-new', '');

    // User immediately activates highlight before base decollision completes
    const r = mgr.resolve('scope-new', 'hl:x');
    expect(r.source).toBe('fresh');
  });
});

// ── planCacheTransition ───────────────────────────────────────────────────────

describe('planCacheTransition', () => {
  const validData = [pos('a', 0, 0), pos('b', 0, 0)];
  const onScreen = [pos('a', 5, 5), pos('b', 6, 6)];

  it('returns null for unchanged', () => {
    const plan = planCacheTransition({ source: 'unchanged', positions: null }, { currentOnScreen: onScreen, validData });
    expect(plan).toBeNull();
  });

  it('returns animate plan for exact hit', () => {
    const cached = new Map([['a', { x: 1, y: 1 }], ['b', { x: 2, y: 2 }]]);
    const plan = planCacheTransition({ source: 'exact', positions: cached }, { currentOnScreen: onScreen, validData });
    expect(plan.type).toBe('animate');
    expect(plan.from).toBe(onScreen);
    expect(plan.to[0]).toMatchObject({ id: 'a', x: 1, y: 1 });
    expect(plan.to[1]).toMatchObject({ id: 'b', x: 2, y: 2 });
  });

  it('returns decollide plan with positions for base-fallback', () => {
    const base = new Map([['a', { x: 1, y: 1 }]]);
    const plan = planCacheTransition({ source: 'base-fallback', positions: base }, { currentOnScreen: onScreen, validData });
    expect(plan.type).toBe('decollide');
    expect(plan.positions).toBe(base);
  });

  it('returns decollide plan with null positions for fresh', () => {
    const plan = planCacheTransition({ source: 'fresh', positions: null }, { currentOnScreen: onScreen, validData });
    expect(plan.type).toBe('decollide');
    expect(plan.positions).toBeNull();
  });
});

// ── Cache as memoizedPositions replacement ──────────────────────────────────
//
// These tests verify the invariant that makes memoizedPositions redundant:
// after store() is called, cache.get(constraintKey) provides the same data
// that memoizedPositions would have, at every point the data effect needs it.

describe('cache readability after store (memoizedPositions replacement invariant)', () => {
  const SCOPE = 'collection:test';
  const rawUMAP = [pos('a', 0, 0), pos('b', 1, 1), pos('c', 2, 2)];
  const baseDecollided = [pos('a', 0.1, 0.1), pos('b', 1.2, 1.2), pos('c', 2.3, 2.3)];
  const hlDecollided = [pos('a', 0.5, 0.5), pos('b', 3, 3), pos('c', 2.3, 2.3)];

  it('after base decollision completes, cache.get("") has positions for unchanged re-renders', () => {
    const mgr = new DecollisionCacheManager();
    // First render: resolve initializes scope
    mgr.resolve(SCOPE, '');
    // Decollision completes:
    mgr.store('', baseDecollided);
    // Subsequent unchanged resolve (unrelated re-render trigger):
    const r = mgr.resolve(SCOPE, '');
    expect(r.source).toBe('unchanged');
    // The caller needs positions — cache.get must provide them
    const cached = mgr.cache.get('');
    expect(cached).not.toBeNull();
    expect(cached.get('a')).toEqual({ x: 0.1, y: 0.1 });
    expect(cached.get('b')).toEqual({ x: 1.2, y: 1.2 });
  });

  it('after constraint decollision completes, cache.get(key) has positions for unchanged re-renders', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    mgr.store('', baseDecollided);
    // Activate highlight:
    mgr.resolve(SCOPE, 'hl:x');
    mgr.store('hl:x', hlDecollided);
    // Unrelated re-render:
    const r = mgr.resolve(SCOPE, 'hl:x');
    expect(r.source).toBe('unchanged');
    // cache.get must have the highlight-decollided positions
    const cached = mgr.cache.get('hl:x');
    expect(cached).not.toBeNull();
    expect(cached.get('b')).toEqual({ x: 3, y: 3 });
  });

  it('cache.size > 0 matches hasMemoizedPositions semantics after base store', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    expect(mgr.cache.size).toBe(0); // nothing stored yet
    mgr.store('', baseDecollided);
    expect(mgr.cache.size).toBeGreaterThan(0); // has base → "skip-cached"
  });

  it('cache.size > 0 after constraint switch with base-fallback (before constraint store)', () => {
    // This is the Render A scenario: constraint just changed, base was seeded,
    // but the new constraint hasn't been decollided yet.
    // memoizedPositions would have base positions (seeded by cachePlan).
    // cache must also have something (base entry) so skip-cached works.
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    mgr.store('', baseDecollided);
    // Constraint changes — resolve returns base-fallback
    const r = mgr.resolve(SCOPE, 'hl:new');
    expect(r.source).toBe('base-fallback');
    // cache still has the base entry even though 'hl:new' isn't stored yet
    expect(mgr.cache.size).toBeGreaterThan(0);
    expect(mgr.cache.has('')).toBe(true);
    expect(mgr.cache.has('hl:new')).toBe(false);
  });

  it('cache.size === 0 after scope change (matches empty memoizedPositions on remount)', () => {
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    mgr.store('', baseDecollided);
    mgr.store('hl:x', hlDecollided);
    expect(mgr.cache.size).toBe(2);
    // Scope changes (e.g., refreshNonce)
    mgr.resolve('collection:other', '');
    expect(mgr.cache.size).toBe(0);
  });

  it('store() and resolve() in completion callback order: both available before next read', () => {
    // Simulates the exact completion callback sequence:
    // 1. syncDecollisionState (would write memoizedPositions)
    // 2. store(constraintKey, finalData)
    // 3. React re-renders → data effect → resolve() returns unchanged → needs cache.get()
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    mgr.store('', baseDecollided);
    mgr.resolve(SCOPE, 'hl:x');
    // --- decollision runs ---
    // Completion: store is called
    mgr.store('hl:x', hlDecollided);
    // React re-renders, data effect runs:
    const r = mgr.resolve(SCOPE, 'hl:x');
    expect(r.source).toBe('unchanged');
    // Position restore reads from cache:
    const cached = mgr.cache.get('hl:x');
    expect(cached.get('a')).toEqual({ x: 0.5, y: 0.5 });
    expect(cached.get('b')).toEqual({ x: 3, y: 3 });
  });

  it('cachePlan.to already carries exact-hit positions (no cache.get needed)', () => {
    // For 'animate' plans, the positions are in the plan itself.
    // Verify planCacheTransition embeds the right positions in .to
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    mgr.store('', baseDecollided);
    mgr.resolve(SCOPE, 'hl:x');
    mgr.store('hl:x', hlDecollided);
    // Deactivate → exact hit
    const resolution = mgr.resolve(SCOPE, '');
    expect(resolution.source).toBe('exact');
    const plan = planCacheTransition(resolution, {
      currentOnScreen: hlDecollided, // what's on screen now
      validData: rawUMAP,
    });
    expect(plan.type).toBe('animate');
    // plan.to has base positions applied to validData
    expect(plan.to[0]).toMatchObject({ id: 'a', x: 0.1, y: 0.1 });
    expect(plan.to[1]).toMatchObject({ id: 'b', x: 1.2, y: 1.2 });
  });

  it('renameId preserves decollided position for promoted discovery dot', () => {
    // Scenario: discovery dot bc_1 is decollided at (5, 6) under focus:abc.
    // User adopts the track → ID changes to lib-uuid. Without renameId,
    // restoreDecollisionedPositions falls back to raw UMAP (0, 0).
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    mgr.store('', [pos('a', 1, 1), pos('bc_1', 3, 3)]);
    mgr.resolve(SCOPE, 'focus:abc');
    mgr.store('focus:abc', [pos('a', 1.5, 1.5), pos('bc_1', 5, 6)]);

    // Promote: rename in cache
    mgr.cache.renameId('bc_1', 'lib-uuid');

    // restoreDecollisionedPositions should find the promoted dot's position
    const cached = mgr.cache.get('focus:abc');
    expect(cached.get('lib-uuid')).toEqual({ x: 5, y: 6 });
    expect(cached.has('bc_1')).toBe(false);
  });

  it('cachePlan.positions carries base-fallback positions directly', () => {
    // For 'decollide' plans with base-fallback, positions is the base Map.
    // Can be read directly without going through memoizedPositions.
    const mgr = new DecollisionCacheManager();
    mgr.resolve(SCOPE, '');
    mgr.store('', baseDecollided);
    const resolution = mgr.resolve(SCOPE, 'hl:new');
    expect(resolution.source).toBe('base-fallback');
    const plan = planCacheTransition(resolution, {
      currentOnScreen: baseDecollided,
      validData: rawUMAP,
    });
    expect(plan.type).toBe('decollide');
    expect(plan.positions.get('a')).toEqual({ x: 0.1, y: 0.1 });
  });
});
