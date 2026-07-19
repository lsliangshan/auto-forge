import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/desktop/vitest.config.ts',
      'apps/desktop/vitest.node.config.ts',
      {
        test: {
          name: 'examples',
          environment: 'node',
          include: ['examples/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'root',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/e2e/**'],
        },
      },
    ],
  },
})
