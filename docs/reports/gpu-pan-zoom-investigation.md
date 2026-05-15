# GPU-Composited Canvas Pan/Zoom — Investigation Report

## Context

We had visible pan/zoom slowness at high dot counts (100k+) in the canvas renderer, and could reproduce the same slowness in the standalone demo at 50k–100k. The bottleneck was on the main thread: every pan/zoom event triggered a full O(n) redraw plus a spatial-index rebuild. This investigation explored whether we could keep the Canvas 2D renderer and offload pan/zoom to the GPU via CSS transforms, before deciding whether a full WebGL renderer is warranted.

**Scope of this thread:** stay on Canvas 2D, push interaction work to the GPU compositor. The next thread will start fresh and explore a WebGL renderer.

## What we built

A "GPU pan/zoom" mode on `DotVisualization`, opt-in via the `gpuPanZoom` prop. When enabled:

1. **During a gesture** — apply CSS `transform: translate(...) scale(...)` to the canvas element. The browser composites it on the GPU; no canvas redraw, no spatial-index rebuild, no per-dot iteration. Per-frame cost is independent of dot count.
2. **After 32 ms of input idle** — redraw the canvas at the current d3-zoom transform. This resets the "baseline" so the next gesture's CSS delta starts at zero.

To make the gesture visually correct outside the originally-rendered viewport, two layers were added:

3. **Over-render margin** (`renderMargin` prop, default 0, demo uses 1.0): the canvas covers an *extended* viewBox region — visible viewport + margin on each side. Bounded by a 256 MB bitmap budget that auto-shrinks the effective margin on high-DPR / large screens.
4. **Low-res backdrop layer**: a second canvas covering the entire data bounding box at fixed resolution (max 1024 px). Always renders all dots once on data change, then mirrors the d3 transform via CSS during gestures. Sits behind the foreground; fills the edges when the user pans/zooms outside the foreground's margin.

## Key files

- `src/DotVisualization.jsx`
  - `gpuPanZoomRef`, `interactionActiveRef` — gate the GPU path
  - `markInteractionActive` — 32 ms idle timer drives the settle redraw
  - `canvasRenderer` — branches: GPU CSS transform during interaction, full redraw otherwise; always updates the backdrop CSS transform
  - SVG element has `overflow: hidden` so the over-rendered margin is only visible when pan reveals it
- `src/ColoredDots.jsx`
  - `extendedViewBox` (memo) — visible viewBox + margin, auto-capped by bitmap memory budget
  - `applyGpuTransform(transform)` — computes CSS delta from baseline; returns false if no baseline (caller falls through to redraw)
  - `clearGpuTransform()` — wipes the inline style
  - `dataBBox` (state) — full data bounding box for the backdrop foreignObject
  - `applyBackdropTransform(transform)` — backdrop's baseline is identity, so CSS = current d3 transform offset by `dataBBox.minX/minY * (s-1)`
  - Backdrop render `useEffect` — draws all dots at low resolution on data change

## What works well

- **Pan/zoom is decoupled from dot count.** At 50k dots, gesture FPS is whatever the compositor can do (60+ on any modern machine). No per-frame canvas work.
- **The settle is invisible during continuous gestures.** At 32 ms idle, natural inter-event spacing (16 ms trackpad, similar mouse drag) never triggers a settle mid-burst — only after the user stops.
- **Cursor-anchored zoom is correct.** Math derivation is in the `applyGpuTransform` comment; we replicate d3-zoom's cursor pin exactly because we just apply the same transform on the GPU.
- **Backdrop fills edges seamlessly.** Once the foreground's margin is exhausted, the low-res backdrop is visible underneath — no empty space, just lower-resolution dots.

## Hard limits we hit

These are not bugs — they are architectural ceilings of the canvas-bitmap-with-CSS-transform approach.

