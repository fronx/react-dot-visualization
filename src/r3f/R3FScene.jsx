import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { R3FDots } from './R3FDots.jsx';
import { R3FEdges } from './R3FEdges.jsx';
import { R3FCamera } from './R3FCamera.jsx';
import { computeFitZ, CAMERA_FOV_DEGREES } from './cameraUtils.js';
import { buildSpatialGrid, queryRadius } from '../spatialIndex.js';
import { useHoverDispatcher } from '../useHoverDispatcher.js';
import { resolveHoverRadius } from './dotAppearance.js';

const CAMERA_FOV_RAD = CAMERA_FOV_DEGREES * (Math.PI / 180);

const _raycaster = new THREE.Raycaster();
const _mouse = new THREE.Vector2();
const _zeroPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const _worldPos = new THREE.Vector3();

const HOVER_CELL_SIZE = 8;
const EMPTY_RADIUS_OVERRIDES = new Map();

function buildHoverSpatialIndex(data, radiusOverrides, defaultSize, hoverSizeMultiplier) {
  const entries = [];
  let maxHoverRadius = 0;

  for (const item of data) {
    const hoverRadius = resolveHoverRadius(item, radiusOverrides, defaultSize, hoverSizeMultiplier);
    maxHoverRadius = Math.max(maxHoverRadius, hoverRadius);

    entries.push({
      item,
      worldX: item.x,
      worldY: -item.y,
      hoverRadius
    });
  }

  const spatialIndex = buildSpatialGrid(entries, {
    cellSize: HOVER_CELL_SIZE,
    getBounds: (entry) => ({
      minX: entry.worldX - entry.hoverRadius,
      maxX: entry.worldX + entry.hoverRadius,
      minY: entry.worldY - entry.hoverRadius,
      maxY: entry.worldY + entry.hoverRadius
    })
  });

  return {
    ...spatialIndex,
    maxHoverRadius,
  };
}

function findNearestDot(spatialIndex, worldX, worldY, threshold) {
  if (!spatialIndex) return null;

  const { maxHoverRadius } = spatialIndex;
  const searchRadius = Math.max(threshold, maxHoverRadius);
  const candidates = queryRadius(spatialIndex, worldX, worldY, searchRadius);
  let minDistSquared = Infinity;
  let nearest = null;

  for (const candidate of candidates) {
    const effectiveThreshold = Math.min(candidate.hoverRadius, threshold);
    if (effectiveThreshold <= 0) continue;
    const limitSquared = effectiveThreshold * effectiveThreshold;
    const diffX = worldX - candidate.worldX;
    const diffY = worldY - candidate.worldY;
    const distSquared = diffX * diffX + diffY * diffY;

    if (distSquared <= limitSquared && distSquared < minDistSquared) {
      minDistSquared = distSquared;
      nearest = candidate.item;
    }
  }

  return nearest;
}

