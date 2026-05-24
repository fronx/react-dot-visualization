const WORKGROUP_SIZE = 64;
const PARAM_BYTES = 48;        // 12 × 4 bytes; matches Params struct in WGSL
const SCAN_PARAM_BYTES = 16;   // 2 × u32 padded for uniform alignment
const INITIAL_RADIUS = 10;
const INITIAL_ANGLE = Math.PI * (3 - Math.sqrt(5));
const DEFAULT_VELOCITY_DECAY = 0.4; // Matches d3.forceSimulation default
const GRID_BOUNDS_MARGIN_CELLS = 8; // Inflate data bbox by this many cellSize units
const MAX_CELLS_PER_SIDE = 1024;
let mainShaderPromise = null;
let scanShaderPromise = null;

export class WebGpuDecollisionUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebGpuDecollisionUnavailableError';
  }
}

function getNavigatorWithGpu() {
  const nav = typeof navigator !== 'undefined'
    ? navigator
    : (typeof self !== 'undefined' ? self.navigator : undefined);
  return nav && nav.gpu ? nav : null;
}

export function isWebGpuDecollisionAvailable() {
  return !!getNavigatorWithGpu();
}

async function getMainShader() {
  if (!mainShaderPromise) {
    mainShaderPromise = import('./decollision-webgpu.wgsl?raw').then((m) => m.default);
  }
  return mainShaderPromise;
}

async function getScanShader() {
  if (!scanShaderPromise) {
    scanShaderPromise = import('./decollision-webgpu-scan.wgsl?raw').then((m) => m.default);
  }
  return scanShaderPromise;
}

let contextPromise = null;

async function ensureContext() {
  if (!contextPromise) {
    contextPromise = (async () => {
      const nav = getNavigatorWithGpu();
      if (!nav) {
        throw new WebGpuDecollisionUnavailableError('WebGPU not available');
      }

      const adapter = await nav.gpu.requestAdapter();
      if (!adapter) {
        throw new WebGpuDecollisionUnavailableError('No compatible GPU adapter');
      }

      const device = await adapter.requestDevice();
      const [mainSource, scanSource] = await Promise.all([getMainShader(), getScanShader()]);
      const mainShader = device.createShaderModule({ code: mainSource });
      const scanShader = device.createShaderModule({ code: scanSource });

      // Main bind group: per-particle buffers + grid buffers + Params.
      // Used by clearBins, countBins, placeParticles, collide, apply.
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

      // Scan bind group (independent module). Uses its own group(0) bindings
      // — the dispatch never binds both this and the main group at the same
      // time, so the shared bin buffer is safe.
      const scanLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
      });

      const mainPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [mainLayout] });
      const scanPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [scanLayout] });

      const pipelines = {
        clearBins: device.createComputePipeline({
          layout: mainPipelineLayout,
          compute: { module: mainShader, entryPoint: 'clearBins' },
        }),
        countBins: device.createComputePipeline({
          layout: mainPipelineLayout,
          compute: { module: mainShader, entryPoint: 'countBins' },
        }),
        prefixSumStep: device.createComputePipeline({
          layout: scanPipelineLayout,
          compute: { module: scanShader, entryPoint: 'prefixSumStep' },
        }),
        placeParticles: device.createComputePipeline({
          layout: mainPipelineLayout,
          compute: { module: mainShader, entryPoint: 'placeParticles' },
        }),
        collide: device.createComputePipeline({
          layout: mainPipelineLayout,
          compute: { module: mainShader, entryPoint: 'collide' },
        }),
        apply: device.createComputePipeline({
          layout: mainPipelineLayout,
          compute: { module: mainShader, entryPoint: 'apply' },
        }),
      };

      device.lost.then(() => {
        contextPromise = null;
      });

      return { device, mainLayout, scanLayout, pipelines };
    })();
  }
  return contextPromise;
}

function createBuffer(device, usage, dataOrSize) {
  if (typeof dataOrSize === 'number') {
    return device.createBuffer({ size: dataOrSize, usage });
  }
  const source = dataOrSize instanceof Float32Array
    ? dataOrSize
    : new Float32Array(dataOrSize);
  const buffer = device.createBuffer({
    size: source.byteLength,
    usage,
    mappedAtCreation: true,
  });
  new Float32Array(buffer.getMappedRange()).set(source);
  buffer.unmap();
  return buffer;
}

