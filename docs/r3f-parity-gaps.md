# R3F Parity Gaps

## Premise

The R3F renderer (`DotVisualizationR3F`) needs to support the surface that **fingertip** uses, with **maximum code sharing** between Canvas and R3F paths. Parallel implementations of pulse logic, decollision scheduling, fit math, interaction state, etc. are out — we'd never keep them in sync. Diverge only where WebGL semantics genuinely require it (e.g. SDF shaders vs. 2D paint).

## Fingertip's surface

Audited from [`SamplesMap.tsx`](../../vibseek/fingertip/src/components/SamplesMap.tsx) and [`useFocusDotRenderer.ts`](../../vibseek/fingertip/src/hooks/useFocusDotRenderer.ts).

**Props passed:**
`data`, `defaultSize`, `defaultOpacity`, `dotStyles` (with `r`, `fill`, `opacity`, `pulse{duration,sizeRange,opacityRange,pulseColor,ringEffect,pulseInward,ringTargetPixels,ringMinRatio}`), `radiusOverrides`, `sharedPositionCache`, `scopeKey`, `constraintKey`, `customDotRenderer`, `dotStrokeWidthFraction`, `useCanvas`, `gpuPanZoom`, `renderMargin`, `blockHoverDuringInteraction`, `pausePulseDuringInteraction`, `isIncrementalUpdate`, `positionsAreIntermediate`, `initialTransform`, `occludeTop`, `occludeBottom`, `onHover`, `onLeave`, `onClick`, `onBackgroundClick`, `onDecollisionComplete`.

**Imperative ref:**
`zoomToVisible(duration, easing, dataOverride, marginOverride, updateExtents, maxScale)`, `getFitTransform(dataOverride, marginOverride)`, `getZoomTransform()`.

**Named exports consumed:**
`useDecollisionCache` (renderer-agnostic hook), `calculateAdaptiveRingRadius` (pure utility).

## Already shareable (use as-is in R3F)

These modules are renderer-agnostic. R3F should consume them directly instead of reimplementing:

