import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: new URL('./electron/main/index.ts', import.meta.url).pathname,
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: new URL('./electron/preload/index.ts', import.meta.url).pathname,
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root,
    plugins: [vue(), tailwindcss()],
    build: {
      rollupOptions: {
        input: new URL('./index.html', import.meta.url).pathname,
      },
    },
  },
})
