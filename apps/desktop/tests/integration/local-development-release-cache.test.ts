import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activateDevelopmentRelease,
  developmentReleasePaths,
  fingerprintDevelopmentRelease,
  readActiveDevelopmentRelease,
  removeInactiveDevelopmentRelease,
  writeDevelopmentReleaseMetadata,
} from '../../scripts/converter-packs/local-development-release-cache.mjs'

const roots: string[] = []
const children = new Set<ReturnType<typeof spawn>>()

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  children.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolvePromise, rejectPromise) => {
    const check = () => {
      if (predicate()) resolvePromise()
      else if (Date.now() - started >= timeoutMs) rejectPromise(new Error('Timed out waiting for release mutation state.'))
      else setTimeout(check, 20)
    }
    check()
  })
}

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-development-release-cache-')))
  roots.push(root)
  return root
}

function createRelease(cacheRoot: string, fingerprint: string): string {
  const release = join(cacheRoot, 'releases', fingerprint)
  mkdirSync(release, { recursive: true })
  return release
}

describe('local development release cache', () => {
  it('frames the development release fingerprint deterministically', () => {
    expect(fingerprintDevelopmentRelease({
      target: 'darwin-arm64',
      inputs: [
        { path: 'a', bytes: Buffer.from('one') },
        { path: 'b', bytes: Buffer.from('two') },
      ],
    })).toBe('ff854d97f63725260c0c5cc96dde6006aa48f8db5912303ec6532bc0d6a355af')
  })

  it('canonicalizes input order and distinguishes targets and bytes', () => {
    const inputs = [
      { path: 'a', bytes: Buffer.from('one') },
      { path: 'b', bytes: Buffer.from('two') },
    ]
    const fingerprint = fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs })

    expect(fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs: [...inputs].reverse() })).toBe(fingerprint)
    expect(fingerprintDevelopmentRelease({ target: 'darwin-x64', inputs })).not.toBe(fingerprint)
    expect(fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs: [{ path: 'a', bytes: Buffer.from('ONE') }, inputs[1]] })).not.toBe(fingerprint)
  })

  it('uses a strict bytewise order for distinct Unicode paths', () => {
    const inputs = [
      { path: 'e\u0301', bytes: Buffer.from('one') },
      { path: 'é', bytes: Buffer.from('two') },
    ]

    expect(fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs: [...inputs].reverse() }))
      .toBe(fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs }))
  })

  it('rejects unsafe or duplicate fingerprint input paths', () => {
    for (const inputs of [
      [{ path: '../escape', bytes: Buffer.alloc(0) }],
      [{ path: '/absolute', bytes: Buffer.alloc(0) }],
      [{ path: 'nested//path', bytes: Buffer.alloc(0) }],
      [{ path: 'a', bytes: Buffer.alloc(0) }, { path: 'a', bytes: Buffer.alloc(1) }],
    ]) {
      expect(() => fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs })).toThrow(/path|duplicate|safe/iu)
    }
  })

  it('returns canonical cache paths and rejects a symbolic root', () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const fingerprint = 'a'.repeat(64)
    const paths = developmentReleasePaths(cacheRoot, fingerprint)

    expect(paths).toMatchObject({
      sources: join(cacheRoot, 'sources'),
      release: join(cacheRoot, 'releases', fingerprint),
      activeMarker: join(cacheRoot, 'active-release.json'),
    })
    expect(paths.markerTemporaryRoot.startsWith(`${cacheRoot}/.`)).toBe(true)

    const alias = join(root, 'cache-alias')
    symlinkSync(cacheRoot, alias)
    expect(() => developmentReleasePaths(alias, fingerprint)).toThrow(/symbolic|canonical|root/iu)
  })

  it('reads only a canonical marker for an existing in-tree release', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot, { recursive: true })
    const fingerprint = 'b'.repeat(64)
    const release = createRelease(cacheRoot, fingerprint)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${fingerprint}","schemaVersion":1}\n`)

    await expect(readActiveDevelopmentRelease({ cacheRoot })).resolves.toBe(release)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${'c'.repeat(64)}","schemaVersion":1}\n`)
    await expect(readActiveDevelopmentRelease({ cacheRoot })).rejects.toThrow(/release|exist/iu)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${fingerprint}","schemaVersion":1,"extra":true}\n`)
    await expect(readActiveDevelopmentRelease({ cacheRoot })).rejects.toThrow(/marker|schema|key/iu)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"schemaVersion":1,"fingerprint":"${fingerprint}"}\n`)
    await expect(readActiveDevelopmentRelease({ cacheRoot })).rejects.toThrow(/marker|schema/iu)

    const externalRelease = join(temporaryRoot(), 'external-release')
    mkdirSync(externalRelease)
    rmSync(release, { recursive: true })
    symlinkSync(externalRelease, release)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${fingerprint}","schemaVersion":1}\n`)
    await expect(readActiveDevelopmentRelease({ cacheRoot })).rejects.toThrow(/release|symbolic|inside/iu)
  })

  it('removes only a confirmed inactive release and never deletes a newly active winner', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(join(cacheRoot, 'sources'), { recursive: true })
    const oldFingerprint = '1'.repeat(64)
    const candidate = '2'.repeat(64)
    createRelease(cacheRoot, oldFingerprint)
    createRelease(cacheRoot, candidate)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${oldFingerprint}","schemaVersion":1}\n`)

    await expect(removeInactiveDevelopmentRelease({ cacheRoot, fingerprint: candidate })).resolves.toBe(true)
    expect(existsSync(join(cacheRoot, 'releases', candidate))).toBe(false)

    createRelease(cacheRoot, candidate)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${candidate}","schemaVersion":1}\n`)
    await expect(removeInactiveDevelopmentRelease({ cacheRoot, fingerprint: candidate })).resolves.toBe(false)
    expect(existsSync(join(cacheRoot, 'releases', candidate))).toBe(true)
  })

  it('activates an existing release atomically without leaking marker temporaries', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot, { recursive: true })
    const oldFingerprint = 'd'.repeat(64)
    const fingerprint = 'e'.repeat(64)
    const release = createRelease(cacheRoot, fingerprint)
    createRelease(cacheRoot, oldFingerprint)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${oldFingerprint}","schemaVersion":1}\n`)

    await expect(activateDevelopmentRelease({ cacheRoot, fingerprint })).resolves.toBe(release)
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toBe(`{"fingerprint":"${fingerprint}","schemaVersion":1}\n`)
    expect(readdirSync(cacheRoot).filter((name) => name.startsWith('.active-release-'))).toEqual([])
  })

  it('preserves the old marker when the final rename fails', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot, { recursive: true })
    const oldFingerprint = 'f'.repeat(64)
    const fingerprint = '0'.repeat(64)
    createRelease(cacheRoot, oldFingerprint)
    createRelease(cacheRoot, fingerprint)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${oldFingerprint}","schemaVersion":1}\n`)

    await expect(activateDevelopmentRelease({ cacheRoot, fingerprint }, {
      rename: async () => { throw new Error('rename failed') },
    })).rejects.toThrow('rename failed')
    await expect(readActiveDevelopmentRelease({ cacheRoot })).resolves.toBe(join(cacheRoot, 'releases', oldFingerprint))
    expect(readdirSync(cacheRoot).filter((name) => name.startsWith('.active-release-'))).toEqual([])
  })

  it('publishes immutable metadata only for a canonical existing release and complete blobs', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(join(cacheRoot, 'sources'), { recursive: true })
    const fingerprint = '1'.repeat(64)
    const blob = '2'.repeat(64)
    createRelease(cacheRoot, fingerprint)
    writeFileSync(join(cacheRoot, 'sources', `${blob}.archive`), 'blob')

    const metadata = await writeDevelopmentReleaseMetadata({
      cacheRoot, fingerprint, blobs: [{ sha256: blob, bytes: 4 }],
    })
    expect(readFileSync(metadata, 'utf8')).toBe(
      `{"blobs":[{"bytes":4,"sha256":"${blob}"}],"fingerprint":"${fingerprint}","release":"releases/${fingerprint}","schemaVersion":1}`,
    )
    await expect(writeDevelopmentReleaseMetadata({
      cacheRoot, fingerprint, blobs: [{ sha256: blob, bytes: 4 }],
    })).resolves.toBe(metadata)

    const alias = join(cacheRoot, 'sources', 'alias.archive')
    symlinkSync(join(cacheRoot, 'sources', `${blob}.archive`), alias)
    await expect(writeDevelopmentReleaseMetadata({
      cacheRoot, fingerprint: '3'.repeat(64), blobs: [{ sha256: 'alias', bytes: 4, path: alias }],
    })).rejects.toThrow()
  })

  it('fails closed when existing release metadata does not match the requested payload', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(join(cacheRoot, 'sources'), { recursive: true })
    mkdirSync(join(cacheRoot, 'release-metadata'))
    const fingerprint = '3'.repeat(64)
    createRelease(cacheRoot, fingerprint)
    const metadata = join(cacheRoot, 'release-metadata', `${fingerprint}.json`)
    writeFileSync(metadata, 'wrong', { mode: 0o444 })

    await expect(writeDevelopmentReleaseMetadata({ cacheRoot, fingerprint, blobs: [] }))
      .rejects.toThrow(/metadata|match|unsafe/iu)
    expect(readFileSync(metadata, 'utf8')).toBe('wrong')
  })

  it('serializes public activation against pruning so the marker never names a deleted release', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(join(cacheRoot, 'sources'), { recursive: true })
    const oldFingerprint = '4'.repeat(64)
    const nextFingerprint = '5'.repeat(64)
    createRelease(cacheRoot, oldFingerprint)
    createRelease(cacheRoot, nextFingerprint)
    await writeDevelopmentReleaseMetadata({ cacheRoot, fingerprint: oldFingerprint, blobs: [] })
    await writeDevelopmentReleaseMetadata({ cacheRoot, fingerprint: nextFingerprint, blobs: [] })
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${oldFingerprint}","schemaVersion":1}\n`)
    const marker = join(cacheRoot, 'activation-ready')
    const release = join(cacheRoot, 'activation-release')
    const moduleUrl = new URL('../../scripts/converter-packs/local-development-release-cache.mjs', import.meta.url).href
    const script = String.raw`
      import { access, writeFile } from 'node:fs/promises'
      const [moduleUrl, cacheRoot, fingerprint, marker, release] = process.argv.slice(1)
      const { activateDevelopmentRelease } = await import(moduleUrl)
      await activateDevelopmentRelease({ cacheRoot, fingerprint }, {
        beforePublishForTest: async () => {
          await writeFile(marker, 'ready')
          while (true) {
            try { await access(release); break } catch { await new Promise((resolve) => setTimeout(resolve, 20)) }
          }
        },
      })
    `
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', script, moduleUrl, cacheRoot, nextFingerprint, marker, release,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    children.add(child)
    await waitUntil(() => existsSync(marker))
    const { pruneDevelopmentCache } = await import('../../scripts/converter-packs/development-cache-budget.mjs')
    await expect(pruneDevelopmentCache({ cacheRoot, activeFingerprint: oldFingerprint, maximumBlobBytes: 1 }))
      .rejects.toThrow('already claimed')
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toContain(oldFingerprint)
    expect(existsSync(join(cacheRoot, 'releases', oldFingerprint))).toBe(true)
    writeFileSync(release, 'release')
    await new Promise<void>((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise)
      child.once('close', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`activation child ${code}`)))
    })
    children.delete(child)
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toContain(nextFingerprint)
    expect(existsSync(join(cacheRoot, 'releases', nextFingerprint))).toBe(true)
  })

  it('fences an initializer resumed after another process takes over its incomplete claim', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const delayed = '6'.repeat(64)
    const winner = '7'.repeat(64)
    createRelease(cacheRoot, delayed)
    createRelease(cacheRoot, winner)
    const ready = join(root, 'claim-ready')
    const resume = join(root, 'claim-resume')
    const moduleUrl = new URL('../../scripts/converter-packs/local-development-release-cache.mjs', import.meta.url).href
    const script = String.raw`
      import { access, writeFile } from 'node:fs/promises'
      const [moduleUrl, cacheRoot, fingerprint, ready, resume] = process.argv.slice(1)
      const { activateDevelopmentRelease } = await import(moduleUrl)
      await activateDevelopmentRelease({ cacheRoot, fingerprint }, {
        afterClaimOpenForTest: async () => {
          await writeFile(ready, 'ready')
          while (true) {
            try { await access(resume); break } catch { await new Promise((resolve) => setTimeout(resolve, 20)) }
          }
        },
      })
    `
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', script, moduleUrl, cacheRoot, delayed, ready, resume,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    children.add(child)
    await waitUntil(() => existsSync(ready))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    await activateDevelopmentRelease({ cacheRoot, fingerprint: winner })
    const closed = new Promise<number | null>((resolvePromise) => child.once('close', resolvePromise))
    writeFileSync(resume, 'resume')
    const exitCode = await closed
    children.delete(child)
    expect(exitCode).not.toBe(0)
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toContain(winner)
  })

  it('does not publish an activation marker after its mutation claim is deleted', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot)
    const oldFingerprint = '8'.repeat(64)
    const nextFingerprint = '9'.repeat(64)
    createRelease(cacheRoot, oldFingerprint)
    createRelease(cacheRoot, nextFingerprint)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${oldFingerprint}","schemaVersion":1}\n`)

    await expect(activateDevelopmentRelease({ cacheRoot, fingerprint: nextFingerprint }, {
      beforePublishForTest: async () => unlinkSync(join(cacheRoot, '.cache-mutation.claim')),
    })).rejects.toThrow(/claim|lost/iu)
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toContain(oldFingerprint)
  })
})
