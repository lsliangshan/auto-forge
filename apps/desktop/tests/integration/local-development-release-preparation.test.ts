import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  developmentFingerprintInputs,
  prepareLocalDevelopmentRelease,
} from '../../scripts/converter-packs/prepare-local-development-release.mjs'

const roots: string[] = []
const fingerprintFiles = [
  'scripts/converter-packs/source-lock.mjs',
  'scripts/converter-packs/acquire-sources.mjs',
  'scripts/converter-packs/build-native-helpers.mjs',
  'scripts/converter-packs/prepare-production-staging.mjs',
  'scripts/converter-packs/macho-closure.mjs',
  'scripts/converter-packs/stage-production-packs.mjs',
  'scripts/converter-packs/build-index.mjs',
  'scripts/converter-packs/sign-index.mjs',
  'scripts/converter-packs/pack-tooling-lib.mjs',
  'scripts/converter-packs/build-local-development-release.mjs',
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
  mkdirSync(join(root, 'scripts', 'converter-packs'), { recursive: true })
  writeFileSync(join(root, 'converter-packs', 'sources.lock.json'), '{"schemaVersion":1}\n', { flag: 'w' })
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
    preparePlan: async ({ planPath }: { planPath: string }) => {
      events.push('plan')
      await writeFile(planPath, '{}\n')
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
    activateRelease: async ({ releaseRoot }: { releaseRoot: string }) => {
      events.push('activate')
      return releaseRoot
    },
    ...overrides,
  }
}

it('prepares a cold development cache in order and activates only after verification', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const events: string[] = []

  const result = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies(events))

  expect(result.reused).toBe(false)
  expect(result.releaseRoot).toBe(join(cacheRoot, 'releases', result.fingerprint))
  expect(events).toEqual(['helpers', 'plan', 'stage', 'build', 'verify', 'activate'])
})

it('reuses a verified matching release without build callbacks', async () => {
  const { desktopRoot, cacheRoot } = fixture()
  const firstEvents: string[] = []
  const first = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies(firstEvents))
  const events: string[] = []

  const result = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies(events))

  expect(result).toEqual({ fingerprint: first.fingerprint, releaseRoot: first.releaseRoot, reused: true })
  expect(events).toEqual(['verify'])
})

it.each([
  ['converter-packs/sources.lock.json'],
  ['converter-packs/native/common/helper.c'],
  ['scripts/converter-packs/prepare-production-staging.mjs'],
])('changes the fingerprint when %s bytes change', async (changedPath) => {
  const { desktopRoot, cacheRoot } = fixture()
  const first = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), dependencies([]))
  writeFileSync(join(desktopRoot, changedPath), 'changed bytes\n')

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

it('rejects symbolic fingerprint inputs instead of following them outside the desktop root', async () => {
  const { root, desktopRoot } = fixture()
  const outside = join(root, 'outside.c')
  writeFileSync(outside, 'outside helper source\n')
  rmSync(join(desktopRoot, 'converter-packs', 'native', 'common', 'helper.c'))
  symlinkSync(outside, join(desktopRoot, 'converter-packs', 'native', 'common', 'helper.c'))

  await expect(developmentFingerprintInputs(desktopRoot)).rejects.toThrow(/symbolic/i)
})

it.each([
  ['helper build', 'buildHelpers'],
  ['probe staging', 'stagePacks'],
  ['release signing', 'buildRelease'],
  ['release verification', 'verifyRelease'],
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

it('removes only a corrupted derived release before rebuilding and activation', async () => {
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
  let verifications = 0
  const events: string[] = []
  const injected = dependencies(events, {
    verifyRelease: async () => {
      events.push('verify')
      verifications += 1
      if (verifications === 1) throw new Error('corrupted derived release')
    },
    buildRelease: async ({ outputRoot }: { outputRoot: string }) => {
      events.push('build')
      expect(existsSync(outputRoot)).toBe(false)
      await releaseBuilder({ outputRoot })
    },
  })

  const result = await prepareLocalDevelopmentRelease(request({ desktopRoot, cacheRoot }), injected)

  expect(result.reused).toBe(false)
  expect(events).toEqual(['verify', 'helpers', 'plan', 'stage', 'build', 'verify', 'activate'])
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
  expect(events).toEqual(['helpers'])
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
    preparePlan: async (value: Record<string, unknown>) => { collect(value); await writeFile(value.planPath as string, '{}\n') },
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
