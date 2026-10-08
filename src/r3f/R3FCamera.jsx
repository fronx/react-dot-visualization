import { useRef, useEffect, useMemo } from 'react';
import { useThree, useFrame, useStore } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import {
  classifyWheelGesture,
  calculateZoomFactor,
  calculateZoomToCursor,
  calculatePan,
  createPanHandler,
  computeFitZ,
  computeZoomOutCapZ,
  cameraForCanvasChange,
  CAMERA_FOV_DEGREES,
} from './cameraUtils.js';
import { finiteBoundsForData } from '../utils.js';
import { CAMERA_Z_MAX, isFiniteCameraPosition } from './cameraState.js';

const CAMERA_Z_MIN = 0.5;
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
export function R3FCamera({ onTransformChange, onInvalidCamera, data = [], interactionRef = null, clickControlRef = null, scrollZoomModifier = 'meta-or-alt', occlusion = {}, minZForHeight = () => 0, initialized = null }) {
  const controlsRef = useRef(null);
  const { camera, gl, size, invalidate } = useThree();
  const store = useStore();

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

  // A resize leaves the map where it was on screen, once the camera has its
  // first placement (before it, a report would file the default camera as the
  // user's). The window's size and its screen origin reach the page as
  // separate updates, a frame or a step apart when an edge drag moves the
  // window (left or top edge), so no single reading of the pair can be trusted.
  // The camera is therefore always derived from the gesture's start, the
  // canvas on screen and the camera when it began: an inconsistent reading
  // costs only its own frame, and the first consistent one puts every dot back
  // (map-steady-on-resize, 2026-10-08). A gesture starts at a press (a window
  // move fires nothing here, and a resize after one would count the move as
  // growth) and whenever anything else moved the camera.
  const resizeStartRef = useRef(null);
  const placedRef = useRef(null);
  const canvasOnScreen = (size) => ({ left: window.screenX + size.left, top: window.screenY + size.top, width: size.width, height: size.height });
  const isAt = (p) => !!p && Math.abs(camera.position.x - p.x) + Math.abs(camera.position.y - p.y) + Math.abs(camera.position.z - p.z) <= 1e-6 * Math.max(1, p.z);
  const startResize = (size) => {
    const placeable = initialized?.current && size.width > 0 && size.height > 0 && isFiniteCameraPosition(camera.position);
    resizeStartRef.current = placeable ? { canvas: canvasOnScreen(size), camera: camera.position.clone() } : null;
    placedRef.current = resizeStartRef.current?.camera ?? null;
  };
  useFrame(({ size }) => {
    const start = resizeStartRef.current;
    if (!start || !isAt(placedRef.current)) { startResize(size); return; }
    if (!(size.width > 0) || !(size.height > 0)) return;
    const moved = cameraForCanvasChange(start.camera, start.canvas, canvasOnScreen(size));
    if (!isFiniteCameraPosition(moved) || isAt(moved)) return;
    camera.position.set(moved.x, moved.y, moved.z);
    placedRef.current = moved;
    controlsRef.current?.target.set(moved.x, moved.y, 0);
    controlsRef.current?.update();
    // The next frame reads the pair again: the origin can still be on its way.
    invalidate();
    onTransformChange?.();
  });
  useEffect(() => {
    const unsubscribe = store.subscribe((state, prev) => { if (state.size !== prev.size) invalidate(); });
    const startGesture = () => startResize(store.getState().size);
    window.addEventListener('pointerdown', startGesture, { capture: true, passive: true });
    return () => {
      unsubscribe();
      window.removeEventListener('pointerdown', startGesture, { capture: true });
    };
  }, [store, invalidate, camera, initialized]);

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
