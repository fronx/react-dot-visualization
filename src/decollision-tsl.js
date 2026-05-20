/**
 * TSL port of the WebGPU decollision kernels (counting-sort spatial hash +
 * collide). Compiles to WGSL through Three's WebGPURenderer, so it can share
 * a device/buffer with R3F rendering — no per-frame GPU→CPU readback.
 *
 * Built incrementally and validated headless against the same naive-O(N²)
 * oracle the raw-WGSL path uses (tests/decollision-tsl.test.mjs).
 *
 * Force math mirrors decollision-webgpu.wgsl `collide` exactly:
 *   nextVel[i] = vel[i] + Σ_j overlap-push(i, j),  weight = rJ²/(rI²+rJ²)
 * and `apply`:
 *   damped = nextVel[i] * velocityRetain;  pos += damped;  vel = damped
 */
import { Fn, instanceIndex, Loop, If, vec2, float, int, uint, floor, clamp, max, sqrt, atomicAdd } from 'three/tsl';

const EPS = 1e-6;

/**
 * `countBins`: histogram particles into grid cells. Writes counts shifted by
 * one (binCount[bin+1] += 1) so an inclusive prefix scan yields per-bin start
 * offsets — same convention as decollision-webgpu.wgsl. `binCount` must be a
 * `.toAtomic()` 'uint' buffer of length numBins+1, pre-zeroed.
 *
 * grid = { gridMinX, gridMinY, cellSize, gridDimX, gridDimY } as plain numbers
 * (baked as literals here; production will swap to uniforms updated per frame).
 */
export function buildCountBins({ positions, velocities, binCount, grid, count }) {
  const { gridMinX, gridMinY, cellSize, gridDimX, gridDimY } = grid;
  return Fn(() => {
    const i = instanceIndex;
    const p = positions.element(i).add(velocities.element(i));
    const cx = clamp(int(floor(p.x.sub(float(gridMinX)).div(float(cellSize)))), int(0), int(gridDimX - 1));
    const cy = clamp(int(floor(p.y.sub(float(gridMinY)).div(float(cellSize)))), int(0), int(gridDimY - 1));
    const bin = cy.mul(int(gridDimX)).add(cx);
    atomicAdd(binCount.element(uint(bin).add(uint(1))), uint(1));
  })().compute(count);
}

/**
 * Brute-force O(N²) collide step — the correctness baseline (no spatial hash).
 * Writes nextVel; does not move positions (that's `buildApply`).
 *
 * @returns a compute node; dispatch via `renderer.computeAsync(node)`.
 */
export function buildCollideBruteForce({ positions, velocities, radii, nextVel, count, strength = 1 }) {
  return Fn(() => {
    const i = instanceIndex;
    const posI = positions.element(i);
    const velI = velocities.element(i);
    const rI = max(radii.element(i), float(EPS));
    const rI2 = rI.mul(rI);
    const xi = posI.add(velI);
    const total = vec2(0, 0).toVar();

    Loop(count, ({ i: j }) => {
      If(j.notEqual(i), () => {
        const xj = positions.element(j).add(velocities.element(j));
        const rJ = max(radii.element(j), float(EPS));
        const minDist = rI.add(rJ);
        const d = xi.sub(xj);
        const dist2 = d.dot(d);
        If(dist2.lessThan(minDist.mul(minDist)), () => {
          const dist = sqrt(dist2);
          const scale = minDist.sub(dist).div(dist).mul(float(strength));
          const weight = rJ.mul(rJ).div(rI2.add(rJ.mul(rJ)));
          total.addAssign(d.mul(scale.mul(weight)));
        });
      });
    });

    nextVel.element(i).assign(velI.add(total));
  })().compute(count);
}

/**
 * Apply step: damp the accumulated velocity and advance positions.
 * velocityRetain = 1 - d3 velocityDecay (0.6 default), matching the WGSL `apply`.
 */
export function buildApply({ positions, velocities, nextVel, count, velocityRetain = 0.6 }) {
  return Fn(() => {
    const i = instanceIndex;
    const damped = nextVel.element(i).mul(float(velocityRetain));
    positions.element(i).addAssign(damped);
    velocities.element(i).assign(damped);
  })().compute(count);
}
