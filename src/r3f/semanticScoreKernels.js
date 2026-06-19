/**
 * WebGPU semantic score kernels for the RDV map renderer.
 *
 * The hot map path wants query-vector scoring to write directly into the same
 * per-instance score buffer the dot material reads. This module is plain JS so
 * headless Dawn tests and R3FDotsWebGPU can share the exact same TSL compute.
 */
import { Fn, Loop, instanceIndex, float, uint, clamp, select, uniform } from 'three/tsl';

export const SEMANTIC_SCORE_DISABLED = -1;

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
 * normalized text vector. `filenameMatches` and `scores` are full-layout
 * buffers indexed by global row (`baseRow + localRow`). The output is the
 * renderer-ready combined score, or `SEMANTIC_SCORE_DISABLED` below threshold.
 */
export function buildSemanticScoreChunkKernel({
  matrix,
  query,
  filenameMatches,
  scores,
  dims,
  count,
  baseRow = 0,
  uniforms,
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
    scores.element(globalRow).assign(select(combined.greaterThanEqual(uniforms.thresholdU), combined, disabled));
  })().compute(count);
}
