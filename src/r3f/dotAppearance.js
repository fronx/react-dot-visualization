/**
 * Per-instance appearance rules — the single source of truth for how a dot's
 * size / fill / opacity / focus are derived from (item, dotStyle, defaults,
 * hover state). Shared by both the WebGL path (instanceUpdate.js, which packs
 * the results into instance matrices + attributes) and the WebGPU path
 * (R3FDotsWebGPU, which uploads them to storage buffers). The renderers diverge
 * only in how they apply these values, never in how they compute them.
 */

export function resolveBaseSize(item, customStyle, radiusOverrides, defaultSize) {
  return customStyle.r ?? radiusOverrides.get(item.id) ?? item.size ?? defaultSize;
}

export function resolveScale(baseSize, isHovered, hoverSizeMultiplier) {
  return isHovered ? baseSize * hoverSizeMultiplier : baseSize;
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
