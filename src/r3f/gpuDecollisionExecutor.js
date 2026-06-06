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
 *     cache target can explicitly ask for a one-shot position readback.
 *   - runAnimation  -> a 'lerp' request: snapshot the live positions, upload
 *     the cached target, and mix(from, target, easeOut(t)) in-shader each
 *     frame -> onComplete(target) at t=1.
 *
 * onUpdateNodes (the per-tick CPU publish the Canvas/WebGL paths consume) is
 * intentionally ignored: positions never leave the GPU during a sim by default,
 * which is the entire reason this path exists. The base-position cache is an
 * explicit bridge: it asks for one completion snapshot so focus-clear can lerp
 * to the real neutral layout without making rendering depend on React-owned
 * settled positions.
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
    runSimulation({ sourceData, fnDotSize, constraintKey, readbackPositionsOnComplete = false, onComplete }) {
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
        seedFromCurrentPositions: true,
        skipConvergenceMetric: !constraintKey && !!baseFixedIterations,
        readbackPositionsOnComplete: !!readbackPositionsOnComplete,
        onComplete,
      });
    },
    runAnimation({ target, duration, onComplete }) {
      return issue({ type: 'lerp', target, duration, onComplete });
    },
  };
}
