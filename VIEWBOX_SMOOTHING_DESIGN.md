# ViewBox Smoothing Design Document

## Problem Statement

When incrementally updating data (adding new dots), the viewBox needs to adjust to accommodate new content. Currently, we animate the viewBox coordinates directly using Kalman filtering + D3 interpolation. However, this causes **jiggling** - dots appear to bounce left/right during zoom transitions.

### Root Cause of Jiggling

When we interpolate viewBox `[x, y, width, height]` independently, the implicit center point `(x + width/2, y + height/2)` doesn't move smoothly. Even with center-based interpolation, we're still directly animating the viewBox, which changes what the "camera sees" rather than where the content is positioned.

## Proposed Solution

Instead of animating the viewBox directly, use **D3 zoom transforms** (which ZoomManager already handles smoothly):

1. Keep viewBox fixed during animation
2. Calculate a compensating zoom transform that makes the old viewBox appear as the new viewBox
3. Animate the transform using ZoomManager (jiggle-free)
4. When animation completes, update viewBox and reset transform to identity

### Why This Works

**ZoomManager** animates transforms `(x, y, k)` which naturally maintain a stable focal point. D3's zoom transform interpolation is specifically designed to avoid the jiggling we're experiencing.

## Key Constraints from Commit 85d1270d

This commit fixed a critical timing bug where viewBox was calculated before `useDotScaling` added `.size` properties, causing giant dots on initial render.

### Must Preserve:

1. **Size change detection** ([DotVisualization.jsx:251-258](DotVisualization.jsx#L251-L258))
   - Detect when dot sizes are added/updated
   - Recalculate viewBox when sizes change

2. **Instant initial zoom** ([ZoomManager.js:199](ZoomManager.js#L199))
   - First data arrival uses `duration: 0` (no animation)
   - Prevents timing issues with size calculation

3. **ViewBox recalculation triggers**
   - When dot sizes change (after useDotScaling runs)
   - When container dimensions change
   - When data bounds significantly change

## Implementation Plan

### 1. Calculate ViewBox-to-Transform Conversion

Given old viewBox `vb1` and new viewBox `vb2`, calculate the transform that makes content stay visually stable:

```javascript
// ViewBox change breakdown:
// - Center shift: (vb2.centerX - vb1.centerX, vb2.centerY - vb1.centerY)
// - Scale change: vb2.width / vb1.width (or height)

function calculateCompensatingTransform(oldViewBox, newViewBox) {
  const oldCenterX = oldViewBox[0] + oldViewBox[2] / 2;
  const oldCenterY = oldViewBox[1] + oldViewBox[3] / 2;
  const newCenterX = newViewBox[0] + newViewBox[2] / 2;
  const newCenterY = newViewBox[1] + newViewBox[3] / 2;

  // Scale ratio (how much viewBox is zooming out/in)
  const scaleRatio = oldViewBox[2] / newViewBox[2];

  // Translation to compensate for center shift
  const dx = (newCenterX - oldCenterX) * scaleRatio;
  const dy = (newCenterY - oldCenterY) * scaleRatio;

  return d3.zoomIdentity
    .translate(dx, dy)
    .scale(scaleRatio);
}
```

### 2. Animation Flow

**Initial Render (no animation):**
```
1. Calculate viewBox from data bounds
2. Set viewBox immediately
3. ZoomManager.initZoom() (instant, duration=0)
```

**Incremental Update (animated):**
```
1. Kalman filter smooths new viewBox target
2. Calculate compensating transform (oldVB → newVB)
3. Animate transform using ZoomManager.animateToTransform()
4. On animation complete:
   - Update viewBox to new target
   - Reset transform to identity
```

### 3. Modified Hook Signature

```javascript
export function useViewBoxTransition(
  setViewBox,
  currentViewBox,
  R,                      // Kalman filter params
  Q,
  transitionDuration,
  transitionEasing,
  zoomManager            // NEW: ZoomManager instance for transform animations
)
```

### 4. Key Functions to Modify

**useViewBoxTransition.js:**
- Add `calculateCompensatingTransform(oldVB, newVB)`
- Modify `requestViewBoxUpdate()` to use transform animation instead of direct viewBox interpolation
- Remove `startViewBoxTransition()` (replaced by ZoomManager.animateToTransform)

**DotVisualization.jsx:**
- Pass `zoomManager.current` to `useViewBoxTransition` hook
- Keep all size-change detection logic
- Distinguish initial vs incremental updates (initial = instant, incremental = animated)

## Testing Considerations

### Before/After Comparison:

**Current (broken):**
- Single dot in center
- Zoom in via incremental updates
- Dot jiggles left/right during transition

**Expected (fixed):**
- Single dot in center
- Zoom in via incremental updates
- Dot stays perfectly centered, smooth zoom in/out

### Edge Cases to Test:

1. **Initial render with sizes** - Must not show giant dots
2. **Size changes mid-animation** - Animation should complete or restart cleanly
3. **Rapid incremental updates** - Should debounce/queue appropriately
4. **Container resize during animation** - Should handle gracefully

## Design Decisions

### 1. Animation Interruption (Secondary Priority)

**Decision:** Smooth handover when new animations arrive, but this can be a secondary enhancement.

**Implementation:** D3 transitions already handle interruption gracefully. ZoomManager's `animateToTransform` resolves the promise on interrupt ([ZoomManager.js:324-328](ZoomManager.js#L324-L328)), so smooth takeover is automatic. No additional work needed for V1.

### 2. Identity Transform Reset - Avoiding Flicker

**Decision:** Atomic synchronous update to prevent flicker.

**Implementation:**
```javascript
// CRITICAL: These must happen synchronously (no React render in between)
setViewBox(newViewBox);                              // Update React state
zoomManager.applyTransformDirect(d3.zoomIdentity);   // Reset transform (synchronous)
```

The key is that both operations complete before React re-renders the next frame. Since `applyTransformDirect` is synchronous (directly manipulates DOM/canvas), there's no intermediate frame where the viewBox and transform are mismatched.

**Why this works:**
- React batches state updates - `setViewBox` doesn't cause immediate re-render
- `applyTransformDirect` updates DOM/canvas synchronously
- On next render, viewBox has new value and transform is identity
- No frame exists where they're out of sync

### 3. Kalman Filter State

**Decision:** Initial viewBox seeds the Kalman filter, then incremental updates flow through it.

**Flow:**
```
Initial render:
  Calculate viewBox → Set directly → Seeds Kalman filter (first data point)

Incremental update 1:
  Calculate viewBox → Kalman filter → Smoothed target → Transform animation

Incremental update 2:
  Calculate viewBox → Kalman filter (accumulated history) → Smoothed target → Transform animation
```

The Kalman filter builds up history across incremental updates, providing progressively better smoothing. It should **not** be reset between incremental updates - continuity is important for accurate prediction.

## Success Criteria

- [ ] No jiggling during incremental zoom updates
- [ ] Initial render shows correctly sized dots (no giant dots bug)
- [ ] Size changes trigger appropriate viewBox recalculation
- [ ] Smooth, natural-looking zoom animations
- [ ] No performance regression
- [ ] No visual flicker during transform reset
