import { useState, useRef, useEffect } from 'react';
import * as d3 from 'd3';

export const usePulseAnimation = (dotStyles, onAnimationFrame) => {
  const [time, setTime] = useState(0);
  const frameRef = useRef();

  const pulseDots = new Map();
  for (const [id, style] of dotStyles) {
    if (style?.pulse) {
      pulseDots.set(id, {
        duration: style.pulse.duration || 1250,
        sizeRange: style.pulse.sizeRange || 0.3,
        opacityRange: style.pulse.opacityRange || 0,
        pulseColor: style.pulse.pulseColor,
        ringEffect: style.pulse.ringEffect || false
      });
    }
  }

  useEffect(() => {
    if (pulseDots.size === 0) return;

    const animate = (t) => {
      setTime(t);
      onAnimationFrame?.();
      frameRef.current = requestAnimationFrame(animate);
    };

    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [pulseDots.size, onAnimationFrame]);

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
      const dotPhase = (time % config.duration) / config.duration;
      const ringPhase = ((time + 400) % config.duration) / config.duration; // 400ms offset

      // Main dot: subtle scale pulse (1.0 to 1.1)
      const dotScale = 1 + (Math.sin(dotPhase * Math.PI * 2) * 0.05);

      // Ring: starts at 50% scale, expands to 300%, fades out after 80%
      let ringScale = null;
      let ringOpacity = 0;

      if (ringPhase <= 0.8) {
        ringScale = 0.5 + (ringPhase * 2.5); // 0.5 to 3.0
        ringOpacity = 1 - (ringPhase / 0.8);
      }

      return {
        sizeMultiplier: dotScale,
        opacityMultiplier: 1,
        color: baseColor,
        ringData: ringScale !== null ? {
          scale: ringScale,
          opacity: ringOpacity,
          color: config.pulseColor || baseColor
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

      return {
        sizeMultiplier: 1 + (config.sizeRange * t),
        opacityMultiplier: config.opacityRange > 0 ? (1 + config.opacityRange * t) : 1,
        color: interpolatedColor,
        ringData: null
      };
    }
  };
};