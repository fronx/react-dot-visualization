export interface DotData {
  id: string | number;
  x: number;
  y: number;
  cluster?: string | number;
  [key: string]: any;
}

export type ImageProvider = (id: string | number) => string | undefined;

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

export interface DotVisualizationProps {
  dots: DotData[];
  edges?: EdgeData[];
  clusters?: ClusterInfo[];
  width?: number;
  height?: number;
  dotRadius?: number;
  onDotHover?: (dot: DotData | null) => void;
  onDotClick?: (dot: DotData) => void;
  colorScale?: (cluster: string | number) => string;
  showLabels?: boolean;
  enableZoom?: boolean;
  enablePan?: boolean;
  className?: string;
  style?: React.CSSProperties;
  imageProvider?: ImageProvider;
  hoverImageProvider?: ImageProvider;
  useImages?: boolean;
}

export interface ColoredDotsProps {
  dots: DotData[];
  dotRadius?: number;
  colorScale?: (cluster: string | number) => string;
  onDotHover?: (dot: DotData | null) => void;
  onDotClick?: (dot: DotData) => void;
  imageProvider?: ImageProvider;
  hoverImageProvider?: ImageProvider;
  useImages?: boolean;
}

export interface InteractionLayerProps {
  dots: DotData[];
  dotRadius?: number;
  onDotHover?: (dot: DotData | null) => void;
  onDotClick?: (dot: DotData) => void;
}

export interface ClusterLabelsProps {
  clusters: ClusterInfo[];
  dots: DotData[];
}

export interface EdgeLayerProps {
  edges: EdgeData[];
  dots: DotData[];
  strokeWidth?: number;
  strokeColor?: string;
}