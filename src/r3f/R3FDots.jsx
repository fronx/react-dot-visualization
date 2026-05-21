import React, { useRef, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import {
  createBevelStrokeMaterial,
  updateMaterialStroke,
  createPulseDiscMaterial,
} from './bevelStrokeMaterial.js';
import { usePulseAnimation } from '../usePulseAnimation.js';
import { calculateAdaptiveRingRadius } from '../pulseRingUtils.js';
import { CAMERA_FOV_DEGREES } from './cameraUtils.js';
import { applyDotStylesToInstances } from './instanceUpdate.js';

const CAMERA_FOV_RAD = CAMERA_FOV_DEGREES * (Math.PI / 180);
const TAN_HALF_FOV = Math.tan(CAMERA_FOV_RAD / 2);

const _dummy = new THREE.Object3D();
const _color = new THREE.Color();
const _ringColor = new THREE.Color();

const BASE_RADIUS = 1.0; // geometry radius in local space

/**
 * Instanced dot mesh.
 * - data: array of {id, x, y, size?, color?}
 * - dotStyles: Map<id, {r?, fill?, opacity?, stroke?, strokeWidth?, pulse?}>
 * - defaultColor, defaultSize, defaultOpacity
 * - dotStroke, dotStrokeWidth (global stroke, dotStrokeWidth is fraction of radius 0-1)
 * - hoveredId, hoverSizeMultiplier, hoverOpacity (visual hover state only;
 *   hover detection + click routing live in HoverDetector)
 */
const EMPTY_RADIUS_OVERRIDES = new Map();

export function R3FDots({
  data,
  dotStyles,
  defaultColor,
  defaultSize,
  defaultOpacity,
  dotStroke,
  dotStrokeWidthFraction = 0.05,
  hoveredId,
  hoverSizeMultiplier = 1.5,
  hoverOpacity = 1.0,
  radiusOverrides = EMPTY_RADIUS_OVERRIDES,
  liveTransitionDataRef = null,
}) {
  const meshRef = useRef(null);
  const ringMeshRef = useRef(null);
  const ringAlphaAttrRef = useRef(null);
  const dotAlphaAttrRef = useRef(null);
  const dotFocusAttrRef = useRef(null);
  const dynamicDotsRef = useRef([]);
  const dynamicDotsByIdRef = useRef(new Map());
  const dotInfoByIdRef = useRef(new Map());
  const hoveredIdRef = useRef(hoveredId);
  const prevHoveredIdRef = useRef(hoveredId);
  const prevHoverSizeMultiplierRef = useRef(hoverSizeMultiplier);

  // Previous values of non-data deps — used by the sim-completion fast path
  // in the big effect below.
  const prevDotStylesRef = useRef(dotStyles);
  const prevPulseDotsRef = useRef(null);
  const prevDefaultColorRef = useRef(defaultColor);
  const prevDefaultSizeRef = useRef(defaultSize);
  const prevDefaultOpacityRef = useRef(defaultOpacity);
  const prevHoverOpacityRef = useRef(hoverOpacity);
  const prevHoverSizeMultRef = useRef(hoverSizeMultiplier);
  const prevRadiusOverridesRef = useRef(radiusOverrides);
  // Snapshot of the last applyDotStylesToInstances inputs + outputs. Lets the
  // next call take the delta path when only style refs flap (data positions
  // stable). Null = no prior snapshot → full rebuild.
  const prevSnapshotRef = useRef(null);

  const material = useMemo(
    () => createBevelStrokeMaterial(dotStroke || '#111', dotStrokeWidthFraction),
    [] // created once; uniforms updated below
  );

  const ringMaterial = useMemo(() => createPulseDiscMaterial(), []);

  // Shared pulse phase + frame budgeting with Canvas renderer. The interpolator
  // returns {sizeMultiplier, opacityMultiplier, color, ringData} per dot.
  // R3F drives painting via useFrame, so the rAF callback is a no-op.
  const getPulseState = usePulseAnimation(dotStyles, undefined, false, true);

  // Update stroke uniforms when props change
  useEffect(() => {
    updateMaterialStroke(material, dotStroke || '#111', dotStrokeWidthFraction);
  }, [material, dotStroke, dotStrokeWidthFraction]);

  // Count pulsing dots that need ring effect
  const pulseDots = useMemo(() => {
    const result = new Map();
    for (const [id, style] of dotStyles) {
      if (style?.pulse) result.set(id, style.pulse);
    }
    return result;
  }, [dotStyles]);

  useEffect(() => {
    hoveredIdRef.current = hoveredId;
  }, [hoveredId]);

  // (Re)attach per-instance alpha buffer to the ring geometry when the
  // instance count changes. Read in pulseDiscMaterial's vertex shader.
  useEffect(() => {
    const ringMesh = ringMeshRef.current;
    if (!ringMesh) {
      ringAlphaAttrRef.current = null;
      return;
    }
    const count = data.length || 1;
    const geom = ringMesh.geometry;
    let attr = geom.getAttribute('instanceAlpha');
    if (!attr || attr.array.length < count) {
      attr = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
      geom.setAttribute('instanceAlpha', attr);
    }
    ringAlphaAttrRef.current = attr;
    // Pre-create instanceColor so the slow path can write directly to the
    // backing Float32Array without Three.js's lazy-on-setColorAt creation.
    if (!ringMesh.instanceColor || ringMesh.instanceColor.array.length < count * 3) {
      ringMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    }
  }, [data.length, pulseDots]);

  // (Re)attach per-instance alpha buffer to the dot geometry. Drives
  // defaultOpacity, dotStyles.opacity, hoverOpacity, and pulse.opacityRange.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) {
      dotAlphaAttrRef.current = null;
      dotFocusAttrRef.current = null;
      return;
    }
    const count = data.length || 1;
    const geom = mesh.geometry;
    let alphaAttr = geom.getAttribute('instanceAlpha');
    if (!alphaAttr || alphaAttr.array.length < count) {
      alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(count).fill(1), 1);
      geom.setAttribute('instanceAlpha', alphaAttr);
    }
    dotAlphaAttrRef.current = alphaAttr;
    // Per-instance focus flag: 1.0 = render as inner+outer-ring focus visual,
    // 0.0 = normal disc + stroke. Defaults to 0.
    let focusAttr = geom.getAttribute('instanceFocus');
    if (!focusAttr || focusAttr.array.length < count) {
      focusAttr = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
      geom.setAttribute('instanceFocus', focusAttr);
    }
    dotFocusAttrRef.current = focusAttr;
    // Pre-create instanceColor (same rationale as the ring mesh above).
    if (!mesh.instanceColor || mesh.instanceColor.array.length < count * 3) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    }
  }, [data.length]);

  // Apply static instance attributes when data/style changes.
  useEffect(() => {
    const mesh = meshRef.current;
    const ringMesh = ringMeshRef.current;
    const dotAlphaAttr = dotAlphaAttrRef.current;
    const dotFocusAttr = dotFocusAttrRef.current;
    if (!mesh) return;

    // Fast path: sim-completion (positions changed, everything else stable).
    // Same translation-column patch as Pass 1 in useFrame.
    const prevDotInfo = dotInfoByIdRef.current;
    const dotStylesSame = dotStyles === prevDotStylesRef.current;
    const pulseDotsSame = pulseDots === prevPulseDotsRef.current;
    const radiusOverridesSame = radiusOverrides === prevRadiusOverridesRef.current;
    const nonDataDepsUnchanged =
      dotStylesSame
      && pulseDotsSame
      && defaultColor === prevDefaultColorRef.current
      && defaultSize === prevDefaultSizeRef.current
      && defaultOpacity === prevDefaultOpacityRef.current
      && hoverOpacity === prevHoverOpacityRef.current
      && hoverSizeMultiplier === prevHoverSizeMultRef.current
      && radiusOverridesSame;

    if (nonDataDepsUnchanged && prevDotInfo.size === data.length && data.length > 0) {
      const matrixArr = mesh.instanceMatrix.array;
      const ringArr = ringMesh ? ringMesh.instanceMatrix.array : null;
      const dynById = dynamicDotsByIdRef.current;
      let fastPathOk = true;
      for (let i = 0; i < data.length; i++) {
        const item = data[i];
        const info = prevDotInfo.get(item.id);
        if (!info) { fastPathOk = false; break; }
        const worldY = -item.y;
        info.x = item.x;
        info.y = worldY;
        const off = info.index * 16;
        matrixArr[off + 12] = item.x;
        matrixArr[off + 13] = worldY;
        if (ringArr) {
          ringArr[off + 12] = item.x;
          ringArr[off + 13] = worldY;
        }
        const dyn = dynById.get(item.id);
        if (dyn) {
          dyn.x = item.x;
          dyn.y = worldY;
        }
      }
      if (fastPathOk) {
        mesh.instanceMatrix.needsUpdate = true;
        if (ringMesh) ringMesh.instanceMatrix.needsUpdate = true;
        // Advance the delta snapshot's data ref. The fast path mutated
        // dotInfoById positions in place (that Map IS the snapshot's), and
        // styles are unchanged here — so the only thing the next delta needs
        // is the new data ref. Without this, the next style-only change sees
        // prev.data !== data and is forced down the full path.
        if (prevSnapshotRef.current) prevSnapshotRef.current.data = data;
        return;
      }
    }

    prevDotStylesRef.current = dotStyles;
    prevPulseDotsRef.current = pulseDots;
    prevDefaultColorRef.current = defaultColor;
    prevDefaultSizeRef.current = defaultSize;
    prevDefaultOpacityRef.current = defaultOpacity;
    prevHoverOpacityRef.current = hoverOpacity;
    prevHoverSizeMultRef.current = hoverSizeMultiplier;
    prevRadiusOverridesRef.current = radiusOverrides;

    const activeHoveredId = hoveredIdRef.current;
    const defaultsSnap = {
      defaultColor, defaultSize, defaultOpacity, hoverOpacity, hoverSizeMultiplier,
    };
    const result = applyDotStylesToInstances({
      data,
      dotStyles,
      pulseDots,
      radiusOverrides,
      defaults: defaultsSnap,
      hoveredId: activeHoveredId,
      buffers: {
        matrix: mesh.instanceMatrix.array,
        color: mesh.instanceColor.array,
        alpha: dotAlphaAttr ? dotAlphaAttr.array : null,
        focus: dotFocusAttr ? dotFocusAttr.array : null,
      },
      ringBuffers: ringMesh ? {
        matrix: ringMesh.instanceMatrix.array,
        color: ringMesh.instanceColor.array,
      } : null,
      prev: prevSnapshotRef.current,
    });

    dynamicDotsRef.current = result.dynamicDots;
    dynamicDotsByIdRef.current = result.dynamicDotsById;
    dotInfoByIdRef.current = result.dotInfoById;
    prevHoveredIdRef.current = activeHoveredId;
    prevHoverSizeMultiplierRef.current = hoverSizeMultiplier;

    prevSnapshotRef.current = {
      data, dotStyles, pulseDots, radiusOverrides,
      defaults: defaultsSnap, hoveredId: activeHoveredId,
      dotInfoById: result.dotInfoById,
      dynamicDots: result.dynamicDots,
      dynamicDotsById: result.dynamicDotsById,
    };

    if (result.dirty.matrix) mesh.instanceMatrix.needsUpdate = true;
    if (result.dirty.color && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (result.dirty.alpha && dotAlphaAttr) dotAlphaAttr.needsUpdate = true;
    if (result.dirty.focus && dotFocusAttr) dotFocusAttr.needsUpdate = true;
    if (ringMesh && result.dirty.ringMatrix) ringMesh.instanceMatrix.needsUpdate = true;
    if (ringMesh && result.dirty.ringColor && ringMesh.instanceColor) {
      ringMesh.instanceColor.needsUpdate = true;
    }
  }, [data, dotStyles, pulseDots, defaultColor, defaultSize, defaultOpacity, hoverOpacity, hoverSizeMultiplier, radiusOverrides]);

  // Hover updates should only touch the previous and current hovered instances.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const prevHoveredId = prevHoveredIdRef.current;
    const prevMultiplier = prevHoverSizeMultiplierRef.current;
    if (prevHoveredId === hoveredId && prevMultiplier === hoverSizeMultiplier) return;

    const idsToUpdate = new Set();
    if (prevHoveredId !== null && prevHoveredId !== undefined) idsToUpdate.add(prevHoveredId);
    if (hoveredId !== null && hoveredId !== undefined) idsToUpdate.add(hoveredId);

    const dotAlphaAttr = dotAlphaAttrRef.current;
    let needsMatrixUpdate = false;
    let needsAlphaUpdate = false;
    idsToUpdate.forEach((id) => {
      const dotInfo = dotInfoByIdRef.current.get(id);
      if (!dotInfo) return;

      const isHovered = id === hoveredId;
      const scale = isHovered
        ? dotInfo.baseScale * hoverSizeMultiplier
        : dotInfo.baseScale;

      _dummy.position.set(dotInfo.x, dotInfo.y, 0);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      mesh.setMatrixAt(dotInfo.index, _dummy.matrix);
      needsMatrixUpdate = true;

      // customStyle.opacity, if explicit, wins over hover (matches Canvas).
      if (dotAlphaAttr) {
        const nextAlpha = dotInfo.customOpacity !== undefined
          ? dotInfo.customOpacity
          : (isHovered ? hoverOpacity : defaultOpacity);
        dotInfo.baseOpacity = nextAlpha;
        dotAlphaAttr.array[dotInfo.index] = nextAlpha;
        needsAlphaUpdate = true;
      }

      const dynamicDot = dynamicDotsByIdRef.current.get(id);
      if (dynamicDot) {
        dynamicDot.baseScale = scale;
        dynamicDot.baseOpacity = dotInfo.baseOpacity;
      }
    });

    if (needsMatrixUpdate) {
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (needsAlphaUpdate && dotAlphaAttr) {
      dotAlphaAttr.needsUpdate = true;
    }

    hoveredIdRef.current = hoveredId;
    prevHoveredIdRef.current = hoveredId;
    prevHoverSizeMultiplierRef.current = hoverSizeMultiplier;
  }, [hoveredId, hoverSizeMultiplier, hoverOpacity, defaultOpacity]);

  // Per-frame loop. Two responsibilities:
  //   1. Live decollision: when the scheduler is mid-simulation,
  //      `liveTransitionDataRef.current` carries fresh positions every tick.
  //      Write them straight into the instance matrices here — no React
  //      re-render, so R3FDots' big data-effect rebuild does NOT run 60×/sec.
  //      Canvas achieves the same thing via `renderCanvasWithData`.
  //   2. Pulse animation: as before, only iterates pulsing dots.
  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const ringMesh = ringMeshRef.current;
    const ringAlphaAttr = ringAlphaAttrRef.current;
    const dotAlphaAttr = dotAlphaAttrRef.current;
    const dynamicDots = dynamicDotsRef.current;
    const liveData = liveTransitionDataRef?.current;
    const dotInfoById = dotInfoByIdRef.current;
    const activeHoveredId = hoveredIdRef.current;

    let needsMatrixUpdate = false;
    let needsColorUpdate = false;
    let needsAlphaUpdate = false;
    let needsRingMatrixUpdate = false;
    let needsRingAlphaUpdate = false;
    let needsRingColorUpdate = false;

    // Pass 1: live decollision positions (no-op when scheduler isn't running).
    //
    // For N=50k+ dots at 60fps, `_dummy.updateMatrix()` per dot dominates —
    // Matrix4.compose() rebuilds the full quat-scaled matrix in JS each call.
    // Scale + rotation don't change during decollision (only translation
    // does), so we patch the translation columns of the instance matrix
    // directly. Each matrix occupies 16 floats; translation lives at
    // offsets 12 (tx) and 13 (ty). The hover useEffect uses Matrix4.compose
    // for its 2-dot path, so hover-induced scale changes still land correctly.
    if (liveData && dotInfoById.size > 0) {
      const matrixArr = mesh.instanceMatrix.array;
      for (let i = 0; i < liveData.length; i++) {
        const item = liveData[i];
        const info = dotInfoById.get(item.id);
        if (!info) continue;
        const worldY = -item.y;
        info.x = item.x;
        info.y = worldY;
        // Keep the pulse-cache copy in lockstep so Pass 2 reads fresh positions.
        const dyn = dynamicDotsByIdRef.current.get(item.id);
        if (dyn) {
          dyn.x = item.x;
          dyn.y = worldY;
        }
        const off = info.index * 16;
        matrixArr[off + 12] = item.x;
        matrixArr[off + 13] = worldY;
      }
      needsMatrixUpdate = true;
    }

    if (!dynamicDots.length) {
      if (needsMatrixUpdate) mesh.instanceMatrix.needsUpdate = true;
      return;
    }

    // Screen-pixels per world unit (CSS pixels) at current camera distance.
    // Adaptive ring sizing wants viewBoxScale in canvas-pixel space and a
    // separate canvasDPR — we feed pxPerWorldUnit_CSS * dpr as viewBoxScale
    // and zoomScale = 1 (R3F bakes zoom into camera distance).
    const heightCSS = state.size.height;
    const camZ = state.camera.position.z;
    const dpr = state.gl.getPixelRatio();
    const pxPerWorldUnit_CSS = heightCSS / (2 * camZ * TAN_HALF_FOV);
    const viewBoxScale = pxPerWorldUnit_CSS * dpr;

    for (const dot of dynamicDots) {
      const { id, index, x, y, baseScale, baseFill, baseOpacity } = dot;
      const pulseState = getPulseState(id, baseFill);

      _dummy.position.set(x, y, 0);
      _dummy.scale.setScalar(baseScale * pulseState.sizeMultiplier);
      _dummy.updateMatrix();
      mesh.setMatrixAt(index, _dummy.matrix);
      needsMatrixUpdate = true;

      if (pulseState.color && pulseState.color !== baseFill) {
        _color.set(pulseState.color);
        mesh.setColorAt(index, _color);
        needsColorUpdate = true;
      }

      if (dotAlphaAttr) {
        const nextAlpha = baseOpacity * pulseState.opacityMultiplier;
        if (dotAlphaAttr.array[index] !== nextAlpha) {
          dotAlphaAttr.array[index] = nextAlpha;
          needsAlphaUpdate = true;
        }
      }

      if (ringMesh) {
        const ringData = pulseState.ringData;
        if (ringData) {
          const ringRadius = calculateAdaptiveRingRadius({
            radius: baseScale,
            animationPhase: ringData.animationPhase,
            viewBoxScale,
            zoomScale: 1,
            targetPixels: ringData.options?.targetPixels,
            minRatio: ringData.options?.minRatio,
            canvasDPR: dpr,
          });
          _dummy.position.set(x, y, -0.1);
          _dummy.scale.setScalar(ringRadius);
          _dummy.updateMatrix();
          ringMesh.setMatrixAt(index, _dummy.matrix);
          needsRingMatrixUpdate = true;

          if (ringAlphaAttr) {
            ringAlphaAttr.array[index] = ringData.opacity;
            needsRingAlphaUpdate = true;
          }

          if (ringData.color) {
            _ringColor.set(ringData.color);
            ringMesh.setColorAt(index, _ringColor);
            needsRingColorUpdate = true;
          }
        } else if (ringAlphaAttr && ringAlphaAttr.array[index] !== 0) {
          // Pulse cycle gap: hide the ring instance.
          ringAlphaAttr.array[index] = 0;
          needsRingAlphaUpdate = true;
        }
      }
    }

    if (needsMatrixUpdate) mesh.instanceMatrix.needsUpdate = true;
    if (needsColorUpdate && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (needsAlphaUpdate && dotAlphaAttr) dotAlphaAttr.needsUpdate = true;
    if (ringMesh && needsRingMatrixUpdate) ringMesh.instanceMatrix.needsUpdate = true;
    if (ringMesh && needsRingColorUpdate && ringMesh.instanceColor) {
      ringMesh.instanceColor.needsUpdate = true;
    }
    if (ringAlphaAttr && needsRingAlphaUpdate) ringAlphaAttr.needsUpdate = true;
  });

  const count = data.length || 1;
  const hasPulseRings = pulseDots.size > 0 && [...pulseDots.values()].some(p => p.ringEffect);

  return (
    <>
      {/* Ring layer (behind dots) — SDF disc with per-instance alpha for fade-out */}
      {hasPulseRings && (
        <instancedMesh
          ref={ringMeshRef}
          args={[undefined, undefined, count]}
          material={ringMaterial}
          raycast={() => null}
          frustumCulled={false}
        >
          <planeGeometry args={[BASE_RADIUS * 2, BASE_RADIUS * 2]} />
        </instancedMesh>
      )}

      {/* Main dot layer — plane geometry; SDF shader defines the circular silhouette */}
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, count]}
        material={material}
        raycast={() => null}
        frustumCulled={false}
      >
        <planeGeometry args={[BASE_RADIUS * 2, BASE_RADIUS * 2]} />
      </instancedMesh>
    </>
  );
}
