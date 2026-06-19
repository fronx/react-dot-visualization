/**
 * Headless Dawn coverage for RDV's renderer-resident semantic score pass.
 * This validates the production TSL kernel that will feed R3FDotsWebGPU's
 * semantic score buffer without full score readback on the app hot path.
 */
import './tslShims.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instancedArray } from 'three/tsl';
import { makeRenderer, readbackF32 } from './tslHeadless.mjs';
import {
  SEMANTIC_SCORE_DISABLED,
  buildSemanticScoreChunkKernel,
  createSemanticScoreUniforms,
} from '../src/r3f/semanticScoreKernels.js';

const PARAMS = {
  cosineCeiling: 0.5,
  filenameAlpha: 0.25,
  curveGamma: 0.75,
  threshold: 0.42,
};

function dotRow(matrix, row, dims, query) {
  let dot = 0;
  const off = row * dims;
  for (let k = 0; k < dims; k++) dot += matrix[off + k] * query[k];
  return dot;
}

function combinedScore(cosine, filenameMatch, params = PARAMS) {
  const semantic = Math.max(0, Math.min(1, cosine / params.cosineCeiling)) ** params.curveGamma;
  return params.filenameAlpha * filenameMatch + (1 - params.filenameAlpha) * semantic;
}

function oracle(matrix, dims, query, filenameMatches, params = PARAMS) {
  const count = filenameMatches.length;
  const out = new Float32Array(count);
  for (let row = 0; row < count; row++) {
    const combined = combinedScore(dotRow(matrix, row, dims, query), filenameMatches[row], params);
    out[row] = combined >= params.threshold ? combined : SEMANTIC_SCORE_DISABLED;
  }
  return out;
}

function assertApproxEqual(got, expected, tol = 1e-5) {
  assert.equal(got.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(got[i] - expected[i]) <= tol,
      `[${i}]: GPU ${got[i]} vs oracle ${expected[i]}`,
    );
  }
}

async function makeHarness() {
  const renderer = await makeRenderer();
  const dims = 4;
  const count = 5;
  const matrix = new Float32Array([
    0.5, 0.5, 0.5, 0.5,
    0.9, 0.1, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    -0.5, 0.5, 0.5, 0.5,
    0.25, 0.25, 0.25, 0.25,
  ]);
  const queryArray = new Float32Array([0.5, 0.5, 0.5, 0.5]);
  const filenameMatchesArray = new Uint32Array([0, 1, 0, 0, 1]);
  const scoresArray = new Float32Array(count);
  scoresArray.fill(SEMANTIC_SCORE_DISABLED);

  const uniforms = createSemanticScoreUniforms(PARAMS);
  const query = instancedArray(queryArray, 'float');
  const filenameMatches = instancedArray(filenameMatchesArray, 'uint');
  const scores = instancedArray(scoresArray, 'float');
  const chunk0 = instancedArray(matrix.slice(0, 2 * dims), 'float');
  const chunk1 = instancedArray(matrix.slice(2 * dims), 'float');
  const kernels = [
    buildSemanticScoreChunkKernel({
      matrix: chunk0,
      query,
      filenameMatches,
      scores,
      dims,
      count: 2,
      baseRow: 0,
      uniforms,
    }),
    buildSemanticScoreChunkKernel({
      matrix: chunk1,
      query,
      filenameMatches,
      scores,
      dims,
      count: 3,
      baseRow: 2,
      uniforms,
    }),
  ];

  return {
    renderer,
    dims,
    count,
    matrix,
    query,
    queryArray,
    filenameMatchesArray,
    scores,
    uniforms,
    kernels,
    async readScores() {
      return new Float32Array(await readbackF32(renderer, scores, count));
    },
    dispose() {
      const device = renderer.backend?.device;
      renderer.dispose();
      device?.destroy();
    },
  };
}

test('semantic score chunks write renderer-ready scores into one full-layout buffer', async () => {
  const h = await makeHarness();
  try {
    for (const kernel of h.kernels) h.renderer.compute(kernel);
    assertApproxEqual(
      await h.readScores(),
      oracle(h.matrix, h.dims, h.queryArray, h.filenameMatchesArray),
    );
  } finally {
    h.dispose();
  }
});

test('semantic score kernels reuse resident buffers for a new query and threshold', async () => {
  const h = await makeHarness();
  try {
    const nextQuery = new Float32Array([1, 0, 0, 0]);
    h.query.value.array.set(nextQuery);
    h.query.value.needsUpdate = true;
    h.uniforms.thresholdU.value = 0.7;

    for (const kernel of h.kernels) h.renderer.compute(kernel);
    assertApproxEqual(
      await h.readScores(),
      oracle(h.matrix, h.dims, nextQuery, h.filenameMatchesArray, {
        ...PARAMS,
        threshold: 0.7,
      }),
    );
  } finally {
    h.dispose();
  }
});
