import { useRef, useEffect } from 'react';

/**
 * Creates a shared position cache that survives renderer switches.
 *
 * When two renderers (e.g. R3F and SVG/Canvas) share this cache, the new renderer
 * immediately seeds its own memoizedPositions on mount — showing decollisioned positions
 * in the first frame without running a catch-up simulation.
 *
 * Each renderer automatically writes back to the cache when its decollision completes.
 *
 * Usage:
 *   const positionCache = useSharedPositionCache(cacheKey);
 *   <DotVisualization sharedPositionCache={positionCache} ... />
 *   <DotVisualizationR3F sharedPositionCache={positionCache} ... />
 */
export function useSharedPositionCache(cacheKey = 'default') {
  const cache = useRef(new Map());
  const prevCacheKey = useRef(cacheKey);

  useEffect(() => {
    if (prevCacheKey.current !== cacheKey) {
      cache.current.clear();
      prevCacheKey.current = cacheKey;
    }
  }, [cacheKey]);

  return cache;
}
