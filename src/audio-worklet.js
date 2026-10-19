import { configureWasm } from './dsp.js';

class LiveProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions: o }) {
    super();
    this.mode = o.mode;
    this.wet = o.wet;
    this.gain = o.gain;
    this.targetWet = o.wet;
    this.targetGain = o.gain;
    this.frame = 0;
    this.batch = o.batch;
    this.delay = this.batch * 3;
    this.left = new Float32Array(this.batch);
    this.right = new Float32Array(this.batch);
    this.fill = 0;
    this.pending = new Map();
    this.inflight = 0;
    this.underruns = 0;
    this.late = 0;
    this.skipped = 0;
    this.gpuMs = 0;
    this.peak = 0;
    this.clips = 0;
    this.resetMeters();
    if (this.mode === 'wasm') {
      this.wasm = new WebAssembly.Instance(o.module);
      configureWasm(this.wasm, sampleRate);
      this.inL = new Float32Array(this.wasm.exports.memory.buffer, 0, 512);
      this.inR = new Float32Array(this.wasm.exports.memory.buffer, 2048, 512);
      this.outL = new Float32Array(this.wasm.exports.memory.buffer, 4096, 512);
      this.outR = new Float32Array(this.wasm.exports.memory.buffer, 6144, 512);
    }
    this.port.onmessage = ({ data }) => {
      if (data.type === 'params') {
        this.targetWet = data.wet;
        this.targetGain = data.gain;
      }
      if (data.type === 'gpu-port') {
        this.gpu = data.port;
        this.gpu.onmessage = ({ data: block }) => {
          if (block.type === 'error') { this.port.postMessage(block); return; }
          this.inflight = Math.max(0, this.inflight - 1);
          if (block.type === 'dropped') { this.skipped++; return; }
          if (block.type !== 'processed') return;
          const deadline = block.start + this.delay;
          this.gpuMs = block.elapsed;
          if (deadline < this.frame) this.late++;
          else this.pending.set(deadline, block.samples);
        };
        this.gpu.start();
      }
    };
    this.port.postMessage({ type: 'ready' });
  }
  resetMeters() {
    this.ll = 0; this.rr = 0; this.lr = 0; this.diff = 0; this.count = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0].length;
    if (!input?.length) return true;
    const l = input[0];
    const r = input[1] || l;
    // Smooth UI changes over several render quanta to reduce zipper noise.
    this.wet += (this.targetWet - this.wet) * 0.1;
    this.gain += (this.targetGain - this.gain) * 0.1;
    for (let i = 0; i < n; i++) {
      this.ll += l[i] * l[i]; this.rr += r[i] * r[i];
      this.lr += l[i] * r[i]; this.diff += (l[i] - r[i]) ** 2;
    }
    this.count += n;
    if (this.mode === 'wasm') {
      if (n > 512) { this.port.postMessage({ type: 'error', message: 'Unsupported audio render block size.' }); return false; }
      this.inL.set(l); this.inR.set(r);
      this.wasm.exports.process(n, this.wet, this.gain);
      output[0].set(this.outL.subarray(0, n));
      output[1].set(this.outR.subarray(0, n));
    } else {
      this.left.set(l, this.fill); this.right.set(r, this.fill);
      this.fill += n;
      if (this.fill === this.batch) {
        if (this.gpu && this.inflight < 3) {
          this.gpu.postMessage({ type: 'block', start: this.frame + n - this.batch,
            left: this.left, right: this.right, wet: this.wet, gain: this.gain });
          this.inflight++;
        } else this.skipped++;
        this.fill = 0;
      }
      const start = Math.floor(this.frame / this.batch) * this.batch;
      const samples = this.pending.get(start);
      if (samples) {
        const offset = this.frame - start;
        output[0].set(samples.subarray(offset, offset + n));
        output[1].set(samples.subarray(this.batch + offset, this.batch + offset + n));
        if (offset + n === this.batch) this.pending.delete(start);
      } else if (this.frame >= this.delay) this.underruns++;
      // Bounded playback queue, even after a discontinuity.
      for (const key of this.pending.keys()) if (key < start) this.pending.delete(key);
    }
    for (const channel of output) for (let i = 0; i < n; i++) {
      const x = channel[i];
      this.peak = Math.max(this.peak, Math.abs(x));
      if (Math.abs(x) > 1) this.clips++;
      channel[i] = Math.max(-1, Math.min(1, x));
    }
    this.frame += n;
    if (this.count >= sampleRate / 5) {
      this.port.postMessage({ type: 'stats', channels: input.length, renderFrames: n,
        rmsL: Math.sqrt(this.ll / this.count), rmsR: Math.sqrt(this.rr / this.count),
        correlation: this.ll * this.rr > 1e-16 ? this.lr / Math.sqrt(this.ll * this.rr) : null,
        difference: this.ll + this.rr > 1e-16 ? Math.sqrt(this.diff / (this.ll + this.rr)) : null,
        peak: this.peak, clips: this.clips, underruns: this.underruns, late: this.late,
        skipped: this.skipped, gpuMs: this.gpuMs, queue: this.pending.size,
        processedSeconds: this.frame / sampleRate });
      this.peak = 0; this.resetMeters();
    }
    return true;
  }
}
registerProcessor('live-processor', LiveProcessor);
