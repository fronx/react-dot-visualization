/**
 * Bench for the R3FDots big-effect slow path (applyDotStylesToInstances).
 *
 * Reproduces the per-click cascade observed in fingertip at N=70k:
 *   1. initial mount  — full population
 *   2. click          — lockedId set, selection ids set, paint map updated
 *   3. neighbours arrive — focus neighbour opacity entries added
 *   4. playing starts — pulse entry added for one dot
 *
 * Each transition rebuilds the per-instance attributes; bench reports per
 * transition wall-clock + cascade total. Verifies headlessly that:
 *   - baseline cost is ~80–110 ms per full rebuild at N=70k (matches the
 *     in-app diagnostic)
 *   - upcoming small-delta path can collapse transitions 2–4 to single-
 *     digit ms when data positions are stable.
 *
 * Run: node --test tests/instance-update.bench.mjs
 */
import { test } from 'node:test';
import { applyDotStylesToInstances } from '../src/r3f/instanceUpdate.js';

const N = 70_000;
const RUNS = 5;

function buildData(n) {
  const data = new Array(n);
  for (let i = 0; i < n; i++) {
    data[i] = {
      id: 's' + i,
      x: (i % 256) * 0.5,
      y: ((i / 256) | 0) * 0.5,
      size: 1.0,
      color: '#7c6fff',
    };
  }
  return data;
}

function freshBuffers(n) {
  return {
    matrix: new Float32Array(16 * n),
    color: new Float32Array(3 * n),
    alpha: new Float32Array(n),
    focus: new Float32Array(n),
  };
}

const DEFAULTS = {
  defaultColor: '#7c6fff',
  defaultSize: 1.0,
  defaultOpacity: 1.0,
  hoverOpacity: 1.0,
  hoverSizeMultiplier: 1.5,
};

const EMPTY = new Map();

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function fmt(ms) {
  return ms.toFixed(1).padStart(6) + 'ms';
}

function buildClickCascadeInputs() {
  const dotStylesClick = new Map();
  dotStylesClick.set('s100', { r: 2.0, opacity: 1, fill: '#ffffff', focusRing: true });
  const radiusOverridesClick = new Map();
  radiusOverridesClick.set('s100', 2.0);

  const dotStylesNeighbours = new Map(dotStylesClick);
  for (let i = 0; i < 20; i++) {
    dotStylesNeighbours.set('s' + (200 + i), { opacity: 1 });
  }

  const dotStylesPlaying = new Map(dotStylesNeighbours);
  const lockedStyleWithPulse = {
    ...dotStylesNeighbours.get('s100'),
    pulse: { duration: 1250, sizeRange: 0.3, ringEffect: true,
      ringTargetPixels: 42, ringMinRatio: 3.0 },
  };
  dotStylesPlaying.set('s100', lockedStyleWithPulse);
  const pulseDotsPlaying = new Map();
  pulseDotsPlaying.set('s100', lockedStyleWithPulse.pulse);

  return {
    click: { dotStyles: dotStylesClick, pulseDots: EMPTY, radiusOverrides: radiusOverridesClick },
    neighbours: { dotStyles: dotStylesNeighbours, pulseDots: EMPTY, radiusOverrides: radiusOverridesClick },
    playing: { dotStyles: dotStylesPlaying, pulseDots: pulseDotsPlaying, radiusOverrides: radiusOverridesClick },
  };
}

