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
import { Fn, instanceIndex, Loop, If, vec2, float, int, uint, floor, clamp, max, min, select, sqrt, atomicAdd, atomicLoad, atomicMax, atomicStore } from 'three/tsl';

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
 * One Hillis-Steele inclusive-prefix-sum pass. Run repeatedly with `step`
 * doubling (1,2,4,…) ping-ponging src/dst; an even number of passes
 * (computeScanIterations) lands the result back in `binCount`. The
 * `*Atomic` flags pick atomicLoad/atomicStore vs plain access so the same
 * atomic `binCount` buffer can be read/written across passes without an
 * atomic-vs-plain view mismatch. `step` is a uint uniform set per pass.
 */
export function buildScanStep({ src, dst, srcAtomic, dstAtomic, step, length }) {
  // Atomic reads must be materialized (.toVar) to be usable as values — an
  // atomic node whose only parent is the stack generates as a void statement.
  const read = (buf, idx) => (srcAtomic ? atomicLoad(buf.element(idx)).toVar() : buf.element(idx));
  const stepU = uint(step); // baked literal (step is a plain number) — avoids uniform type ambiguity
  return Fn(() => {
    const i = instanceIndex;
    const cur = read(src, i);
    const j = uint(max(int(i).sub(int(step)), int(0))); // guarded — branch unused when i<step
    const res = select(i.lessThan(stepU), cur, cur.add(read(src, j)));
    if (dstAtomic) atomicStore(dst.element(i), res);
    else dst.element(i).assign(res);
  })().compute(length);
}

/**
 * `placeParticles`: scatter each particle's index into `sortedIndices`,
 * grouped by bin. `binCount` holds post-scan start offsets; `placeCounter`
 * (atomic, pre-zeroed) hands out per-bin slots. Mirrors the WGSL `placeParticles`.
 */
export function buildPlaceParticles({ positions, velocities, binCount, placeCounter, sortedIndices, grid, count }) {
  const { gridMinX, gridMinY, cellSize, gridDimX, gridDimY } = grid;
  return Fn(() => {
    const i = instanceIndex;
    const p = positions.element(i).add(velocities.element(i));
    const cx = clamp(int(floor(p.x.sub(float(gridMinX)).div(float(cellSize)))), int(0), int(gridDimX - 1));
    const cy = clamp(int(floor(p.y.sub(float(gridMinY)).div(float(cellSize)))), int(0), int(gridDimY - 1));
    const bin = uint(cy.mul(int(gridDimX)).add(cx));
    const slot = atomicAdd(placeCounter.element(bin), uint(1)).toVar();
    const base = atomicLoad(binCount.element(bin)).toVar();
    sortedIndices.element(base.add(slot)).assign(uint(i));
  })().compute(count);
}

/**
 * `collideSpatial`: the production collide — walks only the 3×3 neighbour cells
 * via the spatial hash (NOT O(N²)). Same force math as buildCollideBruteForce;
 * validated to produce identical nextVel. Jitter on exact overlap is omitted
 * (matches the brute-force oracle; degenerate-only).
 */
export function buildCollideSpatial({ positions, velocities, radii, nextVel, binCount, sortedIndices, grid, count, strength = 1, alpha = 1 }) {
  const { gridMinX, gridMinY, cellSize, gridDimX, gridDimY } = grid;
  return Fn(() => {
    const i = instanceIndex;
    const posI = positions.element(i);
    const velI = velocities.element(i);
    const rI = max(radii.element(i), float(EPS));
    const rI2 = rI.mul(rI);
    const xi = posI.add(velI);
    const cx0 = int(floor(xi.x.sub(float(gridMinX)).div(float(cellSize))));
    const cy0 = int(floor(xi.y.sub(float(gridMinY)).div(float(cellSize))));
    const cyLo = max(cy0.sub(1), int(0));
    const cyHi = min(cy0.add(1), int(gridDimY - 1));
    const cxLo = max(cx0.sub(1), int(0));
    const cxHi = min(cx0.add(1), int(gridDimX - 1));
    const total = vec2(0, 0).toVar();

    Loop({ start: cyLo, end: cyHi.add(1), type: 'int', condition: '<' }, ({ i: cy }) => {
      Loop({ start: cxLo, end: cxHi.add(1), type: 'int', condition: '<', name: 'cx' }, ({ cx }) => {
        const bin = uint(cy.mul(int(gridDimX)).add(cx));
        const start = atomicLoad(binCount.element(bin)).toVar();
        const end = atomicLoad(binCount.element(bin.add(uint(1)))).toVar();
        Loop({ start, end, type: 'uint', condition: '<', name: 'k' }, ({ k }) => {
          const j = sortedIndices.element(k);
          If(j.notEqual(i), () => {
            const xj = positions.element(j).add(velocities.element(j));
            const rJ = max(radii.element(j), float(EPS));
            const minDist = rI.add(rJ);
            const d = xi.sub(xj);
            const dist2 = d.dot(d);
            If(dist2.lessThan(minDist.mul(minDist)), () => {
              const dist = sqrt(dist2);
              const scale = minDist.sub(dist).div(dist).mul(float(strength)).mul(alpha);
              const weight = rJ.mul(rJ).div(rI2.add(rJ.mul(rJ)));
              total.addAssign(d.mul(scale.mul(weight)));
            });
          });
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

/**
 * Reduce the largest per-particle velocity² into a single atomic uint.
 *
 * WebGPU atomics do not support float, so callers provide a fixed-point scale
 * and compare the readback against `epsilon² * scale`. This is intentionally
 * based on the post-apply velocity rather than overlap count: a decollision run
 * is "done enough" for visual continuity when the next frame would move no dot
 * by a meaningful amount.
 */
export function buildMeasureMaxVelocitySquared({ velocities, maxVelocitySquared, count, scale = 1000000 }) {
  return Fn(() => {
    const v = velocities.element(instanceIndex);
    const scaled = clamp(v.dot(v).mul(float(scale)), float(0), float(4294967040));
    atomicMax(maxVelocitySquared.element(uint(0)), uint(scaled));
  })().compute(count);
}

/**
 * Zero an atomic `uint` storage buffer. The headless checks created fresh
 * buffers per run; a continuous frame loop reuses them, so the atomic
 * accumulators (binCount, placeCounter) must be reset before each iteration.
 */
export function buildClearAtomicU32({ buffer, length }) {
  return Fn(() => {
    atomicStore(buffer.element(instanceIndex), uint(0));
  })().compute(length);
}
