# Three.js Renderer Plan

Replace the SVG/Canvas 2D rendering in react-dot-visualization with a Three.js (WebGL) instanced mesh renderer, matching the current visual appearance exactly.

## Context

### Current renderer (react-dot-visualization)
- SVG circles (default) or Canvas 2D (`useCanvas=true`)
- Flat colored circles with theme-aware stroke outlines
- Pulse animations (size/opacity/color sine wave + ring effects)
- Pan/zoom via D3 zoom behavior
- Hover via invisible SVG circles or spatial hash grid (canvas mode)
- Decollision via D3 force simulation
- Text labels via `RegionLabels.jsx`

### Target renderer (catalog-viz / vibseek)
- Three.js + react-three-fiber with `InstancedMesh` (single draw call for all dots)
- Custom bevel/dome fragment shader: hemisphere lighting gives dots 3D appearance (bright center, dark edges via diffuse lighting)
- Camera controller with zoom-to-cursor math
- Raycasting hover detection (cursor ray -> Z=0 plane -> nearest dot)

### Text rendering (semantic_navigator)
- `three-text` library (HarfBuzz WASM + WOFF2) generating Three.js BufferGeometry
- `Billboard` components from drei (`follow={false} lockZ`) to keep labels camera-facing
- World-space scaling with `computeUnitsPerPixel()` - text scales with zoom but enforces minimum screen pixel size
- Multi-layer smoothstep fade based on pixel size thresholds
- Geometry caching by font/size/text

## Implementation Plan

### Phase 1: Three.js Renderer Core

New file: `src/ThreeJSRenderer.jsx` (or similar) as an alternative rendering backend. `DotVisualization` gets a `renderer: 'svg' | 'canvas' | 'threejs'` prop.

#### 1a. Instanced Mesh with Bevel Shader + Stroke

- `InstancedMesh` with `circleGeometry` (16 segments)
- Custom fragment shader combining:
  - **Dome/bevel lighting**: hemisphere distance function, normal calculation, diffuse lighting (same as catalog-viz `bevelMaterial.ts`)
  - **Stroke outline**: pixels near the circle edge render as stroke color instead of dome-lit fill
- Stroke parameters: color and width driven by props (`dotStroke`, `dotStrokeWidth`), theme-aware (dark: thin light strokes, light: thicker dark strokes)
- Single draw call for all dots

#### 1b. Per-Instance Colors and Scales

- Instance color buffer from `dotStyles` Map (per-dot fill colors)
- Instance matrix transforms for position (x, y, 0) and scale (from dot size + hover multiplier)
- Update buffers when `dotStyles`, `data`, or hover state changes

#### 1c. Camera Controller

Port from catalog-viz `CameraController.tsx`:
- Orthographic or perspective camera (FOV 10, top-down)
- **Zoom-to-cursor**: exponential zoom factor, recalculate camera position to keep cursor point fixed
- **Pan**: mousemove drag with threshold, screen-to-world delta conversion
- **Gesture classification**: Ctrl+wheel = pinch zoom, default wheel = scroll-pan
- Expose zoom transform state compatible with existing `ZoomManager` API so MusicMapper integration is seamless

#### 1d. Edge Rendering

- drei `Line2` (LineSegments2 internally) for consistent-width lines
- Edge color, opacity, and width from edge `strength` property (same as current `EdgeLayer.jsx`)

#### 1e. Text Labels

Same technique as semantic_navigator:
- `three-text` library for geometry generation
- `Billboard` from drei with `follow={false} lockZ`
- `computeUnitsPerPixel()` for zoom-responsive scaling with minimum screen pixel size
- Smoothstep fade at size thresholds
- Geometry caching by font/size/text to avoid recreation
- Port existing `RegionLabels.jsx` logic (cluster detection, label positioning) to this approach

### Phase 2: Interaction Parity

#### 2a. Hover and Click Detection

- Raycaster from cursor to Z=0 plane (same as catalog-viz PointCloud)
- Distance threshold check against all dot positions (scaled by camera Z)
- Map to existing callback API: `onDotHover(dotId, event)`, `onDotClick(dotId, event)`
- Hover size multiplier: update instance scale for hovered dot

#### 2b. Drag Detection

- Click vs drag discrimination: < 300ms duration AND < 5px movement = click
- Emit `onDragStart` only on actual drag (matching current behavior)

### Phase 3: Animation Parity

#### 3a. Pulse Animation

- Port `usePulseAnimation` logic to `useFrame` callback
- Per-frame updates to instance matrix (scale) and instance color buffer
- Sine wave oscillation for size range, opacity range, color interpolation
- Support both pulse-inward and pulse-outward modes

#### 3b. Ring Pulse Effect

- Second `InstancedMesh` layer for expanding/fading ring circles
- Only instantiated for dots with `pulse.ringEffect = true`
- Ring radius and opacity animated per frame
- Adaptive ring sizing (port `pulseRingUtils.js` logic)

### Phase 4: MusicMapper Integration

#### 4a. Switch Renderer

- Set `renderer="threejs"` in `MusicDotVisualization.tsx`
- Ensure decollision output feeds instance positions correctly
- Verify zoom/pan state management works with new camera controller

#### 4b. Visual Verification

- Stroke colors match theme (dark: `rgb(240,240,240)` thin, light: `rgb(40,40,40)` thicker)
- Dot sizes and radius scalars preserved
- Pulse animations visually identical
- Edge rendering matches current appearance
- Text labels readable at all zoom levels

## Dependencies

- `@react-three/fiber` - React renderer for Three.js
- `@react-three/drei` - Billboard, Line2, Html utilities
- `three` - Three.js core
- `three-text` - Text geometry generation (HarfBuzz WASM)

## Files to Create/Modify

### react-dot-visualization (new files)
- `src/ThreeJSRenderer.jsx` - Main Three.js rendering component
- `src/ThreeJSDots.jsx` - InstancedMesh dot rendering with bevel+stroke shader
- `src/ThreeJSEdges.jsx` - Line2 edge rendering
- `src/ThreeJSLabels.jsx` - three-text label rendering
- `src/ThreeJSInteraction.jsx` - Raycaster hover/click
- `src/ThreeJSCamera.jsx` - Camera controller
- `src/bevelStrokeMaterial.js` - Combined dome + stroke shader

### react-dot-visualization (modified)
- `src/DotVisualization.jsx` - Add `renderer` prop, conditionally render Three.js or SVG/Canvas
- `src/types.ts` - Add renderer type
- `src/index.js` - Export new components

### MusicMapper (modified)
- `src/renderer/components/MusicDotVisualization.tsx` - Switch to `renderer="threejs"`

## What Gets Removed (Eventually)

Once Three.js renderer is validated, these become candidates for removal:
- `src/ColoredDots.jsx` (SVG/Canvas dot rendering)
- `src/canvasInteractions.js` (spatial hash grid)
- `src/InteractionLayer.jsx` (SVG invisible circles)
- D3 zoom dependency (replaced by Three.js camera)

Keep `src/decollisioning.js` - D3 force simulation still useful for separating overlapping dots before feeding positions to Three.js.
