import { useRef, useCallback, useEffect } from 'react';
import * as d3 from 'd3';
import { PHASE, onIntermediateChange, onBaseComplete, onConstraintRequest, onColdStart } from './decollisionScheduler.js';
import { decollisioning } from './decollisioning.js';
import { useLatest } from './useLatest.js';
import { useStableCallback } from './useStableCallback.js';

/**
 * Resolve the current on-screen positions for animation "from" state.
 * Priority: live transition data (mid-simulation) > processedData (last commit) > raw data.
 */
export function resolveOnScreenData(liveData, processedData, rawData) {
  if (liveData && liveData.length > 0) return [...liveData];
  if (processedData && processedData.length > 0) return [...processedData];
  return [...(rawData || [])];
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

  const cancelSimulation = useCallback(() => {
    if (simulationRef.current) {
      simulationRef.current.stop();
      simulationRef.current = null;
      stableOnSimulationRunningChange(false);
    }
  }, [stableOnSimulationRunningChange]);

  /**
   * Build dot size function from radiusOverrides (a prop, guaranteed current).
   * For base decollision, radiusOverrides may be empty → all dots get defaultSize.
   * For constraint decollision, radiusOverrides has per-dot overrides for larger dots.
   */
  const makeDotSizeFn = useCallback((overrides) => {
    return (item) => {
      const override = overrides?.get(item.id);
      return override !== undefined ? override : (item.size || defaultSizeRef.current);
    };
  }, [defaultSizeRef]);

  /**
   * Launch a decollision simulation.
   * @param {Array} sourceData - data to decollide (caller provides, not read from dataRef)
   * @param {string} constraintKeyForLaunch - cache key for this simulation's result
   * @param {Map} overrides - radiusOverrides to use for dot sizes
   * @param {Function} onComplete - called with (finalData, constraintKey) on completion
   * @param {object} [transitionConfig] - if provided, skip intermediate frames and animate from stablePositions to final
   */
  const launchSimulation = useCallback((sourceData, constraintKeyForLaunch, overrides, onComplete, transitionConfig = null) => {
    if (!sourceData || sourceData.length === 0) return;

    cancelSimulation();

    const fnDotSize = makeDotSizeFn(overrides);
    const skipFrames = transitionConfig?.enabled === true;
    let cancelled = false;

    stableOnSimulationRunningChange(true);

    const simulation = decollisioning(
      sourceData,
      (nodes) => {
        if (!cancelled) stableOnUpdateNodes(nodes);
      },
      fnDotSize,
      (finalData) => {
        if (cancelled) return;
        simulationRef.current = null;
        stableOnSimulationRunningChange(false);
        stableSyncDecollisionState(finalData);
        onComplete(finalData, constraintKeyForLaunch);
      },
      skipFrames,
      transitionConfig,
      {
        engine: decollisionEngineRef.current,
        shouldPublishIntermediate: () => !(isDraggingRef.current || interactionActiveRef.current),
        sendMetrics: sendMetricsRef.current,
      }
    );

    simulationRef.current = simulation;
  }, [cancelSimulation, makeDotSizeFn, stableOnUpdateNodes, stableSyncDecollisionState, stableOnSimulationRunningChange, decollisionEngineRef, isDraggingRef, interactionActiveRef, sendMetricsRef]);

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
    launchSimulation([...data], '', new Map(), (finalData) => {
      if (cache) {
        cache.store('', finalData);
      }

      activeConstraintKeyRef.current = '';
      const result = onBaseComplete(queuedConstraintRef.current);
      queuedConstraintRef.current = null;
      phaseRef.current = result.phase;

      stableOnBaseReady(finalData);

      if (result.action?.type === 'launch-constraint') {
        launchConstraintRef.current?.(result.action.constraintKey);
      }
    }, transitionConfig);
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
      if (cache) {
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

  const animateFromCache = useCallback((key, positions) => {
    const data = dataRef.current;
    if (!data || data.length === 0) return;

    // Capture "from" BEFORE cancelling — liveTransitionDataRef is cleared on cancel
    const from = getOnScreenData();
    cancelSimulation();

    const target = data.map(item => {
      const pos = positions.get(item.id);
      return pos ? { ...item, x: pos.x, y: pos.y } : item;
    });

    const duration = 500;
    const ease = d3.easeCubicOut;
    let cancelled = false;

    const timer = d3.timer((elapsed) => {
      if (cancelled) { timer.stop(); return; }
      const t = Math.min(1, ease(elapsed / duration));
      const interpolated = target.map((targetItem, i) => {
        const source = from[i] || targetItem;
        return {
          ...targetItem,
          x: source.x + (targetItem.x - source.x) * t,
          y: source.y + (targetItem.y - source.y) * t,
        };
      });
      stableOnUpdateNodes(interpolated);
      if (t >= 1) {
        timer.stop();
        simulationRef.current = null;
        activeConstraintKeyRef.current = key;
        stableSyncDecollisionState(target);
        stableOnConstraintReady(target, key);
      }
    });

    simulationRef.current = {
      stop() { cancelled = true; timer.stop(); }
    };
  }, [dataRef, getOnScreenData, cancelSimulation, stableOnUpdateNodes, stableSyncDecollisionState, stableOnConstraintReady]);

  // Ref to access processAction from animateToBase completion
  const processActionRef = useRef(null);

  const animateToBase = useCallback((positions) => {
    const data = dataRef.current;
    if (!data || data.length === 0) return;

    // Capture "from" BEFORE cancelling — liveTransitionDataRef is cleared on cancel
    const from = getOnScreenData();
    cancelSimulation();

    const target = data.map(item => {
      const pos = positions.get(item.id);
      return pos ? { ...item, x: pos.x, y: pos.y } : item;
    });
    const duration = 350; // slightly faster than full animate
    const ease = d3.easeCubicOut;
    let cancelled = false;

    const timer = d3.timer((elapsed) => {
      if (cancelled) { timer.stop(); return; }
      const t = Math.min(1, ease(elapsed / duration));
      const interpolated = target.map((targetItem, i) => {
        const source = from[i] || targetItem;
        return {
          ...targetItem,
          x: source.x + (targetItem.x - source.x) * t,
          y: source.y + (targetItem.y - source.y) * t,
        };
      });
      stableOnUpdateNodes(interpolated);
      if (t >= 1) {
        timer.stop();
        simulationRef.current = null;
        activeConstraintKeyRef.current = '';
        stableSyncDecollisionState(target);

        // Now process queued constraint
        const queued = queuedConstraintRef.current;
        if (queued != null) {
          queuedConstraintRef.current = null;
          const cachedPositions = cache?.cache.get(queued) ?? null;
          const result = onConstraintRequest(phaseRef.current, queued, cachedPositions, false, '', null);
          processActionRef.current?.(result.action);
        }
      }
    });

    simulationRef.current = {
      stop() { cancelled = true; timer.stop(); }
    };
  }, [dataRef, getOnScreenData, cancelSimulation, stableOnUpdateNodes, stableSyncDecollisionState, cache]);

  // Process actions returned by the pure state machine
  const processAction = useCallback((action) => {
    if (!action) return;
    if (Array.isArray(action)) {
      action.forEach(a => processAction(a));
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
        animateFromCache(action.constraintKey, action.positions);
        break;
      case 'animate-to-base':
        animateToBase(action.positions);
        break;
      case 'cancel-base':
      case 'cancel-constraint':
        cancelSimulation();
        break;
      case 'queue-constraint':
        queuedConstraintRef.current = action.constraintKey;
        break;
    }
  }, [launchBase, launchConstraint, animateFromCache, animateToBase, cancelSimulation]);

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
  useEffect(() => {
    if (radiusOverrides === prevRadiusOverridesRef.current) return;
    prevRadiusOverridesRef.current = radiusOverrides;

    const key = constraintKeyRef.current;
    const cachedPositions = cache?.cache.get(key) ?? null;
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
