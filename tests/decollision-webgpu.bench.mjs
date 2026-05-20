/**
 * Headless reproduction bench for the WebGPU decollision responsiveness issue.
 *
 * Runs the REAL `src/decollision-webgpu.wgsl` kernels + the REAL
 * `computeGridParams` through Dawn (the `webgpu` npm package) — no Electron,
 * no renderer. It replays the lifecycle that hurts in the app:
 *
 *   base settle (raw layout)  →  focus one dot  →  clear focus
 *
 * and dumps the three metrics that test our hypotheses:
 *
 *   1. Per-iteration max/mean displacement across a base settle — does the
 *      α-schedule cutoff (~90 iters) land BEFORE the field has converged?
 *      (Hypothesis: base freezes mid-trajectory → diverged goal state.)
 *   2. Grid cellSize + bin occupancy for base vs. focus — does one fat
 *      focused dot inflate the uniform cellSize globally and over-fill cells?
 *      (Hypothesis: focus is multiples more expensive per iteration.)
 *   3. Per-iteration GPU time for base vs. focus, and how far dots FAR from
 *      the focused dot move during the focus sim (global re-flow vs. local).
 *
 * Run: `npm run bench:decollision` (or `node tests/decollision-webgpu.bench.mjs`).
 *
 * Dawn-Node quirks (same as decollision-webgpu.test.mjs): one `create([])`
 * at module load; staging buffers destroyed after readback.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { create, globals } from 'webgpu';
import { computeGridParams } from '../src/decollision-webgpu.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WGSL_SRC = readFileSync(join(__dirname, '..', 'src', 'decollision-webgpu.wgsl'), 'utf8');
const SCAN_WGSL_SRC = readFileSync(join(__dirname, '..', 'src', 'decollision-webgpu-scan.wgsl'), 'utf8');

Object.assign(globalThis, globals);
const gpu = create([]);

const WORKGROUP_SIZE = 64;
const PARAM_BYTES = 48;

// Production sim constants (mirror src/decollision-webgpu.js defaults).
const ALPHA_START = 1;
const ALPHA_MIN = 0.01;
const ALPHA_DECAY = 0.05;
const STRENGTH = 1;
const VELOCITY_RETAIN = 0.6; // = 1 - d3 velocityDecay(0.4); the WGSL `apply` field
const JITTER = 1e-6;

// Synthetic-data scale: matches fingertip's RDV_DATA_SCALE mapping (UMAP
// [-1,1] → [0,100]) and a representative defaultSize (nodeRadius 0.008 ×
// committedScale 1 × RDV_DATA_SCALE 50 = 0.4).
const SPACE = 100;
const DEFAULT_SIZE = Number(process.env.BENCH_DOT || 0.4);

function alphaIterations() {
  // alpha *= (1 - ALPHA_DECAY) each iter; stop when alpha < ALPHA_MIN.
  let alpha = ALPHA_START;
  let n = 0;
  while (alpha >= ALPHA_MIN) { alpha += (0 - alpha) * ALPHA_DECAY; n++; }
  return n;
}

function computeScanIterations(n) {
  if (n <= 1) return 0;
  let iters = Math.ceil(Math.log2(n));
  if (iters % 2 === 1) iters += 1;
  return iters;
}

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
  f32[8] = p.strength ?? STRENGTH;
  f32[9] = p.velocityDecay ?? VELOCITY_RETAIN;
  f32[10] = p.jitter ?? JITTER;
  f32[11] = 0;
}

async function setupGPU() {
  const adapter = await gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const mainShader = device.createShaderModule({ code: WGSL_SRC });
  const scanShader = device.createShaderModule({ code: SCAN_WGSL_SRC });

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
  const scanLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const mainPL = device.createPipelineLayout({ bindGroupLayouts: [mainLayout] });
  const scanPL = device.createPipelineLayout({ bindGroupLayouts: [scanLayout] });

  const mk = (layout, module, entryPoint) =>
    device.createComputePipeline({ layout, compute: { module, entryPoint } });
  const pipelines = {
    clearBins: mk(mainPL, mainShader, 'clearBins'),
    countBins: mk(mainPL, mainShader, 'countBins'),
    prefixSumStep: mk(scanPL, scanShader, 'prefixSumStep'),
    placeParticles: mk(mainPL, mainShader, 'placeParticles'),
    collide: mk(mainPL, mainShader, 'collide'),
    apply: mk(mainPL, mainShader, 'apply'),
  };
  return { device, mainLayout, scanLayout, pipelines };
}

// Deterministic PRNG (Mulberry32) for reproducible datasets.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  // Box-Muller.
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Clustered 2D dataset mimicking a UMAP layout: several dense Gaussian cores
 * plus a sparse uniform background. Radii are density-adaptive (dense → small,
 * sparse → large) like fingertip's `computeDensityRadii`, computed via a coarse
 * occupancy grid. Returns { positions: Float32Array(2n), radii: Float32Array(n) }.
 */
