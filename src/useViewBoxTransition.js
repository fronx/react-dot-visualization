import { useRef, useCallback } from 'react';
import * as d3 from 'd3';
import KalmanFilter from 'kalmanjs';

/**
 * Calculate a zoom transform that compensates for a viewBox change.
 * This transform makes the content stay visually in place when viewBox changes.
 *
 * Mathematical derivation:
 * A viewBox maps data coordinates p=(x,y) to pixels by: pixels = S(p - origin)
 * where S = diag(W/w, H/h) (viewport/viewBox ratio) and origin = (x0, y0)
 *
 * After switching to newViewBox and applying transform G(p) = k*p + t,
 * we want: S2(G(p) - o2) = S1(p - o1) for all p
 *
 * Solving:
 *   k = w2/w1 (ratio of new to old viewBox width)
 *   t = (x2 - k*x1, y2 - k*y1) (origin shift accounting for scale)
 *
 * Credit: GPT-5 derivation
 *
 * @param {Array} oldViewBox - [x, y, width, height]
 * @param {Array} newViewBox - [x, y, width, height]
 * @returns {d3.ZoomTransform} - Transform to apply
 */
function calculateCompensatingTransform(oldViewBox, newViewBox) {
  const [x1, y1, w1, h1] = oldViewBox;
  const [x2, y2, w2, h2] = newViewBox;

  // Scale: ratio of new to old viewBox size
  const k = w2 / w1;

  // Translation: new origin minus scaled old origin
  const tx = x2 - k * x1;
  const ty = y2 - k * y1;

  return d3.zoomIdentity
    .translate(tx, ty)
    .scale(k);
}

/**
 * Hook to manage smooth viewBox transitions using ZoomManager transforms
 *
 * Strategy:
 * 1. Kalman filter smooths target viewBox (ignores noise/spikes)
 * 2. Calculate zoom transform that compensates for viewBox change
 * 3. Animate the transform (using ZoomManager for jiggle-free motion)
 * 4. When animation completes, update viewBox and reset transform to identity
 *
 * This leverages D3's zoom transform interpolation which naturally maintains
 * a stable focal point, avoiding jiggling from direct viewBox interpolation.
 *
 * Recommended configurations:
 * ┌──────────────┬──────┬───┬──────────┬───────────────────────────────────┐
 * │ Config       │ R    │ Q │ Duration │ Behavior                          │
 * ├──────────────┼──────┼───┼──────────┼───────────────────────────────────┤
 * │ Conservative │ 0.01 │ 3 │ 800ms    │ Very smooth, slow to adapt        │
 * │ Balanced     │ 0.1  │ 3 │ 350ms    │ Good middle ground (default)      │
 * │ Responsive   │ 1    │ 3 │ 800ms    │ Adapts quickly, smooth transitions│
 * └──────────────┴──────┴───┴──────────┴───────────────────────────────────┘
 *
 * @param {Function} setViewBox - State setter for viewBox
 * @param {Array} currentViewBox - Current viewBox value [x, y, width, height]
 * @param {number} R - Kalman filter measurement noise (lower = trust measurements less)
 * @param {number} Q - Kalman filter process noise (higher = expect more change)
 * @param {number} transitionDuration - Duration of viewBox transitions in ms
 * @param {Function} transitionEasing - D3 easing function for transitions
 * @param {Object} zoomManager - ZoomManager instance for transform animations
 * @returns {Object} - { requestViewBoxUpdate, cleanup }
 */
