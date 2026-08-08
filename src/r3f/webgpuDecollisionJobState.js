// A 'sim' request may only start against the data it was issued for. The
// request lands in the channel ref a frame before React commits the matching
// data/buffers to the R3F child, so the frame loop can see a request whose
// world doesn't exist yet. Two guards, one rule:
//   - identity: a request carrying a dataKey waits until the displayed data
//     identity matches. This is the real invariant — it also holds equal-count
//     membership swaps, where starting early binds the OUTGOING buffers and
//     the data-swap flip then silently replaces the running job (the
//     never-settling Refresh, 2026-08-08/09).
//   - count: startJob loops over buffers.N reading sourceData[i], so a
//     mismatched size walks past the snapshot's end (crashed with undefined.x
//     on a shrinking swap, 2026-08-08). Kept as its own check because it also
//     guards identity-less requests and the mid-stream partial-count window.
// Deferring cannot wedge: the channel keeps only the latest request, and the
// scheduler replaces it whenever the data changes, so request and buffers
// converge.
export function shouldDeferRequestForBuffers(request, buffers, displayedDataKey = null) {
  if (!request || request.type !== 'sim') return false;
  if (request.dataKey != null && request.dataKey !== displayedDataKey) return true;
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
