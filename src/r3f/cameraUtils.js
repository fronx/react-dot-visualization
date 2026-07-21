/**
 * Camera math utilities for the R3F dot renderer.
 * Ported from vibseek/shared/camera.
 */

export const CAMERA_FOV_DEGREES = 10;
const CAMERA_FOV_RADIANS = CAMERA_FOV_DEGREES * (Math.PI / 180);
const ZOOM_FACTOR_BASE = 1.003;
const PINCH_ZOOM_MULTIPLIER = 3;
const DRAG_THRESHOLD = 4;

export function classifyWheelGesture(event, scrollZoomModifier = 'meta-or-alt') {
  if (event.ctrlKey) return 'pinch';
  const modifierHeld = scrollZoomModifier === 'meta'
    ? event.metaKey
    : scrollZoomModifier === 'alt'
      ? event.altKey
      : event.metaKey || event.altKey;
  if (modifierHeld) return 'scroll-zoom';
  return 'scroll-pan';
}

export function calculateZoomFactor(deltaY, isPinch = false) {
  const effective = isPinch ? deltaY * PINCH_ZOOM_MULTIPLIER : deltaY;
  return Math.pow(ZOOM_FACTOR_BASE, effective);
}

export function calculateZoomToCursor({ oldZ, newZ, cameraX, cameraY, cursorNDC, aspect }) {
  const oldH = 2 * oldZ * Math.tan(CAMERA_FOV_RADIANS / 2);
  const oldW = oldH * aspect;
  const graphX = cameraX + cursorNDC.x * (oldW / 2);
  const graphY = cameraY + cursorNDC.y * (oldH / 2);

  const newH = 2 * newZ * Math.tan(CAMERA_FOV_RADIANS / 2);
  const newW = newH * aspect;
  return {
    cameraX: graphX - cursorNDC.x * (newW / 2),
    cameraY: graphY - cursorNDC.y * (newH / 2),
  };
}

export function calculatePan({ screenDeltaX, screenDeltaY, cameraZ, containerWidth, containerHeight }) {
  const visibleH = 2 * cameraZ * Math.tan(CAMERA_FOV_RADIANS / 2);
  const pixelsPerUnit = containerHeight / visibleH;
  return {
    worldDeltaX: -screenDeltaX / pixelsPerUnit,
    worldDeltaY: screenDeltaY / pixelsPerUnit,
  };
}

/**
 * Compute camera Z needed to fit a data bounding box, with margin.
 */
export function computeFitZ(minX, maxX, minY, maxY, aspect, margin = 0.9) {
  const dataW = maxX - minX;
  const dataH = maxY - minY;
  if (dataW === 0 && dataH === 0) return 65;

  const neededForH = (dataH / 2 / margin) / Math.tan(CAMERA_FOV_RADIANS / 2);
  const neededForW = (dataW / 2 / margin) / Math.tan(CAMERA_FOV_RADIANS / 2) / aspect;
  return Math.max(neededForH, neededForW, 1);
}

export function createPanHandler({ canvas, getCameraZ, onPan, onPanStart, onPanEnd, onClick }) {
  let isPanning = false;
  let isPointerDown = false;
  let startX = 0, startY = 0, lastX = 0, lastY = 0;

  const down = (e) => {
    if (e.button !== 0) return;
    isPointerDown = true;
    startX = lastX = e.clientX;
    startY = lastY = e.clientY;
  };

  const move = (e) => {
    if (!isPointerDown) return;
    if (!isPanning) {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      isPanning = true;
      canvas.style.cursor = 'grabbing';
      onPanStart?.();
    }
    const rect = canvas.getBoundingClientRect();
    const { worldDeltaX, worldDeltaY } = calculatePan({
      screenDeltaX: e.clientX - lastX,
      screenDeltaY: e.clientY - lastY,
      cameraZ: getCameraZ(),
      containerWidth: rect.width,
      containerHeight: rect.height,
    });
    lastX = e.clientX;
    lastY = e.clientY;
    onPan(worldDeltaX, worldDeltaY);
  };

  // `fireClick` distinguishes a real release-on-canvas (mouseup) from the
  // pointer merely leaving the canvas mid-press (mouseleave): only the former
  // is a click. `isPanning` latches once the gesture passes DRAG_THRESHOLD, so
  // a drag that wanders out and back never counts as a click.
  const finish = (e, fireClick) => {
    if (isPanning) {
      // Clear, not 'grab': restore the resting cursor (default) rather than
      // leaving the canvas stuck showing a hand after every pan.
      canvas.style.cursor = '';
      onPanEnd?.();
    } else if (isPointerDown && fireClick) {
      onClick?.(e);
    }
    isPanning = false;
    isPointerDown = false;
  };
  const up = (e) => finish(e, true);
  const leave = (e) => finish(e, false);

  canvas.addEventListener('mousedown', down);
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseup', up);
  canvas.addEventListener('mouseleave', leave);
  return () => {
    canvas.removeEventListener('mousedown', down);
    canvas.removeEventListener('mousemove', move);
    canvas.removeEventListener('mouseup', up);
    canvas.removeEventListener('mouseleave', leave);
  };
}
