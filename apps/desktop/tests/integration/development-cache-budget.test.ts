import { randomUUID } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'
import {
  preflightDevelopmentCache,
  pruneDevelopmentCache,
} from '../../scripts/converter-packs/development-cache-budget.mjs'
import { writeDevelopmentReleaseMetadata } from '../../scripts/converter-packs/local-development-release-cache.mjs'

const roots: string[] = []
const GiB = 1024 * 1024 * 1024

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-development-cache-budget-')))
  roots.push(root)
  return root
}

function createCache(): string {
  const cacheRoot = join(temporaryRoot(), 'cache')
  mkdirSync(join(cacheRoot, 'releases'), { recursive: true })
  mkdirSync(join(cacheRoot, 'release-metadata'))
  mkdirSync(join(cacheRoot, 'sources'))
  return cacheRoot
}

function fingerprint(character: string): string {
  return character.repeat(64)
}

function createBlob(cacheRoot: string, sha256: string, bytes: Buffer, age: number): void {
  const path = join(cacheRoot, 'sources', `${sha256}.archive`)
  writeFileSync(path, bytes)
  utimesSync(path, age, age)
}

function writeActiveMarker(cacheRoot: string, value: string): void {
  writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${value}","schemaVersion":1}\n`)
}

async function createVerifiedRelease(cacheRoot: string, character: string, blobs: Array<{ sha256: string; bytes: number }>, age: number) {
  const value = fingerprint(character)
  mkdirSync(join(cacheRoot, 'releases', value))
  await writeDevelopmentReleaseMetadata({ cacheRoot, fingerprint: value, blobs })
  utimesSync(join(cacheRoot, 'release-metadata', `${value}.json`), age, age)
  return value
}

