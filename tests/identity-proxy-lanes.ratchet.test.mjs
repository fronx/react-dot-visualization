import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Ratchet (maintenance review 2026-08-09, fingertip wdtdx55qjq): five fixes in
// one week (b847c0c, 217da8b, dfcb6c7, e3facd9, fce90a5) were one mechanism —
// dataKey is optional, so seams infer layout identity from proxies (buffer
// count, effect-updated refs, O(n) position compares) and stale state crosses
// the swap boundary when a proxy misfires. Each lane below keeps the
// identity-less fallback alive.
//
// Remedy: make dataKey required on both front-ends, key sim/restore/relaunch
// decisions on it, delete the count-as-identity fallbacks (count stays only
// for the within-identity partial-buffer window), and where callers guarantee
// key-changes-iff-content-changes, retire the O(n) position compare.
// Retirement: delete this test when those lanes are gone.
//
// Counts may only SHRINK. Raising a bound to pass is never the fix.

const src = (rel) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

const count = (text, regex) => (text.match(regex) ?? []).length;

test('identity-proxy lanes only shrink', () => {
  const lanes = {
    // Keyless requests fall back to a count comparison in the sim-defer gate.
    countFallbackInDeferGate: count(src('r3f/webgpuDecollisionJobState.js'), /request\.dataKey == null/g),
    // The restore-skip is a caller-supplied flag defaulting to "trust value compares".
    identityFlagDefaultsOff: count(src('resolveDataEffectPositions.js'), /dataIdentityChanged = false/g),
    // Length change stands in for "the layout changed" as a relaunch trigger.
    lengthAsRelaunchTrigger:
      count(src('r3f/DotVisualizationR3F.jsx'), /prevLength !== validData\.length/g)
      + count(src('DotVisualization.jsx'), /prevLength !== validData\.length/g),
    // The Canvas front-end is fully keyless (R9 restore bug latent there).
    keylessCanvasFrontEnd: count(src('DotVisualization.jsx'), /dataKey/g) === 0 ? 1 : 0,
  };
  const bounds = {
    countFallbackInDeferGate: 1,
    identityFlagDefaultsOff: 1,
    lengthAsRelaunchTrigger: 2,
    keylessCanvasFrontEnd: 1,
  };
  for (const [lane, bound] of Object.entries(bounds)) {
    assert.ok(
      lanes[lane] <= bound,
      `identity-proxy lane "${lane}" grew: ${lanes[lane]} > ${bound}. ` +
      'Do not add another identity proxy - key the decision on dataKey (see test header).',
    );
  }
});