// Renderer-agnostic: raycasts a z=0 plane (pure three-core math against the
// camera) and resolves the nearest dot. WebGL resolves it via a CPU spatial
// index over `data`; WebGPU (when `pickControlRef` is supplied) defers to a GPU
// pick kernel that reads the live position buffer, so hit-testing tracks the
// moving dots during decollision rather than the settled `data`. Touches no GPU
// meshes either way, so the WebGPU backend mounts it directly.
export function HoverDetector({ data, radiusOverrides, defaultSize, hoverSizeMultiplier, onHover, onLeave, onHoveredIdChange, onDotClick, onBackgroundClick, pickControlRef = null, interactionRef = null, clickControlRef = null }) {
  const { camera, gl } = useThree();
  const rectRef = useRef(gl.domElement.getBoundingClientRect());
  const useGpuPick = !!pickControlRef;
  const spatialIndex = useMemo(
    () => (useGpuPick ? null : buildHoverSpatialIndex(data, radiusOverrides, defaultSize, hoverSizeMultiplier)),
    [useGpuPick, data, radiusOverrides, defaultSize, hoverSizeMultiplier]
  );
  // Latest data, read inside async pick callbacks to map a resolved index back
  // to its dot. The GPU buffer order matches `data` (both positional), so
  // `data[index]` is the hit dot.
  const dataRef = useRef(data);
  dataRef.current = data;

  const dispatcher = useHoverDispatcher({ onHover, onLeave, onHoveredIdChange });

  // Publish the latest cursor into the GPU pick channel; R3FDotsWebGPU's frame
  // loop services it and calls `onResult(index)`. The single writer for both
  // hover-move ('move') and click ('click') slots.
  const publishPick = useCallback((slot, threshold, onResult) => {
    const channel = pickControlRef?.current;
    if (channel) channel[slot] = { x: _worldPos.x, y: _worldPos.y, threshold, onResult };
  }, [pickControlRef]);

  // Cache canvas bounds; avoid layout reads on every mouse event.
  useEffect(() => {
    const canvas = gl.domElement;
    const updateRect = () => {
      rectRef.current = canvas.getBoundingClientRect();
    };

    updateRect();
    const observer = new ResizeObserver(updateRect);
    observer.observe(canvas);
    window.addEventListener('resize', updateRect);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateRect);
    };
  }, [gl]);

  useEffect(() => {
    const canvas = gl.domElement;
    let rafId = 0;
    let pendingX = 0;
    let pendingY = 0;
    // True while the pointer is inside the canvas. The GPU pick resolves a frame
    // or two later; without this gate an in-flight (or queued) pick could land
    // after mouseleave and re-hover a dot we already reported as zone-left.
    let inside = false;

    const processMove = () => {
      rafId = 0;
      // Clear and hold the focus while the camera is being dragged: panning
      // sweeps dots under the cursor, which would otherwise focus a new dot on
      // every frame (including the one the drag started on). move(null) clears
      // the ring once, then no-ops. Mirrors Canvas's blockHoverDuringInteraction.
      if (interactionRef?.current) {
        dispatcher.move(null);
        return;
      }
      const rect = rectRef.current;
      _mouse.set(
        ((pendingX - rect.left) / rect.width) * 2 - 1,
        -((pendingY - rect.top) / rect.height) * 2 + 1,
      );
      _raycaster.setFromCamera(_mouse, camera);
      if (!_raycaster.ray.intersectPlane(_zeroPlane, _worldPos)) return;

      // Threshold scales with camera Z to maintain consistent screen-space feel
      const threshold = 0.015 * camera.position.z;

      if (useGpuPick) {
        publishPick('move', threshold, (index) => {
          if (!inside) return;
          dispatcher.move(index >= 0 ? (dataRef.current[index] ?? null) : null);
        });
        return;
      }

      const nearest = findNearestDot(spatialIndex, _worldPos.x, _worldPos.y, threshold);
      dispatcher.move(nearest ?? null);
    };

    const handleMove = (e) => {
      inside = true;
      pendingX = e.clientX;
      pendingY = e.clientY;
      if (!rafId) {
        rafId = requestAnimationFrame(processMove);
      }
    };

    const handleLeave = () => {
      inside = false;
      // Drop any batched move so a stale raycast can't re-hover after we've
      // already reported the zone-leave.
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      // Cancel a queued GPU pick too (an in-flight one is gated by `inside`).
      if (useGpuPick && pickControlRef.current) pickControlRef.current.move = null;
      dispatcher.leaveZone();
    };

    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mouseleave', handleLeave);
    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      canvas.removeEventListener('mousemove', handleMove);
      canvas.removeEventListener('mouseleave', handleLeave);
    };
  }, [camera, gl, dispatcher, spatialIndex, useGpuPick, pickControlRef, publishPick, interactionRef]);

  // Click detection. R3FCamera's pan handler is the single click-vs-drag
  // authority: it calls clickControlRef only on a genuine click (never on the
  // click the browser synthesizes after a drag), so we publish the pick logic
  // here and let the pan handler invoke it.
  useEffect(() => {
    if (!clickControlRef) return undefined;

    const handleClick = (e) => {
      const rect = rectRef.current;
      _mouse.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      _raycaster.setFromCamera(_mouse, camera);
      if (!_raycaster.ray.intersectPlane(_zeroPlane, _worldPos)) return;

      const threshold = 0.015 * camera.position.z;

      if (useGpuPick) {
        // No `inside` gate: a click is user-initiated, not a hover re-trigger,
        // so it should land even if the pointer left between press and resolve.
        publishPick('click', threshold, (index) => {
          const item = index >= 0 ? dataRef.current[index] : null;
          if (item) onDotClick?.(item, e);
          else onBackgroundClick?.(e);
        });
        return;
      }

      const nearest = findNearestDot(spatialIndex, _worldPos.x, _worldPos.y, threshold);
      if (nearest) {
        onDotClick?.(nearest, e);
      } else {
        onBackgroundClick?.(e);
      }
    };

    clickControlRef.current = handleClick;
    return () => { clickControlRef.current = null; };
  }, [camera, gl, onDotClick, onBackgroundClick, spatialIndex, useGpuPick, publishPick, clickControlRef]);

  return null;
}

