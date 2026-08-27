import { describe, expect, it } from 'vitest'
import config from '../../../electron.vite.config.js'

describe('knowledge parser build boundary', () => {
  it('builds dedicated parser preload and sandbox renderer entry points', () => {
    const resolved = config as {
      preload?: { build?: { externalizeDeps?: unknown; rollupOptions?: { input?: unknown; output?: unknown } } }
      renderer?: { build?: { rollupOptions?: { input?: unknown } } }
    }
    expect(resolved.preload?.build?.externalizeDeps).toBe(false)
    expect(resolved.preload?.build?.rollupOptions?.input).toMatchObject({
      knowledgeParser: expect.stringMatching(/knowledge-parser\/preload\.ts$/),
    })
    expect(resolved.preload?.build?.rollupOptions?.output).toMatchObject({
      format: 'cjs',
      entryFileNames: '[name].cjs',
    })
    expect(resolved.renderer?.build?.rollupOptions?.input).toMatchObject({
      knowledgeParser: expect.stringMatching(/knowledge-parser\/index\.html$/),
    })
  })
})
