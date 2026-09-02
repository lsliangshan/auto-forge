import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { rename, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'
import {
  preflightDevelopmentCache,
  pruneDevelopmentCache,
} from '../../scripts/converter-packs/development-cache-budget.mjs'
import { writeDevelopmentReleaseMetadata } from '../../scripts/converter-packs/local-development-release-cache.mjs'

const roots: string[] = []
const children = new Set<ReturnType<typeof spawn>>()
const GiB = 1024 * 1024 * 1024

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  children.clear()
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

function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolvePromise, rejectPromise) => {
    const check = () => {
      if (predicate()) resolvePromise()
      else if (Date.now() - started >= timeoutMs) rejectPromise(new Error('Timed out waiting for cache mutation state.'))
      else setTimeout(check, 20)
    }
    check()
  })
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

  it('recovers a metadata temporary and mutation claim after the publishing process is killed', async () => {
    const cacheRoot = createCache()
    const blob = fingerprint('a')
    createBlob(cacheRoot, blob, Buffer.from('data'), 100)
    const value = fingerprint('b')
    mkdirSync(join(cacheRoot, 'releases', value))
    const marker = join(cacheRoot, 'metadata-temp-ready')
    const moduleUrl = new URL('../../scripts/converter-packs/local-development-release-cache.mjs', import.meta.url).href
    const script = String.raw`
      import { writeFile } from 'node:fs/promises'
      const [moduleUrl, cacheRoot, fingerprint, blob, marker] = process.argv.slice(1)
      const { writeDevelopmentReleaseMetadata } = await import(moduleUrl)
      await writeDevelopmentReleaseMetadata({
        cacheRoot, fingerprint, blobs: [{ sha256: blob, bytes: 4 }],
        afterTemporaryCreateForTest: async () => {
          await writeFile(marker, 'ready')
          await new Promise(() => { setInterval(() => {}, 1_000) })
        },
      })
    `
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', script, moduleUrl, cacheRoot, value, blob, marker,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    children.add(child)
    await waitUntil(() => existsSync(marker))
    const closed = new Promise<void>((resolvePromise) => child.once('close', () => resolvePromise()))
    child.kill('SIGKILL')
    await closed
    children.delete(child)
    expect(existsSync(join(cacheRoot, 'release-metadata', `${value}.json`))).toBe(false)
    expect(readdirSync(join(cacheRoot, 'release-metadata')).some((name) => name.endsWith('.tmp'))).toBe(true)

    await expect(writeDevelopmentReleaseMetadata({
      cacheRoot, fingerprint: value, blobs: [{ sha256: blob, bytes: 4 }],
    })).resolves.toBe(join(cacheRoot, 'release-metadata', `${value}.json`))
    expect(readdirSync(join(cacheRoot, 'release-metadata')).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('finishes an authenticated metadata hard-link publication interrupted before temporary cleanup', async () => {
    const cacheRoot = createCache()
    const value = fingerprint('c')
    mkdirSync(join(cacheRoot, 'releases', value))
    const marker = join(temporaryRoot(), 'metadata-link-ready')
    const moduleUrl = new URL('../../scripts/converter-packs/local-development-release-cache.mjs', import.meta.url).href
    const script = String.raw`
      import { writeFile } from 'node:fs/promises'
      const [moduleUrl, cacheRoot, fingerprint, marker] = process.argv.slice(1)
      const { writeDevelopmentReleaseMetadata } = await import(moduleUrl)
      await writeDevelopmentReleaseMetadata({
        cacheRoot, fingerprint, blobs: [],
        afterMetadataLinkForTest: async () => {
          await writeFile(marker, 'ready')
          await new Promise(() => { setInterval(() => {}, 1_000) })
        },
      })
    `
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', script, moduleUrl, cacheRoot, value, marker,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    children.add(child)
    await waitUntil(() => existsSync(marker))
    const closed = new Promise<void>((resolvePromise) => child.once('close', () => resolvePromise()))
    child.kill('SIGKILL')
    await closed
    children.delete(child)

    await expect(writeDevelopmentReleaseMetadata({ cacheRoot, fingerprint: value, blobs: [] }))
      .resolves.toBe(join(cacheRoot, 'release-metadata', `${value}.json`))
    expect(readdirSync(join(cacheRoot, 'release-metadata')).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('rolls back every moved entry when the second prune rename fails', async () => {
    const cacheRoot = createCache()
    const old = await createVerifiedRelease(cacheRoot, 'a', [], 100)
    await createVerifiedRelease(cacheRoot, 'b', [], 200)
    const active = await createVerifiedRelease(cacheRoot, 'c', [], 300)
    writeActiveMarker(cacheRoot, active)
    let calls = 0

    await expect(pruneDevelopmentCache({
      cacheRoot,
      activeFingerprint: active,
      maximumBlobBytes: 1,
      renameForTest: async (source: string, destination: string) => {
        calls += 1
        if (calls === 2) {
          const error = new Error('injected prune rename EACCES') as Error & { code: string }
          error.code = 'EACCES'
          throw error
        }
        await rename(source, destination)
      },
    })).rejects.toThrow('injected prune rename EACCES')
    expect(existsSync(join(cacheRoot, 'releases', old))).toBe(true)
    expect(existsSync(join(cacheRoot, 'release-metadata', `${old}.json`))).toBe(true)
    expect(readdirSync(cacheRoot).filter((name) => name.startsWith('.development-cache-trash-'))).toEqual([])
  })

  it('does not begin a prune transaction after its mutation claim is deleted', async () => {
    const cacheRoot = createCache()
    const old = await createVerifiedRelease(cacheRoot, '4', [], 100)
    await createVerifiedRelease(cacheRoot, '5', [], 200)
    const active = await createVerifiedRelease(cacheRoot, '6', [], 300)
    writeActiveMarker(cacheRoot, active)

    await expect(pruneDevelopmentCache({
      cacheRoot,
      activeFingerprint: active,
      maximumBlobBytes: 1,
      beforeMutationForTest: async () => unlinkSync(join(cacheRoot, '.cache-mutation.claim')),
    })).rejects.toThrow(/claim|lost/iu)
    expect(existsSync(join(cacheRoot, 'releases', old))).toBe(true)
    expect(existsSync(join(cacheRoot, 'release-metadata', `${old}.json`))).toBe(true)
  })

  it('recovers a recognized interrupted prune trash before safely retrying the plan', async () => {
    const cacheRoot = createCache()
    const old = await createVerifiedRelease(cacheRoot, 'd', [], 100)
    await createVerifiedRelease(cacheRoot, 'e', [], 200)
    const active = await createVerifiedRelease(cacheRoot, 'f', [], 300)
    writeActiveMarker(cacheRoot, active)
    const trash = join(cacheRoot, `.development-cache-trash-${randomUUID()}`)
    mkdirSync(join(trash, 'releases'), { recursive: true })
    mkdirSync(join(trash, 'release-metadata'))
    writeFileSync(join(trash, 'transaction.json'), canonicalBytes({
      phase: 'staging',
      schemaVersion: 1,
      targets: [`release-metadata/${old}.json`, `releases/${old}`].sort(),
    }), { mode: 0o444 })
    await rename(join(cacheRoot, 'releases', old), join(trash, 'releases', old))
    await rename(
      join(cacheRoot, 'release-metadata', `${old}.json`),
      join(trash, 'release-metadata', `${old}.json`),
    )

    await expect(pruneDevelopmentCache({ cacheRoot, activeFingerprint: active, maximumBlobBytes: 1 }))
      .resolves.toEqual({ removedReleases: [old], removedBlobs: [] })
    expect(existsSync(join(cacheRoot, 'releases', old))).toBe(false)
    expect(existsSync(trash)).toBe(false)
  })

  it('continues deleting a committed prune transaction instead of restoring a partial removal', async () => {
    const cacheRoot = createCache()
    const old = await createVerifiedRelease(cacheRoot, '1', [], 100)
    await createVerifiedRelease(cacheRoot, '2', [], 200)
    const active = await createVerifiedRelease(cacheRoot, '3', [], 300)
    writeActiveMarker(cacheRoot, active)

    await expect(pruneDevelopmentCache({
      cacheRoot,
      activeFingerprint: active,
      maximumBlobBytes: 1,
      rmForTest: async (path: string, options: { recursive: boolean; force: boolean }) => {
        if (path.includes('/releases/')) {
          await rm(path, options)
          return
        }
        throw new Error('injected committed trash rm failure')
      },
    })).rejects.toThrow('injected committed trash rm failure')
    expect(existsSync(join(cacheRoot, 'releases', old))).toBe(false)
    expect(existsSync(join(cacheRoot, 'release-metadata', `${old}.json`))).toBe(false)

    await expect(pruneDevelopmentCache({ cacheRoot, activeFingerprint: active, maximumBlobBytes: 1 }))
      .resolves.toEqual({ removedReleases: [], removedBlobs: [] })
    expect(readdirSync(cacheRoot).filter((name) => name.startsWith('.development-cache-trash-'))).toEqual([])
    expect(existsSync(join(cacheRoot, 'releases', old))).toBe(false)
    expect(existsSync(join(cacheRoot, 'release-metadata', `${old}.json`))).toBe(false)
  })
})
