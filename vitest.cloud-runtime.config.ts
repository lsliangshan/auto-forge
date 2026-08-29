import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/cloudbase/knowledge-worker.test.ts',
      'tests/cloudbase/knowledge-package-smoke.test.ts',
    ],
  },
})
