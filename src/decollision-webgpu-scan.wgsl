// Hillis-Steele inclusive prefix-sum kernel for the spatial-hash pipeline.
//
// Run iteratively with stepSize doubling (1, 2, 4, ..., until >= n).
// Inputs alternate (ping-pong) between two buffers across iterations.
//
// Kept in its own WGSL module so its bind group doesn't collide with the
// main pipeline's. Sharing a module would force the main bind group to
// include a buffer (scanIn) that conflicts with main's atomic counters,
// triggering WebGPU's "same buffer used as read and write" hazard.

struct ScanParams {
  n: u32,
  stepSize: u32,
};

@group(0) @binding(0) var<storage, read> scanIn: array<u32>;
@group(0) @binding(1) var<storage, read_write> scanOut: array<u32>;
@group(0) @binding(2) var<uniform> params: ScanParams;

const WORKGROUP_SIZE: u32 = 64u;

@compute @workgroup_size(WORKGROUP_SIZE)
fn prefixSumStep(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) {
    return;
  }
  if (i < params.stepSize) {
    scanOut[i] = scanIn[i];
  } else {
    scanOut[i] = scanIn[i] + scanIn[i - params.stepSize];
  }
}
