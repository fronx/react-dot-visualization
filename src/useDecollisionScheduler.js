import { useRef, useCallback, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { PHASE, onIntermediateChange, onBaseComplete, onConstraintRequest, onColdStart } from './decollisionScheduler.js';
import { makeCpuExecutor } from './cpuDecollisionExecutor.js';
import { useLatest } from './useLatest.js';
import { useStableCallback } from './useStableCallback.js';

/**
 * Check whether cached positions are stale relative to current data.
 *
 * The cache key only encodes constraint identity (which track is focused),
 * not data identity (how many dots exist). When dots are added or removed,
 * the same key may point to stale positions. This check catches that case
 * by requiring the cache to cover all current data items.
 *
 * Returns the original positions if valid, or null (cache miss) if stale.
 */
export function validateCachedPositions(cachedPositions, dataLength) {
  if (!cachedPositions) return null;
  if (dataLength > 0 && cachedPositions.size < dataLength) return null;
  return cachedPositions;
}

/**
 * Build dot size function from radiusOverrides.
 * For base decollision, overrides may be empty → all dots get defaultSize.
 * For constraint decollision, overrides has per-dot sizes for larger dots.
 */
export function makeDotSizeFn(overrides, defaultSize) {
  return (item) => {
    const override = overrides?.get(item.id);
    return override !== undefined ? override : (item.size || defaultSize);
  };
}

/**
 * Resolve the current on-screen positions for animation "from" state.
 * Priority: live transition data (mid-simulation) > processedData (last commit) > raw data.
 */
export function resolveOnScreenData(liveData, processedData, rawData) {
  if (liveData && liveData.length > 0) return [...liveData];
  if (processedData && processedData.length > 0) return [...processedData];
  return [...(rawData || [])];
}

function isCacheOnlyCompletion(completionInfo) {
  return completionInfo?.cacheOnly === true;
}

/**
 * React hook wrapping the decollision scheduler state machine.
 *
 * Two triggers, both driven by props (correct by construction):
 * 1. positionsAreIntermediate settles (false) → base decollision
 * 2. radiusOverrides changes → constraint decollision (queued if base not ready)
 *
 * The app does NOT need to call decollideForConstraint for playlist/focus changes.
 * The library detects size changes from its own props and acts.
 */
export function useDecollisionScheduler({
  dataRef,
  processedDataRef,
  liveTransitionDataRef,
  cache,
  positionsAreIntermediate,
  constraintKey,
  radiusOverrides,
  decollisionEngine = 'auto',
  defaultSize,
  onUpdateNodes,
  onBaseReady,
  onConstraintReady,
  syncDecollisionState,
  onSimulationRunningChange,
  sendMetrics = false,
  isDraggingRef,
  interactionActiveRef,
  enabled = true,
  executor: providedExecutor = null,
}) {
  const phaseRef = useRef(PHASE.AWAITING_LAYOUT);
  const simulationRef = useRef(null);
  const queuedConstraintRef = useRef(null);
  const coldStartDoneRef = useRef(false);
  const activeConstraintKeyRef = useRef('');

  // Track previous values for edge detection
  const prevIntermediateRef = useRef(positionsAreIntermediate);
  const prevRadiusOverridesRef = useRef(radiusOverrides);

  // Stable callback wrappers so simulation closures always call latest version
  const stableOnUpdateNodes = useStableCallback(onUpdateNodes);
  const stableOnBaseReady = useStableCallback(onBaseReady);
  const stableOnConstraintReady = useStableCallback(onConstraintReady);
  const stableSyncDecollisionState = useStableCallback(syncDecollisionState);
  const stableOnSimulationRunningChange = useStableCallback(onSimulationRunningChange);

  // Keep latest values accessible without triggering re-runs
  const decollisionEngineRef = useLatest(decollisionEngine);
  const defaultSizeRef = useLatest(defaultSize);
  const sendMetricsRef = useLatest(sendMetrics);
  const radiusOverridesRef = useLatest(radiusOverrides);
  const constraintKeyRef = useLatest(constraintKey);
  const enabledRef = useLatest(enabled);
  const prevEnabledRef = useRef(enabled);

  // Execution backend. Default = CPU/standalone-WebGPU sim + d3.timer lerp
  // (built here so existing callers pass nothing and keep their behavior). The
  // WebGPU R3F path injects a GPU-resident executor; only the *how* differs —
  // every decision below (phase, cache, go-through-base) is renderer-agnostic.
  const defaultCpuExecutor = useMemo(
    () => makeCpuExecutor({ decollisionEngineRef, isDraggingRef, interactionActiveRef, sendMetricsRef }),
    [decollisionEngineRef, isDraggingRef, interactionActiveRef, sendMetricsRef],
  );
  const executor = providedExecutor ?? defaultCpuExecutor;

  const cancelSimulation = useCallback(() => {
    if (simulationRef.current) {
      simulationRef.current.stop();
      simulationRef.current = null;
      stableOnSimulationRunningChange(false);
    }
  }, [stableOnSimulationRunningChange]);

  /**
   * Launch a decollision simulation.
   * @param {Array} sourceData - data to decollide (caller provides, not read from dataRef)
   * @param {string} constraintKeyForLaunch - cache key for this simulation's result
   * @param {Map} overrides - radiusOverrides to use for dot sizes
   * @param {Function} onComplete - called with (finalData, constraintKey) on completion
   * @param {object} [transitionConfig] - if provided, skip intermediate frames and animate from stablePositions to final
   * @param {boolean} [readbackPositionsOnComplete] - executor-specific explicit CPU-position bridge for cache targets
   */
  const launchSimulation = useCallback((sourceData, constraintKeyForLaunch, overrides, onComplete, transitionConfig = null, readbackPositionsOnComplete = false) => {
    if (!sourceData || sourceData.length === 0) return;

    cancelSimulation();

    const fnDotSize = makeDotSizeFn(overrides, defaultSizeRef.current);
    stableOnSimulationRunningChange(true);

    const handle = executor.runSimulation({
      sourceData,
      fnDotSize,
      transitionConfig,
      constraintKey: constraintKeyForLaunch,
      readbackPositionsOnComplete,
      onUpdateNodes: stableOnUpdateNodes,
      onComplete: (finalData, completionInfo) => {
        simulationRef.current = null;
        stableOnSimulationRunningChange(false);
        stableSyncDecollisionState(finalData);
        onComplete(finalData, constraintKeyForLaunch, completionInfo);
      },
    });

    simulationRef.current = handle;
  }, [cancelSimulation, defaultSizeRef, executor, stableOnUpdateNodes, stableSyncDecollisionState, stableOnSimulationRunningChange]);

  // Ref to break circular dependency: launchBase → launchConstraint → processAction → launchBase
  const launchConstraintRef = useRef(null);

  const launchBase = useCallback(() => {
    const data = dataRef.current;
    if (!data || data.length === 0) return;

    // If there are on-screen positions (e.g. stable positions from import), animate
    // from them to the decollided result instead of showing raw physics frames.
    // This gives a smooth transition when layout settles after incremental updates.
    const onScreen = processedDataRef.current;
    const transitionConfig = onScreen.length > 0 ? {
      enabled: true,
      stablePositions: onScreen,
      duration: 350,
      easing: d3.easeCubicOut,
    } : null;

    // Base uses empty overrides (no constraint = uniform sizes)
    launchSimulation([...data], '', new Map(), (finalData, _launchKey, completionInfo) => {
      if (cache && Array.isArray(finalData)) {
        cache.store('', finalData);
      }

      activeConstraintKeyRef.current = '';
      const result = onBaseComplete(queuedConstraintRef.current);
      queuedConstraintRef.current = null;
      phaseRef.current = result.phase;

      stableOnBaseReady(isCacheOnlyCompletion(completionInfo) ? null : finalData);

      if (result.action?.type === 'launch-constraint') {
        launchConstraintRef.current?.(result.action.constraintKey);
      }
    }, transitionConfig, !!cache);
  }, [dataRef, processedDataRef, launchSimulation, cache, stableOnBaseReady]);

  const launchConstraint = useCallback((key) => {
    const data = dataRef.current;
    if (!data || data.length === 0) return;


    // Seed from base positions if available
    let sourceData;
    const base = cache?.cache.get('');
    if (base && base.size > 0) {
      sourceData = data.map(item => {
        const pos = base.get(item.id);
        return pos ? { ...item, x: pos.x, y: pos.y } : item;
      });
    } else {
      sourceData = [...data];
    }

    // Use current radiusOverrides (a prop, guaranteed up-to-date on this render)
    const overrides = radiusOverridesRef.current;

    launchSimulation(sourceData, key, overrides, (finalData, launchKey) => {
      if (cache && Array.isArray(finalData)) {
        cache.store(launchKey, finalData);
      }
      phaseRef.current = PHASE.READY;
      activeConstraintKeyRef.current = launchKey;
      stableOnConstraintReady(finalData, launchKey);
    });
  }, [dataRef, launchSimulation, cache, radiusOverridesRef, stableOnConstraintReady]);

  launchConstraintRef.current = launchConstraint;

  const getOnScreenData = useCallback(() => {
    return resolveOnScreenData(liveTransitionDataRef.current, processedDataRef.current, dataRef.current);
  }, [liveTransitionDataRef, processedDataRef, dataRef]);

  /**
   * Animate dots from current on-screen positions to target positions.
   * @param {Map} positions - target positions keyed by dot id
   * @param {number} duration - animation duration in ms
   * @param {Function} onComplete - called with (finalData) when animation finishes
   */
  const animateToPositions = useCallback((positions, duration, onComplete) => {
    const data = dataRef.current;
    if (!data || data.length === 0) return;

    // Capture "from" BEFORE cancelling — liveTransitionDataRef is cleared on cancel
    const from = getOnScreenData();
    cancelSimulation();

    const target = data.map(item => {
      const pos = positions.get(item.id);
      return pos ? { ...item, x: pos.x, y: pos.y } : item;
    });

    const handle = executor.runAnimation({
      fromData: from,
      target,
      duration,
      onUpdateNodes: stableOnUpdateNodes,
      onComplete: (finalData) => {
        simulationRef.current = null;
        stableSyncDecollisionState(finalData);
        onComplete(finalData);
      },
    });

    simulationRef.current = handle;
  }, [dataRef, getOnScreenData, cancelSimulation, executor, stableOnUpdateNodes, stableSyncDecollisionState]);

  // Ref to access processAction from animate-to-base completion
  const processActionRef = useRef(null);

  // Dispatch actions returned by the pure state machine to side effects.
  //
  // REENTRANT: 'animate-to-base' completion re-enters this dispatcher.
  // Constraint-to-constraint transitions always pass through base visually:
  //
  //   Trigger 2 → onConstraintRequest → [animate-to-base, queue-constraint]
  //   → animation ends → processActionRef.current → onConstraintRequest
  //   → launch-constraint (or animate-from-cache)
  //
  // The queued constraint is consumed before re-dispatch (queuedConstraintRef
  // is nulled first), so re-entrancy is bounded to one level.
  const processAction = useCallback((action) => {
    if (!action) return;
    if (Array.isArray(action)) {
      action.forEach(a => processAction(a));
      return;
    }
    if (!enabledRef.current && action.type !== 'cancel-base' && action.type !== 'cancel-constraint') {
      return;
    }
    switch (action.type) {
      case 'launch-base':
        launchBase();
        break;
      case 'launch-constraint':
        launchConstraint(action.constraintKey);
        break;
      case 'animate-from-cache':
        animateToPositions(action.positions, 500, (target) => {
          activeConstraintKeyRef.current = action.constraintKey;
          stableOnConstraintReady(target, action.constraintKey);
        });
        break;
      case 'animate-to-base':
        animateToPositions(action.positions, 350, () => {
          activeConstraintKeyRef.current = '';
          // Process queued constraint
          const queued = queuedConstraintRef.current;
          if (queued != null) {
            queuedConstraintRef.current = null;
            const cachedPositions = cache?.cache.get(queued) ?? null;
            const result = onConstraintRequest(phaseRef.current, queued, cachedPositions, false, '', null);
            processActionRef.current?.(result.action);
          }
        });
        break;
      case 'cancel-base':
      case 'cancel-constraint':
        cancelSimulation();
        break;
      case 'queue-constraint':
        queuedConstraintRef.current = action.constraintKey;
        break;
    }
  }, [launchBase, launchConstraint, animateToPositions, cancelSimulation, stableOnConstraintReady, cache]);

  processActionRef.current = processAction;

  // ── Trigger 1: positionsAreIntermediate edge transitions ──────────────
  useEffect(() => {
    const prev = prevIntermediateRef.current;
    prevIntermediateRef.current = positionsAreIntermediate;

    if (prev === positionsAreIntermediate) {
      // No change — check for cold start (first render with settled data)
      if (!coldStartDoneRef.current && dataRef.current?.length > 0) {
        coldStartDoneRef.current = true;
        const result = onColdStart(true, positionsAreIntermediate);
        phaseRef.current = result.phase;
        processAction(result.action);
      }
      return;
    }

    coldStartDoneRef.current = true;
    const result = onIntermediateChange(phaseRef.current, positionsAreIntermediate);
    phaseRef.current = result.phase;
    processAction(result.action);
  }, [positionsAreIntermediate, processAction, dataRef]);

  // ── Trigger 2: radiusOverrides changes → constraint decollision ───────
  // This fires on the render where radiusOverrides has already been updated
  // as a prop. The sizes are guaranteed correct — no timing games.
  //
  // Full input surface (deps marked *, refs marked →):
  //   * radiusOverrides    — the trigger (dep, reference equality)
  //   → constraintKeyRef   — which constraint to request
  //   → dataRef            — current data length for cache staleness check
  //   → simulationRef      — whether a simulation is running
  //   → phaseRef           — current scheduler phase
  //   → activeConstraintKeyRef — which constraint is currently active
  //   * cache              — position cache (dep, stable ref)
  //   * processAction      — action dispatcher (dep)
  useEffect(() => {
    if (radiusOverrides === prevRadiusOverridesRef.current) return;
    prevRadiusOverridesRef.current = radiusOverrides;

    const key = constraintKeyRef.current;
    const cachedPositions = validateCachedPositions(
      cache?.cache.get(key) ?? null,
      dataRef.current?.length ?? 0
    );
    const baseCachedPositions = cache?.cache.get('') ?? null;
    const isRunning = simulationRef.current != null && phaseRef.current === PHASE.READY;
    const activeKey = activeConstraintKeyRef.current;

    const result = onConstraintRequest(phaseRef.current, key, cachedPositions, isRunning, activeKey, baseCachedPositions);
    processAction(result.action);
  }, [radiusOverrides, constraintKeyRef, cache, processAction]);

  // Imperative API — only for explicit re-decollision (e.g. track deletion)
  const decollideForConstraint = useCallback((key) => {
    const cachedPositions = cache?.cache.get(key) ?? null;
    const baseCachedPositions = cache?.cache.get('') ?? null;
    const isRunning = simulationRef.current != null && phaseRef.current === PHASE.READY;
    const activeKey = activeConstraintKeyRef.current;
    const result = onConstraintRequest(phaseRef.current, key, cachedPositions, isRunning, activeKey, baseCachedPositions);
    processAction(result.action);
  }, [cache, processAction]);

  // ── enabled toggle ────────────────────────────────────────────────────
  // false → true: re-decollide from current raw positions.
  // true → false: cancel any running sim and snap visible positions to raw input.
  useEffect(() => {
    const prev = prevEnabledRef.current;
    prevEnabledRef.current = enabled;
    if (prev === enabled) return;

    if (!enabled) {
      cancelSimulation();
      const raw = dataRef.current;
      if (raw && raw.length > 0) {
        const snapshot = raw.map(item => ({ ...item }));
        stableOnUpdateNodes(snapshot);
        stableSyncDecollisionState(snapshot);
      }
      return;
    }

    if (dataRef.current?.length > 0) {
      launchBase();
    }
  }, [enabled, cancelSimulation, dataRef, stableOnUpdateNodes, stableSyncDecollisionState, launchBase]);

  // Cleanup on unmount
  useEffect(() => {
    return () => cancelSimulation();
  }, [cancelSimulation]);

  return {
    get phase() { return phaseRef.current; },
    get isRunning() { return simulationRef.current != null; },
    decollideForConstraint,
    cancelSimulation,
  };
}
