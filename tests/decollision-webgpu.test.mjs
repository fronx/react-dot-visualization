/**
 * Direct WGSL tests for the spatial-hash decollision pipeline.
 *
 * Loads `src/decollision-webgpu.wgsl`, runs it through Dawn (via the
 * `webgpu` npm package), and asserts per-kernel correctness against
 * hand-prepared inputs and CPU oracles.
 *
 * Each test creates a fresh GPU device + pipelines. This is required —
 * Dawn-Node crashes (libc++abi "mutex lock failed") if a single device is
 * shared across multiple `test()` cases in node:test. The setup cost is
 * ~10–20 ms per test, which is acceptable.
 */

// Dawn-Node quirks worked around in this file:
//   1. Tests live at top level — `describe()` wrapping triggers SIGSEGV.
//   2. ONE `create([])` call at module load; tests reuse that gpu handle.
//      Calling `create([])` per test corrupts state and the second test
//      crashes with `libc++abi: mutex lock failed`.
//   3. Each test still requests its own `device` from the shared gpu —
//      sharing the device across tests also crashes.
//   4. Staging buffers (mapAsync targets) must be `destroy()`-ed after
//      readback to keep the process clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { create, globals } from 'webgpu';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WGSL_SRC = readFileSync(
  join(__dirname, '..', 'src', 'decollision-webgpu.wgsl'),
  'utf8',
);
const SCAN_WGSL_SRC = readFileSync(
  join(__dirname, '..', 'src', 'decollision-webgpu-scan.wgsl'),
  'utf8',
);

Object.assign(globalThis, globals);
const gpu = create([]);

const PARAM_BYTES = 48;
const WORKGROUP_SIZE = 64;

/** Build a fresh device + pipelines. Call once per test. */
async function setupGPU() {
  const adapter = await gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const shaderModule = device.createShaderModule({ code: WGSL_SRC });

  const mainLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const mainPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [mainLayout] });

  const pipelines = {
    clearBins: device.createComputePipeline({
      layout: mainPipelineLayout,
      compute: { module: shaderModule, entryPoint: 'clearBins' },
    }),
    countBins: device.createComputePipeline({
      layout: mainPipelineLayout,
      compute: { module: shaderModule, entryPoint: 'countBins' },
    }),
    placeParticles: device.createComputePipeline({
      layout: mainPipelineLayout,
      compute: { module: shaderModule, entryPoint: 'placeParticles' },
    }),
    collide: device.createComputePipeline({
      layout: mainPipelineLayout,
      compute: { module: shaderModule, entryPoint: 'collide' },
    }),
    apply: device.createComputePipeline({
      layout: mainPipelineLayout,
      compute: { module: shaderModule, entryPoint: 'apply' },
    }),
  };

  return { device, mainLayout, pipelines };
}

// ── Helpers (bound to a specific device per test) ─────────────────────────

function writeParams(buffer, p) {
  const u32 = new Uint32Array(buffer);
  const f32 = new Float32Array(buffer);
  u32[0] = p.nNodes >>> 0;
  u32[1] = p.numBins >>> 0;
  u32[2] = p.gridDimX >>> 0;
  u32[3] = p.gridDimY >>> 0;
  f32[4] = p.gridMinX;
  f32[5] = p.gridMinY;
  f32[6] = p.cellSize;
  u32[7] = (p.epoch ?? 0) >>> 0;
  f32[8] = p.strength ?? 1;
  f32[9] = p.velocityDecay ?? 0.6;
  f32[10] = p.jitter ?? 1e-6;
  f32[11] = 0;
}

