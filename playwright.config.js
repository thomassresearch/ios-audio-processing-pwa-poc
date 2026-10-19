import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 45000, workers: 1,
  use: { baseURL: 'http://localhost:4173/ios-audio-processing-pwa-poc/', trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/serve.mjs', port: 4173, reuseExistingServer: !process.env.CI },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], permissions: ['microphone'], launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
    } } },
    { name: 'webkit-mobile', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
});
