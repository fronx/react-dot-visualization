import { useRef, useEffect } from 'react';
import { useDebug } from './useDebug.js';

/**
 * A generic cache hook for expensive computations.
 * Automatically invalidates when dependencies change.
 *
 * @param {Array} dependencies - Array of values that should trigger cache invalidation
 * @param {Object} options - Configuration options
 * @param {boolean} options.debug - Whether to log cache hit rate (default: false)
 * @param {string} options.name - Name for logging purposes (default: 'useCache')
 * @param {number} options.logInterval - How often to log stats in ms (default: 2000)
 * @returns {Object} Cache interface with getCached() method and version property
 */
export const useCache = (dependencies = [], options = {}) => {
  const {
    debug = false,
    name = 'useCache',
    logInterval = 2000
  } = options;

  const debugLog = useDebug(debug);

  const cache = useRef(new Map());
  const version = useRef(0);
  const stats = useRef({ hits: 0, misses: 0, lastLog: 0 });

  // Invalidate cache when dependencies change
  useEffect(() => {
    cache.current.clear();
    version.current += 1;
    stats.current = { hits: 0, misses: 0, lastLog: 0 };

    debugLog(`[${name}] Cache invalidated (version ${version.current})`);
  }, dependencies);

  /**
   * Get cached value or compute and cache it
   * @param {string|number} key - Unique key for the cached item
   * @param {Function} compute - Function to compute the value if not cached
   * @param {boolean} skipCache - If true, always compute (for dynamic values)
   */
  const getCached = (key, compute, skipCache = false) => {
    // Include version in cache key to auto-invalidate old entries
    const cacheKey = `${key}_${version.current}`;

    if (!skipCache && cache.current.has(cacheKey)) {
      if (debug) {
        stats.current.hits += 1;
        logStatsIfNeeded();
      }
      return cache.current.get(cacheKey);
    }

    // Cache miss - compute the value
    if (debug && !skipCache) {
      stats.current.misses += 1;
    }

    const value = compute();

    // Store in cache unless explicitly skipped
    if (!skipCache) {
      cache.current.set(cacheKey, value);
    }

    return value;
  };

  const logStatsIfNeeded = () => {
    const now = Date.now();
    if (now - stats.current.lastLog > logInterval) {
      const total = stats.current.hits + stats.current.misses;
      const hitRate = total > 0 ? ((stats.current.hits / total) * 100).toFixed(1) : 0;
      debugLog(`[${name}] Hit rate: ${hitRate}% (${stats.current.hits}/${total})`);
      stats.current.lastLog = now;
    }
  };

  return { getCached, version: version.current };
};
