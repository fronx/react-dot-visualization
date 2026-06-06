# WebGPU Decollision Convergence Report

Date: 2026-05-21

## Summary

The R3F/WebGPU samples-map renderer now runs decollision to a measured velocity fixpoint instead of stopping after a fixed frame count. This fixes the visible focus churn where clicking a sample caused broad dense regions to keep shrinking and sparse regions to reshuffle even though only the focused dot's radius changed.

The key result: once the base layout has actually converged, it becomes a reliable cached home state. Defocus can animate back to that base and close the rim left by the enlarged focused dot; focus from base should only move the local overlap around the enlarged dot instead of re-energizing unfinished global collision.

## Symptom

In the WebGPU backend, focusing a sample still produced too much screen motion:

- Dense areas compressed further during focus transitions.
- Sparse areas had small random dot swaps with no visual benefit.
- Interaction sometimes felt delayed after focus clicks because the renderer was doing large invisible setup/compute work before the transition finished.

This was most visible on large samples-map datasets, where the base cloud contains tens or hundreds of thousands of points.

## Root Cause

The fixed caps (`BASE_SETTLE_FRAMES = 220`, `CONSTRAINT_SETTLE_FRAMES = 90`) were not convergence criteria. They were just time limits.

For dense UMAP layouts, 220 frames was often not enough to reach a stable collision fixpoint. A later focus run then did two things at once:

1. Resolve the newly enlarged focused dot.
2. Continue the unfinished base decollision.

That second effect was the unwanted global motion. The focus operation was not inherently moving the whole map; it was resuming an under-converged base simulation.

## Implementation

### Scheduler Reuse

`useDecollisionScheduler` was made executor-injectable:

- Canvas/WebGL use the default CPU/standalone-WebGPU executor.
- R3F/WebGPU injects a GPU-resident executor.
- The scheduler still owns phase transitions, constraint cache semantics, and base/focus routing.

This keeps renderer behavior aligned while letting WebGPU execute simulation and cached-position lerps without per-frame CPU readback. Canvas/WebGL still use CPU position maps for their transition targets; WebGPU treats reusable layouts as GPU snapshots.

### GPU-Resident WebGPU Executor

`R3FDotsWebGPU` now consumes scheduler requests through `gpuControlRef`:

- `sim`: seed GPU position/velocity buffers and run spatial-hash collision kernels. Base completion snapshots live `positions` into a persistent GPU `basePos` buffer instead of materializing a CPU array by default.
- `lerp`: snapshot live GPU positions and mix to either an uploaded CPU target or the GPU `basePos` snapshot.

Per-seed buffers survive cosmetic restyles and focus changes. Sim resources are cached by grid signature so focusing repeatedly does not leak fresh pipelines and bin buffers.

### Convergence Metric

The TSL kernel set now includes `buildMeasureMaxVelocitySquared`.

It reduces the largest post-apply velocity squared into a single atomic `uint` buffer using fixed-point scaling. WebGPU atomics do not support floats, so the metric is:

```text
maxVelocitySquaredU32 = max(vx*vx + vy*vy) * 1_000_000
```

The renderer reads back this 4-byte metric every 8 frame batches. A simulation settles when the metric falls below the configured threshold, or when the safety cap is hit.

Current defaults:

- `SOLVER_ITERATIONS_PER_FRAME = 4`
- `CONVERGENCE_CHECK_FRAME_INTERVAL = 8`
- `CONVERGED_MAX_VELOCITY = 0.002` world units
- `BASE_MAX_SOLVER_ITERATIONS = 2400`
- `CONSTRAINT_MAX_SOLVER_ITERATIONS = 1200`

These iteration caps are safety limits, not normal settle criteria.

## Verification

Automated checks:

- `npm run build:lib` passes.
- Targeted non-GPU tests pass:
  - `tests/decollisionScheduler.test.mjs`
  - `tests/instance-update.test.mjs`
  - `tests/positionChangeDetection.test.mjs`
  - `tests/resolveDataEffectAction.test.mjs`
- GPU-backed TSL checks pass when run with GPU access:
  - `npm run check:tsl`
  - `npm run check:tsl-spatial`

The new metric kernel is covered by `npm run check:tsl`, which verifies that the fixed-point atomic max reports the expected max velocity.

Live app verification:

- The samples map now converges sufficiently that focus/defocus behavior is visually stable.
- User-confirmed: "It's working!"

## Remaining Watch Points

- The convergence threshold is intentionally conservative but still empirical. If very dense datasets hit the safety cap before visually settling, raise the cap or tune the velocity threshold.
- The renderer still does large per-launch setup for all points. Convergence fixes the visual churn; further interaction latency work may still require pausing compute during wheel/pan or reducing focus runs to local work.
- Plain sandboxed WebGPU tests may fail to acquire an adapter. Running the same checks outside the sandbox succeeds.
