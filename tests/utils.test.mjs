import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOcclusionAwareViewBox, shouldAutoZoomToNewContent, computeAbsoluteExtent, unionExtent, setAbsoluteExtent, computeZoomExtentForData, shouldUpdateZoomExtent } from '../src/utils.js';

// --- helpers ---------------------------------------------------------------

const eps = 1e-9;
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

function visibleCenterVB([x, y, w, h], W, H, { left = 0, right = 0, top = 0, bottom = 0 } = {}) {
  const Wv = Math.max(1, W - left - right);
  const Hv = Math.max(1, H - top - bottom);
  const cx = x + (w / W) * (left + Wv / 2);
  const cy = y + (h / H) * (top + Hv / 2);
  return [cx, cy];
}

function visibleSizeVB([, , w, h], W, H, { left = 0, right = 0, top = 0, bottom = 0 } = {}) {
  const Wv = Math.max(1, W - left - right);
  const Hv = Math.max(1, H - top - bottom);
  return [w * (Wv / W), h * (Hv / H)];
}

function expectedFitSizes(bounds, margin, W, H, occl) {
  const dx = Math.max(eps, bounds.maxX - bounds.minX);
  const dy = Math.max(eps, bounds.maxY - bounds.minY);
  const dxm = dx * (1 + 2 * margin);
  const dym = dy * (1 + 2 * margin);
  const Wv = Math.max(1, W - (occl.left || 0) - (occl.right || 0));
  const Hv = Math.max(1, H - (occl.top || 0) - (occl.bottom || 0));
  const a = Wv / Hv;
  const Sx = Math.max(dxm, a * dym);
  const Sy = Sx / a;
  return [Sx, Sy];
}

function dataCenter(bounds) {
  return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
}

// --- scenarios -------------------------------------------------------------

test('no occlusion, container 1000x500, simple bounds', () => {
  const W = 1000, H = 500;
  const occl = { left: 0, right: 0, top: 0, bottom: 0 };
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  const margin = 0.1;

  const vb = computeOcclusionAwareViewBox(bounds, { width: W, height: H }, occl, margin);
  assert.ok(Array.isArray(vb) && vb.length === 4, 'returns [x,y,w,h]');

  const [Sx, Sy] = expectedFitSizes(bounds, margin, W, H, occl);
  const [visW, visH] = visibleSizeVB(vb, W, H, occl);
  assert.ok(approx(visW, Sx), `visible width ${visW} ≈ ${Sx}`);
  assert.ok(approx(visH, Sy), `visible height ${visH} ≈ ${Sy}`);

  const [cxExp, cyExp] = dataCenter(bounds);
  const [cx, cy] = visibleCenterVB(vb, W, H, occl);
  assert.ok(approx(cx, cxExp), `center x ${cx} ≈ ${cxExp}`);
  assert.ok(approx(cy, cyExp), `center y ${cy} ≈ ${cyExp}`);

  // aspect of visible area should equal visible window aspect (W/H here)
  assert.ok(approx(visW / visH, W / H), 'visible AR matches container AR');
});

test('left occlusion only (250px), same bounds as above', () => {
  const W = 1000, H = 500;
  const occl = { left: 250, right: 0, top: 0, bottom: 0 };
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  const margin = 0.1;

  const vb = computeOcclusionAwareViewBox(bounds, { width: W, height: H }, occl, margin);

  const [Sx, Sy] = expectedFitSizes(bounds, margin, W, H, occl);
  const [visW, visH] = visibleSizeVB(vb, W, H, occl);
  assert.ok(approx(visW, Sx), `visible width ${visW} ≈ ${Sx}`);
  assert.ok(approx(visH, Sy), `visible height ${visH} ≈ ${Sy}`);

  const [cxExp, cyExp] = dataCenter(bounds);
  const [cx, cy] = visibleCenterVB(vb, W, H, occl);
  assert.ok(approx(cx, cxExp), `center x ${cx} ≈ ${cxExp}`);
  assert.ok(approx(cy, cyExp), `center y ${cy} ≈ ${cyExp}`);

  const Wv = W - occl.left; // 750
  const Hv = H;             // 500
  assert.ok(approx(visW / visH, Wv / Hv), 'visible AR matches non-occluded window AR');
});