function makeHelpers(device, mainLayout) {
  function createStorageBuffer(bytes, initialData = null) {
    const buf = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    if (initialData) {
      device.queue.writeBuffer(buf, 0, initialData.buffer, initialData.byteOffset, initialData.byteLength);
    }
    return buf;
  }

  function createReadOnlyStorageBuffer(initialData) {
    const buf = device.createBuffer({
      size: initialData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, initialData.buffer, initialData.byteOffset, initialData.byteLength);
    return buf;
  }

  function createParamsBuffer(params) {
    const raw = new ArrayBuffer(PARAM_BYTES);
    writeParams(raw, params);
    const buf = device.createBuffer({
      size: PARAM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, raw);
    return buf;
  }

  async function readBuffer(buf, TypedArray, length) {
    const bytes = length * TypedArray.BYTES_PER_ELEMENT;
    const staging = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(buf, 0, staging, 0, bytes);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new TypedArray(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return out;
  }

  function buildBindGroup(buffers) {
    return device.createBindGroup({
      layout: mainLayout,
      entries: [
        { binding: 0, resource: { buffer: buffers.positions } },
        { binding: 1, resource: { buffer: buffers.velocities } },
        { binding: 2, resource: { buffer: buffers.radii } },
        { binding: 3, resource: { buffer: buffers.nextVelocities } },
        { binding: 4, resource: { buffer: buffers.params } },
        { binding: 5, resource: { buffer: buffers.binCount } },
        { binding: 6, resource: { buffer: buffers.placeCounter } },
        { binding: 7, resource: { buffer: buffers.sortedIndices } },
      ],
    });
  }

  function dispatch(pipeline, bindGroup, workgroups) {
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, bindGroup);
    pass.setPipeline(pipeline);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  return { createStorageBuffer, createReadOnlyStorageBuffer, createParamsBuffer, readBuffer, buildBindGroup, dispatch };
}

// 4 particles, one per cell of a 2×2 grid.
function fourCornersFixture() {
  return {
    positions: new Float32Array([0.5, 0.5, 1.5, 0.5, 0.5, 1.5, 1.5, 1.5]),
    velocities: new Float32Array(8),
    radii: new Float32Array([0.3, 0.3, 0.3, 0.3]),
    nNodes: 4,
    gridDimX: 2, gridDimY: 2, cellSize: 1.0,
    gridMinX: 0, gridMinY: 0, numBins: 4,
    binArrayLen: 5,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('main pipeline: clearBins zeros binCount and placeCounter', async () => {
    const { device, mainLayout, pipelines } = await setupGPU();
    const h = makeHelpers(device, mainLayout);
    const f = fourCornersFixture();

    const buffers = {
      positions: h.createStorageBuffer(f.positions.byteLength, f.positions),
      velocities: h.createStorageBuffer(f.velocities.byteLength, f.velocities),
      radii: h.createReadOnlyStorageBuffer(f.radii),
      nextVelocities: h.createStorageBuffer(f.velocities.byteLength),
      params: h.createParamsBuffer({
        nNodes: f.nNodes, numBins: f.numBins,
        gridDimX: f.gridDimX, gridDimY: f.gridDimY,
        gridMinX: f.gridMinX, gridMinY: f.gridMinY, cellSize: f.cellSize,
      }),
      binCount: h.createStorageBuffer(f.binArrayLen * 4, new Uint32Array(f.binArrayLen).fill(99)),
      placeCounter: h.createStorageBuffer(f.numBins * 4, new Uint32Array(f.numBins).fill(77)),
      sortedIndices: h.createStorageBuffer(f.nNodes * 4),
    };
    const bg = h.buildBindGroup(buffers);

    h.dispatch(pipelines.clearBins, bg, Math.ceil(f.binArrayLen / WORKGROUP_SIZE));

    const counts = await h.readBuffer(buffers.binCount, Uint32Array, f.binArrayLen);
    const place = await h.readBuffer(buffers.placeCounter, Uint32Array, f.numBins);
    assert.deepEqual([...counts], new Array(f.binArrayLen).fill(0));
    assert.deepEqual([...place], new Array(f.numBins).fill(0));
  });

test('main pipeline: countBins assigns each particle to its bin (one per bin)', async () => {
    const { device, mainLayout, pipelines } = await setupGPU();
    const h = makeHelpers(device, mainLayout);
    const f = fourCornersFixture();

    const buffers = {
      positions: h.createStorageBuffer(f.positions.byteLength, f.positions),
      velocities: h.createStorageBuffer(f.velocities.byteLength, f.velocities),
      radii: h.createReadOnlyStorageBuffer(f.radii),
      nextVelocities: h.createStorageBuffer(f.velocities.byteLength),
      params: h.createParamsBuffer({
        nNodes: f.nNodes, numBins: f.numBins,
        gridDimX: f.gridDimX, gridDimY: f.gridDimY,
        gridMinX: f.gridMinX, gridMinY: f.gridMinY, cellSize: f.cellSize,
      }),
      binCount: h.createStorageBuffer(f.binArrayLen * 4, new Uint32Array(f.binArrayLen)),
      placeCounter: h.createStorageBuffer(f.numBins * 4, new Uint32Array(f.numBins)),
      sortedIndices: h.createStorageBuffer(f.nNodes * 4),
    };
    const bg = h.buildBindGroup(buffers);

    h.dispatch(pipelines.countBins, bg, Math.ceil(f.nNodes / WORKGROUP_SIZE));

    const counts = await h.readBuffer(buffers.binCount, Uint32Array, f.binArrayLen);
    assert.deepEqual([...counts], [0, 1, 1, 1, 1]);
  });

test('main pipeline: countBins handles multiple particles in the same bin', async () => {
    const { device, mainLayout, pipelines } = await setupGPU();
    const h = makeHelpers(device, mainLayout);

    const positions = new Float32Array([1.1, 0.2, 1.3, 0.5, 1.5, 0.7, 1.9, 0.9]);
    const velocities = new Float32Array(8);
    const radii = new Float32Array([0.1, 0.1, 0.1, 0.1]);

    const buffers = {
      positions: h.createStorageBuffer(positions.byteLength, positions),
      velocities: h.createStorageBuffer(velocities.byteLength, velocities),
      radii: h.createReadOnlyStorageBuffer(radii),
      nextVelocities: h.createStorageBuffer(velocities.byteLength),
      params: h.createParamsBuffer({
        nNodes: 4, numBins: 4,
        gridDimX: 2, gridDimY: 2,
        gridMinX: 0, gridMinY: 0, cellSize: 1.0,
      }),
      binCount: h.createStorageBuffer(20, new Uint32Array(5)),
      placeCounter: h.createStorageBuffer(16, new Uint32Array(4)),
      sortedIndices: h.createStorageBuffer(16),
    };
    const bg = h.buildBindGroup(buffers);

    h.dispatch(pipelines.countBins, bg, 1);

    const counts = await h.readBuffer(buffers.binCount, Uint32Array, 5);
    // All 4 particles in bin 1 (cell (1,0)) → counts[bin+1=2] = 4.
    assert.deepEqual([...counts], [0, 0, 4, 0, 0]);
  });

test('main pipeline: placeParticles writes correct sortedIndices given pre-scanned offsets', async () => {
    const { device, mainLayout, pipelines } = await setupGPU();
    const h = makeHelpers(device, mainLayout);
    const f = fourCornersFixture();

    const buffers = {
      positions: h.createStorageBuffer(f.positions.byteLength, f.positions),
      velocities: h.createStorageBuffer(f.velocities.byteLength, f.velocities),
      radii: h.createReadOnlyStorageBuffer(f.radii),
      nextVelocities: h.createStorageBuffer(f.velocities.byteLength),
      params: h.createParamsBuffer({
        nNodes: f.nNodes, numBins: f.numBins,
        gridDimX: f.gridDimX, gridDimY: f.gridDimY,
        gridMinX: f.gridMinX, gridMinY: f.gridMinY, cellSize: f.cellSize,
      }),
      binCount: h.createStorageBuffer(20, new Uint32Array([0, 1, 2, 3, 4])),
      placeCounter: h.createStorageBuffer(f.numBins * 4, new Uint32Array(f.numBins)),
      sortedIndices: h.createStorageBuffer(f.nNodes * 4, new Uint32Array([99, 99, 99, 99])),
    };
    const bg = h.buildBindGroup(buffers);

    h.dispatch(pipelines.placeParticles, bg, Math.ceil(f.nNodes / WORKGROUP_SIZE));

    const sorted = await h.readBuffer(buffers.sortedIndices, Uint32Array, f.nNodes);
    assert.deepEqual([...sorted], [0, 1, 2, 3]);
  });

test('main pipeline: collide produces zero force when particles are well-separated', async () => {
    const { device, mainLayout, pipelines } = await setupGPU();
    const h = makeHelpers(device, mainLayout);
    const f = fourCornersFixture();

    const buffers = {
      positions: h.createStorageBuffer(f.positions.byteLength, f.positions),
      velocities: h.createStorageBuffer(f.velocities.byteLength, f.velocities),
      radii: h.createReadOnlyStorageBuffer(f.radii),
      nextVelocities: h.createStorageBuffer(f.velocities.byteLength),
      params: h.createParamsBuffer({
        nNodes: f.nNodes, numBins: f.numBins,
        gridDimX: f.gridDimX, gridDimY: f.gridDimY,
        gridMinX: f.gridMinX, gridMinY: f.gridMinY, cellSize: f.cellSize,
      }),
      binCount: h.createStorageBuffer(20, new Uint32Array([0, 1, 2, 3, 4])),
      placeCounter: h.createStorageBuffer(16, new Uint32Array(4)),
      sortedIndices: h.createStorageBuffer(16, new Uint32Array([0, 1, 2, 3])),
    };
    const bg = h.buildBindGroup(buffers);

    h.dispatch(pipelines.collide, bg, Math.ceil(f.nNodes / WORKGROUP_SIZE));

    const nextVelData = await h.readBuffer(buffers.nextVelocities, Float32Array, f.nNodes * 2);
    for (const v of nextVelData) assert.equal(v, 0, `expected zero force, got ${v}`);
  });

test('main pipeline: collide produces force matching naive O(N²) reference for overlapping pair', async () => {
    const { device, mainLayout, pipelines } = await setupGPU();
    const h = makeHelpers(device, mainLayout);

    const positions = new Float32Array([0.5, 0.5, 0.6, 0.5]);
    const velocities = new Float32Array(4);
    const radii = new Float32Array([0.2, 0.2]);

    const buffers = {
      positions: h.createStorageBuffer(positions.byteLength, positions),
      velocities: h.createStorageBuffer(velocities.byteLength, velocities),
      radii: h.createReadOnlyStorageBuffer(radii),
      nextVelocities: h.createStorageBuffer(velocities.byteLength),
      params: h.createParamsBuffer({
        nNodes: 2, numBins: 1, gridDimX: 1, gridDimY: 1,
        gridMinX: 0, gridMinY: 0, cellSize: 1.0, strength: 1.0,
      }),
      binCount: h.createStorageBuffer(8, new Uint32Array([0, 2])),
      placeCounter: h.createStorageBuffer(4, new Uint32Array(1)),
      sortedIndices: h.createStorageBuffer(8, new Uint32Array([0, 1])),
    };
    const bg = h.buildBindGroup(buffers);

    h.dispatch(pipelines.collide, bg, 1);

    const gpu = await h.readBuffer(buffers.nextVelocities, Float32Array, 4);

    // CPU oracle, mirrors WGSL math: dx = -0.1, dist = 0.1, minDist = 0.4,
    // scale = (0.4 - 0.1) / 0.1 = 3, weight = 0.04 / 0.08 = 0.5.
    const expectedVx0 = -0.1 * 3 * 0.5; // -0.15
    const expectedVx1 = +0.1 * 3 * 0.5; // +0.15

    assert.ok(Math.abs(gpu[0] - expectedVx0) < 1e-5, `p0.vx: gpu=${gpu[0]} expected=${expectedVx0}`);
    // vy is ~0 plus jitter (the shader perturbs dy when it's exactly 0 so
    // coincident particles can separate). Jitter is bounded by `params.jitter`
    // (= 1e-6) scaled by the force; expect a few-1e-6 tolerance.
    assert.ok(Math.abs(gpu[1]) < 1e-5, `p0.vy: gpu=${gpu[1]} expected near 0`);
    assert.ok(Math.abs(gpu[2] - expectedVx1) < 1e-5, `p1.vx: gpu=${gpu[2]} expected=${expectedVx1}`);
    assert.ok(Math.abs(gpu[3]) < 1e-5, `p1.vy: gpu=${gpu[3]} expected near 0`);
  });

test('main pipeline: apply updates positions from nextVelocities with damping', async () => {
    const { device, mainLayout, pipelines } = await setupGPU();
    const h = makeHelpers(device, mainLayout);

    const positions = new Float32Array([1.0, 2.0]);
    const velocities = new Float32Array([0, 0]);
    const radii = new Float32Array([0.1]);
    const nextVel = new Float32Array([0.5, 0.3]);
    const velocityDecay = 0.5;

    const buffers = {
      positions: h.createStorageBuffer(positions.byteLength, positions),
      velocities: h.createStorageBuffer(velocities.byteLength, velocities),
      radii: h.createReadOnlyStorageBuffer(radii),
      nextVelocities: h.createStorageBuffer(nextVel.byteLength, nextVel),
      params: h.createParamsBuffer({
        nNodes: 1, numBins: 1, gridDimX: 1, gridDimY: 1,
        gridMinX: 0, gridMinY: 0, cellSize: 1.0, velocityDecay,
      }),
      binCount: h.createStorageBuffer(8, new Uint32Array(2)),
      placeCounter: h.createStorageBuffer(4, new Uint32Array(1)),
      sortedIndices: h.createStorageBuffer(4, new Uint32Array([0])),
    };
    const bg = h.buildBindGroup(buffers);

    h.dispatch(pipelines.apply, bg, 1);

    const newPos = await h.readBuffer(buffers.positions, Float32Array, 2);
    const newVel = await h.readBuffer(buffers.velocities, Float32Array, 2);
    // damped = nextVel * velocityDecay = (0.25, 0.15)
    // positions += damped → (1.25, 2.15); velocities = damped.
    assert.ok(Math.abs(newPos[0] - 1.25) < 1e-6);
  assert.ok(Math.abs(newPos[1] - 2.15) < 1e-6);
  assert.ok(Math.abs(newVel[0] - 0.25) < 1e-6);
  assert.ok(Math.abs(newVel[1] - 0.15) < 1e-6);
});

// ── Scan kernel (separate WGSL module) ─────────────────────────────────────

async function setupScan() {
  const adapter = await gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const mod = device.createShaderModule({ code: SCAN_WGSL_SRC });
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // scanIn
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },           // scanOut
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },           // params
    ],
  });
  const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipeline = device.createComputePipeline({
    layout: pl,
    compute: { module: mod, entryPoint: 'prefixSumStep' },
  });
  return { device, layout, pipeline };
}

