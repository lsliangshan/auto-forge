import { mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activateDevelopmentRelease,
  developmentReleasePaths,
  fingerprintDevelopmentRelease,
  readActiveDevelopmentRelease,
} from '../../scripts/converter-packs/local-development-release-cache.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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
})