test('left+right occlusion (150px, 50px)', () => {
  const W = 1000, H = 500;
  const occl = { left: 150, right: 50, top: 0, bottom: 0 };
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  const margin = 0.1;

  const vb = computeOcclusionAwareViewBox(bounds, { width: W, height: H }, occl, margin);

  const [Sx, Sy] = expectedFitSizes(bounds, margin, W, H, occl);
  const [visW, visH] = visibleSizeVB(vb, W, H, occl);
  assert.ok(approx(visW, Sx), `visible width ${visW} ≈ ${Sx}`);
  assert.ok(approx(visH, Sy), `visible height ${visH} ≈ ${Sy}`);

  const [cxExp, cyExp] = dataCenter(bounds);
  const [cx, cy] = visibleCenterVB(vb, W, H, occl);
  assert.ok(approx(cx, cxExp), `center x ${cx} ≈ ${cxExp}`);
  assert.ok(approx(cy, cyExp), `center y ${cy} ≈ ${cyExp}`);

  const Wv = W - occl.left - occl.right;
  const Hv = H;
  assert.ok(approx(visW / visH, Wv / Hv), 'visible AR matches non-occluded window AR');
});

test('top+bottom occlusion with different container aspect', () => {
  const W = 800, H = 600;
  const occl = { left: 0, right: 0, top: 100, bottom: 50 }; // visible height 450
  const bounds = { minX: -200, minY: -50, maxX: 300, maxY: 250 }; // dx=500, dy=300
  const margin = 0.2; // 20%

  const vb = computeOcclusionAwareViewBox(bounds, { width: W, height: H }, occl, margin);

  const [Sx, Sy] = expectedFitSizes(bounds, margin, W, H, occl);
  const [visW, visH] = visibleSizeVB(vb, W, H, occl);
  assert.ok(approx(visW, Sx), `visible width ${visW} ≈ ${Sx}`);
  assert.ok(approx(visH, Sy), `visible height ${visH} ≈ ${Sy}`);

  const [cxExp, cyExp] = dataCenter(bounds);
  const [cx, cy] = visibleCenterVB(vb, W, H, occl);
  assert.ok(approx(cx, cxExp), `center x ${cx} ≈ ${cxExp}`);
  assert.ok(approx(cy, cyExp), `center y ${cy} ≈ ${cyExp}`);

  const Wv = W;                  // 800
  const Hv = H - 100 - 50;       // 450
  assert.ok(approx(visW / visH, Wv / Hv), 'visible AR matches non-occluded window AR');
});

test('degenerate skinny data is still fully visible (dx ~ 0)', () => {
  const W = 900, H = 600;
  const occl = { left: 200, right: 0, top: 0, bottom: 0 };
  const bounds = { minX: 10, minY: 0, maxX: 10 + 1e-12, maxY: 100 }; // almost line
  const margin = 0.1;

  const vb = computeOcclusionAwareViewBox(bounds, { width: W, height: H }, occl, margin);

  const [Sx, Sy] = expectedFitSizes(bounds, margin, W, H, occl);
  const [visW, visH] = visibleSizeVB(vb, W, H, occl);
  // Expect at least the required sizes (allow tiny numeric slack)
  assert.ok(visW + 1e-6 >= Sx, `visible width ${visW} >= ${Sx}`);
  assert.ok(visH + 1e-6 >= Sy, `visible height ${visH} >= ${Sy}`);

  const [cxExp, cyExp] = dataCenter(bounds);
  const [cx, cy] = visibleCenterVB(vb, W, H, occl);
  assert.ok(approx(cx, cxExp), `center x ${cx} ≈ ${cxExp}`);
  assert.ok(approx(cy, cyExp), `center y ${cy} ≈ ${cyExp}`);
});

// --- shouldAutoZoomToNewContent tests ----------------------------------------

