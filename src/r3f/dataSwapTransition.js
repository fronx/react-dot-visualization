/**
 * Id-matched data-swap transition support for R3FDotsWebGPU (opt-in via
 * DotVisualizationR3F's `dataSwapTransition` prop; default off).
 *
 * When `data`/`dataKey` swap to a new layout, the component reads the outgoing
 * layout's live GPU positions back once, seeds the new buffers so surviving
 * ids start where they were on screen, and plays one GPU lerp to the new raw
 * layout (newcomers ramp in via the entry-ramp buffer, removed ids drop). The
 * mapping lives here — pure, no React/GPU imports — so the headless Dawn tests
 * can drive the exact production seed against the production lerp kernels.
 */

// Seed identity for the GPU buffers: caller-provided dataset identity + count.
// Shared by R3FDotsWebGPU's seedKey memo and the swap detection so "the seed
// would rebuild" and "a swap transition applies" can never disagree.
export function seedKeyFor(data, dataKey) {
  return !data || data.length === 0
    ? 'empty'
    : `${dataKey ?? 'default'}|count:${data.length}`;
}

/**
 * Build the transition seed for a swap into `newData`.
 *
 * `oldPositions` is the outgoing positions buffer read back from the GPU:
 * packed render-space pairs [x, -y] indexed by the OLD layout's order.
 * Survivors (ids present in both layouts) start at their old on-screen
 * position with ramp0 = 1 (always fully shown); newcomers start at their
 * target with ramp0 = 0 so the entry ramp (alpha/scale × mix(progress, 1,
 * ramp0)) grows them in over the transition window. `survivors` lets callers
 * skip the transition entirely for disjoint id sets.
 */
export function buildSwapSeed({ newData, oldData, oldPositions }) {
  const oldIndexById = new Map();
  for (let i = 0; i < oldData.length; i += 1) oldIndexById.set(oldData[i].id, i);
  const N = newData.length;
  const from = new Float32Array(N * 2);
  const ramp0 = new Float32Array(N);
  let survivors = 0;
  for (let i = 0; i < N; i += 1) {
    const item = newData[i];
    const oldIndex = oldIndexById.get(item.id);
    if (oldIndex !== undefined && oldIndex * 2 + 1 < oldPositions.length) {
      from[i * 2] = oldPositions[oldIndex * 2];
      from[i * 2 + 1] = oldPositions[oldIndex * 2 + 1];
      ramp0[i] = 1;
      survivors += 1;
    } else {
      from[i * 2] = item.x;
      from[i * 2 + 1] = -item.y;
    }
  }
  return { from, ramp0, survivors };
}
