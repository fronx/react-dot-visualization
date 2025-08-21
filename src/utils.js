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

export function bounds(data, fn) {
  return data.reduce((acc, obj) => ({
    min: Math.min(acc.min, fn(obj)),
    max: Math.max(acc.max, fn(obj)),
  }), {
    min: Infinity,
    max: -Infinity,
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

// Check if new bounds extend beyond current viewBox
export function needsViewBoxExpansion(newBounds, currentViewBox) {
  const [vbX, vbY, vbWidth, vbHeight] = currentViewBox;
  return (
    newBounds.minX < vbX ||
    newBounds.minY < vbY ||
    newBounds.maxX > (vbX + vbWidth) ||
    newBounds.maxY > (vbY + vbHeight)
  );
}

// Calculate expanded viewBox that encompasses both current and new bounds
export function calculateExpandedViewBox(newBounds, currentViewBox, margin = 0.1) {
  const [vbX, vbY, vbWidth, vbHeight] = currentViewBox;

  const expandedBounds = {
    minX: Math.min(newBounds.minX, vbX),
    minY: Math.min(newBounds.minY, vbY),
    maxX: Math.max(newBounds.maxX, vbX + vbWidth),
    maxY: Math.max(newBounds.maxY, vbY + vbHeight)
  };

  const box = [expandedBounds.minX, expandedBounds.minY,
  expandedBounds.maxX - expandedBounds.minX,
  expandedBounds.maxY - expandedBounds.minY];

  return withMargin(margin, box);
}

// Calculate the compensating transform when viewBox changes
export function calculateCompensatingTransform(oldViewBox, newViewBox, currentTransform = null) {
  const [oldX, oldY, oldW, oldH] = oldViewBox;
  const [newX, newY, newW, newH] = newViewBox;

  // Calculate scale factors for the viewBox change
  const scaleX = oldW / newW;
  const scaleY = oldH / newH;

  // Calculate translation to compensate for origin shift
  const translateX = (oldX - newX) * (newW / oldW);
  const translateY = (oldY - newY) * (newH / oldH);

  // Return the compensating transform factors (to be applied with d3.zoomIdentity)
  return {
    translateX,
    translateY,
    scaleX,
    scaleY,
    currentTransform
  };
}

// Pure function: calculate stable viewBox update (no d3 dependencies)
export function getStableViewBoxUpdate(data, currentViewBox, margin = 0.1) {
  if (!data || data.length === 0) return null;

  const newBounds = boundsForData(data);

  // If no current viewBox, this is initial setup
  if (!currentViewBox) {
    const initialViewBox = calculateViewBox(data, margin);
    return {
      newViewBox: initialViewBox,
      compensatingFactors: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 }
    };
  }

  if (!needsViewBoxExpansion(newBounds, currentViewBox)) {
    return null; // No expansion needed
  }

  const newViewBox = calculateExpandedViewBox(newBounds, currentViewBox, margin);
  const compensatingFactors = calculateCompensatingTransform(currentViewBox, newViewBox);

  return {
    newViewBox,
    compensatingFactors
  };
}

// Determine if we should apply compensating transform based on data change type
export function shouldApplyCompensatingTransform(newData, previousData, positionsChanged) {
  // No previous data means this is initial load - never compensate
  if (!previousData || previousData.length === 0) {
    return false;
  }

  // If positions changed, we need to distinguish between:
  // 1. Data expansion (appending new dots) - should compensate
  // 2. Data replacement (completely new dataset) - should NOT compensate

  if (positionsChanged) {
    // Check if this is an append operation:
    // - Previous data IDs should be identical in the same positions
    // - New data can have additional items at the end

    if (newData.length <= previousData.length) {
      // Definitely not an append
      return false;
    }

    // Check if all previous IDs match in the same positions
    for (let i = 0; i < previousData.length; i++) {
      if (previousData[i].id !== newData[i].id) {
        // IDs don't match at same position - not an append
        return false;
      }
    }

    // All previous IDs match in same positions - this is an append!
    return true;
  }

  // If positions haven't changed, always compensate (just expanding viewBox for same data)
  return true;
}