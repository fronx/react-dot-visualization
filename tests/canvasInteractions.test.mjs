/**
 * Tests for canvas interaction utilities.
 *
 * The spatial index is built in DATA-space coordinates. Mouse coords are in
 * CSS pixels; findDotAtPosition takes a transform to invert them back into
 * the data-space frame the index lives in.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildSpatialIndex, findDotAtPosition } from '../src/canvasInteractions.js';
import { transformToCSSPixels } from '../src/utils.js';

describe('Canvas Interactions', () => {
  const mockData = [
    { id: 0, x: 100, y: 100 },
    { id: 1, x: 200, y: 200 },
    { id: 2, x: 150, y: 150 }
  ];

  // Radius in data-space units. Sensitivity zone is 2× this.
  const mockGetSize = () => 10;
  const identityTransform = { k: 1, x: 0, y: 0 };

  test('buildSpatialIndex creates grid with correct dots', () => {
    const index = buildSpatialIndex(mockData, mockGetSize);

    assert(index.grid);
    assert(index.cellSize > 0);
    assert(index.grid.size > 0);
  });

  test('buildSpatialIndex defaults cellSize to 4× mean radius', () => {
    const index = buildSpatialIndex(mockData, mockGetSize);
    // All radii = 10 → mean = 10 → default cellSize = 40
    assert.strictEqual(index.cellSize, 40);
  });

  test('buildSpatialIndex honours an explicit cellSize override', () => {
    const index = buildSpatialIndex(mockData, mockGetSize, { cellSize: 25 });
    assert.strictEqual(index.cellSize, 25);
  });

  test('findDotAtPosition finds correct dot under identity transform', () => {
    const index = buildSpatialIndex(mockData, mockGetSize);

    // Mouse coords are CSS pixels; identity transform means CSS = data-space.
    const hit1 = findDotAtPosition(100, 100, identityTransform, index);
    assert.strictEqual(hit1, mockData[0]);

    const hit2 = findDotAtPosition(200, 200, identityTransform, index);
    assert.strictEqual(hit2, mockData[1]);

    // Empty space — should miss
    const miss = findDotAtPosition(50, 50, identityTransform, index);
    assert.strictEqual(miss, null);
  });

  test('findDotAtPosition respects sensitivity zone (2× data-space radius)', () => {
    const index = buildSpatialIndex(mockData, mockGetSize);

    // radius = 10, sensitivity = 20. Mouse at (119, 100) → dist 19, hit.
    const hitEdge = findDotAtPosition(119, 100, identityTransform, index);
    assert.strictEqual(hitEdge, mockData[0]);

    // Mouse at (121, 100) → dist 21, just outside → miss.
    const missEdge = findDotAtPosition(121, 100, identityTransform, index);
    assert.strictEqual(missEdge, null);
  });

  test('findDotAtPosition works with zoom transform', () => {
    const zoomTransform = { k: 2, x: 50, y: 50 }; // 2× zoom, offset
    const index = buildSpatialIndex(mockData, mockGetSize);

    // Dot at data-space (100, 100) projects to CSS (100*2 + 50, 100*2 + 50) = (250, 250).
    const hit = findDotAtPosition(250, 250, zoomTransform, index);
    assert.strictEqual(hit, mockData[0]);

    // The CSS position (100, 100) inverts to data-space (25, 25) — empty.
    const miss = findDotAtPosition(100, 100, zoomTransform, index);
    assert.strictEqual(miss, null);
  });

  test('findDotAtPosition works with CSS-pixel transform from viewBox', () => {
    const zoomTransform = { k: 1, x: 0, y: 0 };
    const viewBox = [0, 0, 1000, 500];
    const canvasDimensions = { width: 500, height: 250 };

    const cssTransform = transformToCSSPixels(zoomTransform, viewBox, canvasDimensions);
    const index = buildSpatialIndex(mockData, mockGetSize);

    // viewBox→CSS scale is 0.5; dot at data-space (100, 100) projects to CSS (50, 50).
    const hit1 = findDotAtPosition(50, 50, cssTransform, index);
    assert.strictEqual(hit1, mockData[0]);

    // Dot at data-space (200, 200) projects to CSS (100, 100).
    const hit2 = findDotAtPosition(100, 100, cssTransform, index);
    assert.strictEqual(hit2, mockData[1]);

    // (10, 10) CSS = (20, 20) data — empty.
    const miss = findDotAtPosition(10, 10, cssTransform, index);
    assert.strictEqual(miss, null);
  });

  test('findDotAtPosition returns closest dot for overlaps', () => {
    const overlappingData = [
      { id: 0, x: 100, y: 100 },
      { id: 1, x: 105, y: 105 },
    ];

    const index = buildSpatialIndex(overlappingData, mockGetSize);

    // Mouse at (102, 102) — dot0 is ~2.83 away, dot1 is ~4.24 away → dot0 wins.
    const hit = findDotAtPosition(102, 102, identityTransform, index);
    assert.strictEqual(hit, overlappingData[0]);
  });

  test('findDotAtPosition handles missing transform / index gracefully', () => {
    const index = buildSpatialIndex(mockData, mockGetSize);
    assert.strictEqual(findDotAtPosition(100, 100, null, index), null);
    assert.strictEqual(findDotAtPosition(100, 100, identityTransform, null), null);
  });

  test('cells cover the sensitivity zone, not just the body', () => {
    // Single dot at the centre of cellSize=40 → cell (2, 2). With radius 10
    // and sensitivity 20, the index entry must register in any cell the 2×
    // zone touches. Verify by querying just outside the body-only bounds.
    const data = [{ id: 0, x: 100, y: 100 }];
    const index = buildSpatialIndex(data, mockGetSize);

    // Mouse at (85, 100) — distance 15, inside sensitivity 20. Cell (2,2) holds
    // the dot (its sensitivity zone reaches [80,120]×[80,120]). Hit.
    const hit = findDotAtPosition(85, 100, identityTransform, index);
    assert.strictEqual(hit, data[0]);
  });
});

describe('Coordinate Transformation', () => {
  test('transformToCSSPixels returns identity transform when no viewBox or dimensions', () => {
    const zoomTransform = { k: 2, x: 10, y: 20 };
    const result = transformToCSSPixels(zoomTransform, null, null);
    assert.deepStrictEqual(result, zoomTransform);
  });

  test('transformToCSSPixels applies viewBox to CSS pixel transformation', () => {
    const zoomTransform = { k: 1, x: 0, y: 0 }; // Identity zoom
    const viewBox = [0, 0, 1000, 500]; // ViewBox: 1000x500 units
    const canvasDimensions = { width: 500, height: 250 }; // CSS: 500x250 pixels

    const result = transformToCSSPixels(zoomTransform, viewBox, canvasDimensions);

    // Scale factors: 500/1000=0.5, 250/500=0.5
    assert.strictEqual(result.k, 0.5); // k * scaleX
    assert.strictEqual(result.x, 0); // (x * scaleX) + translateX
    assert.strictEqual(result.y, 0); // (y * scaleY) + translateY
  });

  test('transformToCSSPixels combines zoom and viewBox transformations', () => {
    const zoomTransform = { k: 2, x: 100, y: 50 }; // 2x zoom, offset
    const viewBox = [0, 0, 1000, 1000]; // Square viewBox
    const canvasDimensions = { width: 500, height: 500 }; // Half-size CSS

    const result = transformToCSSPixels(zoomTransform, viewBox, canvasDimensions);

    // Scale factor: 500/1000 = 0.5
    assert.strictEqual(result.k, 1); // 2 * 0.5
    assert.strictEqual(result.x, 50); // (100 * 0.5) + 0
    assert.strictEqual(result.y, 25); // (50 * 0.5) + 0
  });

  test('transformToCSSPixels handles viewBox with offset origin', () => {
    const zoomTransform = { k: 1, x: 0, y: 0 };
    const viewBox = [-100, -50, 1000, 500]; // Offset origin
    const canvasDimensions = { width: 500, height: 250 };

    const result = transformToCSSPixels(zoomTransform, viewBox, canvasDimensions);

    // Scale factors: 0.5, 0.5
    // Translate: -(-100 * 0.5) = 50, -(-50 * 0.5) = 25
    assert.strictEqual(result.k, 0.5);
    assert.strictEqual(result.x, 50); // translateX
    assert.strictEqual(result.y, 25); // translateY
  });
});
