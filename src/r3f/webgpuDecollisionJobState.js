// A 'sim' request may only start against buffers of exactly its snapshot's
// size: startJob loops over buffers.N reading sourceData[i], so a larger
// buffer set walks past the snapshot's end (crashed with undefined.x on a
// shrinking data swap, 2026-08-08 — the request lands in the channel ref a
// frame before React commits the smaller data/buffers). Deferring cannot
// wedge: the channel keeps only the latest request, and the scheduler
// replaces it whenever the data changes, so request and buffers converge.
export function shouldDeferRequestForBuffers(request, buffers) {
  if (!request || request.type !== 'sim') return false;
  const sourceLength = request.sourceData?.length;
  if (!Number.isFinite(sourceLength) || sourceLength <= 0) return false;
  if (!buffers) return true;
  return sourceLength !== buffers.N;
}

export function chooseBufferMismatchAction(job, request, buffers) {
  if (!job?.buffers || job.buffers === buffers) return 'continue';
  if (job.mode !== 'sim' || !request || request.id !== job.jobId) return 'idle';
  if (!buffers) return 'complete-live';
  if (!request.sourceData || request.sourceData.length < buffers.N) return 'complete-live';
  return 'rebind';
}
