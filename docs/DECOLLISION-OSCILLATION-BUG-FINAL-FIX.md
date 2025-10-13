# Decollision Oscillation Bug - Definitive Fix

**Status**: ✅ RESOLVED
**Date**: October 13, 2025
**Severity**: Critical - Made decollision animation unusable when active track present

---

## The Bug

When an active track was loaded into the audio player and a user selected a playlist (triggering decollision), the dots would enter a rapid oscillation loop, flickering between two positions instead of smoothly spreading out. The oscillation continued indefinitely until the active track was cleared (ESC or background click).

### Visual Symptoms
- Dots rapidly flickering/oscillating during decollision
- Animation never completing, stuck in endless loop
- Only occurred when active track present (pulse animation active)

---

## Root Cause

The D3 force simulation driving decollision was being **repeatedly restarted** due to React useEffect dependency issues. Every time the simulation restarted, its internal tick counter reset to 1, causing dots to jump back to their starting positions and begin the animation again.

### The Smoking Gun

Console logs revealed the pattern:
```
⚫ D3 decollision tick 1 updating positions - first item: 64.43 76.53
⚫ D3 decollision tick 2 updating positions - first item: 64.48 76.70
⚫ D3 decollision tick 1 updating positions - first item: 64.43 76.53  ← RESET!
⚫ D3 decollision tick 2 updating positions - first item: 64.48 76.70
⚫ D3 decollision tick 1 updating positions - first item: 64.43 76.53  ← RESET!
```

The tick counter repeatedly resetting to 1 proved the simulation was being stopped and restarted, causing dots to oscillate between their first two positions.

---

## Technical Details

### The Problematic useEffect

In `src/DotVisualization.jsx`, the decollision simulation was managed by a useEffect:

```javascript
useEffect(() => {
  if (!enableDecollisioning || !processedData.length) return;

  const simulation = decollisioning(dataSnapshot, onUpdateNodes, fnDotSize, onDecollisionComplete);

  return () => {
    simulation.stop(); // Cleanup: stop simulation when effect re-runs
  };
}, [enableDecollisioning, defaultSize, useCanvas, onUpdateNodes, onDecollisionComplete]);
```

**The Problem**: `onUpdateNodes` and `onDecollisionComplete` were callback functions that changed on every render (or when their dependencies changed), causing the useEffect to re-run, which:
1. Called the cleanup function `simulation.stop()`
2. Started a new simulation from scratch
3. Reset the tick counter back to 1

### Why Callbacks Changed Frequently

Both callbacks were created with `useCallback`:

```javascript
const onUpdateNodes = useCallback((nodes) => {
  // Update canvas with new positions
  coloredDotsRef.current.renderCanvasWithData(nodes, transform);
}, [useCanvas]);

const handleDecollisionComplete = useCallback((finalData, needsAnotherCycle) => {
  setAnimationState('idle');
  // ... other state updates
}, [autoResumeImmediate]);
```

Even though they had dependencies, React's `useCallback` creates new function references when:
- Dependencies change
- Parent component re-renders (even if deps are stable)

This meant the decollision useEffect would re-run frequently, especially when:
- Active track pulse animation triggered re-renders (30 FPS)
- User interactions (hover, click) caused re-renders
- State updates from other features

---

## Bug History & Previous Fix Attempts

### September 24, 2025 - Bug Introduced
**Commit**: `94f5806` - "React to resizing"

`onUpdateNodes` was extracted from being defined inline in the useEffect and wrapped in `useCallback`, then **added to the dependency array** along with `data`, `dotStyles`, and `onDecollisionComplete`:

```javascript
// Before: callback defined inside useEffect (stable)
useEffect(() => {
  const onUpdateNodes = (nodes) => { /* ... */ };
  const simulation = decollisioning(data, onUpdateNodes, ...);
}, [enableDecollisioning, defaultSize, useCanvas]);

// After: callback extracted and added to deps (unstable)
const onUpdateNodes = useCallback((nodes) => { /* ... */ }, [useCanvas]);
useEffect(() => {
  const simulation = decollisioning(data, onUpdateNodes, ...);
}, [enableDecollisioning, defaultSize, useCanvas, onUpdateNodes, data, dotStyles, onDecollisionComplete]);
```

