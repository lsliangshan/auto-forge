import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  developmentFingerprintInputs,
  prepareLocalDevelopmentRelease,
  runLocalDevelopmentReleasePreparationCli,
  runLocalDevelopmentReleasePreparation,
} from '../../scripts/converter-packs/prepare-local-development-release.mjs'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'
import { writeDevelopmentReleaseMetadata } from '../../scripts/converter-packs/local-development-release-cache.mjs'

const roots: string[] = []
const fingerprintFiles = [
  'scripts/converter-packs/source-lock.mjs',
  'scripts/converter-packs/closure-lock.mjs',
  'scripts/converter-packs/acquire-sources.mjs',
  'scripts/converter-packs/bottle-archive.mjs',
  'scripts/converter-packs/bottle-universe.mjs',
  'scripts/converter-packs/development-cache-budget.mjs',
  'scripts/converter-packs/build-native-helpers.mjs',
  'scripts/converter-packs/locked-engine-assets.mjs',
  'scripts/converter-packs/local-development-release-cache.mjs',
  'scripts/converter-packs/private-directory-publication.mjs',
  'scripts/converter-packs/prepare-production-staging.mjs',
  'scripts/converter-packs/macho-closure.mjs',
  'scripts/converter-packs/stage-production-packs.mjs',
  'scripts/converter-packs/build-index.mjs',
  'scripts/converter-packs/sign-index.mjs',
  'scripts/converter-packs/pack-tooling-lib.mjs',
  'scripts/converter-packs/build-local-development-release.mjs',
  'scripts/converter-packs/verify-local-development-release.mjs',
]

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-local-preparation-')))
  roots.push(root)
  return root
}

function writeFixtureDesktop(root: string) {
  mkdirSync(join(root, 'converter-packs', 'native', 'common'), { recursive: true })
  mkdirSync(join(root, 'converter-packs', 'closures'), { recursive: true })
  mkdirSync(join(root, 'scripts', 'converter-packs'), { recursive: true })
  const lock = {
    closureLocks: {
      'darwin-arm64': { path: 'closures/darwin-arm64.lock.json' },
      'darwin-x64': { path: 'closures/darwin-x64.lock.json' },
    },
    schemaVersion: 2,
  }
  writeFileSync(join(root, 'converter-packs', 'sources.lock.json'), JSON.stringify(lock), { flag: 'w' })
  writeFileSync(join(root, 'converter-packs', 'closures', 'darwin-arm64.lock.json'), '{"target":"darwin-arm64"}', { flag: 'w' })
  writeFileSync(join(root, 'converter-packs', 'closures', 'darwin-x64.lock.json'), '{"target":"darwin-x64"}', { flag: 'w' })
  writeFileSync(join(root, 'converter-packs', 'native', 'common', 'helper.c'), 'int helper(void) { return 1; }\n', { flag: 'w' })
  for (const relative of fingerprintFiles) {
    writeFileSync(join(root, relative), `// ${relative}\n`, { flag: 'w' })
  }
}

function fixture() {
  const root = temporaryRoot()
  const desktopRoot = join(root, 'desktop')
  mkdirSync(desktopRoot, { recursive: true })
  writeFixtureDesktop(desktopRoot)
  const cacheRoot = join(root, 'cache')
  mkdirSync(cacheRoot)
  return { root, desktopRoot, cacheRoot }
}

async function releaseBuilder({ outputRoot }: { outputRoot: string }) {
  await mkdir(outputRoot, { recursive: true })
}

function request({ desktopRoot, cacheRoot }: { desktopRoot: string, cacheRoot: string }) {
  return { desktopRoot, cacheRoot, platform: 'darwin', arch: 'arm64', compiler: '/usr/bin/clang' }
}

