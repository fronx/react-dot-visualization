import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '..', 'src', 'r3f', 'DotVisualizationR3F.jsx'), 'utf8');

test('WebGPU map keeps 2x supersampling on low-DPI displays', () => {
  assert.match(source, /const WEBGPU_MAP_DPR = 2;/);
  assert.match(
    source,
    /backend === 'webgpu'[\s\S]*?<Canvas[\s\S]*?dpr=\{WEBGPU_MAP_DPR\}/,
  );
});
