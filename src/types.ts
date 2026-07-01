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
  pulseInward?: boolean; // pulse inward (shrink) instead of outward (grow) (default: false)
  ringTargetPixels?: number;   // max ring size in pixels for small dots (default: 50px)
  ringMinRatio?: number;       // minimum ring size ratio for large dots (default: 2.0 = 2x dot radius)
}

// Base style properties combining static styles and effects
export interface DotStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  strokeDasharray?: number[]; // Canvas setLineDash pattern (e.g., [3, 3] for dashed)
  'stroke-width'?: number; // kebab-case variant for compatibility
  opacity?: number;
  r?: number; // SVG radius attribute
  pulse?: PulseConfig;   // pulse animation effect
  hoverSizeMultiplier?: number; // per-dot hover size multiplier override
  focusRing?: boolean; // R3F: render as the built-in inner+outer-ring focus visual
}

// The dotStyles prop type
export type DotStylesMap = Map<string | number, DotStyle>;

// ── Imperative handle ───────────────────────────────────────────────────────

/**
 * D3-compatible zoom transform: `{x, y, k}` in viewBox space
 * (`[0, 0, 100 * aspect, 100]`). Both renderers exchange transforms in this
 * shape through the imperative handle; a `d3.ZoomTransform` satisfies it
 * structurally.
 */
export interface ZoomTransformLike {
  x: number;
  y: number;
  k: number;
}

export interface DotPosition {
  id: string | number;
  x: number;
  y: number;
}

/**
 * Imperative API exposed via `ref` by both `DotVisualization` (Canvas/SVG)
 * and `DotVisualizationR3F` (WebGL/WebGPU).
 */
export interface DotVisualizationRef {
  /**
   * Fit the (optionally overridden) data into the visible region, honoring
   * `occludeLeft/Right/Top/Bottom`. Resolves `true` when a fit was computed
   * and applied.
   */
  zoomToVisible: (
    duration?: number,
    easing?: (t: number) => number,
    dataOverride?: DotData[] | null,
    marginOverride?: number | null,
    updateExtents?: boolean,
    maxScale?: number,
  ) => Promise<boolean>;
  /** Compute (without applying) the occlusion-aware fit transform. */
  getFitTransform: (
    dataOverride?: DotData[] | null,
    marginOverride?: number | null,
  ) => ZoomTransformLike | null;
  /** Current transform in viewBox space (null/undefined before zoom setup). */
  getZoomTransform: () => ZoomTransformLike | null | undefined;
  /**
   * Apply a viewBox-space transform. In the Canvas renderer
   * `options.direct` (default `true`) bypasses the d3 zoom handler; the R3F
   * renderer sets the camera directly and ignores the option.
   */
  setZoomTransform: (
    transform: ZoomTransformLike,
    options?: { direct?: boolean },
  ) => boolean;
  getVisibleDotCount: () => number;
  updateVisibleDotCount: () => void;
  /** Cancel any in-flight decollision simulation. */
  cancelDecollision: () => void;
  /**
   * Current (possibly mid-decollision) positions. R3F returns the full data
   * items; Canvas returns bare `{id, x, y}` records.
   */
  getCurrentPositions: () => DotPosition[];
  /** Canvas renderer only: kick a decollision pass for a constraint key. */
  decollideForConstraint?: (constraintKey: string) => void;
  /** Canvas renderer only: current decollision-scheduler phase. */
  getSchedulerPhase?: () => string | undefined;
}

// ── Shared props ────────────────────────────────────────────────────────────

/**
 * Structural type of the constraint-keyed decollision position-cache manager
 * returned by `useDecollisionCache()`. Passed as `sharedPositionCache` so
 * decollided layouts survive renderer remounts and hot reloads.
 */
export interface SharedPositionCache {
  cache: {
    get(constraintKey: string): Map<string | number, { x: number; y: number }> | null;
    store(constraintKey: string, positions: Map<string | number, { x: number; y: number }>): void;
    clear(): void;
  };
  resolve(scopeKey: string, constraintKey: string): {
    positions: Map<string | number, { x: number; y: number }> | null;
    source: 'exact' | 'base-fallback' | 'fresh' | 'unchanged';
  };
  store(constraintKey: string, positions: Map<string | number, { x: number; y: number }>): void;
  checkScope(scopeKey: string): boolean;
}

/**
 * Canvas-only per-dot paint override. Return `true` to skip the default dot
 * rendering for the item.
 */
export type CustomDotRenderer = (
  ctx: CanvasRenderingContext2D,
  item: DotData,
  styles: DotStyle & { fill?: string; opacity?: number },
  extras: {
    radius: number;
    pulseData?: unknown;
    isHovered?: boolean;
    zoomScale?: number;
    viewBoxScale?: number;
    canvasDPR?: number;
  },
) => boolean | void;

/**
 * Props accepted by both renderers (`DotVisualization` and
 * `DotVisualizationR3F`). Renderer-specific props live on the extending
 * interfaces below.
 */
