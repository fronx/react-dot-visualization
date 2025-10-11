import { useRef, useEffect } from 'react';

/**
 * Returns a ref that always contains the latest value without triggering re-renders or effect re-runs.
 *
 * Useful when you need access to current props/state inside callbacks or effects without
 * adding them to dependency arrays (which would cause unwanted re-runs).
 *
 * @param {*} value - The value to keep updated in the ref
 * @returns {React.MutableRefObject} A ref containing the latest value
 *
 * @example
 * const dotStylesRef = useLatest(dotStyles);
 * // Later, in a callback or effect:
 * const currentStyles = dotStylesRef.current;
 */
export function useLatest(value) {
  const ref = useRef(value);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref;
}