function dependencies(events: string[], overrides: Record<string, unknown> = {}) {
  return {
    buildHelpers: async ({ output }: { output: string }) => {
      events.push('helpers')
      await mkdir(output)
    },
    preparePlan: async ({ planPath, afterMaterialize }: { planPath: string, afterMaterialize: () => Promise<void> }) => {
      await afterMaterialize()
      events.push('plan')
      await writeFile(planPath, '{}\n')
      return { blobs: [], networkBytes: 0 }
    },
    stagePacks: async ({ output }: { output: string }) => {
      events.push('stage')
      await mkdir(output)
    },
    buildRelease: async ({ outputRoot }: { outputRoot: string }) => {
      events.push('build')
      await releaseBuilder({ outputRoot })
    },
    verifyRelease: async () => { events.push('verify') },
    smokeRelease: async () => { events.push('smoke') },
    writeMetadata: async () => { events.push('metadata') },
    activateRelease: async ({ cacheRoot, fingerprint, releaseRoot }: { cacheRoot: string, fingerprint: string, releaseRoot: string }) => {
      events.push('activate')
      await writeFile(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${fingerprint}","schemaVersion":1}\n`)
      return releaseRoot
    },
    pruneCache: async () => { events.push('prune') },
    ...overrides,
  }
}

it('prepares a cold development cache in order and activates only after verification', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const events: string[] = []

  const result = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies(events))

  expect(result.reused).toBe(false)
  expect(result.releaseRoot).toBe(join(cacheRoot, 'releases', result.fingerprint))
  expect(events).toEqual(['helpers', 'plan', 'stage', 'build', 'verify', 'smoke', 'metadata', 'activate', 'prune'])
})

it('recovers a legacy fixed private workspace and prepares in a unique private directory', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const inputs = await developmentFingerprintInputs(desktopRoot)
  const { fingerprintDevelopmentRelease } = await import('../../scripts/converter-packs/local-development-release-cache.mjs')
  const fingerprint = fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs })
  const legacy = join(cacheRoot, `.local-development-preparation-${fingerprint.slice(0, 12)}`)
  await mkdir(legacy)
  await writeFile(join(legacy, 'interrupted'), 'stale')
  let observedWorkspace = ''
  const injected = dependencies([], {
    preparePlan: async (value: Record<string, unknown>) => {
      observedWorkspace = value.workspace as string
      await (value.afterMaterialize as () => Promise<void>)()
      await writeFile(value.planPath as string, '{}\n')
      return { blobs: [], networkBytes: 0 }
    },
  })

  await expect(prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), injected)).resolves.toMatchObject({ reused: false })

  expect(observedWorkspace).not.toBe(join(legacy, 'workspace'))
  expect(existsSync(legacy)).toBe(false)
  expect((await readdir(cacheRoot)).filter((name) => (
    name.startsWith(`.local-development-preparation-${fingerprint.slice(0, 12)}`)
  ))).toEqual([])
})

it('runs the authenticated cold pipeline in exact order and publishes metadata before activation', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const events: string[] = []
  const blob = { bytes: 7, sha256: 'b'.repeat(64) }
  const injected = dependencies(events, {
    preparePlan: async (value: Record<string, unknown>) => {
      events.push('validate', 'preflight', 'acquire', 'universe')
      await (value.afterMaterialize as () => Promise<void>)()
      events.push('plan')
      await writeFile(value.planPath as string, '{}\n')
      return { blobs: [blob], networkBytes: 7 }
    },
    writeMetadata: async (value: Record<string, unknown>) => {
      events.push('metadata')
      expect(value.blobs).toEqual([blob])
    },
    pruneCache: async () => { events.push('prune') },
  })

  const result = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), injected)

  expect(result.reused).toBe(false)
  expect(events).toEqual([
    'validate', 'preflight', 'acquire', 'universe', 'helpers', 'plan',
    'stage', 'build', 'verify', 'smoke', 'metadata', 'activate', 'prune',
  ])
})

