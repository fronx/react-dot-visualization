const EMPTY_STYLE = Object.freeze({});

/** Resolve a transient style over the ordinary per-dot style. */
export function resolveLayeredDotStyle(id, dotStyles, dynamicDotStyles) {
  const base = dotStyles?.get(id);
  const dynamic = dynamicDotStyles?.get(id);
  if (!dynamic) return base || EMPTY_STYLE;
  if (!base) return dynamic;
  return { ...base, ...dynamic };
}

/** Merge the sparse overlay for renderers that only accept one style map. */
export function mergeDotStyleMaps(dotStyles, dynamicDotStyles) {
  if (!dynamicDotStyles?.size) return dotStyles;
  const merged = new Map(dotStyles);
  for (const [id, dynamic] of dynamicDotStyles) {
    const base = dotStyles?.get(id);
    merged.set(id, base ? { ...base, ...dynamic } : dynamic);
  }
  return merged;
}

/**
 * Return only ids whose transient style was added, removed, or replaced.
 * Value identity is intentional: callers build immutable style entries.
 */
export function collectChangedDynamicStyleIds(previous, next) {
  const changed = new Set();
  for (const [id, style] of previous) {
    if (next.get(id) !== style) changed.add(id);
  }
  for (const id of next.keys()) {
    if (!previous.has(id)) changed.add(id);
  }
  return changed;
}

/**
 * Mark exact storage-buffer elements for upload. Three's WebGPU renderer
 * converts these component ranges into bounded queue.writeBuffer calls.
 */
export function markAttributeIndicesForUpdate(attribute, indices, itemSize = 1) {
  let count = 0;
  for (const index of indices) {
    if (index === undefined || index < 0) continue;
    attribute.addUpdateRange(index * itemSize, itemSize);
    count += 1;
  }
  if (count > 0) attribute.needsUpdate = true;
  return count;
}
