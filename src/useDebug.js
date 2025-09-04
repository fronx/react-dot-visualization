import { useCallback } from 'react';

export const useDebug = (enabled = false) => {
  return useCallback((...args) => {
    if (enabled) {
      console.log(...args);
    }
  }, [enabled]);
};