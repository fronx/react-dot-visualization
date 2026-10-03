import { useRef, useEffect, useMemo } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import {
  classifyWheelGesture,
  calculateZoomFactor,
  calculateZoomToCursor,
  calculatePan,
  createPanHandler,
  computeFitZ,
  computeZoomOutCapZ,
  CAMERA_FOV_DEGREES,
} from './cameraUtils.js';
import { finiteBoundsForData } from '../utils.js';
import { isFiniteCameraPosition } from './cameraState.js';

const CAMERA_Z_MIN = 0.5;
const CAMERA_Z_MAX = 5000; // absolute zoom-out ceiling (safety)
// Most-zoomed-out state keeps the whole graph filling at least this fraction of
// the visible (unoccluded) area, so it never shrinks to a useless speck; a fit
// fills ~0.9 of the same area, so it is always reachable.
const MIN_GRAPH_VIEWPORT_FRACTION = 0.4;

/**
 * Camera controller for the R3F dot renderer.
 * - Drag to pan (2D top-down)
 * - Scroll to pan (trackpad two-finger scroll)
 * - Pinch or modifier+scroll to zoom, zoom-to-cursor
 */
export function R3FCamera({ onTransformChange, onInvalidCamera, data = [], interactionRef = null, clickControlRef = null, scrollZoomModifier = 'meta-or-alt', occlusion = {}, minZForHeight = () => 0 }) {
  const controlsRef = useRef(null);
  const { camera, gl, size, invalidate } = useThree();

  // Graph-aware zoom-out cap: derive the max camera distance from the data
  // bounds so the whole graph never shrinks below MIN_GRAPH_VIEWPORT_FRACTION
  // of the viewport. Recomputed only when the point set or viewport changes.
  const dataBounds = useMemo(() => finiteBoundsForData(data), [data]);
  const maxZ = useMemo(() => {
    if (!dataBounds) return CAMERA_Z_MAX;
    if (!(size.width > 0) || !(size.height > 0)) return CAMERA_Z_MAX;
    const z = computeZoomOutCapZ(dataBounds, size, occlusion, MIN_GRAPH_VIEWPORT_FRACTION);
    return Number.isFinite(z) ? Math.min(CAMERA_Z_MAX, z) : CAMERA_Z_MAX;
  }, [dataBounds, size.width, size.height, occlusion.left, occlusion.right, occlusion.top, occlusion.bottom]);

  // OrbitControls targets the origin by default, but CameraInitializer and
  // zoomToVisible place the camera at arbitrary (x, y). Without keeping the
  // look-at directly under the camera, the view stays aimed at the origin and
  // the data renders off-center until the first pan/zoom (which sets target).
  useFrame(() => {
    if (!isFiniteCameraPosition(camera.position)) {
      onInvalidCamera?.();
      return;
    }
    const controls = controlsRef.current;
    if (!controls) return;
    const { x, y } = camera.position;
    if (controls.target.x !== x || controls.target.y !== y) {
      controls.target.set(x, y, 0);
      controls.update();
    }
  });

  // Drag-to-pan
  useEffect(() => {
    return createPanHandler({
      canvas: gl.domElement,
      getCameraZ: () => camera.position.z,
      onPanStart: () => { if (interactionRef) interactionRef.current = true; },
      onPanEnd: () => { if (interactionRef) interactionRef.current = false; },
      // Single click-vs-drag authority: createPanHandler fires onClick only on a
      // genuine click, so the dot pick/select runs here and never on the click
      // the browser synthesizes after a drag. HoverDetector publishes its pick
      // logic into clickControlRef.
      onClick: (e) => { if (clickControlRef) clickControlRef.current?.(e); },
      onPan: (worldDeltaX, worldDeltaY) => {
        const next = {
          x: camera.position.x + worldDeltaX,
          y: camera.position.y + worldDeltaY,
          z: camera.position.z,
        };
        if (!isFiniteCameraPosition(next)) {
          onInvalidCamera?.();
          return;
        }
        camera.position.x = next.x;
        camera.position.y = next.y;
        if (controlsRef.current) {
          controlsRef.current.target.set(camera.position.x, camera.position.y, 0);
          controlsRef.current.update();
        }
        invalidate();
        onTransformChange?.();
      },
    });
  }, [camera, gl, interactionRef, clickControlRef, invalidate, onInvalidCamera]);

  // Wheel: scroll-to-pan or zoom-to-cursor
  useEffect(() => {
    const canvas = gl.domElement;

    const handleWheel = (event) => {
      if (!controlsRef.current) return;
      event.preventDefault();
      event.stopPropagation();

      const gesture = classifyWheelGesture(event, scrollZoomModifier);
      const rect = canvas.getBoundingClientRect();
      if (!isFiniteCameraPosition(camera.position) || !(rect.width > 0) || !(rect.height > 0)) {
        if (!isFiniteCameraPosition(camera.position)) onInvalidCamera?.();
        return;
      }

      if (gesture === 'scroll-pan') {
        const { worldDeltaX, worldDeltaY } = calculatePan({
          screenDeltaX: -event.deltaX,
          screenDeltaY: -event.deltaY,
          cameraZ: camera.position.z,
          containerWidth: rect.width,
          containerHeight: rect.height,
        });
        const next = {
          x: camera.position.x + worldDeltaX,
          y: camera.position.y + worldDeltaY,
          z: camera.position.z,
        };
        if (!isFiniteCameraPosition(next)) {
          onInvalidCamera?.();
          return;
        }
        camera.position.x = next.x;
        camera.position.y = next.y;
        controlsRef.current.target.set(camera.position.x, camera.position.y, 0);
        controlsRef.current.update();
      } else {
        // zoom-to-cursor
        const oldZ = camera.position.z;
        const isPinch = gesture === 'pinch';
        const minZ = Math.max(CAMERA_Z_MIN, minZForHeight(size.height));
        const newZ = Math.max(minZ, Math.min(maxZ, oldZ * calculateZoomFactor(event.deltaY, isPinch)));
        if (Math.abs(newZ - oldZ) < 0.001) return;

        const screenX = event.clientX - rect.left;
        const screenY = event.clientY - rect.top;
        const ndcX = (screenX / rect.width) * 2 - 1;
        const ndcY = -((screenY / rect.height) * 2 - 1);

        const result = calculateZoomToCursor({
          oldZ, newZ,
          cameraX: camera.position.x,
          cameraY: camera.position.y,
          cursorNDC: { x: ndcX, y: ndcY },
          aspect: size.width / size.height,
        });
        const next = { x: result.cameraX, y: result.cameraY, z: newZ };
        if (!isFiniteCameraPosition(next)) {
          onInvalidCamera?.();
          return;
        }

        camera.position.x = next.x;
        camera.position.y = next.y;
        camera.position.z = next.z;
        controlsRef.current.target.set(camera.position.x, camera.position.y, 0);
        controlsRef.current.update();
      }

      invalidate();
      onTransformChange?.();
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [camera, gl, size, maxZ, scrollZoomModifier, invalidate, onInvalidCamera, minZForHeight]);

  return (
    <OrbitControls
      ref={controlsRef}
      enableRotate={false}
      enablePan={false}
      enableZoom={false}
      enableDamping
      dampingFactor={0.1}
      minDistance={CAMERA_Z_MIN}
      // Not maxZ: the wheel handler enforces the zoom-out cap, and OrbitControls'
      // own zoom is off, so a cap here only clamps the camera's distance to the
      // controls' target — still the origin on the first frame after a placed
      // camera — and moves it unreported (a one-dot map restored to its saved
      // camera drew nothing, 2026-10-03).
      maxDistance={CAMERA_Z_MAX}
    />
  );
}

/**
 * Programmatically fit the camera to a bounding box.
 * Returns a function to call with {minX, maxX, minY, maxY}.
 */
export function useCameraFit() {
  const { camera, size } = useThree();

  return ({ minX, maxX, minY, maxY }) => {
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const aspect = size.width / size.height;
    const z = computeFitZ(minX, maxX, minY, maxY, aspect);
    if (!isFiniteCameraPosition({ x: centerX, y: centerY, z })) return false;
    camera.position.set(centerX, centerY, z);
    return true;
  };
}
