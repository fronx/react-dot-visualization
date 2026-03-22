/**
 * Caches decollisioned positions keyed by constraint configuration.
 *
 * Different dot size constraints (focus, playlist, browser selection) produce
 * different decollision results. This cache stores each result so transitions
 * between states can restore known-good positions instead of re-running
 * decollision from raw UMAP coordinates.
 *
 * The base key ("") is always protected — it's the clean, no-constraint layout
 * that every other state transitions through. It's only invalidated on scope
 * changes (collection, checkpoint, source filters) or node count changes.
 *
 * Transient entries (specific focus/highlight states) are capped to prevent
 * unbounded growth. When the cap is exceeded, the oldest transient is evicted.
 */
const MAX_TRANSIENT_ENTRIES = 5;

export class DecollisionPositionCache {
  constructor() {
    /** @type {Map<string, Map<string|number, {x: number, y: number}>>} */
    this._entries = new Map();
  }

  /** Store positions for a constraint key. Evicts oldest transient if cap exceeded. */
  store(key, positions) {
    const map = new Map();
    for (const node of positions) {
      map.set(node.id, { x: node.x, y: node.y });
    }
    this._entries.set(key, map);
    this._evictIfNeeded();
  }

  /** Retrieve cached positions for a constraint key, or null. */
  get(key) {
    return this._entries.get(key) || null;
  }

  /** Check if a key has cached positions. */
  has(key) {
    return this._entries.has(key);
  }

  /** Clear everything (scope invalidation). */
  clear() {
    this._entries.clear();
  }

  /** Number of cached entries (for diagnostics). */
  get size() {
    return this._entries.size;
  }

  /** @private Evict oldest transient entry if over cap. Base ("") is protected. */
  _evictIfNeeded() {
    const transientCount = this._entries.has('') ? this._entries.size - 1 : this._entries.size;
    if (transientCount <= MAX_TRANSIENT_ENTRIES) return;

    // Evict the oldest transient (first non-base key in insertion order)
    for (const key of this._entries.keys()) {
      if (key !== '') {
        this._entries.delete(key);
        break;
      }
    }
  }
}
