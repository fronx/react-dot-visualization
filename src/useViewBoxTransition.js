import { useRef, useCallback } from 'react';
import * as d3 from 'd3';

/**
 * Hook to manage smooth viewBox transitions with exponential smoothing and debouncing
 *
 * @param {Function} setViewBox - State setter for viewBox
 * @param {Array} currentViewBox - Current viewBox value [x, y, width, height]
 * @returns {Object} - { requestViewBoxUpdate, startViewBoxTransition, cleanup }
 */
export function useViewBoxTransition(setViewBox, currentViewBox) {
  const viewBoxTransitionRef = useRef(null);
  const smoothedViewBoxRef = useRef(null);
  const viewBoxDebounceRef = useRef(null);

  // Apply exponential smoothing to viewBox (low-pass filter)
  const smoothViewBox = useCallback((newVB, alpha = 0.3) => {
    if (!smoothedViewBoxRef.current) {
      smoothedViewBoxRef.current = newVB;
      return newVB;
    }

    const smoothed = smoothedViewBoxRef.current.map((prev, i) => {
      return alpha * newVB[i] + (1 - alpha) * prev;
    });

    smoothedViewBoxRef.current = smoothed;
    return smoothed;
  }, []);

  // Smoothly transition viewBox from current to target
  const startViewBoxTransition = useCallback((fromViewBox, toViewBox, duration, easing) => {
    if (viewBoxTransitionRef.current) {
      viewBoxTransitionRef.current.stop();
    }

    const timer = d3.timer((elapsed) => {
      const t = Math.min(elapsed / duration, 1);
      const easedT = easing(t);

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
  const requestViewBoxUpdate = useCallback((vb, duration, easing) => {
    const smoothedVB = smoothViewBox(vb);

    console.log('[ViewBox] Smoothed update:', {
      raw: vb,
      smoothed: smoothedVB
    });

    if (viewBoxDebounceRef.current) {
      clearTimeout(viewBoxDebounceRef.current);
    }

    viewBoxDebounceRef.current = setTimeout(() => {
      if (!viewBoxTransitionRef.current) {
        const currentVB = currentViewBox || smoothedVB;
        console.log('[ViewBox] Starting smoothed transition');
        startViewBoxTransition(currentVB, smoothedVB, duration, easing);
      }
    }, 300);
  }, [smoothViewBox, currentViewBox, startViewBoxTransition]);

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
