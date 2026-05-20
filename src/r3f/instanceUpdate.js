import * as THREE from 'three';

const _color = new THREE.Color();
const _ringColor = new THREE.Color();

/**
 * Pure rebuild of instance attributes from (data, dotStyles, pulseDots,
 * radiusOverrides, defaults) into pre-allocated typed-array buffers.
 *
 * Behaviourally identical to R3FDots' big-effect slow path: same matrix
 * layout (column-major translation + uniform scale), same fill/opacity
 * resolution, same dotInfoById / dynamicDots construction.
 *
 * Extracted so the slow path is benchable headlessly (node) and so the
 * upcoming small-delta variant can share the per-entry math.
 *
 * Buffers:
 *   matrix: Float32Array(16 * N) — instanceMatrix.array
 *   color:  Float32Array(3 * N)  — instanceColor.array
 *   alpha:  Float32Array(N) | null — InstancedBufferAttribute('instanceAlpha').array
 *   focus:  Float32Array(N) | null — InstancedBufferAttribute('instanceFocus').array
 *
 * ringBuffers: { matrix: Float32Array(16 * N), color: Float32Array(3 * N) } | null
 *   When non-null, mirrors mesh.setMatrixAt/setColorAt on the ring mesh:
 *   ring matrix is positioned at (x, -y, -0.1) with scale=0 (animation
 *   blows it up in useFrame), ring color is pulseColor || fill.
 */
export function applyDotStylesToInstances({
  data,
  dotStyles,
  pulseDots,
  radiusOverrides,
  defaults,
  hoveredId,
  buffers,
  ringBuffers,
  prev = null,
}) {
  if (prev && canTakeDeltaPath(prev, data, defaults, hoveredId)) {
    return applyDelta({
      data, dotStyles, pulseDots, radiusOverrides, defaults,
      hoveredId, buffers, ringBuffers, prev,
    });
  }
  return applyFull({
    data, dotStyles, pulseDots, radiusOverrides, defaults,
    hoveredId, buffers, ringBuffers,
  });
}

function canTakeDeltaPath(prev, data, defaults, hoveredId) {
  if (prev.data !== data) return false;
  if (prev.hoveredId !== hoveredId) return false;
  const pd = prev.defaults;
  return pd.defaultColor === defaults.defaultColor
    && pd.defaultSize === defaults.defaultSize
    && pd.defaultOpacity === defaults.defaultOpacity
    && pd.hoverOpacity === defaults.hoverOpacity
    && pd.hoverSizeMultiplier === defaults.hoverSizeMultiplier;
}

