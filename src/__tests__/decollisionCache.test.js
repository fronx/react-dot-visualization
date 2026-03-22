import { describe, it, expect } from 'vitest';
import { DecollisionPositionCache } from '../DecollisionPositionCache.js';
import { resolvePositionsForKey } from '../useDecollisionCache.js';

describe('DecollisionPositionCache', () => {
  it('stores and retrieves positions by key', () => {
    const cache = new DecollisionPositionCache();
    cache.store('base', [{ id: 'a', x: 1, y: 2 }, { id: 'b', x: 3, y: 4 }]);

    const result = cache.get('base');
    expect(result.size).toBe(2);
    expect(result.get('a')).toEqual({ x: 1, y: 2 });
    expect(result.get('b')).toEqual({ x: 3, y: 4 });
  });

  it('returns null for unknown keys', () => {
    const cache = new DecollisionPositionCache();
    expect(cache.get('unknown')).toBeNull();
  });

  it('has() checks key existence', () => {
    const cache = new DecollisionPositionCache();
    expect(cache.has('x')).toBe(false);
    cache.store('x', [{ id: 'a', x: 0, y: 0 }]);
    expect(cache.has('x')).toBe(true);
  });

  it('evictTransient keeps only the base key', () => {
    const cache = new DecollisionPositionCache();
    cache.store('', [{ id: 'a', x: 1, y: 1 }]);
    cache.store('hl:b,c', [{ id: 'a', x: 2, y: 2 }]);
    cache.store('focus:d', [{ id: 'a', x: 3, y: 3 }]);

    cache.evictTransient();
    expect(cache.has('')).toBe(true);
    expect(cache.has('hl:b,c')).toBe(false);
    expect(cache.has('focus:d')).toBe(false);
  });

  it('clear removes everything', () => {
    const cache = new DecollisionPositionCache();
    cache.store('', [{ id: 'a', x: 1, y: 1 }]);
    cache.store('x', [{ id: 'a', x: 2, y: 2 }]);
    cache.clear();
    expect(cache.has('')).toBe(false);
    expect(cache.has('x')).toBe(false);
  });

  it('overwrites existing key', () => {
    const cache = new DecollisionPositionCache();
    cache.store('k', [{ id: 'a', x: 1, y: 1 }]);
    cache.store('k', [{ id: 'a', x: 9, y: 9 }]);
    expect(cache.get('k').get('a')).toEqual({ x: 9, y: 9 });
  });
});

describe('resolvePositionsForKey', () => {
  it('saves current positions under previous key and returns cached for new key', () => {
    const cache = new DecollisionPositionCache();
    // Pre-populate cache with base positions
    cache.store('base', [{ id: 'a', x: 10, y: 20 }]);

    // Simulate switching from highlight back to base
    const currentPositions = new Map([['a', { x: 50, y: 60 }]]);
    const result = resolvePositionsForKey(cache, 'hl:x', 'base', currentPositions);

    // Should return cached base positions
    expect(result.source).toBe('cache');
    expect(result.positions.get('a')).toEqual({ x: 10, y: 20 });

    // Should have saved current positions under old key
    expect(cache.get('hl:x').get('a')).toEqual({ x: 50, y: 60 });
  });

  it('returns fresh when no cache exists for new key', () => {
    const cache = new DecollisionPositionCache();
    const currentPositions = new Map([['a', { x: 1, y: 2 }]]);
    const result = resolvePositionsForKey(cache, 'base', 'hl:x,y', currentPositions);

    expect(result.source).toBe('fresh');
    expect(result.positions).toBeNull();

    // Should have saved base positions
    expect(cache.get('base').get('a')).toEqual({ x: 1, y: 2 });
  });

  it('does not save when current positions are empty', () => {
    const cache = new DecollisionPositionCache();
    const result = resolvePositionsForKey(cache, 'old', 'new', new Map());

    expect(result.source).toBe('fresh');
    expect(cache.has('old')).toBe(false);
  });

  it('round-trips: base → highlight → base restores original positions', () => {
    const cache = new DecollisionPositionCache();
    const basePositions = new Map([
      ['a', { x: 1, y: 2 }],
      ['b', { x: 3, y: 4 }],
    ]);

    // Base → highlight: save base, no cache for highlight
    const r1 = resolvePositionsForKey(cache, 'base', 'hl:a', basePositions);
    expect(r1.source).toBe('fresh');

    // Simulate decollision completing for highlight
    const highlightedPositions = new Map([
      ['a', { x: 10, y: 20 }],
      ['b', { x: 30, y: 40 }],
    ]);
    cache.store('hl:a', Array.from(highlightedPositions.entries()).map(
      ([id, pos]) => ({ id, ...pos })
    ));

    // Highlight → base: save highlighted, restore base
    const r2 = resolvePositionsForKey(cache, 'hl:a', 'base', highlightedPositions);
    expect(r2.source).toBe('cache');
    expect(r2.positions.get('a')).toEqual({ x: 1, y: 2 });
    expect(r2.positions.get('b')).toEqual({ x: 3, y: 4 });
  });

  it('permutation-invariant keys work correctly', () => {
    const cache = new DecollisionPositionCache();
    cache.store('hl:a,b,c', [{ id: 'x', x: 1, y: 1 }]);

    // Same tracks, same sorted key
    const result = resolvePositionsForKey(cache, 'base', 'hl:a,b,c', new Map());
    expect(result.source).toBe('cache');
  });
});
