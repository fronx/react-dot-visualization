/**
 * Tests for canvas interaction utilities
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
  
  const mockGetSize = () => 10; // 10px diameter
  const mockTransform = { k: 1, x: 0, y: 0 }; // No zoom/pan
  
  test('buildSpatialIndex creates grid with correct dots', () => {
    const index = buildSpatialIndex(mockData, mockGetSize, mockTransform);
    
    assert(index.spatialGrid);
    assert(index.cellSize);
    assert(index.spatialGrid.size > 0);
  });
  
  test('findDotAtPosition finds correct dot', () => {
    const index = buildSpatialIndex(mockData, mockGetSize, mockTransform);
    
    // Should hit first dot at 100,100 (radius 5)
    const hit1 = findDotAtPosition(100, 100, index);
    assert.strictEqual(hit1, mockData[0]);
    
    // Should hit second dot at 200,200
    const hit2 = findDotAtPosition(200, 200, index);
    assert.strictEqual(hit2, mockData[1]);
    
    // Should miss at empty space
    const miss = findDotAtPosition(50, 50, index);
    assert.strictEqual(miss, null);
  });
  
  test('findDotAtPosition respects dot radius', () => {
    const index = buildSpatialIndex(mockData, mockGetSize, mockTransform);
    
    // Should hit at edge of dot (radius = 5)
    const hitEdge = findDotAtPosition(105, 100, index);
    assert.strictEqual(hitEdge, mockData[0]);
    
    // Should miss just outside radius
    const missEdge = findDotAtPosition(106, 100, index);
    assert.strictEqual(missEdge, null);
  });
  
  test('findDotAtPosition works with zoom transform', () => {
    const zoomTransform = { k: 2, x: 50, y: 50 }; // 2x zoom, offset
    const index = buildSpatialIndex(mockData, mockGetSize, zoomTransform);
    
    // Dot at 100,100 becomes screen position (100*2+50, 100*2+50) = (250, 250)
    const hit = findDotAtPosition(250, 250, index);
    assert.strictEqual(hit, mockData[0]);
    
    // Original position should now miss
    const miss = findDotAtPosition(100, 100, index);
    assert.strictEqual(miss, null);
  });
  
  test('findDotAtPosition works with CSS pixel transform', () => {
    // Simulate canvas coordinate transformation
    const zoomTransform = { k: 1, x: 0, y: 0 };
    const viewBox = [0, 0, 1000, 500];
    const canvasDimensions = { width: 500, height: 250 };
    
    const cssTransform = transformToCSSPixels(zoomTransform, viewBox, canvasDimensions);
    const index = buildSpatialIndex(mockData, mockGetSize, cssTransform);
    
    // Dot at 100,100 in data space with 0.5 scale becomes CSS position (50, 50)
    const hit1 = findDotAtPosition(50, 50, index);
    assert.strictEqual(hit1, mockData[0]);
    
    // Dot at 200,200 in data space becomes CSS position (100, 100) with 0.5 scale
    const hit2 = findDotAtPosition(100, 100, index);
    assert.strictEqual(hit2, mockData[1]);
    
    // Position outside any dots should miss
    const miss = findDotAtPosition(10, 10, index);
    assert.strictEqual(miss, null);
  });
  
  test('findDotAtPosition returns topmost dot for overlaps', () => {
    // Create overlapping dots
    const overlappingData = [
      { id: 0, x: 100, y: 100 },
      { id: 1, x: 105, y: 105 }, // Overlaps with first
    ];
    
    const index = buildSpatialIndex(overlappingData, mockGetSize, mockTransform);
    
    // Should return the last one in render order (topmost)
    const hit = findDotAtPosition(102, 102, index);
    assert.strictEqual(hit, overlappingData[1]);
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