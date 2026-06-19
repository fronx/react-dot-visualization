/**
 * WebGPU semantic score kernels for the RDV map renderer.
 *
 * The hot map path wants query-vector scoring to write directly into the same
 * per-instance score buffer the dot material reads. This module is plain JS so
 * headless Dawn tests and R3FDotsWebGPU can share the exact same TSL compute.
 */
import {
  Fn, Loop, If, instanceIndex, float, uint, clamp, select, uniform, floor,
  atomicAdd, atomicMax,
} from 'three/tsl';

export const SEMANTIC_SCORE_DISABLED = -1;
export const SEMANTIC_SCORE_SUMMARY_BUCKETS = 256;
export const SEMANTIC_SCORE_SUMMARY_SCALE = 1000000;

export function createSemanticScoreUniforms({
  cosineCeiling = 0.32,
  filenameAlpha = 0.35,
  curveGamma = 0.72,
  threshold = 0,
} = {}) {
  return {
    cosineCeilingU: uniform(float(cosineCeiling)),
    filenameAlphaU: uniform(float(filenameAlpha)),
    curveGammaU: uniform(float(curveGamma)),
    thresholdU: uniform(float(threshold)),
  };
}

/**
 * Build one chunk of the exact semantic score pass.
 *
 * `matrix` is chunk-local, row-major normalized audio vectors. `query` is the
 * normalized text vector. `filenameMatches`, `semanticDisableMask`, and
 * `scores` are full-layout buffers indexed by global row (`baseRow + localRow`).
 * The output is the renderer-ready combined score. By default scores below the
 * threshold are disabled to preserve the legacy CPU-filtered paint path; direct
 * map coloring can set `disableBelowThreshold: false` and use the material
 * range to draw below-threshold rows at the dim end.
 */
export function buildSemanticScoreChunkKernel({
  matrix,
  query,
  filenameMatches,
  semanticDisableMask,
  scores,
  dims,
  count,
  baseRow = 0,
  uniforms,
  disableBelowThreshold = true,
}) {
  const dimsU = uint(dims);
  const baseRowU = uint(baseRow);
  const disabled = float(SEMANTIC_SCORE_DISABLED);
  const oneMinusAlpha = float(1).sub(uniforms.filenameAlphaU);

  return Fn(() => {
    const localRow = instanceIndex;
    const globalRow = baseRowU.add(localRow);
    const rowOffset = localRow.mul(dimsU);
    const dot = float(0).toVar();

    Loop(dims, ({ i: k }) => {
      dot.addAssign(matrix.element(rowOffset.add(k)).mul(query.element(k)));
    });

    const semantic = clamp(dot.div(uniforms.cosineCeilingU), float(0), float(1)).pow(uniforms.curveGammaU);
    const filename = float(filenameMatches.element(globalRow));
    const combined = uniforms.filenameAlphaU.mul(filename).add(oneMinusAlpha.mul(semantic));
    const thresholded = disableBelowThreshold
      ? select(combined.greaterThanEqual(uniforms.thresholdU), combined, disabled)
      : combined;
    scores.element(globalRow).assign(select(
      semanticDisableMask.element(globalRow).greaterThan(uint(0)),
      disabled,
      thresholded,
    ));
  })().compute(count);
}

/**
 * Reduce renderer-ready semantic scores to a small summary buffer.
 *
 * The score pass writes values in [0, 1], or SEMANTIC_SCORE_DISABLED for rows
 * whose normal paint should win. This summary keeps full score payloads on the
 * GPU: the app can read back a fixed-size histogram plus max score and derive
 * approximate quantiles/ranges without pulling N floats over the bridge.
 */
export function buildSemanticScoreSummaryKernel({
  scores,
  histogram,
  maxScoreFixed,
  count,
  bucketCount = SEMANTIC_SCORE_SUMMARY_BUCKETS,
  scale = SEMANTIC_SCORE_SUMMARY_SCALE,
}) {
  return Fn(() => {
    const score = scores.element(instanceIndex);
    If(score.greaterThanEqual(float(0)), () => {
      const clamped = clamp(score, float(0), float(1));
      const bucket = uint(floor(clamped.mul(float(bucketCount - 1))));
      atomicAdd(histogram.element(bucket), uint(1));
      atomicMax(maxScoreFixed.element(uint(0)), uint(clamped.mul(float(scale))));
    });
  })().compute(count);
}
