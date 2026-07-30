/**
 * Per-instance appearance rules — the single source of truth for how a dot's
 * size / fill / opacity / focus are derived from (item, dotStyle, defaults,
 * hover state). Shared by both the WebGL path (instanceUpdate.js, which packs
 * the results into instance matrices + attributes) and the WebGPU path
 * (R3FDotsWebGPU, which uploads them to storage buffers). The renderers diverge
 * only in how they apply these values, never in how they compute them.
 */

// Floats per colour in the WebGPU path's colour storage buffers: RGB in a vec4
// slot, fourth component unused. A `vec3` storage attribute is not safe to
// update partially — three pads it to vec4 on the GPU but keeps re-deriving
// that padded array from `attribute.array` read at stride 3 on every upload
// (WebGPUAttributeUtils `_force3to4BytesAlignment`). Only a full stride-3
// rewrite leaves the array in the layout that re-derivation expects, so a
// single-dot write scrambles every other dot's colour. Matching the GPU's own
// stride removes the re-derivation entirely.
export const COLOR_STRIDE = 4;

export function resolveBaseSize(item, customStyle, radiusOverrides, defaultSize) {
  return customStyle.r ?? radiusOverrides.get(item.id) ?? item.size ?? defaultSize;
}

export function resolveScale(baseSize, isHovered, hoverSizeMultiplier) {
  return isHovered ? baseSize * hoverSizeMultiplier : baseSize;
}

// Hover/click hit radius — the pickable radius around a dot. Shared by the CPU
// spatial grid (R3FScene.buildHoverSpatialIndex) and the GPU pick-radius buffer
// (R3FDotsWebGPU.writePickRadii) so the two hit-testers stay in lockstep. Unlike
// resolveBaseSize it ignores customStyle.r: hit-testing has no dotStyles.
export function resolveHoverRadius(item, radiusOverrides, defaultSize, hoverSizeMultiplier) {
  return (radiusOverrides.get(item.id) ?? item.size ?? defaultSize) * hoverSizeMultiplier;
}

export function resolveFill(item, customStyle, defaultColor) {
  return customStyle.fill || customStyle.color || item.color || defaultColor || '#7c6fff';
}

export function resolveOpacity(customStyle, isHovered, hoverOpacity, defaultOpacity) {
  return customStyle.opacity !== undefined
    ? customStyle.opacity
    : (isHovered ? hoverOpacity : defaultOpacity);
}

export function resolveFocus(customStyle) {
  return customStyle.focusRing ? 1 : 0;
}
