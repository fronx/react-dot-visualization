import { describe, it, expect } from 'vitest';
import { DecollisionPositionCache } from '../DecollisionPositionCache.js';

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

  it('evicts oldest transient when exceeding cap, keeping base', () => {
    const cache = new DecollisionPositionCache();
    cache.store('', [{ id: 'a', x: 0, y: 0 }]); // base — protected

    // Fill up to cap (5 transient entries)
    for (let i = 1; i <= 5; i++) {
      cache.store(`focus:${i}`, [{ id: 'a', x: i, y: i }]);
    }
    expect(cache.size).toBe(6); // base + 5 transient

    // Adding one more should evict the oldest transient (focus:1)
    cache.store('focus:6', [{ id: 'a', x: 6, y: 6 }]);
    expect(cache.size).toBe(6); // still 6
    expect(cache.has('')).toBe(true); // base preserved
    expect(cache.has('focus:1')).toBe(false); // oldest evicted
    expect(cache.has('focus:6')).toBe(true); // newest kept
  });

  it('base key is never evicted by transient pressure', () => {
    const cache = new DecollisionPositionCache();
    cache.store('', [{ id: 'a', x: 0, y: 0 }]);

    // Add many transient entries
    for (let i = 1; i <= 20; i++) {
      cache.store(`hl:${i}`, [{ id: 'a', x: i, y: i }]);
    }

    expect(cache.has('')).toBe(true);
    expect(cache.get('').get('a')).toEqual({ x: 0, y: 0 });
  });

  it('tracks size correctly', () => {
    const cache = new DecollisionPositionCache();
    expect(cache.size).toBe(0);
    cache.store('a', [{ id: 'x', x: 1, y: 1 }]);
    expect(cache.size).toBe(1);
    cache.store('b', [{ id: 'x', x: 2, y: 2 }]);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
