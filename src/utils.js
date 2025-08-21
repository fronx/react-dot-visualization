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
