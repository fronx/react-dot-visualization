# CSS-based pan/zoom (`gpuPanZoom`)

A canvas-only opt-in mode that decouples pan/zoom frame rate from dot count. During a gesture the existing bitmap is shifted and scaled via CSS — the browser composites it on the GPU. No canvas redraw, no per-dot iteration, no spatial-index rebuild. When the gesture goes idle the canvas redraws once at the final transform so the next gesture starts from a fresh baseline.

See [`reports/gpu-pan-zoom-investigation.md`](reports/gpu-pan-zoom-investigation.md) for the design rationale, gotchas resolved, and the case for moving to WebGL after this.

## Enabling

```jsx
<DotVisualization
  data={data}
  useCanvas              // required
  gpuPanZoom             // opt-in flag
  renderMargin={1}       // 100% over-render on each side
/>
```

Two props, both off by default:

- `gpuPanZoom: boolean` — enables the CSS-transform path. Requires `useCanvas`.
- `renderMargin: number` — fraction of viewport size to over-render on each side of the visible viewBox. `0` (default) is "no margin." `1.0` paints a canvas 3× the viewport in each axis. Internally capped by a 256 MB bitmap budget — if the requested margin would exceed it (e.g. 4K Retina + `renderMargin={1}`), the effective margin shrinks silently.

`renderMargin` is only useful with `gpuPanZoom`. Without the flag, the margin pixels exist but are never on-screen.

A low-res backdrop canvas covering the full data bounding box is also enabled automatically. It sits behind the foreground and fills the edges when a pan exhausts the over-render margin.

## What changes from the consumer's side

- Pan/zoom gestures don't redraw the canvas. Per-frame cost is independent of dot count.
- After ~32 ms of input idle the canvas redraws at the current transform. Brief blocking call (~30 ms at 50k dots with `renderMargin={1}`).
- Hit-testing keeps working — the spatial index is now in data-space and is transform-invariant.
- Anything driven by `getZoomTransform()` or `getCurrentTransform()` (e.g. overlay labels positioned in data space) still receives every transform update during a gesture. Only the *canvas paint* is deferred.
- `decollision` redraws still happen synchronously — the GPU path is only active during user-driven pan/zoom gestures (it gates on `interactionActiveRef`).

## When to enable it

Good fit:

- ≥ ~5k dots and pan/zoom feels heavy.
- The bitmap memory cost is acceptable on the target machines (~64 MB at 1080p Retina, ~256 MB at 4K Retina with `renderMargin={1}`).
- The consumer's visible viewport stays roughly stable in size during a session.

Skip it:

- Small dot counts (<2k). The full redraw is already fast and the extra bitmap is wasted memory.
- Heavy zoom-in past ~2×. The CSS-stretched bitmap visibly blurs until settle. The settle redraw restores sharpness, but if your UX expects crisp dots mid-gesture, this is the wrong layer for it (use WebGL).
- Long, slow pans that traverse the entire dataset. The user will see the lower-res backdrop most of the way.

## Picking `renderMargin`

Larger margin → fewer settles redraw → smoother experience. Larger margin → more bitmap memory.

| `renderMargin` | Canvas area (× viewport) | Bitmap @ 1080p Retina | Behavior |
|---|---|---|---|
| `0` | 1× | ~16 MB | Every pan triggers a settle redraw. Don't pair with `gpuPanZoom`. |
| `0.5` | 4× | ~64 MB | Small pans stay within margin; medium pans hit settle. |
| `1.0` | 9× | ~145 MB | Most gestures stay within margin; settle is rare. Recommended default. |
| `>1.5` | ≥16× | ≥260 MB | Will be capped by the 256 MB budget. |

The budget cap is silent (`debug={true}` logs it). On large displays you may receive a smaller effective margin than requested. The backdrop fills the gap visually, just at lower resolution.

## Hard limits

Documented in detail in the investigation report. Quick reference:

1. **Zoom-in past ~2× blurs the bitmap during the gesture.** Restored on settle.
2. **Settle redraw blocks the main thread synchronously (~30 ms at 50k).** A user who resumes scrolling exactly during that window feels a hitch.
3. **Backdrop is low-res (max 1024 px on long axis).** Visible at extreme zoom-out or after a long pan that crosses the foreground margin.
4. **No tile pyramid / LOD.** The backdrop is one level; the foreground is the other. That's it.

For interaction that needs crisp dots at all times, scales to 1M+ dots, or eliminates the settle hitch entirely, the recommended path is a WebGL renderer — see the investigation report's "Recommendation for the WebGL follow-up" section.

## Debugging

Set `debug={true}` to enable the library's debug log. Relevant lines:

- `renderMargin X capped to Y by 256 MB bitmap budget` — the configured margin exceeded the per-bitmap memory ceiling and was shrunk.
- `renderMargin disabled: viewport alone exceeds bitmap budget` — the viewport itself is too large for the budget; the GPU path still works but with no over-render.
- `[ColoredDots] Rebuilt spatial index (data changed)` — confirms hit-test rebuilds aren't firing on transform changes (they're now data-only).
- `Backdrop rendered: { dots: N, bbox, bitmap: WxH }` — fires once per data-identity change.

If hover misses after enabling: the foreground bitmap's CSS transform is one path, the spatial index is another (data-space, invariant to camera). A mismatch here usually means `effectiveViewBox` or `containerDimensions` updated without a corresponding canvas dimensions reset — check that `ResizeObserver` is firing on the SVG element.
