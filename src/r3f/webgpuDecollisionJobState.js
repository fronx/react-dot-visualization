export function chooseBufferMismatchAction(job, request, buffers) {
  if (!job?.buffers || job.buffers === buffers) return 'continue';
  if (job.mode !== 'sim' || !request || request.id !== job.jobId) return 'idle';
  if (!buffers) return 'complete-live';
  if (!request.sourceData || request.sourceData.length < buffers.N) return 'complete-live';
  return 'rebind';
}
