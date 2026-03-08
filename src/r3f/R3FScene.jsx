import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { R3FDots } from './R3FDots.jsx';
import { R3FEdges } from './R3FEdges.jsx';
import { R3FCamera, useCameraFit } from './R3FCamera.jsx';
import { CAMERA_FOV_DEGREES, computeFitZ } from './cameraUtils.js';

const _raycaster = new THREE.Raycaster();
const _mouse = new THREE.Vector2();
const _zeroPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const _worldPos = new THREE.Vector3();

const CAMERA_FOV_RADIANS = CAMERA_FOV_DEGREES * (Math.PI / 180);

function HoverDetector({ data, dotStyles, defaultSize, hoverSizeMultiplier, onHoverChange, onDotClick, onBackgroundClick }) {
  const { camera, gl } = useThree();
  const hoveredIdRef = useRef(null);

  // Build a fast lookup map
  const dataById = useMemo(() => {
    const map = new Map();
    for (const item of data) map.set(item.id, item);
    return map;
  }, [data]);

  useEffect(() => {
    const canvas = gl.domElement;

    const handleMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      _mouse.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      _raycaster.setFromCamera(_mouse, camera);
      if (!_raycaster.ray.intersectPlane(_zeroPlane, _worldPos)) return;

      // Threshold scales with camera Z to maintain consistent screen-space feel
      const threshold = 0.015 * camera.position.z;
      let minDist = Infinity;
      let nearest = null;

      for (const item of data) {
        const dist = Math.hypot(_worldPos.x - item.x, _worldPos.y - (-item.y));
        const effectiveSize = (dotStyles.get(item.id)?.r ?? item.size ?? defaultSize);
        if (dist < effectiveSize * hoverSizeMultiplier && dist < threshold && dist < minDist) {
          minDist = dist;
          nearest = item;
        }
      }

      const newId = nearest?.id ?? null;
      if (newId !== hoveredIdRef.current) {
        hoveredIdRef.current = newId;
        onHoverChange?.(newId, nearest);
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
      canvas.removeEventListener('mousemove', handleMove);
      canvas.removeEventListener('mouseleave', handleLeave);
    };
  }, [camera, gl, data, dotStyles, defaultSize, hoverSizeMultiplier, onHoverChange]);

  // Click detection
  useEffect(() => {
    const canvas = gl.domElement;

    const handleClick = (e) => {
      const rect = canvas.getBoundingClientRect();
      _mouse.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      _raycaster.setFromCamera(_mouse, camera);
      if (!_raycaster.ray.intersectPlane(_zeroPlane, _worldPos)) return;

      const threshold = 0.015 * camera.position.z;
      let minDist = Infinity;
      let nearest = null;
      for (const item of data) {
        const dist = Math.hypot(_worldPos.x - item.x, _worldPos.y - (-item.y));
        const effectiveSize = (dotStyles.get(item.id)?.r ?? item.size ?? defaultSize);
        if (dist < effectiveSize * hoverSizeMultiplier && dist < threshold && dist < minDist) {
          minDist = dist;
          nearest = item;
        }
      }

      if (nearest) {
        onDotClick?.(nearest, e);
      } else {
        onBackgroundClick?.(e);
      }
    };

    canvas.addEventListener('click', handleClick);
    return () => canvas.removeEventListener('click', handleClick);
  }, [camera, gl, data, dotStyles, defaultSize, hoverSizeMultiplier, onDotClick, onBackgroundClick]);

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
