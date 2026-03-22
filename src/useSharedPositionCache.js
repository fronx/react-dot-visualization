import { useRef } from 'react';
import { DecollisionPositionCache } from './DecollisionPositionCache.js';

/**
 * Creates a shared, keyed position cache that survives renderer switches
 * and constraint changes (focus, playlist, browser selection).
 *
 * Positions are stored per constraint key. When switching constraints,
 * the cache can restore previously computed positions instantly
 * instead of re-running decollision.
 *
 * Usage:
 *   const positionCache = useSharedPositionCache();
 *   <DotVisualization sharedPositionCache={positionCache} cacheKey={constraintKey} ... />
 */
export function useSharedPositionCache() {
  const cache = useRef(null);
  if (!cache.current) {
    cache.current = new DecollisionPositionCache();
  }
  return cache;
}