it('publishes canonical immutable metadata with the exact acquired blob measurements', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const archive = Buffer.from('archive')
  const blob = { bytes: archive.byteLength, sha256: createHash('sha256').update(archive).digest('hex') }
  const events: string[] = []
  const result = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies(events, {
    preparePlan: async (value: Record<string, unknown>) => {
      await (value.afterMaterialize as () => Promise<void>)()
      events.push('plan')
      await writeFile(join(value.cacheRoot as string, `${blob.sha256}.archive`), archive)
      await writeFile(value.planPath as string, '{}\n')
      return { blobs: [blob], networkBytes: archive.byteLength }
    },
    writeMetadata: async (value: Parameters<typeof writeDevelopmentReleaseMetadata>[0]) => {
      events.push('metadata')
      await writeDevelopmentReleaseMetadata(value)
    },
  }))

  const metadataPath = join(cacheRoot, 'release-metadata', `${result.fingerprint}.json`)
  expect(readFileSync(metadataPath)).toEqual(canonicalBytes({
    blobs: [blob], fingerprint: result.fingerprint,
    release: `releases/${result.fingerprint}`, schemaVersion: 1,
  }))
  expect(statSync(metadataPath).mode & 0o777).toBe(0o444)
  expect(events).toEqual(['helpers', 'plan', 'stage', 'build', 'verify', 'smoke', 'metadata', 'activate', 'prune'])
})

it.each([
  ['after-link', () => ({ afterMetadataLinkForTest: async () => { throw new Error('metadata after-link failure') } })],
  ['directory-sync', () => {
    let syncs = 0
    return {
      syncDirectoryForTest: async () => {
        syncs += 1
        if (syncs === 2) throw new Error('metadata directory-sync failure')
      },
    }
  }],
  ['claim-cleanup', () => ({ claimCleanupForTest: async () => { throw new Error('metadata claim-cleanup failure') } })],
])('removes linked metadata and its release when durable metadata publication reports a %s tail failure', async (_scenario, fault) => {
  const { desktopRoot, cacheRoot } = fixture()
  const previous = 'e'.repeat(64)
  const marker = `{"fingerprint":"${previous}","schemaVersion":1}\n`
  await mkdir(join(cacheRoot, 'releases', previous), { recursive: true })
  await writeFile(join(cacheRoot, 'active-release.json'), marker)
  const archive = Buffer.from('tail-fault-archive')
  const blob = { bytes: archive.byteLength, sha256: createHash('sha256').update(archive).digest('hex') }
  let fingerprint = ''
  const injected = dependencies([], {
    preparePlan: async (value: Record<string, unknown>) => {
      await (value.afterMaterialize as () => Promise<void>)()
      await writeFile(join(value.cacheRoot as string, `${blob.sha256}.archive`), archive)
      await writeFile(value.planPath as string, '{}\n')
      return { blobs: [blob], networkBytes: archive.byteLength }
    },
    writeMetadata: async (value: Parameters<typeof writeDevelopmentReleaseMetadata>[0]) => {
      fingerprint = value.fingerprint
      await writeDevelopmentReleaseMetadata({
        ...value,
        ...fault(),
      })
    },
  })

  await expect(prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), injected))
    .rejects.toThrow(/failure|failed/)

  expect(await readFile(join(cacheRoot, 'active-release.json'), 'utf8')).toBe(marker)
  expect(existsSync(join(cacheRoot, 'releases', fingerprint))).toBe(false)
  expect(existsSync(join(cacheRoot, 'release-metadata', `${fingerprint}.json`))).toBe(false)
  expect((await readdir(join(cacheRoot, 'release-metadata'))).filter((name) => name.includes(fingerprint))).toEqual([])
})

