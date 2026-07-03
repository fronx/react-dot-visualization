export function shouldDeferRequestForBuffers(request, buffers) {
  if (!request || request.type !== 'sim') return false;
  const sourceLength = request.sourceData?.length;
  if (!Number.isFinite(sourceLength) || sourceLength <= 0) return false;
  if (!buffers) return true;
  return sourceLength > buffers.N;
}

export function chooseBufferMismatchAction(job, request, buffers) {
  if (!job?.buffers || job.buffers === buffers) return 'continue';
  if (job.mode !== 'sim' || !request || request.id !== job.jobId) return 'idle';
  if (!buffers) return 'complete-live';
  if (!request.sourceData || request.sourceData.length < buffers.N) return 'complete-live';
  return 'rebind';
}
