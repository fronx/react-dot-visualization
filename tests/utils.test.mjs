import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOcclusionAwareViewBox } from '../src/utils.js';

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