| Module | Used by Canvas | R3F status |
|---|---|---|
| [`useDecollisionScheduler.js`](../src/useDecollisionScheduler.js) | Yes (full base + constraint state machine) | **Not used** — runs bare `decollisioning()` instead |
| [`decollisionScheduler.js`](../src/decollisionScheduler.js) (state machine) | Yes | **Not used** |
| [`useDecollisionCache.js`](../src/useDecollisionCache.js) | Yes | Canvas/WebGL transition target cache; WebGPU uses GPU snapshots instead |
| [`usePulseAnimation.js`](../src/usePulseAnimation.js) | Yes | **Not used** — R3F has its own ad-hoc pulse loop in [R3FDots.jsx:208-279](../src/r3f/R3FDots.jsx#L208-L279) |
| [`useFrameBudget.js`](../src/useFrameBudget.js) | Yes (via `usePulseAnimation`) | **Not used** |
| [`pulseRingUtils.js`](../src/pulseRingUtils.js) (`calculateAdaptiveRingRadius`) | Yes | **Not used** — R3F has a different sizing formula |
| [`dotUtils.js`](../src/dotUtils.js) (`getDotSize`) | Yes | Used — OK |
| [`utils.js`](../src/utils.js) (`boundsForData`) | Yes | Used — OK |
| [`spatialIndex.js`](../src/spatialIndex.js) | Yes (hover hit-test) | Not used (R3F does its own raycast; reasonable divergence) |

**The big code-sharing wins are #1 (scheduler) and #4–6 (pulse pipeline).** Both are entire subsystems R3F duplicates today.

## Gaps mapped to fingertip props

Severity is fingertip-impact. Reuse column says which shared module fixes it.

### Visual / per-dot state

| # | Prop / feature | Severity | Reuse | Notes |
|---|---|---|---|---|
| 1 | `defaultOpacity`, `dotStyles.opacity`, `pulse.opacityRange` | High | shader only | Shader writes `vec4(color, alpha)` only for AA edge; per-instance opacity ignored. Fix: instance alpha attribute. Tech-mandatory divergence (shader vs 2D paint). |
| 2 | `radiusOverrides` not applied to rendered size | High | none | Pure logic bug — [R3FDots.jsx:96](../src/r3f/R3FDots.jsx#L96) doesn't look in the override map. One-line fix. |
| 3 | `dotStyles.pulse.{ringEffect,ringTargetPixels,ringMinRatio,pulseInward,opacityRange,pulseColor,duration,sizeRange}` | High | **`usePulseAnimation` + `pulseRingUtils`** | R3F should drive its instance updates from the same hook Canvas uses; only the *application* of pulse-derived size/opacity/color to the InstancedMesh diverges. Adaptive ring sizing is a one-line call to `calculateAdaptiveRingRadius`. |
| 4 | `customDotRenderer` (focused-dot inner+ring) | High | none | Strict tech reason for divergence — R3F can't expose a `CanvasRenderingContext2D`. Options: (a) draw the focus visual via SDF shader (gap + outer ring is straightforward); (b) DOM-overlay diamond on the focused dot. Recommend (a) — fewer moving parts, no per-frame DOM update. |

### Lifecycle / decollision

| # | Prop / feature | Severity | Reuse |
|---|---|---|---|
| 5 | `scopeKey` honored | Medium | scheduler |
| 6 | `constraintKey` triggers re-decollision with bumped radii | High | **scheduler** (R3F currently does a one-shot; doesn't model base + constraint phases) |
| 7 | `isIncrementalUpdate` + `positionsAreIntermediate` semantics match Canvas | Medium | **scheduler** (Canvas already gets this for free via the scheduler) |
| 8 | `onDecollisionComplete` fires on both initial settle AND constraint settle AND animate-from-cache path | High | **scheduler** |
| 9 | CPU `sharedPositionCache` round-trips on Canvas/WebGL; WebGPU restores from GPU snapshots | Medium | scheduler + WebGPU executor |

### Camera / fit

| # | Prop / feature | Severity | Reuse |
|---|---|---|---|
| 10 | `initialTransform` honored on first paint | Medium | shared math via [`ZoomManager.js`](../src/ZoomManager.js) and/or `cameraUtils.js` if we extract |
| 11 | `occludeTop` / `occludeBottom` (panel-aware fit) | High | extract a shared `computeFitTransform({bounds, container, occlusion, margin})` and call from both renderers |
| 12 | `zoomToVisible(duration, easing, dataOverride, marginOverride, updateExtents, maxScale)` does the work | High | same — fit math is renderer-agnostic; only the camera-apply step differs (D3 zoom vs. Three camera position) |
| 13 | `getFitTransform` / `getZoomTransform` return consistent D3-equivalent transforms | Medium | same |

### Interaction

| # | Prop / feature | Severity | Reuse |
|---|---|---|---|
| 14 | `blockHoverDuringInteraction` | Medium | extract interaction-state ref to a shared hook; both renderers gate hover dispatch on it |
| 15 | `pausePulseDuringInteraction` | Medium | same hook + freeze `usePulseAnimation`'s timeRef (already supported via the `enabled` arg) |

### Canvas-only / N/A in R3F

These have *strict technological reasons* and shouldn't be ported:

- `useCanvas` — renderer-selection prop; meaningless in R3F.
- `gpuPanZoom` — Canvas-specific optimization (bitmap CSS transform during gestures); WebGL is GPU-native, so R3F gets the equivalent for free.
- `renderMargin` — exists only to support `gpuPanZoom`; N/A.

## Suggested order (fingertip-driven)

Numbered to read top-down — each step builds on the previous:

1. **Extract the scheduler integration into R3F** (gaps #5–9). Biggest single code-sharing win; removes ~80 lines of bespoke decollision logic in `DotVisualizationR3F.jsx`. Replace the bare `decollisioning()` call with `useDecollisionScheduler` exactly the way Canvas does.
2. **Per-dot opacity in the shader** (gap #1). Adds instance alpha attribute; unblocks gap #3's `opacityRange`.
3. **`radiusOverrides` applied to render** (gap #2). One-line bug.
4. **Adopt `usePulseAnimation` in R3F** (gap #3). Delete the ad-hoc loop in `R3FDots.jsx`; have R3F's `useFrame` ingest the hook's per-id state and write instance matrices/colors.
5. **Extract a shared `computeFitTransform`** + wire `occludeTop/Bottom` and `zoomToVisible` (gaps #10–13). Move the math out of `DotVisualization.jsx` and `DotVisualizationR3F.jsx` into a shared util both call.
6. **Shared interaction-state hook** for `block/pausePulseDuringInteraction` (gaps #14–15).
7. **Focused-dot visual via shader** (gap #4). Last because it requires the per-dot opacity work from step 2 and the pulse integration from step 4 to compose correctly.

After step 6, fingertip can choose R3F as a drop-in and the only behavior loss is the `customDotRenderer` callback — which step 7 replaces with a built-in equivalent.

## Out of scope (not used by fingertip)

Deferred or skipped until a real consumer needs them: per-dot stroke color, `strokeDasharray`, image patterns, `ClusterLabels`, edges, `onDragStart`/`onDoubleClick`/`onContextMenu`, `autoZoomToNewContent`, viewBox smoothing, custom `defaultColor` fallback chain. Re-evaluate if fingertip's surface grows.
