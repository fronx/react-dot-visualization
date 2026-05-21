import * as d3 from 'd3';
import { decollisioning } from './decollisioning.js';

/**
 * Default execution backend for useDecollisionScheduler — the CPU / standalone-
 * WebGPU sim (via decollisioning()) plus a d3.timer position lerp.
 *
 * The scheduler owns the *decisions* (phase machine, cache, go-through-base);
 * an executor owns *how a launch or transition is carried out*. When no
 * executor is injected the scheduler builds this one, so the Canvas and
 * WebGL-R3F paths keep their exact prior behavior. The WebGPU path injects a
 * GPU-resident executor instead (src/r3f/gpuDecollisionExecutor.js) so its sim
 * stays on the GPU with no per-frame readback.
 *
 * Contract (both methods return a handle with stop()):
 *   runSimulation({ sourceData, fnDotSize, transitionConfig, onUpdateNodes, onComplete })
 *   runAnimation ({ fromData, target, targetPositions, duration, onUpdateNodes, onComplete })
 * The scheduler wraps onComplete to clear its handle, sync state, and store the
 * cache; onUpdateNodes publishes live per-tick frames (consumed by Canvas/WebGL,
 * ignored by the GPU executor whose positions live in a GPU buffer).
 */
export function makeCpuExecutor({ decollisionEngineRef, isDraggingRef, interactionActiveRef, sendMetricsRef }) {
  function runSimulation({ sourceData, fnDotSize, transitionConfig, onUpdateNodes, onComplete }) {
    let cancelled = false;
    const skipFrames = transitionConfig?.enabled === true;

    const simulation = decollisioning(
      sourceData,
      (nodes) => { if (!cancelled) onUpdateNodes(nodes); },
      fnDotSize,
      (finalData) => { if (!cancelled) onComplete(finalData); },
      skipFrames,
      transitionConfig,
      {
        engine: decollisionEngineRef.current,
        shouldPublishIntermediate: () => !(isDraggingRef.current || interactionActiveRef.current),
        sendMetrics: sendMetricsRef.current,
      },
    );

    return { stop() { cancelled = true; simulation?.stop?.(); } };
  }

  function runAnimation({ fromData, target, duration, onUpdateNodes, onComplete }) {
    const ease = d3.easeCubicOut;
    let cancelled = false;

    const timer = d3.timer((elapsed) => {
      if (cancelled) { timer.stop(); return; }
      const t = Math.min(1, ease(elapsed / duration));
      const interpolated = target.map((targetItem, i) => {
        const source = fromData[i] || targetItem;
        return {
          ...targetItem,
          x: source.x + (targetItem.x - source.x) * t,
          y: source.y + (targetItem.y - source.y) * t,
        };
      });
      onUpdateNodes(interpolated);
      if (t >= 1) {
        timer.stop();
        onComplete(target);
      }
    });

    return { stop() { cancelled = true; timer.stop(); } };
  }

  return { runSimulation, runAnimation };
}
