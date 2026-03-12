import * as d3 from 'd3';
import {
  startWebGpuDecollisioning,
  isWebGpuDecollisionAvailable,
  WebGpuDecollisionUnavailableError
} from './decollision-webgpu.js';

const DEFAULT_ALPHA_START = 1;
const DEFAULT_ALPHA_MIN = 0.01;
const DEFAULT_ALPHA_DECAY = 0.05;

function createFrameEmitter(onFrame) {
  let rafId = null;
  let latestNodes = null;

  const flush = () => {
    rafId = null;
    if (!latestNodes) return;
    const nodes = latestNodes;
    latestNodes = null;
    onFrame(nodes);
  };

  return {
    push(nodes) {
      latestNodes = nodes;
      if (rafId != null) return;
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        rafId = window.requestAnimationFrame(flush);
      } else {
        rafId = setTimeout(flush, 0);
      }
    },
    flushNow() {
      if (rafId != null) {
        if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(rafId);
        } else {
          clearTimeout(rafId);
        }
        rafId = null;
      }
      if (!latestNodes) return;
      const nodes = latestNodes;
      latestNodes = null;
      onFrame(nodes);
    },
    cancel() {
      if (rafId != null) {
        if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(rafId);
        } else {
          clearTimeout(rafId);
        }
      }
      rafId = null;
      latestNodes = null;
    }
  };
}

function sendMetric(name, valueMs, tags = {}, enabled = false) {
  if (!enabled) return;
  const tagStr = Object.entries(tags).map(([k, v]) => `${k}=${v}`).join(',');
  const line = `${name}${tagStr ? ',' + tagStr : ''} value=${valueMs}`;
  try { fetch('http://localhost:8428/write', { method: 'POST', body: line }).catch(() => {}); } catch (_) {}
}

function finalizeDecollision(nodes, onUpdatePositions, onDecollisionComplete, skipIntermediateFrames, transitionConfig) {
  if (skipIntermediateFrames && transitionConfig?.enabled && transitionConfig?.stablePositions) {
    return startTransition(nodes, transitionConfig, onUpdatePositions, onDecollisionComplete);
  }

  onUpdatePositions([...nodes]);
  if (onDecollisionComplete) {
    onDecollisionComplete([...nodes]);
  }
  return null;
}

function startCpuDecollisioning({
  nodes,
  onUpdatePositions,
  fnDotSize,
  onDecollisionComplete,
  skipIntermediateFrames,
  transitionConfig,
  alphaStart = DEFAULT_ALPHA_START,
  alphaMin = DEFAULT_ALPHA_MIN,
  alphaDecay = DEFAULT_ALPHA_DECAY,
  sendMetrics = false
}) {
  let tickCount = 0;
  const decollisionT0 = performance.now();
  const simulation = d3.forceSimulation(nodes)
    .alpha(alphaStart)
    .alphaMin(alphaMin)
    .alphaDecay(alphaDecay)
    .force('collide', d3.forceCollide().radius(fnDotSize))
    .on('tick', () => {
      tickCount++;
      if (!skipIntermediateFrames) {
        onUpdatePositions([...nodes]);
      }
    })
    .on('end', () => {
      sendMetric('decollision_total', performance.now() - decollisionT0, { n: nodes.length, ticks: tickCount, backend: 'cpu' }, sendMetrics);
      finalizeDecollision(nodes, onUpdatePositions, onDecollisionComplete, skipIntermediateFrames, transitionConfig);
    });

  return simulation;
}

function startWebGpuWithFallback({
  nodes,
  onUpdatePositions,
  onDecollisionComplete,
  skipIntermediateFrames,
  transitionConfig,
  fnDotSize,
  alphaStart,
  alphaMin,
  alphaDecay,
  webgpuStrength,
  webgpuJitter,
  webgpuVelocityDecay,
  webgpuStepsPerTick,
  webgpuReadbackIntervalMs,
  shouldPublishIntermediate,
  allowCpuFallback,
  sendMetrics = false
}) {
  const radii = new Float32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const radius = Number(fnDotSize(nodes[i]));
    radii[i] = Number.isFinite(radius) ? Math.max(0, radius) : 0;
  }

  let gpuRunner = null;
  let fallbackSimulation = null;
  let finalized = false;
  const decollisionT0 = performance.now();
  const frameEmitter = createFrameEmitter((latestNodes) => {
    onUpdatePositions([...latestNodes]);
  });

  const startFallback = () => {
    if (fallbackSimulation || !allowCpuFallback) return;
    console.info('[decollisioning] backend=cpu reason=webgpu_fallback');
    fallbackSimulation = startCpuDecollisioning({
      nodes,
      onUpdatePositions,
      fnDotSize,
      onDecollisionComplete,
      skipIntermediateFrames,
      transitionConfig,
      alphaStart,
      alphaMin,
      alphaDecay,
      sendMetrics
    });
  };

  try {
    gpuRunner = startWebGpuDecollisioning({
      nodes,
      radii,
      alphaStart,
      alphaMin,
      alphaDecay,
      strength: webgpuStrength,
      jitter: webgpuJitter,
      velocityDecay: webgpuVelocityDecay,
      stepsPerTick: webgpuStepsPerTick,
      readbackIntervalMs: webgpuReadbackIntervalMs,
      publishIntermediate: !skipIntermediateFrames,
      shouldPublishIntermediate,
      onTick: (updatedNodes) => {
        frameEmitter.push(updatedNodes);
      },
      onComplete: (finalNodes, tickCount) => {
        frameEmitter.cancel();
        finalized = true;
        sendMetric('decollision_total', performance.now() - decollisionT0, {
          n: nodes.length,
          ticks: tickCount,
          backend: 'webgpu'
        }, sendMetrics);
        finalizeDecollision(finalNodes, onUpdatePositions, onDecollisionComplete, skipIntermediateFrames, transitionConfig);
      },
      onError: (error) => {
        frameEmitter.cancel();
        if (error instanceof WebGpuDecollisionUnavailableError) {
          startFallback();
          return;
        }
        if (allowCpuFallback) {
          console.warn('[decollisioning] WebGPU decollision failed; falling back to CPU', error);
          startFallback();
        } else {
          console.error('[decollisioning] WebGPU decollision failed', error);
        }
      }
    });
  } catch (error) {
    frameEmitter.cancel();
    if (allowCpuFallback) {
      startFallback();
    } else {
      throw error;
    }
  }

  return {
    stop() {
      frameEmitter.cancel();
      gpuRunner?.stop?.();
      fallbackSimulation?.stop?.();
    },
    isGpu: true,
    isFinalized: () => finalized
  };
}

