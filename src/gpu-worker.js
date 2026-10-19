import { HISTORY, makeTaps, shader } from './dsp.js';

let device, pipeline, history, params, output, readback, bindGroup, port, frames;
let busy = false;
const fail = (error) => {
  const message = error?.message || String(error);
  self.postMessage({ type: 'error', message });
  port?.postMessage({ type: 'error', message });
};
self.onmessage = async ({ data }) => {
  if (data.type !== 'init') return;
  try {
    if (!self.navigator.gpu) throw new Error('WebGPU is unavailable in this browser worker. Choose WASM.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available. Choose WASM.');
    device = await adapter.requestDevice();
    device.lost.then(info => fail(new Error(`GPU device lost: ${info.message}. Stop and restart with WASM.`)));
    device.addEventListener('uncapturederror', event => fail(event.error));
    frames = data.frames;
    const buffer = (size, usage) => device.createBuffer({ size, usage });
    history = buffer(HISTORY * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const taps = makeTaps(data.rate);
    const delays = buffer(taps.delays.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const gains = buffer(taps.gains.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(delays, 0, taps.delays);
    device.queue.writeBuffer(gains, 0, taps.gains);
    output = buffer(frames * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    readback = buffer(frames * 8, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    params = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const module = device.createShaderModule({ code: shader });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(m => m.type === 'error');
    if (errors.length) throw new Error(errors.map(m => m.message).join('; '));
    pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries:
      [history, delays, gains, output, params].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    port = data.port;
    port.onmessage = event => processBlock(event.data).catch(fail);
    port.start();
    self.postMessage({ type: 'ready' });
  } catch (error) { fail(error); }
};
async function processBlock(data) {
  if (data.type !== 'block') return;
  // Preserve input history even when a render job must be skipped. Writes are queue-ordered.
  const pos = data.start & (HISTORY - 1);
  device.queue.writeBuffer(history, pos * 4, data.left);
  device.queue.writeBuffer(history, (HISTORY + pos) * 4, data.right);
  // No accumulating promises/queues: missed deadlines remain visible in the worklet.
  if (busy) { port.postMessage({ type: 'dropped', start: data.start }); return; }
  busy = true;
  const begin = performance.now();
  try {
    // All supported block sizes divide HISTORY, so uploads never wrap.
    const bytes = new ArrayBuffer(16);
    new Uint32Array(bytes).set([pos, frames]);
    new Float32Array(bytes).set([data.wet, data.gain], 2);
    device.queue.writeBuffer(params, 0, bytes);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(frames * 2 / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, frames * 8);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const samples = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    port.postMessage({ type: 'processed', start: data.start, samples, elapsed: performance.now() - begin }, [samples.buffer]);
  } finally { busy = false; }
}
