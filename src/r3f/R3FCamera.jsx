import { useRef, useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import {
  classifyWheelGesture,
  calculateZoomFactor,
  calculateZoomToCursor,
  calculatePan,
  createPanHandler,
  computeFitZ,
  CAMERA_FOV_DEGREES,
} from './cameraUtils.js';

const CAMERA_Z_MIN = 0.5;
const CAMERA_Z_MAX = 5000;

/**
 * Camera controller for the R3F dot renderer.
 * - Drag to pan (2D top-down)
 * - Scroll to pan (trackpad two-finger scroll)
 * - Pinch or modifier+scroll to zoom, zoom-to-cursor
 */
export function R3FCamera({ onTransformChange }) {
  const controlsRef = useRef(null);
  const { camera, gl, size } = useThree();

  // Drag-to-pan
  useEffect(() => {
    return createPanHandler({
      canvas: gl.domElement,
      getCameraZ: () => camera.position.z,
      onPan: (worldDeltaX, worldDeltaY) => {
        camera.position.x += worldDeltaX;
        camera.position.y += worldDeltaY;
        if (controlsRef.current) {
          controlsRef.current.target.set(camera.position.x, camera.position.y, 0);
          controlsRef.current.update();
        }
        onTransformChange?.();
      },
    });
  }, [camera, gl]);

  // Wheel: scroll-to-pan or zoom-to-cursor
  useEffect(() => {
    const canvas = gl.domElement;

    const handleWheel = (event) => {
      if (!controlsRef.current) return;
      event.preventDefault();
      event.stopPropagation();

      const gesture = classifyWheelGesture(event);
      const rect = canvas.getBoundingClientRect();

      if (gesture === 'scroll-pan') {
        const { worldDeltaX, worldDeltaY } = calculatePan({
          screenDeltaX: -event.deltaX,
          screenDeltaY: -event.deltaY,
          cameraZ: camera.position.z,
          containerWidth: rect.width,
          containerHeight: rect.height,
        });
        camera.position.x += worldDeltaX;
        camera.position.y += worldDeltaY;
        controlsRef.current.target.set(camera.position.x, camera.position.y, 0);
        controlsRef.current.update();
      } else {
        // zoom-to-cursor
        const oldZ = camera.position.z;
        const isPinch = gesture === 'pinch';
        const newZ = Math.max(CAMERA_Z_MIN, Math.min(CAMERA_Z_MAX, oldZ * calculateZoomFactor(event.deltaY, isPinch)));
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

        camera.position.x = result.cameraX;
        camera.position.y = result.cameraY;
        camera.position.z = newZ;
        controlsRef.current.target.set(camera.position.x, camera.position.y, 0);
        controlsRef.current.update();
      }

      onTransformChange?.();
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [camera, gl, size]);

  return (
    <OrbitControls
      ref={controlsRef}
      enableRotate={false}
      enablePan={false}
      enableZoom={false}
      enableDamping
      dampingFactor={0.1}
      minDistance={CAMERA_Z_MIN}
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
    camera.position.set(centerX, centerY, z);
  };
}