function generateClustered(n, seed = 12345) {
  const rng = makeRng(seed);
  const positions = new Float32Array(n * 2);
  const nClusters = 6;
  const centers = [];
  for (let c = 0; c < nClusters; c++) {
    centers.push([SPACE * (0.15 + 0.7 * rng()), SPACE * (0.15 + 0.7 * rng())]);
  }
  const clusterFrac = 0.8; // 80% of dots in cores, 20% sparse background
  for (let i = 0; i < n; i++) {
    let x, y;
    if (rng() < clusterFrac) {
      const c = centers[(rng() * nClusters) | 0];
      const sigma = SPACE * 0.05;
      x = c[0] + gaussian(rng) * sigma;
      y = c[1] + gaussian(rng) * sigma;
    } else {
      x = rng() * SPACE;
      y = rng() * SPACE;
    }
    positions[2 * i] = Math.min(Math.max(x, 0), SPACE);
    positions[2 * i + 1] = Math.min(Math.max(y, 0), SPACE);
  }

  // Density-adaptive radii via a coarse count grid (cheap proxy for kNN dk).
  const G = 80;
  const cell = SPACE / G;
  const counts = new Int32Array(G * G);
  const cellOf = (x, y) => {
    const cx = Math.min(G - 1, Math.max(0, (x / cell) | 0));
    const cy = Math.min(G - 1, Math.max(0, (y / cell) | 0));
    return cy * G + cx;
  };
  for (let i = 0; i < n; i++) counts[cellOf(positions[2 * i], positions[2 * i + 1])]++;
  let maxCount = 1;
  for (let i = 0; i < counts.length; i++) if (counts[i] > maxCount) maxCount = counts[i];

  // Dense (count→maxCount) maps to 0.5×, sparse (count→1) maps to 2× default.
  const radii = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = counts[cellOf(positions[2 * i], positions[2 * i + 1])];
    const density = c / maxCount; // (0,1]
    const factor = 2 - 1.5 * density; // density 1 → 0.5, density→0 → 2
    radii[i] = DEFAULT_SIZE * factor;
  }
  return { positions, radii };
}

