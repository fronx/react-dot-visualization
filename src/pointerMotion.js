/**
 * Pointer speed tracker for hover intent. One sample per mouse move: the
 * distance from the previous position over the elapsed time, smoothed with an
 * exponential moving average so a single jittery event cannot flip the verdict.
 * Constant work per event, no allocation — a sweep across a hundred dots a
 * second costs a hundred subtractions.
 *
 * `slow` is a convenience verdict against a cutoff; the R3F hover detector reads
 * the raw `speed` against its live tuning. Nothing here knows about dots.
 */
export const DEFAULT_SLOW_PX_PER_MS = 0.05;
const SMOOTHING = 0.5;

export function createPointerMotion({ slowPxPerMs = DEFAULT_SLOW_PX_PER_MS } = {}) {
  let lastX = NaN;
  let lastY = NaN;
  let lastT = NaN;
  // Unknown until two samples exist: a pointer that just entered must not read
  // as still, or the first dot under it would count as rested on.
  let speed = Infinity;

  return {
    /** Feed one mouse-move sample; returns the smoothed px/ms and the verdict. */
    sample(x, y, t) {
      if (Number.isFinite(lastT)) {
        const dt = t - lastT;
        if (dt > 0) {
          const dx = x - lastX;
          const dy = y - lastY;
          const instant = Math.sqrt(dx * dx + dy * dy) / dt;
          speed = Number.isFinite(speed) ? speed * (1 - SMOOTHING) + instant * SMOOTHING : instant;
        }
      }
      lastX = x;
      lastY = y;
      lastT = t;
      return { speed, slow: speed < slowPxPerMs };
    },
    /** Forget the previous position (pointer left the surface). */
    reset() {
      lastX = NaN;
      lastY = NaN;
      lastT = NaN;
      speed = Infinity;
    },
    get speed() {
      return speed;
    },
  };
}
