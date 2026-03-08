import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { R3FDots } from './R3FDots.jsx';
import { R3FEdges } from './R3FEdges.jsx';
import { R3FCamera } from './R3FCamera.jsx';
import { computeFitZ, CAMERA_FOV_DEGREES } from './cameraUtils.js';
import { buildSpatialGrid, queryRadius } from '../spatialIndex.js';

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
    const effectiveSize = radiusOverrides.get(item.id) ?? item.size ?? defaultSize;
    const hoverRadius = effectiveSize * hoverSizeMultiplier;
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

function HoverDetector({ data, radiusOverrides, defaultSize, hoverSizeMultiplier, onHoverChange, onDotClick, onBackgroundClick }) {
  const { camera, gl } = useThree();
  const hoveredIdRef = useRef(null);
  const rectRef = useRef(gl.domElement.getBoundingClientRect());
  const spatialIndex = useMemo(
    () => buildHoverSpatialIndex(data, radiusOverrides, defaultSize, hoverSizeMultiplier),
    [data, radiusOverrides, defaultSize, hoverSizeMultiplier]
  );

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

    const processMove = () => {
      rafId = 0;
      const rect = rectRef.current;
      _mouse.set(
        ((pendingX - rect.left) / rect.width) * 2 - 1,
        -((pendingY - rect.top) / rect.height) * 2 + 1,
      );
      _raycaster.setFromCamera(_mouse, camera);
      if (!_raycaster.ray.intersectPlane(_zeroPlane, _worldPos)) return;

      // Threshold scales with camera Z to maintain consistent screen-space feel
      const threshold = 0.015 * camera.position.z;
      const nearest = findNearestDot(spatialIndex, _worldPos.x, _worldPos.y, threshold);

      const newId = nearest?.id ?? null;
      if (newId !== hoveredIdRef.current) {
        hoveredIdRef.current = newId;
        onHoverChange?.(newId, nearest);
      }
    };

    const handleMove = (e) => {
      pendingX = e.clientX;
      pendingY = e.clientY;
      if (!rafId) {
        rafId = requestAnimationFrame(processMove);
      }
    };

    const handleLeave = () => {
      if (hoveredIdRef.current !== null) {
        hoveredIdRef.current = null;
        onHoverChange?.(null, null);
      }
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
  }, [camera, gl, onHoverChange, spatialIndex]);

  // Click detection
  useEffect(() => {
    const canvas = gl.domElement;

    const handleClick = (e) => {
      const rect = rectRef.current;
      _mouse.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      _raycaster.setFromCamera(_mouse, camera);
      if (!_raycaster.ray.intersectPlane(_zeroPlane, _worldPos)) return;

      const threshold = 0.015 * camera.position.z;
      const nearest = findNearestDot(spatialIndex, _worldPos.x, _worldPos.y, threshold);

      if (nearest) {
        onDotClick?.(nearest, e);
      } else {
        onBackgroundClick?.(e);
      }
    };

    canvas.addEventListener('click', handleClick);
    return () => canvas.removeEventListener('click', handleClick);
  }, [camera, gl, onDotClick, onBackgroundClick, spatialIndex]);

  return null;
}

function CameraInitializer({ data, initialized, initialTransform, onInit }) {
  const { camera, size } = useThree();
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current || initialized.current || data.length === 0) return;
    hasRun.current = true;
    initialized.current = true;

    if (initialTransform) {
      // Restore from a saved D3 zoom transform (from Canvas renderer or previous session).
      // Convert pixel-space D3 transform {x, y, k} to Three.js camera position.
      const { x, y, k } = initialTransform;
      const { width: W, height: H } = size;
      const cx = (W / 2 - x) / k;
      const cy_world = -((H / 2 - y) / k); // negate: data Y is SVG (down+), world Y is up+
      const cz = H / (k * 2 * Math.tan(CAMERA_FOV_RAD / 2));
      camera.position.set(cx, cy_world, Math.max(0.5, Math.min(5000, cz)));
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

// Fires onCameraStateChange whenever the camera moves, allowing the outer component
// to read camera state for zoom/pan persistence across renderer switches.
function CameraReporter({ reportRef, onCameraStateChange }) {
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
  onHoverChange,
  onDotClick,
  onBackgroundClick,
  hoverSizeMultiplier,
  hoverOpacity,
  edgeColor,
  edgeOpacity,
  showEdges,
  cameraInitialized,
  initialTransform = null,
  onCameraStateChange,
}) {
  const dataMap = useMemo(() => {
    const map = new Map();
    for (const item of data) map.set(item.id, item);
    return map;
  }, [data]);

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
        onInit={onCameraStateChange}
      />
      <CameraReporter reportRef={reportCameraRef} onCameraStateChange={onCameraStateChange} />
      <R3FCamera onTransformChange={handleTransformChange} />

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
      />

      <HoverDetector
        data={data}
        radiusOverrides={radiusOverrides}
        defaultSize={defaultSize}
        hoverSizeMultiplier={hoverSizeMultiplier}
        onHoverChange={onHoverChange}
        onDotClick={onDotClick}
        onBackgroundClick={onBackgroundClick}
      />
    </>
  );
}