**Why it was done**: Following React hooks best practices (exhaustive dependencies lint rule)
**Unintended consequence**: Made the simulation restart on every callback change

### October 11, 2025 - Partial Fix
**Commit**: `4909491` - "Prevent decollision simulation from restarting when dotStyles change"

Recognized that `dotStyles` in the dependency array was causing simulation restarts. Implemented the `useLatest` hook pattern to store `dotStyles` in a ref, allowing the simulation to access the latest styles without being restarted:

```javascript
const dotStylesRef = useLatest(dotStyles);

useEffect(() => {
  const fnDotSize = (item) => getDotSize(item, dotStylesRef.current, defaultSize);
  const simulation = decollisioning(data, onUpdateNodes, fnDotSize, onDecollisionComplete);
}, [enableDecollisioning, defaultSize, useCanvas, onUpdateNodes, onDecollisionComplete]); // dotStyles removed!
```

**What it fixed**: Hovering over dots during decollision no longer caused restarts
**What it missed**: `onUpdateNodes` and `onDecollisionComplete` still in deps, still causing restarts

### October 13, 2025 - Final Fix
**This commit** - Complete ref-based solution for all callbacks

Applied the same ref pattern to the remaining callbacks:

```javascript
// Store callbacks in refs to avoid breaking decollision useEffect deps
const onUpdateNodesRef = useRef(onUpdateNodes);
useEffect(() => {
  onUpdateNodesRef.current = onUpdateNodes;
}, [onUpdateNodes]);

const onDecollisionCompleteRef = useRef(onDecollisionComplete);
useEffect(() => {
  onDecollisionCompleteRef.current = onDecollisionComplete;
}, [onDecollisionComplete]);

// Decollision useEffect now has ONLY stable deps
useEffect(() => {
  const simulation = decollisioning(
    dataSnapshot,
    (nodes) => onUpdateNodesRef.current(nodes),  // Access via ref
    fnDotSize,
    (finalData) => onDecollisionCompleteRef.current?.(finalData, needsAnotherCycle)  // Access via ref
  );

  return () => simulation.stop();
}, [enableDecollisioning, defaultSize, useCanvas]); // Callbacks removed from deps!
```

**Why this works**:
- The useEffect only re-runs when `enableDecollisioning`, `defaultSize`, or `useCanvas` change
- These are all stable values that only change intentionally (starting/stopping decollision, resize events)
- The callbacks are accessed via refs, so they can update without restarting the simulation
- The simulation runs uninterrupted until `enableDecollisioning` becomes false

---

## The Complete Solution

### Pattern: Stable Dependencies with Current Values

This pattern solves a common React hooks dilemma:
- **Need**: Access current values of props/state inside a long-running effect
- **Problem**: Adding those values to dependencies causes the effect to restart
- **Solution**: Store values in refs, keep refs synchronized via separate effects

```javascript
// Step 1: Store callback in ref
const callbackRef = useRef(callback);

// Step 2: Keep ref synchronized (runs on every render)
useEffect(() => {
  callbackRef.current = callback;
}, [callback]);

// Step 3: Long-running effect uses ref, not direct callback
useEffect(() => {
  const cleanup = startLongRunningProcess(() => {
    callbackRef.current(); // Always calls the latest version
  });
  return cleanup;
}, [/* stable deps only */]);
```

### Final Dependencies

After the fix, the decollision useEffect has only stable dependencies:

- ✅ `enableDecollisioning` - Only changes when starting/stopping decollision
- ✅ `defaultSize` - Only changes on resize events
- ✅ `useCanvas` - Static configuration, never changes

All other values needed by the simulation are accessed via refs:
- `dotStylesRef.current` - Latest dot styles
- `onUpdateNodesRef.current` - Latest position update callback
- `onDecollisionCompleteRef.current` - Latest completion callback

---

## Verification

