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
 * `onHoveredIdChange(id | null)` tracks the hovered id for visual state.
 * `event` is forwarded opaquely to onHover/onLeave (Canvas supplies the DOM
 * event; R3F, raycasting on a batched rAF, omits it). React hosts bind this to
 * live callbacks via `useHoverDispatcher`.
 */
export function createHoverDispatcher(callbacks) {
  let prevItem = null;

  const setHovered = (item, event) => {
    const id = item?.id ?? null;
    const prevId = prevItem?.id ?? null;
    if (id === prevId) return;
    const left = prevItem;
    prevItem = item ?? null;
    callbacks.onHoveredIdChange?.(id);
    if (left) callbacks.onLeave?.(left, event);
    if (item) callbacks.onHover?.(item, event);
  };

  return {
    move(item, event) {
      setHovered(item ?? null, event);
    },
    leaveZone(event) {
      prevItem = null;
      callbacks.onHoveredIdChange?.(null);
      callbacks.onLeave?.(null, event);
    },
  };
}
