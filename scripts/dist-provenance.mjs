#!/usr/bin/env node
// dist/ is gitignored build output, yet consumers that link this repo (npm link
// or a node_modules symlink) bundle whatever dist happens to be on disk. This
// script makes dist self-describing: `write` (run by build:lib) records digests
// of the build inputs and outputs plus the git state; `report` tells a consumer
// whether the current dist is derived from the src currently on disk, and which
// commit that src is.
//
//   node scripts/dist-provenance.mjs write    # after vite build; writes dist/provenance.json
//   node scripts/dist-provenance.mjs report   # prints { commit, dirty, distFresh, built }
//
// `built` is what the dist on disk was made from ({ commit, dirty } at build
// time, or null before any provenance was written) — the consumer's first fact
// when "the app feels different today".
//
// Every path resolves against this file's own repository, never the working
// directory: a consumer invoking it from elsewhere would otherwise get its own
// repo's commit and a meaningless freshness verdict, silently and in the right
// shape — the exact kind of lie the record exists to prevent.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const inRepo = (...segments) => path.join(repoRoot, ...segments);

const BUILD_INPUT_PATHS = [
  'src',
  'vite.lib.config.js',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
];
const PROVENANCE_FILE = inRepo('dist/provenance.json');

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

function fileHash(filePath) {
  if (!existsSync(filePath)) return 'MISSING';
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

// Keyed by repo-relative path so the digest is identical wherever the
// repository is checked out.
function combineHashes(relativePaths) {
  const digest = createHash('sha256');
  for (const relativePath of [...relativePaths].sort()) {
    digest.update(`${relativePath}\0${fileHash(inRepo(relativePath))}\n`);
  }
  return digest.digest('hex');
}

function srcDigest() {
  const listed = git('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...BUILD_INPUT_PATHS);
  return combineHashes(listed.split('\0').filter(Boolean));
}

function distDigest() {
  const files = readdirSync(inRepo('dist'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .filter((filePath) => path.resolve(filePath) !== PROVENANCE_FILE)
    .map((filePath) => path.relative(repoRoot, filePath));
  return combineHashes(files);
}

export function gitState() {
  return {
    commit: git('rev-parse', 'HEAD').trim(),
    dirty: git('status', '--porcelain', '--', ...BUILD_INPUT_PATHS).trim() !== '',
  };
}

export function write() {
  if (!existsSync(inRepo('dist'))) throw new Error('dist/ not found; run the lib build first');
  const provenance = { ...gitState(), srcDigest: srcDigest(), distDigest: distDigest() };
  writeFileSync(PROVENANCE_FILE, `${JSON.stringify(provenance, null, 2)}\n`);
}

function report() {
  const recorded = existsSync(PROVENANCE_FILE)
    ? JSON.parse(readFileSync(PROVENANCE_FILE, 'utf8'))
    : null;
  const distFresh = recorded !== null
    && recorded.srcDigest === srcDigest()
    && recorded.distDigest === distDigest();
  const built = recorded && { commit: recorded.commit, dirty: recorded.dirty };
  console.log(JSON.stringify({ ...gitState(), distFresh, built }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const command = process.argv[2];
  if (command === 'write') write();
  else if (command === 'report') report();
  else {
    console.error('usage: dist-provenance.mjs write|report');
    process.exit(2);
  }
}
