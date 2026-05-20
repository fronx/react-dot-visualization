/**
 * WebGPU render spike.
 *
 * Question: does the GPU-resident compute->render path work under R3F, with
 * zero per-frame readback, leaving the main thread idle?
 *
 * Setup: R3F <Canvas> driving a three WebGPURenderer (async gl prop). N dots
 * are one InstancedMesh whose per-instance position/color/alpha/focus are read
 * from storage buffers via element(instanceIndex) — no vertex attributes, no
 * CPU-side matrix writes. The decollision sim (the validated TSL kernels) runs
 * entirely on the GPU each frame and writes the positions buffer the material
 * reads, so dots start overlapping and spread apart as the sim settles.
 *
 * Material: bevelStrokeNodeMaterial (TSL port of the GLSL bevel/stroke/focus).
 */
import React, { useMemo, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { instanceIndex, vec3, instancedArray, positionLocal, uniform } from 'three/tsl';
import { createBevelStrokeNodeMaterial } from './r3f/bevelStrokeNodeMaterial.js';
import { computeGridParams } from './decollision-webgpu.js';
import {
  buildCountBins, buildScanStep, buildPlaceParticles, buildCollideSpatial,
  buildApply, buildClearAtomicU32,
} from './decollision-tsl.js';

// Default is few + large dots so the stroke ring + focus ring are legible.
// The 67k perf headline holds via ?n=67000.
const params = new URLSearchParams(location.search);
const N = Number(params.get('n') || 2000);
const SPACE = 100; // initial spread + camera framing; matches the bench's synthetic scale
// Radius scale knob: default dots are large for material legibility, which is
// pathologically dense at high N. ?r=0.25 approximates realistic UMAP density.
const RAD_SCALE = Number(params.get('r') || 1);

// d3 alpha schedule: the collide push is scaled by a global alpha that decays
// 1 -> ~0 over the settle, so motion damps to a stop instead of twitching at a
// noise floor forever. Defaults match d3-force.
const ALPHA_DECAY = 0.0228;
const ALPHA_MIN = 0.001;

// Inclusive-prefix-scan pass count, rounded up to even so the ping-pong lands
// back in binCount (mirrors the headless check's computeScanIterations).
function scanIterations(n) {
  if (n <= 1) return 0;
  let iters = Math.ceil(Math.log2(n));
  if (iters % 2 === 1) iters += 1;
  return iters;
}

function makeBuffers() {
  const pos = new Float32Array(N * 2);
  const rad = new Float32Array(N);
  const col = new Float32Array(N * 3);
  const alpha = new Float32Array(N);
  const focus = new Float32Array(N);
  const nodes = new Array(N);
  const tmp = new THREE.Color();
  let s = 1234567;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < N; i++) {
    const x = (rand() - 0.5) * SPACE;
    const y = (rand() - 0.5) * SPACE;
    pos[i * 2] = x; pos[i * 2 + 1] = y;
    nodes[i] = { x, y };
    const isFocus = i % 160 === 0;
    focus[i] = isFocus ? 1 : 0;
    rad[i] = (isFocus ? 4.5 : 0.8 + rand() * 1.4) * RAD_SCALE;
    tmp.setHSL(rand(), 0.65, 0.6);
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    alpha[i] = i % 9 === 0 ? 0.35 : 1.0;
  }
  const grid = computeGridParams(nodes, rad);
  const len = grid.numBins + 1;
  return {
    positions: instancedArray(pos, 'vec2'),
    velocities: instancedArray(new Float32Array(N * 2), 'vec2'),
    radii: instancedArray(rad, 'float'),
    nextVel: instancedArray(N, 'vec2'),
    binCount: instancedArray(new Uint32Array(len), 'uint').toAtomic(),
    scratch: instancedArray(new Uint32Array(len), 'uint'),
    placeCounter: instancedArray(new Uint32Array(grid.numBins), 'uint').toAtomic(),
    sortedIndices: instancedArray(new Uint32Array(N), 'uint'),
    colors: instancedArray(col, 'vec3'),
    alphas: instancedArray(alpha, 'float'),
    focus: instancedArray(focus, 'float'),
    grid, len,
  };
}

