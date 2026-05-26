// Public surface for the package — the index advertises every renderer the
// library offers (canvas / R3F / Sigma) so consumers can pick from a menu.
//
// The R3F and Sigma renderers are wrapped in `React.lazy` so they don't get
// fetched + evaluated at module-evaluation time. Without this, every consumer
// of `react-dot-visualization` (even canvas-only ones) drags in the full
// three.js + @react-three/fiber + zustand chain — Vite dev doesn't tree-shake
// at module level. Consumers using `<DotVisualizationR3F />` or
// `<DotVisualizationSigma />` need a `<Suspense>` ancestor to handle the
// brief load while the chunk is fetched.
import { lazy } from 'react';

export { default as DotVisualization } from './DotVisualization.jsx';
export const DotVisualizationR3F = lazy(() => import('./r3f/DotVisualizationR3F.jsx'));
// In-scene cluster captions for the R3F renderer (passed via DotVisualizationR3F's
// `sceneChildren`). Lazy like the renderer so three isn't pulled into canvas-only
// consumers; the pure fade helpers (no three import) are safe to export directly.
export const ClusterLabels3D = lazy(() => import('./r3f/ClusterLabels3D.jsx'));
export { smoothstep, makeZoomFade, clamp01 } from './r3f/labelFade.js';
export const DotVisualizationSigma = lazy(() => import('./DotVisualizationSigma.jsx'));
export { default as ColoredDots } from './ColoredDots.jsx';
export { default as InteractionLayer } from './InteractionLayer.jsx';
export { default as ClusterLabels } from './ClusterLabels.jsx';
export { default as RegionLabels } from './RegionLabels.jsx';
export * from './utils.js';
export * from './types';
export { useFrameBudget, createFrameBudget } from './useFrameBudget.js';
export { useCache } from './useCache.js';
export { useSharedPositionCache } from './useSharedPositionCache.js';
export { useDecollisionCache } from './useDecollisionCache.js';
export { PHASE as DECOLLISION_PHASE } from './decollisionScheduler.js';
export { calculateAdaptiveRingRadius } from './pulseRingUtils.js';
export { decollisioning } from './decollisioning.js';