export interface DotVisualizationCommonProps {
  data?: DotData[];
  edges?: EdgeData[];
  dotStyles?: DotStylesMap;
  defaultColor?: string | null;
  defaultSize?: number;
  defaultOpacity?: number;
  dotStroke?: string;
  /** Stroke thickness as a fraction of dot radius (0-1), e.g. 0.05 = 5%. */
  dotStrokeWidthFraction?: number | null;
  hoverSizeMultiplier?: number;
  hoverOpacity?: number;
  edgeColor?: string;
  edgeOpacity?: number;
  /**
   * Per-id physical radius for the decollision simulation (and rendered dot
   * size). A new Map reference triggers the scheduler to re-decollide.
   */
  radiusOverrides?: Map<string | number, number>;
  /** Constraint-keyed decollision cache, shared across renderer mounts. */
  sharedPositionCache?: SharedPositionCache | null;
  /** Cache scope (dataset identity). Changing it invalidates cached layouts. */
  scopeKey?: string;
  /** Decollision cache key for the active constraint. `''` = base. */
  constraintKey?: string;
  enableDecollisioning?: boolean;
  /** Decollision backend. `'auto'` prefers WebGPU when available. */
  decollisionEngine?: 'auto' | 'webgpu' | 'cpu';
  isIncrementalUpdate?: boolean;
  /**
   * True while a layout is still emitting intermediate positions; holds the
   * decollision scheduler until positions settle.
   */
  positionsAreIntermediate?: boolean;
  transitionDuration?: number;
  transitionEasing?: (t: number) => number;
  /** ViewBox-space transform honored on first paint. */
  initialTransform?: ZoomTransformLike | null;
  occludeLeft?: number;
  occludeRight?: number;
  occludeTop?: number;
  occludeBottom?: number;
  /** Suppress hover acquisition while the camera is being panned/zoomed. */
  blockHoverDuringInteraction?: boolean;
  onHover?: (item: DotData | null, event?: MouseEvent) => void;
  onLeave?: (item: DotData | null, event?: MouseEvent | null) => void;
  onClick?: (item: DotData, event?: MouseEvent) => void;
  onContextMenu?: (item: DotData, event?: MouseEvent) => void;
  onBackgroundClick?: (event?: MouseEvent) => void;
  onDragStart?: (item: DotData, event?: MouseEvent) => void;
  /**
   * Fires when a decollision simulation settles (both the initial base layout
   * and each constraint), including the animate-from-cache path. Receives the
   * just-settled positions.
   */
  onDecollisionComplete?: (data?: DotData[]) => void;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

export interface DotVisualizationProps extends DotVisualizationCommonProps {
  clusters?: ClusterInfo[];
  clusterKey?: (item: DotData) => string | number;
  renderCluster?: (cluster: ClusterInfo) => React.ReactNode;
  hoveredCluster?: string | number;
  onClusterHover?: (cluster: ClusterInfo | null) => void;
  onClusterLeave?: (cluster: ClusterInfo | null) => void;
  dragIcon?: React.ReactNode;
  onZoomStart?: (event?: any) => void;
  onZoomEnd?: (event?: any) => void;
  zoomExtent?: [number, number];
  margin?: number;
  /** Stroke width in world units (see also `dotStrokeWidthFraction`). */
  dotStrokeWidth?: number;
  useImages?: boolean;
  imageProvider?: ImageProvider;
  hoverImageProvider?: ImageProvider;
  /** Canvas-only paint override per dot. */
  customDotRenderer?: CustomDotRenderer | null;
  autoFitToVisible?: boolean;
  fitMargin?: number;
  autoZoomToNewContent?: boolean;
  autoZoomDuration?: number;
  useCanvas?: boolean;
  /** Composite pan/zoom gestures as a CSS transform of the last bitmap. */
  gpuPanZoom?: boolean;
  /** Over-render margin (in viewport fractions) supporting `gpuPanZoom`. */
  renderMargin?: number;
  /** Cancel the pulse rAF entirely during pan/zoom gestures. */
  pausePulseDuringInteraction?: boolean;
  sendMetrics?: boolean;
  viewBoxSmoothingR?: number;
  viewBoxSmoothingQ?: number;
  viewBoxTransitionDuration?: number;
  backgroundChildren?: React.ReactNode;
  foregroundChildren?: React.ReactNode;
  debug?: boolean;
}

// ── R3F renderer props ──────────────────────────────────────────────────────

/** Streamed position updates applied GPU-side (WebGPU backend). */
export interface StreamingPositions {
  coords: Float32Array | null;
  coordIndices?: Int32Array;
  hideUnseen?: boolean;
  transform?: { xScale?: number; xOffset?: number; yScale?: number; yOffset?: number };
  onApplied?: () => void;
  version?: number;
}

/** WebGPU-only semantic paint buffer: scores parallel to `data`; entries
 *  below zero keep the normal dot color. */
export interface SemanticScoresInput {
  scores: Float32Array;
  range: { lo: number; hi: number };
  dimColor?: [number, number, number];
  hotColor?: [number, number, number];
}

/** WebGPU-only renderer-resident semantic scorer input. While active, the dot
 *  layer scores the resident matrix in-shader and ignores `semanticScores`. */
export interface SemanticGpuScoringOptions {
  matrixKey?: string | null;
  matrix?: Float32Array;
  matrixF16?: Uint16Array;
  matrixF16Packed?: Uint32Array;
  matrixF16PackedChunks?: Array<{ baseRow: number; rowCount: number; matrixF16Packed: Uint32Array }>;
  dims: number;
  query: Float32Array;
  filenameMatches?: Uint8Array;
  matrixRowIndices?: Uint32Array;
  semanticDisableMask?: Uint8Array | Uint32Array;
  disableBelowThreshold?: boolean;
  threshold: number;
  range: { lo: number; hi: number };
  matchedScoreThreshold?: number;
  combine?: {
    cosineCeiling?: number;
    filenameAlpha?: number;
    curveGamma?: number;
  };
  dimColor?: [number, number, number];
  hotColor?: [number, number, number];
  debug?: boolean;
  onResourcesReady?: (event: { matrixKey: string | null; count: number; dims: number }) => void;
  onResourcesDisposed?: (event: { matrixKey: string | null; count: number; dims: number }) => void;
  onSummary?: (summary: {
    dispatchId: number;
    count: number;
    histogram: Uint32Array;
    maxScore: number;
    bucketCount: number;
    readbackMs: number;
  }) => void;
  onMatchedScores?: (matched: {
    dispatchId: number;
    scoreDispatchId: number;
    count: number;
    threshold: number;
    fixedScores: Uint32Array;
    scale: number;
    readbackMs: number;
    ids?: readonly (string | number)[];
  }) => void;
}

export interface DotVisualizationR3FProps extends DotVisualizationCommonProps {
  /** Render backend. `'webgl'` (default) is the instanced-mesh path;
   *  `'webgpu'` is the GPU-resident renderer. */
  backend?: 'webgl' | 'webgpu';
  dataKey?: string | null;
  streamingPositions?: StreamingPositions | null;
  showEdges?: boolean;
  semanticScores?: SemanticScoresInput | null;
  semanticGpuScoring?: SemanticGpuScoringOptions | null;
  /** Fires when the settled positions have been applied visually (WebGPU). */
  onDecollisionVisualComplete?: (info: { count: number; reason: string; jobId: number }) => void;
  /** R3F render-loop mode for the WebGPU Canvas. */
  frameloop?: 'always' | 'demand' | 'never';
  /** WebGPU-only: solver iterations submitted per rendered frame. */
  webgpuSolverIterationsPerFrame?: number;
  /** WebGPU-only: soft CPU submit budget per decollision frame (ms). */
  webgpuSolverFrameBudgetMs?: number;
  /** WebGPU-only: base solves stop at the visual minimum iteration count
   *  instead of reading back a convergence metric. */
  webgpuBaseFixedIterations?: boolean;
  /** WebGPU-only: emit decollision timing diagnostics to the console. */
  webgpuDecollisionDebug?: boolean;
  /** In-scene R3F content rendered inside the Canvas (e.g. ClusterLabels3D). */
  sceneChildren?: React.ReactNode;
}

// ── ClusterLabels3D ─────────────────────────────────────────────────────────

/**
 * Result of a `createTextGeometry` call. `geometry` is a three.js
 * `BufferGeometry`; typed as `unknown` here so canvas-only consumers don't
 * need three's types on their compile path.
 */
export interface ClusterLabelTextGeometry {
  geometry: unknown;
  planeBounds: {
    min: { x: number; y: number };
    max: { x: number; y: number };
  };
}

export type CreateClusterLabelTextGeometry = (
  text: string,
  options: { size: number },
) => ClusterLabelTextGeometry | Promise<ClusterLabelTextGeometry>;

export interface ClusterLabelDatum {
  id: string | number;
  /** Data-space anchor; a label given a dot's (x, y) lands on that dot. */
  x: number;
  y: number;
  text: string;
  fontSize?: number;
  color?: string;
  opacity?: number;
}

/** Props for the `ClusterLabels3D` in-scene caption layer (WebGPU backend),
 *  passed via `DotVisualizationR3F`'s `sceneChildren`. */
export interface ClusterLabels3DProps {
  clusters?: ReadonlyArray<ClusterLabelDatum>;
  /** Injected text-geometry builder (e.g. backed by three-text). */
  createTextGeometry: CreateClusterLabelTextGeometry;
  fontSize?: number;
  /** Screen-size floor in px; `<= 0` keeps each label at its world size. */
  minScreenPx?: number;
  /** Zoom fade: maps `camera.position.z` to opacity (see `makeZoomFade`). */
  fadeOpacity?: (cameraZ: number) => number;
  labelZ?: number;
  defaultColor?: string;
  shadowColor?: string;
  shadowStrength?: number;
  onClusterClick?: (id: string | number) => void;
  onClusterHover?: (id: string | number | null) => void;
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