/** A live decollision simulation bound to one device, with measurement hooks. */
class Sim {
  constructor(ctx, positions, radii) {
    this.ctx = ctx;
    this.n = radii.length;
    this.radii = radii;
    const { device } = ctx;
    const grid = computeGridParams(packNodes(positions), radii);
    this.grid = grid;
    this.binArrayLen = grid.numBins + 1;

    const storage = (bytes, init) => {
      const b = device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      if (init) device.queue.writeBuffer(b, 0, init.buffer, init.byteOffset, init.byteLength);
      return b;
    };

    this.posBuf = storage(positions.byteLength, positions);
    this.velBuf = storage(positions.byteLength, new Float32Array(this.n * 2));
    this.radiiBuf = device.createBuffer({
      size: radii.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.radiiBuf, 0, radii.buffer, radii.byteOffset, radii.byteLength);
    this.nextVelBuf = storage(positions.byteLength);
    this.binBuf = storage(this.binArrayLen * 4);
    this.placeBuf = storage(grid.numBins * 4);
    this.sortedBuf = storage(this.n * 4);
    this.scanScratch = storage(this.binArrayLen * 4);
    this.paramsBuf = device.createBuffer({
      size: PARAM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.mainBG = device.createBindGroup({
      layout: ctx.mainLayout,
      entries: [
        { binding: 0, resource: { buffer: this.posBuf } },
        { binding: 1, resource: { buffer: this.velBuf } },
        { binding: 2, resource: { buffer: this.radiiBuf } },
        { binding: 3, resource: { buffer: this.nextVelBuf } },
        { binding: 4, resource: { buffer: this.paramsBuf } },
        { binding: 5, resource: { buffer: this.binBuf } },
        { binding: 6, resource: { buffer: this.placeBuf } },
        { binding: 7, resource: { buffer: this.sortedBuf } },
      ],
    });

    this.scanIters = computeScanIterations(this.binArrayLen);
    this.scanParamBufs = [];
    for (let s = 0; s < this.scanIters; s++) {
      const buf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, new Uint32Array([this.binArrayLen, 1 << s]).buffer, 0, 8);
      this.scanParamBufs.push(buf);
    }
    this.scanA2B = this.scanParamBufs.map((pb) => device.createBindGroup({
      layout: ctx.scanLayout,
      entries: [
        { binding: 0, resource: { buffer: this.binBuf } },
        { binding: 1, resource: { buffer: this.scanScratch } },
        { binding: 2, resource: { buffer: pb } },
      ],
    }));
    this.scanB2A = this.scanParamBufs.map((pb) => device.createBindGroup({
      layout: ctx.scanLayout,
      entries: [
        { binding: 0, resource: { buffer: this.scanScratch } },
        { binding: 1, resource: { buffer: this.binBuf } },
        { binding: 2, resource: { buffer: pb } },
      ],
    }));

    this.particleWG = Math.ceil(this.n / WORKGROUP_SIZE);
    this.binWG = Math.ceil(this.binArrayLen / WORKGROUP_SIZE);
    this.epoch = 0;
    this._params = new ArrayBuffer(PARAM_BYTES);
  }

  _writeParams() {
    writeParams(this._params, {
      nNodes: this.n,
      numBins: this.grid.numBins,
      gridDimX: this.grid.gridDimX,
      gridDimY: this.grid.gridDimY,
      gridMinX: this.grid.gridMinX,
      gridMinY: this.grid.gridMinY,
      cellSize: this.grid.cellSize,
      epoch: this.epoch,
      strength: STRENGTH,
      velocityDecay: VELOCITY_RETAIN,
      jitter: JITTER,
    });
    this.ctx.device.queue.writeBuffer(this.paramsBuf, 0, this._params, 0, PARAM_BYTES);
  }

  _encodeBinning(enc) {
    {
      const p = enc.beginComputePass();
      p.setBindGroup(0, this.mainBG); p.setPipeline(this.ctx.pipelines.clearBins);
      p.dispatchWorkgroups(this.binWG); p.end();
    }
    {
      const p = enc.beginComputePass();
      p.setBindGroup(0, this.mainBG); p.setPipeline(this.ctx.pipelines.countBins);
      p.dispatchWorkgroups(this.particleWG); p.end();
    }
    for (let s = 0; s < this.scanIters; s++) {
      const bg = (s % 2 === 0) ? this.scanA2B[s] : this.scanB2A[s];
      const p = enc.beginComputePass();
      p.setBindGroup(0, bg); p.setPipeline(this.ctx.pipelines.prefixSumStep);
      p.dispatchWorkgroups(this.binWG); p.end();
    }
  }

  /** One full iteration: clear → count → scan → place → collide → apply. */
  encodeIteration(enc) {
    this._writeParams();
    this._encodeBinning(enc);
    {
      const p = enc.beginComputePass();
      p.setBindGroup(0, this.mainBG); p.setPipeline(this.ctx.pipelines.placeParticles);
      p.dispatchWorkgroups(this.particleWG); p.end();
    }
    {
      const p = enc.beginComputePass();
      p.setBindGroup(0, this.mainBG); p.setPipeline(this.ctx.pipelines.collide);
      p.dispatchWorkgroups(this.particleWG);
      p.setPipeline(this.ctx.pipelines.apply);
      p.dispatchWorkgroups(this.particleWG);
      p.end();
    }
    this.epoch++;
  }

  /** Submit `count` iterations (no readback). */
  submitIterations(count) {
    const { device } = this.ctx;
    for (let i = 0; i < count; i++) {
      const enc = device.createCommandEncoder();
      this.encodeIteration(enc);
      device.queue.submit([enc.finish()]);
    }
  }

  async sync() { await this.ctx.device.queue.onSubmittedWorkDone(); }

  async readPositions() {
    const bytes = this.n * 2 * 4;
    const staging = this.ctx.device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.ctx.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.posBuf, 0, staging, 0, bytes);
    this.ctx.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap(); staging.destroy();
    return out;
  }

  /** Run clear+count+scan once on current positions; read per-bin occupancy. */
  async measureOccupancy() {
    const { device } = this.ctx;
    this._writeParams();
    const enc = device.createCommandEncoder();
    this._encodeBinning(enc);
    device.queue.submit([enc.finish()]);
    const bytes = this.binArrayLen * 4;
    const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc2 = device.createCommandEncoder();
    enc2.copyBufferToBuffer(this.binBuf, 0, staging, 0, bytes);
    device.queue.submit([enc2.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const offsets = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap(); staging.destroy();
    let occMax = 0, nonEmpty = 0, total = 0;
    for (let b = 0; b < this.grid.numBins; b++) {
      const c = offsets[b + 1] - offsets[b];
      if (c > 0) { nonEmpty++; total += c; if (c > occMax) occMax = c; }
    }
    return { avg: nonEmpty ? total / nonEmpty : 0, max: occMax, nonEmpty, cellSize: this.grid.cellSize, numBins: this.grid.numBins, gridDim: `${this.grid.gridDimX}×${this.grid.gridDimY}` };
  }

  destroy() {
    for (const b of [this.posBuf, this.velBuf, this.radiiBuf, this.nextVelBuf, this.binBuf, this.placeBuf, this.sortedBuf, this.scanScratch, this.paramsBuf, ...this.scanParamBufs]) b.destroy();
  }
}

function packNodes(positions) {
  const n = positions.length / 2;
  const nodes = new Array(n);
  for (let i = 0; i < n; i++) nodes[i] = { x: positions[2 * i], y: positions[2 * i + 1] };
  return nodes;
}

function maxMeanDisplacement(a, b) {
  let max = 0, sum = 0;
  const n = a.length / 2;
  for (let i = 0; i < n; i++) {
    const dx = a[2 * i] - b[2 * i];
    const dy = a[2 * i + 1] - b[2 * i + 1];
    const d = Math.hypot(dx, dy);
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: sum / n };
}

function fmt(n, d = 3) { return Number(n).toFixed(d); }

/** Submit k iterations with no readback; return GPU wall time per iter (ms). */
async function timePerIter(sim, k) {
  const t0 = performance.now();
  sim.submitIterations(k);
  await sim.sync();
  return (performance.now() - t0) / k;
}

/** Run from current state until maxDisp/it < eps (sampled over `window`) or
 *  `cap` iters. Returns { iters, finalPositions, curve, converged }. */
async function settle(sim, { eps, cap, window }) {
  let prev = await sim.readPositions();
  let done = 0;
  const curve = [];
  let converged = false;
  while (done < cap) {
    const k = Math.min(window, cap - done);
    sim.submitIterations(k);
    await sim.sync();
    const cur = await sim.readPositions();
    const { max, mean } = maxMeanDisplacement(cur, prev);
    curve.push({ iter: done + k, max: max / k, mean: mean / k });
    prev = cur;
    done += k;
    if (max / k < eps) { converged = true; break; }
  }
  return { iters: done, finalPositions: prev, curve, converged };
}

/** Run exactly `iters` from current state; return { finalPositions, msPerIter }. */
async function runFixed(sim, iters) {
  const t0 = performance.now();
  sim.submitIterations(iters);
  await sim.sync();
  const msPerIter = (performance.now() - t0) / iters;
  const finalPositions = await sim.readPositions();
  return { finalPositions, msPerIter };
}

async function main() {
  const N = Number(process.env.BENCH_N || 67000);
  const alphaIters = alphaIterations();
  const EPS = 0.02; // convergence threshold on maxDisp/it (data-space units)
  console.log(`\n=== decollision WebGPU bench — N=${N}, α-cutoff=${alphaIters} iters, ε=${EPS} ===\n`);

  const ctx = await setupGPU();
  const { positions, radii } = generateClustered(N);
  let baseMaxR = 0;
  for (let i = 0; i < N; i++) if (radii[i] > baseMaxR) baseMaxR = radii[i];

  // ── Phase 1: base settle — is the α-cutoff premature? ────────────────────
  const base = new Sim(ctx, positions, radii);
  const baseOcc = await base.measureOccupancy();
  console.log('[base] grid:', `cellSize=${fmt(baseOcc.cellSize)} maxRadius=${fmt(baseMaxR)} dims=${baseOcc.gridDim} bins=${baseOcc.numBins}`);
  console.log('[base] occupancy:', `avg=${fmt(baseOcc.avg, 2)} max=${baseOcc.max} nonEmptyBins=${baseOcc.nonEmpty}`);

  const settleRun = await settle(base, { eps: EPS, cap: alphaIters * 10, window: 5 });
  console.log('\n[base] settle curve (maxDisp/it, meanDisp/it):');
  console.log('  iter |  maxDisp/it  meanDisp/it');
  for (const w of settleRun.curve) {
    if (w.iter % 25 === 0 || w.iter <= alphaIters + 5) {
      const mark = w.iter === Math.ceil(alphaIters / 5) * 5 ? '  <- α-cutoff' : '';
      console.log(`  ${String(w.iter).padStart(4)} |  ${fmt(w.max, 4)}      ${fmt(w.mean, 5)}${mark}`);
    }
  }
  const atCutoff = settleRun.curve.find((w) => w.iter >= alphaIters);
  console.log(`\n[base] PREMATURE? maxDisp/it at α-cutoff(${alphaIters})=${fmt(atCutoff?.max ?? 0, 4)}, ε=${EPS} reached at iter ${settleRun.converged ? settleRun.iters : '>' + settleRun.iters}`);
  console.log(`[base] → α-cutoff fires ${fmt((settleRun.iters / alphaIters), 1)}× too early relative to true convergence`);
  const baseConv = settleRun.finalPositions; // converged reference config
  base.destroy();

  // ── Phase 2: focus cost — grid inflation + per-iter GPU time ─────────────
  // Sweep the dense-core dot (tiny natural radius) and the sparse-area dot
  // (largest natural radius). focusOuterRadius ≈ naturalSize × 2.125.
  const denseIdx = argMinRadius(radii);
  const sparseIdx = argMaxRadius(radii);
  const baseStep = new Sim(ctx, baseConv, radii);
  const baseMsPerIter = await timePerIter(baseStep, 30);
  baseStep.destroy();
  console.log(`\n[base] settled GPU time: ${fmt(baseMsPerIter, 3)} ms/it`);

  const focusResults = {};
  for (const [label, idx] of [['focus-dense', denseIdx], ['focus-sparse', sparseIdx]]) {
    const focusRadii = radii.slice();
    const focusOuter = radii[idx] * 1.25 * 1.7;
    focusRadii[idx] = focusOuter;
    const focus = new Sim(ctx, baseConv, focusRadii);
    const occ = await focus.measureOccupancy();
    console.log(`\n[${label}] naturalR=${fmt(radii[idx])} focusOuterR=${fmt(focusOuter)} (×${fmt(focusOuter / baseMaxR, 2)} base maxR)`);
    console.log(`[${label}] grid: cellSize=${fmt(occ.cellSize)} (×${fmt(occ.cellSize / baseOcc.cellSize, 2)}) dims=${occ.gridDim} bins=${occ.numBins}`);
    console.log(`[${label}] occupancy: avg=${fmt(occ.avg, 2)} (×${fmt(occ.avg / baseOcc.avg, 2)}) max=${occ.max}`);
    const msPerIter = await timePerIter(focus, 30);
    console.log(`[${label}] GPU time: ${fmt(msPerIter, 3)} ms/it (×${fmt(msPerIter / baseMsPerIter, 2)} base)`);
    focus.destroy();
    focusResults[label] = { idx, focusRadii, focusPos: [baseConv[2 * idx], baseConv[2 * idx + 1]], cellSize: occ.cellSize };
  }

  // ── Phase 3: is the focus "global re-flow" focus-specific, or just the
  //    prematurely-frozen base resuming under the α=1 restart? ──────────────
  // The app's base cache holds the α-cutoff state (frozen mid-trajectory).
  // A focus click seeds a fresh α=1 sim from THAT, so any global motion the
  // cutoff interrupted resumes. Reproduce by seeding from the frozen base, and
  // contrast with seeding from a converged base.
  const sparse = focusResults['focus-sparse'];
  const frozenSim = new Sim(ctx, positions, radii);
  const { finalPositions: baseFrozen } = await runFixed(frozenSim, alphaIters);
  frozenSim.destroy();

  const farRadius = sparse.cellSize * 4;
  // RESUME: frozen base, continue with BASE radii (no focus). Far-field motion
  // here is purely the interrupted global settling resuming.
  const resume = new Sim(ctx, baseFrozen, radii);
  const { finalPositions: resumeOut } = await runFixed(resume, alphaIters);
  resume.destroy();
  const resumeFar = farField(baseFrozen, resumeOut, sparse.focusPos, farRadius);

  // FOCUS-FROM-FROZEN: frozen base + focus radii. App's actual focus path.
  const ffSim = new Sim(ctx, baseFrozen, sparse.focusRadii);
  const { finalPositions: ffOut } = await runFixed(ffSim, alphaIters);
  ffSim.destroy();
  const ffFar = farField(baseFrozen, ffOut, sparse.focusPos, farRadius);

  // FOCUS-FROM-CONVERGED: converged base + focus radii. What focus WOULD cost
  // globally if the base were already settled.
  const fcSim = new Sim(ctx, baseConv, sparse.focusRadii);
  const { finalPositions: fcOut } = await runFixed(fcSim, alphaIters);
  fcSim.destroy();
  const fcFar = farField(baseConv, fcOut, sparse.focusPos, farRadius);

  console.log('\n[global re-flow] far-field mean move (>4 cells from focused dot), 90-iter restart:');
  console.log(`  resume  (frozen base, base radii):       ${fmt(resumeFar.mean, 5)}  ← interrupted settling resuming`);
  console.log(`  focus   (frozen base, focus radii):      ${fmt(ffFar.mean, 5)}`);
  console.log(`  focus   (converged base, focus radii):   ${fmt(fcFar.mean, 5)}  ← focus's OWN global effect`);
  console.log(`\n  → focus-from-frozen vs resume: ×${fmt(ffFar.mean / Math.max(resumeFar.mean, 1e-9), 2)} (≈1 ⇒ re-flow is the frozen base resuming, NOT focus)`);
  console.log(`  → focus-from-converged is ${fmt(fcFar.mean / Math.max(resumeFar.mean, 1e-9), 2)}× the resume drift (small ⇒ focus alone is ~local; the global drift was prematurity)`);
  console.log('\n  Implication: converging the base removes the global re-flow at its source.');

  console.log('\n=== done ===\n');
  process.exit(0);
}

function argMinRadius(radii) { let m = 0; for (let i = 1; i < radii.length; i++) if (radii[i] < radii[m]) m = i; return m; }
function argMaxRadius(radii) { let m = 0; for (let i = 1; i < radii.length; i++) if (radii[i] > radii[m]) m = i; return m; }

/** Mean/max displacement of dots farther than `minDist` from `center`
 *  (minDist=0 ⇒ whole field). */
function farField(before, after, center, minDist) {
  let max = 0, sum = 0, count = 0;
  const n = before.length / 2;
  const minD2 = minDist * minDist;
  for (let i = 0; i < n; i++) {
    const fx = before[2 * i] - center[0];
    const fy = before[2 * i + 1] - center[1];
    if (fx * fx + fy * fy < minD2) continue;
    count++;
    const d = Math.hypot(after[2 * i] - before[2 * i], after[2 * i + 1] - before[2 * i + 1]);
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: count ? sum / count : 0, count };
}

main().catch((e) => { console.error(e); process.exit(1); });