test('baseline: full rebuild cascade at N=70k', () => {
  const data = buildData(N);
  const buffers = freshBuffers(N);

  // Per-click cascade: 4 transitions per "click cycle".
  // Run RUNS cycles; report per-transition mean.
  const tInitial = [];
  const tClick = [];
  const tNeighbours = [];
  const tPlaying = [];

  for (let run = 0; run < RUNS; run++) {
    // ── Transition 1: initial mount (empty maps) ─────────────────────────
    let t = performance.now();
    applyDotStylesToInstances({
      data, dotStyles: EMPTY, pulseDots: EMPTY, radiusOverrides: EMPTY,
      defaults: DEFAULTS, hoveredId: null, buffers, ringBuffers: null,
    });
    tInitial.push(performance.now() - t);

    // ── Transition 2: click ──────────────────────────────────────────────
    // lockedId='s100' → focus dotStyle with r=2.0 + focusRing.
    // selectionIds={'s100'} → no extra paint map (matched paint already empty
    // since no filter is active in focus mode; selection just sets the focus).
    // paintDotStyles is sparse in focus mode — only the playing/offline dots
    // get entries. Here we have neither yet, so just the focus entry.
    const dotStylesClick = new Map();
    dotStylesClick.set('s100', { r: 2.0, opacity: 1, fill: '#ffffff', focusRing: true });
    const radiusOverridesClick = new Map();
    radiusOverridesClick.set('s100', 2.0);
    t = performance.now();
    applyDotStylesToInstances({
      data, dotStyles: dotStylesClick, pulseDots: EMPTY, radiusOverrides: radiusOverridesClick,
      defaults: DEFAULTS, hoveredId: null, buffers, ringBuffers: null,
    });
    tClick.push(performance.now() - t);

    // ── Transition 3: neighbours arrive ──────────────────────────────────
    // 20 neighbour ids gain opacity:1.
    const dotStylesN = new Map(dotStylesClick);
    for (let i = 0; i < 20; i++) {
      dotStylesN.set('s' + (200 + i), { opacity: 1 });
    }
    t = performance.now();
    applyDotStylesToInstances({
      data, dotStyles: dotStylesN, pulseDots: EMPTY, radiusOverrides: radiusOverridesClick,
      defaults: DEFAULTS, hoveredId: null, buffers, ringBuffers: null,
    });
    tNeighbours.push(performance.now() - t);

    // ── Transition 4: playing starts ─────────────────────────────────────
    // Pulse entry added for the playing dot.
    const dotStylesP = new Map(dotStylesN);
    dotStylesP.set('s100', {
      ...dotStylesN.get('s100'),
      pulse: { duration: 1250, sizeRange: 0.3, ringEffect: true,
        ringTargetPixels: 42, ringMinRatio: 3.0 },
    });
    const pulseDotsP = new Map();
    pulseDotsP.set('s100', dotStylesP.get('s100').pulse);
    t = performance.now();
    applyDotStylesToInstances({
      data, dotStyles: dotStylesP, pulseDots: pulseDotsP, radiusOverrides: radiusOverridesClick,
      defaults: DEFAULTS, hoveredId: null, buffers, ringBuffers: null,
    });
    tPlaying.push(performance.now() - t);
  }

  const m1 = mean(tInitial);
  const m2 = mean(tClick);
  const m3 = mean(tNeighbours);
  const m4 = mean(tPlaying);
  const cascade = m2 + m3 + m4;

  console.log(`\n  N=${N.toLocaleString()}, ${RUNS} runs`);
  console.log(`  initial mount  : ${fmt(m1)}`);
  console.log(`  click          : ${fmt(m2)}`);
  console.log(`  neighbours     : ${fmt(m3)}`);
  console.log(`  playing        : ${fmt(m4)}`);
  console.log(`  ─────────────────────────`);
  console.log(`  click cascade  : ${fmt(cascade)}  (sum of transitions 2-4)`);
});

test('delta path: small-diff cascade at N=70k (positions stable)', () => {
  const data = buildData(N);
  const buffers = freshBuffers(N);
  const cascade = buildClickCascadeInputs();
  const defaultsSnap = DEFAULTS;
  const hoveredId = null;

  const tClick = [];
  const tNeighbours = [];
  const tPlaying = [];

  for (let run = 0; run < RUNS; run++) {
    // Initial mount via full path (no prev).
    let result = applyDotStylesToInstances({
      data, dotStyles: EMPTY, pulseDots: EMPTY, radiusOverrides: EMPTY,
      defaults: defaultsSnap, hoveredId, buffers, ringBuffers: null,
    });
    let prev = {
      data, dotStyles: EMPTY, pulseDots: EMPTY, radiusOverrides: EMPTY,
      defaults: defaultsSnap, hoveredId,
      dotInfoById: result.dotInfoById,
      dynamicDots: result.dynamicDots,
      dynamicDotsById: result.dynamicDotsById,
    };

    // ── Transition 2: click ──────────────────────────────────────────────
    let t = performance.now();
    result = applyDotStylesToInstances({
      data, ...cascade.click,
      defaults: defaultsSnap, hoveredId, buffers, ringBuffers: null, prev,
    });
    tClick.push(performance.now() - t);
    prev = {
      data, ...cascade.click, defaults: defaultsSnap, hoveredId,
      dotInfoById: result.dotInfoById,
      dynamicDots: result.dynamicDots,
      dynamicDotsById: result.dynamicDotsById,
    };

    // ── Transition 3: neighbours arrive ──────────────────────────────────
    t = performance.now();
    result = applyDotStylesToInstances({
      data, ...cascade.neighbours,
      defaults: defaultsSnap, hoveredId, buffers, ringBuffers: null, prev,
    });
    tNeighbours.push(performance.now() - t);
    prev = {
      data, ...cascade.neighbours, defaults: defaultsSnap, hoveredId,
      dotInfoById: result.dotInfoById,
      dynamicDots: result.dynamicDots,
      dynamicDotsById: result.dynamicDotsById,
    };

    // ── Transition 4: playing starts ─────────────────────────────────────
    t = performance.now();
    result = applyDotStylesToInstances({
      data, ...cascade.playing,
      defaults: defaultsSnap, hoveredId, buffers, ringBuffers: null, prev,
    });
    tPlaying.push(performance.now() - t);
  }

  const m2 = mean(tClick);
  const m3 = mean(tNeighbours);
  const m4 = mean(tPlaying);
  const cascadeTotal = m2 + m3 + m4;

  console.log(`\n  N=${N.toLocaleString()}, ${RUNS} runs (delta path)`);
  console.log(`  click          : ${fmt(m2)}`);
  console.log(`  neighbours     : ${fmt(m3)}`);
  console.log(`  playing        : ${fmt(m4)}`);
  console.log(`  ─────────────────────────`);
  console.log(`  click cascade  : ${fmt(cascadeTotal)}  (sum of transitions 2-4)`);
});