it('reuses only the verified active fingerprint with integrity and safe pruning while preserving mtimes', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const firstEvents: string[] = []
  const first = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies(firstEvents))
  const events: string[] = []
  const sourcePath = join(desktopRoot, 'converter-packs', 'sources.lock.json')
  const sourceMtime = statSync(sourcePath).mtimeMs
  const releaseMtime = statSync(first.releaseRoot).mtimeMs
  const forbidden = async () => { throw new Error('warm path performed cold work') }
  const injected = dependencies(events, {
    buildHelpers: forbidden,
    preparePlan: forbidden,
    stagePacks: forbidden,
    buildRelease: forbidden,
    smokeRelease: forbidden,
    writeMetadata: forbidden,
    activateRelease: forbidden,
    pruneCache: async () => { events.push('prune') },
  })

  const result = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), injected)

  expect(result).toEqual({ fingerprint: first.fingerprint, releaseRoot: first.releaseRoot, reused: true })
  expect(events).toEqual(['verify', 'prune'])
  expect(statSync(sourcePath).mtimeMs).toBe(sourceMtime)
  expect(statSync(first.releaseRoot).mtimeMs).toBe(releaseMtime)
})

it.each([
  ['converter-packs/closures/darwin-arm64.lock.json'],
  ['converter-packs/closures/darwin-x64.lock.json'],
  ['converter-packs/native/common/helper.c'],
  ['scripts/converter-packs/private-directory-publication.mjs'],
  ['scripts/converter-packs/prepare-production-staging.mjs'],
  ['scripts/converter-packs/development-cache-budget.mjs'],
  ['scripts/converter-packs/local-development-release-cache.mjs'],
  ['scripts/converter-packs/verify-local-development-release.mjs'],
])('changes the fingerprint when %s bytes change', async (changedPath) => {
  const { desktopRoot, cacheRoot } = fixture()
  const first = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies([]))
  writeFileSync(join(desktopRoot, changedPath), 'changed bytes\n')

  const second = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies([]))

  expect(second.fingerprint).not.toBe(first.fingerprint)
})

it('changes the fingerprint when canonical source lock bytes change', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const first = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies([]))
  const sourcePath = join(desktopRoot, 'converter-packs', 'sources.lock.json')
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
  writeFileSync(sourcePath, JSON.stringify({
    closureLocks: source.closureLocks,
    fixtureRevision: 1,
    schemaVersion: source.schemaVersion,
  }))

  const second = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies([]))

  expect(second.fingerprint).not.toBe(first.fingerprint)
})

it('includes the requested target in the fingerprint', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const arm64 = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies([]))

  const x64 = await prepareLocalDevelopmentRelease(
    { ...request({ desktopRoot, cacheRoot }), arch: 'x64' },
    dependencies([]),
  )

  expect(x64.fingerprint).not.toBe(arm64.fingerprint)
})

it('passes the requested x64 target to the release builder', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const events: string[] = []
  const injected = dependencies(events, {
    buildRelease: async (value: Record<string, unknown>) => {
      events.push('build')
      expect(value.platform).toBe('darwin')
      expect(value.arch).toBe('x64')
      await releaseBuilder({ outputRoot: value.outputRoot as string })
    },
  })

  await prepareLocalDevelopmentRelease(
    { ...request({ desktopRoot, cacheRoot }), arch: 'x64' },
    injected,
  )

  expect(events).toEqual(['helpers', 'plan', 'stage', 'build', 'verify', 'smoke', 'metadata', 'activate', 'prune'])
})

it('rejects symbolic fingerprint inputs instead of following them outside the desktop root', async () => {
  const { root, desktopRoot } = fixture()
  const outside = join(root, 'outside.c')
  writeFileSync(outside, 'outside helper source\n')
  rmSync(join(desktopRoot, 'converter-packs', 'native', 'common', 'helper.c'))
  symlinkSync(outside, join(desktopRoot, 'converter-packs', 'native', 'common', 'helper.c'))

  await expect(developmentFingerprintInputs(desktopRoot)).rejects.toThrow(/symbolic/i)
})