export function CameraInitializer({ data, initialized, initialTransform, onInit, computeFitTarget }) {
  const { camera, size } = useThree();
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current || initialized.current || data.length === 0) return;
    hasRun.current = true;
    initialized.current = true;

    const occlusionAwareFit = !initialTransform ? computeFitTarget?.() : null;

    if (initialTransform) {
      // Restore from a saved D3 zoom transform produced by Canvas's
      // ZoomManager or computed externally against the same convention
      // (viewBox = [0, 0, 100*aspect, 100], where 100 matches
      // DotVisualization's baseHeight). The Y inversion that turns SVG
      // down-positive into Three.js up-positive is baked into the
      // (y - vbH/2) sign — no extra negation here.
      const { x, y, k } = initialTransform;
      const { width: W, height: H } = size;
      const vbH = 100;
      const vbW = (W / H) * vbH;
      const cx = (vbW / 2 - x) / k;
      const cy_world = (y - vbH / 2) / k;
      const cz = vbH / (k * 2 * Math.tan(CAMERA_FOV_RAD / 2));
      camera.position.set(cx, cy_world, Math.max(0.5, Math.min(5000, cz)));
    } else if (occlusionAwareFit) {
      // Match Canvas: center the data in the occlusion-aware visible region
      // (padded bounds, fitMargin) via the same computeFitTransformToVisible
      // pipeline DotVisualizationR3F.zoomToVisible uses, rather than centering
      // the raw centroid on the full canvas.
      camera.position.set(occlusionAwareFit.x, occlusionAwareFit.y, occlusionAwareFit.z);
    } else {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const item of data) {
        if (item.x < minX) minX = item.x;
        if (item.x > maxX) maxX = item.x;
        if (item.y < minY) minY = item.y;
        if (item.y > maxY) maxY = item.y;
      }
      const centerX = (minX + maxX) / 2;
      const centerY = -((minY + maxY) / 2); // negate Y: data Y is SVG (down+), world Y is up+
      const aspect = size.width / size.height;
      const z = computeFitZ(minX, maxX, minY, maxY, aspect, 0.85);
      camera.position.set(centerX, centerY, z);
    }

    onInit?.({ x: camera.position.x, y: camera.position.y, z: camera.position.z });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, camera, size, initialized]);

  return null;
}

// Allows programmatic camera positioning from outside the Canvas context.
export function CameraSetter({ setCameraRef }) {
  const { camera } = useThree();

  useEffect(() => {
    setCameraRef.current = (x, y, z) => {
      camera.position.set(x, y, z);
    };
    return () => { setCameraRef.current = null; };
  }, [camera, setCameraRef]);

  return null;
}

