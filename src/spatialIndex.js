/**
 * Generic spatial hash grid utilities shared by Canvas and R3F renderers.
 */

/**
 * Build a spatial grid from arbitrary entries.
 * getBounds(entry) must return { minX, maxX, minY, maxY } in the same coordinate space
 * that query calls will use.
 */
export function buildSpatialGrid(entries, { cellSize = 20, getBounds }) {
  const grid = new Map();

  for (const entry of entries) {
    const { minX, maxX, minY, maxY } = getBounds(entry);
    if (!isFinite(minX) || !isFinite(maxX) || !isFinite(minY) || !isFinite(maxY)) continue;
    const minCellX = Math.floor(minX / cellSize);
    const maxCellX = Math.floor(maxX / cellSize);
    const minCellY = Math.floor(minY / cellSize);
    const maxCellY = Math.floor(maxY / cellSize);

    // Skip entries spanning too many cells (degenerate coordinates)
    if (maxCellX - minCellX > 1000 || maxCellY - minCellY > 1000) continue;

    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const key = `${cellX},${cellY}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(entry);
      }
    }
  }

  return { grid, cellSize };
}

/**
 * Query a single cell.
 */
export function queryCell(spatialIndex, x, y) {
  if (!spatialIndex) return [];
  const { grid, cellSize } = spatialIndex;
  const cellX = Math.floor(x / cellSize);
  const cellY = Math.floor(y / cellSize);
  return grid.get(`${cellX},${cellY}`) || [];
}

/**
 * Query all entries in cells intersecting a radius around the point.
 * Dedupes entries because entries can occupy multiple cells.
 */
export function queryRadius(spatialIndex, x, y, radius) {
  if (!spatialIndex) return [];
  const { grid, cellSize } = spatialIndex;
  const range = Math.max(1, Math.ceil(radius / cellSize));
  const centerX = Math.floor(x / cellSize);
  const centerY = Math.floor(y / cellSize);

  const result = [];
  const seen = new Set();

  for (let dx = -range; dx <= range; dx++) {
    for (let dy = -range; dy <= range; dy++) {
      const candidates = grid.get(`${centerX + dx},${centerY + dy}`);
      if (!candidates) continue;
      for (const entry of candidates) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        result.push(entry);
      }
    }
  }

  return result;
}