function applyFull({
  data,
  dotStyles,
  pulseDots,
  radiusOverrides,
  defaults,
  hoveredId,
  buffers,
  ringBuffers,
}) {
  const __path = 'full';
  const {
    defaultColor,
    defaultSize,
    defaultOpacity,
    hoverOpacity,
    hoverSizeMultiplier,
  } = defaults;
  const { matrix, color, alpha, focus } = buffers;

  const dotInfoById = new Map();
  const dynamicDots = [];
  const dynamicDotsById = new Map();
  let needsMatrixUpdate = false;
  let needsColorUpdate = false;
  let needsAlphaUpdate = false;
  let needsFocusUpdate = false;
  let needsRingMatrixUpdate = false;
  let needsRingColorUpdate = false;

  const n = data.length;
  for (let i = 0; i < n; i++) {
    const item = data[i];
    const customStyle = dotStyles.get(item.id) || {};
    const isHovered = item.id === hoveredId;
    const pulse = pulseDots.get(item.id);

    const baseSize = customStyle.r ?? radiusOverrides.get(item.id) ?? item.size ?? defaultSize;
    const scale = isHovered ? baseSize * hoverSizeMultiplier : baseSize;
    const fill = customStyle.fill || customStyle.color || item.color || defaultColor || '#7c6fff';

    const baseOpacity = customStyle.opacity !== undefined
      ? customStyle.opacity
      : (isHovered ? hoverOpacity : defaultOpacity);

    const worldY = -item.y;
    const off = i * 16;
    matrix[off + 0] = scale;
    matrix[off + 1] = 0;
    matrix[off + 2] = 0;
    matrix[off + 3] = 0;
    matrix[off + 4] = 0;
    matrix[off + 5] = scale;
    matrix[off + 6] = 0;
    matrix[off + 7] = 0;
    matrix[off + 8] = 0;
    matrix[off + 9] = 0;
    matrix[off + 10] = scale;
    matrix[off + 11] = 0;
    matrix[off + 12] = item.x;
    matrix[off + 13] = worldY;
    matrix[off + 14] = 0;
    matrix[off + 15] = 1;
    needsMatrixUpdate = true;

    _color.set(fill);
    const cOff = i * 3;
    color[cOff + 0] = _color.r;
    color[cOff + 1] = _color.g;
    color[cOff + 2] = _color.b;
    needsColorUpdate = true;

    if (alpha) {
      alpha[i] = baseOpacity;
      needsAlphaUpdate = true;
    }

    if (focus) {
      const focusValue = customStyle.focusRing ? 1 : 0;
      if (focus[i] !== focusValue) {
        focus[i] = focusValue;
        needsFocusUpdate = true;
      }
    }

    dotInfoById.set(item.id, {
      index: i,
      x: item.x,
      y: worldY,
      baseScale: baseSize,
      baseOpacity,
      customOpacity: customStyle.opacity,
    });

    if (pulse) {
      const dynamicDot = {
        id: item.id,
        index: i,
        x: item.x,
        y: worldY,
        baseScale: scale,
        baseFill: fill,
        baseOpacity,
      };
      dynamicDots.push(dynamicDot);
      dynamicDotsById.set(item.id, dynamicDot);
    }

    if (ringBuffers) {
      const ringOff = i * 16;
      ringBuffers.matrix[ringOff + 0] = 0;
      ringBuffers.matrix[ringOff + 1] = 0;
      ringBuffers.matrix[ringOff + 2] = 0;
      ringBuffers.matrix[ringOff + 3] = 0;
      ringBuffers.matrix[ringOff + 4] = 0;
      ringBuffers.matrix[ringOff + 5] = 0;
      ringBuffers.matrix[ringOff + 6] = 0;
      ringBuffers.matrix[ringOff + 7] = 0;
      ringBuffers.matrix[ringOff + 8] = 0;
      ringBuffers.matrix[ringOff + 9] = 0;
      ringBuffers.matrix[ringOff + 10] = 0;
      ringBuffers.matrix[ringOff + 11] = 0;
      ringBuffers.matrix[ringOff + 12] = item.x;
      ringBuffers.matrix[ringOff + 13] = worldY;
      ringBuffers.matrix[ringOff + 14] = -0.1;
      ringBuffers.matrix[ringOff + 15] = 1;
      needsRingMatrixUpdate = true;

      _ringColor.set(pulse?.pulseColor || fill);
      ringBuffers.color[cOff + 0] = _ringColor.r;
      ringBuffers.color[cOff + 1] = _ringColor.g;
      ringBuffers.color[cOff + 2] = _ringColor.b;
      needsRingColorUpdate = true;
    }
  }

  return {
    path: __path,
    dotInfoById,
    dynamicDots,
    dynamicDotsById,
    dirty: {
      matrix: needsMatrixUpdate,
      color: needsColorUpdate,
      alpha: needsAlphaUpdate,
      focus: needsFocusUpdate,
      ringMatrix: needsRingMatrixUpdate,
      ringColor: needsRingColorUpdate,
    },
  };
}

/**
 * Delta path: data positions and defaults are stable. Walk only the
 * symmetric difference of dotStyles/pulseDots/radiusOverrides keys and
 * update those instance slots. Mutates prev.dotInfoById / dynamicDotsById
 * in place — caller passes them in and reassigns refs to the returned
 * object, so identity stays the same across calls (consumers always read
 * via .get(id)).
 *
 * Matrix positions are not rewritten — same data ref guarantees same
 * positions. Only scale columns [0]/[5]/[10] get touched.
 */
