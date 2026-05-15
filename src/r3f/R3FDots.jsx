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
 * - hoveredId, hoverSizeMultiplier, hoverOpacity
 * - onHoverChange(id | null) — called when hovered dot changes
 * - onDotClick(item, event)
 * - onBackgroundClick(event)
 */
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
}) {
  const meshRef = useRef(null);
  const ringMeshRef = useRef(null);
  const ringAlphaAttrRef = useRef(null);
  const dynamicDotsRef = useRef([]);
  const dynamicDotsByIdRef = useRef(new Map());
  const dotInfoByIdRef = useRef(new Map());
  const hoveredIdRef = useRef(hoveredId);
  const prevHoveredIdRef = useRef(hoveredId);
  const prevHoverSizeMultiplierRef = useRef(hoverSizeMultiplier);

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
  }, [data.length, pulseDots]);

  // Apply static instance attributes when data/style changes.
  useEffect(() => {
    const mesh = meshRef.current;
    const ringMesh = ringMeshRef.current;
    if (!mesh) return;

    const dynamicDots = [];
    const dynamicDotsById = new Map();
    const dotInfoById = new Map();
    const activeHoveredId = hoveredIdRef.current;
    let needsMatrixUpdate = false;
    let needsColorUpdate = false;
    let needsRingMatrixUpdate = false;
    let needsRingColorUpdate = false;

    data.forEach((item, i) => {
      const customStyle = dotStyles.get(item.id) || {};
      const isHovered = item.id === activeHoveredId;
      const pulse = pulseDots.get(item.id);

      const baseSize = customStyle.r ?? item.size ?? defaultSize;
      const scale = isHovered ? baseSize * hoverSizeMultiplier : baseSize;
      const fill = customStyle.fill || customStyle.color || item.color || defaultColor || '#7c6fff';

      _dummy.position.set(item.x, -item.y, 0);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
      needsMatrixUpdate = true;

      _color.set(fill);
      mesh.setColorAt(i, _color);
      needsColorUpdate = true;

      dotInfoById.set(item.id, {
        index: i,
        x: item.x,
        y: -item.y,
        baseScale: baseSize,
      });

      if (pulse) {
        const dynamicDot = {
          id: item.id,
          index: i,
          x: item.x,
          y: -item.y,
          baseScale: scale,
          baseFill: fill,
        };
        dynamicDots.push(dynamicDot);
        dynamicDotsById.set(item.id, dynamicDot);
      }

      // Ring effect
      if (ringMesh) {
        _dummy.position.set(item.x, -item.y, -0.1);
        _dummy.scale.setScalar(0);
        _dummy.updateMatrix();
        ringMesh.setMatrixAt(i, _dummy.matrix);
        needsRingMatrixUpdate = true;

        _ringColor.set(pulse?.pulseColor || fill);
        ringMesh.setColorAt(i, _ringColor);
        needsRingColorUpdate = true;
      }
    });

    dynamicDotsRef.current = dynamicDots;
    dynamicDotsByIdRef.current = dynamicDotsById;
    dotInfoByIdRef.current = dotInfoById;
    prevHoveredIdRef.current = activeHoveredId;
    prevHoverSizeMultiplierRef.current = hoverSizeMultiplier;

    if (needsMatrixUpdate) mesh.instanceMatrix.needsUpdate = true;
    if (needsColorUpdate && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (ringMesh && needsRingMatrixUpdate) {
      ringMesh.instanceMatrix.needsUpdate = true;
    }
    if (ringMesh && needsRingColorUpdate && ringMesh.instanceColor) {
      ringMesh.instanceColor.needsUpdate = true;
    }
  }, [data, dotStyles, pulseDots, defaultColor, defaultSize, hoverSizeMultiplier]);

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

    let needsMatrixUpdate = false;
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

      const dynamicDot = dynamicDotsByIdRef.current.get(id);
      if (dynamicDot) {
        dynamicDot.baseScale = scale;
      }
    });

    if (needsMatrixUpdate) {
      mesh.instanceMatrix.needsUpdate = true;
    }

    hoveredIdRef.current = hoveredId;
    prevHoveredIdRef.current = hoveredId;
    prevHoverSizeMultiplierRef.current = hoverSizeMultiplier;
  }, [hoveredId, hoverSizeMultiplier]);

  // Animate only pulsing dots each frame. Phase + ring geometry are derived
  // from the shared hook+utility so behavior matches the Canvas renderer.
  useFrame((state) => {
    const dynamicDots = dynamicDotsRef.current;
    if (!dynamicDots.length) return;

    const mesh = meshRef.current;
    const ringMesh = ringMeshRef.current;
    const ringAlphaAttr = ringAlphaAttrRef.current;
    if (!mesh) return;

    // Screen-pixels per world unit (CSS pixels) at current camera distance.
    // Adaptive ring sizing wants viewBoxScale in canvas-pixel space and a
    // separate canvasDPR — we feed pxPerWorldUnit_CSS * dpr as viewBoxScale
    // and zoomScale = 1 (R3F bakes zoom into camera distance).
    const heightCSS = state.size.height;
    const camZ = state.camera.position.z;
    const dpr = state.gl.getPixelRatio();
    const pxPerWorldUnit_CSS = heightCSS / (2 * camZ * TAN_HALF_FOV);
    const viewBoxScale = pxPerWorldUnit_CSS * dpr;

    let needsMatrixUpdate = false;
    let needsColorUpdate = false;
    let needsRingMatrixUpdate = false;
    let needsRingAlphaUpdate = false;
    let needsRingColorUpdate = false;

    for (const dot of dynamicDots) {
      const { id, index, x, y, baseScale, baseFill } = dot;
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
