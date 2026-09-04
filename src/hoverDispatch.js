/**
 * Shared hover/leave state machine for both renderers (the Canvas path's
 * `useCanvasInteractions` and the R3F path's `HoverDetector`). It emits one
 * canonical contract:
 *
 *   onHover(item)  — entered a dot
 *   onLeave(item)  — left a dot but is still inside the rendering zone
 *   onLeave(null)  — left the rendering zone entirely
 *
 * The per-dot/zone distinction is the point: a consumer can treat
 * `onLeave(null)` as "pointer gone" and ignore the `onLeave(item)` that fires
 * constantly during a sweep. The two render paths previously reimplemented
 * this and drifted — R3F collapsed "left a dot, still inside" into
 * `onLeave(null)`, so a consumer reverting on zone-leave reverted on every
 * gap-crossing.
 *
 * `onHoverRest(item)` — the pointer came to rest on the last dot it entered:
 * nearly still over it, on it for `restMs` (time beside it does not count), or
 * still for `restMs` in the empty space beside it. Fires at most once per dot entered; a consumer treats it as
 * intent, where a hover alone is a pass-through.
 *
 * `onHoveredIdChange(id | null)` tracks the hovered id for visual state.
 * `event` is forwarded opaquely to onHover/onLeave (Canvas supplies the DOM
 * event; R3F, raycasting on a batched rAF, omits it). React hosts bind this to
 * live callbacks via `useHoverDispatcher`.
 */
/**
 * `options.restMs` (a number or a getter, read per hover) arms a dwell timer at
 * each hover-in: staying on the same dot that long counts as rest whether or
 * not the pointer moves. The timer lives here, not in a React effect, so an
 * effect re-run (camera change, pick channel swap) cannot cancel a dwell in
 * progress — that exact miss cost a live probe on 2026-09-04. `options.timers`
 * injects setTimeout/clearTimeout/now for tests.
 */
export function createHoverDispatcher(callbacks, options = {}) {
  const timers = options.timers ?? globalThis;
  const restMsOf = typeof options.restMs === 'function' ? options.restMs : () => options.restMs ?? 0;
  let prevItem = null;
  // The rest candidate is the last dot entered. It survives drifting into the
  // empty space beside it (a consumer keeps showing and playing that dot), and
  // is replaced only by another dot or cleared by leaving the zone.
  let candidate = null;
  let rested = false;
  let restTimer = null;
  // Dwell counts only time ON the candidate: it pauses in the empty space
  // beside the dot and resumes on re-entry, so a slow brush across sparse dots
  // does not accumulate a rest while the pointer is between them.
  let dwellRemainingMs = 0;
  let dwellStartedAt = 0;

  const clearRestTimer = () => {
    if (restTimer !== null) timers.clearTimeout(restTimer);
    restTimer = null;
  };

  const rest = (event) => {
    if (!candidate || rested) return;
    rested = true;
    callbacks.onHoverRest?.(candidate, event);
  };

  const resumeDwell = (event) => {
    if (rested || dwellRemainingMs <= 0) return;
    const armedFor = candidate;
    dwellStartedAt = timers.now ? timers.now() : Date.now();
    restTimer = timers.setTimeout(() => {
      restTimer = null;
      dwellRemainingMs = 0;
      if (candidate === armedFor) rest(event);
    }, dwellRemainingMs);
  };

  const pauseDwell = () => {
    if (restTimer === null) return;
    clearRestTimer();
    const now = timers.now ? timers.now() : Date.now();
    dwellRemainingMs = Math.max(0, dwellRemainingMs - (now - dwellStartedAt));
  };

  // Off the dot but beside it, a pointer that goes still for restMs also rests
  // on the candidate (the consumer is still showing and playing it). Armed per
  // pointer move only while a not-yet-rested candidate is off-dot.
  let stillTimer = null;
  const clearStillTimer = () => {
    if (stillTimer !== null) timers.clearTimeout(stillTimer);
    stillTimer = null;
  };
  const pointerMoved = (event) => {
    clearStillTimer();
    if (!candidate || rested || prevItem !== null) return;
    const restMs = restMsOf();
    if (restMs <= 0) return;
    const armedFor = candidate;
    stillTimer = timers.setTimeout(() => {
      stillTimer = null;
      if (candidate === armedFor && prevItem === null) rest(event);
    }, restMs);
  };

  const setCandidate = (item, event) => {
    candidate = item;
    rested = false;
    clearRestTimer();
    dwellRemainingMs = item ? restMsOf() : 0;
    resumeDwell(event);
  };

  const setHovered = (item, event) => {
    const id = item?.id ?? null;
    const prevId = prevItem?.id ?? null;
    if (id === prevId) return;
    const left = prevItem;
    prevItem = item ?? null;
    if (item === candidate) resumeDwell(event);
    else if (item) setCandidate(item, event);
    else {
      // Going off-dot arms the stillness rule at once: a late pick can read
      // empty space under a pointer that has already stopped, and no further
      // move will come to arm it.
      pauseDwell();
      pointerMoved(event);
    }
    if (item) clearStillTimer();
    callbacks.onHoveredIdChange?.(id);
    if (left) callbacks.onLeave?.(left, event);
    if (item) callbacks.onHover?.(item, event);
  };

  return {
    move(item, event) {
      setHovered(item ?? null, event);
    },
    /** The pointer is at rest on (or just beside) the candidate dot; idempotent per candidate. */
    rest,
    get hovered() {
      return prevItem;
    },
    /** The last dot entered, kept through the empty space beside it. */
    get restCandidate() {
      return candidate;
    },
    /** A raw pointer move (before the pick resolves); drives the off-dot stillness rule. */
    pointerMoved,
    leaveZone(event) {
      clearStillTimer();
      setCandidate(null, event);
      prevItem = null;
      callbacks.onHoveredIdChange?.(null);
      callbacks.onLeave?.(null, event);
    },
  };
}
