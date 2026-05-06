/**
 * Decollision work scheduler — pure logic, no React dependency.
 *
 * Separates intent (what needs to happen) from execution (when it runs).
 * The library owns base decollision timing (detects when layout settles).
 * The app owns constraint scheduling (calls decollideForConstraint when ready).
 *
 * Phase state machine:
 *
 *   AWAITING_LAYOUT  →  BASE_DECOLLISION  →  READY
 *        ↑                                      |
 *        └──── new layout update ───────────────┘
 *
 * - AWAITING_LAYOUT: External layout (e.g. UMAP) is sending intermediate positions.
 *   No decollision runs. Scheduler waits for positions to settle.
 * - BASE_DECOLLISION: Layout settled. Base decollision running (non-interruptible).
 *   Constraint requests are queued, not executed.
 * - READY: Base is cached. Idle or running constraint decollision.
 *   Constraint requests execute immediately (latest wins).
 */

export const PHASE = {
  AWAITING_LAYOUT: 'AWAITING_LAYOUT',
  BASE_DECOLLISION: 'BASE_DECOLLISION',
  READY: 'READY',
};

/**
 * Determine the next phase given a state update.
 *
 * Pure function — no side effects. Returns { phase, action } where action
 * describes what the caller should do (launch base, queue constraint, etc).
 *
 * Actions:
 * - null: no action needed
 * - { type: 'launch-base' }: start base decollision
 * - { type: 'launch-constraint', constraintKey }: start constraint decollision
 * - { type: 'animate-from-cache', constraintKey, positions }: animate to cached positions
 * - { type: 'cancel-base' }: cancel running base (layout restarted)
 * - { type: 'cancel-constraint' }: cancel running constraint (new one incoming)
 */

/**
 * Handle positionsAreIntermediate changing.
 * Called when the external layout signal changes value.
 */
export function onIntermediateChange(currentPhase, isIntermediate) {
  if (isIntermediate) {
    // Layout started (or restarted). Go to AWAITING_LAYOUT.
    // If base was running, it needs to be cancelled.
    if (currentPhase === PHASE.BASE_DECOLLISION) {
      return { phase: PHASE.AWAITING_LAYOUT, action: { type: 'cancel-base' } };
    }
    if (currentPhase === PHASE.READY) {
      return { phase: PHASE.AWAITING_LAYOUT, action: { type: 'cancel-constraint' } };
    }
    // Already awaiting — no change
    return { phase: PHASE.AWAITING_LAYOUT, action: null };
  }

  // Positions settled. If we were awaiting, start base decollision.
  if (currentPhase === PHASE.AWAITING_LAYOUT) {
    return { phase: PHASE.BASE_DECOLLISION, action: { type: 'launch-base' } };
  }

  // Already in BASE or READY — no change (shouldn't normally happen)
  return { phase: currentPhase, action: null };
}

/**
 * Handle base decollision completing.
 * Returns the next phase and any queued constraint to execute.
 */
export function onBaseComplete(queuedConstraint) {
  if (queuedConstraint != null) {
    return {
      phase: PHASE.READY,
      action: { type: 'launch-constraint', constraintKey: queuedConstraint }
    };
  }
  return { phase: PHASE.READY, action: null };
}

/**
 * Handle a constraint decollision request.
 *
 * Rule: constraint-to-constraint transitions always go through base visually.
 * Focus A → animate to base → then decollide/animate to Focus B.
 * This ensures smooth, predictable transitions instead of jarring jumps.
 *
 * @param {string} currentPhase
 * @param {string} constraintKey - the requested constraint
 * @param {Map|null} cachedPositions - exact cache hit for the requested constraint
 * @param {boolean} isConstraintRunning - whether a constraint simulation is in flight
 * @param {string} activeConstraintKey - the currently active constraint ('' = base)
 * @param {Map|null} baseCachedPositions - cached base positions (for animate-to-base)
 */
export function onConstraintRequest(currentPhase, constraintKey, cachedPositions, isConstraintRunning, activeConstraintKey = '', baseCachedPositions = null) {
  // During base decollision or layout, queue — don't execute
  if (currentPhase === PHASE.BASE_DECOLLISION || currentPhase === PHASE.AWAITING_LAYOUT) {
    return { action: { type: 'queue-constraint', constraintKey } };
  }

  // READY phase — execute

  // Constraint-to-constraint: go through base first (unless returning to base)
  const isChangingConstraint = activeConstraintKey !== '' && constraintKey !== '' && activeConstraintKey !== constraintKey;
  if (isChangingConstraint && baseCachedPositions && baseCachedPositions.size > 0) {
    const actions = [];
    if (isConstraintRunning) {
      actions.push({ type: 'cancel-constraint' });
    }
    actions.push({ type: 'animate-to-base', positions: baseCachedPositions });
    actions.push({ type: 'queue-constraint', constraintKey });
    return { action: actions };
  }

  // Direct transition (from base, or cache hit)
  if (cachedPositions && cachedPositions.size > 0) {
    const actions = [];
    if (isConstraintRunning) {
      actions.push({ type: 'cancel-constraint' });
    }
    actions.push({ type: 'animate-from-cache', constraintKey, positions: cachedPositions });
    return { action: actions.length === 1 ? actions[0] : actions };
  }

  // Empty constraint key with no cache (e.g. scope-change wipe followed by a
  // request to re-decollide the base layout) → launch-base, not launch-
  // constraint. `launchBase` builds a transitionConfig from the current
  // on-screen state, so the animation interpolates positions from where the
  // user can currently see the dots toward the freshly decollided layout —
  // sizes (carried in the data items) snap to the new value at frame 0
  // while x/y animate. `launchConstraint` has no transitionConfig and would
  // fire raw simulation ticks instead, producing a rougher visual.
  if (constraintKey === '') {
    const actions = [];
    if (isConstraintRunning) {
      actions.push({ type: 'cancel-constraint' });
    }
    actions.push({ type: 'launch-base' });
    return { action: actions.length === 1 ? actions[0] : actions };
  }

  const actions = [];
  if (isConstraintRunning) {
    actions.push({ type: 'cancel-constraint' });
  }
  actions.push({ type: 'launch-constraint', constraintKey });
  return { action: actions.length === 1 ? actions[0] : actions };
}

/**
 * Handle constraint decollision completing.
 * Phase stays READY. No state change needed.
 */
export function onConstraintComplete() {
  return { phase: PHASE.READY, action: null };
}

/**
 * Handle cold start — component mounts with already-settled data.
 * positionsAreIntermediate was never true, so there's no transition to detect.
 */
export function onColdStart(hasData, positionsAreIntermediate) {
  if (hasData && !positionsAreIntermediate) {
    return { phase: PHASE.BASE_DECOLLISION, action: { type: 'launch-base' } };
  }
  if (hasData && positionsAreIntermediate) {
    return { phase: PHASE.AWAITING_LAYOUT, action: null };
  }
  return { phase: PHASE.AWAITING_LAYOUT, action: null };
}
