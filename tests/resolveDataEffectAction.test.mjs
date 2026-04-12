import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDataEffectAction } from '../src/resolveDataEffectAction.js';

test('initial load completes: apply and clear stable positions', () => {
  const action = resolveDataEffectAction(false, false, false, false);
  assert.strictEqual(action, 'apply-and-clear');
});

test('full UMAP refresh: apply and clear stable positions', () => {
  const action = resolveDataEffectAction(false, false, true, false);
  assert.strictEqual(action, 'apply-and-clear');
});

test('incremental import with stable positions: hold stable', () => {
  const action = resolveDataEffectAction(true, true, true, true);
  assert.strictEqual(action, 'hold-stable');
});

test('discovery dots arrive (not marked incremental): apply and clear', () => {
  // Discovery additions skip isIncrementalUpdate — positions are final (skipRefine),
  // not intermediate. The data effect commits them normally.
  const action = resolveDataEffectAction(false, false, true, true);
  assert.strictEqual(action, 'apply-and-clear');
});

test('import incremental with stable positions and data grew: hold stable', () => {
  const action = resolveDataEffectAction(true, true, false, true);
  assert.strictEqual(action, 'hold-stable');
});

test('import incremental, no stable positions, data grew: hold incremental', () => {
  const action = resolveDataEffectAction(false, true, true, true);
  assert.strictEqual(action, 'hold-incremental');
});

test('import incremental, no prior data at all: apply raw positions', () => {
  const action = resolveDataEffectAction(false, true, false, true);
  assert.strictEqual(action, 'apply');
});

test('defocus with discovery removal (not incremental): apply and clear', () => {
  const action = resolveDataEffectAction(false, false, true, false);
  assert.strictEqual(action, 'apply-and-clear');
});

test('discovery dots removed while isIncrementalUpdate still true: apply (data shrunk)', () => {
  // When discovery is dismissed, data shrinks. Even though isIncrementalUpdate
  // may still be true from the previous add, we must apply the removal.
  const action = resolveDataEffectAction(false, true, true, false);
  assert.strictEqual(action, 'apply');
});

test('same-size data with isIncrementalUpdate (metadata update): apply', () => {
  // Data didn't grow — e.g., metadata updates for existing dots.
  // Should apply the update, not hold.
  const action = resolveDataEffectAction(false, true, true, false);
  assert.strictEqual(action, 'apply');
});
