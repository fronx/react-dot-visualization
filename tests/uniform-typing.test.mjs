import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// three r184's uniform() takes its type from its argument's nodeType, and uint(x),
// int(x) and the integer vectors return nodes whose nodeType is null, so the
// uniform builds as f32: a bitmask or index through it is exact only below 2^24.
// categorical-filter-gpu.test.mjs holds the masks that broke. Write
// uniform(value, 'uint') instead.
const UNTYPED_INTEGER_UNIFORM = /\buniform\(\s*(?:u?int|[iu]vec[234])\(/;

const root = fileURLToPath(new URL('..', import.meta.url));
const self = fileURLToPath(import.meta.url);

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(m?js|jsx|tsx?)$/.test(entry.name) && file !== self ? [file] : [];
  });
}

const untypedLines = (text) => text.split('\n').flatMap((line, i) => (UNTYPED_INTEGER_UNIFORM.test(line) ? [i + 1] : []));

test('the untyped-uniform detector finds the pattern and nothing else', () => {
  assert.deepEqual(untypedLines('uniform(uint(0));\nuniform( int(1) );\nuniform(uvec2(1, 2));'), [1, 2, 3]);
  assert.deepEqual(untypedLines("uniform(0, 'uint');\nuniform(float(1));\nmyuniform(uint(2));"), []);
});

test('integer uniforms are typed explicitly', () => {
  const files = ['src', 'tests'].flatMap((dir) => sourceFiles(join(root, dir)));
  const texts = files.map((file) => readFileSync(file, 'utf8'));
  assert.ok(texts.some((text) => /\buniform\(/.test(text)), 'the scan saw no uniform() call at all');
  const offenders = files.flatMap((file, i) => untypedLines(texts[i]).map((line) => `${relative(root, file)}:${line}`));
  assert.deepEqual(offenders, [], "write uniform(value, 'uint') instead of uniform(uint(value))");
});