// Fires onCameraStateChange whenever the camera moves, allowing the outer component
// to read camera state for zoom/pan persistence across renderer switches.
export function CameraReporter({ reportRef, onCameraStateChange }) {
  const { camera } = useThree();
  const onChangeRef = useRef(onCameraStateChange);
  useEffect(() => { onChangeRef.current = onCameraStateChange; }, [onCameraStateChange]);

  useEffect(() => {
    reportRef.current = () => {
      onChangeRef.current?.({ x: camera.position.x, y: camera.position.y, z: camera.position.z });
    };
  }, [camera, reportRef]);

  return null;
}

/**
 * The R3F 3D scene — camera, dots, edges, hover detection.
 * Props mirror DotVisualization.
 */
export function R3FScene({
  data,
  edges,
  radiusOverrides = EMPTY_RADIUS_OVERRIDES,
  dotStyles,
  defaultColor,
  defaultSize,
  defaultOpacity,
  dotStroke,
  dotStrokeWidthFraction,
  hoveredId,
  onHover,
  onLeave,
  onHoveredIdChange,
  onDotClick,
  onBackgroundClick,
  hoverSizeMultiplier,
  hoverOpacity,
  edgeColor,
  edgeOpacity,
  showEdges,
  cameraInitialized,
  initialTransform = null,
  computeFitTarget,
  onCameraStateChange,
  setCameraRef,
  liveTransitionDataRef,
  blockHoverDuringInteraction = false,
}) {
  const dataMap = useMemo(() => {
    const map = new Map();
    for (const item of data) map.set(item.id, item);
    return map;
  }, [data]);

  // True while the camera is being dragged; HoverDetector reads it to suppress
  // hover acquisition during a pan when blockHoverDuringInteraction is on.
  const interactionRef = useRef(false);
  // HoverDetector publishes its pick logic here; R3FCamera's pan handler invokes
  // it on a genuine click (the single click-vs-drag authority).
  const clickControlRef = useRef(null);

  const reportCameraRef = useRef(null);
  const handleTransformChange = useCallback(() => {
    reportCameraRef.current?.();
  }, []);

  return (
    <>
      <CameraInitializer
        data={data}
        initialized={cameraInitialized}
        initialTransform={initialTransform}
        computeFitTarget={computeFitTarget}
        onInit={onCameraStateChange}
      />
      <CameraReporter reportRef={reportCameraRef} onCameraStateChange={onCameraStateChange} />
      {setCameraRef && <CameraSetter setCameraRef={setCameraRef} />}
      <R3FCamera onTransformChange={handleTransformChange} data={data} interactionRef={interactionRef} clickControlRef={clickControlRef} />

      {showEdges && edges.length > 0 && (
        <R3FEdges
          edges={edges}
          dataMap={dataMap}
          edgeColor={edgeColor}
          edgeOpacity={edgeOpacity}
        />
      )}

      <R3FDots
        data={data}
        dotStyles={dotStyles}
        defaultColor={defaultColor}
        defaultSize={defaultSize}
        defaultOpacity={defaultOpacity}
        dotStroke={dotStroke}
        dotStrokeWidthFraction={dotStrokeWidthFraction}
        hoveredId={hoveredId}
        hoverSizeMultiplier={hoverSizeMultiplier}
        hoverOpacity={hoverOpacity}
        radiusOverrides={radiusOverrides}
        liveTransitionDataRef={liveTransitionDataRef}
      />

      <HoverDetector
        data={data}
        radiusOverrides={radiusOverrides}
        defaultSize={defaultSize}
        hoverSizeMultiplier={hoverSizeMultiplier}
        onHover={onHover}
        onLeave={onLeave}
        onHoveredIdChange={onHoveredIdChange}
        onDotClick={onDotClick}
        onBackgroundClick={onBackgroundClick}
        interactionRef={blockHoverDuringInteraction ? interactionRef : null}
        clickControlRef={clickControlRef}
      />
    </>
  );
}