export function useViewBoxTransition(
  setViewBox,
  currentViewBox,
  R,
  Q = 3,
  transitionDuration,
  transitionEasing = d3.easeCubicOut,
  zoomManager = null
) {
  const animationInProgressRef = useRef(false);
  const kalmanFiltersRef = useRef(null);
  const viewBoxDebounceRef = useRef(null);
  const currentParamsRef = useRef({ R, Q });

  // Reinitialize filters if parameters change
  if (!kalmanFiltersRef.current || currentParamsRef.current.R !== R || currentParamsRef.current.Q !== Q) {
    kalmanFiltersRef.current = [
      new KalmanFilter({ R, Q }), // x
      new KalmanFilter({ R, Q }), // y
      new KalmanFilter({ R, Q }), // width
      new KalmanFilter({ R, Q })  // height
    ];
    currentParamsRef.current = { R, Q };
  }

  // Apply Kalman filtering to viewBox
  const smoothViewBox = useCallback((newVB) => {
    const smoothed = newVB.map((value, i) => {
      return kalmanFiltersRef.current[i].filter(value);
    });
    return smoothed;
  }, []);

  // Smoothly transition viewBox using ZoomManager transforms
  const startViewBoxTransitionViaTransform = useCallback(async (fromViewBox, toViewBox) => {
    const zm = zoomManager?.current;
    if (!zm || animationInProgressRef.current) {
      console.log('[ViewBox:Transform] Skipped - no zoomManager or animation in progress');
      return;
    }

    animationInProgressRef.current = true;

    console.log('[ViewBox:Transform] Starting', JSON.stringify({
      from: fromViewBox.map(v => Math.round(v * 100) / 100),
      to: toViewBox.map(v => Math.round(v * 100) / 100),
      duration: transitionDuration
    }));

    // Calculate the compensating transform
    const compensatingTransform = calculateCompensatingTransform(fromViewBox, toViewBox);

    console.log('[ViewBox:Transform] Compensating transform:', {
      x: Math.round(compensatingTransform.x * 100) / 100,
      y: Math.round(compensatingTransform.y * 100) / 100,
      k: Math.round(compensatingTransform.k * 100) / 100
    });

    try {
      // Animate the transform to compensate for viewBox change
      await zm.animateToTransform(compensatingTransform, {
        duration: transitionDuration,
        easing: transitionEasing
      });

      // At this point:
      // - Transform is at compensatingTransform
      // - ViewBox is still oldViewBox
      // - Content looks correct (transform compensates)

      // Update viewBox and reset transform
      // React won't re-render until next tick, but applyTransformDirect is synchronous
      // So we set viewBox (queued), then immediately reset transform (sync)
      setViewBox(toViewBox);

      // Use requestAnimationFrame to ensure transform reset happens AFTER viewBox re-render
      requestAnimationFrame(() => {
        zm.applyTransformDirect(d3.zoomIdentity);
        console.log('[ViewBox:Transform] Complete - viewBox updated, transform reset to identity');
      });

    } catch (error) {
      console.error('[ViewBox:Transform] Animation failed:', error);
    } finally {
      animationInProgressRef.current = false;
    }
  }, [zoomManager, transitionDuration, transitionEasing, setViewBox]);

  // Request a smoothed viewBox update (with debouncing for batching)
  const requestViewBoxUpdate = useCallback((vb) => {
    const smoothedVB = smoothViewBox(vb);

    console.log('[ViewBox:Smoothed]', JSON.stringify({
      raw: vb.map(v => Math.round(v * 100) / 100),
      smoothed: smoothedVB.map(v => Math.round(v * 100) / 100),
      filter: `Kalman(R=${R}, Q=${Q})`
    }));

    if (viewBoxDebounceRef.current) {
      clearTimeout(viewBoxDebounceRef.current);
    }

    viewBoxDebounceRef.current = setTimeout(() => {
      const currentVB = currentViewBox || smoothedVB;
      startViewBoxTransitionViaTransform(currentVB, smoothedVB);
    }, 300);
  }, [smoothViewBox, currentViewBox, startViewBoxTransitionViaTransform, R, Q]);

  const cleanup = useCallback(() => {
    if (viewBoxDebounceRef.current) {
      clearTimeout(viewBoxDebounceRef.current);
    }
    animationInProgressRef.current = false;
  }, []);

  return {
    requestViewBoxUpdate,
    cleanup
  };
}
