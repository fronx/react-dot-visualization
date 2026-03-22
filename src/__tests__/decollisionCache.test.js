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
