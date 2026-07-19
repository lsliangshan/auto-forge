import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    name: 'desktop-renderer',
    environment: 'happy-dom',
    include: ['tests/components/**/*.test.ts'],
  },
})
