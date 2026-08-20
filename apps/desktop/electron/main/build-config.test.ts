import { existsSync, readFileSync } from 'node:fs'
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

  it('uses Electron Chromium without staging a Playwright browser runtime', () => {
    const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
    }
    const builderConfigPath = fileURLToPath(new URL('../../electron-builder.yml', import.meta.url))
    const builderConfig = readFileSync(builderConfigPath, 'utf8')
    const stageScriptPath = fileURLToPath(new URL('../../scripts/stage-browser.mjs', import.meta.url))

    expect(packageJson.dependencies?.['playwright-chromium']).toBeUndefined()
    expect(packageJson.scripts?.['stage:browser']).toBeUndefined()
    expect(packageJson.scripts?.['dist:dir']).not.toContain('stage:browser')
    expect(builderConfig).not.toContain('browser-runtime.json')
    expect(builderConfig).not.toContain('ms-playwright')
    expect(existsSync(stageScriptPath)).toBe(false)
  })
})