function Dots({ buffers, statsRef }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  const pipeline = useMemo(() => {
    const { positions, velocities, radii, nextVel, binCount, scratch, placeCounter, sortedIndices, grid, len } = buffers;
    const scanSteps = [];
    const iters = scanIterations(len);
    for (let s = 0; s < iters; s++) {
      const a2b = s % 2 === 0;
      scanSteps.push(buildScanStep({
        src: a2b ? binCount : scratch, dst: a2b ? scratch : binCount,
        srcAtomic: a2b, dstAtomic: !a2b, step: 1 << s, length: len,
      }));
    }
    const alphaU = uniform(1);
    return {
      alphaU,
      clearBin: buildClearAtomicU32({ buffer: binCount, length: len }),
      clearPlace: buildClearAtomicU32({ buffer: placeCounter, length: grid.numBins }),
      countBins: buildCountBins({ positions, velocities, binCount, grid, count: N }),
      scanSteps,
      place: buildPlaceParticles({ positions, velocities, binCount, placeCounter, sortedIndices, grid, count: N }),
      collide: buildCollideSpatial({ positions, velocities, radii, nextVel, binCount, sortedIndices, grid, count: N, strength: 1, alpha: alphaU }),
      apply: buildApply({ positions, velocities, nextVel, count: N, velocityRetain: 0.6 }),
    };
  }, [buffers]);

  const mesh = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = createBevelStrokeNodeMaterial({
      instanceColor: buffers.colors.element(instanceIndex),
      instanceAlpha: buffers.alphas.element(instanceIndex),
      instanceFocus: buffers.focus.element(instanceIndex),
      strokeColor: '#111',
      strokeWidthFraction: 0.12,
    });
    const instPos = buffers.positions.element(instanceIndex);
    const instRad = buffers.radii.element(instanceIndex);
    // local quad [-0.5,0.5] -> diameter (2*r), then translate to instance pos
    material.positionNode = vec3(
      positionLocal.xy.mul(instRad.mul(2.0)).add(instPos),
      0,
    );
    const m = new THREE.InstancedMesh(geometry, material, N);
    m.frustumCulled = false;
    return m;
  }, [buffers]);

  // Fit the orthographic camera to the origin-centered [-SPACE/2, SPACE/2]^2.
  useEffect(() => {
    const margin = 1.06;
    camera.zoom = Math.min(size.width, size.height) / (SPACE * margin);
    camera.position.set(0, 0, 100);
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height]);

  const acc = useRef({ js: 0, frames: 0, last: performance.now(), longtasks: 0 });

  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return;
    const obs = new PerformanceObserver((list) => {
      acc.current.longtasks += list.getEntries().length;
    });
    try { obs.observe({ entryTypes: ['longtask'] }); } catch { /* unsupported */ }
    return () => obs.disconnect();
  }, []);

  useFrame(() => {
    const t0 = performance.now();
    const p = pipeline;
    // Run the sim only while alpha is above the floor; once settled it stops
    // (positions freeze, no more jitter). The render keeps going regardless.
    if (p.alphaU.value > ALPHA_MIN) {
      gl.compute(p.clearBin);
      gl.compute(p.clearPlace);
      gl.compute(p.countBins);
      for (let i = 0; i < p.scanSteps.length; i++) gl.compute(p.scanSteps[i]);
      gl.compute(p.place);
      gl.compute(p.collide);
      gl.compute(p.apply);
      p.alphaU.value += (0 - p.alphaU.value) * ALPHA_DECAY;
    }
    const a = acc.current;
    a.js += performance.now() - t0;
    a.frames += 1;
    const elapsed = t0 - a.last;
    if (elapsed >= 500 && statsRef.current) {
      const fps = (a.frames / elapsed) * 1000;
      const jsMs = a.js / a.frames;
      statsRef.current.textContent =
        `N=${N}  FPS ${fps.toFixed(0)}  main-thread ${jsMs.toFixed(2)} ms/frame  longtasks ${a.longtasks}`;
      a.js = 0; a.frames = 0; a.last = t0;
    }
  });

  return <primitive object={mesh} />;
}

function App() {
  const buffers = useMemo(makeBuffers, []);
  const statsRef = useRef(null);
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={statsRef} style={{
        position: 'absolute', top: 10, left: 12, zIndex: 10,
        background: 'rgba(0,0,0,0.55)', padding: '6px 10px', borderRadius: 6,
        fontSize: 13, whiteSpace: 'nowrap',
      }}>initializing WebGPU…</div>
      <Canvas
        orthographic
        camera={{ position: [0, 0, 100], near: 0.1, far: 1000, zoom: 5 }}
        gl={async (props) => {
          const renderer = new THREE.WebGPURenderer(props);
          await renderer.init();
          return renderer;
        }}
      >
        <Dots buffers={buffers} statsRef={statsRef} />
      </Canvas>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
