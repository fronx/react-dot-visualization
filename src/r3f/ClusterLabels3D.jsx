import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Billboard } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { clamp01 } from './labelFade.js';

// In-scene cluster captions for the R3F/WebGPU renderer: camera-facing text
// billboards positioned at per-cluster 2D anchors, sharp at any zoom (real
// glyph geometry, not raster), that fade with zoom. The text-geometry engine
// is injected (`createTextGeometry`) so this file carries no font/WASM
// dependency — consumers supply a builder (e.g. three-text). Targets the
// WebGPU backend: the glyph mesh uses MeshBasicNodeMaterial.
// Zoom-fade helpers (smoothstep, makeZoomFade) live in ./labelFade.js so they
// can be imported without the three/drei stack.

const DEFAULT_MIN_SCREEN_PX = 22;
const DEFAULT_FONT_SIZE = 52;

function ClusterLabels3D({
  clusters = [],
  createTextGeometry,
  fontSize = DEFAULT_FONT_SIZE,
  minScreenPx = DEFAULT_MIN_SCREEN_PX,
  fadeOpacity,
  labelZ = 0,
  defaultColor = '#ffffff',
  shadowColor = '#000000',
  shadowStrength = 0.8,
  onClusterClick,
  onClusterHover,
}) {
  const { camera, size: viewport } = useThree();
  const registry = useRef(new Map());
  const worldPos = useMemo(() => new THREE.Vector3(), []);

  const register = useCallback((id, entry) => {
    if (entry) registry.current.set(id, entry);
    else registry.current.delete(id);
  }, []);

  useFrame(() => {
    const zoomOpacity = fadeOpacity ? clamp01(fadeOpacity(camera.position.z)) : 1;
    // minScreenPx <= 0 keeps each label at its own world size (here, scaled to
    // the cluster footprint); only the floor path needs the per-frame distance.
    const floored = minScreenPx > 0;
    const tanHalfFov = floored ? Math.tan(THREE.MathUtils.degToRad(camera.fov ?? 10) / 2) : 0;
    registry.current.forEach((entry) => {
      const { billboard, material, shadowMaterial, baseOpacity } = entry;
      if (!billboard) return;
      if (floored) {
        const distance = billboard.getWorldPosition(worldPos).distanceTo(camera.position);
        const unitsPerPixel = (2 * tanHalfFov * Math.max(distance, 1e-3)) / viewport.height;
        billboard.scale.setScalar(Math.max(1, (minScreenPx * unitsPerPixel) / entry.fontSize));
      }

      const opacity = zoomOpacity * baseOpacity;
      if (Math.abs(material.opacity - opacity) > 0.004) material.opacity = opacity;
      if (shadowMaterial) {
        const shadowOpacity = opacity * shadowStrength;
        if (Math.abs(shadowMaterial.opacity - shadowOpacity) > 0.004) {
          shadowMaterial.opacity = shadowOpacity;
        }
      }
    });
  });

  if (!clusters.length || !createTextGeometry) return null;

  return (
    <>
      {clusters.map((cluster) => (
        <ClusterLabelSprite
          key={cluster.id}
          cluster={cluster}
          createTextGeometry={createTextGeometry}
          fontSize={fontSize}
          labelZ={labelZ}
          color={cluster.color ?? defaultColor}
          shadowColor={shadowColor}
          shadowStrength={shadowStrength}
          register={register}
          onClusterClick={onClusterClick}
          onClusterHover={onClusterHover}
        />
      ))}
    </>
  );
}

function ClusterLabelSprite({
  cluster,
  createTextGeometry,
  fontSize,
  labelZ,
  color,
  shadowColor,
  shadowStrength,
  register,
  onClusterClick,
  onClusterHover,
}) {
  const [geometry, setGeometry] = useState(null);
  const [anchor, setAnchor] = useState([0, 0]);
  const billboardRef = useRef(null);
  const entryRef = useRef(null);

  const labelFontSize = cluster.fontSize ?? fontSize;

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(createTextGeometry(cluster.text, { size: labelFontSize }))
      .then((info) => {
        // The factory owns geometry lifetime (it may cache/share instances), so
        // we never dispose it here — this component only owns its materials.
        if (cancelled) return;
        const { min, max } = info.planeBounds;
        setAnchor([(min.x + max.x) / 2, (min.y + max.y) / 2]);
        setGeometry(info.geometry);
      })
      .catch((err) => console.error('[ClusterLabels3D] text geometry failed', cluster.text, err));
    return () => {
      cancelled = true;
    };
  }, [cluster.text, labelFontSize, createTextGeometry]);

  const baseOpacity = cluster.opacity ?? 1;

  const material = useMemo(
    () =>
      new MeshBasicNodeMaterial({
        color: new THREE.Color(color),
        transparent: true,
        toneMapped: false,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity: baseOpacity,
      }),
    // color/opacity are updated imperatively; rebuild only if the material identity must change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const shadowMaterial = useMemo(
    () =>
      shadowStrength > 0
        ? new MeshBasicNodeMaterial({
            color: new THREE.Color(shadowColor),
            transparent: true,
            toneMapped: false,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide,
            opacity: baseOpacity * shadowStrength,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    material.color.set(color);
  }, [material, color]);

  useEffect(
    () => () => {
      material.dispose();
      shadowMaterial?.dispose();
    },
    [material, shadowMaterial],
  );

  useEffect(() => {
    if (!geometry) {
      register(cluster.id, null);
      entryRef.current = null;
      return;
    }
    const entry = { billboard: billboardRef.current, material, shadowMaterial, baseOpacity, fontSize: labelFontSize };
    entryRef.current = entry;
    register(cluster.id, entry);
    return () => {
      register(cluster.id, null);
      entryRef.current = null;
    };
  }, [geometry, material, shadowMaterial, baseOpacity, labelFontSize, cluster.id, register]);

  const setBillboardRef = useCallback((instance) => {
    billboardRef.current = instance;
    if (entryRef.current) entryRef.current.billboard = instance;
  }, []);

  const handlers = {};
  if (onClusterClick) {
    handlers.onClick = (event) => {
      event.stopPropagation();
      onClusterClick(cluster.id);
    };
  }
  if (onClusterHover) {
    handlers.onPointerOver = (event) => {
      event.stopPropagation();
      onClusterHover(cluster.id);
    };
    handlers.onPointerOut = (event) => {
      event.stopPropagation();
      onClusterHover(null);
    };
  }

  if (!geometry) return null;

  const shadowOffset = labelFontSize * (2 / DEFAULT_FONT_SIZE);

  return (
    // worldY = -cluster.y mirrors R3FDots/R3FDotsWebGPU's seed convention
    // (buildSeedBuffers: `array[i*2+1] = -data[i].y`), so a label given a dot's
    // data-space (x, y) lands on top of that dot.
    <Billboard ref={setBillboardRef} position={[cluster.x, -cluster.y, labelZ]} follow={false} lockZ>
      <group position={[-anchor[0], -anchor[1], 0]}>
        {shadowMaterial && (
          <mesh
            geometry={geometry}
            material={shadowMaterial}
            position={[shadowOffset, -shadowOffset, -0.01]}
            frustumCulled={false}
          />
        )}
        <mesh geometry={geometry} material={material} frustumCulled={false} {...handlers} />
      </group>
    </Billboard>
  );
}

export default ClusterLabels3D;
