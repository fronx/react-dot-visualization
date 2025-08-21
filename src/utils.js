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
  console.log('computeFitTransformToVisible called with bounds', { bounds, viewBox, svgRect, occlusion, margin });
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

/**
 * computeOcclusionAwareViewBox
 *
 * Purpose: Fit `bounds` into the *visible* part of an SVG container that has
 *          occluded strips on its sides, keeping aspect ratio, adding a margin,
 *          and returning an SVG viewBox [x, y, w, h] in data coordinates.
 *
 * ASCII map (not to scale)
 *
 *   Data space (returned viewBox is in these units; x→ right, y→ down if SVG):
 *
 *   ┌────────────────────────────── container (W × H) ───────────────────────────────┐
 *   │◄───────────────────────────────  W (container)  ─────────────────────────────►│
 *   │ ┌──── left ────┐                      visible window (Wv × Hv)                │
 *   │ │   ▒▒▒▒▒▒▒▒▒  │   x_vc = (W + left - right)/2                                │
 *   │ │   ▒          │   y_vc = (H +  top - bottom)/2                               │
 *   │ │   ▒   ┌──────────────────────────────────────────────────────────────┐      │
 *   │ │   ▒   │                Sx × Sy (fits dxm × dym at aspect a)         │      │
 *   │ │   ▒   │   (dxm, dym = data extent with margin)                      │      │
 *   │ │   ▒   │   centered at (cx, cy)                                      │      │
 *   │ │   ▒   └──────────────────────────────────────────────────────────────┘      │
 *   │ │   ▒          │                                                             │
 *   │ │   ▒▒▒▒▒▒▒▒▒  │                                                             │
 *   │ └──────────────┘ top                                                      bottom
 *   │                                  ┌────── right ──────┐                        │
 *   │                                  │      ▒▒▒▒▒▒▒      │                        │
 *   │                                  │      ▒     ▒      │                        │
 *   │                                  │      ▒▒▒▒▒▒▒      │                        │
 *   └────────────────────────────────────────────────────────────────────────────────┘
 *
 * Legend:
 *   W,H     : container width/height
 *   left,…  : occlusion thickness on each side (inside the container)
 *   Wv,Hv   : visible window size = (W-left-right, H-top-bottom)
 *   bounds  : data box {minX,maxX,minY,maxY}; dx,dy its size; (cx,cy) its center
 *   margin  : relative padding around data (e.g. 0.1 → +10% on each side)
 *   dxm,dym : padded data extents = dx*(1+2m), dy*(1+2m)
 *   a       : aspect ratio of visible window, a = Wv/Hv
 *   Sx,Sy   : smallest extents that fit dxm×dym into aspect a without cropping
 *             Sx = max(dxm, a*dym),  Sy = Sx/a
 *   w,h     : final SVG viewBox size; scale Sx,Sy back up so the *visible* window
 *             shows Sx×Sy once occlusions are accounted for:
 *                w = Sx * (W / Wv),   h = Sy * (H / Hv)
 *   x,y     : viewBox origin so that the visible window’s center aligns with (cx,cy).
 *             Visible center in container coordinates:
 *                x_vc = left + Wv/2 = (W + (left - right)) / 2
 *                y_vc = top  + Hv/2 = (H + (top  - bottom)) / 2
 *             Convert that center to data units by scaling with w/W and h/H:
 *                x = cx - w * (x_vc / W)
 *                y = cy - h * (y_vc / H)
 */
export function computeOcclusionAwareViewBox(bounds, container, occlusion = {}, margin = 0.1) {
  console.log('computeOcclusionAwareViewBox called with bounds', { bounds, container, occlusion, margin });
  if (!bounds || !container) return null;
  const { width: W, height: H } = container;
  if (!(W > 0) || !(H > 0)) return null;
  const { left = 0, right = 0, top = 0, bottom = 0 } = occlusion;

  // Data extents and center in data coordinates
  const dx = Math.max(1e-9, bounds.maxX - bounds.minX);
  const dy = Math.max(1e-9, bounds.maxY - bounds.minY);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;

  // Pad extents by margin on both sides
  const dxm = dx * (1 + 2 * margin);
  const dym = dy * (1 + 2 * margin);

  // Visible window after occlusions and its aspect
  const Wv = Math.max(1, W - left - right);
  const Hv = Math.max(1, H - top - bottom);
  const a = Wv / Hv;

  // Fit padded data into visible aspect without cropping
  const Sx = Math.max(dxm, a * dym);
  const Sy = Sx / a;

  // Scale to full container so the visible window shows Sx×Sy
  const w = Sx * (W / Wv);
  const h = Sy * (H / Hv);

  // Align visible window center with (cx,cy)
  const x = cx - w * (W + (left - right)) / (2 * W);
  const y = cy - h * (H + (top - bottom)) / (2 * H);

  return [x, y, w, h];
}