it('rejects unsafe closure coordinates and symbolic closure files before fingerprinting', async () => {
  const unsafe = fixture()
  const unsafePath = join(unsafe.desktopRoot, 'converter-packs', 'sources.lock.json')
  const unsafeLock = JSON.parse(readFileSync(unsafePath, 'utf8'))
  unsafeLock.closureLocks['darwin-arm64'].path = '../outside.lock.json'
  writeFileSync(unsafePath, JSON.stringify(unsafeLock))
  writeFileSync(join(unsafe.desktopRoot, 'converter-packs', 'outside.lock.json'), '{}')
  await expect(developmentFingerprintInputs(unsafe.desktopRoot)).rejects.toThrow(/closure coordinates/iu)

  const symbolic = fixture()
  const closurePath = join(symbolic.desktopRoot, 'converter-packs', 'closures', 'darwin-arm64.lock.json')
  const outside = join(symbolic.root, 'outside-closure.json')
  writeFileSync(outside, '{"target":"darwin-arm64"}')
  rmSync(closurePath)
  symlinkSync(outside, closurePath)
  await expect(developmentFingerprintInputs(symbolic.desktopRoot)).rejects.toThrow(/linked|symbolic/iu)
})

it.each([
  ['helper build', 'buildHelpers'],
  ['probe staging', 'stagePacks'],
  ['release signing', 'buildRelease'],
  ['release verification', 'verifyRelease'],
  ['release smoke verification', 'smokeRelease'],
] as const)('retains the literal previous marker when %s fails', async (_name, failingDependency) => {
  const { desktopRoot, cacheRoot } = fixture()
  const previous = 'a'.repeat(64)
  await mkdir(join(cacheRoot, 'releases', previous), { recursive: true })
  const marker = `{"fingerprint":"${previous}","schemaVersion":1}\n`
  await writeFile(join(cacheRoot, 'active-release.json'), marker)
  const events: string[] = []
  const injected = dependencies(events, {
    [failingDependency]: async () => { throw new Error('expected failure') },
  })

  await expect(prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), injected)).rejects.toThrow('expected failure')

  await expect(readFile(join(cacheRoot, 'active-release.json'), 'utf8')).resolves.toBe(marker)
  expect(events).not.toContain('activate')
})

it.each(['buildRelease', 'verifyRelease', 'smokeRelease'] as const)(
  'preserves the %s failure first and attempts both release and private cleanup',
  async (failingDependency) => {
    const { desktopRoot, cacheRoot } = fixture()
    const attempts: string[] = []
    const injected = dependencies([], {
      [failingDependency]: async () => { throw new Error(`${failingDependency} primary`) },
      removeRelease: async () => { attempts.push('release'); throw new Error('release rm EACCES') },
      removePrivateRoot: async () => { attempts.push('private'); throw new Error('private rm EACCES') },
    })

    const failure = await prepareLocalDevelopmentRelease(
      request({ desktopRoot, cacheRoot }),
      injected,
    ).then(() => undefined, (error: unknown) => error as AggregateError)

    expect(attempts).toEqual(['release', 'private'])
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.message).toBe(`${failingDependency} primary`)
    expect(failure.errors.map((error) => (error as Error).message))
      .toEqual([`${failingDependency} primary`, 'release rm EACCES', 'private rm EACCES'])
  },
)

it('removes a smoke-failed cold release, preserves the prior marker, and rebuilds on the next request', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const previous = 'a'.repeat(64)
  const marker = `{"fingerprint":"${previous}","schemaVersion":1}\n`
  await mkdir(join(cacheRoot, 'releases', previous), { recursive: true })
  await writeFile(join(cacheRoot, 'active-release.json'), marker)
  const firstEvents: string[] = []
  let releaseRoot = ''
  const failing = dependencies(firstEvents, {
    buildRelease: async ({ outputRoot }: { outputRoot: string }) => { firstEvents.push('build'); releaseRoot = outputRoot; await releaseBuilder({ outputRoot }) },
    smokeRelease: async () => { firstEvents.push('smoke'); throw new Error('smoke failed') },
  })

  await expect(prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), failing)).rejects.toThrow('smoke failed')
  expect(existsSync(releaseRoot)).toBe(false)
  await expect(readFile(join(cacheRoot, 'active-release.json'), 'utf8')).resolves.toBe(marker)
  expect(firstEvents).toEqual(['helpers', 'plan', 'stage', 'build', 'verify', 'smoke'])

  const secondEvents: string[] = []
  await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies(secondEvents))
  expect(secondEvents).toEqual(['helpers', 'plan', 'stage', 'build', 'verify', 'smoke', 'metadata', 'activate', 'prune'])
})

