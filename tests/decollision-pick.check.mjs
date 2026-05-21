/**
 * Headless correctness check for the GPU hover/click pick kernel
 * (buildPickNearest), run on Dawn via Three's WebGPURenderer. Asserts the
 * packed-atomicMin argmin matches a CPU oracle for: nearest-within-threshold,
 * the per-dot radius rule (dist <= min(radius, threshold)), and the no-hit
 * sentinel. This is the only deterministic way to verify the bit-packing +
 * sentinel reservation without a live GPU + eyes.
 *
 * STANDALONE runner (not node:test): a WebGPURenderer + Dawn keep native
 * handles + an animation loop alive, so node --test never finalizes the file.
 * We assert manually and process.exit. Run: `npm run check:pick`.
 */
import './tslShims.mjs'; // must be first — sets navigator.gpu/self/rAF before three loads
import { instancedArray, uniform, vec2, float } from 'three/tsl';
import { makeRenderer, readbackU32 } from './tslHeadless.mjs';
import { buildPickNearest, buildStoreAtomicU32, pickIndexBits } from '../src/decollision-tsl.js';

let failures = 0;
function assertEqual(label, got, expected) {
  if (got !== expected) {
    console.error(`  FAIL ${label}: got ${got}, expected ${expected}`);
    failures++;
  } else {
    console.log(`  PASS ${label}: ${got}`);
  }
}

// CPU oracle: the same rule the kernel applies — nearest dot whose distance is
// within min(its radius, threshold). Returns -1 on no hit.
function oraclePick(pos, radii, cx, cy, threshold) {
  let best = -1, bestD2 = Infinity;
  for (let i = 0; i < radii.length; i++) {
    const dx = pos[i * 2] - cx, dy = pos[i * 2 + 1] - cy;
    const d2 = dx * dx + dy * dy;
    const limit = Math.min(radii[i], threshold);
    if (d2 <= limit * limit && d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best;
}

const renderer = await makeRenderer();

// One reusable rig per point set: positions + radii are fixed; cursor/threshold
// are uniforms updated per query, so the kernel (indexBits baked from count) is
// reused across queries — exactly as the component does.
function makeRig(pos, rad) {
  const n = rad.length;
  const positions = instancedArray(pos, 'vec2');
  const pickRadii = instancedArray(rad, 'float');
  const pickResult = instancedArray(new Uint32Array(1), 'uint').toAtomic();
  const cursor = uniform(vec2(0, 0));
  const threshold = uniform(float(0));
  const clear = buildStoreAtomicU32({ buffer: pickResult, value: 0xffffffff });
  const pickNearest = buildPickNearest({ positions, pickRadii, pickResult, cursor, threshold, count: n });
  const indexBits = pickIndexBits(n);
  return { pickResult, cursor, threshold, clear, pickNearest, indexBits };
}

async function runPick(rig, cx, cy, t) {
  rig.cursor.value.set(cx, cy);
  rig.threshold.value = t;
  await renderer.computeAsync(rig.clear);
  await renderer.computeAsync(rig.pickNearest);
  const packed = (await readbackU32(renderer, rig.pickResult, 1))[0] >>> 0;
  if (packed === 0xffffffff) return -1;
  return packed & ((2 ** rig.indexBits) - 1);
}

// Check 1: nearest among several dots within threshold.
{
  const pos = new Float32Array([0, 0, 1, 0, 2, 0, 0.3, 0]); // dots at x = 0,1,2,0.3
  const rad = new Float32Array([1, 1, 1, 1]);
  const rig = makeRig(pos, rad);
  const cx = 0.4, cy = 0, t = 1.0; // closest is index 3 (0.3), dist 0.1
  assertEqual('nearest-within-threshold', await runPick(rig, cx, cy, t), oraclePick(pos, rad, cx, cy, t));
}

// Check 2: no hit — cursor far from every dot → sentinel → -1.
{
  const pos = new Float32Array([0, 0, 1, 1, 2, 2]);
  const rad = new Float32Array([0.5, 0.5, 0.5]);
  const rig = makeRig(pos, rad);
  const cx = 10, cy = 10, t = 1.0;
  assertEqual('no-hit-sentinel', await runPick(rig, cx, cy, t), oraclePick(pos, rad, cx, cy, t)); // -1
}

// Check 3: per-dot radius rule — the nearest dot has a tiny radius and is
// excluded, so a farther dot with a large-enough radius wins (global threshold
// alone would have picked the near one).
{
  // dot 0 at dist 0.2 but radius 0.05 (excluded: 0.2 > min(0.05, t));
  // dot 1 at dist 0.6 with radius 1.0 (included: 0.6 <= min(1.0, 1.0)).
  const pos = new Float32Array([0.2, 0, 0.6, 0]);
  const rad = new Float32Array([0.05, 1.0]);
  const rig = makeRig(pos, rad);
  const cx = 0, cy = 0, t = 1.0;
  assertEqual('per-dot-radius-excludes-near', await runPick(rig, cx, cy, t), oraclePick(pos, rad, cx, cy, t)); // 1
}

// Check 4: threshold caps the radius — a dot inside its own radius but beyond
// the (smaller) global threshold is excluded.
{
  const pos = new Float32Array([0.5, 0]); // dist 0.5, radius 1.0
  const rad = new Float32Array([1.0]);
  const rig = makeRig(pos, rad);
  const cx = 0, cy = 0, t = 0.3; // min(1.0, 0.3) = 0.3 < 0.5 → no hit
  assertEqual('threshold-caps-radius', await runPick(rig, cx, cy, t), oraclePick(pos, rad, cx, cy, t)); // -1
}

// Check 5: larger set, off-axis nearest, deterministic distances.
{
  const n = 50;
  const pos = new Float32Array(n * 2);
  const rad = new Float32Array(n);
  for (let i = 0; i < n; i++) { pos[i * 2] = (i - 25) * 0.4; pos[i * 2 + 1] = ((i % 5) - 2) * 0.4; rad[i] = 0.5; }
  const rig = makeRig(pos, rad);
  const cx = 1.1, cy = -0.05, t = 0.6;
  assertEqual('larger-set-nearest', await runPick(rig, cx, cy, t), oraclePick(pos, rad, cx, cy, t));
}

console.log(failures === 0 ? '\nALL PICK CHECKS PASSED' : `\n${failures} PICK CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
