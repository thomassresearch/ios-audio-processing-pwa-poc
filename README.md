# Audio Lab · iOS microphone PWA PoC

A static, installable PWA that captures microphone audio, diagnoses the stream's channel layout, applies a room reverb and monitors it through the system audio output. No audio is sent to a server or recorded.

**Published URL:** https://thomassresearch.github.io/ios-audio-processing-pwa-poc/

## Run on iPhone

1. Open the published HTTPS URL in Safari. Optionally use **Share → Add to Home Screen**.
2. Connect earphones and start at low volume. Wired or USB earphones give a better latency baseline than Bluetooth.
3. Select **WASM**, tap **Start listening**, and allow microphone access.
4. Check the microphone selector after granting permission. iOS can switch to a headset microphone when a headset is attached. Select the built-in microphone if Safari exposes it. Stop before changing input or engine.
5. Move a sound around the phone. Compare the reported track channel count, the actual channel count entering the audio thread, input RMS levels, L/R correlation and normalized L/R difference.
6. Try **Require exactly 2 channels**. An unsupported exact request produces a visible error; choose **Prefer stereo** to allow mono.
7. Stop, select **WebGPU**, and start again. Compare the added DSP buffer, compute/readback duration and missed deadlines.

The UI does **not** assume stereo because the phone has several microphones. Stereo constraints can be ignored or rejected; iOS may expose only one processed stream. Two channels can contain identical mono samples. Even differing channels cannot prove a mapping to particular physical microphones. With mono input, the measured input remains mono, then the processed signal is duplicated to both output channels.

## Processing architecture

| Mode | DSP | Audio transport | Extra application buffering |
| --- | --- | --- | --- |
| WASM (default) | Compiled WebAssembly sparse FIR reverb on CPU | Directly inside `AudioWorkletProcessor` | No extra block buffer beyond the browser render quantum |
| WebGPU (experimental) | Same FIR reverb in a WGSL compute shader | AudioWorklet → dedicated Worker via MessagePort → GPU → CPU readback → AudioWorklet | 3 × selected block size; 32 / 64 / 128 ms at 48 kHz |

**WASM does not itself execute on the GPU.** WebGPU is the browser GPU interface; the actual GPU DSP is a WGSL shader. The CPU path is real WASM generated from `dsp/reverb.wat`, not a JavaScript approximation. Both paths evaluate the same 32-tap, exponentially decaying, ~563 ms sparse room impulse response independently for each channel. This is a deliberately simple audible effect, not a production reverb or source separation model.

The audio context requests 48 kHz and interactive latency; actual rate is reported. The audio thread uses the input's actual channel count (`channelCountMode: max`, `channelInterpretation: discrete`) before any output duplication. AGC, noise suppression and echo cancellation are requested off, and actual track settings/capabilities are included in diagnostics where exposed. Browser/OS processing cannot be assumed to be bypassed.

The GPU worker owns its adapter/device, persistent history and storage buffers, compute pipeline and readback buffer. Audio uses ordinary MessagePorts, so no COOP/COEP headers or SharedArrayBuffer are required on GitHub Pages. The audio thread never waits for the GPU. It has a fixed playback timeline, bounds outstanding jobs, drops late results, counts missed output render quanta, and outputs silence for missed GPU blocks. Startup preroll is not counted as an underrun. Changing mix/level is smoothed per render quantum. Output is clamped to [-1, 1].

A small FIR can be faster and have less latency in WASM than on the GPU. GPU submission, messages and readback have overhead. The PoC measures whether the GPU path meets its deadlines; it does not claim GPU acceleration always helps. GPU failures are shown explicitly; stop and select WASM rather than silently switching engines.

## iOS constraints and interpretation

