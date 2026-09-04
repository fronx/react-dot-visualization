#!/usr/bin/env node
// The library build, with the two checks that keep a shared checkout honest.
// dist/ is what every app linking this repo loads, so before bundling we ask:
//
//   1. Is another live session editing this checkout right now? Then its
//      unfinished work would ship into everyone's running app — refuse.
//   2. Are there uncommitted changes nobody has declared? Refuse unless the
//      building session holds the claim, or --allow-dirty says so explicitly.
//
// The answer comes from the Vibseek session registry (~/.vibseek/dev-ledger.db,
// scripts/dev-ledger/sessions.mjs in any fingertip checkout — found through the
// registry's own rows, so nothing here needs to know where fingertip lives; a
// checkout too old to know the build rule is skipped). Without a registry on
// this machine only the dirty rule applies.
//
//   node scripts/build-lib.mjs [--allow-dirty]   # guard, vite build, write provenance
//   node scripts/build-lib.mjs --check-only      # guard only; the post-checkout hook's warning
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitState, write } from './dist-provenance.mjs';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const args = new Set(process.argv.slice(2));
const LEDGER = path.join(homedir(), '.vibseek', 'dev-ledger.db');

const BUILD_VERB = '--may-build';
const isMainCheckout = (worktree) => !worktree.includes('/.claude/worktrees/');

function sessionsCli() {
  if (!existsSync(LEDGER)) return null;
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(LEDGER, { readOnly: true });
  try {
    const rows = db.prepare('SELECT worktree FROM sessions WHERE worktree IS NOT NULL ORDER BY updated_ts DESC').all();
    return rows
      .map((r) => r.worktree)
      .sort((a, b) => Number(isMainCheckout(b)) - Number(isMainCheckout(a)))
      .map((worktree) => path.join(worktree, 'scripts', 'dev-ledger', 'sessions.mjs'))
      .find((cli) => existsSync(cli) && readFileSync(cli, 'utf8').includes(BUILD_VERB)) ?? null;
  } finally {
    db.close();
  }
}

function sqlite() {
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
  try {
    return process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
}

function guard() {
  const { dirty } = gitState();
  const cli = sessionsCli();
  if (!cli) {
    if (dirty && !args.has('--allow-dirty')) {
      return 'There are uncommitted changes here. Commit them, or build anyway with --allow-dirty.';
    }
    return null;
  }
  const check = spawnSync(process.execPath, [
    cli, 'claim', '--path', repoRoot, BUILD_VERB,
    ...(dirty ? ['--dirty'] : []),
    ...(args.has('--allow-dirty') ? ['--allow-dirty'] : []),
  ], { encoding: 'utf8' });
  return check.status === 0 ? null : (check.stderr || check.stdout).trim();
}

const refusal = guard();
if (args.has('--check-only')) {
  if (refusal) console.error(`\n[react-dot-visualization] ${refusal}\n`);
  process.exit(0);
}
if (refusal) {
  console.error(`\n[build:lib] Not building. ${refusal}\n`);
  process.exit(1);
}
const build = spawnSync('npx', ['vite', 'build', '--config', 'vite.lib.config.js'], { cwd: repoRoot, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
write();
