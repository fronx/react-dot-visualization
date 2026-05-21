import { useRef } from 'react';
import { createHoverDispatcher } from './hoverDispatch.js';

/**
 * React binding for `createHoverDispatcher`. Returns one stable dispatcher
 * instance (so its prev-hover state survives re-renders) while always invoking
 * the latest callbacks: the callbacks object's fields are updated in place
 * rather than replaced, so the reference the dispatcher captured stays valid.
 */
export function useHoverDispatcher(callbacks) {
  const callbacksRef = useRef({});
  Object.assign(callbacksRef.current, callbacks);
  const dispatcherRef = useRef(null);
  if (!dispatcherRef.current) {
    dispatcherRef.current = createHoverDispatcher(callbacksRef.current);
  }
  return dispatcherRef.current;
}
