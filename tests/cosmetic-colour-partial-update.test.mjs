// Hovering a dot starts a preview, which changes that dot's transient style and
// nothing else. So there is a before-set and an after-set of colours for every
// dot, and they must be equal — the audible owner included, since the transient
// overlay only ever carries opacity and pulse.
//
// The colour that reaches the screen is what the renderer uploads, so these
// tests read the colours back out of a fake GPU after driving three's real
// buffer code with R3FDotsWebGPU's real write lanes:
//   buildCosmeticBuffers → writeCosmetics   (full rewrite + full range)
//   first render         → createAttribute  (allocates and pads the GPU buffer)
//   hover                → one sparse write + markAttributeIndicesForUpdate
//
// The trap this pins: three pads an itemSize-3 storage attribute to vec4 for
// the GPU, but keeps re-deriving that padded array from `attribute.array` read
// at stride 3 on EVERY upload (WebGPUAttributeUtils `_force3to4BytesAlignment`).
// Only a full stride-3 rewrite leaves the array in the layout the re-derivation
// expects, so a single-dot write shifts every other dot's colour by one slot.
// A sparse upload hides that at first — it only sends its own dot — so the
// after-set is read twice: as uploaded, and again after the next full upload,
// which is when the shifted values actually reach the screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebGPUAttributeUtils from 'three/src/renderers/webgpu/utils/WebGPUAttributeUtils.js';
import StorageInstancedBufferAttribute from 'three/src/renderers/common/StorageInstancedBufferAttribute.js';
import { markAttributeIndicesForUpdate } from '../src/r3f/dynamicDotStyles.js';
import { COLOR_STRIDE } from '../src/r3f/dotAppearance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Two "folders": dots share one of two palette colours, the way the samples
// map shares one hue per folder. Under the stride bug each dot reads across
// two neighbouring padded slots, so the palette stops collapsing — the field
// signature is the distinct-colour count jumping, not just colours moving.
const PALETTE = [[0.10, 0.11, 0.12], [0.60, 0.61, 0.62]];
const COLOURS = [0, 0, 1, 1, 0, 1].map((p) => PALETTE[p]);
const HOVERED = 3;

const distinctColours = (set) => new Set(set.map((c) => c.join(','))).size;

// A GPU whose buffer we can read back. writeBuffer follows the WebGPU spec:
// dataOffset/size count ELEMENTS of the typed array, bufferOffset counts bytes.
function fakeBackend() {
  const store = new WeakMap();
  const state = { bytes: null };
  return {
    state,
    get(o) {
      let d = store.get(o);
      if (!d) { d = {}; store.set(o, d); }
      return d;
    },
    device: {
      createBuffer({ size }) {
        state.bytes = new ArrayBuffer(size);
        return { getMappedRange: () => state.bytes, unmap() {} };
      },
      queue: {
        writeBuffer(buffer, bufferOffset, data, dataOffset, size) {
          const bpe = data.BYTES_PER_ELEMENT;
          const count = size === undefined ? data.length - dataOffset : size;
          const src = new Uint8Array(data.buffer, data.byteOffset + dataOffset * bpe, count * bpe);
          new Uint8Array(state.bytes).set(src, bufferOffset);
        },
      },
    },
  };
}

// Every dot's colour as the GPU currently holds it. The GPU layout is always
// vec4 — that is the padding three applies and the reason this file exists.
function gpuColours(bytes, n) {
  const f = new Float32Array(bytes);
  return Array.from({ length: n }, (_, i) =>
    [f[i * 4], f[i * 4 + 1], f[i * 4 + 2]].map((v) => Number(v.toFixed(2))));
}

// Runs the hover at the given stride and returns the colour sets around it.
function coloursAroundHover(stride) {
  const n = COLOURS.length;
  const attribute = new StorageInstancedBufferAttribute(new Float32Array(n * stride), stride);
  const backend = fakeBackend();
  const utils = new WebGPUAttributeUtils(backend);

  const writeColour = (i) => {
    attribute.array[i * stride] = COLOURS[i][0];
    attribute.array[i * stride + 1] = COLOURS[i][1];
    attribute.array[i * stride + 2] = COLOURS[i][2];
  };
  const writeCosmetics = () => {
    for (let i = 0; i < n; i++) writeColour(i);
    attribute.addUpdateRange(0, n * stride);
    attribute.needsUpdate = true;
  };

  writeCosmetics();                    // buildCosmeticBuffers seeds the styles
  writeCosmetics();                    // the restyle effect, same commit
  utils.createAttribute(attribute, 0); // first render: allocate + upload
  const before = gpuColours(backend.state.bytes, n);

  // The hover: one dot's transient style changes. Its own colour is unchanged —
  // the overlay carries opacity and pulse, never fill.
  writeColour(HOVERED);
  markAttributeIndicesForUpdate(attribute, [HOVERED], stride);
  utils.updateAttribute(attribute);
  const after = gpuColours(backend.state.bytes, n);

  // The next full upload — any later restyle, or three's own no-range path.
  attribute.needsUpdate = true;
  utils.updateAttribute(attribute);
  const afterNextFullUpload = gpuColours(backend.state.bytes, n);

  return { before, after, afterNextFullUpload };
}

test('a hover leaves every dot the colour it already had', () => {
  // Runs at the stride production allocates, so lowering COLOR_STRIDE fails
  // here and not only in the source guard below.
  const { before, after, afterNextFullUpload } = coloursAroundHover(COLOR_STRIDE);
  assert.deepEqual(before, COLOURS.map((c) => c.map((v) => Number(v.toFixed(2)))));
  assert.deepEqual(after, before);
  assert.deepEqual(afterNextFullUpload, before);
  assert.equal(distinctColours(after), PALETTE.length);
});

test('at stride 3 the same hover shifts every other dot\'s colour', () => {
  // The falsifier for the test above. Every dot but the hovered one slides one
  // slot along the buffer, which is what reads on screen as "all the colours
  // went random at once".
  const { before, after } = coloursAroundHover(3);
  assert.notDeepEqual(after, before);
  // The hovered dot is the one that survives — it was just rewritten.
  assert.deepEqual(after[HOVERED], before[HOVERED]);
  // The field signature Fronx reported: the folder palette stops collapsing.
  // Shifted reads straddle two padded slots, so the distinct-colour count
  // JUMPS past the palette size instead of staying at one-per-folder.
  assert.equal(distinctColours(before), PALETTE.length);
  assert.ok(distinctColours(after) > PALETTE.length);
});

test('colour storage buffers are declared vec4 and read .xyz', () => {
  const dots = readFileSync(join(__dirname, '..', 'src', 'r3f', 'R3FDotsWebGPU.jsx'), 'utf8');
  const density = readFileSync(join(__dirname, '..', 'src', 'r3f', 'densityField.js'), 'utf8');

  assert.equal(COLOR_STRIDE, 4);
  assert.match(dots, /colors: instancedArray\(new Float32Array\(N \* COLOR_STRIDE\), 'vec4'\)/);
  assert.match(dots, /colors: instancedArray\(new Float32Array\(count \* COLOR_STRIDE\), 'vec4'\)/);
  // A vec3 storage attribute anywhere in the renderer reopens the trap.
  assert.doesNotMatch(dots, /'vec3'/);
  assert.doesNotMatch(density, /'vec3'/);
  // Every shader read narrows the vec4 slot back to RGB.
  assert.match(dots, /cosmetic\.colors\.element\(indexNode\)\.xyz/);
  assert.match(dots, /ringBuffers\.colors\.element\(instanceIndex\)\.xyz/);
  assert.match(density, /colors\.element\(instanceIndex\)\.xyz/);
});