- Safari 26 introduced WebGPU on iOS; availability is tested again inside the dedicated Worker at runtime. WASM + AudioWorklet is the compatibility path.
- Output follows the iOS route; select earphones using Control Center. A web app cannot reliably force a particular physical input/output pairing or verify the active earphone route. Bluetooth duplex capture may select a lower quality headset profile.
- `navigator.audioSession.type = 'play-and-record'` is set when supported, and the AudioContext is resumed from the Start button gesture. The old session type is restored on Stop.
- Browser `baseLatency` and `outputLatency` are partial reports and can be missing or zero. The app labels unavailable values. GPU time includes submit/readback. None of these is an acoustic measurement of microphone-to-ear latency. Capture, routing and Bluetooth latency are additional.
- The app deliberately stops when hidden or on page exit; uninterrupted background capture and screen-lock operation are not promised. It requests a screen wake lock when supported. Calls and route changes can interrupt audio; Resume or Stop/Start may be necessary.
- Connect earphones to avoid acoustic feedback. Keep initial volume low.
- For a real latency test, record an external transient and the earphone output simultaneously using a second recording device; measure their time offset. Repeat with 0% reverb to separate transport latency from the intended wet effect delays.

**Download diagnostics** exports capabilities, selected settings, recent processing statistics and events. It contains no audio samples. Device/group IDs are redacted; microphone labels and the browser user agent remain in the report.

## Develop and verify

Requires Node 24 (Node 22 also works locally). No runtime npm/CDN dependencies.

```sh
npm ci
npm test                       # build WASM and static site; DSP / scheduling tests
npx playwright install --with-deps chromium webkit
npm run test:browser            # Chromium fake mic + real shader; mobile WebKit shell/cache
npm run dev                    # http://localhost:4173/ios-audio-processing-pwa-poc/
```

Localhost is a secure context on the development computer. Opening a plain HTTP LAN IP on an iPhone is not; use HTTPS or the deployed Pages site.

Tests cover WASM dry gain, independent channels, reference wet impulse response through history wrap, bounded output at several sample rates, mono diagnostics before duplication, fixed GPU playback deadlines, late-result rejection and bounded in-flight jobs. Browser tests cover static hosting under the repository subpath, offline service-worker caching, capture lifecycle, permission denial and actual WebGPU shader dispatch/readback on Chromium's software GPU. Linux WebKit with an iPhone viewport checks the shell, responsive layout, cache installation and reload. Its automation offline toggle aborts service-worker navigation with an internal WebKit error, so actual offline reload is exercised in Chromium. This does not replace physical iPhone testing.

## Publish a release

In repository **Settings → Pages → Build and deployment**, set **Source = GitHub Actions** once. If the `github-pages` environment restricts deployment refs, allow release tags as well.

Every pushed tag triggers `.github/workflows/deploy.yml` (all tag names are accepted). The workflow runs DSP and browser checks, uploads `dist`, then deploys with GitHub's official Pages actions. Main-branch pushes and PRs run CI without deploying. A manual deployment can also be started from the Actions tab.

```sh
git add .
git commit -m 'Describe your changes'
git push origin main
git tag v0.2.0
git push origin v0.2.0
```

The shell uses relative URLs throughout, including worker modules, WASM, the manifest and service worker, so it works under the repository's Pages subpath. A release cache is identified by package version + commit SHA. Updates wait for existing app windows to close, avoiding a forced reload during a live session; close all Safari/PWA windows for this app and reopen to activate a new release. The shell and DSP assets work offline after the first successful cache installation; microphone permission is still controlled by the browser.

## Main files

- `src/main.js`: capture lifecycle, UI, diagnostics and iOS session handling.
- `src/audio-worklet.js`: realtime WASM processing, channel analysis and GPU playback scheduling.
- `src/gpu-worker.js`: WebGPU setup, compute dispatch and readback.
- `src/dsp.js`: shared impulse response and WGSL shader.
- `dsp/reverb.wat`: WASM CPU DSP implementation.
- `scripts/build.mjs`: deterministic WAT compilation and static asset packaging.

## API references

- [WebKit: Safari 26 and WebGPU](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
- [WebGPU specification](https://www.w3.org/TR/webgpu/)
- [Media capture channel count](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/channelCount)
- [AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)
