export interface DotData {
  id: string | number;
  x: number;
  y: number;
  cluster?: string | number;
  color?: string;
  size?: number;
  opacity?: number;
  [key: string]: any;
}

export type ImageProvider = (id: string | number, visibleDotCount?: number) => string | undefined;

export interface EdgeData {
  id: string | number;
  source: string | number;
  target: string | number;
  [key: string]: any;
}

export interface ClusterInfo {
  id: string | number;
  label: string;
  color?: string;
  [key: string]: any;
}

// Pulse animation configuration
export interface PulseConfig {
  duration?: number;     // pulse cycle duration in ms (default: 1800)
  sizeRange?: number;    // size multiplier range (default: 0.3 = 30% larger)
  opacityRange?: number; // opacity variation (default: 0 = no opacity change)
  pulseColor?: string;   // target color to pulse toward (interpolated with base color)
  ringEffect?: boolean;  // use pulsating ring effect instead of size/color pulse
}

// Base style properties combining static styles and effects
export interface DotStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  'stroke-width'?: number; // kebab-case variant for compatibility
  opacity?: number;
  r?: number; // SVG radius attribute
  pulse?: PulseConfig;   // pulse animation effect
}

// The dotStyles prop type
export type DotStylesMap = Map<string | number, DotStyle>;

export interface DotVisualizationProps {
  data?: DotData[];
  edges?: EdgeData[];
  clusters?: ClusterInfo[];
  clusterKey?: (item: DotData) => string | number;
  renderCluster?: (cluster: ClusterInfo) => React.ReactNode;
  hoveredCluster?: string | number;
  onClusterHover?: (cluster: ClusterInfo | null) => void;
  onClusterLeave?: (cluster: ClusterInfo | null) => void;
  onHover?: (item: DotData | null, event?: MouseEvent) => void;
  onLeave?: (item: DotData | null, event?: MouseEvent) => void;
  onClick?: (item: DotData, event?: MouseEvent) => void;
  onBackgroundClick?: (event?: MouseEvent) => void;
  onDragStart?: (item: DotData, event?: MouseEvent) => void;
  dragIcon?: React.ReactNode;
  onZoomStart?: (event?: any) => void;
  onZoomEnd?: (event?: any) => void;
  onDecollisionComplete?: () => void;
  enableDecollisioning?: boolean;
  enablePositionTransitions?: boolean;
  transitionDuration?: number;
  frameRate?: number;
  positionsAreIntermediate?: boolean;
  zoomExtent?: [number, number];
  margin?: number;
  dotStroke?: string;
  dotStrokeWidth?: number;
  defaultColor?: string | null;
  defaultSize?: number;
  defaultOpacity?: number;
  dotStyles?: DotStylesMap;
  useImages?: boolean;
  imageProvider?: ImageProvider;
  hoverImageProvider?: ImageProvider;
  edgeOpacity?: number;
  edgeColor?: string;
  className?: string;
  style?: React.CSSProperties;
  occludeLeft?: number;
  occludeRight?: number;
  occludeTop?: number;
  occludeBottom?: number;
  autoFitToVisible?: boolean;
  fitMargin?: number;
  autoZoomToNewContent?: boolean;
  autoZoomDuration?: number;
  hoverSizeMultiplier?: number;
  hoverOpacity?: number;
  useCanvas?: boolean;
  debug?: boolean;
}

export interface ColoredDotsProps {
  data?: DotData[];
  dotId?: (layer: number, item: DotData) => string;
  stroke?: string;
  strokeWidth?: number;
  defaultColor?: string | null;
  defaultSize?: number;
  defaultOpacity?: number;
  dotStyles?: DotStylesMap;
  hoveredDotId?: string | number | null;
  hoverSizeMultiplier?: number;
  hoverOpacity?: number;
  useImages?: boolean;
  imageProvider?: ImageProvider;
  hoverImageProvider?: ImageProvider;
  visibleDotCount?: number | null;
  useCanvas?: boolean;
  zoomTransform?: any; // d3.ZoomTransform
  effectiveViewBox?: [number, number, number, number] | null;
  debug?: boolean;
  onHover?: (item: DotData | null, event?: MouseEvent) => void;
  onLeave?: (item: DotData | null, event?: MouseEvent) => void;
  onClick?: (item: DotData, event?: MouseEvent) => void;
  onBackgroundClick?: (event?: MouseEvent) => void;
  onMouseDown?: (item: DotData, event?: MouseEvent) => void;
  onMouseUp?: (item: DotData, event?: MouseEvent) => void;
  onDoubleClick?: (item: DotData, event?: MouseEvent) => void;
  onContextMenu?: (item: DotData, event?: MouseEvent) => void;
  onDragStart?: (item: DotData, event?: MouseEvent) => void;
  isZooming?: boolean;
}

export interface InteractionLayerProps {
  data?: DotData[];
  dotId?: (layer: number, item: DotData) => string;
  onHover?: (item: DotData | null, event?: MouseEvent) => void;
  onLeave?: (item: DotData | null, event?: MouseEvent) => void;
  onClick?: (item: DotData, event?: MouseEvent) => void;
  onBackgroundClick?: (event?: MouseEvent) => void;
  onDragStart?: (item: DotData, event?: MouseEvent) => void;
  isZooming?: boolean;
  defaultSize?: number;
  dotStyles?: DotStylesMap;
  hoveredDotId?: string | number | null;
  hoverSizeMultiplier?: number;
  debug?: boolean;
}

export interface ClusterLabelsProps {
  data?: DotData[];
  clusters?: ClusterInfo[];
  clusterKey?: (item: DotData) => string | number;
  renderCluster?: (cluster: ClusterInfo) => React.ReactNode;
  hoveredCluster?: string | number;
  onClusterHover?: (cluster: ClusterInfo | null) => void;
  onClusterLeave?: (cluster: ClusterInfo | null) => void;
  debug?: boolean;
}

export interface EdgeLayerProps {
  edges?: EdgeData[];
  data?: DotData[];
  edgeOpacity?: number;
  edgeColor?: string;
  strokeWidth?: number;
  debug?: boolean;
}