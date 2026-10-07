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

const isThenable = (value) => typeof value?.then === 'function';

const DEFAULT_MIN_SCREEN_PX = 22;
const DEFAULT_FONT_SIZE = 52;
// The dot layers draw with renderOrder up to 11 (focus locator) and write no
// depth, so a caption below that order is painted over by the dots it names.
const DEFAULT_RENDER_ORDER = 20;

function ClusterLabels3D({
  clusters = [],
  createTextGeometry,
  fontSize = DEFAULT_FONT_SIZE,
  minScreenPx = DEFAULT_MIN_SCREEN_PX,
  fadeOpacity,
  labelZ = 0,
  renderOrder = DEFAULT_RENDER_ORDER,
  defaultColor = '#ffffff',
  shadowColor = '#000000',
  shadowStrength = 0.8,
  onClusterClick,
  onClusterHover,
}) {
  const { camera, size: viewport, invalidate } = useThree();
  const registry = useRef(new Map());
  const worldPos = useMemo(() => new THREE.Vector3(), []);

  // A label's letters arrive after the scene last drew; under the demand frameloop nothing else asks
  // for the frame that shows them (or stops showing a removed one).
  const register = useCallback((id, entry) => {
    if (entry) registry.current.set(id, entry);
    else registry.current.delete(id);
    invalidate();
  }, [invalidate]);

  useFrame(() => {
    const cameraZ = camera.position.z;
    const zoomOpacity = fadeOpacity ? clamp01(fadeOpacity(cameraZ)) : 1;
    // minScreenPx <= 0 keeps each label at its own world size (here, scaled to
    // the cluster footprint); only the floor path needs the per-frame distance.
    const floored = minScreenPx > 0;
    const tanHalfFov = floored ? Math.tan(THREE.MathUtils.degToRad(camera.fov ?? 10) / 2) : 0;
    registry.current.forEach((entry) => {
      const { billboard, material, shadowMaterial, baseOpacity, fade } = entry;
      if (!billboard) return;
      if (floored) {
        const distance = billboard.getWorldPosition(worldPos).distanceTo(camera.position);
        const unitsPerPixel = (2 * tanHalfFov * Math.max(distance, 1e-3)) / viewport.height;
        billboard.scale.setScalar(Math.max(1, (minScreenPx * unitsPerPixel) / entry.fontSize));
      }

      const opacity = zoomOpacity * baseOpacity * (fade ? clamp01(fade(cameraZ)) : 1);
      // A faded-out label costs no draw call.
      const visible = opacity > 0.004;
      if (billboard.visible !== visible) billboard.visible = visible;
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
          renderOrder={renderOrder}
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
  renderOrder,
  color,
  shadowColor,
  shadowStrength,
  register,
  onClusterClick,
  onClusterHover,
}) {
  const billboardRef = useRef(null);
  const entryRef = useRef(null);

  const labelFontSize = cluster.fontSize ?? fontSize;

  // The factory owns geometry lifetime (it may cache/share instances), so we never dispose it here; this
  // component only owns its materials. Letters it already has come back as a value and draw in this render,
  // with the frame that brings their dots; letters still being built come back as a promise.
  const created = useMemo(
    () => createTextGeometry(cluster.text, { size: labelFontSize }),
    [cluster.text, labelFontSize, createTextGeometry],
  );
  const [resolved, setResolved] = useState(null);
  useEffect(() => {
    if (!isThenable(created)) return undefined;
    let cancelled = false;
    created
      .then((info) => { if (!cancelled) setResolved({ created, info }); })
      .catch((err) => console.error('[ClusterLabels3D] text geometry failed', cluster.text, err));
    return () => {
      cancelled = true;
    };
  }, [created, cluster.text]);
  const info = isThenable(created) ? (resolved?.created === created ? resolved.info : null) : created;
  const geometry = info?.geometry ?? null;
  const shadowGeometry = info?.shadowGeometry ?? null;
  const anchor = info
    ? [(info.planeBounds.min.x + info.planeBounds.max.x) / 2, (info.planeBounds.min.y + info.planeBounds.max.y) / 2]
    : [0, 0];

  const baseOpacity = cluster.opacity ?? 1;
  // Optional per-label zoom fade, multiplied with the set's `fadeOpacity`.
  const fade = cluster.fade;

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
    const entry = { billboard: billboardRef.current, material, shadowMaterial, baseOpacity, fade, fontSize: labelFontSize };
    entryRef.current = entry;
    register(cluster.id, entry);
    return () => {
      register(cluster.id, null);
      entryRef.current = null;
    };
  }, [geometry, material, shadowMaterial, baseOpacity, fade, labelFontSize, cluster.id, register]);

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
            geometry={shadowGeometry ?? geometry}
            material={shadowMaterial}
            position={shadowGeometry ? [0, 0, -0.01] : [shadowOffset, -shadowOffset, -0.01]}
            renderOrder={renderOrder}
            frustumCulled={false}
          />
        )}
        <mesh geometry={geometry} material={material} renderOrder={renderOrder + 1} frustumCulled={false} {...handlers} />
      </group>
    </Billboard>
  );
}

export default ClusterLabels3D;