/** Run the Hillis-Steele scan on the GPU and read back the result. */
async function runScan(device, layout, pipeline, input) {
  const n = input.length;
  // Round to even iterations so the final result lands back in buffer A.
  const log2 = (v) => Math.ceil(Math.log2(Math.max(2, v)));
  let iters = log2(n);
  if (iters % 2 === 1) iters += 1;

  const bytes = n * 4;
  const bufA = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  device.queue.writeBuffer(bufA, 0, input.buffer, input.byteOffset, input.byteLength);
  const bufB = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });

  // One uniform buffer per iteration, pre-filled with (n, stepSize).
  const paramBuffers = [];
  for (let s = 0; s < iters; s++) {
    const buf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, new Uint32Array([n, 1 << s]).buffer, 0, 8);
    paramBuffers.push(buf);
  }
  // Bind groups: alternate A→B and B→A.
  const bindA2B = paramBuffers.map((pb) => device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: bufA } },
      { binding: 1, resource: { buffer: bufB } },
      { binding: 2, resource: { buffer: pb } },
    ],
  }));
  const bindB2A = paramBuffers.map((pb) => device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: bufB } },
      { binding: 1, resource: { buffer: bufA } },
      { binding: 2, resource: { buffer: pb } },
    ],
  }));

  const enc = device.createCommandEncoder();
  for (let s = 0; s < iters; s++) {
    const bg = (s % 2 === 0) ? bindA2B[s] : bindB2A[s];
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, bg);
    pass.setPipeline(pipeline);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
  }
  const staging = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  enc.copyBufferToBuffer(bufA, 0, staging, 0, bytes);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = new Uint32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return out;
}