function applyDelta({
  data,
  dotStyles,
  pulseDots,
  radiusOverrides,
  defaults,
  hoveredId,
  buffers,
  ringBuffers,
  prev,
}) {
  const __path = 'delta';
  const { defaultColor, defaultSize, defaultOpacity, hoverOpacity, hoverSizeMultiplier } = defaults;
  const { matrix, color, alpha, focus } = buffers;
  const { dotInfoById, dynamicDotsById } = prev;
  let dynamicDots = prev.dynamicDots;

  const changed = new Set();
  collectChangedKeys(prev.dotStyles, dotStyles, changed);
  collectChangedKeys(prev.pulseDots, pulseDots, changed);
  collectChangedKeys(prev.radiusOverrides, radiusOverrides, changed);

  let needsMatrixUpdate = false;
  let needsColorUpdate = false;
  let needsAlphaUpdate = false;
  let needsFocusUpdate = false;
  let needsRingMatrixUpdate = false;
  let needsRingColorUpdate = false;
  let dynamicDotsListDirty = false;

  for (const id of changed) {
    const info = dotInfoById.get(id);
    if (!info) continue;
    const i = info.index;
    const item = data[i];
    const customStyle = dotStyles.get(id) || {};
    const isHovered = id === hoveredId;
    const pulse = pulseDots.get(id);

    const baseSize = customStyle.r ?? radiusOverrides.get(id) ?? item.size ?? defaultSize;
    const scale = isHovered ? baseSize * hoverSizeMultiplier : baseSize;
    const fill = customStyle.fill || customStyle.color || item.color || defaultColor || '#7c6fff';
    const baseOpacity = customStyle.opacity !== undefined
      ? customStyle.opacity
      : (isHovered ? hoverOpacity : defaultOpacity);

    const off = i * 16;
    matrix[off + 0] = scale;
    matrix[off + 5] = scale;
    matrix[off + 10] = scale;
    needsMatrixUpdate = true;

    _color.set(fill);
    const cOff = i * 3;
    color[cOff + 0] = _color.r;
    color[cOff + 1] = _color.g;
    color[cOff + 2] = _color.b;
    needsColorUpdate = true;

    if (alpha) {
      alpha[i] = baseOpacity;
      needsAlphaUpdate = true;
    }

    if (focus) {
      const focusValue = customStyle.focusRing ? 1 : 0;
      if (focus[i] !== focusValue) {
        focus[i] = focusValue;
        needsFocusUpdate = true;
      }
    }

    info.baseScale = baseSize;
    info.baseOpacity = baseOpacity;
    info.customOpacity = customStyle.opacity;

    const prevDyn = dynamicDotsById.get(id);
    if (pulse) {
      const dynamicDot = {
        id,
        index: i,
        x: item.x,
        y: info.y,
        baseScale: scale,
        baseFill: fill,
        baseOpacity,
      };
      dynamicDotsById.set(id, dynamicDot);
      if (prevDyn) {
        const idx = dynamicDots.indexOf(prevDyn);
        if (idx >= 0) dynamicDots[idx] = dynamicDot;
        else dynamicDotsListDirty = true;
      } else {
        dynamicDotsListDirty = true;
      }
    } else if (prevDyn) {
      dynamicDotsById.delete(id);
      dynamicDotsListDirty = true;
    }

    if (ringBuffers) {
      _ringColor.set(pulse?.pulseColor || fill);
      ringBuffers.color[cOff + 0] = _ringColor.r;
      ringBuffers.color[cOff + 1] = _ringColor.g;
      ringBuffers.color[cOff + 2] = _ringColor.b;
      needsRingColorUpdate = true;
    }
  }

  if (dynamicDotsListDirty) {
    dynamicDots = Array.from(dynamicDotsById.values());
  }

  return {
    path: __path,
    dotInfoById,
    dynamicDots,
    dynamicDotsById,
    dirty: {
      matrix: needsMatrixUpdate,
      color: needsColorUpdate,
      alpha: needsAlphaUpdate,
      focus: needsFocusUpdate,
      ringMatrix: needsRingMatrixUpdate,
      ringColor: needsRingColorUpdate,
    },
  };
}

function collectChangedKeys(prev, next, out) {
  for (const [k, v] of prev) {
    if (next.get(k) !== v) out.add(k);
  }
  for (const k of next.keys()) {
    if (!prev.has(k)) out.add(k);
  }
}
