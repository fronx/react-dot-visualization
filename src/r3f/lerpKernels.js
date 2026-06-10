/**
 * TSL compute kernels for GPU-owned position transitions in R3FDotsWebGPU.
 *
 * Plain .js (no JSX/React) so the headless Dawn tests can compile and dispatch
 * the exact production kernels (tests/keyframes-webgpu.test.mjs); the component
 * imports them from here. Used by the 'lerp' job and the 'keyframes' chain
 * player (keyframePlayer.js).
 */
import { Fn, instanceIndex, float } from 'three/tsl';

// Tiny kernels for GPU-owned transitions: snapshot the live positions into
// fromPos (one GPU→GPU copy at transition start), snapshot the settled base
// layout into basePos, then mix fromPos→target by a uniform t each frame. No
// per-frame CPU↔GPU copy — just the t uniform.
export function buildLerpKernels({ N, positions, basePos, fromPos, targetPos }, tU) {
  const snapshot = Fn(() => {
    fromPos.element(instanceIndex).assign(positions.element(instanceIndex));
  })().compute(N);
  const snapshotBase = Fn(() => {
    basePos.element(instanceIndex).assign(positions.element(instanceIndex));
  })().compute(N);
  const mixStep = Fn(() => {
    const i = instanceIndex;
    const a = fromPos.element(i);
    const b = targetPos.element(i);
    positions.element(i).assign(a.mul(float(1).sub(tU)).add(b.mul(tU)));
  })().compute(N);
  const mixBaseStep = Fn(() => {
    const i = instanceIndex;
    const a = fromPos.element(i);
    const b = basePos.element(i);
    positions.element(i).assign(a.mul(float(1).sub(tU)).add(b.mul(tU)));
  })().compute(N);
  return { snapshot, snapshotBase, mixStep, mixBaseStep };
}