/** CPU oracle: inclusive prefix sum. */
function cpuInclusiveScan(input) {
  const out = new Uint32Array(input.length);
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    sum += input[i];
    out[i] = sum;
  }
  return out;
}

test('scan: inclusive prefix sum of [0,1,1,1,1] → [0,1,2,3,4]', async () => {
  const { device, layout, pipeline } = await setupScan();
  const input = new Uint32Array([0, 1, 1, 1, 1]);
  const gpu = await runScan(device, layout, pipeline, input);
  assert.deepEqual([...gpu], [...cpuInclusiveScan(input)]);
});

test('scan: inclusive prefix sum of mixed counts', async () => {
  const { device, layout, pipeline } = await setupScan();
  const input = new Uint32Array([0, 3, 0, 5, 2, 0, 7, 1, 4, 0, 2]);
  const gpu = await runScan(device, layout, pipeline, input);
  assert.deepEqual([...gpu], [...cpuInclusiveScan(input)]);
});

test('scan: large array (n=2501) matches CPU oracle', async () => {
  const { device, layout, pipeline } = await setupScan();
  const n = 2501;
  const input = new Uint32Array(n);
  // Sparse + bursty pattern — exercises boundary conditions across iterations.
  for (let i = 0; i < n; i++) input[i] = (i * 7 + 3) % 13;
  const gpu = await runScan(device, layout, pipeline, input);
  const cpu = cpuInclusiveScan(input);
  for (let i = 0; i < n; i++) {
    if (gpu[i] !== cpu[i]) {
      assert.fail(`mismatch at i=${i}: gpu=${gpu[i]} cpu=${cpu[i]}`);
    }
  }
});

