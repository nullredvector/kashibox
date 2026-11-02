'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MODES, buildGraph } = require('../genvideo.js');

// every link in the graph must point to a node that exists
function links(g) {
  for (const [id, n] of Object.entries(g)) {
    for (const v of Object.values(n.inputs)) {
      if (Array.isArray(v)) assert.ok(g[v[0]], `${id} links to missing ${v[0]}`);
    }
  }
}

test('every mode builds a connected graph that saves a video', () => {
  for (const m of MODES) {
    const g = buildGraph(m, 'in.mp4', { prompt: 'x', seed: 1, sourceFrames: 95 });
    links(g);
    assert.strictEqual(g.save.class_type, 'VHS_VideoCombine');
  }
});

test('sizes snap to 32 and frame counts to 8k+1', () => {
  const g = buildGraph('i2v', 'in.png', { width: 500, height: 800, frames: 50 });
  assert.strictEqual(g.start.inputs.width, 512);
  assert.strictEqual(g.start.inputs.height, 800);
  assert.strictEqual(g.start.inputs.length, 49);
});

test('extend keeps the last frames of the source and crops the guide before decoding', () => {
  const g = buildGraph('extend', 'in.mp4', { sourceFrames: 100, guideFrames: 9 });
  assert.strictEqual(g.tail.inputs.batch_index, 91);
  assert.strictEqual(g.tail.inputs.length, 9);
  assert.deepStrictEqual(g.decode.inputs.samples, ['crop', 2]);
});

test('unknown mode is rejected', () => {
  assert.throws(() => buildGraph('nope', 'x'));
});

test('LTX 2.3 graphs are connected, carry sound and use the distilled schedule', () => {
  for (const m of MODES) {
    const g = buildGraph(m, 'in.mp4', { model: 'ltx23', prompt: 'x', seed: 1, sourceFrames: 95, frames: 49 });
    links(g);
    assert.strictEqual(g.save.class_type, 'VHS_VideoCombine');
    assert.deepStrictEqual(g.save.inputs.audio, ['sound', 0]);
    assert.strictEqual(g.unet.class_type, 'UnetLoaderGGUF');
  }
});

test('LTX 2.3 restyle starts lower down the schedule when it changes less', () => {
  const sig = (d) => buildGraph('restyle', 'in.mp4', { model: 'ltx23', denoise: d, frames: 49 }).sigmas.inputs.sigmas.split(', ').map(Number);
  assert.strictEqual(sig(0.6)[0], 0.6);
  assert.ok(sig(0.6).length < sig(0.9).length);
  assert.strictEqual(sig(0.6).at(-1), 0);
});

test('LTX 2.3 extend keeps the last frames and crops the guide', () => {
  const g = buildGraph('extend', 'in.mp4', { model: 'ltx23', sourceFrames: 100, guideFrames: 9 });
  assert.strictEqual(g.tail.inputs.batch_index, 91);
  assert.deepStrictEqual(g.decode.inputs.samples, ['crop', 2]);
});
