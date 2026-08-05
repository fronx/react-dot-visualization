/**
 * Projection-aligned categorical filtering for the WebGPU renderer.
 *
 * The per-instance values are uploaded only when the data changes. Interactive
 * filter changes update uniforms, so toggling a category is O(1) on the CPU and
 * does not rewrite the color/alpha storage buffers.
 */
import { float, select, uint } from 'three/tsl';

export const DEFAULT_CATEGORICAL_VALUE_MASK = 0xff;
export const DEFAULT_CATEGORICAL_DIM_OPACITY = 0.35;

function unsigned(value, fallback) {
  return Number.isFinite(value) ? (Math.floor(value) >>> 0) : fallback;
}

export function normalizeCategoricalFilter(input) {
  return {
    enabled: !!input?.values && input?.enabled !== false,
    includedValues: unsigned(input?.includedValues, 0),
    valueMask: unsigned(input?.valueMask, DEFAULT_CATEGORICAL_VALUE_MASK),
    valueShift: Math.min(31, unsigned(input?.valueShift, 0)),
    dimOpacity: Number.isFinite(input?.dimOpacity)
      ? Math.max(0, Math.min(1, Number(input.dimOpacity)))
      : DEFAULT_CATEGORICAL_DIM_OPACITY,
  };
}

export function categoricalValueMatches(rawValue, input) {
  const normalized = normalizeCategoricalFilter(input);
  if (!normalized.enabled) return true;
  const value = ((rawValue >>> normalized.valueShift) & normalized.valueMask) >>> 0;
  if (value > 31) return false;
  return (normalized.includedValues & ((1 << value) >>> 0)) !== 0;
}

export function makeCategoricalValueBuffer(input, count) {
  const out = new Uint32Array(Math.max(0, count));
  const source = input?.values;
  if (!source) return out;
  const n = Math.min(out.length, source.length);
  for (let i = 0; i < n; i += 1) out[i] = source[i] >>> 0;
  return out;
}

/** Copy either the whole source or a sparse delta into an existing u32 storage
 *  attribute. Returns the number of elements marked for upload. */
export function updateCategoricalValueBuffer(attribute, input, count, forceFull = false) {
  const source = input?.values;
  if (!attribute?.array || !source) return 0;
  const n = Math.min(attribute.array.length, source.length, Math.max(0, count));
  const changed = input.changedIndices;
  if (forceFull || !changed) {
    for (let i = 0; i < n; i += 1) attribute.array[i] = source[i] >>> 0;
    attribute.addUpdateRange(0, n);
    attribute.needsUpdate = true;
    return n;
  }
  let updated = 0;
  for (const candidate of changed) {
    const index = Math.floor(Number(candidate));
    if (!Number.isFinite(index) || index < 0 || index >= n) continue;
    attribute.array[index] = source[index] >>> 0;
    attribute.addUpdateRange(index, 1);
    updated += 1;
  }
  if (updated > 0) attribute.needsUpdate = true;
  return updated;
}

export function categoricalMatchNode(rawValue, filter) {
  const value = rawValue.shiftRight(filter.valueShiftU).bitAnd(filter.valueMaskU);
  const valueBit = uint(1).shiftLeft(value);
  return value.lessThan(uint(32)).and(filter.includedValuesU.bitAnd(valueBit).greaterThan(uint(0)));
}

export function categoricalColorNode(baseColor, rawValue, focus, filter) {
  const filtered = select(categoricalMatchNode(rawValue, filter), baseColor, filter.dimColorU);
  const focusBypass = select(focus.greaterThan(float(0.5)), baseColor, filtered);
  return select(filter.enabledU.greaterThan(uint(0)), focusBypass, baseColor);
}

export function categoricalAlphaNode(baseAlpha, rawValue, focus, filter) {
  const filtered = select(categoricalMatchNode(rawValue, filter), baseAlpha, filter.dimOpacityU);
  const focusBypass = select(focus.greaterThan(float(0.5)), baseAlpha, filtered);
  return select(filter.enabledU.greaterThan(uint(0)), focusBypass, baseAlpha);
}