### Before Fix
```
21:17:59.076 ⚫ D3 decollision tick 2 - first item: 64.48 76.70
21:17:59.126 ⚫ D3 decollision tick 1 - first item: 64.43 76.53  ← RESET
21:17:59.186 ⚫ D3 decollision tick 2 - first item: 64.48 76.70
21:17:59.235 ⚫ D3 decollision tick 1 - first item: 64.43 76.53  ← RESET
```
**Result**: Oscillation continues indefinitely, animation never completes

### After Fix
```
21:21:55.287 ⚫ D3 decollision tick 1
21:21:55.314 ⚫ D3 decollision tick 2
21:21:55.331 ⚫ D3 decollision tick 3
21:21:55.351 ⚫ D3 decollision tick 4
21:21:55.373 ⚫ D3 decollision tick 5
...
21:21:58.651 ⚫ D3 decollision tick 43
21:21:58.669 ⚫ D3 decollision complete
```
**Result**: Smooth progression, animation completes successfully

---

## Lessons Learned

### 1. React's Exhaustive Dependencies Rule Isn't Always Right
The ESLint rule `react-hooks/exhaustive-deps` is generally helpful, but for long-running effects like animations, following it blindly can cause problems. Sometimes refs are the correct solution.

### 2. Callbacks in Dependencies Are Expensive
Every time a callback in a dependency array changes, the effect re-runs. For expensive operations like D3 simulations, this can create severe performance issues and visual bugs.

### 3. The Ref Pattern Is Your Friend
When you need:
- Long-running effects (animations, subscriptions, intervals)
- That need access to current values
- Without restarting when those values change

Use the ref pattern shown above.

### 4. Console Logging Saved the Day
The comprehensive logging we added (`⚫ D3 decollision tick N`) immediately revealed the root cause. When debugging animation issues, log the **frame counter** or **iteration number** to see if your animation is restarting.

### 5. Partial Fixes Can Hide the Full Problem
The October 11 fix for `dotStyles` worked for that specific case (hovering), but didn't address the underlying pattern. The bug recurred because `onUpdateNodes` and `onDecollisionComplete` had the same problem.

---

## Related Files

- `src/DotVisualization.jsx` - Main fix location
- `src/decollisioning.js` - D3 force simulation
- `src/useDotStyles.ts` - Pulse animation that was triggering re-renders
- `docs/decollision-flickering-remaining-issue.md` - Previous investigation notes

---

## Testing

To verify the fix works:

1. Load a track into the audio player (activates pulse animation)
2. Select a playlist to trigger decollision
3. Watch the console logs for tick counter progression
4. ✅ Should see: `tick 1, 2, 3, 4... 43, complete`
5. ❌ Should NOT see: `tick 1, 2, 1, 2, 1, 2...` (oscillation)

---

## Future Prevention

To prevent similar issues:

1. **Be cautious with callbacks in long-running effect dependencies**
   - Consider if the effect really needs to restart when the callback changes
   - Use refs when you need current values without restarts

2. **Add frame/iteration counters to animations**
   - Makes it immediately obvious when animations are restarting
   - Example: `console.log('⚫ Animation frame', frameCount)`

3. **Document "expensive" effects**
   - Mark effects that start animations, subscriptions, or other expensive operations
   - Note which dependencies are intentional vs. which should use refs

4. **Test with active animations**
   - Bugs like this only manifest when multiple animations run concurrently
   - Test features while pulse animations, transitions, or other effects are active

---

## Commit Message

```
fix: Prevent D3 decollision simulation restarts via ref-based callbacks

The decollision oscillation bug was caused by callback dependencies in the
useEffect triggering simulation restarts. Every restart reset the D3 tick
counter, causing dots to repeatedly jump between their first two positions.

Root cause:
- onUpdateNodes and onDecollisionComplete in useEffect deps
- These callbacks changed frequently due to re-renders
- Each change restarted the simulation via cleanup function

Solution:
- Store callbacks in refs (onUpdateNodesRef, onDecollisionCompleteRef)
- Access via .current in the simulation
- Remove from dependency array
- Effect now only re-runs for intentional state changes

This completes the fix started in commit 4909491 which addressed dotStyles.

Fixes: Oscillation when active track + playlist selection
Related: 91ae23d, e5d51a8, 4d02876 (previous flicker fixes)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```
