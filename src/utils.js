export function boundsForData(data) {
  return data.reduce((acc, obj) => ({
    minX: Math.min(acc.minX, obj.x),
    minY: Math.min(acc.minY, obj.y),
    maxX: Math.max(acc.maxX, obj.x),
    maxY: Math.max(acc.maxY, obj.y),
  }), {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  });
}

export function withMargin(margin, box) {
  let width = box[2] * (1 + 2 * margin);
  let height = box[3] * (1 + 2 * margin);
  let minX = box[0] - (width - box[2]) / 2;
  let minY = box[1] - (height - box[3]) / 2;
  return [minX, minY, width, height];
}

export function calculateViewBox(data, margin = 0.1) {
  const bounds = boundsForData(data);
  const box = [bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY];
  return withMargin(margin, box);
}

export function fitViewBoxToAspect(viewBox, targetAR, anchor = 'top-left') {
  const EPSILON = 1e-9;
  let [x, y, w, h] = viewBox;
  const currentAR = w / h;

  if (Math.abs(currentAR - targetAR) < EPSILON) {
    // Aspect ratios are close enough; no change.
    return [x, y, w, h];
  }

  if (currentAR < targetAR) {
    // Need to increase width
    const newW = h * targetAR;
    if (anchor === 'top-left') {
      // Keep x, y unchanged; expand to the right
      return [x, y, newW, h];
    }
    // Other anchors could be implemented here if needed
  } else if (currentAR > targetAR) {
    // Need to increase height
    const newH = w / targetAR;
    if (anchor === 'top-left') {
      // Keep x, y unchanged; expand downward
      return [x, y, w, newH];
    }
    // Other anchors could be implemented here if needed
  }

  // If no changes needed or anchor not recognized, return original
  return [x, y, w, h];
}

export function computeFitTransformToVisible(bounds, viewBox, svgRect, occlusion = {}, margin = 0.9) {
  if (!bounds || !viewBox || !svgRect) return null;
  const { left = 0, right = 0, top = 0, bottom = 0 } = occlusion;
  const [minX, minY, maxX, maxY] = [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY];
  const dx = Math.max(1e-9, maxX - minX);
  const dy = Math.max(1e-9, maxY - minY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const [vbX, vbY, vbW, vbH] = viewBox;
  const sx = svgRect.width / vbW;
  const sy = svgRect.height / vbH;
  if (!(sx > 0) || !(sy > 0)) return null;

  const visWpx = Math.max(1, svgRect.width - left - right);
  const visHpx = Math.max(1, svgRect.height - top - bottom);
  const visCxPx = left + visWpx / 2;
  const visCyPx = top + visHpx / 2;

  // Visible rect in viewBox units
  const visWvb = visWpx / sx;
  const visHvb = visHpx / sy;
  const visCxVb = vbX + visCxPx / sx;
  const visCyVb = vbY + visCyPx / sy;

  const k = margin * Math.min(visWvb / dx, visHvb / dy);
  const tx = visCxVb - k * cx;
  const ty = visCyVb - k * cy;
  return { k, x: tx, y: ty };
}

// Pure function: calculate stable viewBox update (no d3 dependencies)
export function getStableViewBoxUpdate(data, currentViewBox, margin = 0.1) {
  if (!data || data.length === 0) return null;

  // If no current viewBox, this is the initial setup: compute it from the data once.
  if (!currentViewBox) {
    const initialViewBox = calculateViewBox(data, margin);
    return {
      newViewBox: initialViewBox
    };
  }

  // Otherwise, never change the viewBox in response to new data.
  return null;
}

export function computeOcclusionAwareViewBox(bounds, container, occlusion = {}, margin = 0.1) {
  if (!bounds || !container) return null;
  const { width: W, height: H } = container;
  if (!(W > 0) || !(H > 0)) return null;
  const { left = 0, right = 0, top = 0, bottom = 0 } = occlusion;

  const dx = Math.max(1e-9, bounds.maxX - bounds.minX);
  const dy = Math.max(1e-9, bounds.maxY - bounds.minY);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;

  const dxm = dx * (1 + 2 * margin);
  const dym = dy * (1 + 2 * margin);

  const Wv = Math.max(1, W - left - right);
  const Hv = Math.max(1, H - top - bottom);
  const a = Wv / Hv;

  const Sx = Math.max(dxm, a * dym);
  const Sy = Sx / a;

  const w = Sx * (W / Wv);
  const h = Sy * (H / Hv);

  const x = cx - w * (W + (left - right)) / (2 * W);
  const y = cy - h * (H + (top - bottom)) / (2 * H);

  return [x, y, w, h];
}