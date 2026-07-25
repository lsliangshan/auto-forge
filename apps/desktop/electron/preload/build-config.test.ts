import { describe, expect, it } from 'vitest'
import electronViteConfig from '../../electron.vite.config.js'

describe('sandboxed preload build', () => {
  it('emits a CommonJS preload script that Electron can execute in the sandbox', () => {
    const config = electronViteConfig as {
      preload?: { build?: { externalizeDeps?: unknown; rollupOptions?: { output?: unknown } } }
    }

    expect(config.preload?.build?.externalizeDeps).toBe(false)
    expect(config.preload?.build?.rollupOptions?.output).toMatchObject({
      format: 'cjs',
      entryFileNames: '[name].cjs',
    })
  })
})
