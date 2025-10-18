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
  onClick?: (node: any) => void;
  onBackgroundClick?: () => void;
  onDragStart?: (node: any) => void;
  dragIcon?: any;
  onZoomStart?: () => void;
  style?: React.CSSProperties;
  [key: string]: any;
}

export interface DotVisualizationRef {
  zoomToVisible: (duration?: number, easing?: any, dataOverride?: any[], marginOverride?: number | null, updateExtents?: boolean) => Promise<boolean>;
  getVisibleDotCount: () => number;
  updateVisibleDotCount: () => void;
  getZoomTransform: () => any;
}

declare const DotVisualization: React.ForwardRefExoticComponent<DotVisualizationProps & React.RefAttributes<DotVisualizationRef>>;

export default DotVisualization;