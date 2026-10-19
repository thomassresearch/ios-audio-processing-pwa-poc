const $ = id => document.getElementById(id);
const base = new URL('../', import.meta.url);
const capabilities = {
  secureContext: isSecureContext,
  microphone: !!navigator.mediaDevices?.getUserMedia,
  audioWorklet: !!window.AudioWorkletNode,
  wasm: typeof WebAssembly !== 'undefined',
  webGPU: !!navigator.gpu,
  audioSession: !!navigator.audioSession,
  supportedConstraints: navigator.mediaDevices?.getSupportedConstraints() || {},
  standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
};
let session = null, starting = false, generation = 0, lastReport = { capabilities }, updateWaiting = false;
const events = [];
function log(message) {
  events.push({ time: new Date().toISOString(), message });
  if (events.length > 40) events.shift();
  renderReport();
}
function renderReport() { $('technical').textContent = JSON.stringify({ ...lastReport, events }, null, 2); }
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function status(text, kind = '') { $('status').textContent = text; $('status').className = `status ${kind}`; }
function controls() {
  $('start').disabled = starting || !!session;
  $('stop').disabled = !starting && !session;
  $('mute').disabled = !session?.monitorGain;
  $('test-tone').disabled = !session?.node || !!session?.testSource;
  for (const id of ['engine', 'device', 'channels', 'batch']) $(id).disabled = starting || !!session;
}
function timeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out. Stop and retry.`)), ms); })]).finally(() => clearTimeout(timer));
}
function waitReady(target, label) {
  return timeout(new Promise((resolve, reject) => {
    const onMessage = ({ data }) => {
      if (!['ready', 'error'].includes(data.type)) return;
      target.removeEventListener('message', onMessage);
      data.type === 'ready' ? resolve() : reject(new Error(data.message));
    };
    target.addEventListener('message', onMessage);
    target.addEventListener('error', e => reject(new Error(e.message || `${label} failed`)), { once: true });
    target.start?.();
  }), 20000, label);
}
async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const chosen = $('device').value;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  $('device').replaceChildren(new Option('System default microphone', ''));
  for (const [i, d] of devices.entries()) if (d.deviceId) $('device').add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId));
  if (devices.some(d => d.deviceId === chosen)) $('device').value = chosen;
}
function params() { return { type: 'params', wet: +$('wet').value / 100, gain: 1, routing: $('routing').value }; }
function applyControls() {
  for (const id of ['wet', 'gain']) $(`${id}-value`).value = `${$(id).value}%`;
  const s = session;
  if (!s?.node || !s.monitorGain) return;
  const time = s.context.currentTime;
  const wet = s.node.parameters.get('wet');
  wet.cancelScheduledValues(time);
  wet.setTargetAtTime(+$('wet').value / 100, time, 0.01);
  const level = s.monitorGain.gain;
  level.cancelScheduledValues(time);
  level.setTargetAtTime(s.muted ? 0 : +$('gain').value / 100, time, 0.01);
  s.node.port.postMessage(params());
}
for (const id of ['wet', 'gain', 'routing']) for (const event of ['input', 'change']) $(id).addEventListener(event, applyControls);
$('mute').addEventListener('click', () => {
  if (!session) return;
  session.muted = !session.muted;
  $('mute').textContent = session.muted ? 'Unmute output' : 'Mute output';
  $('mute').setAttribute('aria-pressed', String(session.muted));
  applyControls();
});
$('test-tone').addEventListener('click', () => {
  const s = session;
  if (!s?.source || s.testSource) return;
  // Replace the microphone with repeatable short chimes through the SAME DSP/output chain.
  const rate = s.context.sampleRate;
  const buffer = s.context.createBuffer(1, Math.round(rate * 2.5), rate);
  const samples = buffer.getChannelData(0);
  for (const time of [0, 0.75, 1.5]) for (let n = 0; n < rate * 0.06; n++) {
    const t = n / rate;
    samples[Math.round(time * rate) + n] = 0.5 * Math.sin(2 * Math.PI * 660 * t) * Math.sin(Math.PI * t / 0.06) ** 2;
  }
  const source = s.context.createBufferSource(); source.buffer = buffer;
  s.source.disconnect(); source.connect(s.node); s.testSource = source;
  $('test-tone').textContent = 'Test chimes playing…'; controls();
  source.onended = () => {
    source.disconnect();
    if (session !== s) return;
    s.testSource = null; s.source.connect(s.node);
    $('test-tone').textContent = 'Play test chimes'; controls();
  };
  source.start();
});
$('engine').addEventListener('change', () => { $('batch-label').hidden = $('engine').value !== 'gpu'; });

async function start() {
  if (starting || session) return;
  if (!capabilities.secureContext || !capabilities.microphone || !capabilities.audioWorklet || !capabilities.wasm) {
    status('Unsupported', 'error'); message('This app needs HTTPS, microphone access, AudioWorklet and WebAssembly. Open it in a current Safari version.', true); return;
  }
  const id = ++generation;
  starting = true;
  controls();
  status('Starting…');
  const mode = $('engine').value;
  const batch = +$('batch').value;
  const s = { mode, batch, started: new Date().toISOString() };
  session = s;
  lastReport = { capabilities, mode, started: s.started };
  try {
    // Resume during the original click, before awaiting permission or module loading.
    if (navigator.audioSession) { s.previousAudioSession = navigator.audioSession.type; navigator.audioSession.type = 'play-and-record'; }
    s.context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    await s.context.resume();
    if (id !== generation) return;
    const request = {
      channelCount: $('channels').value === 'strict' ? { exact: 2 } : { ideal: 2 },
      sampleRate: { ideal: 48000 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      ...($('device').value ? { deviceId: { exact: $('device').value } } : {}),
    };
    lastReport.request = request;
    message('Waiting for microphone permission…');
    // Permission dialogs may legitimately take a long time. Stop cancels this generation.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: request, video: false });
    if (id !== generation) { stream.getTracks().forEach(t => t.stop()); return; }
    s.stream = stream;
    const track = stream.getAudioTracks()[0];
    s.track = track;
    lastReport.track = { label: track.label, settings: track.getSettings(), capabilities: track.getCapabilities?.() || {} };
    $('track-channels').textContent = track.getSettings().channelCount ? `${track.getSettings().channelCount} ch` : 'Not reported';
    track.addEventListener('ended', () => { if (session === s) stop('Microphone disconnected. Choose an input and restart.'); });
    track.addEventListener('mute', () => log('Microphone muted by browser or OS.'));
    track.addEventListener('unmute', () => log('Microphone unmuted.'));
    await listDevices();
    message('Preparing the audio engine…');
    await s.context.audioWorklet.addModule(new URL('src/audio-worklet.js', base));
    if (id !== generation) return;
    let module;
    if (mode === 'wasm') {
      const response = await fetch(new URL('reverb.wasm', base));
      if (!response.ok) throw new Error(`WASM download failed (${response.status}).`);
      module = await WebAssembly.compile(await response.arrayBuffer());
      if (id !== generation) return;
    }
    s.node = new AudioWorkletNode(s.context, 'live-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'max', channelInterpretation: 'discrete',
      parameterData: { wet: +$('wet').value / 100 },
      processorOptions: { mode, module, batch, ...params() },
    });
    const nodeReady = waitReady(s.node.port, 'Audio processor');
    s.node.onprocessorerror = () => { if (session === s) stop('Audio processor failed. Stop and restart.', true); };
    s.node.port.addEventListener('message', ({ data }) => {
      if (session !== s) return;
      if (data.type === 'stats') showStats(data, s);
      if (data.type === 'error') stop(data.message, true);
    });
    await nodeReady;
    if (id !== generation) return;
    if (mode === 'gpu') {
      s.worker = new Worker(new URL('src/gpu-worker.js', base), { type: 'module' });
      const ready = waitReady(s.worker, 'WebGPU initialization');
      s.worker.addEventListener('message', ({ data }) => { if (data.type === 'error' && session === s) stop(data.message, true); });
      s.worker.addEventListener('error', event => { if (session === s) stop(event.message || 'GPU worker failed.', true); });
      const bridge = new MessageChannel();
      s.node.port.postMessage({ type: 'gpu-port', port: bridge.port1 }, [bridge.port1]);
      s.worker.postMessage({ type: 'init', rate: s.context.sampleRate, frames: batch, port: bridge.port2 }, [bridge.port2]);
      await ready;
      if (id !== generation) return;
    }
    s.source = s.context.createMediaStreamSource(stream);
    s.source.channelInterpretation = 'discrete';
    s.source.connect(s.node);
    // Native final gain guarantees the level/mute affect both DSP engines.
    s.monitorGain = s.context.createGain();
    s.monitorGain.gain.value = +$('gain').value / 100;
    s.analyser = s.context.createAnalyser(); s.analyser.fftSize = 2048;
    s.outputSamples = new Float32Array(s.analyser.fftSize);
    s.node.connect(s.monitorGain); s.monitorGain.connect(s.analyser);
    s.analyser.connect(s.context.destination);
    applyControls();
    s.context.onstatechange = () => {
      if (session !== s) return;
      log(`Audio context: ${s.context.state}`);
      $('resume').hidden = s.context.state === 'running';
      status(s.context.state === 'running' ? 'Listening' : 'Interrupted', s.context.state === 'running' ? 'live' : '');
    };
    await s.context.resume();
    if (id !== generation) return;
    $('active-engine').textContent = mode === 'wasm' ? 'WASM / CPU' : 'WEBGPU / GPU';
    $('rate').textContent = `${s.context.sampleRate.toLocaleString()} Hz`;
    $('buffer').textContent = mode === 'wasm' ? '0 extra frames' : `${(batch * 3 / s.context.sampleRate * 1000).toFixed(1)} ms`;
    $('gpu-time').textContent = mode === 'wasm' ? 'Not used' : 'Waiting…';
    $('base-latency').textContent = latency(s.context.baseLatency);
    $('output-latency').textContent = latency(s.context.outputLatency);
    status('Listening', 'live');
    message(mode === 'wasm' ? 'WASM reverb is running in the audio thread. Move the sound source to explore the input channels.' : 'WebGPU reverb is running in a worker with three blocks of output delay. Watch the missed-deadline counters.');
    lastReport.audio = { sampleRate: s.context.sampleRate, baseLatency: s.context.baseLatency,
      outputLatency: s.context.outputLatency, addedBufferFrames: mode === 'gpu' ? batch * 3 : 0, outputRoute: 'System managed; not verifiable' };
    log(`${mode.toUpperCase()} session started`);
    s.wake = await navigator.wakeLock?.request('screen').catch(() => null);
    if (id !== generation) await s.wake?.release();
  } catch (error) {
    if (id !== generation) return;
    const explanation = error.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in Safari website settings, then retry.'
      : error.name === 'OverconstrainedError' ? `The microphone cannot meet ${error.constraint || 'the requested constraints'}. Try “Prefer stereo” or a different input.`
      : error.message;
    await stop(explanation, true);
  } finally { if (id === generation) { starting = false; controls(); } }
}
async function stop(reason = 'Session stopped. You can change the engine or microphone and restart.', error = false) {
  ++generation;
  starting = false;
  const s = session;
  session = null;
  if (s?.testSource) { s.testSource.onended = null; s.testSource.stop(); s.testSource.disconnect(); }
  s?.source?.disconnect();
  s?.monitorGain?.disconnect(); s?.analyser?.disconnect();
  s?.node?.disconnect();
  s?.worker?.terminate();
  s?.stream?.getTracks().forEach(t => t.stop());
  s?.wake?.release().catch(() => {});
  if (s?.context) { s.context.onstatechange = null; await s.context.close().catch(() => {}); }
  if (navigator.audioSession && s?.previousAudioSession != null) navigator.audioSession.type = s.previousAudioSession;
  $('resume').hidden = true;
  $('mute').textContent = 'Mute output'; $('mute').setAttribute('aria-pressed', 'false');
  $('test-tone').textContent = 'Play test chimes';
  $('meter-out').value = 0; $('db-out').textContent = '−∞ dBFS';
  $('meter-l').value = 0; $('meter-r').value = 0;
  status(error ? 'Error' : 'Stopped', error ? 'error' : '');
  message(reason + (updateWaiting ? ' An update is ready; close all app windows and reopen to load it.' : ''), error);
  log(reason);
  controls();
}
const latency = seconds => Number.isFinite(seconds) && seconds > 0 ? `${(seconds * 1000).toFixed(1)} ms` : 'Not reported';
const db = x => x > 0.000001 ? `${(20 * Math.log10(x)).toFixed(1)} dBFS` : '−∞ dBFS';
function showStats(data, s) {
  let outputRms = 0;
  if (s.analyser) {
    s.analyser.getFloatTimeDomainData(s.outputSamples);
    for (const x of s.outputSamples) outputRms += x * x;
    outputRms = Math.sqrt(outputRms / s.outputSamples.length);
  }
  lastReport.latestStats = { ...data, outputRms, outputGain: s.monitorGain?.gain.value, muted: !!s.muted,
    inputSource: s.testSource ? 'test chimes' : 'microphone' };
  $('meter-out').value = Math.min(1, outputRms * 4); $('db-out').textContent = db(outputRms);
  $('applied-wet').textContent = `${Math.round(data.wet * 100)}%`;
  $('applied-gain').textContent = `${Math.round((s.monitorGain?.gain.value || 0) * 100)}%`;
  $('input-source').textContent = s.testSource ? 'TEST CHIMES · MIC TEMPORARILY REPLACED' : 'BEFORE THE EFFECT';
  $('meter-l').value = Math.min(1, data.rmsL * 4); $('meter-r').value = Math.min(1, data.rmsR * 4);
  $('db-l').textContent = db(data.rmsL); $('db-r').textContent = data.channels > 1 ? db(data.rmsR) : 'Mono input';
  $('actual-channels').textContent = `${data.channels} ch`;
  $('correlation').textContent = data.channels < 2 || data.correlation === null ? '—' : data.correlation.toFixed(5);
  $('difference').textContent = data.channels < 2 || data.difference === null ? '—' : data.difference.toFixed(5);
  $('stereo').textContent = data.channels < 2 ? 'Mono capture. iOS supplied one channel; output is duplicated to both ears.'
    : data.rmsL < 0.0001 && data.rmsR < 0.0001 ? 'Two channels delivered. Make a sound to check whether they differ.'
    : data.rmsR < 0.0001 && data.rmsL >= 0.0001 ? 'Two channels supplied, but only the left carries a signal. This does not establish stereo capture. Select Left input → both ears to centre monitoring.'
    : data.rmsL < 0.0001 && data.rmsR >= 0.0001 ? 'Two channels supplied, but only the right carries a signal. Select Right input → both ears to centre monitoring.'
    : data.difference < 0.0001 ? 'Two channels delivered, but samples are effectively identical. This may be duplicated mono.'
    : 'Two active, differing input channels detected. Move a sound around the phone to investigate the stereo image.';
  if (s.testSource) $('stereo').textContent = 'Test chimes are replacing the microphone input. Compare 0% and 100% reverb, and try Mute output.';
  $('quantum').textContent = `${data.renderFrames} / ${(data.renderFrames / s.context.sampleRate * 1000).toFixed(2)} ms`;
  $('gpu-time').textContent = s.mode === 'gpu' ? `${data.gpuMs.toFixed(2)} ms` : 'Not used';
  $('underruns').textContent = data.underruns;
  $('late').textContent = `${data.late} / ${data.skipped}`;
  renderReport();
}
$('start').addEventListener('click', start);
$('stop').addEventListener('click', () => stop());
$('resume').addEventListener('click', async () => {
  try { await session?.context.resume(); } catch (error) { message(error.message, true); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && (session || starting)) stop('Stopped because the app left the foreground. Tap Start to continue.'); });
window.addEventListener('pagehide', () => { if (session || starting) stop('Session closed.'); });
navigator.mediaDevices?.addEventListener('devicechange', () => {
  log('Audio devices changed. Check the system output route and selected microphone.');
  listDevices().catch(e => log(e.message));
});
$('report').addEventListener('click', () => {
  const report = { ...lastReport, exported: new Date().toISOString(), userAgent: navigator.userAgent, events,
    privacy: 'No audio samples are recorded or included; device identifiers are removed.' };
  const json = JSON.stringify(report, (key, value) => ['deviceId', 'groupId'].includes(key) ? '[redacted]' : value, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `audio-lab-${Date.now()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});
renderReport();
listDevices().catch(e => log(e.message));
fetch(new URL('version.json', base)).then(r => r.json()).then(v => { $('version').textContent = `Audio Lab · ${v.version}`; }).catch(() => {});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname, updateViaCache: 'none' }).then(registration => {
    if (registration.waiting) { updateWaiting = true; log('Update ready. Close all app windows and reopen after stopping.'); }
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) { updateWaiting = true; log('Update downloaded. Close all app windows and reopen to activate.'); }
      });
    });
  }).catch(error => log(`Offline cache unavailable: ${error.message}`));
}
