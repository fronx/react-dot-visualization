import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSemanticScoreDispatchJob,
  shouldReplaceSemanticScoreDispatchJob,
  stepSemanticScoreDispatchJob,
} from '../src/r3f/semanticScoreDispatchScheduler.js';

test('semantic score dispatch scheduler respects a per-frame budget', () => {
  let t = 0;
  const resources = { chunks: ['a', 'b', 'c', 'd', 'e'] };
  const job = createSemanticScoreDispatchJob(1, resources, t);
  const submitted = [];
  const summaries = [];
  const now = () => t;

  let result = stepSemanticScoreDispatchJob(job, {
    now,
    frameBudgetMs: 10,
    computeChunk: (chunk) => {
      submitted.push(chunk);
      t += 5;
    },
    computeSummary: () => {
      summaries.push('summary');
      t += 2;
    },
  });

  assert.equal(result.done, false);
  assert.deepEqual(submitted, ['a', 'b']);
  assert.deepEqual(summaries, []);
  assert.equal(job.nextChunk, 2);

  result = stepSemanticScoreDispatchJob(job, {
    now,
    frameBudgetMs: 10,
    computeChunk: (chunk) => {
      submitted.push(chunk);
      t += 5;
    },
    computeSummary: () => {
      summaries.push('summary');
      t += 2;
    },
  });

  assert.equal(result.done, false);
  assert.deepEqual(submitted, ['a', 'b', 'c', 'd']);
  assert.deepEqual(summaries, []);
  assert.equal(job.nextChunk, 4);

  result = stepSemanticScoreDispatchJob(job, {
    now,
    frameBudgetMs: 10,
    computeChunk: (chunk) => {
      submitted.push(chunk);
      t += 5;
    },
    computeSummary: () => {
      summaries.push('summary');
      t += 2;
    },
  });

  assert.equal(result.done, true);
  assert.deepEqual(submitted, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(summaries, ['summary']);
  assert.equal(result.frames, 3);
  assert.equal(result.submitMs, 27);
});

test('semantic score dispatch scheduler publishes only after every chunk finishes', () => {
  let t = 0;
  const resources = { chunks: ['a', 'b', 'c'] };
  const job = createSemanticScoreDispatchJob(1, resources, t);
  const submitted = [];
  const summaries = [];
  const publishes = [];
  const now = () => t;
  const step = () => stepSemanticScoreDispatchJob(job, {
    now,
    frameBudgetMs: 6,
    computeChunk: (chunk) => {
      submitted.push(chunk);
      t += 4;
    },
    computeSummary: () => {
      summaries.push('summary');
      t += 1;
    },
    computePublish: () => {
      publishes.push('publish');
      t += 1;
    },
  });

  let result = step();
  assert.equal(result.done, false);
  assert.deepEqual(submitted, ['a', 'b']);
  assert.deepEqual(summaries, []);
  assert.deepEqual(publishes, []);

  result = step();
  assert.equal(result.done, true);
  assert.deepEqual(submitted, ['a', 'b', 'c']);
  assert.deepEqual(summaries, ['summary']);
  assert.deepEqual(publishes, ['publish']);
  assert.equal(result.submitMs, 14);
});

test('semantic score dispatch scheduler replaces stale jobs by dispatch id or resources', () => {
  const resources = { chunks: [] };
  const job = createSemanticScoreDispatchJob(1, resources, 0);

  assert.equal(shouldReplaceSemanticScoreDispatchJob(job, 1, resources), false);
  assert.equal(shouldReplaceSemanticScoreDispatchJob(job, 2, resources), true);
  assert.equal(shouldReplaceSemanticScoreDispatchJob(job, 1, { chunks: [] }), true);
  assert.equal(shouldReplaceSemanticScoreDispatchJob(null, 1, resources), true);
});
