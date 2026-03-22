import { useRef } from 'react';
import { DecollisionPositionCache } from './DecollisionPositionCache.js';

/**
 * Manages cached decollision positions across constraint changes.
 *
 * Two key concepts:
 * - scopeKey: collection + checkpoint + sources. When scope changes, ALL cached
 *   positions are invalidated (they belong to a different dataset).
 * - constraintKey: highlight + focus. Different constraints produce different
 *   dot sizes → different decollision layouts. The base state is "" (no constraint).
 *
 * On constraint change: save outgoing positions, restore incoming (if cached).
 * On scope change: clear everything.
 *
 * Call resolve() during render (before memoizedPositions are consumed).
 * Call store() when decollision completes.
 */
export function useDecollisionCache() {
  const cacheRef = useRef(null);
  if (!cacheRef.current) {
    cacheRef.current = new DecollisionPositionCache();
  }

  const prevScopeKeyRef = useRef(null);
  const prevConstraintKeyRef = useRef('');

  /**
   * Called during render to handle key transitions.
   *
   * @param {string} scopeKey - Dataset scope (collection, checkpoint, sources)
   * @param {string} constraintKey - Dot size constraints (highlight, focus). "" = base.
   * @param {Map} currentPositions - Current memoized positions (will be saved under outgoing key)
   * @returns {{ positions: Map|null, source: 'cache'|'fresh'|'unchanged' }}
   */
  function resolve(scopeKey, constraintKey, currentPositions) {
    const cache = cacheRef.current;

    // Scope changed — invalidate everything
    if (prevScopeKeyRef.current !== null && prevScopeKeyRef.current !== scopeKey) {
      console.log('[cache] scope changed:', prevScopeKeyRef.current, '→', scopeKey, '— clearing all cached positions');
      cache.clear();
      prevScopeKeyRef.current = scopeKey;
      prevConstraintKeyRef.current = constraintKey;
      return { positions: null, source: 'fresh' };
    }
    prevScopeKeyRef.current = scopeKey;

    // Constraint unchanged — no-op
    if (prevConstraintKeyRef.current === constraintKey) {
      return { positions: null, source: 'unchanged' };
    }

    // Constraint changed — save outgoing, restore incoming
    const prevConstraint = prevConstraintKeyRef.current;
    prevConstraintKeyRef.current = constraintKey;

    // Save current positions under the outgoing constraint
    if (currentPositions.size > 0) {
      const positions = Array.from(currentPositions.entries()).map(
        ([id, pos]) => ({ id, x: pos.x, y: pos.y })
      );
      cache.store(prevConstraint, positions);
    }

    // Evict old transient entries (keep base)
    if (constraintKey !== '') {
      cache.evictTransient();
      // Re-store the outgoing positions we just saved (evictTransient clears non-base)
      if (currentPositions.size > 0 && prevConstraint !== '') {
        // Don't bother re-storing a transient we just evicted — only base matters
      }
    }

    // Try to restore cached positions for the incoming constraint
    const cached = cache.get(constraintKey);
    if (cached && cached.size > 0) {
      return { positions: cached, source: 'cache' };
    }

    return { positions: null, source: 'fresh' };
  }

  /**
   * Called when decollision completes to cache the result.
   *
   * @param {string} constraintKey - The constraint key active during this decollision
   * @param {Array<{id: string|number, x: number, y: number}>} positions - Final decollided positions
   */
  function store(constraintKey, positions) {
    cacheRef.current.store(constraintKey, positions);
  }

  return { resolve, store };
}
