export const TAPS = 32;
export const HISTORY = 65536;
export function makeTaps(rate) {
  const delays = new Uint32Array(TAPS);
  const gains = new Float32Array(TAPS);
  let norm = 0;
  for (let t = 0; t < TAPS; t++) {
    const seconds = 0.013 + (t / (TAPS - 1)) ** 1.35 * 0.55;
    delays[t] = Math.min(HISTORY - 1, Math.round(seconds * rate));
    gains[t] = Math.exp(-seconds * 5);
    norm += gains[t];
  }
  for (let t = 0; t < TAPS; t++) gains[t] /= norm;
  return { delays, gains };
}
export function configureWasm(instance, rate) {
  const { delays, gains } = makeTaps(rate);
  new Uint32Array(instance.exports.memory.buffer, 8192, TAPS).set(delays);
  new Float32Array(instance.exports.memory.buffer, 8320, TAPS).set(gains);
}

// The WASM and GPU backends evaluate the same sparse room impulse response.
export const shader = `
struct Params { start: u32, frames: u32, wet: f32, gain: f32 };
@group(0) @binding(0) var<storage, read> history: array<f32>;
@group(0) @binding(1) var<storage, read> delays: array<u32>;
@group(0) @binding(2) var<storage, read> gains: array<f32>;
@group(0) @binding(3) var<storage, read_write> result: array<f32>;
@group(0) @binding(4) var<uniform> p: Params;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = id.x;
  if (n >= p.frames * 2u) { return; }
  let channel = n / p.frames;
  let pos = (p.start + n % p.frames) & 65535u;
  let base = channel * 65536u;
  var value = 0.0;
  for (var t = 0u; t < 32u; t++) {
    value += history[base + ((pos + 65536u - delays[t]) & 65535u)] * gains[t];
  }
  result[n] = p.gain * ((1.0 - p.wet) * history[base + pos] + p.wet * value);
}`;
