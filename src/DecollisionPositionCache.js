/**
 * Caches decollisioned positions keyed by constraint configuration.
 *
 * Different dot size constraints (focus, playlist, browser selection) produce
 * different decollision results. This cache stores each result so transitions
 * between states can animate to known-good positions instead of re-running
 * decollision.
 *
 * Eviction: only the base ("") key is retained long-term. All other entries
 * are evicted when a new constraint is activated, since transient states
 * (specific selections) are cheap to recompute and unlikely to repeat exactly.
 */
export class DecollisionPositionCache {
  constructor() {
    /** @type {Map<string, Map<string|number, {x: number, y: number}>>} */
    this._entries = new Map();
  }

  /** Store positions for a constraint key. */
  store(key, positions) {
    const map = new Map();
    for (const node of positions) {
      map.set(node.id, { x: node.x, y: node.y });
    }
    this._entries.set(key, map);
  }

  /** Retrieve cached positions for a constraint key, or null. */
  get(key) {
    return this._entries.get(key) || null;
  }

  /** Check if a key has cached positions. */
  has(key) {
    return this._entries.has(key);
  }

  /**
   * Evict transient entries, keeping only the base state.
   * Call when switching to a new transient constraint.
   */
  evictTransient() {
    const base = this._entries.get('');
    this._entries.clear();
    if (base) this._entries.set('', base);
  }

  /** Clear everything. */
  clear() {
    this._entries.clear();
  }
}
