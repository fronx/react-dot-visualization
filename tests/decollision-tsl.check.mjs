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
import { makeRenderer, readbackF32, readbackU32 } from './tslHeadless.mjs';
import {
  buildCollideBruteForce,
  buildApply,
  buildMeasureMaxVelocitySquared,
  buildClearAtomicU32,
} from '../src/decollision-tsl.js';

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
    let tx = 0, ty = 0, deepest = 0;
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
        const px = dx * scale * weight, py = dy * scale * weight;
        tx += px; ty += py; deepest = Math.max(deepest, Math.hypot(px, py));
      }
    }
    const len = Math.hypot(tx, ty);
    if (len > deepest) { tx *= deepest / len; ty *= deepest / len; }
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

// Check 3: fixed-point max-velocity metric reduces into one atomic uint.
{
  const n = 4, scale = 1000000;
  const velocities = instancedArray(new Float32Array([
    0.1, 0.0,    // v² * scale = 10000
    0.03, 0.04,  // v² * scale = 2500
    0.0, 0.0,
    -0.02, 0.0,
  ]), 'vec2');
  const metric = instancedArray(new Uint32Array([999]), 'uint').toAtomic();
  await renderer.computeAsync(buildClearAtomicU32({ buffer: metric, length: 1 }));
  await renderer.computeAsync(buildMeasureMaxVelocitySquared({ velocities, maxVelocitySquared: metric, count: n, scale }));
  const out = await readbackU32(renderer, metric, 1);
  if (out[0] < 9999 || out[0] > 10001) {
    console.error(`  FAIL maxVelocitySquared: TSL ${out[0]} vs expected ~10000`);
    failures++;
  } else {
    console.log('PASS: TSL max-velocity metric reduces to fixed-point atomic max');
  }
}

// Runs the production step (collide at strength 2, apply at retain 0.6) for `iters` steps; returns positions.
async function settle(pos, rad, iters = 48) {
  const n = rad.length;
  const positions = instancedArray(Float32Array.from(pos), 'vec2');
  const velocities = instancedArray(new Float32Array(n * 2), 'vec2');
  const radii = instancedArray(Float32Array.from(rad), 'float');
  const nextVel = instancedArray(n, 'vec2');
  const collide = buildCollideBruteForce({ positions, velocities, radii, nextVel, count: n, strength: 2 });
  const apply = buildApply({ positions, velocities, nextVel, count: n, velocityRetain: 0.6 });
  for (let it = 0; it < iters; it++) { await renderer.computeAsync(collide); await renderer.computeAsync(apply); }
  return readbackF32(renderer, positions, n * 2);
}

// Closest pair as a multiple of touching distance, and the widest pair in dot diameters.
function stackShape(xy, r) {
  let closest = Infinity, widest = 0;
  for (let i = 0; i < xy.length / 2; i++) for (let j = i + 1; j < xy.length / 2; j++) {
    const d = Math.hypot(xy[i * 2] - xy[j * 2], xy[i * 2 + 1] - xy[j * 2 + 1]);
    closest = Math.min(closest, d / (2 * r)); widest = Math.max(widest, d / (2 * r));
  }
  return { closest, widest };
}

// Check 4: a stack of 8 near-coincident dots settles touching, not flung apart.
// Summed pushes without the cap left the closest pair 4.1x touching, 17.5 widths across;
// d3 forceCollide on the same input settles at 1.19x and 4.5 widths.
{
  const r = 1.388;
  const offsets = [[0.03, -0.02], [-0.05, 0.01], [0.02, 0.06], [-0.01, -0.07], [0.07, 0.03], [-0.04, -0.04], [0.0, 0.02], [0.05, -0.06]];
  const xy = await settle(offsets.flat(), new Array(8).fill(r));
  const { closest, widest } = stackShape(xy, r);
  if (!(closest > 0.97 && closest < 1.15 && widest < 6)) {
    console.error(`  FAIL stack: closest pair ${closest.toFixed(2)}x touching, ${widest.toFixed(1)} widths across`);
    failures++;
  } else console.log(`PASS: an 8-dot stack settles touching (closest ${closest.toFixed(2)}x, ${widest.toFixed(1)} widths across)`);
}

// Check 5: exactly coincident dots are parted, never NaN.
{
  const r = 0.5;
  const xy = await settle(new Array(20).fill(3), new Array(10).fill(r));
  const finite = xy.every(Number.isFinite);
  const { closest } = finite ? stackShape(xy, r) : { closest: NaN };
  if (!finite || !(closest > 0.97)) {
    console.error(`  FAIL coincident: finite=${finite}, closest pair ${closest}x touching`);
    failures++;
  } else console.log(`PASS: 10 coincident dots are parted (closest ${closest.toFixed(2)}x touching)`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