test('shouldAutoZoomToNewContent: no extension, should not auto-zoom', () => {
  const newData = [
    { x: 10, y: 20 },
    { x: 30, y: 40 }
  ];
  const previousBounds = { minX: 0, maxX: 50, minY: 0, maxY: 50 };
  const viewBox = [0, 0, 100, 100];
  const transform = { k: 1, x: 0, y: 0 };
  
  const result = shouldAutoZoomToNewContent(newData, previousBounds, viewBox, transform);
  assert.strictEqual(result, false, 'should not auto-zoom when data stays within previous bounds');
});

test('shouldAutoZoomToNewContent: data extends beyond previous bounds but within visible area', () => {
  const newData = [
    { x: -10, y: 20 }, // extends left beyond previous bounds
    { x: 30, y: 40 }
  ];
  const previousBounds = { minX: 0, maxX: 50, minY: 0, maxY: 50 };
  const viewBox = [0, 0, 100, 100];
  const transform = { k: 1, x: 20, y: 20 }; // visible area is -20 to 80
  
  const result = shouldAutoZoomToNewContent(newData, previousBounds, viewBox, transform);
  assert.strictEqual(result, false, 'should not auto-zoom when new data is still within visible area');
});

test('shouldAutoZoomToNewContent: data extends beyond visible area', () => {
  const newData = [
    { x: -100, y: 20 }, // extends far left, outside visible area
    { x: 30, y: 40 }
  ];
  const previousBounds = { minX: 0, maxX: 50, minY: 0, maxY: 50 };
  const viewBox = [0, 0, 100, 100];
  const transform = { k: 2, x: 100, y: 100 }; // visible area is -50 to 50
  
  const result = shouldAutoZoomToNewContent(newData, previousBounds, viewBox, transform);
  assert.strictEqual(result, true, 'should auto-zoom when new data extends outside visible area');
});

test('shouldAutoZoomToNewContent: data extends in multiple directions', () => {
  const newData = [
    { x: -10, y: -5 },  // extends left and up
    { x: 60, y: 70 }    // extends right and down
  ];
  const previousBounds = { minX: 0, maxX: 50, minY: 0, maxY: 50 };
  const viewBox = [0, 0, 100, 100];
  const transform = { k: 1, x: 25, y: 25 }; // visible area is -25 to 75
  
  const result = shouldAutoZoomToNewContent(newData, previousBounds, viewBox, transform);
  assert.strictEqual(result, false, 'should not auto-zoom when extensions are still within visible bounds');
});

test('shouldAutoZoomToNewContent: handles edge cases', () => {
  // Empty data
  assert.strictEqual(
    shouldAutoZoomToNewContent([], { minX: 0, maxX: 1, minY: 0, maxY: 1 }, [0, 0, 1, 1], { k: 1, x: 0, y: 0 }),
    false,
    'should return false for empty data'
  );
  
  // Missing parameters
  assert.strictEqual(
    shouldAutoZoomToNewContent([{ x: 0, y: 0 }], null, [0, 0, 1, 1], { k: 1, x: 0, y: 0 }),
    false,
    'should return false when previousBounds is null'
  );
  
  assert.strictEqual(
    shouldAutoZoomToNewContent([{ x: 0, y: 0 }], { minX: 0, maxX: 1, minY: 0, maxY: 1 }, null, { k: 1, x: 0, y: 0 }),
    false,
    'should return false when viewBox is null'
  );
});

// --- zoom extent helpers tests ---------------------------------------------

test('computeAbsoluteExtent: basic functionality', () => {
  const result = computeAbsoluteExtent([0.5, 4], 2);
  assert.deepStrictEqual(result, [1, 8], 'should multiply relative extent by base scale');
});

test('computeAbsoluteExtent: handles reversed extents', () => {
  const result = computeAbsoluteExtent([4, 0.5], 2);
  assert.deepStrictEqual(result, [1, 8], 'should handle reversed extents correctly');
});

test('computeAbsoluteExtent: uses fallback for invalid extent', () => {
  const result = computeAbsoluteExtent(null, 2);
  assert.deepStrictEqual(result, [0.5, 20], 'should use fallback [0.25, 10] for invalid extent');
  
  const result2 = computeAbsoluteExtent([1], 2);
  assert.deepStrictEqual(result2, [0.5, 20], 'should use fallback for array with wrong length');
});

