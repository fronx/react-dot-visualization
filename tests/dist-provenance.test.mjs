import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(fileURLToPath(import.meta.url), '../../scripts/dist-provenance.mjs');

// The script under test anchors every path to its own repository, so the
// fixture gets its own copy rather than being pointed at through a cwd.
function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'dist-provenance-'));
  const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8' });
  run('git', ['init', '--quiet']);
  run('git', ['config', 'user.email', 'test@example.com']);
  run('git', ['config', 'user.name', 'test']);
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'scripts'));
  copyFileSync(script, path.join(root, 'scripts/dist-provenance.mjs'));
  writeFileSync(path.join(root, 'src/index.js'), 'export const answer = 42;\n');
  writeFileSync(path.join(root, 'vite.lib.config.js'), 'export default {};\n');
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(path.join(root, '.gitignore'), 'dist/\n');
  run('git', ['add', '-A']);
  run('git', ['commit', '--quiet', '-m', 'fixture']);
  mkdirSync(path.join(root, 'dist'));
  writeFileSync(path.join(root, 'dist/index.es.js'), 'built output\n');
  const provenance = (command, cwd = root) =>
    execFileSync(process.execPath, [path.join(root, 'scripts/dist-provenance.mjs'), command], {
      cwd,
      encoding: 'utf8',
    });
  return { root, run, provenance, report: (cwd) => JSON.parse(provenance('report', cwd)) };
}

test('a freshly written provenance reports fresh and clean', (t) => {
  const { root, run, provenance, report } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  provenance('write');
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  assert.deepEqual(report(), { commit: head, dirty: false, distFresh: true });
});

test('the answer describes the script\'s own repository, not the caller\'s directory', (t) => {
  const { root, run, provenance, report } = makeRepo();
  const elsewhere = makeRepo();
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere.root, { recursive: true, force: true });
  });
  provenance('write');
  appendFileSync(path.join(elsewhere.root, 'src/index.js'), '// unrelated edit\n');
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  assert.deepEqual(report(elsewhere.root), { commit: head, dirty: false, distFresh: true });
});

test('editing a build input makes the dist stale and the tree dirty', (t) => {
  const { root, provenance, report } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  provenance('write');
  appendFileSync(path.join(root, 'src/index.js'), '// edited\n');
  assert.deepEqual(report().distFresh, false);
  assert.deepEqual(report().dirty, true);
});

test('an untracked file under src counts as a build input', (t) => {
  const { root, provenance, report } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  provenance('write');
  writeFileSync(path.join(root, 'src/new.js'), 'export {};\n');
  assert.deepEqual(report().distFresh, false);
  assert.deepEqual(report().dirty, true);
});

test('a dist edited after the build is not fresh', (t) => {
  const { root, provenance, report } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  provenance('write');
  appendFileSync(path.join(root, 'dist/index.es.js'), 'tampered\n');
  assert.deepEqual(report(), { ...report(), distFresh: false, dirty: false });
});

test('a missing provenance record reports not fresh', (t) => {
  const { root, report } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(report().distFresh, false);
});

test('a dist rebuilt before committing stays fresh after the commit lands', (t) => {
  const { root, run, provenance, report } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  appendFileSync(path.join(root, 'src/index.js'), '// fix\n');
  provenance('write');
  assert.deepEqual(report().dirty, true);
  run('git', ['add', '-A']);
  run('git', ['commit', '--quiet', '-m', 'fix']);
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  assert.deepEqual(report(), { commit: head, dirty: false, distFresh: true });
});
