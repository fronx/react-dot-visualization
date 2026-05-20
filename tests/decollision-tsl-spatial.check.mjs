/**
 * Headless validation of the TSL spatial-hash kernels (counting sort) against
 * CPU oracles, built incrementally: countBins → (scan → place → collide).
 * Uses the REAL computeGridParams from decollision-webgpu.js so the grid math
 * matches the WGSL path exactly. Standalone runner (see decollision-tsl.check.mjs
 * for why not node:test). Run: `npm run check:tsl-spatial`.
 */
import './tslShims.mjs';
import { instancedArray } from 'three/tsl';
import { makeRenderer, readbackU32 } from './tslHeadless.mjs';
import { computeGridParams } from '../src/decollision-webgpu.js';
import { buildCountBins } from '../src/decollision-tsl.js';

let failures = 0;
const fail = (msg) => { console.error('  FAIL ' + msg); failures++; };

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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
