import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 18100);

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: {
    command: 'node ../server/dist/server.mjs',
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT), DATA_DIR: '../test-results/server-data' },
  },
});
