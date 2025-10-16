/**
 * Adaptive pulse ring sizing utility
 * Calculates ring radius based on dot screen size with two strategies:
 * - Small dots: fixed pixel size for visibility (zoom-independent)
 * - Large dots: minimum ratio to prevent oversized rings (zoom-dependent)
 *
 * The threshold where these strategies switch is automatically calculated to ensure
 * continuous scaling: pixelThreshold = targetPixels / minRatio
 */

const DEFAULT_TARGET_PIXELS = 50;    // Max ring size for small dots (in pixels)
const DEFAULT_MIN_RATIO = 2.0;       // Min ring can be 2x the dot for large dots

export function calculateAdaptiveRingRadius({
  radius,
  animationPhase,
  viewBoxScale,
  zoomScale,
  targetPixels = DEFAULT_TARGET_PIXELS,
  minRatio = DEFAULT_MIN_RATIO,
  canvasDPR,
  debug = false
}) {

  // Calculate threshold automatically for continuous scaling
  // At the threshold: targetPixels = threshold * minRatio
  const pixelThreshold = targetPixels / minRatio;

  // Calculate actual screen size accounting for BOTH viewBox scale and zoom
  // Note: viewBoxScale already includes the canvas DPR multiplier
  const totalScale = viewBoxScale * zoomScale;
  const dotScreenRadius = radius * totalScale;

  // CSS pixel scale (what user actually sees) excludes the DPR
  const totalCSSScale = (viewBoxScale / canvasDPR) * zoomScale;
  const dotCSSRadius = radius * totalCSSScale;

  let ringRadius;
  let ringScreenRadius;
  let ringCSSRadius;

  if (dotCSSRadius < pixelThreshold) {
    // Small dots: fixed CSS pixel size that stays constant regardless of zoom
    // targetPixels is in CSS pixels (what the user sees)
    ringCSSRadius = targetPixels * animationPhase;
    // Convert CSS pixels to canvas space by multiplying by DPR
    ringScreenRadius = ringCSSRadius * canvasDPR;
    ringRadius = ringScreenRadius / totalScale;
  } else {
    // Large dots: ratio-based sizing that scales with zoom
    ringRadius = radius * (minRatio * animationPhase);
    ringScreenRadius = ringRadius * totalScale;
    ringCSSRadius = ringScreenRadius / canvasDPR;
  }

  // Debug logging (sampled)
  if (debug && Math.random() < 0.03) {
    console.log('[Ring Debug]', {
      radius: radius.toFixed(2),
      dotCSSRadius: dotCSSRadius.toFixed(1),
      dotScreenRadius: dotScreenRadius.toFixed(1),
      viewBoxScale: viewBoxScale.toFixed(2),
      zoomScale: zoomScale.toFixed(2),
      canvasDPR: canvasDPR.toFixed(2),
      totalScale: totalScale.toFixed(2),
      totalCSSScale: totalCSSScale.toFixed(2),
      animationPhase: animationPhase.toFixed(2),
      ringRadius: ringRadius.toFixed(2),
      ringScreenRadius: ringScreenRadius.toFixed(1),
      ringCSSRadius: ringCSSRadius.toFixed(1),
      mode: dotCSSRadius < pixelThreshold ? 'pixel-based' : 'ratio-based',
      config: { pixelThreshold, targetPixels, minRatio }
    });
  }

  return ringRadius;
}
