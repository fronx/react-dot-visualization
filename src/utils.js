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
  let width = box[2] * (1 + 2*margin);
  let height = box[3] * (1 + 2*margin);
  let minX = box[0] - (width - box[2])/4;
  let minY = box[1] - (height - box[3])/4;
  return [minX, minY, width, height];
}

export function calculateViewBox(data, margin = 0.1) {
  const bounds = boundsForData(data);
  const box = [bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY];
  return withMargin(margin, box);
}