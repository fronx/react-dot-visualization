import { useState, useRef, useEffect } from 'react';
import * as d3 from 'd3';
import { useFrameBudget } from './useFrameBudget';
import { useDebug } from './useDebug.js';

export const usePulseAnimation = (dotStyles, onAnimationFrame, debug = false) => {
  const [time, setTime] = useState(0);
  const frameRef = useRef();

  const TARGET_FPS = 30;
  const THRESHOLD_FPS = TARGET_FPS * 0.8;

  const debugLog = useDebug(debug);

  // Frame time budgeting to ensure smooth, consistent frame rates
  const { shouldRender, getStats } = useFrameBudget({
    targetFPS: TARGET_FPS,
    adaptiveThrottling: true, // Automatically adjust if system can't maintain 60 FPS
    minFPS: TARGET_FPS * 0.6,
    debug
  });

  const pulseDots = new Map();
  for (const [id, style] of dotStyles) {
    if (style?.pulse) {
      pulseDots.set(id, {
        duration: style.pulse.duration || 1250,
        sizeRange: style.pulse.sizeRange || 0.3,
        opacityRange: style.pulse.opacityRange || 0,
        pulseColor: style.pulse.pulseColor,
        ringEffect: style.pulse.ringEffect || false,
        pulseInward: style.pulse.pulseInward || false,
        ringTargetPixels: style.pulse.ringTargetPixels,
        ringMinRatio: style.pulse.ringMinRatio
      });
    }
  }

  useEffect(() => {
    if (pulseDots.size === 0) return;

    const animate = (t) => {
      setTime(t);

      // Only trigger expensive canvas redraw if frame budget allows
      // This prevents trying to render faster than the system can handle,
      // which causes janky, inconsistent frame rates
      if (shouldRender()) {
        onAnimationFrame?.();

        // Optional: Log performance warnings when debug is enabled
        const stats = getStats();
        if (stats.actualFPS < THRESHOLD_FPS && stats.actualFPS > 0) {
          debugLog(`[usePulseAnimation] Low FPS detected: ${stats.actualFPS.toFixed(1)} FPS (dropped ${stats.droppedFrames} frames)`);
        }
      }

      frameRef.current = requestAnimationFrame(animate);
    };

    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [pulseDots.size, onAnimationFrame, shouldRender, getStats, debugLog]);

  return (dotId, baseColor) => {
    const config = pulseDots.get(dotId);
    if (!config) return {
      sizeMultiplier: 1,
      opacityMultiplier: 1,
      color: baseColor,
      ringData: null
    };

    const phase = (time % config.duration) / config.duration;

    if (config.ringEffect) {
      // Ring effect animation
      const dotPhase = phase;
      const ringPhase = ((time + 400) % config.duration) / config.duration; // 400ms offset

      // Main dot: scale pulse using sizeRange (sine wave for smooth oscillation)
      const sineWave = Math.sin(dotPhase * Math.PI * 2); // -1 to 1
      const dotScale = config.pulseInward
        ? 1 - (config.sizeRange * (sineWave + 1) / 2)  // Pulse inward: 1.0 to (1 - sizeRange)
        : 1 + (config.sizeRange * (sineWave + 1) / 2); // Pulse outward: 1.0 to (1 + sizeRange)

      // Ring: animates from 0 to 1 over first 80% of cycle, then fades out
      // The actual ring size is calculated adaptively based on dot size
      let ringAnimationPhase = null;
      let ringOpacity = 0;

      if (ringPhase <= 0.8) {
        ringAnimationPhase = ringPhase / 0.8; // Normalize to 0-1 range
        ringOpacity = 1 - (ringPhase / 0.8);
      }

      return {
        sizeMultiplier: dotScale,
        opacityMultiplier: 1,
        color: baseColor,
        ringData: ringAnimationPhase !== null ? {
          animationPhase: ringAnimationPhase, // 0 to 1
          opacity: ringOpacity,
          color: config.pulseColor || baseColor,
          options: {
            targetPixels: config.ringTargetPixels,
            minRatio: config.ringMinRatio
          }
        } : null
      };
    } else {
      // Original pulse effect
      let t;
      if (phase < 0.5) {
        // First half: ease out from 0 to 1 (growing)
        t = d3.easeQuadOut(phase * 2);
      } else {
        // Second half: ease in from 1 to 0 (shrinking)
        t = d3.easeQuadIn(1 - (phase - 0.5) * 2);
      }

      // Color interpolation if pulseColor is provided
      let interpolatedColor = baseColor;
      if (config.pulseColor && baseColor) {
        const colorInterpolator = d3.interpolate(baseColor, config.pulseColor);
        interpolatedColor = colorInterpolator(t);
      }

      // Calculate size multiplier based on pulse direction
      const sizeMultiplier = config.pulseInward
        ? 1 - (config.sizeRange * t)  // Shrink: 1.0 down to (1 - sizeRange)
        : 1 + (config.sizeRange * t); // Grow: 1.0 up to (1 + sizeRange)

      return {
        sizeMultiplier,
        opacityMultiplier: config.opacityRange > 0 ? (1 + config.opacityRange * t) : 1,
        color: interpolatedColor,
        ringData: null
      };
    }
  };
};