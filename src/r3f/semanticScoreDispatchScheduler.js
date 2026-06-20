export const DEFAULT_SEMANTIC_SCORE_FRAME_BUDGET_MS = 12;

export function createSemanticScoreDispatchJob(dispatchId, resources, now = performance.now()) {
  return {
    dispatchId,
    resources,
    nextChunk: 0,
    frames: 0,
    submitMs: 0,
    startedAt: now,
  };
}

export function shouldReplaceSemanticScoreDispatchJob(job, dispatchId, resources) {
  return !job || job.dispatchId !== dispatchId || job.resources !== resources;
}

export function stepSemanticScoreDispatchJob(
  job,
  {
    now = () => performance.now(),
    computeChunk,
    computeSummary,
    computePublish = null,
    frameBudgetMs = DEFAULT_SEMANTIC_SCORE_FRAME_BUDGET_MS,
    minChunksPerFrame = 1,
  },
) {
  const resources = job.resources;
  const chunks = resources?.chunks ?? [];
  const frameStarted = now();
  let chunksThisFrame = 0;

  while (job.nextChunk < chunks.length) {
    const chunk = chunks[job.nextChunk];
    const chunkStarted = now();
    computeChunk(chunk, job.nextChunk);
    job.submitMs += now() - chunkStarted;
    job.nextChunk += 1;
    chunksThisFrame += 1;

    if (
      chunksThisFrame >= minChunksPerFrame
      && now() - frameStarted >= frameBudgetMs
      && job.nextChunk < chunks.length
    ) {
      job.frames += 1;
      return {
        done: false,
        chunksThisFrame,
        frameMs: now() - frameStarted,
        submitMs: job.submitMs,
        frames: job.frames,
      };
    }
  }

  if (chunksThisFrame > 0 && now() - frameStarted >= frameBudgetMs) {
    job.frames += 1;
    return {
      done: false,
      chunksThisFrame,
      frameMs: now() - frameStarted,
      submitMs: job.submitMs,
      frames: job.frames,
    };
  }

  const summaryStarted = now();
  computeSummary(resources);
  if (typeof computePublish === 'function') {
    computePublish(resources);
  }
  job.submitMs += now() - summaryStarted;
  job.frames += 1;

  return {
    done: true,
    chunksThisFrame,
    frameMs: now() - frameStarted,
    submitMs: job.submitMs,
    frames: job.frames,
    wallMs: now() - job.startedAt,
  };
}
