/**
 * GPU-resident execution backend for useDecollisionScheduler (the WebGPU R3F
 * path). Mirror of cpuDecollisionExecutor: the scheduler still owns every
 * decision (phase machine, position cache, go-through-base transitions); this
 * executor only changes *how* a launch or transition runs.
 *
 * Where the CPU executor runs the d3 / standalone-WebGPU sim and publishes a
 * fresh CPU node array per tick, this one writes a command into a request
 * channel (gpuControlRef.current.request) that R3FDotsWebGPU consumes inside
 * its useFrame loop and executes entirely on the GPU:
 *   - runSimulation -> a 'sim' request: seed the positions buffer, build the
 *     spatial-hash collide pipeline for the launch radii, and step the kernels
 *     in-shader. Completion reports readiness by default; callers that need a
 *     reusable target can request a GPU snapshot.
 *   - runAnimation  -> a 'lerp' request: snapshot the live positions, upload
 *     the cached target, and mix(from, target, easeOut(t)) in-shader each
 *     frame -> onComplete(target) at t=1.
 *
 * onUpdateNodes (the per-tick CPU publish the Canvas/WebGL paths consume) is
 * intentionally ignored: positions never leave the GPU during a sim by default,
 * which is the entire reason this path exists. WebGPU captures a GPU-resident
 * base snapshot so focus-clear can lerp to the real neutral layout without
 * materializing React-owned settled positions.
 *
 * The request channel is a plain object on gpuControlRef.current. It decouples
 * the scheduler (parent component, outside the R3F Canvas) from the GPU work
 * (child, inside useFrame) and is race-free against the lazy Canvas mount: a
 * request issued before the child's first frame simply waits there until the
 * frame loop reads it (latest request wins, matching cancelSimulation + relaunch).
 */
export function makeGpuExecutor(gpuControlRef, {
  baseMaxIterations,
  constraintMaxIterations,
  solverIterationsPerFrame,
  solverFrameBudgetMs,
  baseFixedIterations,
}) {
  let reqSeq = 0;

  const issue = (req) => {
    const id = ++reqSeq;
    if (gpuControlRef.current) gpuControlRef.current.request = { id, ...req };
    return {
      stop() {
        const channel = gpuControlRef.current;
        // Only cancel if our request is still the pending one; a newer launch
        // already superseded us otherwise.
        if (channel && channel.request && channel.request.id === id) {
          channel.request = { id: ++reqSeq, type: 'stop' };
        }
      },
    };
  };

  return {
    canSnapshotPositions: true,
    hasPositionSnapshot(key) {
      return !!gpuControlRef.current?.positionSnapshots?.has(key);
    },
    // Drop the GPU snapshot for a key so the next decollideForConstraint(key)
    // relaunches the sim instead of lerping to a now-stale layout. This is the
    // WebGPU half of a scope change: the CPU/WebGL backend wipes
    // sharedPositionCache via checkScope(); WebGPU keeps its settled layout in
    // GPU buffers, so the matching invalidation is forgetting the snapshot key.
    invalidatePositionSnapshot(key) {
      gpuControlRef.current?.positionSnapshots?.delete(key);
    },
    runSimulation({
      sourceData,
      fnDotSize,
      constraintKey,
      snapshotOnCompleteKey = null,
      onComplete,
    }) {
      // These are safety caps only. R3FDotsWebGPU stops earlier once the
      // velocity metric says the layout is at a visual fixpoint.
      const maxIterations = constraintKey ? constraintMaxIterations : baseMaxIterations;
      return issue({
        type: 'sim',
        sourceData,
        fnDotSize,
        constraintKey,
        maxIterations,
        solverIterationsPerFrame,
        solverFrameBudgetMs,
        // Base launches (constraintKey === '') reseed from sourceData: a fresh
        // layout or a dot-size change must re-spread from the raw projection,
        // and the push-only collide solver can't re-spread positions that are
        // already settled. Constraint launches (focus/clear) seed from the
        // current GPU positions — nudging from where dots already are is the
        // entire point of the GPU-current speedup.
        seedFromCurrentPositions: !!constraintKey,
        skipConvergenceMetric: !constraintKey && !!baseFixedIterations,
        snapshotOnCompleteKey,
        onComplete,
      });
    },
    runAnimation({ target, targetSnapshotKey = null, duration, onComplete }) {
      return issue({ type: 'lerp', target, targetSnapshotKey, duration, onComplete });
    },
  };
}