function buildParamsBuffer() {
  const raw = new ArrayBuffer(PARAM_BYTES);
  const u32 = new Uint32Array(raw);
  const f32 = new Float32Array(raw);
  return { raw, u32, f32 };
}

function writeParams(target, params) {
  target.u32[0] = params.nNodes >>> 0;
  target.u32[1] = params.numBins >>> 0;
  target.u32[2] = params.gridDimX >>> 0;
  target.u32[3] = params.gridDimY >>> 0;
  target.f32[4] = params.gridMinX;
  target.f32[5] = params.gridMinY;
  target.f32[6] = params.cellSize;
  target.u32[7] = params.epoch >>> 0;
  target.f32[8] = params.strength;
  target.f32[9] = params.velocityDecay;
  target.f32[10] = params.jitter;
  target.f32[11] = 0;
}

// Compute a uniform grid covering the data with margin. cellSize must be
// ≥ 2 × maxRadius so the 3×3 neighbor scan in `collide` covers every
// possible collider. We pick cellSize as large as practical (targeting
// ~3 particles per cell) so numBins stays small and the prefix-sum cheap.
export function computeGridParams(nodes, radii) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let maxRadius = 0;
  for (let i = 0; i < nodes.length; i++) {
    const x = nodes[i].x;
    const y = nodes[i].y;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    const r = radii[i];
    if (r > maxRadius) maxRadius = r;
  }
  if (!Number.isFinite(minX)) {
    minX = -1; minY = -1; maxX = 1; maxY = 1;
  }
  if (maxRadius <= 0) maxRadius = 1;

  const minCellSize = 2 * maxRadius;
  const dataW = Math.max(maxX - minX, minCellSize);
  const dataH = Math.max(maxY - minY, minCellSize);
  // Occupancy-aware cell size: the uniform target (≈3 dots/cell over the bbox)
  // overpacks dense clusters when the layout is clumpy (dense islands + empty
  // gaps), so each collision iteration scans hundreds of neighbours. Scale the
  // target down by how much of the bbox the points actually occupy, estimated
  // from a coarse grid (~16 pts/cell if uniform → fraction ≈1, so uniform layouts
  // like the UMAP map are unchanged); clumpy layouts get a smaller cell → ~3
  // dots/cell → cheap iterations. The MAX_CELLS_PER_SIDE clamp below bounds it.
  const occSide = Math.max(1, Math.round(Math.sqrt(nodes.length / 16)));
  const spanX = (maxX - minX) || 1;
  const spanY = (maxY - minY) || 1;
  const occCells = new Uint8Array(occSide * occSide);
  let occupied = 0;
  for (let i = 0; i < nodes.length; i++) {
    const ox = Math.min(occSide - 1, Math.max(0, Math.floor(((nodes[i].x - minX) / spanX) * occSide)));
    const oy = Math.min(occSide - 1, Math.max(0, Math.floor(((nodes[i].y - minY) / spanY) * occSide)));
    const k = oy * occSide + ox;
    if (occCells[k] === 0) { occCells[k] = 1; occupied += 1; }
  }
  const occupiedFraction = Math.max(1e-3, occupied / (occSide * occSide));
  const targetCellsPerSide = Math.max(1, Math.ceil(Math.sqrt(nodes.length / 3)));
  const targetCellSize = (Math.max(dataW, dataH) / targetCellsPerSide) * Math.sqrt(occupiedFraction);
  const cellSize = Math.max(minCellSize, targetCellSize);

  const margin = GRID_BOUNDS_MARGIN_CELLS * cellSize;
  const gridMinX = minX - margin;
  const gridMinY = minY - margin;
  let gridDimX = Math.ceil((dataW + 2 * margin) / cellSize);
  let gridDimY = Math.ceil((dataH + 2 * margin) / cellSize);
  gridDimX = Math.max(1, Math.min(gridDimX, MAX_CELLS_PER_SIDE));
  gridDimY = Math.max(1, Math.min(gridDimY, MAX_CELLS_PER_SIDE));
  const numBins = gridDimX * gridDimY;

  return { gridMinX, gridMinY, cellSize, gridDimX, gridDimY, numBins };
}