test('computeAbsoluteExtent: handles zero or negative base scale', () => {
  const result = computeAbsoluteExtent([0.5, 4], 0);
  assert.deepStrictEqual(result, [0.5, 4], 'should use 1 as fallback for zero base scale');
  
  const result2 = computeAbsoluteExtent([0.5, 4], -1);
  assert.deepStrictEqual(result2, [0.5, 4], 'should use 1 as fallback for negative base scale');
});

test('unionExtent: basic functionality', () => {
  const result = unionExtent([1, 3], [2, 5]);
  assert.deepStrictEqual(result, [1, 5], 'should return union of two extents');
});

test('unionExtent: handles non-overlapping extents', () => {
  const result = unionExtent([1, 2], [4, 5]);
  assert.deepStrictEqual(result, [1, 5], 'should return union of non-overlapping extents');
});

test('unionExtent: handles undefined inputs defensively', () => {
  const result = unionExtent(null, [2, 5]);
  assert.deepStrictEqual(result, [2, 5], 'should handle null first extent');
  
  const result2 = unionExtent([1, 3], undefined);
  assert.deepStrictEqual(result2, [1, 3], 'should handle undefined second extent');
  
  const result3 = unionExtent(null, null);
  assert.deepStrictEqual(result3, [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY], 'should handle both null extents');
});

test('setAbsoluteExtent: calls scaleExtent when valid', () => {
  let calledWith = null;
  const mockHandler = {
    scaleExtent: (extent) => {
      calledWith = extent;
    }
  };
  
  setAbsoluteExtent(mockHandler, [1, 10]);
  assert.deepStrictEqual(calledWith, [1, 10], 'should call scaleExtent with provided extent');
});

test('setAbsoluteExtent: handles invalid inputs gracefully', () => {
  let called = false;
  const mockHandler = {
    scaleExtent: () => {
      called = true;
    }
  };
  
  setAbsoluteExtent(null, [1, 10]);
  assert.strictEqual(called, false, 'should not call scaleExtent when handler is null');
  
  setAbsoluteExtent(mockHandler, null);
  assert.strictEqual(called, false, 'should not call scaleExtent when extent is null');
  
  setAbsoluteExtent(mockHandler, [1]);
  assert.strictEqual(called, false, 'should not call scaleExtent when extent has wrong length');
});

// --- zoom extent for data tests --------------------------------------------

test('computeZoomExtentForData: basic functionality', () => {
  const data = [
    { x: 0, y: 0 },
    { x: 100, y: 50 }
  ];
  const viewBox = [0, 0, 200, 100];
  const zoomExtent = [0.5, 4];
  const transform = { k: 1, x: 0, y: 0 };
  const fitMargin = 0.9;
  
  const result = computeZoomExtentForData(data, viewBox, zoomExtent, transform, fitMargin);
  
  assert.ok(result !== null, 'should return result object');
  assert.ok('baseScale' in result, 'should have baseScale property');
  assert.ok('absoluteExtent' in result, 'should have absoluteExtent property');
  assert.ok(result.baseScale > 0, 'baseScale should be positive');
  assert.ok(Array.isArray(result.absoluteExtent) && result.absoluteExtent.length === 2, 'absoluteExtent should be array of length 2');
});

test('computeZoomExtentForData: calculates correct baseScale for fitting data', () => {
  const data = [
    { x: 0, y: 0 },
    { x: 50, y: 25 }  // data is 50x25
  ];
  const viewBox = [0, 0, 100, 50];  // viewBox is 100x50
  const zoomExtent = [0.5, 4];
  const transform = { k: 1, x: 0, y: 0 };
  const fitMargin = 1.0;  // no margin for easier calculation
  
  const result = computeZoomExtentForData(data, viewBox, zoomExtent, transform, fitMargin);
  
  // Scale needed: min(100/50, 50/25) = min(2, 2) = 2
  assert.ok(approx(result.baseScale, 2), `expected baseScale ~2, got ${result.baseScale}`);
  
  // Absolute extent should be [0.5*2, 4*2] = [1, 8]
  assert.deepStrictEqual(result.absoluteExtent, [1, 8], 'absoluteExtent should be scaled correctly');
});