it('preserves resumable source state and removes all unpublished cold state after staging fails', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const previous = 'a'.repeat(64)
  const marker = `{"fingerprint":"${previous}","schemaVersion":1}\n`
  const partialSha = 'c'.repeat(64)
  const partialNonce = randomUUID()
  const partial = join(cacheRoot, 'sources', `.${partialSha}.${partialNonce}.partial`)
  const partialMetadata = canonicalBytes({
    bytes: 20, nonce: partialNonce, partialBytes: 15, sha256: partialSha,
    url: 'https://downloads.example.test/resumable',
  })
  const owner = canonicalBytes({
    bytes: 20, nonce: partialNonce, pid: process.pid, sha256: partialSha, state: 'resume',
    url: 'https://downloads.example.test/resumable',
  })
  await mkdir(join(cacheRoot, 'releases', previous), { recursive: true })
  await mkdir(join(cacheRoot, 'sources'), { recursive: true })
  await writeFile(join(cacheRoot, 'active-release.json'), marker)
  await writeFile(join(cacheRoot, 'sources', `.${partialSha}.owner`), owner)
  await writeFile(partial, 'resumable bytes')
  await writeFile(`${partial}.json`, partialMetadata)
  const events: string[] = []

  await expect(prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies(events, {
    stagePacks: async () => { events.push('stage'); throw new Error('staging failed') },
  }))).rejects.toThrow('staging failed')

  const inputs = await developmentFingerprintInputs(desktopRoot)
  const { fingerprintDevelopmentRelease } = await import('../../scripts/converter-packs/local-development-release-cache.mjs')
  const fingerprint = fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs })
  expect(await readFile(join(cacheRoot, 'active-release.json'), 'utf8')).toBe(marker)
  expect(await readFile(partial, 'utf8')).toBe('resumable bytes')
  expect(await readFile(`${partial}.json`)).toEqual(partialMetadata)
  expect(await readFile(join(cacheRoot, 'sources', `.${partialSha}.owner`))).toEqual(owner)
  expect(existsSync(join(cacheRoot, 'releases', fingerprint))).toBe(false)
  expect(existsSync(join(cacheRoot, 'release-metadata', `${fingerprint}.json`))).toBe(false)
  expect(existsSync(join(cacheRoot, `.local-development-preparation-${fingerprint.slice(0, 12)}`))).toBe(false)
  expect(events).toEqual(['helpers', 'plan', 'stage'])

  const retryEvents: string[] = []
  const retry = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies(retryEvents))
  expect(retry.reused).toBe(false)
  expect(retryEvents).toEqual(['helpers', 'plan', 'stage', 'build', 'verify', 'smoke', 'metadata', 'activate', 'prune'])
})

