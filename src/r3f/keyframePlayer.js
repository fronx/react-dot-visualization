/**
 * GPU keyframe-chain player for R3FDotsWebGPU's 'keyframes' job.
 *
 * Plays a chain of position keyframes with the existing GPU lerp kernels
 * (lerpKernels.js): a global clock t in [0,1] — eased CPU-side — maps to a
 * segment index i and a local fraction f. At each segment boundary the player
 * writes frames[i] / frames[i+1] into the persistent fromPos/targetPos buffers
 * (one CPU buffer write per boundary — cheap at the typical 16–32 keyframes
 * over ~2s); every frame after that is just a t-uniform update plus one mix
 * dispatch, so positions stay GPU-resident throughout. The final dispatch runs
 * with t exactly 1, so positions land bit-equal on the last keyframe — the same
 * landing a plain 'lerp' target produces, keeping the decollision-handoff edge
 * unchanged.
 *
 * Coordinate convention: frames are PACKED RENDER-SPACE coords
 * ([x0, y0, x1, y1, …], Float32Array of length N*2). Unlike the 'lerp' job's
 * {x, y} data-space targets, no y negation happens here — the caller performs
 * any data→render transform (e.g. the worldY = -y flip) before issuing, and the
 * player copies frame data verbatim.
 *
 * Plain .js (no JSX/React) so the headless Dawn tests can drive the exact
 * production chain logic against the real kernels.
 */
import { easeCubicOut, easeCubicInOut } from 'd3';

const EASINGS = {
  linear: (t) => t,
  'ease-out': easeCubicOut,
  'ease-in-out': easeCubicInOut,
};

/** Resolve a named easing ('linear' | 'ease-out' | 'ease-in-out') to a
 * function over [0,1]. Unknown / missing names fall back to linear. */
export function resolveKeyframeEasing(name) {
  return EASINGS[name] || EASINGS.linear;
}

// Map an eased global clock e in [0,1] over `segmentCount` segments to
// { segment, fraction }. At e=1 this returns the last segment at fraction
// exactly 1, so the final mix dispatch computes a*(1-1) + b*1 == b bit-exact
// for finite a — positions land bit-equal on the last keyframe.
export function keyframePhase(e, segmentCount) {
  const pos = e * segmentCount;
  const segment = Math.min(Math.floor(pos), segmentCount - 1);
  return { segment, fraction: pos - segment };
}

/**
 * Instant path (duration <= 0): write the last keyframe into targetPos and run
 * one mix dispatch at t=1 so positions land bit-equal on it through the same
 * kernel path as the animated chain.
 */
export function jumpToLastKeyframe({ gl, buffers, mixKernel, tU, frames }) {
  buffers.targetPos.value.array.set(frames[frames.length - 1]);
  buffers.targetPos.value.needsUpdate = true;
  tU.value = 1;
  gl.compute(mixKernel);
}

/**
 * Create the per-frame driver for one keyframe chain. The caller (the
 * 'keyframes' job in R3FDotsWebGPU's useFrame loop) calls `step(nowMs)` once
 * per rAF frame until it returns true; supersession is simply never stepping
 * the old player again — it holds no async work and issues no writes outside
 * `step`.
 *
 * @param {object} opts
 * @param {object} opts.gl renderer with a `.compute(node)` method (WebGPURenderer)
 * @param {object} opts.buffers persistent seed buffers; uses `fromPos`/`targetPos`
 * @param {object} opts.mixKernel the fromPos→targetPos mix compute node
 *   (buildLerpKernels(...).mixStep)
 * @param {object} opts.tU the mix kernel's t uniform
 * @param {Float32Array[]} opts.frames packed render-space keyframes, each N*2.
 *   A single-frame chain plays from the CURRENT positions to frames[0]: the
 *   caller must snapshot fromPos (lerpKernels.snapshot) before the first step,
 *   and the player leaves fromPos untouched.
 * @param {number} opts.duration total chain duration in ms (> 0; the caller
 *   handles duration <= 0 via jumpToLastKeyframe)
 * @param {string} [opts.easing] named easing applied to the global clock;
 *   default 'linear'
 * @param {number} opts.startMs clock origin (performance.now() at job start)
 * @returns {{ step: (nowMs: number) => boolean }} step returns true once the
 *   chain has completed (final t=1 dispatch issued)
 */
export function createKeyframePlayer({ gl, buffers, mixKernel, tU, frames, duration, easing, startMs }) {
  const ease = resolveKeyframeEasing(easing);
  const single = frames.length === 1;
  const segmentCount = single ? 1 : frames.length - 1;
  let loaded = -1;
  const loadSegment = (i) => {
    if (!single) {
      buffers.fromPos.value.array.set(frames[i]);
      buffers.fromPos.value.needsUpdate = true;
    }
    buffers.targetPos.value.array.set(frames[single ? 0 : i + 1]);
    buffers.targetPos.value.needsUpdate = true;
    loaded = i;
  };
  return {
    step(nowMs) {
      const t = Math.min(1, Math.max(0, (nowMs - startMs) / duration));
      const { segment, fraction } = keyframePhase(ease(t), segmentCount);
      if (segment !== loaded) loadSegment(segment);
      tU.value = fraction;
      gl.compute(mixKernel);
      return t >= 1;
    },
  };
}
