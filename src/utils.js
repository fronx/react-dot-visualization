export function boundsForData(data, dotSize = 2) {
  if (!data || data.length === 0) {
    return {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    };
  }

  // Find the maximum radius among all dots
  const maxRadius = data.reduce((max, obj) => {
    const radius = obj.size || dotSize;
    return Math.max(max, radius);
  }, 0);

  // Add 4x padding to prevent giant dots from filling the screen.
  // When rendering only 2-3 initial dots at large sizes (50-100px), fitting them to 90%
  // of screen would be overwhelming. This padding creates a minimum boundary that scales
  // with dot size, ensuring comfortable spacing as dots shrink during import.
  const paddedRadius = maxRadius * 4;

  // Calculate bounds using each dot's center position plus the padded radius
  return data.reduce((acc, obj) => ({
    minX: Math.min(acc.minX, obj.x - paddedRadius),
    minY: Math.min(acc.minY, obj.y - paddedRadius),
    maxX: Math.max(acc.maxX, obj.x + paddedRadius),
    maxY: Math.max(acc.maxY, obj.y + paddedRadius),
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

export function calculateViewBox(data, margin = 0.1, dotSize) {
  const bounds = boundsForData(data, dotSize);
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
export function getStableViewBoxUpdate(data, currentViewBox, margin = 0.1, dotSize) {
  if (!data || data.length === 0) return null;

  // If no current viewBox, this is the initial setup: compute it from the data once.
  if (!currentViewBox) {
    const initialViewBox = calculateViewBox(data, margin, dotSize);
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

/**
 * Check if new data should trigger auto-zoom based on content fit percentage
 * @param {Array} newData - Array of data points with x,y coordinates
 * @param {Object} previousBounds - Previous data bounds {minX, maxX, minY, maxY}
 * @param {Array} viewBox - Current viewBox [x, y, width, height]
 * @param {Object} transform - Current zoom transform {k, x, y}
 * @param {number} dotSize - Default dot size for bounds calculation
 * @returns {boolean} True if auto-zoom should be triggered
 */
export function shouldAutoZoomToNewContent(newData, previousBounds, viewBox, transform, dotSize) {
  if (!newData.length || !viewBox || !transform) return false;

  const newBounds = boundsForData(newData, dotSize);

  // SPECIAL CASE: Initial zoom when previousBounds is null (first data arrival)
  // Always zoom to fit the initial content
  if (!previousBounds) {
    return true;
  }

  // First check if bounds have changed beyond a small tolerance (2%)
  const tolerance = 0.02;

  const prevWidth = previousBounds.maxX - previousBounds.minX;
  const prevHeight = previousBounds.maxY - previousBounds.minY;
  const newWidth = newBounds.maxX - newBounds.minX;
  const newHeight = newBounds.maxY - newBounds.minY;

  const widthChanged = Math.abs(newWidth - prevWidth) / prevWidth > tolerance;
  const heightChanged = Math.abs(newHeight - prevHeight) / prevHeight > tolerance;

  const boundsChanged =
    Math.abs(newBounds.minX - previousBounds.minX) / prevWidth > tolerance ||
    Math.abs(newBounds.maxX - previousBounds.maxX) / prevWidth > tolerance ||
    Math.abs(newBounds.minY - previousBounds.minY) / prevHeight > tolerance ||
    Math.abs(newBounds.maxY - previousBounds.maxY) / prevHeight > tolerance ||
    widthChanged || heightChanged;

  // If bounds haven't changed significantly, don't auto-zoom
  if (!boundsChanged) return false;

  // Calculate how much of the current view the content occupies
  const { k, x: tx, y: ty } = transform;
  const [vbX, vbY, vbW, vbH] = viewBox;

  // Current visible area in data coordinates (inverse transform)
  const visibleDataWidth = vbW / k;
  const visibleDataHeight = vbH / k;

  // Content size in data coordinates
  const contentWidth = newBounds.maxX - newBounds.minX;
  const contentHeight = newBounds.maxY - newBounds.minY;

  // Calculate what percentage of the view the content occupies
  const widthFitPercentage = contentWidth / visibleDataWidth;
  const heightFitPercentage = contentHeight / visibleDataHeight;

  // Use the larger percentage (limiting factor)
  const contentFitPercentage = Math.max(widthFitPercentage, heightFitPercentage);

  // HYSTERESIS: Use wider thresholds to prevent oscillation
  // Zoom OUT if content < 40% (too zoomed in)
  // Zoom IN if content > 95% (too zoomed out, content barely fits)
  // Dead zone: 40-95% = comfortable viewing range, no zoom changes
  const shouldZoom = contentFitPercentage < 0.4 || contentFitPercentage > 0.95;

  return shouldZoom;
}

// --- Zoom extent helpers (absolute-extent management) ---

export function computeAbsoluteExtent(relExtent, baseScale) {
  const [rmin, rmax] = Array.isArray(relExtent) && relExtent.length === 2
    ? relExtent
    : [0.25, 10]; // fallback if needed
  const s = baseScale > 0 ? baseScale : 1;
  const a = Math.min(rmin, rmax) * s;
  const b = Math.max(rmin, rmax) * s;
  return [a, b];
}

export function unionExtent(a, b) {
  // a, b are [min,max]; treat undefined defensively
  const [amin, amax] = a || [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const [bmin, bmax] = b || [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  return [Math.min(amin, bmin), Math.max(amax, bmax)];
}

// Sets handler's absolute extent. Guard for handler existence.
export function setAbsoluteExtent(handler, absExtent) {
  if (handler && absExtent && absExtent.length === 2) {
    handler.scaleExtent(absExtent);
  }
}

/**
 * Updates zoom extent to accommodate data, using the exact same code path as auto-zoom.
 * This ensures perfect consistency between auto-zoom and manual zoom extent calculations.
 * @param {Object} zoomHandler - D3 zoom handler
 * @param {Array} data - Array of data points with x,y coordinates
 * @param {Array} viewBox - Current viewBox [x, y, width, height] 
 * @param {Object} svgRect - DOM rect with width/height
 * @param {Object} occlusion - Occlusion object {left, right, top, bottom}
 * @param {Array} zoomExtent - Relative zoom extent [min, max]
 * @param {number} fitMargin - Margin for fitting (0-1)
 * @returns {boolean} True if extent was updated
 */
export function updateZoomExtentForData(zoomHandler, data, viewBox, svgRect, occlusion, zoomExtent, fitMargin = 0.9, dotSize) {
  if (!zoomHandler || !data.length || !viewBox || !svgRect || !zoomExtent) return false;

  const currentExtent = zoomHandler.scaleExtent();
  const bounds = boundsForData(data, dotSize);

  // Use the EXACT same code path as auto-zoom: computeFitTransformToVisible
  const fitTransform = computeFitTransformToVisible(bounds, viewBox, svgRect, occlusion, fitMargin);
  if (!fitTransform) return false;

  const baseScale = fitTransform.k;
  const requiredExtent = computeAbsoluteExtent(zoomExtent, baseScale);

  // Only update if we need a more permissive extent (allow zooming out further)
  const hasNoExtent = !currentExtent || currentExtent[0] === 0 && currentExtent[1] === Infinity;
  const needsMorePermissive = requiredExtent[0] < currentExtent[0];

  if (hasNoExtent || needsMorePermissive) {
    // Expand current extent to accommodate new data
    const newExtent = hasNoExtent ? requiredExtent : unionExtent(currentExtent, requiredExtent);
    setAbsoluteExtent(zoomHandler, newExtent);
    return true;
  }

  return false;
}

/**
 * Count dots that are currently visible within the viewport using transform bounds
 * This is O(n) efficient and uses the current zoom transform for precise calculation
 * @param {Array} data - Array of data points with x,y coordinates
 * @param {Object} transform - Current D3 zoom transform {k, x, y}
 * @param {Array} viewBox - Current viewBox [x, y, width, height]
 * @param {number} defaultSize - Default dot size for radius calculation
 * @returns {number} Count of visible dots
 */
/**
 * Convert zoom transform from viewBox coordinates to CSS pixel coordinates
 * This is needed for canvas interactions where mouse events are in CSS pixels
 * but the zoom transform is in viewBox coordinates
 * 
 * @param {Object} zoomTransform - D3 zoom transform {k, x, y} in viewBox space
 * @param {Array} effectiveViewBox - ViewBox [x, y, width, height]
 * @param {Object} canvasDimensions - Canvas CSS dimensions {width, height}
 * @returns {Object} Transform {k, x, y} in CSS pixel space
 */
export function transformToCSSPixels(zoomTransform, effectiveViewBox, canvasDimensions) {
  const cssTransform = { ...zoomTransform };
  
  if (effectiveViewBox && canvasDimensions) {
    const { width, height } = canvasDimensions; // CSS pixels
    const [vbX, vbY, vbW, vbH] = effectiveViewBox;

    // Scale from viewBox coordinates to CSS pixels (no DPR here)
    const scaleX = width / vbW;
    const scaleY = height / vbH;
    const translateX = -vbX * scaleX;
    const translateY = -vbY * scaleY;

    // Combine viewBox transform with zoom transform to get CSS pixel positions
    cssTransform.k = zoomTransform.k * scaleX;
    cssTransform.x = (zoomTransform.x * scaleX) + translateX;
    cssTransform.y = (zoomTransform.y * scaleY) + translateY;
  }
  
  return cssTransform;
}

export function countVisibleDots(data, transform, viewBox, defaultSize = 2) {
  if (!data || !data.length || !transform || !viewBox) return 0;

  const { k, x: tx, y: ty } = transform;
  const [vbX, vbY, vbW, vbH] = viewBox;

  // Calculate visible data bounds (inverse transform)
  const visibleLeft = (vbX - tx) / k;
  const visibleRight = (vbX + vbW - tx) / k;
  const visibleTop = (vbY - ty) / k;
  const visibleBottom = (vbY + vbH - ty) / k;

  let visibleCount = 0;

  for (const dot of data) {
    const radius = (dot.size || defaultSize) / 2;

    // Check if dot (including its radius) intersects with visible area
    if (dot.x + radius >= visibleLeft &&
      dot.x - radius <= visibleRight &&
      dot.y + radius >= visibleTop &&
      dot.y - radius <= visibleBottom) {
      visibleCount++;
    }
  }

  return visibleCount;
}

