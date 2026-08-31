import { existsSync, readFileSync, readdirSync } from 'node:fs'
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

  it('packages only fail-closed converter bootstrap trust metadata, never keys or engines', () => {
    const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> }
    const builderConfigPath = fileURLToPath(new URL('../../electron-builder.yml', import.meta.url))
    const builderConfig = readFileSync(builderConfigPath, 'utf8')
    const productionBuilderConfig = readFileSync(fileURLToPath(new URL('../../electron-builder.production.cjs', import.meta.url)), 'utf8')
    const resourceRoot = fileURLToPath(new URL('../../resources/converter-packs/', import.meta.url))
    const bootstrap = JSON.parse(readFileSync(`${resourceRoot}/bootstrap.json`, 'utf8')) as Record<string, unknown>
    const resourceNames = readdirSync(resourceRoot).sort()

    expect(builderConfig).toContain('from: resources/converter-packs')
    expect(builderConfig).toContain('to: converter-packs')
    expect(builderConfig).toContain('bootstrap.json')
    expect(builderConfig).toContain('index.schema.json')
    expect(builderConfig).toContain('root-public-key.pem')
    expect(builderConfig).not.toMatch(/^\s*-\s+out\/\*\*\s*$/mu)
    expect(builderConfig).toContain('out/main/index.js')
    expect(builderConfig).toContain('out/preload/index.cjs')
    expect(builderConfig).toContain('out/renderer/index.html')
    expect(builderConfig).toContain('out/renderer/assets/**')
    expect(builderConfig).toContain('out/workers/workflow-runner.cjs')
    expect(builderConfig).toMatch(/!\*\*\/\{test,tests,__tests__,spec,fixtures,e2e,\.e2e,stale\}\/\*\*/u)
    expect(builderConfig).toContain('!out/**/*.map')
    expect(resourceNames).toEqual(['bootstrap.json', 'index.schema.json'])
    expect(bootstrap).toMatchObject({ schemaVersion: 1, downloadsEnabled: false, indexUrl: null, rootPublicKeyFile: null })
    expect(builderConfig).not.toMatch(/private[-_]?key|\.tar|\.exe|ffmpeg|soffice|autoforge-image-converter|autoforge-pdf-raster/iu)
    expect(packageJson.scripts?.['converter-packs:build']).toContain('build-index.mjs')
    expect(packageJson.scripts?.['converter-packs:sign']).toContain('sign-index.mjs')
    expect(packageJson.scripts?.['converter-packs:create-bootstrap']).toContain('create-production-bootstrap.mjs')
    expect(packageJson.scripts?.['dist:production']).toContain('electron-builder.production.cjs')
    expect(packageJson.scripts?.['dist:production']).toContain('--metadata-mode production')
    expect(productionBuilderConfig).toContain('AUTOFORGE_CONVERTER_METADATA_ROOT')
    expect(productionBuilderConfig).not.toContain('from: resources/converter-packs')
    expect(packageJson.scripts?.['verify:converter-packs']).toContain('verify-converter-packs.mjs')
    expect(packageJson.scripts?.['dist:dir']).toContain('verify:converter-packs')
  })

  it('uses signed local conversion only in development and keeps packaged builds on the production factory', () => {
    const mainEntryPath = fileURLToPath(new URL('./index.ts', import.meta.url))
    const source = readFileSync(mainEntryPath, 'utf8')

    expect(source).toContain("import { createProductionConversionRuntimeFactory } from './conversion/production-conversion-runtime.js'")
    expect(source).toContain("import { createLocalDevelopmentConversionRuntimeFactory } from './conversion/local-development-conversion-runtime.js'")
    expect(source).toContain("join(process.resourcesPath, 'converter-packs')")
    expect(source).toContain("join(app.getAppPath(), 'resources', 'converter-packs')")
    expect(source).toMatch(/const developmentConverterRelease = app\.isPackaged\s*\?\s*undefined\s*:\s*process\.env\.AUTOFORGE_DEV_CONVERTER_RELEASE_ROOT/u)
    expect(source).toMatch(/conversionRuntimeFactory:\s*developmentConverterRelease\s*\?\s*createLocalDevelopmentConversionRuntimeFactory\(\{ releaseRoot: developmentConverterRelease \}\)\s*:\s*createProductionConversionRuntimeFactory\(\{[\s\S]*resourcesRoot:\s*converterPackResources,[\s\S]*network:\s*networkProxy/u)
  })
})
