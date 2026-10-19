/** Playwright config for regenerating docs/images (see screenshots.ts). Not part of the test suite. */
import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

export default defineConfig({
  ...base,
  testMatch: /screenshots\.ts$/,
  timeout: 240_000,
  retries: 0,
  reporter: 'list',
  use: { ...base.use, trace: 'off' },
});
