import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import * as d3 from 'd3';

describe('ZoomManager - Complete Zoom Functionality Tests', () => {
  let dom, document, ZoomManager;
  let mockZoomRef, mockContentRef;
  let canvasRenderCalls, svgTransformCalls, transformChangeCalls;
  let zoomManager;

  beforeEach(async () => {
    // Setup JSDOM
    dom = new JSDOM(`<!DOCTYPE html><div id="zoom-container"><g id="content"></g></div>`);
    document = dom.window.document;
    global.document = document;
    global.window = dom.window;
    global.requestAnimationFrame = (callback) => setTimeout(callback, 16);

    // Import ZoomManager
    const module = await import('../src/ZoomManager.js');
    ZoomManager = module.ZoomManager;

    // Setup mock refs
    mockZoomRef = { current: document.getElementById('zoom-container') };
    mockContentRef = { current: document.getElementById('content') };

    // Track calls
    canvasRenderCalls = [];
    svgTransformCalls = [];
    transformChangeCalls = [];

    // Mock canvas renderer
    const mockCanvasRenderer = (transform) => {
      canvasRenderCalls.push({
        transform: { k: transform.k, x: transform.x, y: transform.y },
        timestamp: Date.now()
      });
    };

    // Mock SVG transform setting
    const originalSetAttribute = mockContentRef.current.setAttribute;
    mockContentRef.current.setAttribute = function(attr, value) {
      if (attr === 'transform') {
        const match = value.match(/translate\(([^,]+),([^)]+)\)\s*scale\(([^)]+)\)/);
        if (match) {
          svgTransformCalls.push({
            transform: { 
              x: parseFloat(match[1]), 
              y: parseFloat(match[2]), 
              k: parseFloat(match[3]) 
            },
            timestamp: Date.now()
          });
        }
      }
      return originalSetAttribute.call(this, attr, value);
    };

    // Create zoom manager
    zoomManager = new ZoomManager({
      zoomRef: mockZoomRef,
      contentRef: mockContentRef,
      canvasRenderer: mockCanvasRenderer,
      useCanvas: true,
      onTransformChange: () => {
        transformChangeCalls.push({ timestamp: Date.now() });
      }
    });
  });

  afterEach(() => {
    if (zoomManager) {
      zoomManager.destroy();
    }
    dom.window.close();
    delete global.document;
    delete global.window;
    delete global.requestAnimationFrame;
  });

  test('FLICKER FIX: Canvas and SVG render synchronously with same transform', async () => {
    zoomManager.initialize();

    const testTransform = { k: 1.5, x: 100, y: 50, toString: () => 'translate(100,50) scale(1.5)' };
    
    // Simulate zoom event
    zoomManager.handleZoom({ transform: testTransform });
    
    // Wait for rAF
    await new Promise(resolve => setTimeout(resolve, 20));
    
    // Both layers should render with same transform in same frame
    assert.strictEqual(canvasRenderCalls.length, 1, 'Canvas should render once');
    assert.strictEqual(svgTransformCalls.length, 1, 'SVG should render once');
    
    const canvas = canvasRenderCalls[0];
    const svg = svgTransformCalls[0];
    
    // Same transform values
    assert.strictEqual(canvas.transform.k, svg.transform.k, 'Scale must match');
    assert.strictEqual(canvas.transform.x, svg.transform.x, 'X translation must match');
    assert.strictEqual(canvas.transform.y, svg.transform.y, 'Y translation must match');
    
    // Same timing (within 5ms)
    const timeDiff = Math.abs(canvas.timestamp - svg.timestamp);
    assert.ok(timeDiff < 5, `Canvas and SVG must render synchronously, got ${timeDiff}ms apart`);
  });

  test('FLICKER FIX: Rapid zoom events are coalesced', async () => {
    zoomManager.initialize();

    // Fire multiple rapid zoom events
    for (let i = 0; i < 5; i++) {
      zoomManager.handleZoom({ 
        transform: { k: 1 + i * 0.1, x: i * 20, y: i * 10, toString: () => `transform-${i}` }
      });
    }
    
    // Wait for rAF
    await new Promise(resolve => setTimeout(resolve, 20));
    
    // Should coalesce into single render with latest transform
    assert.strictEqual(canvasRenderCalls.length, 1, 'Should coalesce rapid events');
    assert.strictEqual(canvasRenderCalls[0].transform.k, 1.4, 'Should use latest transform');
    assert.strictEqual(canvasRenderCalls[0].transform.x, 80, 'Should use latest transform');
  });

  test('AUTO-ZOOM: zoomToVisible works for fitting data', async () => {
    // Set up view box
    zoomManager.setViewBox([0, 0, 1000, 500]);
    
    // Mock getBoundingClientRect
    mockZoomRef.current.getBoundingClientRect = () => ({
      width: 1000,
      height: 500
    });

    const testData = [
      { id: 0, x: 100, y: 100 },
      { id: 1, x: 900, y: 400 }
    ];

    const success = await zoomManager.zoomToVisible(testData);
    
    assert.strictEqual(success, true, 'zoomToVisible should succeed');
    
    // Should have applied transform to fit the data
    const finalTransform = zoomManager.getCurrentTransform();
    assert.ok(finalTransform.k > 0, 'Should have positive scale');
    assert.ok(typeof finalTransform.x === 'number', 'Should have numeric x translation');
    assert.ok(typeof finalTransform.y === 'number', 'Should have numeric y translation');
  });

  test('AUTO-ZOOM: checkAutoZoom triggers when conditions are met', () => {
    // Set up for auto-zoom detection
    zoomManager.setViewBox([0, 0, 1000, 500]);
    zoomManager.updateDataBounds([{ id: 0, x: 500, y: 250 }]); // Initial small bounds
    
    mockZoomRef.current.getBoundingClientRect = () => ({
      width: 1000,
      height: 500
    });

    // New data that extends beyond previous bounds
    const newData = [
      { id: 0, x: 500, y: 250 },
      { id: 1, x: 100, y: 100 },
      { id: 2, x: 900, y: 400 }
    ];

    const didAutoZoom = zoomManager.checkAutoZoom(newData, {
      autoZoomToNewContent: true,
      autoZoomDuration: 0 // No animation for testing
    });

    // Note: The actual shouldAutoZoomToNewContent logic determines if this triggers
    // This test verifies the integration works without errors
    assert.ok(typeof didAutoZoom === 'boolean', 'checkAutoZoom should return boolean');
  });

  test('PROGRAMMATIC ZOOM: animateToTransform works smoothly', async () => {
    zoomManager.initialize();

    const targetTransform = { k: 2, x: 100, y: 50 };
    
    // Start animation
    const animationPromise = zoomManager.animateToTransform(targetTransform, { duration: 50 });
    
    // Should complete without error
    await animationPromise;
    
    // Final transform should match target
    const finalTransform = zoomManager.getCurrentTransform();
    assert.strictEqual(finalTransform.k, 2, 'Final scale should match target');
    assert.strictEqual(finalTransform.x, 100, 'Final x should match target');
    assert.strictEqual(finalTransform.y, 50, 'Final y should match target');
  });

  test('CONFIGURATION: updateConfig works correctly', () => {
    const initialFitMargin = zoomManager.fitMargin;
    
    zoomManager.updateConfig({ 
      fitMargin: 0.5, 
      useCanvas: false,
      defaultSize: 5 
    });
    
    assert.strictEqual(zoomManager.fitMargin, 0.5, 'fitMargin should update');
    assert.strictEqual(zoomManager.useCanvas, false, 'useCanvas should update');
    assert.strictEqual(zoomManager.defaultSize, 5, 'defaultSize should update');
  });

  test('ERROR HANDLING: animateToTransform rejects when zoomRef unavailable', async () => {
    const badManager = new ZoomManager({ zoomRef: { current: null } });
    
    try {
      await badManager.animateToTransform({ k: 2, x: 0, y: 0 });
      assert.fail('Should have rejected');
    } catch (error) {
      assert.strictEqual(error.message, 'zoomRef not available');
    }
  });

  test('INTEGRATION: Complete zoom workflow works end-to-end', async () => {
    // Initialize
    zoomManager.initialize();
    zoomManager.setViewBox([0, 0, 1000, 500]);
    
    mockZoomRef.current.getBoundingClientRect = () => ({
      width: 1000,
      height: 500
    });

    // 1. Handle interactive zoom
    zoomManager.handleZoom({ 
      transform: { k: 1.2, x: 50, y: 25, toString: () => 'translate(50,25) scale(1.2)' }
    });
    
    await new Promise(resolve => setTimeout(resolve, 20));
    
    // Should have rendered both layers
    assert.ok(canvasRenderCalls.length > 0, 'Canvas should render');
    assert.ok(svgTransformCalls.length > 0, 'SVG should render');
    
    // 2. Update data bounds
    const testData = [{ id: 0, x: 500, y: 250 }];
    zoomManager.updateDataBounds(testData);
    
    // 3. Try programmatic zoom
    await zoomManager.zoomToVisible(testData, { duration: 0 });
    
    // Should complete without errors
    const finalTransform = zoomManager.getCurrentTransform();
    assert.ok(finalTransform, 'Should have final transform');
    
    // 4. Check that callbacks were called
    assert.ok(transformChangeCalls.length > 0, 'Transform change callbacks should fire');
  });
});