async function readPositions(stagingBuffer, nodeCount) {
  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const copy = stagingBuffer.getMappedRange().slice(0);
  stagingBuffer.unmap();
  const positions = new Float32Array(copy);
  const expected = nodeCount * 2;
  return positions.length === expected ? positions : positions.slice(0, expected);
}

function applyPositionsToNodes(nodes, positions) {
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].x = positions[i * 2];
    nodes[i].y = positions[i * 2 + 1];
  }
}

function createNodePositions(nodes) {
  const positions = new Float32Array(nodes.length * 2);
  for (let i = 0; i < nodes.length; i++) {
    positions[i * 2] = nodes[i].x;
    positions[i * 2 + 1] = nodes[i].y;
  }
  return positions;
}

function createNodeVelocities(nodes) {
  const velocities = new Float32Array(nodes.length * 2);
  for (let i = 0; i < nodes.length; i++) {
    velocities[i * 2] = nodes[i].vx;
    velocities[i * 2 + 1] = nodes[i].vy;
  }
  return velocities;
}

function initializeNodesLikeD3(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    node.index = i;

    if (node.fx != null) node.x = node.fx;
    if (node.fy != null) node.y = node.fy;

    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      const radius = INITIAL_RADIUS * Math.sqrt(0.5 + i);
      const angle = i * INITIAL_ANGLE;
      node.x = radius * Math.cos(angle);
      node.y = radius * Math.sin(angle);
    }

    if (!Number.isFinite(node.vx) || !Number.isFinite(node.vy)) {
      node.vx = 0;
      node.vy = 0;
    }
  }
}

function destroyBuffers(buffers) {
  for (const buffer of buffers) {
    if (buffer && typeof buffer.destroy === 'function') {
      buffer.destroy();
    }
  }
}