test('computeZoomExtentForData: handles edge cases', () => {
  // Empty data
  const result1 = computeZoomExtentForData([], [0, 0, 100, 100], [0.5, 4], { k: 1, x: 0, y: 0 });
  assert.strictEqual(result1, null, 'should return null for empty data');
  
  // Missing viewBox
  const data = [{ x: 0, y: 0 }];
  const result2 = computeZoomExtentForData(data, null, [0.5, 4], { k: 1, x: 0, y: 0 });
  assert.strictEqual(result2, null, 'should return null for missing viewBox');
  
  // Missing transform
  const result3 = computeZoomExtentForData(data, [0, 0, 100, 100], [0.5, 4], null);
  assert.strictEqual(result3, null, 'should return null for missing transform');
});

test('computeZoomExtentForData: handles degenerate data dimensions', () => {
  const data = [
    { x: 10, y: 0 },
    { x: 10, y: 100 }  // vertical line (dx ~ 0)
  ];
  const viewBox = [0, 0, 100, 100];
  const zoomExtent = [0.5, 4];
  const transform = { k: 1, x: 0, y: 0 };
  
  const result = computeZoomExtentForData(data, viewBox, zoomExtent, transform, 1.0);
  
  assert.ok(result !== null, 'should handle degenerate dimensions');
  assert.ok(result.baseScale > 0, 'should have positive baseScale even with degenerate data');
  assert.ok(result.absoluteExtent[0] > 0, 'should have positive minimum extent');
});

// --- shouldUpdateZoomExtent tests ------------------------------------------

test('shouldUpdateZoomExtent: should update when current extent is too restrictive', () => {
  const data = [
    { x: 0, y: 0 },
    { x: 200, y: 100 }  // large data that needs wide extent
  ];
  const currentExtent = [1, 2];  // restrictive extent
  const viewBox = [0, 0, 100, 50];
  const zoomExtent = [0.5, 4];
  const transform = { k: 1, x: 0, y: 0 };
  
  const result = shouldUpdateZoomExtent(data, currentExtent, viewBox, zoomExtent, transform, 1.0);
  assert.strictEqual(result, true, 'should update when current extent is too restrictive');
});

test('shouldUpdateZoomExtent: should not update when current extent is sufficient', () => {
  const data = [
    { x: 0, y: 0 },
    { x: 50, y: 25 }  // small data
  ];
  const currentExtent = [0.1, 10];  // generous extent
  const viewBox = [0, 0, 100, 50];
  const zoomExtent = [0.5, 4];
  const transform = { k: 1, x: 0, y: 0 };
  
  const result = shouldUpdateZoomExtent(data, currentExtent, viewBox, zoomExtent, transform, 1.0);
  assert.strictEqual(result, false, 'should not update when current extent is sufficient');
});

test('shouldUpdateZoomExtent: handles edge cases', () => {
  const data = [{ x: 0, y: 0 }];
  const currentExtent = [1, 4];
  const viewBox = [0, 0, 100, 100];
  const zoomExtent = [0.5, 4];
  const transform = { k: 1, x: 0, y: 0 };
  
  // Empty data
  const result1 = shouldUpdateZoomExtent([], currentExtent, viewBox, zoomExtent, transform);
  assert.strictEqual(result1, false, 'should return false for empty data');
  
  // Missing current extent
  const result2 = shouldUpdateZoomExtent(data, null, viewBox, zoomExtent, transform);
  assert.strictEqual(result2, false, 'should return false when currentExtent is missing');
  
  // Missing viewBox
  const result3 = shouldUpdateZoomExtent(data, currentExtent, null, zoomExtent, transform);
  assert.strictEqual(result3, false, 'should return false when viewBox is missing');
  
  // Missing transform
  const result4 = shouldUpdateZoomExtent(data, currentExtent, viewBox, zoomExtent, null);
  assert.strictEqual(result4, false, 'should return false when transform is missing');
});

