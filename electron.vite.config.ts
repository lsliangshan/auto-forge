import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@main': resolve('src/main'), '@shared': resolve('src/shared') } },
    build: { rollupOptions: { external: ['esbuild'] } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rollupOptions: {
      input: { index: resolve('src/preload/index.ts'), workflowRunner: resolve('src/preload/workflow-runner.ts') },
      output: { format: 'cjs', entryFileNames: '[name].js' }
    } }
  },
  renderer: {
    root: '.',
    plugins: [vue()],
    resolve: { alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    build: { rollupOptions: { input: resolve('index.html') } }
  }
})
