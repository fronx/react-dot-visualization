/**
 * Headless WebGPURenderer harness for testing/benching TSL compute on Dawn.
 * Import `./tslShims.mjs` (which this depends on) BEFORE this module.
 */
import { gpu } from './tslShims.mjs';
import * as THREE from 'three/webgpu';

const stubCanvas = {
  width: 1, height: 1, style: {}, clientWidth: 1, clientHeight: 1,
  addEventListener() {}, removeEventListener() {},
  getRootNode() { return stubCanvas; }, getContext() { return null; },
};

/** Create a headless WebGPURenderer backed by a fresh Dawn device. */
export async function makeRenderer() {
  const adapter = await gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const renderer = new THREE.WebGPURenderer({ device, antialias: false, canvas: stubCanvas });
  await renderer.init();
  // init() auto-starts an rAF animation loop; under our setTimeout-based rAF
  // shim that keeps the node event loop alive forever (node --test then never
  // sees the file finish). We only need compute, so stop the loop.
  renderer.setAnimationLoop(null);
  return renderer;
}

/** Read a storage buffer (instancedArray node) back as a Float32Array view. */
export async function readbackF32(renderer, storageNode, floatCount) {
  const buf = await renderer.getArrayBufferAsync(storageNode.value);
  const arr = new Float32Array(buf);
  return floatCount ? arr.subarray(0, floatCount) : arr;
}
