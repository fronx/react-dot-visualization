# SVG ViewBox Transform Compensation - Math Problem

## Goal

We need to calculate a D3 zoom transform that, when applied to content in a **new viewBox**, makes it appear visually identical to how it looked in an **old viewBox**.

## Context

We're animating viewBox transitions in an SVG visualization:

1. Start with `oldViewBox` displaying content
2. Switch SVG to `newViewBox`
3. Apply a transform to the content group that makes it LOOK like `oldViewBox` is still active
4. Animate the transform smoothly back to identity
5. End result: content visually transitions smoothly while viewBox changes underneath

## The Question

**Given `oldViewBox = [x1, y1, width1, height1]` and `newViewBox = [x2, y2, width2, height2]`, what D3 transform should we apply to a `<g>` element to make content appear in the same visual position as it did with the old viewBox?**

## Concrete Example

**Test Case: Zoom In (Centered)**

```
oldViewBox: [0, 0, 100, 100]     // Shows area from (0,0) to (100,100)
newViewBox: [25, 25, 50, 50]     // Shows area from (25,25) to (75,75) - zoomed in 2x

Dots in data coordinates:
- Dot A: (50, 50)  - center
- Dot B: (25, 25)  - top-left of new viewBox
- Dot C: (75, 75)  - bottom-right of new viewBox

SVG viewport: 200x200 pixels (for all examples)
```

**Visual appearance with oldViewBox:**
- Dot A (50,50): appears at center of 200x200 viewport = pixel (100, 100)
- Dot B (25,25): appears at 25% across = pixel (50, 50)
- Dot C (75,75): appears at 75% across = pixel (150, 150)

**Visual appearance with newViewBox (no transform):**
- Dot A (50,50): (50-25)/50 = 50% across = pixel (100, 100) - SAME position!
- Dot B (25,25): (25-25)/50 = 0% across = pixel (0, 0) - DIFFERENT!
- Dot C (75,75): (75-25)/50 = 100% across = pixel (200, 200) - DIFFERENT!

**What we need:** A transform T such that when applied to the `<g>` element containing the dots in newViewBox, all dots appear at their oldViewBox pixel positions.

## D3 Transform Format

D3 transforms are of the form:
```javascript
d3.zoomIdentity
  .translate(tx, ty)
  .scale(k)
```

This is equivalent to SVG transform: `translate(tx, ty) scale(k)`

In SVG, transforms compose right-to-left, so this means:
1. First scale by k
2. Then translate by (tx, ty)

## What We've Tried (All Failed)

### Attempt 1:
```javascript
const scale = oldViewBox[2] / newViewBox[2];
const dx = (oldCenterX - newCenterX) * scale;
const dy = (oldCenterY - newCenterY) * scale;
return d3.zoomIdentity.translate(dx, dy).scale(scale);
```
Result: Wrong - dots appear in completely wrong positions

### Attempt 2 (Inverted):
```javascript
const scale = newViewBox[2] / oldViewBox[2];
const dx = (newCenterX - oldCenterX);
const dy = (newCenterY - oldCenterY);
return d3.zoomIdentity.translate(-dx, -dy).scale(scale);
```
Result: Pan works correctly, but zoom completely fails (dots disappear or wrong size)

### Attempt 3 (Current):
```javascript
const scale = oldViewBox[2] / newViewBox[2];
const centerShiftX = newCenterX - oldCenterX;
const centerShiftY = newCenterY - oldCenterY;
const tx = -centerShiftX * scale;
const ty = -centerShiftY * scale;
return d3.zoomIdentity.translate(tx, ty).scale(scale);
```
Result: Still wrong for zoom operations

## Test Setup

We have an HTML test file that shows 3 side-by-side SVGs:
1. **Box 1**: oldViewBox with dots (reference - how it should look)
2. **Box 2**: newViewBox with dots (no transform - shows the problem)
3. **Box 3**: newViewBox with dots + compensating transform (should match Box 1)

**Success criteria:** Box 1 and Box 3 must look visually identical.

## Current Test Results

- ✅ **Pure pan** (viewBox shifts, same size): Works correctly
- ❌ **Zoom in** (viewBox shrinks): Dots disappear or wrong size
- ❌ **Zoom out** (viewBox grows): Dots appear wrong
- ❌ **Zoom + pan**: Completely wrong

## Question for GPT-5

**What is the correct formula for calculating `(tx, ty, k)` such that content in newViewBox + transform appears identical to content in oldViewBox?**

Please provide:
1. The mathematical formula
2. Step-by-step derivation/explanation
3. Verification using the concrete example above (oldViewBox=[0,0,100,100], newViewBox=[25,25,50,50], dot at (50,50))

## Additional Context

- We're using D3 v7
- The transform is applied to a `<g>` element containing the content
- The SVG viewport size stays constant (e.g., 200x200 pixels)
- We only need to handle 2D transforms (no rotation or skew)
