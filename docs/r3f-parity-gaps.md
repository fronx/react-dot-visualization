# R3F Parity Gaps

> **Status (2026-07-01):** this audit is now largely historical — the code-sharing
> plan below was executed. The R3F renderer drives decollision through the shared
> `useDecollisionScheduler`, pulses through `usePulseAnimation` +
> `calculateAdaptiveRingRadius`, applies `radiusOverrides`, honors
> occlusion/`initialTransform`/`zoomToVisible`, and replaced `customDotRenderer`
> with a built-in shader focus visual (`dotStyles.focusRing`). Resolved items are
> marked inline. Still open: gap #15 (`pausePulseDuringInteraction` — R3F doesn't
> accept the prop) and the `customDotRenderer` callback itself (intentionally not
> ported; see gap #4). Fingertip has since flipped its default to the R3F WebGPU
> renderer (2026-05-22) and its surface has grown beyond this audit (WebGPU
> backend selection, `semanticGpuScoring`, `streamingPositions`, `sceneChildren`
> / `ClusterLabels3D`), which this doc does not cover.

## Premise

The R3F renderer (`DotVisualizationR3F`) needs to support the surface that **fingertip** uses, with **maximum code sharing** between Canvas and R3F paths. Parallel implementations of pulse logic, decollision scheduling, fit math, interaction state, etc. are out — we'd never keep them in sync. Diverge only where WebGL semantics genuinely require it (e.g. SDF shaders vs. 2D paint).

## Fingertip's surface

Audited from [`SamplesMap.tsx`](../../vibseek/fingertip/src/components/SamplesMap.tsx) and [`useFocusDotRenderer.ts`](../../vibseek/fingertip/src/hooks/useFocusDotRenderer.ts).

**Props passed:**
`data`, `defaultSize`, `defaultOpacity`, `dotStyles` (with `r`, `fill`, `opacity`, `pulse{duration,sizeRange,opacityRange,pulseColor,ringEffect,pulseInward,ringTargetPixels,ringMinRatio}`), `radiusOverrides`, `sharedPositionCache`, `scopeKey`, `constraintKey`, `customDotRenderer`, `dotStrokeWidthFraction`, `useCanvas`, `gpuPanZoom`, `renderMargin`, `blockHoverDuringInteraction`, `pausePulseDuringInteraction`, `isIncrementalUpdate`, `positionsAreIntermediate`, `initialTransform`, `occludeTop`, `occludeBottom`, `onHover`, `onLeave`, `onClick`, `onBackgroundClick`, `onDecollisionComplete`.

**Imperative ref:**
`zoomToVisible(duration, easing, dataOverride, marginOverride, updateExtents, maxScale)`, `getFitTransform(dataOverride, marginOverride)`, `getZoomTransform()`, `setZoomTransform(transform, options)`.

**Named exports consumed:**
`useDecollisionCache` (renderer-agnostic hook), `calculateAdaptiveRingRadius` (pure utility).

## Already shareable (use as-is in R3F)

These modules are renderer-agnostic. R3F should consume them directly instead of reimplementing:

| Module | Used by Canvas | R3F status |
|---|---|---|
| [`useDecollisionScheduler.js`](../src/useDecollisionScheduler.js) | Yes (full base + constraint state machine) | **Resolved (2026-07-01)** — used in [DotVisualizationR3F.jsx](../src/r3f/DotVisualizationR3F.jsx) (`useDecollisionScheduler(...)`, WebGPU runs it through a GPU executor) |
| [`decollisionScheduler.js`](../src/decollisionScheduler.js) (state machine) | Yes | **Resolved (2026-07-01)** — used via the hook |
| [`useDecollisionCache.js`](../src/useDecollisionCache.js) | Yes | Canvas/WebGL transition target cache; WebGPU uses GPU snapshots instead |
| [`usePulseAnimation.js`](../src/usePulseAnimation.js) | Yes | **Resolved (2026-07-01)** — the ad-hoc loop is gone; [R3FDots.jsx](../src/r3f/R3FDots.jsx) drives instances from `usePulseAnimation` |
| [`useFrameBudget.js`](../src/useFrameBudget.js) | Yes (via `usePulseAnimation`) | **Resolved (2026-07-01)** — used via `usePulseAnimation` |
| [`pulseRingUtils.js`](../src/pulseRingUtils.js) (`calculateAdaptiveRingRadius`) | Yes | **Resolved (2026-07-01)** — used in [R3FDots.jsx](../src/r3f/R3FDots.jsx) for adaptive ring sizing |
| [`dotUtils.js`](../src/dotUtils.js) (`getDotSize`) | Yes | Used — OK |
| [`utils.js`](../src/utils.js) (`boundsForData`) | Yes | Used — OK (plus the shared `computeFitTransformToVisible`) |
| [`spatialIndex.js`](../src/spatialIndex.js) | Yes (hover hit-test) | **Used (as of 2026-07-01)** — [R3FScene.jsx](../src/r3f/R3FScene.jsx)'s HoverDetector builds the same spatial grid for CPU hit-testing; the WebGPU backend can hit-test via GPU picking instead |

**The big code-sharing wins were #1 (scheduler) and #4–6 (pulse pipeline).** Both subsystems are now shared (see status note above).

## Gaps mapped to fingertip props

Severity is fingertip-impact. Reuse column says which shared module fixes it.

### Visual / per-dot state

| # | Prop / feature | Severity | Reuse | Notes |
|---|---|---|---|---|
| 1 | `defaultOpacity`, `dotStyles.opacity`, `pulse.opacityRange` | High | shader only | **Resolved (2026-07-01)** — per-instance alpha attribute landed: [R3FDots.jsx](../src/r3f/R3FDots.jsx) attaches an `instanceAlpha` buffer driving `defaultOpacity`, `dotStyles.opacity`, `hoverOpacity`, and `pulse.opacityRange`; the WebGPU path resolves opacity per dot in [`dotAppearance.js`](../src/r3f/dotAppearance.js). |
| 2 | `radiusOverrides` not applied to rendered size | High | none | **Resolved (2026-07-01)** — `radiusOverrides` is a prop on both dot layers and is applied via `resolveBaseSize` ([`dotAppearance.js`](../src/r3f/dotAppearance.js), [`instanceUpdate.js`](../src/r3f/instanceUpdate.js), [R3FDotsWebGPU.jsx](../src/r3f/R3FDotsWebGPU.jsx)), including pick radii. |
| 3 | `dotStyles.pulse.{ringEffect,ringTargetPixels,ringMinRatio,pulseInward,opacityRange,pulseColor,duration,sizeRange}` | High | **`usePulseAnimation` + `pulseRingUtils`** | **Resolved (2026-07-01)** — [R3FDots.jsx](../src/r3f/R3FDots.jsx) drives instance updates from `usePulseAnimation` (shared phase + frame budgeting) and sizes rings via `calculateAdaptiveRingRadius`. |
| 4 | `customDotRenderer` (focused-dot inner+ring) | High | none | **Resolved via option (a) (2026-07-01)** — the focus visual is built in: `dotStyles.focusRing` sets a per-instance `instanceFocus` flag rendered as the inner+outer-ring visual in the shader. The `customDotRenderer` callback itself remains Canvas-only by design (R3F can't expose a `CanvasRenderingContext2D`). |

### Lifecycle / decollision

All resolved (2026-07-01) — R3F runs the same `useDecollisionScheduler` as Canvas
(with a GPU executor on the WebGPU backend), so these came along with it:

| # | Prop / feature | Severity | Reuse |
|---|---|---|---|
| 5 | `scopeKey` honored | Medium | scheduler — **resolved**; the data effect detects scope changes and re-runs base decollision |
| 6 | `constraintKey` triggers re-decollision with bumped radii | High | **scheduler** — **resolved**; base + constraint phases modeled |
| 7 | `isIncrementalUpdate` + `positionsAreIntermediate` semantics match Canvas | Medium | **scheduler** — **resolved**; shares `resolveDataEffectPositions` + `useStablePositions` with Canvas |
| 8 | `onDecollisionComplete` fires on both initial settle AND constraint settle AND animate-from-cache path | High | **scheduler** — **resolved**; wired through `onBaseReady`/`onConstraintReady` |
| 9 | CPU `sharedPositionCache` round-trips on Canvas/WebGL; WebGPU restores from GPU snapshots | Medium | scheduler + WebGPU executor — **resolved** as described |

### Camera / fit

All resolved (2026-07-01) — the fit math was extracted into the shared
`computeFitTransformToVisible` ([`utils.js`](../src/utils.js)), which both
`ZoomManager` and R3F's `computeFit` call; R3F converts the resulting
viewBox-space `{x, y, k}` to a camera position (`d3ToCamera`):

| # | Prop / feature | Severity | Reuse |
|---|---|---|---|
| 10 | `initialTransform` honored on first paint | Medium | **resolved** — `CameraInitializer` in [R3FScene.jsx](../src/r3f/R3FScene.jsx) applies it (falling back to an occlusion-aware fit) |
| 11 | `occludeTop` / `occludeBottom` (panel-aware fit) | High | **resolved** — shared `computeFitTransformToVisible` handles occlusion in both renderers |
| 12 | `zoomToVisible(duration, easing, dataOverride, marginOverride, updateExtents, maxScale)` does the work | High | **resolved** — full signature implemented in R3F's imperative handle, incl. `maxScale` re-centering (only `updateExtents` is a no-op; R3F has no d3 zoom extents) |
| 13 | `getFitTransform` / `getZoomTransform` return consistent D3-equivalent transforms | Medium | **resolved** — plus `setZoomTransform` for round-tripping |

### Interaction

| # | Prop / feature | Severity | Reuse |
|---|---|---|---|
| 14 | `blockHoverDuringInteraction` | Medium | **Resolved (2026-07-01)** — R3F accepts the prop; `R3FCamera` flips an interaction ref on pan start/end and `HoverDetector` gates hover acquisition on it |
| 15 | `pausePulseDuringInteraction` | Medium | **Still open** — R3F does not accept the prop. Less pressing than on Canvas: R3F pulse painting rides the existing `useFrame` loop (and `usePulseAnimation`'s own rAF is a no-op there), so there's no separate pulse rAF to cancel |

### Canvas-only / N/A in R3F

These have *strict technological reasons* and shouldn't be ported:

- `useCanvas` — renderer-selection prop; meaningless in R3F.
- `gpuPanZoom` — Canvas-specific optimization (bitmap CSS transform during gestures); WebGL is GPU-native, so R3F gets the equivalent for free.
- `renderMargin` — exists only to support `gpuPanZoom`; N/A.

## Suggested order (fingertip-driven)

Numbered to read top-down — each step builds on the previous. **Status
(2026-07-01): steps 1–5 and 7 are done; step 6 is done for
`blockHoverDuringInteraction` only (`pausePulseDuringInteraction` remains
Canvas-only, see gap #15).**

1. ✅ **Extract the scheduler integration into R3F** (gaps #5–9). Biggest single code-sharing win; removes ~80 lines of bespoke decollision logic in `DotVisualizationR3F.jsx`. Replace the bare `decollisioning()` call with `useDecollisionScheduler` exactly the way Canvas does.
2. ✅ **Per-dot opacity in the shader** (gap #1). Adds instance alpha attribute; unblocks gap #3's `opacityRange`.
3. ✅ **`radiusOverrides` applied to render** (gap #2). One-line bug.
4. ✅ **Adopt `usePulseAnimation` in R3F** (gap #3). Delete the ad-hoc loop in `R3FDots.jsx`; have R3F's `useFrame` ingest the hook's per-id state and write instance matrices/colors.
5. ✅ **Extract a shared `computeFitTransform`** + wire `occludeTop/Bottom` and `zoomToVisible` (gaps #10–13). Landed as `computeFitTransformToVisible` in `utils.js`, called by both renderers.
6. ◐ **Shared interaction-state hook** for `block/pausePulseDuringInteraction` (gaps #14–15). `blockHoverDuringInteraction` is wired (interaction ref + HoverDetector); `pausePulseDuringInteraction` still isn't accepted by R3F.
7. ✅ **Focused-dot visual via shader** (gap #4). Landed as the built-in `dotStyles.focusRing` → `instanceFocus` visual.

Fingertip has since adopted R3F (WebGPU backend) as its default samples-map renderer (2026-05-22); the `customDotRenderer` callback remains Canvas-only, replaced in R3F by the built-in focus visual.

## Out of scope (not used by fingertip)

Deferred or skipped until a real consumer needs them: per-dot stroke color, `strokeDasharray`, image patterns, `ClusterLabels` (R3F has since gained its own in-scene `ClusterLabels3D` for the WebGPU backend, used by fingertip), edges (R3F does render edges via `R3FEdges`), `onDragStart`/`onDoubleClick` (`onContextMenu` is now accepted by both renderers), `autoZoomToNewContent`, viewBox smoothing, custom `defaultColor` fallback chain. Re-evaluate if fingertip's surface grows.
