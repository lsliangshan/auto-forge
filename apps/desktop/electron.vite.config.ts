import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: new URL('./src/main.ts', import.meta.url).pathname,
        },
      },
    },
  },
  renderer: {
    root,
    plugins: [vue()],
    build: {
      rollupOptions: {
        input: new URL('./index.html', import.meta.url).pathname,
      },
    },
  },
})