test('shouldUpdateZoomExtent: boundary cases for extent comparison', () => {
  const data = [
    { x: 0, y: 0 },
    { x: 100, y: 50 }
  ];
  const viewBox = [0, 0, 100, 50];
  const zoomExtent = [0.5, 4];
  const transform = { k: 1, x: 0, y: 0 };
  
  // Calculate what the required extent would be
  const extentCalc = computeZoomExtentForData(data, viewBox, zoomExtent, transform, 1.0);
  const [requiredMin, requiredMax] = extentCalc.absoluteExtent;
  
  // Test with exact required extent (should not update)
  const result1 = shouldUpdateZoomExtent(data, [requiredMin, requiredMax], viewBox, zoomExtent, transform, 1.0);
  assert.strictEqual(result1, false, 'should not update when extent exactly matches requirement');
  
  // Test with slightly more restrictive extent (should update)
  const result2 = shouldUpdateZoomExtent(data, [requiredMin + 0.1, requiredMax - 0.1], viewBox, zoomExtent, transform, 1.0);
  assert.strictEqual(result2, true, 'should update when extent is slightly too restrictive');
  
  // Test with more generous extent (should not update)
  const result3 = shouldUpdateZoomExtent(data, [requiredMin - 0.1, requiredMax + 0.1], viewBox, zoomExtent, transform, 1.0);
  assert.strictEqual(result3, false, 'should not update when extent is more generous');
});

// This test demonstrates the real root cause: the zoomExtent useEffect overwrites 
// the carefully calculated extent for new data with an extent based on old baseScale
test('FAILING: baseScaleRef from old data causes extent to be too restrictive for new data', () => {
  // Simulate the component's behavior:
  // 1. Initial small data leads to initial baseScale and extent
  const initialData = [{ x: 10, y: 10 }, { x: 20, y: 20 }];
  const viewBox = [0, 0, 100, 100]; 
  const zoomExtent = [0.25, 10];
  
  // Initial fit would set baseScale to a value that fits the small initial data
  const initialFitCalc = computeZoomExtentForData(initialData, viewBox, zoomExtent, { k: 1, x: 0, y: 0 }, 0.9);
  const initialBaseScale = initialFitCalc.baseScale;  // This will be relatively high (small data = high scale to fit)
  
  // 2. User adds much larger data range
  const expandedData = [
    ...initialData,
    { x: -100, y: -100 },  // Much larger range
    { x: 200, y: 200 }
  ];
  
  // 3. Data processing useEffect correctly calculates extent for ALL data
  const correctExtentCalc = computeZoomExtentForData(expandedData, viewBox, zoomExtent, { k: 1, x: 0, y: 0 }, 0.9);
  const correctExtent = correctExtentCalc.absoluteExtent;
  
  // 4. But then zoomExtent useEffect runs and overwrites with extent based on old baseScale
  const overridingExtent = computeAbsoluteExtent(zoomExtent, initialBaseScale);
  
  // The problem: the overriding extent is more restrictive than what's needed for the new data
  // because it's based on the old, smaller data's baseScale
  console.log('Initial baseScale (small data):', initialBaseScale);
  console.log('Correct extent for expanded data:', correctExtent);
  console.log('Overriding extent from old baseScale:', overridingExtent);
  
  const isMoreRestrictive = overridingExtent[0] > correctExtent[0];
  console.log('Is overriding extent more restrictive?', isMoreRestrictive);
  
  if (!isMoreRestrictive) {
    // If this assertion fails, our hypothesis was wrong - let's understand why
    assert.fail(`Expected overriding extent min ${overridingExtent[0]} to be more restrictive than correct extent min ${correctExtent[0]}, but it wasn't. This suggests the root cause is different.`);
  }
  
  // This demonstrates that users can't zoom out far enough to see the new data
  // The test succeeds in demonstrating the root cause
  assert(true, 'Root cause confirmed: baseScaleRef causes extent override issue');
});


