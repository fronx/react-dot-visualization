import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '..', 'src', 'r3f', 'R3FDotsWebGPU.jsx'), 'utf8');

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
    source,
    /const snapshotBase = Fn\(\(\) => \{[\s\S]*basePos\.element\(instanceIndex\)\.assign\(positions\.element\(instanceIndex\)\);/,
  );
  assert.match(
    source,
    /const mixBaseStep = Fn\(\(\) => \{[\s\S]*const b = basePos\.element\(i\);[\s\S]*positions\.element\(i\)\.assign/,
  );
  assert.match(source, /targetSnapshotKey === '' \? lerpKernels\.mixBaseStep : lerpKernels\.mixStep/);
  assert.doesNotMatch(source, /readbackSettledPositions/);
  assert.doesNotMatch(source, /readbackPositionsOnComplete/);
});