1. **Zoom-in past ~2× becomes visibly blurry during the gesture.** The bitmap upscales linearly; the redraw on settle restores sharpness. Acceptable for many UX, not for all.
2. **Memory grows quadratically with margin.** A 100% margin at 1080p Retina would want a 1.2 GB bitmap. We cap at 256 MB and silently shrink the effective margin — but on big screens, the margin shrinks to ~40% or less, which is small enough to be panned through during a single gesture.
3. **The backdrop is low-res by design.** Once a user pans far enough that the backdrop is the only thing visible, dots look soft. At extreme zoom-in, the backdrop is *very* blurry. The foreground keeps it in check at typical zoom levels but doesn't extend the backdrop's resolution.
4. **The settle redraw still blocks the main thread synchronously.** At 50k dots with 100% margin, it's ~30 ms. If the user resumes scrolling exactly during that 30 ms window, they feel a hitch. With 32 ms idle, the redraw probability per gap is `30 / (30 + 32) ≈ 48%` — so resuming-after-a-pause has a ~50/50 chance of catching a hitch. This is the most fundamental remaining limit.
5. **The whole approach is a manual reimplementation of LOD / tile pyramids.** Backdrop = low-LOD, foreground = high-LOD viewport. Adding more LOD levels, predictive tile loading, or async render queues means reinventing what map and scatterplot libraries do for free.

## Gotchas hit along the way (with fixes)

These are bugs we *discovered and fixed*. The next thread shouldn't rediscover them.

### 1. Settle timer too short → mid-burst hitch

At 120 ms, natural pauses between small-increment wheel events crossed the threshold; the settle fired, blocked the main thread, and the next scroll event hit the block. **Fix**: tested 120 → 500 ms (good for pan, bad for zoom-out), then unified to 32 ms (~2 frames) — short enough that natural inter-event gaps fall under it and refresh feels continuous. The trade-off is more redraws when the user has many small pauses, but each redraw lands in idle time.

### 2. CSS transform "double speed" / wrong zoom anchor