function nextFrame() {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function getAdaptiveStepsPerTick(nodeCount, publishIntermediate) {
  if (!publishIntermediate) {
    return 16;
  }
  if (nodeCount >= 8000) return 8;
  if (nodeCount >= 3000) return 4;
  if (nodeCount >= 1000) return 2;
  return 1;
}

// Number of Hillis-Steele scan iterations needed to fully accumulate
// inclusive prefixes for an array of length `n`. Padded to an even count
// so the final result lands back in `binBufferA` (the main pipeline's
// counter / offset buffer).
function computeScanIterations(n) {
  if (n <= 1) return 0;
  let iters = Math.ceil(Math.log2(n));
  if (iters % 2 === 1) iters += 1;
  return iters;
}

export function startWebGpuDecollisioning({
  nodes,
  radii,
  alphaStart = 1,
  alphaMin = 0.01,
  alphaDecay = 0.05,
  strength = 1,
  velocityDecay = DEFAULT_VELOCITY_DECAY,
  jitter = 1e-6,
  stepsPerTick,
  readbackIntervalMs = 16,
  publishIntermediate = true,
  shouldPublishIntermediate,
  onTick,
  onComplete,
  onError,
}) {
  if (!isWebGpuDecollisionAvailable()) {
    throw new WebGpuDecollisionUnavailableError('WebGPU not available');
  }

  let stopped = false;
  let currentPromise = null;

  currentPromise = (async () => {
    const { device, mainLayout, scanLayout, pipelines } = await ensureContext();
    const nodeCount = nodes.length;
    if (!nodeCount) {
      onComplete?.(nodes, 0);
      return;
    }

    initializeNodesLikeD3(nodes);
    const positionsData = createNodePositions(nodes);
    const velocitiesData = createNodeVelocities(nodes);
    const grid = computeGridParams(nodes, radii);
    const numBins = grid.numBins;
    const binArrayLen = numBins + 1; // +1 sentinel so countBins' bin+1 write is in-range

    const positionsBuffer = createBuffer(
      device,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      positionsData,
    );
    const velocitiesBuffer = createBuffer(
      device,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      velocitiesData,
    );
    const radiiBuffer = createBuffer(device, GPUBufferUsage.STORAGE, radii);
    const nextVelocitiesBuffer = createBuffer(
      device,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      positionsData.byteLength,
    );
    const paramsBuffer = createBuffer(
      device,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      PARAM_BYTES,
    );
    const stagingBuffer = device.createBuffer({
      size: positionsData.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    // Spatial-hash buffers.
    //   binBuffer: counts after countBins, offsets after scan, read by collide.
    //   scanScratch: ping-pong target for the Hillis-Steele scan.
    //   placeCounter / sortedIndices: phase-3 placement.
    const binBytes = binArrayLen * 4;
    const binBuffer = device.createBuffer({
      size: binBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const scanScratch = device.createBuffer({
      size: binBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const placeCounterBuffer = device.createBuffer({
      size: numBins * 4,
      usage: GPUBufferUsage.STORAGE,
    });
    const sortedIndicesBuffer = device.createBuffer({
      size: nodeCount * 4,
      usage: GPUBufferUsage.STORAGE,
    });

    // Pre-write one uniform per scan iteration so the dispatch loop just
    // rebinds without touching the queue.
    const scanIterations = computeScanIterations(binArrayLen);
    const scanParamBuffers = [];
    for (let s = 0; s < scanIterations; s++) {
      const buf = device.createBuffer({
        size: SCAN_PARAM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, new Uint32Array([binArrayLen, 1 << s]).buffer, 0, 8);
      scanParamBuffers.push(buf);
    }

    const mainBindGroup = device.createBindGroup({
      layout: mainLayout,
      entries: [
        { binding: 0, resource: { buffer: positionsBuffer } },
        { binding: 1, resource: { buffer: velocitiesBuffer } },
        { binding: 2, resource: { buffer: radiiBuffer } },
        { binding: 3, resource: { buffer: nextVelocitiesBuffer } },
        { binding: 4, resource: { buffer: paramsBuffer } },
        { binding: 5, resource: { buffer: binBuffer } },
        { binding: 6, resource: { buffer: placeCounterBuffer } },
        { binding: 7, resource: { buffer: sortedIndicesBuffer } },
      ],
    });

    // Two scan bind groups per iteration: A→scratch and scratch→A.
    // Iteration parity ensures the final result lands back in binBuffer.
    const scanBindGroupsA2B = scanParamBuffers.map((pb) => device.createBindGroup({
      layout: scanLayout,
      entries: [
        { binding: 0, resource: { buffer: binBuffer } },
        { binding: 1, resource: { buffer: scanScratch } },
        { binding: 2, resource: { buffer: pb } },
      ],
    }));
    const scanBindGroupsB2A = scanParamBuffers.map((pb) => device.createBindGroup({
      layout: scanLayout,
      entries: [
        { binding: 0, resource: { buffer: scanScratch } },
        { binding: 1, resource: { buffer: binBuffer } },
        { binding: 2, resource: { buffer: pb } },
      ],
    }));

    const paramsScratch = buildParamsBuffer();
    const particleWorkgroups = Math.ceil(nodeCount / WORKGROUP_SIZE);
    const binWorkgroups = Math.ceil(binArrayLen / WORKGROUP_SIZE);
    const batchSteps = Number.isFinite(stepsPerTick)
      ? Math.max(1, Math.floor(stepsPerTick))
      : getAdaptiveStepsPerTick(nodeCount, publishIntermediate);
    const minReadbackInterval = Math.max(1, readbackIntervalMs);
    let alpha = alphaStart;
    let epoch = 0;
    let lastReadbackAt = -Infinity;
    let positionsSyncedToCpu = true;

    const allBuffers = [
      positionsBuffer, velocitiesBuffer, radiiBuffer, nextVelocitiesBuffer, paramsBuffer,
      stagingBuffer, binBuffer, scanScratch, placeCounterBuffer, sortedIndicesBuffer,
      ...scanParamBuffers,
    ];

    try {
      while (!stopped) {
        if (publishIntermediate) {
          await nextFrame();
          if (stopped) break;
        }

        const shouldPublishNow =
          publishIntermediate
          && (typeof shouldPublishIntermediate === 'function'
            ? !!shouldPublishIntermediate()
            : true);

        let reachedFinalAlpha = false;
        let copiedForBatch = false;
        const iterationsThisBatch = publishIntermediate ? batchSteps : Math.max(batchSteps, 16);

        for (let batchIndex = 0; batchIndex < iterationsThisBatch && !stopped; batchIndex++) {
          alpha += (0 - alpha) * alphaDecay;
          writeParams(paramsScratch, {
            nNodes: nodeCount,
            numBins,
            gridDimX: grid.gridDimX,
            gridDimY: grid.gridDimY,
            gridMinX: grid.gridMinX,
            gridMinY: grid.gridMinY,
            cellSize: grid.cellSize,
            epoch,
            strength,
            velocityDecay: 1 - velocityDecay,
            jitter,
          });

          const willFinish = alpha < alphaMin;
          const now = performance.now();
          const readbackDue = now - lastReadbackAt >= minReadbackInterval;
          const shouldCopyThisStep =
            shouldPublishNow
            && (batchIndex === iterationsThisBatch - 1 || willFinish)
            && (willFinish || readbackDue);

          device.queue.writeBuffer(paramsBuffer, 0, paramsScratch.raw, 0, PARAM_BYTES);
          const encoder = device.createCommandEncoder();

          // Phase 0: clear binBuffer + placeCounter.
          {
            const pass = encoder.beginComputePass();
            pass.setBindGroup(0, mainBindGroup);
            pass.setPipeline(pipelines.clearBins);
            pass.dispatchWorkgroups(binWorkgroups);
            pass.end();
          }
          // Phase 1: count particles per bin.
          {
            const pass = encoder.beginComputePass();
            pass.setBindGroup(0, mainBindGroup);
            pass.setPipeline(pipelines.countBins);
            pass.dispatchWorkgroups(particleWorkgroups);
            pass.end();
          }
          // Phase 2: Hillis-Steele scan (ping-pong). Iteration parity is
          // chosen by `computeScanIterations` so the final result lands
          // back in binBuffer for collide to read.
          for (let s = 0; s < scanIterations; s++) {
            const bg = (s % 2 === 0) ? scanBindGroupsA2B[s] : scanBindGroupsB2A[s];
            const pass = encoder.beginComputePass();
            pass.setBindGroup(0, bg);
            pass.setPipeline(pipelines.prefixSumStep);
            pass.dispatchWorkgroups(binWorkgroups);
            pass.end();
          }
          // Phase 3: place particles into sortedIndices.
          {
            const pass = encoder.beginComputePass();
            pass.setBindGroup(0, mainBindGroup);
            pass.setPipeline(pipelines.placeParticles);
            pass.dispatchWorkgroups(particleWorkgroups);
            pass.end();
          }
          // Phase 4 + 5: collide → apply (same pass; dispatches are ordered
          // within a compute pass per the WebGPU spec).
          {
            const pass = encoder.beginComputePass();
            pass.setBindGroup(0, mainBindGroup);
            pass.setPipeline(pipelines.collide);
            pass.dispatchWorkgroups(particleWorkgroups);
            pass.setPipeline(pipelines.apply);
            pass.dispatchWorkgroups(particleWorkgroups);
            pass.end();
          }

          if (shouldCopyThisStep) {
            encoder.copyBufferToBuffer(positionsBuffer, 0, stagingBuffer, 0, positionsData.byteLength);
            copiedForBatch = true;
            lastReadbackAt = now;
          }

          device.queue.submit([encoder.finish()]);
          epoch++;
          positionsSyncedToCpu = false;

          if (willFinish) {
            reachedFinalAlpha = true;
            break;
          }
        }

        await device.queue.onSubmittedWorkDone();
        if (stopped) break;

        if (publishIntermediate && copiedForBatch) {
          const latestPositions = await readPositions(stagingBuffer, nodeCount);
          applyPositionsToNodes(nodes, latestPositions);
          positionsSyncedToCpu = true;
          onTick?.(nodes, alpha, epoch);
        }

        if (reachedFinalAlpha) break;
      }

      if (!stopped) {
        if (!positionsSyncedToCpu) {
          const encoder = device.createCommandEncoder();
          encoder.copyBufferToBuffer(positionsBuffer, 0, stagingBuffer, 0, positionsData.byteLength);
          device.queue.submit([encoder.finish()]);
          await device.queue.onSubmittedWorkDone();
          const latestPositions = await readPositions(stagingBuffer, nodeCount);
          applyPositionsToNodes(nodes, latestPositions);
          positionsSyncedToCpu = true;
        }
        onComplete?.(nodes, epoch);
      }
    } finally {
      destroyBuffers(allBuffers);
    }
  })().catch((error) => {
    if (!stopped) {
      onError?.(error);
    }
  });

  return {
    stop() {
      stopped = true;
    },
    done() {
      return currentPromise;
    },
  };
}
