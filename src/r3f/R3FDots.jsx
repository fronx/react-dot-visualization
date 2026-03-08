import React, { useRef, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { createBevelStrokeMaterial, updateMaterialStroke } from './bevelStrokeMaterial.js';
import * as d3 from 'd3';

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
  const dynamicDotsRef = useRef([]);

  // Per-dot pulse state: time reference and animation phase
  const pulseTimeRef = useRef(0);

  const material = useMemo(
    () => createBevelStrokeMaterial(dotStroke || '#111', dotStrokeWidthFraction),
    [] // created once; uniforms updated below
  );

  const ringMaterial = useMemo(() => {
    const m = new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, side: THREE.FrontSide });
    return m;
  }, []);

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

  // Apply static instance attributes when data/style/hover changes.
  useEffect(() => {
    const mesh = meshRef.current;
    const ringMesh = ringMeshRef.current;
    if (!mesh) return;

    const dynamicDots = [];
    let needsMatrixUpdate = false;
    let needsColorUpdate = false;
    let needsRingMatrixUpdate = false;
    let needsRingColorUpdate = false;

    data.forEach((item, i) => {
      const customStyle = dotStyles.get(item.id) || {};
      const isHovered = item.id === hoveredId;
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

      if (pulse) {
        dynamicDots.push({
          index: i,
          x: item.x,
          y: -item.y,
          baseScale: scale,
          baseFill: fill,
          pulse,
        });
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

    if (needsMatrixUpdate) mesh.instanceMatrix.needsUpdate = true;
    if (needsColorUpdate && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (ringMesh && needsRingMatrixUpdate) {
      ringMesh.instanceMatrix.needsUpdate = true;
    }
    if (ringMesh && needsRingColorUpdate && ringMesh.instanceColor) {
      ringMesh.instanceColor.needsUpdate = true;
    }
  }, [data, dotStyles, pulseDots, defaultColor, defaultSize, hoveredId, hoverSizeMultiplier]);

  // Animate only pulsing dots each frame.
  useFrame((_, delta) => {
    const dynamicDots = dynamicDotsRef.current;
    if (!dynamicDots.length) return;

    const mesh = meshRef.current;
    const ringMesh = ringMeshRef.current;
    if (!mesh) return;

    pulseTimeRef.current += delta * 1000; // ms
    const t = pulseTimeRef.current;

    let needsMatrixUpdate = false;
    let needsColorUpdate = false;
    let needsRingMatrixUpdate = false;

    for (const dot of dynamicDots) {
      const { index, x, y, baseScale, baseFill, pulse } = dot;
      const duration = pulse.duration || 1250;
      const sizeRange = pulse.sizeRange || 0.3;
      const phase = (t % duration) / duration;

      let pulseMul;
      if (pulse.ringEffect) {
        const sine = Math.sin(phase * Math.PI * 2);
        pulseMul = pulse.pulseInward
          ? 1 - (sizeRange * (sine + 1) / 2)
          : 1 + (sizeRange * (sine + 1) / 2);
      } else {
        let eased;
        if (phase < 0.5) eased = d3.easeQuadOut(phase * 2);
        else eased = d3.easeQuadIn(1 - (phase - 0.5) * 2);
        pulseMul = pulse.pulseInward ? 1 - sizeRange * eased : 1 + sizeRange * eased;
      }

      _dummy.position.set(x, y, 0);
      _dummy.scale.setScalar(baseScale * pulseMul);
      _dummy.updateMatrix();
      mesh.setMatrixAt(index, _dummy.matrix);
      needsMatrixUpdate = true;

      // Pulse color interpolation only for non-ring pulses.
      if (pulse.pulseColor && !pulse.ringEffect) {
        let eased;
        if (phase < 0.5) eased = d3.easeQuadOut(phase * 2);
        else eased = d3.easeQuadIn(1 - (phase - 0.5) * 2);
        _color.set(d3.interpolate(baseFill, pulse.pulseColor)(eased));
        mesh.setColorAt(index, _color);
        needsColorUpdate = true;
      }

      if (ringMesh && pulse.ringEffect) {
        const ringPhase = ((t + 400) % duration) / duration;
        let ringScale = 0;
        if (ringPhase <= 0.8) {
          const normalized = ringPhase / 0.8;
          ringScale = baseScale * pulseMul * (1 + normalized * 1.5);
        }
        _dummy.position.set(x, y, -0.1);
        _dummy.scale.setScalar(ringScale);
        _dummy.updateMatrix();
        ringMesh.setMatrixAt(index, _dummy.matrix);
        needsRingMatrixUpdate = true;
      }
    }

    if (needsMatrixUpdate) mesh.instanceMatrix.needsUpdate = true;
    if (needsColorUpdate && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (needsRingMatrixUpdate && ringMesh) {
      ringMesh.instanceMatrix.needsUpdate = true;
    }
  });

  const count = data.length || 1;
  const hasPulseRings = pulseDots.size > 0 && [...pulseDots.values()].some(p => p.ringEffect);

  return (
    <>
      {/* Ring layer (behind dots) */}
      {hasPulseRings && (
        <instancedMesh
          ref={ringMeshRef}
          args={[undefined, undefined, count]}
          material={ringMaterial}
          raycast={() => null}
          frustumCulled={false}
        >
          <circleGeometry args={[BASE_RADIUS, 12]} />
        </instancedMesh>
      )}

      {/* Main dot layer */}
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, count]}
        material={material}
        raycast={() => null}
        frustumCulled={false}
      >
        <circleGeometry args={[BASE_RADIUS, 12]} />
      </instancedMesh>
    </>
  );
}