The canvas lives inside `<foreignObject>`. Its own CSS pixel space already equals viewBox units (because the foreignObject's width/height attributes define the inner HTML viewport size). Applying a `cssW / vbW` scale factor in the CSS-transform math is wrong — the SVG viewBox→screen mapping is applied *after* the CSS transform, so the factor compounds. **Fix**: drop the scale factor; use d3-zoom transform values directly in the CSS transform.

### 3. 1–2 px vertical offset between CSS-scaled and redrawn states

Toggling `canvas.style.transform = ''` between a value and empty triggered compositor layer promotion/demotion. The two states (transformed/promoted vs. static/non-promoted) use different sub-pixel rounding rules in some browsers — see Mozilla #739176, WebKit #129859, Mozilla #608812. **Fix**: keep the canvas permanently promoted via `willChange: 'transform'`, and snap the canvas's SVG-coord origin (extendedViewBox top-left) to integer SVG units so it doesn't sit at a fractional pixel position.

### 4. `enableDecollisioning` prop was dead in canvas mode

Comment said "unused by canvas renderer (scheduler handles it)." The scheduler ran unconditionally. **Fix**: threaded the prop into `useDecollisionScheduler` as `enabled`, gated `processAction` to skip when disabled, and added an effect that triggers `launchBase` on `enabled` transitions.

### 5. Data-count changes didn't re-decollide

Adding/removing dots left the cached layout stale. **Fix**: data effect detects `validData.length !== prev` and calls `schedulerRef.current.decollideForConstraint('')` to launch a fresh base sim from raw input.

### 6. Dead `enablePositionTransitions` prop in the demo

Triggered the React warning "does not recognize this prop on a DOM element" because it fell through `...otherProps` to the SVG. **Fix**: deleted; the prop name doesn't exist in the library.

## Recommendation for the WebGL follow-up

### Why switch

The 30 ms main-thread block on settle is the dominant remaining UX issue, and the only way to truly eliminate it is to either (a) chunk + async-render (OffscreenCanvas + Worker), or (b) move dots to the GPU as geometry so pan/zoom is a uniform matrix update with no bitmap and no settle. Option (b) is the same total work as making (a) production-ready, but it removes the entire CSS-transform-baseline-margin-backdrop machinery we just built.

A WebGL renderer with **instanced quads + smoothstep fragment shader** for circles also:

- Renders crisp at *any* zoom level (no bitmap to blur)
- Scales to 1M+ dots (regl-scatterplot demonstrates 20M)
- Has zero per-frame JS cost for pan/zoom (just a uniform update)
- Eliminates the spatial-index rebuild problem (visibility culling can be GPU-side via fragment discard, or replaced with simpler bbox tests)

### Recommended starting points

- **[regl-scatterplot](https://github.com/flekschas/regl-scatterplot)** — production-ready scatterplot library on regl (a thin WebGL wrapper). Closest fit for our use case; supports lasso selection, hover, transitions.
- **Custom thin WebGL renderer** using [regl](https://github.com/regl-project/regl) directly — gives full control over the dot shader (we'd want to keep features like pulse rings, stroke variants, image dots).

R3F (already partially present at `src/r3f/`) is *not* recommended:
- Default point sprites are texture-based and blur on zoom (this is what the user observed). A custom shader fixes it, but at that point you're not really using R3F's value-add.

### What to keep from this thread

Most of `DotVisualization` is renderer-agnostic and should survive the swap:

- The hover/click/drag/keyboard event surface
- The decollision scheduler and its lifecycle (`useDecollisionScheduler`)
- The `sharedPositionCache`, `scopeKey`, `constraintKey` contract for layout transitions
- The data-count change re-decollide trigger
- The `enableDecollisioning` gate

The `ColoredDots` rendering implementation — including the GPU pan/zoom code, `extendedViewBox`, `applyGpuTransform`, `applyBackdropTransform`, and the backdrop layer — can be **discarded entirely** when the WebGL renderer lands. It's specific to the canvas-bitmap approach.

`ZoomManager` and the d3-zoom integration should mostly stay — the WebGL renderer just needs a transform `{x, y, k}` per frame, which is what the manager already produces. The only change is to replace `canvasRenderer(transform)` with a "set GPU uniforms" call.

### Things the new renderer must match (existing visual contract)

- Anti-aliased circles, smooth at any zoom
- Per-dot color, size, stroke (color + width), opacity, dash pattern
- Hover state: enlarged radius, full opacity, drawn on top of others
- Pulse animations: time-driven size/opacity/color sine waves, plus expanding outer rings
- Image dots: identicons + raster images (currently SVG `<pattern>` for SVG mode, `drawImage` for canvas)
- Per-dot styles via `dotStyles` Map (fill, stroke, stroke-width overrides per-id)
- `customDotRenderer` escape hatch — this is the trickiest to port; consumers expect to call canvas APIs directly. May need a different escape hatch (e.g., shader-uniform overrides) for the WebGL renderer.

### Things the new renderer should *not* try to preserve

- The `useCanvas` toggle — pick one renderer per build, or one default with the other as a tree-shaken alternative.
- The SVG fallback path inside `ColoredDots` — it's been mostly dormant since the canvas path became the default and adds complexity.

## Open questions for the next thread

1. **Hit-testing strategy.** Current: spatial hash grid in canvas-pixel space. WebGL alternatives: GPU picking (render to a hidden ID buffer, read pixel under cursor) vs. a CPU-side spatial index in world coords that's updated only on data change. GPU picking is cheaper at scale but adds a per-frame readback. Worth benchmarking.
2. **Image dots.** Texture atlas in WebGL — straightforward but adds a bind/upload path. How many distinct images do we actually have in production? If <1k, a single 4096×4096 atlas covers it.
3. **Text labels.** `RegionLabels` currently uses SVG `<text>`. Keep SVG overlay (composited above the WebGL canvas) or move text into WebGL via SDF font? Probably keep SVG initially — text is rare enough that the cost is fine.
4. **`customDotRenderer`** — the canvas-context callback API doesn't translate to WebGL. Audit callers and decide: replace with a per-dot uniform/attribute schema, or accept that the WebGL renderer doesn't support this hook.

## Commits on this branch (`gpu-pan-zoom`)

1. `Fix decollision toggle and add GPU-composited pan/zoom mode` — initial wiring, demo 50k default, decollision fixes
2. `Add over-render margin and pixel-snap GPU-pan canvas` — render margin (with memory cap), `will-change: transform`, integer SVG-coord snapping
3. (pending) — settle-timer rework, backdrop layer, this report
