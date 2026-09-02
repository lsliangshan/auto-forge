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
    const selected = {
      target: 'darwin-arm64', sourceLock: { formulae: [] },
      closureLock: { target: 'darwin-arm64', measurements: { downloadBytes: 1 } },
    }
    const digest = 'a'.repeat(64)
    const blobs = new Map([[digest, { path: join(root, 'a'), sha256: digest, bytes: 1, networkBytes: 1 }]])
    const calls: string[] = []
    const privateLock = join(workspace, 'locks', 'sources.lock.json')

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
      materializeLocks: async () => {
        calls.push('private-locks')
        mkdirSync(join(workspace, 'locks'), { recursive: true })
        writeFileSync(privateLock, '{}')
        return { selected, sourceLockPath: privateLock }
      },
      preflightCache: async () => { calls.push('preflight') },
      acquireSources: async () => { calls.push('acquire'); return { blobs, networkBytes: 1 } },
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
      sourceLockPath: privateLock,
      universeRoot: join(workspace, 'universe'),
      helpersRoot: helpers,
      engineAssetsRoot: join(workspace, 'engine-assets'),
    })
    expect(calls).toEqual(['locks', 'private-locks', 'preflight', 'acquire', 'universe', 'engine-assets'])
  })

  it('preflights the authenticated closure before one unique acquisition and writes a private lock plan', async () => {
    const root = temporaryRoot()
    const helpers = join(root, 'helpers')
    const plan = join(root, 'staging-plan.json')
    const workspace = join(root, 'prepared')
    const staging = join(root, 'staging')
    const lock = join(root, 'sources.lock.json')
    const cache = join(root, 'cache')
    mkdirSync(cache)
    writeFileSync(lock, '{}')
    const privateLock = join(workspace, 'locks', 'sources.lock.json')
    const selected = {
      target: 'darwin-arm64',
      sourceLock: { formulae: [], closureLock: { path: 'closures/darwin-arm64.lock.json' } },
      closureLock: { target: 'darwin-arm64', measurements: { downloadBytes: 23 } },
    }
    const artifact = { path: join(cache, 'a'.repeat(64) + '.archive'), sha256: 'a'.repeat(64), bytes: 23, networkBytes: 23 }
    const calls: string[] = []

    const result = await prepareProductionStagingPlan({
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
      afterMaterialize: async () => {
        calls.push('helpers')
        mkdirSync(helpers)
      },
    }, {
      loadLocks: async () => { calls.push('locks'); return selected },
      materializeLocks: async () => {
        calls.push('private-locks')
        mkdirSync(join(workspace, 'locks'), { recursive: true })
        writeFileSync(privateLock, '{}')
        return { selected, sourceLockPath: privateLock }
      },
      preflightCache: async ({ requiredDownloadBytes }: { requiredDownloadBytes: number }) => {
        calls.push('preflight')
        expect(requiredDownloadBytes).toBe(23)
      },
      acquireSources: async () => { calls.push('acquire'); return { blobs: new Map([[artifact.sha256, artifact]]), networkBytes: 23 } },
      materializeUniverse: async ({ outputRoot }: { outputRoot: string }) => {
        calls.push('universe'); mkdirSync(outputRoot)
      },
      materializeEngineAssets: async ({ outputRoot }: { outputRoot: string }) => {
        calls.push('engine-assets'); mkdirSync(outputRoot)
      },
    })

    expect(calls).toEqual(['locks', 'private-locks', 'preflight', 'acquire', 'universe', 'engine-assets', 'helpers'])
    expect(result).toEqual({ blobs: [{ bytes: 23, sha256: 'a'.repeat(64) }], networkBytes: 23 })
    expect(JSON.parse(readFileSync(plan, 'utf8')).sourceLockPath).toBe(privateLock)
  })

  it('rejects inconsistent acquisition measurements before publishing a plan', async () => {
    const root = temporaryRoot()
    const helpers = join(root, 'helpers')
    const plan = join(root, 'staging-plan.json')
    const workspace = join(root, 'prepared')
    const privateLock = join(workspace, 'locks', 'sources.lock.json')
    const cache = join(root, 'cache')
    mkdirSync(cache)
    mkdirSync(helpers)
    const selected = {
      target: 'darwin-arm64', sourceLock: { formulae: [] },
      closureLock: { target: 'darwin-arm64', measurements: { downloadBytes: 3 } },
    }
    const digest = 'd'.repeat(64)

    await expect(prepareProductionStagingPlan({
      lockPath: join(root, 'sources.lock.json'), target: 'darwin-arm64', cacheRoot: cache, helpersRoot: helpers,
      workspace, staging: join(root, 'staging'), planPath: plan, version: '1.2.3', sequence: 7,
      generatedAt: '2026-08-31T00:00:00.000Z', archiveBaseUrl: 'https://example.test/releases/7',
    }, {
      loadLocks: async () => selected,
      materializeLocks: async () => {
        mkdirSync(join(workspace, 'locks'), { recursive: true })
        writeFileSync(privateLock, '{}')
        return { selected, sourceLockPath: privateLock }
      },
      preflightCache: async () => undefined,
      acquireSources: async () => ({
        blobs: new Map([[digest, { path: join(cache, `${digest}.archive`), sha256: digest, bytes: 3, networkBytes: 3 }]]),
        networkBytes: 2,
      }),
      materializeUniverse: async ({ outputRoot }: { outputRoot: string }) => { mkdirSync(outputRoot) },
      materializeEngineAssets: async ({ outputRoot }: { outputRoot: string }) => { mkdirSync(outputRoot) },
    })).rejects.toThrow(/measurement/iu)

    expect(() => readFileSync(plan)).toThrow()
    expect(() => realpathSync(workspace)).toThrow()
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
      materializeLocks: async () => { throw new Error('unexpected private locks') },
      preflightCache: async () => { throw new Error('unexpected preflight') },
      acquireSources: async () => ({ blobs: new Map(), networkBytes: 0 }),
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
