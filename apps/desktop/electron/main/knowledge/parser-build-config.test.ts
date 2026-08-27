import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
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

  it('builds the smoke main before creating its disposable package', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(packageJson.scripts['build:knowledge-parser-smoke']).toMatch(/tsup .*knowledge-parser-smoke-main\.ts/)
    expect(packageJson.scripts['package:knowledge-parser-smoke']).toMatch(
      /^pnpm build:knowledge-parser-smoke && electron-builder /,
    )
  })
})
