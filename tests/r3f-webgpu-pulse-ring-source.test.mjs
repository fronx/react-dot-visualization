import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '..', 'src', 'r3f', 'R3FDotsWebGPU.jsx'), 'utf8');
// The lerp/snapshot kernels live in their own module (lerpKernels.js) so the
// headless Dawn tests can compile the production kernels; the guard reads both.
const kernelsSource = readFileSync(join(__dirname, '..', 'src', 'r3f', 'lerpKernels.js'), 'utf8');

test('WebGPU pulse rings read live GPU dot positions, not seed data positions', () => {
  assert.match(
    source,
    /const dotIndex = ringBuffers\.indices\.element\(instanceIndex\);[\s\S]*const rp = buffers\.positions\.element\(dotIndex\);/,
  );
  assert.doesNotMatch(source, /ringPos\[j \* 2\]\s*=\s*item\.x/);
  assert.doesNotMatch(source, /positions:\s*instancedArray\(new Float32Array\(count \* 2\), 'vec2'\)/);
});

test('WebGPU base layout is snapshotted and restored from GPU buffers', () => {
  assert.match(source, /basePos:\s*instancedArray\(new Float32Array\(pos\), 'vec2'\)/);
  assert.match(
    kernelsSource,
    /const snapshotBase = Fn\(\(\) => \{[\s\S]*basePos\.element\(instanceIndex\)\.assign\(positions\.element\(instanceIndex\)\);/,
  );
  assert.match(
    kernelsSource,
    /const mixBaseStep = Fn\(\(\) => \{[\s\S]*const b = basePos\.element\(i\);[\s\S]*positions\.element\(i\)\.assign/,
  );
  assert.match(source, /targetSnapshotKey === '' \? lerpKernels\.mixBaseStep : lerpKernels\.mixStep/);
  assert.doesNotMatch(source, /readbackSettledPositions/);
  assert.doesNotMatch(source, /readbackPositionsOnComplete/);
});
