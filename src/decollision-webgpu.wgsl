struct Params {
  nNodes: u32,
  epoch: u32,
  _pad0: u32,
  _pad1: u32,
  strength: f32,
  velocityDecay: f32,
  jitter: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<storage, read_write> positions: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> velocities: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> radii: array<f32>;
@group(0) @binding(3) var<storage, read_write> nextVelocities: array<vec2<f32>>;
@group(0) @binding(4) var<uniform> params: Params;

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
  var total = vec2<f32>(0.0, 0.0);

  for (var j: u32 = 0u; j < params.nNodes; j = j + 1u) {
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
