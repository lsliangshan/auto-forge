import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  prepareProductionStagingPlan,
  prepareProductionStagingPlanMain,
} from '../../scripts/converter-packs/prepare-production-staging.mjs'

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
  it('reports CLI failures with a fixed path-free message and exit code', async () => {
    const stderr: string[] = []
    const secret = '/private/customer/staging-plan.json'
    const argv = [
      '--lock', '/private/lock.json', '--target', 'darwin-arm64', '--cache', '/private/cache',
      '--helpers', '/private/helpers', '--workspace', '/private/workspace', '--staging', '/private/staging',
      '--plan', secret, '--version', '1.2.3', '--sequence', '7',
      '--generated-at', '2026-08-31T00:00:00.000Z', '--archive-base-url', 'https://example.test/releases/7',
    ]

    const exitCode = await prepareProductionStagingPlanMain(argv, {
      stdout: { write: () => { throw new Error('unexpected stdout') } },
      stderr: { write: (value: string) => { stderr.push(value); return true } },
      prepare: async () => { throw new Error(`failed to publish ${secret}`) },
    })

    expect(exitCode).toBe(1)
    expect(stderr).toEqual(['converter staging preparation failed\n'])
    expect(stderr.join('')).not.toContain(secret)
  })

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

  it('preserves the preparation failure first when workspace cleanup also fails', async () => {
    const root = temporaryRoot()
    const helpers = join(root, 'helpers')
    const cache = join(root, 'cache')
    mkdirSync(helpers)
    mkdirSync(cache)
    const failure = await prepareProductionStagingPlan({
      lockPath: join(root, 'sources.lock.json'), target: 'darwin-arm64', cacheRoot: cache, helpersRoot: helpers,
      workspace: join(root, 'prepared'), staging: join(root, 'staging'), planPath: join(root, 'plan.json'),
      version: '1.2.3', sequence: 7, generatedAt: '2026-08-31T00:00:00.000Z',
      archiveBaseUrl: 'https://example.test/releases/7',
    }, {
      loadLocks: async () => { throw new Error('lock primary') },
      acquireSources: async () => ({ blobs: new Map() }),
      materializeUniverse: async () => undefined,
      materializeEngineAssets: async () => undefined,
      removeWorkspace: async () => {
        const error = new Error('workspace rm EACCES') as Error & { code: string }
        error.code = 'EACCES'
        throw error
      },
    }).then(() => undefined, (error: unknown) => error as AggregateError)

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.message).toBe('lock primary')
    expect(failure.errors.map((error) => (error as Error).message))
      .toEqual(['lock primary', 'workspace rm EACCES'])
  })
})
