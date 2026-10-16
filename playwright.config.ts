import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'apps/web/e2e', timeout: 60000, workers: 1,
  globalSetup: './scripts/browser-fixture.mjs',
  use: { baseURL: process.env.LOCHO_DEPLOY_URL ?? 'http://127.0.0.1:4173', ignoreHTTPSErrors: process.env.LOCHO_LOCAL_TLS_TEST === '1', trace: 'off', screenshot: 'off', video: 'off' },
  webServer: process.env.LOCHO_DEPLOY_URL ? undefined : { command: 'npx vite preview apps/web --host 127.0.0.1 --port 4173 --strictPort', url: 'http://127.0.0.1:4173', reuseExistingServer: false },
  projects: [
    { name: 'chromium', use: devices['Desktop Chrome'] },
    { name: 'firefox', use: devices['Desktop Firefox'] },
    { name: 'webkit', use: devices['Desktop Safari'] },
  ],
});
