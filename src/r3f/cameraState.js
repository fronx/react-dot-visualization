import { CAMERA_FOV_DEGREES, computeFitZ } from './cameraUtils.js';

const CAMERA_FOV_RADIANS = CAMERA_FOV_DEGREES * (Math.PI / 180);
const CAMERA_Z_MIN = 0.5;
const CAMERA_Z_MAX = 5000;
const VIEWBOX_HEIGHT = 100;

function isFinitePositiveSize(size) {
  return Number.isFinite(size?.width) && size.width > 0
    && Number.isFinite(size?.height) && size.height > 0;
}

export function isFiniteCameraPosition(position) {
  return position != null
    && Number.isFinite(position.x)
    && Number.isFinite(position.y)
    && Number.isFinite(position.z)
    && position.z > 0;
}

export function isFiniteCameraTransform(transform) {
  return transform != null
    && Number.isFinite(transform.x)
    && Number.isFinite(transform.y)
    && Number.isFinite(transform.k)
    && transform.k > 0;
}

// Invert the D3/viewBox transform used by Canvas and the public imperative API
// into Three's camera space. Data Y is negated when rendered, so `(y - 50) / k`
// already carries the SVG-down to world-up convention; no second negation.
export function cameraPositionFromTransform(transform, size) {
  if (!isFiniteCameraTransform(transform) || !isFinitePositiveSize(size)) return null;
  const viewBoxWidth = (size.width / size.height) * VIEWBOX_HEIGHT;
  const position = {
    x: (viewBoxWidth / 2 - transform.x) / transform.k,
    y: (transform.y - VIEWBOX_HEIGHT / 2) / transform.k,
    z: Math.max(
      CAMERA_Z_MIN,
      Math.min(CAMERA_Z_MAX, VIEWBOX_HEIGHT / (transform.k * 2 * Math.tan(CAMERA_FOV_RADIANS / 2))),
    ),
  };
  return isFiniteCameraPosition(position) ? position : null;
}

function fallbackCameraPosition(data, size) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const item of data) {
    if (!Number.isFinite(item?.x) || !Number.isFinite(item?.y)) continue;
    if (item.x < minX) minX = item.x;
    if (item.x > maxX) maxX = item.x;
    if (item.y < minY) minY = item.y;
    if (item.y > maxY) maxY = item.y;
  }
  if (!Number.isFinite(minX)) return null;
  const position = {
    x: (minX + maxX) / 2,
    y: -((minY + maxY) / 2),
    z: computeFitZ(minX, maxX, minY, maxY, size.width / size.height, 0.85),
  };
  return isFiniteCameraPosition(position) ? position : null;
}

export function resolveInitialCameraPosition({ data, size, initialTransform, computeFitTarget }) {
  if (!data?.length || !isFinitePositiveSize(size)) return null;
  // A corrupt remembered transform is absence, not authority. Prefer the same
  // occlusion-aware fit as zoomToVisible, retaining the raw-bounds fallback for
  // consumers that do not provide that fit surface.
  const restored = cameraPositionFromTransform(initialTransform, size);
  if (restored) return restored;
  const fitted = computeFitTarget?.() ?? null;
  if (isFiniteCameraPosition(fitted)) return fitted;
  return fallbackCameraPosition(data, size);
}

export function cameraMoveMode({ start, target, duration }) {
  if (!isFiniteCameraPosition(target)) return 'reject';
  if (!(duration > 0) || !isFiniteCameraPosition(start)) return 'instant';
  return 'animate';
}