it('does not let a losing concurrent cold cleanup delete the release activated by the winner', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  let releaseFirst!: () => void
  let signalFirstPlan!: () => void
  let signalSecondPlan!: () => void
  let signalActivated!: () => void
  const firstPlan = new Promise<void>((resolve) => { signalFirstPlan = resolve })
  const secondPlan = new Promise<void>((resolve) => { signalSecondPlan = resolve })
  const releasePlan = new Promise<void>((resolve) => { releaseFirst = resolve })
  const activated = new Promise<void>((resolve) => { signalActivated = resolve })
  const firstDependencies = dependencies([], {
    preparePlan: async (value: Record<string, unknown>) => {
      signalFirstPlan()
      await releasePlan
      await (value.afterMaterialize as () => Promise<void>)()
      await writeFile(value.planPath as string, '{}\n')
      return { blobs: [], networkBytes: 0 }
    },
    activateRelease: async ({ cacheRoot: root, fingerprint, releaseRoot }: { cacheRoot: string, fingerprint: string, releaseRoot: string }) => {
      await writeFile(join(root, 'active-release.json'), `{"fingerprint":"${fingerprint}","schemaVersion":1}\n`)
      signalActivated()
      return releaseRoot
    },
  })
  const losingDependencies = dependencies([], {
    preparePlan: async (value: Record<string, unknown>) => {
      await (value.afterMaterialize as () => Promise<void>)()
      await writeFile(value.planPath as string, '{}\n')
      signalSecondPlan()
      return { blobs: [], networkBytes: 0 }
    },
    buildRelease: async () => {
      await activated
      throw new Error('lost concurrent publication')
    },
  })

  const winner = prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), firstDependencies)
  await firstPlan
  const loser = prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), losingDependencies)
  await secondPlan
  releaseFirst()
  const won = await winner
  await expect(loser).rejects.toThrow('lost concurrent publication')

  expect(existsSync(won.releaseRoot)).toBe(true)
  expect(await readFile(join(cacheRoot, 'active-release.json'), 'utf8'))
    .toBe(`{"fingerprint":"${won.fingerprint}","schemaVersion":1}\n`)
})

it('keeps a release when activation writes its marker and then throws', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  let releaseRoot = ''
  const injected = dependencies([], {
    buildRelease: async ({ outputRoot }: { outputRoot: string }) => { releaseRoot = outputRoot; await releaseBuilder({ outputRoot }) },
    activateRelease: async ({ fingerprint }: { fingerprint: string }) => {
      await writeFile(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${fingerprint}","schemaVersion":1}\n`)
      throw new Error('activation after marker write')
    },
  })

  await expect(prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), injected)).rejects.toThrow('activation after marker write')
  expect(existsSync(releaseRoot)).toBe(true)
})

it('does not warm-reuse a non-active derived release before rebuilding and activation', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const inputs = await developmentFingerprintInputs(desktopRoot)
  const { fingerprintDevelopmentRelease } = await import('../../scripts/converter-packs/local-development-release-cache.mjs')
  const fingerprint = fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs })
  const corrupted = join(cacheRoot, 'releases', fingerprint)
  await mkdir(corrupted, { recursive: true })
  await writeFile(join(cacheRoot, 'sources', 'keep.archive'), 'source cache', { flag: 'w' }).catch(async () => {
    await mkdir(join(cacheRoot, 'sources'), { recursive: true })
    await writeFile(join(cacheRoot, 'sources', 'keep.archive'), 'source cache')
  })
  const events: string[] = []
  const injected = dependencies(events, {
    buildRelease: async ({ outputRoot }: { outputRoot: string }) => {
      events.push('build')
      expect(existsSync(outputRoot)).toBe(false)
      await releaseBuilder({ outputRoot })
    },
  })

  const result = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), injected)

  expect(result.reused).toBe(false)
  expect(events).toEqual(['helpers', 'plan', 'stage', 'build', 'verify', 'smoke', 'metadata', 'activate', 'prune'])
  await expect(readFile(join(cacheRoot, 'sources', 'keep.archive'), 'utf8')).resolves.toBe('source cache')
})

it('does not overwrite a content-addressed source archive when source verification fails', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const archive = join(cacheRoot, 'sources', 'a'.repeat(64) + '.archive')
  await mkdir(join(cacheRoot, 'sources'), { recursive: true })
  await writeFile(archive, 'old source archive')
  const events: string[] = []

  await expect(prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies(events, {
    preparePlan: async () => { throw new Error('source archive hash mismatch') },
  }))).rejects.toThrow('source archive hash mismatch')

  await expect(readFile(archive, 'utf8')).resolves.toBe('old source archive')
  expect(events).toEqual([])
})

