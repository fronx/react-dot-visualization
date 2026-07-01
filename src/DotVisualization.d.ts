import React from 'react';
import type {
  DotVisualizationProps as DotVisualizationStrictProps,
  DotVisualizationRef,
} from './types';

export type { DotVisualizationRef };

// Historically this declaration was fully permissive (`[key: string]: any`).
// The strict prop surface now lives in ./types (DotVisualizationProps); the
// index signature is kept so existing consumers passing extra props don't
// break.
export interface DotVisualizationProps extends DotVisualizationStrictProps {
  [key: string]: any;
}

declare const DotVisualization: React.ForwardRefExoticComponent<DotVisualizationProps & React.RefAttributes<DotVisualizationRef>>;

export default DotVisualization;