export function decollisioning(
  data,
  onUpdatePositions,
  fnDotSize,
  onDecollisionComplete,
  skipIntermediateFrames = false,
  transitionConfig = null,
  runtimeOptions = {}
) {
  const nodes = data.map(d => ({ ...d }));
  const engine = runtimeOptions.engine ?? 'auto';
  const allowCpuFallback = runtimeOptions.allowCpuFallback ?? true;
  const alphaStart = runtimeOptions.alphaStart ?? DEFAULT_ALPHA_START;
  const alphaMin = runtimeOptions.alphaMin ?? DEFAULT_ALPHA_MIN;
  const alphaDecay = runtimeOptions.alphaDecay ?? DEFAULT_ALPHA_DECAY;
  const sendMetrics = runtimeOptions.sendMetrics ?? false;

  // Auto prefers WebGPU and falls back to CPU when unavailable or invalid.
  const shouldTryWebGpu = engine !== 'cpu';
  if (shouldTryWebGpu && isWebGpuDecollisionAvailable()) {
    console.info('[decollisioning] backend=webgpu engine=' + engine);
    return startWebGpuWithFallback({
      nodes,
      onUpdatePositions,
      onDecollisionComplete,
      skipIntermediateFrames,
      transitionConfig,
      fnDotSize,
      alphaStart,
      alphaMin,
      alphaDecay,
      webgpuStrength: runtimeOptions.webgpuStrength ?? 1,
      webgpuJitter: runtimeOptions.webgpuJitter ?? 1e-6,
      webgpuVelocityDecay: runtimeOptions.webgpuVelocityDecay ?? 0.4,
      webgpuStepsPerTick: runtimeOptions.webgpuStepsPerTick ?? 2,
      webgpuReadbackIntervalMs: runtimeOptions.webgpuReadbackIntervalMs ?? 16,
      shouldPublishIntermediate: runtimeOptions.shouldPublishIntermediate,
      allowCpuFallback,
      sendMetrics
    });
  }

  console.info('[decollisioning] backend=cpu engine=' + engine);
  return startCpuDecollisioning({
    nodes,
    onUpdatePositions,
    fnDotSize,
    onDecollisionComplete,
    skipIntermediateFrames,
    transitionConfig,
    alphaStart,
    alphaMin,
    alphaDecay,
    sendMetrics
  });
}

function startTransition(targetNodes, config, onUpdatePositions, onDecollisionComplete) {
  const { stablePositions, duration, easing } = config;
  const stableMap = new Map(stablePositions.map(node => [node.id, node]));

  const transitionNodes = targetNodes.map(target => {
    const stable = stableMap.get(target.id);
    return {
      ...target,
      _startX: stable ? stable.x : target.x,
      _startY: stable ? stable.y : target.y,
      _targetX: target.x,
      _targetY: target.y,
    };
  });

  const timer = d3.timer((elapsed) => {
    const t = Math.min(elapsed / duration, 1);
    const easedT = easing ? easing(t) : t;

    transitionNodes.forEach(node => {
      node.x = node._startX + (node._targetX - node._startX) * easedT;
      node.y = node._startY + (node._targetY - node._startY) * easedT;
    });

    onUpdatePositions([...transitionNodes]);

    if (t >= 1) {
      timer.stop();
      const finalNodes = transitionNodes.map(node => {
        const { _startX, _startY, _targetX, _targetY, ...clean } = node;
        return { ...clean, x: node._targetX, y: node._targetY };
      });

      onUpdatePositions(finalNodes);
      if (onDecollisionComplete) {
        onDecollisionComplete(finalNodes);
      }
    }
  });

  return timer;
}
