import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareProductionStagingPlan } from '../../scripts/converter-packs/prepare-production-staging.mjs'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-prepare-staging-')))
  temporaryRoots.push(root)
  return root
}

describe('production staging plan preparation', () => {
  it('materializes authenticated inputs and writes only private resolver roots', async () => {
    const root = temporaryRoot()
    const helpers = join(root, 'helpers')
    const plan = join(root, 'staging-plan.json')
    const workspace = join(root, 'prepared')
    const staging = join(root, 'staging')
    const lock = join(root, 'sources.lock.json')
    const cache = join(root, 'cache')
    mkdirSync(cache)
    mkdirSync(helpers)
    writeFileSync(lock, '{}')
    const selected = { target: 'darwin-arm64', sourceLock: { formulae: [] }, closureLock: { target: 'darwin-arm64' } }
    const blobs = new Map([['a', { path: join(root, 'a') }]])
    const calls: string[] = []

    await prepareProductionStagingPlan({
      lockPath: lock,
      target: 'darwin-arm64',
      cacheRoot: cache,
      helpersRoot: helpers,
      workspace,
      staging,
      planPath: plan,
      version: '1.2.3',
      sequence: 7,
      generatedAt: '2026-08-31T00:00:00.000Z',
      archiveBaseUrl: 'https://cdn.example.test/converter-packs/releases/7',
    }, {
      loadLocks: async () => { calls.push('locks'); return selected },
      acquireSources: async () => { calls.push('acquire'); return { blobs } },
      materializeUniverse: async ({ outputRoot }: { outputRoot: string }) => {
        calls.push('universe'); mkdirSync(outputRoot)
      },
      materializeEngineAssets: async ({ outputRoot }: { outputRoot: string }) => {
        calls.push('engine-assets'); mkdirSync(outputRoot)
      },
    })

    const value = JSON.parse(readFileSync(plan, 'utf8'))
    expect(value).toEqual({
      target: 'darwin-arm64', output: staging, version: '1.2.3', sequence: 7,
      generatedAt: '2026-08-31T00:00:00.000Z',
      archiveBaseUrl: 'https://cdn.example.test/converter-packs/releases/7',
      sourceLockPath: lock,
      universeRoot: join(workspace, 'universe'),
      helpersRoot: helpers,
      engineAssetsRoot: join(workspace, 'engine-assets'),
    })
    expect(calls).toEqual(['locks', 'acquire', 'universe', 'engine-assets'])
  })
})
