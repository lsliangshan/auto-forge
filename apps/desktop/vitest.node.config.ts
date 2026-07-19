import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'desktop-node',
    environment: 'node',
    include: ['electron/**/*.test.ts', 'tests/integration/**/*.test.ts'],
  },
})
