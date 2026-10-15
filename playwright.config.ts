import { defineConfig } from '@playwright/test';
const db = './data/browser-tests-' + Date.now() + '.sqlite';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 90000,
  fullyParallel: false,
  workers: 1,
  use: {
    actionTimeout: 10000,
    baseURL: 'http://127.0.0.1:3100',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/dev.mjs',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: '3100',
      DATABASE_PATH: db,
      AGENT_MODE: 'mock',
      OPENAI_API_KEY: '',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
