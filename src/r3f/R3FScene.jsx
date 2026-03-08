import React, { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { R3FDots } from './R3FDots.jsx';
import { R3FEdges } from './R3FEdges.jsx';
import { R3FCamera } from './R3FCamera.jsx';
import { computeFitZ } from './cameraUtils.js';
import { buildSpatialGrid, queryRadius } from '../spatialIndex.js';

const _raycaster = new THREE.Raycaster();
const _mouse = new THREE.Vector2();
const _zeroPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const _worldPos = new THREE.Vector3();

const HOVER_CELL_SIZE = 8;

function buildHoverSpatialIndex(data, dotStyles, defaultSize, hoverSizeMultiplier) {
  const entries = [];
  let maxHoverRadius = 0;

  for (const item of data) {
    const effectiveSize = dotStyles.get(item.id)?.r ?? item.size ?? defaultSize;
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

function HoverDetector({ data, dotStyles, defaultSize, hoverSizeMultiplier, onHoverChange, onDotClick, onBackgroundClick }) {
  const { camera, gl } = useThree();
  const hoveredIdRef = useRef(null);
  const rectRef = useRef(gl.domElement.getBoundingClientRect());
  const spatialIndex = useMemo(
    () => buildHoverSpatialIndex(data, dotStyles, defaultSize, hoverSizeMultiplier),
    [data, dotStyles, defaultSize, hoverSizeMultiplier]
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

function CameraInitializer({ data, initialized }) {
  const { camera, size } = useThree();
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current || initialized.current || data.length === 0) return;
    hasRun.current = true;
    initialized.current = true;

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
  }, [data, camera, size, initialized]);

  return null;
}

/**
 * The R3F 3D scene — camera, dots, edges, hover detection.
 * Props mirror DotVisualization.
 */
export function R3FScene({
  data,
  edges,
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
}) {
  const dataMap = useMemo(() => {
    const map = new Map();
    for (const item of data) map.set(item.id, item);
    return map;
  }, [data]);

  return (
    <>
      <CameraInitializer data={data} initialized={cameraInitialized} />
      <R3FCamera />

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
        dotStyles={dotStyles}
        defaultSize={defaultSize}
        hoverSizeMultiplier={hoverSizeMultiplier}
        onHoverChange={onHoverChange}
        onDotClick={onDotClick}
        onBackgroundClick={onBackgroundClick}
      />
    </>
  );
}
