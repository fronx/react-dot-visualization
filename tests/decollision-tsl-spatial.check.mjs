/**
 * Headless validation of the TSL spatial-hash kernels (counting sort) against
 * CPU oracles, built incrementally: countBins → (scan → place → collide).
 * Uses the REAL computeGridParams from decollision-webgpu.js so the grid math
 * matches the WGSL path exactly. Standalone runner (see decollision-tsl.check.mjs
 * for why not node:test). Run: `npm run check:tsl-spatial`.
 */
import './tslShims.mjs';
import { instancedArray } from 'three/tsl';
import { makeRenderer, readbackU32, readbackF32 } from './tslHeadless.mjs';
import { computeGridParams } from '../src/decollision-webgpu.js';
import {
  buildCountBins, buildScanStep, buildPlaceParticles, buildCollideSpatial,
} from '../src/decollision-tsl.js';

let failures = 0;
const fail = (msg) => { console.error('  FAIL ' + msg); failures++; };

function computeScanIterations(n) {
  if (n <= 1) return 0;
  let iters = Math.ceil(Math.log2(n));
  if (iters % 2 === 1) iters += 1;
  return iters;
}

function naiveCollide(pos, vel, rad, strength = 1) {
  const n = rad.length;
  const next = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const xi = pos[i * 2] + vel[i * 2], yi = pos[i * 2 + 1] + vel[i * 2 + 1];
    const ri = Math.max(rad[i], 1e-6), ri2 = ri * ri;
    let tx = 0, ty = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const xj = pos[j * 2] + vel[j * 2], yj = pos[j * 2 + 1] + vel[j * 2 + 1];
      const rj = Math.max(rad[j], 1e-6), minDist = ri + rj;
      const dx = xi - xj, dy = yi - yj, dist2 = dx * dx + dy * dy;
      if (dist2 < minDist * minDist && dist2 > 0) {
        const dist = Math.sqrt(dist2), scale = (minDist - dist) / dist * strength;
        const weight = (rj * rj) / (ri2 + rj * rj);
        tx += dx * scale * weight; ty += dy * scale * weight;
      }
    }
    next[i * 2] = vel[i * 2] + tx; next[i * 2 + 1] = vel[i * 2 + 1] + ty;
  }
  return next;
}

function makeData(n, seed = 4242) {
  let s = seed;
  const rand = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pos = new Float32Array(n * 2), vel = new Float32Array(n * 2), rad = new Float32Array(n);
  for (let i = 0; i < n; i++) { pos[i * 2] = rand() * 50; pos[i * 2 + 1] = rand() * 50; rad[i] = 0.2 + rand() * 0.6; }
  return { pos, vel, rad };
}

// CPU oracle: same cellOf + bin+1-shifted histogram as the WGSL/TSL kernels.
function cpuBinCounts(pos, vel, grid, n) {
  const { gridMinX, gridMinY, cellSize, gridDimX, gridDimY, numBins } = grid;
  const counts = new Uint32Array(numBins + 1);
  for (let i = 0; i < n; i++) {
    const x = pos[i * 2] + vel[i * 2], y = pos[i * 2 + 1] + vel[i * 2 + 1];
    const cx = Math.min(Math.max(Math.floor((x - gridMinX) / cellSize), 0), gridDimX - 1);
    const cy = Math.min(Math.max(Math.floor((y - gridMinY) / cellSize), 0), gridDimY - 1);
    counts[cy * gridDimX + cx + 1]++;
  }
  return counts;
}

const renderer = await makeRenderer();

{
  const n = 2000;
  const { pos, vel, rad } = makeData(n);
  const nodes = []; for (let i = 0; i < n; i++) nodes.push({ x: pos[i * 2], y: pos[i * 2 + 1] });
  const grid = computeGridParams(nodes, rad);

  const positions = instancedArray(pos, 'vec2');
  const velocities = instancedArray(vel, 'vec2');
  const binCount = instancedArray(new Uint32Array(grid.numBins + 1), 'uint').toAtomic();

  await renderer.computeAsync(buildCountBins({ positions, velocities, binCount, grid, count: n }));
  const gpu = await readbackU32(renderer, binCount, grid.numBins + 1);
  const cpu = cpuBinCounts(pos, vel, grid, n);

  let total = 0, mismatches = 0;
  for (let b = 0; b < grid.numBins + 1; b++) {
    total += gpu[b];
    if (gpu[b] !== cpu[b] && mismatches < 5) { fail(`bin[${b}] gpu=${gpu[b]} cpu=${cpu[b]}`); mismatches++; }
  }
  if (total !== n) fail(`total counted ${total} != n ${n}`);
  console.log(failures === 0
    ? `PASS: TSL countBins histogram == CPU oracle (n=${n}, ${grid.numBins} bins, cellSize=${grid.cellSize.toFixed(3)})`
    : 'FAIL: countBins');
}

// Full pipeline: countBins → scan → place → collideSpatial, asserted equal to
// the brute-force naive collide (the spatial hash must not change the result).
{
  const n = 2000;
  const { pos, vel, rad } = makeData(n, 7);
  const nodes = []; for (let i = 0; i < n; i++) nodes.push({ x: pos[i * 2], y: pos[i * 2 + 1] });
  const grid = computeGridParams(nodes, rad);
  const len = grid.numBins + 1;

  const positions = instancedArray(pos, 'vec2');
  const velocities = instancedArray(vel, 'vec2');
  const radii = instancedArray(rad, 'float');
  const nextVel = instancedArray(n, 'vec2');
  const binCount = instancedArray(new Uint32Array(len), 'uint').toAtomic();
  const scratch = instancedArray(new Uint32Array(len), 'uint');
  const placeCounter = instancedArray(new Uint32Array(grid.numBins), 'uint').toAtomic();
  const sortedIndices = instancedArray(new Uint32Array(n), 'uint');

  await renderer.computeAsync(buildCountBins({ positions, velocities, binCount, grid, count: n }));
  const iters = computeScanIterations(len);
  for (let s = 0; s < iters; s++) {
    const a2b = s % 2 === 0;
    await renderer.computeAsync(buildScanStep({
      src: a2b ? binCount : scratch, dst: a2b ? scratch : binCount,
      srcAtomic: a2b, dstAtomic: !a2b, step: 1 << s, length: len,
    }));
  }
  await renderer.computeAsync(buildPlaceParticles({ positions, velocities, binCount, placeCounter, sortedIndices, grid, count: n }));
  await renderer.computeAsync(buildCollideSpatial({ positions, velocities, radii, nextVel, binCount, sortedIndices, grid, count: n, strength: 1 }));

  const out = await readbackF32(renderer, nextVel, n * 2);
  const expected = naiveCollide(pos, vel, rad, 1);
  let maxErr = 0;
  for (let i = 0; i < n * 2; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - expected[i]));
  if (maxErr > 2e-3) fail(`spatial collide vs brute-force maxErr=${maxErr.toExponential(2)} (>2e-3)`);
  console.log(maxErr <= 2e-3
    ? `PASS: TSL spatial collide == brute-force (n=${n}, maxErr=${maxErr.toExponential(2)}) — NOT O(N²)`
    : 'FAIL: spatial collide');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
