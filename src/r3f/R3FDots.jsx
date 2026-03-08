import React, { useRef, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { createBevelStrokeMaterial, updateMaterialStroke } from './bevelStrokeMaterial.js';
import * as d3 from 'd3';

const _dummy = new THREE.Object3D();
const _color = new THREE.Color();

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

  // Track animation time
  useFrame((_, delta) => {
    pulseTimeRef.current += delta * 1000; // ms
  });

  // Animate instances each frame
  useFrame(() => {
    const mesh = meshRef.current;
    const ringMesh = ringMeshRef.current;
    if (!mesh) return;

    const t = pulseTimeRef.current;
    let needsMatrixUpdate = false;
    let needsColorUpdate = false;
    let needsRingUpdate = false;

    data.forEach((item, i) => {
      const customStyle = dotStyles.get(item.id) || {};
      const isHovered = item.id === hoveredId;
      const pulse = pulseDots.get(item.id);

      const baseSize = customStyle.r ?? item.size ?? defaultSize;
      let scale = baseSize;
      if (isHovered) scale *= hoverSizeMultiplier;

      if (pulse) {
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
          let tEased;
          if (phase < 0.5) tEased = d3.easeQuadOut(phase * 2);
          else tEased = d3.easeQuadIn(1 - (phase - 0.5) * 2);
          pulseMul = pulse.pulseInward ? 1 - sizeRange * tEased : 1 + sizeRange * tEased;
        }
        scale *= pulseMul;
      }

      _dummy.position.set(item.x, -item.y, 0);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
      needsMatrixUpdate = true;

      // Color
      const fill = customStyle.fill || customStyle.color || item.color || defaultColor || '#7c6fff';
      _color.set(fill);
      if (pulse?.pulseColor && !pulse.ringEffect) {
        const duration = pulse.duration || 1250;
        const phase = (t % duration) / duration;
        let tEased;
        if (phase < 0.5) tEased = d3.easeQuadOut(phase * 2);
        else tEased = d3.easeQuadIn(1 - (phase - 0.5) * 2);
        const interp = d3.interpolate(fill, pulse.pulseColor);
        _color.set(interp(tEased));
      }
      mesh.setColorAt(i, _color);
      needsColorUpdate = true;

      // Ring effect
      if (ringMesh) {
        const ringPulse = pulse?.ringEffect ? pulse : null;
        let ringScale = 0;
        let ringOpacity = 0;
        if (ringPulse) {
          const duration = ringPulse.duration || 1250;
          const ringPhase = ((t + 400) % duration) / duration;
          if (ringPhase <= 0.8) {
            const normalized = ringPhase / 0.8;
            const targetScale = scale * (1 + normalized * 1.5);
            ringScale = targetScale;
            ringOpacity = 1 - normalized;
          }
        }
        _dummy.position.set(item.x, -item.y, -0.1);
        _dummy.scale.setScalar(ringScale);
        _dummy.updateMatrix();
        ringMesh.setMatrixAt(i, _dummy.matrix);
        const ringColor = ringPulse?.pulseColor ? new THREE.Color(ringPulse.pulseColor) : _color;
        ringMesh.setColorAt(i, ringColor);
        needsRingUpdate = true;
      }
    });

    if (needsMatrixUpdate) mesh.instanceMatrix.needsUpdate = true;
    if (needsColorUpdate && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (needsRingUpdate && ringMesh) {
      ringMesh.instanceMatrix.needsUpdate = true;
      if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true;
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
          <circleGeometry args={[BASE_RADIUS, 16]} />
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
        <circleGeometry args={[BASE_RADIUS, 16]} />
      </instancedMesh>
    </>
  );
}

