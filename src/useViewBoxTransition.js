import { useRef, useCallback } from 'react';
import * as d3 from 'd3';
import KalmanFilter from 'kalmanjs';

/**
 * Hook to manage smooth viewBox transitions with Kalman filtering and debouncing
 *
 * Two-stage smoothing approach:
 * 1. Kalman filter determines smooth target (ignores noise/spikes)
 * 2. D3 animation interpolates to target over controlled duration
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
 * @returns {Object} - { requestViewBoxUpdate, startViewBoxTransition, cleanup }
 */
export function useViewBoxTransition(
  setViewBox,
  currentViewBox,
  R,
  Q = 3,
  transitionDuration,
  transitionEasing = d3.easeCubicOut
) {
  const viewBoxTransitionRef = useRef(null);
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

  // Smoothly transition viewBox from current to target
  const startViewBoxTransition = useCallback((fromViewBox, toViewBox, duration, easing) => {
    if (viewBoxTransitionRef.current) {
      viewBoxTransitionRef.current.stop();
    }

    const timer = d3.timer((elapsed) => {
      const t = Math.min(elapsed / duration, 1);
      const easedT = easing ? easing(t) : t;

      const interpolated = fromViewBox.map((start, i) => {
        const end = toViewBox[i];
        return start + (end - start) * easedT;
      });

      setViewBox(interpolated);

      if (t >= 1) {
        timer.stop();
        viewBoxTransitionRef.current = null;
        setViewBox(toViewBox);
      }
    });

    viewBoxTransitionRef.current = timer;
  }, [setViewBox]);

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
      if (!viewBoxTransitionRef.current) {
        const currentVB = currentViewBox || smoothedVB;
        console.log('[ViewBox:Transition] Starting', JSON.stringify({
          from: currentVB.map(v => Math.round(v * 100) / 100),
          to: smoothedVB.map(v => Math.round(v * 100) / 100),
          duration: transitionDuration
        }));
        startViewBoxTransition(currentVB, smoothedVB, transitionDuration, transitionEasing);
      }
    }, 300);
  }, [smoothViewBox, currentViewBox, startViewBoxTransition, R, Q, transitionDuration, transitionEasing]);

  const cleanup = useCallback(() => {
    if (viewBoxDebounceRef.current) {
      clearTimeout(viewBoxDebounceRef.current);
    }
    if (viewBoxTransitionRef.current) {
      viewBoxTransitionRef.current.stop();
    }
  }, []);

  return {
    requestViewBoxUpdate,
    startViewBoxTransition,
    cleanup
  };
}
