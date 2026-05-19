// Main pipeline shaders: clearBins, countBins, placeParticles, collide, apply.
// The prefix-sum scan lives in decollision-webgpu-scan.wgsl with its own
// independent bind group so no buffer is ever in two bind groups at once
// — that would trip WebGPU's "same buffer read+write in one dispatch" guard.

struct Params {
  nNodes: u32,
  numBins: u32,
  gridDimX: u32,
  gridDimY: u32,
  gridMinX: f32,
  gridMinY: f32,
  cellSize: f32,
  epoch: u32,
  strength: f32,
  velocityDecay: f32,
  jitter: f32,
  _pad: f32,
};

@group(0) @binding(0) var<storage, read_write> positions: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> velocities: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> radii: array<f32>;
@group(0) @binding(3) var<storage, read_write> nextVelocities: array<vec2<f32>>;
@group(0) @binding(4) var<uniform> params: Params;
@group(0) @binding(5) var<storage, read_write> binCountAtomic: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> placeCounter: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> sortedIndices: array<u32>;

const WORKGROUP_SIZE: u32 = 64u;
const EPS: f32 = 1e-6;

fn hash_u32(x: u32) -> u32 {
  var v = x;
  v ^= v >> 16u;
  v *= 0x7feb352du;
  v ^= v >> 15u;
  v *= 0x846ca68bu;
  v ^= v >> 16u;
  return v;
}

fn jitter_component(seed: u32) -> f32 {
  let h = hash_u32(seed);
  return (f32(h) / 4294967296.0 - 0.5) * params.jitter;
}

fn cellOf(pos: vec2<f32>) -> u32 {
  let cx = clamp(i32(floor((pos.x - params.gridMinX) / params.cellSize)), 0, i32(params.gridDimX) - 1);
  let cy = clamp(i32(floor((pos.y - params.gridMinY) / params.cellSize)), 0, i32(params.gridDimY) - 1);
  return u32(cy) * params.gridDimX + u32(cx);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn clearBins(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i > params.numBins) {
    return;
  }
  atomicStore(&binCountAtomic[i], 0u);
  if (i < params.numBins) {
    atomicStore(&placeCounter[i], 0u);
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn countBins(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.nNodes) {
    return;
  }
  let xi = positions[i] + velocities[i];
  let bin = cellOf(xi);
  atomicAdd(&binCountAtomic[bin + 1u], 1u);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn placeParticles(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.nNodes) {
    return;
  }
  let xi = positions[i] + velocities[i];
  let bin = cellOf(xi);
  let slot = atomicAdd(&placeCounter[bin], 1u);
  let base = atomicLoad(&binCountAtomic[bin]);
  sortedIndices[base + slot] = i;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn collide(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.nNodes) {
    return;
  }

  let posI = positions[i];
  let velI = velocities[i];
  let radiusI = max(radii[i], EPS);
  let radiusI2 = radiusI * radiusI;
  let xi = posI + velI;

  let cx0 = i32(floor((xi.x - params.gridMinX) / params.cellSize));
  let cy0 = i32(floor((xi.y - params.gridMinY) / params.cellSize));
  let cxLo = max(cx0 - 1, 0);
  let cxHi = min(cx0 + 1, i32(params.gridDimX) - 1);
  let cyLo = max(cy0 - 1, 0);
  let cyHi = min(cy0 + 1, i32(params.gridDimY) - 1);

  var total = vec2<f32>(0.0, 0.0);

  for (var cy = cyLo; cy <= cyHi; cy = cy + 1) {
    for (var cx = cxLo; cx <= cxHi; cx = cx + 1) {
      let bin = u32(cy) * params.gridDimX + u32(cx);
      let start = atomicLoad(&binCountAtomic[bin]);
      let end = atomicLoad(&binCountAtomic[bin + 1u]);
      for (var k = start; k < end; k = k + 1u) {
        let j = sortedIndices[k];
        if (j == i) {
          continue;
        }
        let xj = positions[j] + velocities[j];
        let radiusJ = max(radii[j], EPS);
        let minDist = radiusI + radiusJ;
        var dx = xi.x - xj.x;
        var dy = xi.y - xj.y;
        var dist2 = dx * dx + dy * dy;
        let seedBase = ((i * 0x9e3779b9u) ^ (j * 0x85ebca6bu) ^ params.epoch);

        if (dist2 < (minDist * minDist)) {
          if (dx == 0.0) {
            dx = jitter_component(seedBase ^ 0xa341316cu);
            dist2 = dist2 + dx * dx;
          }
          if (dy == 0.0) {
            dy = jitter_component(seedBase ^ 0xc8013ea4u);
            dist2 = dist2 + dy * dy;
          }
          dist2 = max(dist2, EPS);
          let dist = sqrt(dist2);
          var scale = (minDist - dist) / dist;
          scale = scale * params.strength;
          let radiusJ2 = radiusJ * radiusJ;
          let weight = radiusJ2 / max(radiusI2 + radiusJ2, EPS);
          total = total + vec2<f32>(dx, dy) * (scale * weight);
        }
      }
    }
  }

  nextVelocities[i] = velI + total;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn apply(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.nNodes) {
    return;
  }

  let damped = nextVelocities[i] * params.velocityDecay;
  positions[i] = positions[i] + damped;
  velocities[i] = damped;
}
