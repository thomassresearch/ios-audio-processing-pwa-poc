import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { configureWasm, makeTaps } from '../src/dsp.js';
const module = await WebAssembly.compile(await fs.readFile('dist/reverb.wasm'));
function engine(rate = 48000) {
  const instance = new WebAssembly.Instance(module); configureWasm(instance, rate);
  const b = instance.exports.memory.buffer;
  return { process: instance.exports.process, l: new Float32Array(b, 0, 512), r: new Float32Array(b, 2048, 512),
    outL: new Float32Array(b, 4096, 512), outR: new Float32Array(b, 6144, 512) };
}
test('WASM dry processing preserves independent stereo and applies gain', () => {
  const e = engine();
  for (let i = 0; i < 128; i++) { e.l[i] = Math.sin(i); e.r[i] = -Math.cos(i); }
  e.process(128, 0, 0.25);
  for (let i = 0; i < 128; i++) { assert.equal(e.outL[i], e.l[i] * .25); assert.equal(e.outR[i], e.r[i] * .25); }
});
test('WASM wet impulse matches the reference sparse FIR across ring wrap without stereo leakage', () => {
  const e = engine(); const { delays, gains } = makeTaps(48000);
  const reference = new Float32Array(100000);
  for (const origin of [0, 65500]) for (let t = 0; t < delays.length; t++) reference[origin + delays[t]] += gains[t];
  for (let start = 0; start < 100000; start += 128) {
    e.l.fill(0); e.r.fill(0);
    for (const origin of [0, 65500]) if (origin >= start && origin < start + 128) e.l[origin - start] = 1;
    e.process(128, 1, 1);
    for (let i = 0; i < 128 && start + i < reference.length; i++) {
      assert.ok(Math.abs(e.outL[i] - reference[start + i]) < 1e-6, `Sample ${start + i}`);
      assert.equal(e.outR[i], 0);
    }
  }
});
test('WASM remains finite and bounded on sustained inputs at common sample rates', () => {
  for (const rate of [44100, 48000, 96000]) {
    const e = engine(rate); e.l.fill(1); e.r.fill(-1);
    for (let n = 0; n < 800; n++) e.process(128, 0.65, 0.5);
    assert.ok(e.outL[127] <= 0.50001 && e.outL[127] >= .49);
    assert.ok(e.outR[127] >= -0.50001 && e.outR[127] <= -.49);
  }
});
const source = (await fs.readFile('src/audio-worklet.js', 'utf8')).replace(/^import .*;\n/, '');
let Processor;
class MockPort { sent = []; postMessage(data) { this.sent.push(data); } }
vm.runInNewContext(source, { AudioWorkletProcessor: class { constructor() { this.port = new MockPort(); } },
  registerProcessor: (_, ctor) => { Processor = ctor; }, WebAssembly, Float32Array, Map, Math, sampleRate: 48000, configureWasm });
function worklet(mode) { return new Processor({ processorOptions: { mode, module, batch: 512, wet: 0, gain: 1 } }); }
function quantum(p, left, right) {
  const result = [[new Float32Array(128), new Float32Array(128)]];
  p.process([[left, ...(right ? [right] : [])]], result); return result[0];
}
test('worklet reports mono before output duplication and clips finite output', () => {
  const p = worklet('wasm'); const l = new Float32Array(128).fill(.2);
  for (let i = 0; i < 80; i++) {
    const [outL, outR] = quantum(p, l);
    assert.ok(Math.abs(outL[0] - .2) < 1e-6); assert.equal(outL[0], outR[0]);
  }
  const stats = p.port.sent.find(s => s.type === 'stats');
  assert.equal(stats.channels, 1); assert.ok(Math.abs(stats.rmsL - .2) < 1e-6);
});
test('GPU worklet bounds outstanding jobs and rejects late results', () => {
  const p = worklet('gpu'); const bridge = { sent: [], postMessage(d) { this.sent.push(d); }, start() {} };
  p.port.onmessage({ data: { type: 'gpu-port', port: bridge } });
  const l = new Float32Array(128).fill(.1);
  for (let i = 0; i < 40; i++) quantum(p, l);
  assert.equal(p.inflight, 3); assert.ok(p.skipped > 0); assert.ok(p.underruns > 0);
  bridge.onmessage({ data: { type: 'processed', start: 0, samples: new Float32Array(1024), elapsed: 1 } });
  assert.equal(p.late, 1); assert.equal(p.pending.size, 0);
});
test('GPU worklet plays returned stereo at its declared three-block deadline', () => {
  const p = worklet('gpu'); const bridge = { postMessage() {}, start() {} };
  p.port.onmessage({ data: { type: 'gpu-port', port: bridge } });
  const l = new Float32Array(128).fill(.1);
  for (let i = 0; i < 4; i++) quantum(p, l);
  const samples = new Float32Array(1024); samples.fill(.25, 0, 512); samples.fill(-.5, 512);
  bridge.onmessage({ data: { type: 'processed', start: 0, samples, elapsed: 1 } });
  for (let i = 0; i < 8; i++) quantum(p, l);
  const [a,b] = quantum(p, l);
  assert.equal(a[0], .25); assert.equal(b[0], -.5); assert.equal(p.underruns, 0);
});

test('mono capture has no invented right input while monitoring remains dual mono', () => {
  const p = worklet('wasm');
  const l = new Float32Array(128).fill(.2);
  for (let i = 0; i < 80; i++) quantum(p, l);
  const stats = p.port.sent.find(s => s.type === 'stats');
  assert.equal(stats.channels, 1); assert.equal(stats.rmsR, 0);
});

test('left-only padded stereo can be centred without changing capture diagnostics', () => {
  const p = worklet('wasm');
  p.port.onmessage({ data: { type: 'params', wet: 0, gain: 1, routing: 'left' } });
  const l = new Float32Array(128).fill(.2), r = new Float32Array(128);
  for (let i = 0; i < 80; i++) {
    const [a,b] = quantum(p,l,r); assert.equal(a[0], b[0]); assert.ok(a[0] > .19);
  }
  const stats = p.port.sent.find(s => s.type === 'stats');
  assert.equal(stats.channels, 2); assert.equal(stats.rmsR, 0);
});

test('native wet AudioParam changes actual worklet output, independently of messages', () => {
  const p = worklet('wasm');
  const l = new Float32Array(128).fill(.2);
  quantum(p,l);
  const output = [[new Float32Array(128),new Float32Array(128)]];
  p.process([[l]], output, { wet: new Float32Array([1]) });
  assert.ok(output[0][0][0] < .19); assert.ok(output[0][0][0] > .17);
  assert.ok(Math.abs(p.wet - .1) < 1e-6);
});
