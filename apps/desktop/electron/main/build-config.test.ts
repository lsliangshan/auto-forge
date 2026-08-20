import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import electronViteConfig from '../../electron.vite.config.js'

describe('main process build', () => {
  it('keeps the workflow source compiler available as an external runtime dependency', () => {
    const config = electronViteConfig as {
      main?: { build?: { rollupOptions?: { external?: unknown } } }
    }
    const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    expect(config.main?.build?.rollupOptions?.external).toContain('esbuild')
    expect(packageJson.dependencies?.esbuild).toEqual(expect.any(String))
    expect(packageJson.devDependencies?.esbuild).toBeUndefined()
  })
})