describe('development converter cache budget', () => {
  it('requires ten GiB free and accepts the exact boundary through the injected statfs seam', async () => {
    const cacheRoot = createCache()
    await expect(preflightDevelopmentCache({
      cacheRoot, requiredDownloadBytes: 1, freeBytes: async () => 10 * GiB - 1,
    })).rejects.toThrow('Development converter cache has insufficient free space.')
    await expect(preflightDevelopmentCache({
      cacheRoot, requiredDownloadBytes: 10 * GiB, freeBytes: async () => 10 * GiB,
    })).resolves.toBeUndefined()
  })

  it('retains the active and newest previous releases and prunes unreferenced blobs oldest first', async () => {
    const cacheRoot = createCache()
    const activeBlob = fingerprint('1')
    const previousBlob = fingerprint('2')
    const oldBlob = fingerprint('3')
    const newerExtraBlob = fingerprint('4')
    createBlob(cacheRoot, activeBlob, Buffer.alloc(2), 400)
    createBlob(cacheRoot, previousBlob, Buffer.alloc(2), 300)
    createBlob(cacheRoot, oldBlob, Buffer.alloc(2), 100)
    createBlob(cacheRoot, newerExtraBlob, Buffer.alloc(2), 200)
    const old = await createVerifiedRelease(cacheRoot, 'a', [{ sha256: oldBlob, bytes: 2 }], 100)
    const previous = await createVerifiedRelease(cacheRoot, 'b', [{ sha256: previousBlob, bytes: 2 }], 200)
    const active = await createVerifiedRelease(cacheRoot, 'c', [{ sha256: activeBlob, bytes: 2 }], 300)
    writeActiveMarker(cacheRoot, active)

    await expect(pruneDevelopmentCache({
      cacheRoot, activeFingerprint: active, keepPrevious: 1, maximumBlobBytes: 6,
    })).resolves.toEqual({ removedReleases: [old], removedBlobs: [oldBlob] })
    expect(existsSync(join(cacheRoot, 'releases', active))).toBe(true)
    expect(existsSync(join(cacheRoot, 'releases', previous))).toBe(true)
    expect(existsSync(join(cacheRoot, 'releases', old))).toBe(false)
    expect(existsSync(join(cacheRoot, 'release-metadata', `${old}.json`))).toBe(false)
    expect(existsSync(join(cacheRoot, 'sources', `${activeBlob}.archive`))).toBe(true)
    expect(existsSync(join(cacheRoot, 'sources', `${previousBlob}.archive`))).toBe(true)
    expect(existsSync(join(cacheRoot, 'sources', `${oldBlob}.archive`))).toBe(false)
    expect(existsSync(join(cacheRoot, 'sources', `${newerExtraBlob}.archive`))).toBe(true)
  })

  it('preserves active acquisition partials and their canonical owner metadata', async () => {
    const cacheRoot = createCache()
    const blob = fingerprint('5')
    createBlob(cacheRoot, blob, Buffer.from('kept'), 100)
    const active = await createVerifiedRelease(cacheRoot, 'd', [{ sha256: blob, bytes: 4 }], 100)
    writeActiveMarker(cacheRoot, active)
    const partialSha = fingerprint('6')
    const nonce = randomUUID()
    const owner = { bytes: 10, nonce, pid: process.pid, sha256: partialSha, state: 'active', url: 'https://downloads.example.test/partial' }
    const partial = join(cacheRoot, 'sources', `.${partialSha}.${nonce}.partial`)
    writeFileSync(join(cacheRoot, 'sources', `.${partialSha}.owner`), canonicalBytes(owner))
    writeFileSync(partial, Buffer.from('part'))
    writeFileSync(`${partial}.json`, canonicalBytes({ bytes: 10, nonce, partialBytes: 4, sha256: partialSha, url: owner.url }))

    await pruneDevelopmentCache({ cacheRoot, activeFingerprint: active, maximumBlobBytes: 5 })
    expect(existsSync(partial)).toBe(true)
    expect(existsSync(`${partial}.json`)).toBe(true)
    expect(existsSync(join(cacheRoot, 'sources', `.${partialSha}.owner`))).toBe(true)
  })

  it('fails without mutation when protected blobs alone exceed the ceiling', async () => {
    const cacheRoot = createCache()
    const activeBlob = fingerprint('7')
    const previousBlob = fingerprint('8')
    createBlob(cacheRoot, activeBlob, Buffer.alloc(3), 100)
    createBlob(cacheRoot, previousBlob, Buffer.alloc(3), 200)
    const previous = await createVerifiedRelease(cacheRoot, 'e', [{ sha256: previousBlob, bytes: 3 }], 100)
    const active = await createVerifiedRelease(cacheRoot, 'f', [{ sha256: activeBlob, bytes: 3 }], 200)
    writeActiveMarker(cacheRoot, active)

    await expect(pruneDevelopmentCache({
      cacheRoot, activeFingerprint: active, keepPrevious: 1, maximumBlobBytes: 5,
    })).rejects.toThrow('Development converter cache cannot be pruned safely.')
    expect(existsSync(join(cacheRoot, 'releases', previous))).toBe(true)
    expect(existsSync(join(cacheRoot, 'sources', `${activeBlob}.archive`))).toBe(true)
    expect(existsSync(join(cacheRoot, 'sources', `${previousBlob}.archive`))).toBe(true)
  })

  it.each(['malformed metadata', 'unknown file', 'symbolic blob', 'outside marker'] as const)(
    'rejects %s before removing any cache entry',
    async (failure) => {
      const cacheRoot = createCache()
      const blob = fingerprint('9')
      createBlob(cacheRoot, blob, Buffer.from('blob'), 100)
      const active = await createVerifiedRelease(cacheRoot, '1', [{ sha256: blob, bytes: 4 }], 100)
      writeActiveMarker(cacheRoot, active)
      if (failure === 'malformed metadata') {
        const metadataPath = join(cacheRoot, 'release-metadata', `${active}.json`)
        rmSync(metadataPath)
        writeFileSync(metadataPath, '{}')
      }
      if (failure === 'unknown file') writeFileSync(join(cacheRoot, 'unknown'), 'unknown')
      if (failure === 'symbolic blob') {
        const outside = join(temporaryRoot(), 'outside')
        writeFileSync(outside, 'blob')
        rmSync(join(cacheRoot, 'sources', `${blob}.archive`))
        symlinkSync(outside, join(cacheRoot, 'sources', `${blob}.archive`))
      }
      if (failure === 'outside marker') {
        writeActiveMarker(cacheRoot, fingerprint('2'))
      }

      await expect(pruneDevelopmentCache({ cacheRoot, activeFingerprint: active, maximumBlobBytes: 5 }))
        .rejects.toThrow()
      expect(existsSync(join(cacheRoot, 'releases', active))).toBe(true)
    },
  )

  it('rejects symbolic and noncanonical cache roots', async () => {
    const cacheRoot = createCache()
    const alias = join(temporaryRoot(), 'cache-alias')
    symlinkSync(cacheRoot, alias)
    await expect(preflightDevelopmentCache({
      cacheRoot: alias, requiredDownloadBytes: 1, freeBytes: async () => 10 * GiB,
    })).rejects.toThrow(/canonical|symbolic/iu)
    await expect(pruneDevelopmentCache({ cacheRoot: `${cacheRoot}/.`, activeFingerprint: fingerprint('a') }))
      .rejects.toThrow(/canonical|root/iu)
  })

  it('writes canonical release metadata outside the runtime release directory', async () => {
    const cacheRoot = createCache()
    const blob = fingerprint('a')
    createBlob(cacheRoot, blob, Buffer.from('data'), 100)
    const value = fingerprint('b')
    mkdirSync(join(cacheRoot, 'releases', value))
    const path = await writeDevelopmentReleaseMetadata({
      cacheRoot, fingerprint: value, blobs: [{ sha256: blob, bytes: 4 }],
    })
    expect(path).toBe(join(cacheRoot, 'release-metadata', `${value}.json`))
    expect(path.startsWith(`${join(cacheRoot, 'releases', value)}/`)).toBe(false)
    expect(readFileSync(path)).toEqual(canonicalBytes({
      blobs: [{ bytes: 4, sha256: blob }],
      fingerprint: value,
      release: `releases/${value}`,
      schemaVersion: 1,
    }))
  })
})