it('fails unsupported targets and non-canonical cache roots before callbacks', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const events: string[] = []

  await expect(prepareLocalDevelopmentRelease(
    { ...request({ desktopRoot, cacheRoot }), platform: 'linux' },
    dependencies(events),
  )).rejects.toThrow(/unsupported/i)
  await expect(prepareLocalDevelopmentRelease(
    { ...request({ desktopRoot, cacheRoot }), cacheRoot: `${cacheRoot}/.` },
    dependencies(events),
  )).rejects.toThrow(/canonical/i)

  expect(events).toEqual([])
})

it('passes callbacks only absolute paths inside the cache workspace or release roots', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const paths: string[] = []
  const collect = (value: Record<string, unknown>) => {
    for (const candidate of Object.values(value)) if (typeof candidate === 'string' && candidate.startsWith(cacheRoot)) paths.push(candidate)
  }
  const events: string[] = []
  const injected = dependencies(events, {
    buildHelpers: async (value: Record<string, unknown>) => { collect(value); await mkdir(value.output as string) },
    preparePlan: async (value: Record<string, unknown>) => {
      collect(value)
      await (value.afterMaterialize as () => Promise<void>)()
      await writeFile(value.planPath as string, '{}\n')
      return { blobs: [], networkBytes: 0 }
    },
    stagePacks: async (value: Record<string, unknown>) => { collect(value); await mkdir(value.output as string) },
    buildRelease: async (value: Record<string, unknown>) => { collect(value); await releaseBuilder({ outputRoot: value.outputRoot as string }) },
    verifyRelease: async (value: Record<string, unknown>) => { collect(value); events.push('verify') },
    activateRelease: async (value: Record<string, unknown>) => { collect(value); events.push('activate'); return value.releaseRoot },
  })

  await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), injected)

  expect(paths.length).toBeGreaterThan(0)
  expect(paths.every((path) => path === cacheRoot || path.startsWith(`${cacheRoot}/`))).toBe(true)
  expect(paths.every((path) => !path.includes('/../'))).toBe(true)
})

it('runs local preparation with the desktop cache and reports only its status and fingerprint', async () => {
  const desktopRoot = temporaryRoot()
  const cacheRoot = join(desktopRoot, 'node_modules', '.cache', 'autoforge-converter-packs')
  const lines: string[] = []
  const prepare = async (value: Record<string, unknown>) => {
    expect(value).toEqual({
      desktopRoot,
      cacheRoot,
      platform: 'darwin',
      arch: 'arm64',
      compiler: '/usr/bin/clang',
    })
    expect(existsSync(cacheRoot)).toBe(true)
    return { fingerprint: 'c'.repeat(64), releaseRoot: '/sensitive/release/root', reused: false }
  }

  await runLocalDevelopmentReleasePreparation({
    desktopRoot,
    platform: 'darwin',
    arch: 'arm64',
    write: (line: string) => { lines.push(line) },
    prepare,
  })

  expect(lines).toEqual([`prepared ${'c'.repeat(64)}\n`])
})

it('reports CLI preparation failures without leaking an error path or message', async () => {
  const errors: string[] = []
  const sensitiveMessage = 'unable to use /private/workspace/cache/signing-key/private.pem token=not-for-output'

  const status = await runLocalDevelopmentReleasePreparationCli({
    prepare: async () => { throw new Error(sensitiveMessage) },
    writeError: (line: string) => { errors.push(line) },
  })

  expect(status).toBe(1)
  expect(errors).toEqual(['converter release preparation failed\n'])
  expect(errors.join('')).not.toContain('/private/workspace')
  expect(errors.join('')).not.toContain('token=not-for-output')
})
