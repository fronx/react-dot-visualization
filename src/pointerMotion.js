/**
 * Pointer speed tracker for hover intent. One sample per mouse move: the
 * distance from the previous position over the elapsed time, smoothed with an
 * exponential moving average so a single jittery event cannot flip the verdict.
 * Constant work per event, no allocation — a sweep across a hundred dots a
 * second costs a hundred subtractions.
 *
 * `slow` is the verdict a consumer acts on: the pointer arrived at (or lingers
 * over) a dot slowly enough to count as a deliberate stop rather than a
 * pass-through. Nothing here knows about dots; the hover dispatcher pairs the
 * verdict with the hovered item.
 */
export const DEFAULT_SLOW_PX_PER_MS = 0.3;
const SMOOTHING = 0.5;

export function createPointerMotion({ slowPxPerMs = DEFAULT_SLOW_PX_PER_MS } = {}) {
  let lastX = NaN;
  let lastY = NaN;
  let lastT = NaN;
  let speed = 0;

  return {
    /** Feed one mouse-move sample; returns the smoothed px/ms and the verdict. */
    sample(x, y, t) {
      if (Number.isFinite(lastT)) {
        const dt = t - lastT;
        if (dt > 0) {
          const dx = x - lastX;
          const dy = y - lastY;
          const instant = Math.sqrt(dx * dx + dy * dy) / dt;
          speed = speed * (1 - SMOOTHING) + instant * SMOOTHING;
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
      speed = 0;
    },
    get speed() {
      return speed;
    },
  };
}
