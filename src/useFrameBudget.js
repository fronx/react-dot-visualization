import { useRef, useCallback } from 'react';

/**
 * useFrameBudget - A generic hook for frame time budgeting and throttling
 *
 * Helps maintain smooth, consistent frame rates by only allowing renders
 * when sufficient time has passed since the last frame. Prevents janky
 * performance caused by trying to render faster than the system can handle.
 *
 * @param {Object} options - Configuration options
 * @param {number} options.targetFPS - Target frame rate (default: 60)
 * @param {boolean} options.adaptiveThrottling - Automatically adjust target based on performance (default: false)
 * @param {number} options.minFPS - Minimum FPS when adaptive throttling is enabled (default: 30)
 * @returns {Object} Frame budget utilities
 */
export function useFrameBudget(options = {}) {
  const {
    targetFPS = 60,
    adaptiveThrottling = false,
    minFPS = 30
  } = options;

  const targetFrameTime = useRef(1000 / targetFPS);
  const lastFrameTime = useRef(performance.now());
  const frameTimings = useRef([]);
  const droppedFrameCount = useRef(0);
  const renderedFrameCount = useRef(0);
  const statsResetTime = useRef(performance.now());

  // Adaptive throttling: if we're consistently missing frames, reduce target FPS
  const adjustTargetFPS = useCallback(() => {
    if (!adaptiveThrottling) return;

    if (frameTimings.current.length < 10) return; // Need enough data

    const avgFrameTime = frameTimings.current.reduce((a, b) => a + b, 0) / frameTimings.current.length;
    const achievableFPS = 1000 / avgFrameTime;

    // If we can't hit target FPS, gradually reduce it (but not below minFPS)
    if (achievableFPS < targetFPS * 0.8) {
      const newTargetFPS = Math.max(minFPS, Math.floor(achievableFPS * 0.9));
      targetFrameTime.current = 1000 / newTargetFPS;

      if (process.env.NODE_ENV === 'development') {
        console.log(`[useFrameBudget] Adaptive throttling: Reduced target to ${newTargetFPS} FPS (avg frame time: ${avgFrameTime.toFixed(2)}ms)`);
      }
    }
  }, [adaptiveThrottling, targetFPS, minFPS]);

  /**
   * Check if enough time has passed to render the next frame
   * @returns {boolean} True if a frame should be rendered
   */
  const shouldRender = useCallback(() => {
    const now = performance.now();
    const elapsed = now - lastFrameTime.current;

    // Check if enough time has passed since last render
    if (elapsed >= targetFrameTime.current) {
      // Record timing stats
      frameTimings.current.push(elapsed);
      if (frameTimings.current.length > 60) {
        frameTimings.current.shift(); // Keep only last 60 frames for rolling average
      }

      renderedFrameCount.current++;
      lastFrameTime.current = now;

      // Reset stats and adjust FPS every second
      if (now - statsResetTime.current > 1000) {
        if (adaptiveThrottling) {
          adjustTargetFPS();
        }
        droppedFrameCount.current = 0;
        renderedFrameCount.current = 0;
        statsResetTime.current = now;
      }

      return true;
    } else {
      droppedFrameCount.current++;
      return false;
    }
  }, [adjustTargetFPS, adaptiveThrottling]);

  /**
   * Get current performance statistics
   * @returns {Object} Performance stats
   */
  const getStats = useCallback(() => {
    const avgFrameTime = frameTimings.current.length > 0
      ? frameTimings.current.reduce((a, b) => a + b, 0) / frameTimings.current.length
      : 0;

    return {
      actualFPS: avgFrameTime > 0 ? 1000 / avgFrameTime : 0,
      droppedFrames: droppedFrameCount.current,
      averageFrameTime: avgFrameTime,
      targetFPS: 1000 / targetFrameTime.current
    };
  }, []);

  /**
   * Reset all timing statistics
   */
  const reset = useCallback(() => {
    lastFrameTime.current = performance.now();
    frameTimings.current = [];
    droppedFrameCount.current = 0;
    renderedFrameCount.current = 0;
    statsResetTime.current = performance.now();
  }, []);

  return {
    shouldRender,
    getStats,
    reset
  };
}

/**
 * createFrameBudget - Standalone version for non-React contexts
 *
 * Creates a frame budget manager that can be used outside of React components,
 * such as in Web Workers, D3 simulations, or other JavaScript contexts.
 *
 * @param {Object} options - Configuration options
 * @param {number} options.targetFPS - Target frame rate (default: 60)
 * @returns {Object} Frame budget utilities
 */
export function createFrameBudget(options = {}) {
  const targetFPS = options.targetFPS || 60;
  const targetFrameTime = 1000 / targetFPS;
  let lastFrameTime = performance.now();
  const frameTimings = [];

  return {
    shouldRender: () => {
      const now = performance.now();
      const elapsed = now - lastFrameTime;

      if (elapsed >= targetFrameTime) {
        frameTimings.push(elapsed);
        if (frameTimings.length > 60) {
          frameTimings.shift();
        }

        lastFrameTime = now;
        return true;
      }
      return false;
    },
    getStats: () => {
      const avgFrameTime = frameTimings.length > 0
        ? frameTimings.reduce((a, b) => a + b, 0) / frameTimings.length
        : 0;

      return {
        actualFPS: avgFrameTime > 0 ? 1000 / avgFrameTime : 0,
        averageFrameTime: avgFrameTime,
        targetFPS
      };
    },
    reset: () => {
      lastFrameTime = performance.now();
      frameTimings.length = 0;
    }
  };
}
