import { test, expect } from '@playwright/test';

test('mobile layout, PWA cache and navigation work under the Pages subpath', async ({ page, context }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Microphone in. A little space out.' })).toBeVisible();
  await expect(page.locator('#technical')).toContainText('"wasm": true');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  // WebKit's automation offline toggle aborts SW-controlled navigations internally.
  // Verify its installed cache directly; exercise a real offline reload in Chromium.
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names.find(name => name.startsWith('audio-lab-')));
    return Promise.all(['index.html', 'reverb.wasm', 'src/audio-worklet.js', 'src/gpu-worker.js'].map(async asset => !!(await cache.match(new URL(asset, location.href)))));
  });
  expect(cached).toEqual([true, true, true, true]);
  if (info.project.name === 'chromium') {
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#start')).toBeVisible();
    expect(await page.evaluate(async () => (await fetch('./reverb.wasm')).ok)).toBeTruthy();
    await context.setOffline(false);
  } else {
    await page.reload();
    await expect(page.locator('#start')).toBeVisible();
  }
  await page.screenshot({ path: `test-results/${info.project.name}-app.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test('WASM microphone monitoring, diagnostics and stop/restart', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Fake microphone integration uses Chromium; iOS hardware must be tested manually.');
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('./');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening', { timeout: 20000 });
  await expect(page.locator('#actual-channels')).toHaveText(/\d ch/);
  await expect(page.locator('#active-engine')).toHaveText('WASM / CPU');
  await expect(page.locator('#quantum')).toContainText('128');
  await page.locator('#wet').fill('80');
  await expect(page.locator('#wet-value')).toHaveText('80%');
  await page.locator('#stop').click();
  await expect(page.locator('#status')).toHaveText('Stopped');
  await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening');
  await page.locator('#stop').click();
  expect(errors).toEqual([]);
});

test('denied microphone is recoverable and never leaves the UI stuck', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium');
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await page.goto('./'); await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Error');
  await expect(page.locator('#message')).toContainText('Microphone access was denied');
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#engine')).toBeEnabled();
});

test('WebGPU executes the reverb shader and returns audio blocks', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium');
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('./');
  await page.locator('#engine').selectOption('gpu');
  await page.locator('#batch').selectOption('2048');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening', { timeout: 30000 });
  await expect(page.locator('#active-engine')).toHaveText('WEBGPU / GPU');
  await expect(page.locator('#technical')).toContainText('"processedSeconds"');
  await expect.poll(async () => parseFloat(await page.locator('#gpu-time').textContent())).toBeGreaterThan(0);
  await page.locator('#stop').click();
  expect(errors).toEqual([]);
});

test('actual GPU impulse response matches the WASM tap definition', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium');
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { makeTaps } = await import('./src/dsp.js');
    const { delays, gains } = makeTaps(48000);
    const worker = new Worker(new URL('./src/gpu-worker.js', location.href), { type: 'module' });
    const channel = new MessageChannel();
    try {
      const ready = new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => data.type === 'ready' ? resolve() : reject(new Error(data.message));
        worker.onerror = reject;
      });
      worker.postMessage({ type: 'init', rate: 48000, frames: 2048, port: channel.port2 }, [channel.port2]);
      await ready;
      let maxError = 0;
      let nonzero = 0;
      for (let start = 0; start < 30000; start += 2048) {
        const left = new Float32Array(2048); const right = new Float32Array(2048);
        if (start === 0) left[0] = 1;
        const response = new Promise((resolve, reject) => {
          channel.port1.onmessage = ({ data }) => data.type === 'processed' ? resolve(data.samples) : reject(new Error(data.message || 'GPU job dropped'));
        });
        channel.port1.postMessage({ type: 'block', start, left, right, wet: 1, gain: 1 });
        const samples = await response;
        for (let i = 0; i < 2048; i++) {
          let expected = 0;
          for (let t = 0; t < delays.length; t++) if (delays[t] === start + i) expected += gains[t];
          maxError = Math.max(maxError, Math.abs(samples[i] - expected), Math.abs(samples[2048 + i]));
          if (samples[i] !== 0) nonzero++;
        }
      }
      return { maxError, nonzero };
    } finally { channel.port1.close(); worker.terminate(); }
  });
  expect(result.maxError).toBeLessThan(1e-6);
  expect(result.nonzero).toBe(32);
});
