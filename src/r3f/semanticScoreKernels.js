/**
 * WebGPU semantic score kernels for the RDV map renderer.
 *
 * The hot map path wants query-vector scoring to write directly into the same
 * per-instance score buffer the dot material reads. This module is plain JS so
 * headless Dawn tests and R3FDotsWebGPU can share the exact same TSL compute.
 */
import {
  Fn, Loop, If, instanceIndex, float, uint, clamp, select, uniform, floor,
  atomicAdd, atomicMax, exp2, max, mix,
} from 'three/tsl';

export const SEMANTIC_SCORE_DISABLED = -1;
export const SEMANTIC_SCORE_SUMMARY_BUCKETS = 256;
export const SEMANTIC_SCORE_SUMMARY_SCALE = 1000000;
/** Alpha multiplier applied to below-threshold dots (dimmed, not hidden). */
export const SEMANTIC_BELOW_THRESHOLD_ALPHA_MULTIPLIER = 0.35;

/** Map a per-instance semantic score to the dim→hot colour ramp; scores at or
 *  below SEMANTIC_SCORE_DISABLED keep the base colour. Shared by the dot layer
 *  and the density splat so the two paint identically (drift here desyncs the
 *  crisp dots from the zoomed-out splat). `semantic` carries the uniforms
 *  { loU, hiU, dimColorU, hotColorU }. */
export function semanticColorNode(baseColor, score, semantic) {
  const span = max(semantic.hiU.sub(semantic.loU), float(0.000001));
  const t = clamp(score.sub(semantic.loU).div(span), float(0), float(1));
  const color = mix(semantic.dimColorU, semantic.hotColorU, t);
  return select(score.greaterThan(float(SEMANTIC_SCORE_DISABLED)), color, baseColor);
}

/** Below-threshold dots dim to SEMANTIC_BELOW_THRESHOLD_ALPHA_MULTIPLIER of base
 *  alpha; disabled (unscored) dots keep base alpha. Paired with semanticColorNode. */
export function semanticAlphaNode(baseAlpha, score, semantic) {
  return select(
    score.greaterThan(float(SEMANTIC_SCORE_DISABLED)),
    select(
      score.lessThan(semantic.loU),
      baseAlpha.mul(float(SEMANTIC_BELOW_THRESHOLD_ALPHA_MULTIPLIER)),
      baseAlpha,
    ),
    baseAlpha,
  );
}

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

function unpackF16FromU32(matrixF16Packed, elementIndex) {
  const word = matrixF16Packed.element(elementIndex.div(uint(2)));
  const half = select(
    elementIndex.bitAnd(uint(1)).equal(uint(1)),
    word.shiftRight(uint(16)),
    word.bitAnd(uint(0xffff)),
  );
  const sign = select(half.bitAnd(uint(0x8000)).equal(uint(0)), float(1), float(-1));
  const exponent = half.shiftRight(uint(10)).bitAnd(uint(0x1f));
  const mantissa = half.bitAnd(uint(0x03ff));
  const mantissaF = float(mantissa).div(float(1024));
  const subnormal = sign.mul(exp2(float(-14))).mul(mantissaF);
  const normal = sign
    .mul(exp2(float(exponent).sub(float(15))))
    .mul(float(1).add(mantissaF));
  return select(exponent.equal(uint(0)), subnormal, normal);
}

/**
 * Same score pass as buildSemanticScoreChunkKernel, but the matrix is stored as
 * two IEEE-754 binary16 values packed into each u32. This keeps the resident GPU
 * matrix at half the f32 footprint while preserving the existing query, summary,
 * and material score buffers.
 */
export function buildSemanticScoreChunkF16Kernel({
  matrixF16Packed,
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
      dot.addAssign(unpackF16FromU32(matrixF16Packed, rowOffset.add(k)).mul(query.element(k)));
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

/**
 * Publish a completed staged score pass into the material-visible score buffer.
 *
 * Large maps can submit chunked score kernels across multiple render frames.
 * Writing those chunks directly to the visible buffer makes semantic paint
 * update in bands. Keeping the score pass staged and publishing once preserves
 * atomic query updates while still allowing chunked submission.
 */
export function buildSemanticScorePublishKernel({
  stagedScores,
  visibleScores,
  count,
}) {
  return Fn(() => {
    visibleScores.element(instanceIndex).assign(stagedScores.element(instanceIndex));
  })().compute(count);
}

/**
 * Quantize scores that pass a threshold into a u32 buffer. Zero means no match;
 * positive values preserve score ordering for delayed list catch-up without
 * reading back the full float score buffer or recomputing the matrix scan.
 */
export function buildSemanticMatchedScoreKernel({
  scores,
  matchedScores,
  threshold,
  count,
  scale = SEMANTIC_SCORE_SUMMARY_SCALE,
}) {
  return Fn(() => {
    const score = scores.element(instanceIndex);
    const fixed = uint(clamp(score, float(0), float(1)).mul(float(scale))).add(uint(1));
    matchedScores.element(instanceIndex).assign(select(
      score.greaterThanEqual(threshold),
      fixed,
      uint(0),
    ));
  })().compute(count);
}
