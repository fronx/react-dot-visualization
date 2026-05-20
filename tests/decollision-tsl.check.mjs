/**
 * Headless correctness check for the TSL decollision kernels, run on Dawn via
 * Three's WebGPURenderer. Asserts the TSL `collide`/`apply` steps are
 * numerically equal to the same naive-O(N²) oracle the raw-WGSL test
 * (decollision-webgpu.test.mjs) uses — so the TSL port is provably equivalent
 * to the validated WGSL math.
 *
 * STANDALONE runner (not node:test): a WebGPURenderer + Dawn keep native
 * handles + an animation loop alive, so node --test never finalizes the file
 * and buffers all output until the timeout kill. We assert manually and
 * process.exit instead. Run: `npm run check:tsl`.
 */
import './tslShims.mjs'; // must be first — sets navigator.gpu/self/rAF before three loads
import { instancedArray } from 'three/tsl';
import { makeRenderer, readbackF32 } from './tslHeadless.mjs';
import { buildCollideBruteForce, buildApply } from '../src/decollision-tsl.js';

let failures = 0;
function approxEqual(label, got, expected, tol = 1e-4) {
  for (let i = 0; i < expected.length; i++) {
    if (Math.abs(got[i] - expected[i]) > tol) {
      console.error(`  FAIL ${label}[${i}]: TSL ${got[i]} vs oracle ${expected[i]}`);
      failures++;
      if (failures > 8) { console.error('  …(more failures suppressed)'); return false; }
    }
  }
  return failures === 0;
}

function naiveCollide(positions, velocities, radii, strength = 1) {
  const n = radii.length;
  const next = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const xi = positions[i * 2] + velocities[i * 2];
    const yi = positions[i * 2 + 1] + velocities[i * 2 + 1];
    const ri = Math.max(radii[i], 1e-6), ri2 = ri * ri;
    let tx = 0, ty = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const xj = positions[j * 2] + velocities[j * 2];
      const yj = positions[j * 2 + 1] + velocities[j * 2 + 1];
      const rj = Math.max(radii[j], 1e-6);
      const minDist = ri + rj;
      const dx = xi - xj, dy = yi - yj, dist2 = dx * dx + dy * dy;
      if (dist2 < minDist * minDist && dist2 > 0) {
        const dist = Math.sqrt(dist2);
        const scale = (minDist - dist) / dist * strength;
        const weight = (rj * rj) / (ri2 + rj * rj);
        tx += dx * scale * weight; ty += dy * scale * weight;
      }
    }
    next[i * 2] = velocities[i * 2] + tx;
    next[i * 2 + 1] = velocities[i * 2 + 1] + ty;
  }
  return next;
}

function makeData(n, seed = 1337) {
  let s = seed;
  const rand = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pos = new Float32Array(n * 2), vel = new Float32Array(n * 2), rad = new Float32Array(n);
  for (let i = 0; i < n; i++) { pos[i * 2] = rand() * 10; pos[i * 2 + 1] = rand() * 10; rad[i] = 0.3; }
  return { pos, vel, rad };
}

const renderer = await makeRenderer();

// Check 1: collide step == naive oracle.
{
  const n = 30;
  const { pos, vel, rad } = makeData(n);
  const positions = instancedArray(pos, 'vec2');
  const velocities = instancedArray(vel, 'vec2');
  const radii = instancedArray(rad, 'float');
  const nextVel = instancedArray(n, 'vec2');
  await renderer.computeAsync(buildCollideBruteForce({ positions, velocities, radii, nextVel, count: n, strength: 1 }));
  const out = await readbackF32(renderer, nextVel, n * 2);
  const ok = approxEqual('collide', out, naiveCollide(pos, vel, rad, 1));
  console.log(ok ? 'PASS: TSL brute-force collide == naive O(N²) oracle (n=30)' : 'FAIL: collide');
}

// Check 2: apply advances positions by damped velocity.
{
  const n = 16, retain = 0.6;
  const { pos, vel, rad } = makeData(n, 99);
  const positions = instancedArray(pos, 'vec2');
  const velocities = instancedArray(vel, 'vec2');
  const radii = instancedArray(rad, 'float');
  const nextVel = instancedArray(n, 'vec2');
  await renderer.computeAsync(buildCollideBruteForce({ positions, velocities, radii, nextVel, count: n, strength: 1 }));
  await renderer.computeAsync(buildApply({ positions, velocities, nextVel, count: n, velocityRetain: retain }));
  const outPos = await readbackF32(renderer, positions, n * 2);
  const nv = naiveCollide(pos, vel, rad, 1);
  const expected = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) expected[i] = pos[i] + nv[i] * retain;
  const ok = approxEqual('apply', outPos, expected);
  console.log(ok ? 'PASS: TSL apply advances positions by damped velocity (n=16)' : 'FAIL: apply');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
