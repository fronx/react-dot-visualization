// Pure zoom→opacity fade math for in-scene labels. Kept dependency-free (no
// three/drei import) so the barrel can re-export it without dragging the R3F
// stack into canvas-only consumers.

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const smoothstep = (t) => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

// Fully visible at/above `fullZ` (zoomed out), fully faded at/below `goneZ`
// (zoomed in). For captions that vanish as you zoom in, fullZ > goneZ.
export const makeZoomFade = ({ fullZ, goneZ }) => {
  const span = fullZ - goneZ;
  if (span === 0) return () => 1;
  return (cameraZ) => smoothstep((cameraZ - goneZ) / span);
};
