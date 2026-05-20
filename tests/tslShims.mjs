/**
 * Headless shims so Three's WebGPURenderer can init in node on Dawn.
 *
 * MUST be imported before any `three/webgpu` import — its top-level side
 * effects (navigator.gpu, self, requestAnimationFrame) have to be in place
 * before the renderer module evaluates. ESM evaluates imports in source
 * order, so a top-of-file `import './tslShims.mjs'` runs these first.
 *
 * Verified shim set (probe, 2026-05-20): a stub canvas avoids
 * document.createElement; navigator.gpu + self + rAF satisfy the renderer's
 * auto-started animation loop. Compute + getArrayBufferAsync then work.
 */
import { create, globals } from 'webgpu';

Object.assign(globalThis, globals);
const gpu = create([]);

globalThis.navigator ??= {};
if (!globalThis.navigator.gpu) globalThis.navigator.gpu = gpu;
globalThis.self ??= globalThis;
globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

export { gpu };
