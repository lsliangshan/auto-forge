import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './apps/desktop/tests/e2e',
  testMatch: [
    'browser-continuation.spec.ts',
    'cloud-user-data-sync.spec.ts',
    'knowledge-smoke.spec.ts',
    'knowledge-benchmark.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})
