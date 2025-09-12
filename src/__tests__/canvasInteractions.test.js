/**
 * Tests for canvas interaction utilities
 */
import { buildSpatialIndex, findDotAtPosition } from '../canvasInteractions.js';

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
    
    expect(index).toHaveProperty('spatialGrid');
    expect(index).toHaveProperty('cellSize');
    expect(index.spatialGrid.size).toBeGreaterThan(0);
  });
  
  test('findDotAtPosition finds correct dot', () => {
    const index = buildSpatialIndex(mockData, mockGetSize, mockTransform);
    
    // Should hit first dot at 100,100 (radius 5)
    const hit1 = findDotAtPosition(100, 100, index);
    expect(hit1).toEqual(mockData[0]);
    
    // Should hit second dot at 200,200
    const hit2 = findDotAtPosition(200, 200, index);
    expect(hit2).toEqual(mockData[1]);
    
    // Should miss at empty space
    const miss = findDotAtPosition(50, 50, index);
    expect(miss).toBeNull();
  });
  
  test('findDotAtPosition respects dot radius', () => {
    const index = buildSpatialIndex(mockData, mockGetSize, mockTransform);
    
    // Should hit at edge of dot (radius = 5)
    const hitEdge = findDotAtPosition(105, 100, index);
    expect(hitEdge).toEqual(mockData[0]);
    
    // Should miss just outside radius
    const missEdge = findDotAtPosition(106, 100, index);
    expect(missEdge).toBeNull();
  });
  
  test('findDotAtPosition works with zoom transform', () => {
    const zoomTransform = { k: 2, x: 50, y: 50 }; // 2x zoom, offset
    const index = buildSpatialIndex(mockData, mockGetSize, zoomTransform);
    
    // Dot at 100,100 becomes screen position (100*2+50, 100*2+50) = (250, 250)
    const hit = findDotAtPosition(250, 250, index);
    expect(hit).toEqual(mockData[0]);
    
    // Original position should now miss
    const miss = findDotAtPosition(100, 100, index);
    expect(miss).toBeNull();
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
    expect(hit).toEqual(overlappingData[1]);
  });
});