// ── Integrated full pipeline: clear → count → scan → place → collide ───────
// Runs the full spatial-hash pipeline and asserts force-correctness against
// a naive O(N²) JS reference. Small N (~30) so the brute-force reference is
// trivial. Catches integration bugs the per-phase tests would miss.

/** CPU reference: same collision math as WGSL `collide`, brute-force O(N²). */
function naiveCollide(positions, velocities, radii, strength = 1) {
  const n = radii.length;
  const next = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const xi = positions[i * 2] + velocities[i * 2];
    const yi = positions[i * 2 + 1] + velocities[i * 2 + 1];
    const ri = Math.max(radii[i], 1e-6);
    const ri2 = ri * ri;
    let totalX = 0, totalY = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const xj = positions[j * 2] + velocities[j * 2];
      const yj = positions[j * 2 + 1] + velocities[j * 2 + 1];
      const rj = Math.max(radii[j], 1e-6);
      const minDist = ri + rj;
      const dx = xi - xj;
      const dy = yi - yj;
      const dist2 = dx * dx + dy * dy;
      if (dist2 < minDist * minDist && dist2 > 0) {
        const dist = Math.sqrt(dist2);
        const scale = (minDist - dist) / dist * strength;
        const weight = (rj * rj) / (ri2 + rj * rj);
        totalX += dx * scale * weight;
        totalY += dy * scale * weight;
      }
    }
    next[i * 2] = velocities[i * 2] + totalX;
    next[i * 2 + 1] = velocities[i * 2 + 1] + totalY;
  }
  return next;
}

