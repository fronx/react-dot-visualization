const WORKGROUP_SIZE = 64;
const PARAM_BYTES = 32;
const INITIAL_RADIUS = 10;
const INITIAL_ANGLE = Math.PI * (3 - Math.sqrt(5));
const DEFAULT_VELOCITY_DECAY = 0.4; // Matches d3.forceSimulation default
let shaderSourcePromise = null;

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

async function getShaderSource() {
  if (!shaderSourcePromise) {
    shaderSourcePromise = import('./decollision-webgpu.wgsl?raw').then((mod) => mod.default);
  }
  return shaderSourcePromise;
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
      const shaderSource = await getShaderSource();
      const shaderModule = device.createShaderModule({ code: shaderSource });
      const bindGroupLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ]
      });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
      const pipelines = {
        collide: device.createComputePipeline({
          layout: pipelineLayout,
          compute: { module: shaderModule, entryPoint: 'collide' }
        }),
        apply: device.createComputePipeline({
          layout: pipelineLayout,
          compute: { module: shaderModule, entryPoint: 'apply' }
        })
      };

      device.lost.then(() => {
        contextPromise = null;
      });

      return { device, bindGroupLayout, pipelines };
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
    mappedAtCreation: true
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
  target.u32[1] = params.epoch >>> 0;
  target.u32[2] = 0;
  target.u32[3] = 0;
  target.f32[4] = params.strength;
  target.f32[5] = params.velocityDecay;
  target.f32[6] = params.jitter;
  target.f32[7] = 0;
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

function nextFrame() {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }
  return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
}

function destroyBuffers(buffers) {
  for (const buffer of buffers) {
    if (buffer && typeof buffer.destroy === 'function') {
      buffer.destroy();
    }
  }
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
  publishIntermediate = true,
  onTick,
  onComplete,
  onError
}) {
  if (!isWebGpuDecollisionAvailable()) {
    throw new WebGpuDecollisionUnavailableError('WebGPU not available');
  }

  let stopped = false;
  let currentPromise = null;

  currentPromise = (async () => {
    const { device, bindGroupLayout, pipelines } = await ensureContext();
    const nodeCount = nodes.length;
    if (!nodeCount) {
      onComplete?.(nodes, 0);
      return;
    }

    initializeNodesLikeD3(nodes);
    const positionsData = createNodePositions(nodes);
    const velocitiesData = createNodeVelocities(nodes);
    const positionsBuffer = createBuffer(
      device,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      positionsData
    );
    const velocitiesBuffer = createBuffer(
      device,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      velocitiesData
    );
    const radiiBuffer = createBuffer(device, GPUBufferUsage.STORAGE, radii);
    const nextVelocitiesBuffer = createBuffer(
      device,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      positionsData.byteLength
    );
    const paramsBuffer = createBuffer(
      device,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      PARAM_BYTES
    );
    const stagingBuffer = device.createBuffer({
      size: positionsData.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });

    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: positionsBuffer } },
        { binding: 1, resource: { buffer: velocitiesBuffer } },
        { binding: 2, resource: { buffer: radiiBuffer } },
        { binding: 3, resource: { buffer: nextVelocitiesBuffer } },
        { binding: 4, resource: { buffer: paramsBuffer } },
      ]
    });

    const params = buildParamsBuffer();
    const workgroups = Math.ceil(nodeCount / WORKGROUP_SIZE);
    let alpha = alphaStart;
    let epoch = 0;

    try {
      while (!stopped) {
        alpha += (0 - alpha) * alphaDecay;
        writeParams(params, {
          nNodes: nodeCount,
          epoch,
          strength,
          velocityDecay: 1 - velocityDecay,
          jitter
        });
        device.queue.writeBuffer(paramsBuffer, 0, params.raw);

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setBindGroup(0, bindGroup);
        pass.setPipeline(pipelines.collide);
        pass.dispatchWorkgroups(workgroups);
        pass.setPipeline(pipelines.apply);
        pass.dispatchWorkgroups(workgroups);
        pass.end();

        const shouldPublish = publishIntermediate || alpha < alphaMin;
        if (shouldPublish) {
          encoder.copyBufferToBuffer(positionsBuffer, 0, stagingBuffer, 0, positionsData.byteLength);
        }

        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        if (stopped) break;

        if (shouldPublish) {
          const latestPositions = await readPositions(stagingBuffer, nodeCount);
          applyPositionsToNodes(nodes, latestPositions);
          if (publishIntermediate) {
            onTick?.(nodes, alpha, epoch + 1);
          }
        }

        epoch++;
        if (alpha < alphaMin) {
          break;
        }

        if (publishIntermediate) {
          await nextFrame();
        }
      }

      if (!stopped) {
        if (!publishIntermediate) {
          const encoder = device.createCommandEncoder();
          encoder.copyBufferToBuffer(positionsBuffer, 0, stagingBuffer, 0, positionsData.byteLength);
          device.queue.submit([encoder.finish()]);
          await device.queue.onSubmittedWorkDone();
          const latestPositions = await readPositions(stagingBuffer, nodeCount);
          applyPositionsToNodes(nodes, latestPositions);
        }
        onComplete?.(nodes, epoch);
      }
    } finally {
      destroyBuffers([
        positionsBuffer,
        velocitiesBuffer,
        radiiBuffer,
        nextVelocitiesBuffer,
        paramsBuffer,
        stagingBuffer
      ]);
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
    }
  };
}
