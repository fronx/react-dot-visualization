import React from 'react';

export interface DotVisualizationProps {
  data?: any[];
  edges?: any[];
  clusters?: any[];
  clusterKey?: (item: any) => any;
  renderCluster?: any;
  hoveredCluster?: any;
  onClusterHover?: (cluster: any) => void;
  onClusterLeave?: () => void;
  onHover?: (node: any) => void;
  onLeave?: () => void;
  onClick?: (node: any, event?: MouseEvent) => void;
  onBackgroundClick?: () => void;
  onDragStart?: (node: any) => void;
  dragIcon?: any;
  onZoomStart?: () => void;
  isIncrementalUpdate?: boolean;
  transitionDuration?: number;
  transitionEasing?: (t: number) => number;
  style?: React.CSSProperties;
  [key: string]: any;
}

export interface DotVisualizationRef {
  zoomToVisible: (duration?: number, easing?: any, dataOverride?: any[], marginOverride?: number | null, updateExtents?: boolean) => Promise<boolean>;
  getVisibleDotCount: () => number;
  updateVisibleDotCount: () => void;
  getZoomTransform: () => any;
  cancelDecollision: () => void;
  getCurrentPositions: () => Array<{ id: string | number; x: number; y: number }>;
}

declare const DotVisualization: React.ForwardRefExoticComponent<DotVisualizationProps & React.RefAttributes<DotVisualizationRef>>;

export default DotVisualization;