test('integrated pipeline: 30 random particles match naive O(N²) ref', async () => {
  // Main pipeline + scan pipeline together. The main pipeline uses one
  // device; the scan uses a separate device (it's a separate test in spirit
  // — they share buffers via copyBufferToBuffer, but here for the
  // integration test we keep both on a single device since the dispatch
  // sequence is what we're validating).
  const main = await setupGPU();
  const scanMod = main.device.createShaderModule({ code: SCAN_WGSL_SRC });
  const scanLayout = main.device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const scanPipelineLayout = main.device.createPipelineLayout({ bindGroupLayouts: [scanLayout] });
  const scanPipe = main.device.createComputePipeline({
    layout: scanPipelineLayout,
    compute: { module: scanMod, entryPoint: 'prefixSumStep' },
  });

  // 30 random particles in [0, 10]², radius 0.3 each. ~50% chance of overlaps.
  const nNodes = 30;
  const positions = new Float32Array(nNodes * 2);
  const velocities = new Float32Array(nNodes * 2);
  const radii = new Float32Array(nNodes);
  // Deterministic PRNG (Mulberry32) so the test is reproducible.
  let seed = 1337;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < nNodes; i++) {
    positions[i * 2] = rand() * 10;
    positions[i * 2 + 1] = rand() * 10;
    radii[i] = 0.3;
  }

  // Grid params: cell = 2 × max radius = 0.6; bbox padded.
  const cellSize = 0.6;
  const gridMinX = -2;
  const gridMinY = -2;
  const gridDimX = Math.ceil((10 + 4) / cellSize); // 24
  const gridDimY = gridDimX;
  const numBins = gridDimX * gridDimY;
  const binArrayLen = numBins + 1;

  const h = makeHelpers(main.device, main.mainLayout);
  const buffers = {
    positions: h.createStorageBuffer(positions.byteLength, positions),
    velocities: h.createStorageBuffer(velocities.byteLength, velocities),
    radii: h.createReadOnlyStorageBuffer(radii),
    nextVelocities: h.createStorageBuffer(positions.byteLength),
    params: h.createParamsBuffer({
      nNodes, numBins, gridDimX, gridDimY,
      gridMinX, gridMinY, cellSize, strength: 1.0,
    }),
    binCount: h.createStorageBuffer(binArrayLen * 4),
    placeCounter: h.createStorageBuffer(numBins * 4),
    sortedIndices: h.createStorageBuffer(nNodes * 4),
  };
  const mainBG = h.buildBindGroup(buffers);

  // Scan needs its own scratch buffer + per-iter param uniforms + bind groups.
  const scanScratch = main.device.createBuffer({
    size: binArrayLen * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  let iters = Math.ceil(Math.log2(Math.max(2, binArrayLen)));
  if (iters % 2 === 1) iters += 1;
  const scanParamBuffers = [];
  for (let s = 0; s < iters; s++) {
    const buf = main.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    main.device.queue.writeBuffer(buf, 0, new Uint32Array([binArrayLen, 1 << s]).buffer, 0, 8);
    scanParamBuffers.push(buf);
  }
  const scanBGA2B = scanParamBuffers.map((pb) => main.device.createBindGroup({
    layout: scanLayout,
    entries: [
      { binding: 0, resource: { buffer: buffers.binCount } },
      { binding: 1, resource: { buffer: scanScratch } },
      { binding: 2, resource: { buffer: pb } },
    ],
  }));
  const scanBGB2A = scanParamBuffers.map((pb) => main.device.createBindGroup({
    layout: scanLayout,
    entries: [
      { binding: 0, resource: { buffer: scanScratch } },
      { binding: 1, resource: { buffer: buffers.binCount } },
      { binding: 2, resource: { buffer: pb } },
    ],
  }));

  // Dispatch the full pipeline in one encoder.
  const enc = main.device.createCommandEncoder();
  // clear
  {
    const p = enc.beginComputePass();
    p.setBindGroup(0, mainBG); p.setPipeline(main.pipelines.clearBins);
    p.dispatchWorkgroups(Math.ceil(binArrayLen / WORKGROUP_SIZE));
    p.end();
  }
  // count
  {
    const p = enc.beginComputePass();
    p.setBindGroup(0, mainBG); p.setPipeline(main.pipelines.countBins);
    p.dispatchWorkgroups(Math.ceil(nNodes / WORKGROUP_SIZE));
    p.end();
  }
  // scan
  for (let s = 0; s < iters; s++) {
    const bg = (s % 2 === 0) ? scanBGA2B[s] : scanBGB2A[s];
    const p = enc.beginComputePass();
    p.setBindGroup(0, bg); p.setPipeline(scanPipe);
    p.dispatchWorkgroups(Math.ceil(binArrayLen / WORKGROUP_SIZE));
    p.end();
  }
  // place
  {
    const p = enc.beginComputePass();
    p.setBindGroup(0, mainBG); p.setPipeline(main.pipelines.placeParticles);
    p.dispatchWorkgroups(Math.ceil(nNodes / WORKGROUP_SIZE));
    p.end();
  }
  // collide
  {
    const p = enc.beginComputePass();
    p.setBindGroup(0, mainBG); p.setPipeline(main.pipelines.collide);
    p.dispatchWorkgroups(Math.ceil(nNodes / WORKGROUP_SIZE));
    p.end();
  }
  main.device.queue.submit([enc.finish()]);

  const gpuForce = await h.readBuffer(buffers.nextVelocities, Float32Array, nNodes * 2);
  const cpuForce = naiveCollide(positions, velocities, radii, 1.0);

  // Per-component tolerance: jitter (1e-6 in shader) can introduce small
  // perturbations when two particles are coincident; per-particle forces
  // dominated by real overlaps should match to ~1e-4.
  let maxErr = 0;
  let firstMismatchAt = -1;
  for (let i = 0; i < nNodes * 2; i++) {
    const err = Math.abs(gpuForce[i] - cpuForce[i]);
    if (err > maxErr) maxErr = err;
    if (err > 1e-4 && firstMismatchAt < 0) firstMismatchAt = i;
  }
  if (firstMismatchAt >= 0) {
    assert.fail(`first mismatch at i=${firstMismatchAt}: gpu=${gpuForce[firstMismatchAt]} cpu=${cpuForce[firstMismatchAt]} (max err across all = ${maxErr})`);
  }
});
