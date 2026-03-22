import { useRef } from 'react';
import { DecollisionPositionCache } from './DecollisionPositionCache.js';

/**
 * Pure decision logic for decollision position caching.
 *
 * Two key concepts:
 * - scopeKey: collection + checkpoint + sources. When scope changes, ALL cached
 *   positions are invalidated (they belong to a different dataset).
 * - constraintKey: highlight + focus. Different constraints produce different
 *   dot sizes → different decollision layouts. The base state is "" (no constraint).
 *
 * resolve() produces one of four outcomes:
 *   unchanged     — same keys, nothing to do
 *   exact         — incoming constraint was previously cached → pure transition
 *   base-fallback — incoming constraint is new, base available → decollide from base
 *   fresh         — nothing cached → decollide from raw positions
 */

// ── Plan builder ──────────────────────────────────────────────────────────────
//
// Turns a resolve() result + current rendering state into a concrete action plan.
// This is the single place that expresses what DotVisualization should do for
// each cache outcome. The decollision effect just executes the plan.

/**
 * @param {object} resolution - from resolve()
 * @param {object} context
 * @param {Array} context.currentOnScreen - dataRef.current (what's rendered now)
 * @param {Array} context.validData - incoming data with UMAP positions
 * @returns {null | { type: 'animate', from, to } | { type: 'decollide', positions: Map|null }}
 */
export function planCacheTransition(resolution, { currentOnScreen, validData }) {
  switch (resolution.source) {
    case 'unchanged':
      return null;

    case 'exact':
      // Exact cache hit: animate directly from current to cached positions.
      // No physics needed — the cached positions are already decollided.
      return {
        type: 'animate',
        from: currentOnScreen,
        to: validData.map(item => {
          const pos = resolution.positions.get(item.id);
          return pos ? { ...item, x: pos.x, y: pos.y } : item;
        }),
      };

    case 'base-fallback':
      // New constraint, but base positions available: seed from base,
      // then decollide with new dot sizes (physics needed).
      return { type: 'decollide', positions: resolution.positions };

    case 'fresh':
      // Nothing cached: decollide from raw UMAP positions.
      return { type: 'decollide', positions: null };

    default:
      return null;
  }
}

// ── Cache manager ─────────────────────────────────────────────────────────────

export class DecollisionCacheManager {
  constructor() {
    this.cache = new DecollisionPositionCache();
    this._prevScopeKey = null;
    this._prevConstraintKey = '';
  }

  /**
   * Resolve cache state for a key transition. Call during render.
   * @returns {{ positions: Map|null, source: 'exact'|'base-fallback'|'fresh'|'unchanged' }}
   */
  resolve(scopeKey, constraintKey) {
    // Scope changed — invalidate everything
    if (this._prevScopeKey !== null && this._prevScopeKey !== scopeKey) {
      this.cache.clear();
      this._prevScopeKey = scopeKey;
      this._prevConstraintKey = constraintKey;
      return { positions: null, source: 'fresh' };
    }
    this._prevScopeKey = scopeKey;

    // Constraint unchanged — no-op
    if (this._prevConstraintKey === constraintKey) {
      return { positions: null, source: 'unchanged' };
    }

    // Constraint changed — restore incoming (if cached).
    // We don't save here — store() is the only writer, called when
    // decollision completes with authoritative positions.
    this._prevConstraintKey = constraintKey;

    // Exact match → pure transition (no physics)
    const cached = this.cache.get(constraintKey);
    if (cached && cached.size > 0) {
      return { positions: cached, source: 'exact' };
    }

    // Base fallback → seed positions for decollision
    const base = this.cache.get('');
    if (base && base.size > 0) {
      return { positions: base, source: 'base-fallback' };
    }

    return { positions: null, source: 'fresh' };
  }

  /** Store decollision result under the constraint it was computed for. */
  store(constraintKey, positions) {
    this.cache.store(constraintKey, positions);
  }
}

// ── React hook ────────────────────────────────────────────────────────────────

/** Returns a ref-stable DecollisionCacheManager. */
export function useDecollisionCache() {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = new DecollisionCacheManager();
  }
  return ref.current;
}
