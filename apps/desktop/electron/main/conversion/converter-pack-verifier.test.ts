import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalConverterPackIndexBytes,
  selectConverterPack,
  verifyConverterPackIndex,
} from './converter-pack-verifier.js'
import type { ConverterPackIndex } from './converter-pack-types.js'

const sha = '0'.repeat(64)

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]))
}

function canonicalFixtureBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(sortJson(value)), 'utf8')
}

function fixtureIndex(overrides: Record<string, unknown> = {}): ConverterPackIndex {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-29T00:00:00.000Z',
    sequence: 7,
    packs: [{
      name: 'image-icon',
      version: '1.2.3',
      platform: 'darwin',
      arch: 'arm64',
      archiveUrl: 'https://packs.test/image-icon-1.2.3-darwin-arm64.tar',
      archiveSha256: sha,
      archiveBytes: 2_048,
      entries: [{ path: 'bin/image-converter', sha256: sha, bytes: 12, executable: true }],
    }],
    ...overrides,
  } as ConverterPackIndex
}

function signed(index: unknown, keyPair = generateKeyPairSync('ed25519')) {
  return {
    index,
    signature: sign(null, canonicalFixtureBytes(index), keyPair.privateKey).toString('base64'),
    rootPublicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
  }
}

describe('converter pack index verification', () => {
  it('canonicalizes stable-key UTF-8 JSON independently of insertion order', () => {
    const bytes = canonicalConverterPackIndexBytes({ z: 1, a: { z: '万象', a: true }, list: [3, 2, 1] })
    expect(bytes).toEqual(Buffer.from('{"a":{"a":true,"z":"万象"},"list":[3,2,1],"z":1}', 'utf8'))
  })

  it('accepts a detached Ed25519 signature from the pinned root', () => {
    const fixture = signed(fixtureIndex())
    const verified = verifyConverterPackIndex({ ...fixture, minimumSequence: 7 })
    expect(verified).toEqual(fixture.index)
  })

  it('rejects a signature made by a different root', () => {
    const fixture = signed(fixtureIndex())
    const wrongRoot = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
    expect(() => verifyConverterPackIndex({ ...fixture, rootPublicKeyPem: wrongRoot, minimumSequence: 0 }))
      .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }))
  })

  it('fails closed without a pinned Ed25519 public root', () => {
    const fixture = signed(fixtureIndex())
    expect(() => verifyConverterPackIndex({
      index: fixture.index,
      signature: fixture.signature,
      rootPublicKeyPem: undefined,
      minimumSequence: 0,
    })).toThrowError(expect.objectContaining({ reason: 'root_unavailable' }))
  })

  it('rejects an index sequence below the monotonic local floor', () => {
    const fixture = signed(fixtureIndex({ sequence: 6 }))
    expect(() => verifyConverterPackIndex({ ...fixture, minimumSequence: 7 }))
      .toThrowError(expect.objectContaining({ reason: 'index_rollback' }))
  })

  it.each([
    ['unknown schema', { schemaVersion: 2 }],
    ['fractional sequence', { sequence: 7.5 }],
    ['unknown top-level key', { extra: true }],
    ['invalid generatedAt', { generatedAt: 'yesterday' }],
  ])('rejects %s before the index can select a URL', (_label, override) => {
    const fixture = signed(fixtureIndex(override))
    expect(() => verifyConverterPackIndex({ ...fixture, minimumSequence: 0 }))
      .toThrowError(expect.objectContaining({ reason: 'index_invalid' }))
  })

  it.each([
    ['unknown pack name', { name: 'office' }],
    ['invalid semantic version', { version: '1.2' }],
    ['unsupported platform', { platform: 'linux' }],
    ['unsupported Windows architecture', { platform: 'win32', arch: 'arm64' }],
    ['insecure URL', { archiveUrl: 'http://packs.test/archive.tar' }],
    ['uppercase archive hash', { archiveSha256: 'A'.repeat(64) }],
    ['unexpected pack key', { license: 'unknown' }],
  ])('rejects %s', (_label, packOverride) => {
    const base = fixtureIndex()
    const fixture = signed({ ...base, packs: [{ ...base.packs[0]!, ...packOverride }] })
    expect(() => verifyConverterPackIndex({ ...fixture, minimumSequence: 0 }))
      .toThrowError(expect.objectContaining({ reason: 'index_invalid' }))
  })

  it.each([
    ['absolute path', '/bin/tool'],
    ['traversal path', '../bin/tool'],
    ['non-normal path', 'bin/../bin/tool'],
    ['Windows separator', 'bin\\tool'],
    ['Windows reserved name', 'bin/CON'],
    ['trailing dot', 'bin/tool.'],
    ['trailing space', 'bin/tool '],
    ['Windows-forbidden character', 'bin/tool?.exe'],
    ['control character', 'bin/\u0001tool'],
    ['drive separator', 'C:/tool'],
    ['portable-alphabet violation', 'bin/étool'],
    ['non-canonical Unicode path', 'bin/e\u0301tool'],
  ])('rejects an entry with a %s', (_label, path) => {
    const base = fixtureIndex()
    const fixture = signed({
      ...base,
      packs: [{ ...base.packs[0]!, entries: [{ ...base.packs[0]!.entries[0]!, path }] }],
    })
    expect(() => verifyConverterPackIndex({ ...fixture, minimumSequence: 0 }))
      .toThrowError(expect.objectContaining({ reason: 'index_invalid' }))
  })

  it('rejects portable-colliding entry paths and duplicate pack coordinates', () => {
    const base = fixtureIndex()
    const duplicateEntries = signed({
      ...base,
      packs: [{
        ...base.packs[0]!,
        entries: [
          base.packs[0]!.entries[0]!,
          { ...base.packs[0]!.entries[0]!, path: 'BIN/IMAGE-CONVERTER' },
        ],
      }],
    })
    expect(() => verifyConverterPackIndex({ ...duplicateEntries, minimumSequence: 0 }))
      .toThrowError(expect.objectContaining({ reason: 'index_invalid' }))

    const duplicatePacks = signed({ ...base, packs: [base.packs[0]!, { ...base.packs[0]! }] })
    expect(() => verifyConverterPackIndex({ ...duplicatePacks, minimumSequence: 0 }))
      .toThrowError(expect.objectContaining({ reason: 'index_invalid' }))
  })

  it('enforces signed archive, entry-count, per-entry, and expanded-byte caps', () => {
    const base = fixtureIndex()
    const cases = [
      { ...base, packs: [{ ...base.packs[0]!, archiveBytes: 4_097 }] },
      { ...base, packs: [{ ...base.packs[0]!, entries: [base.packs[0]!.entries[0]!, { path: 'bin/second', sha256: sha, bytes: 1, executable: false }] }] },
      { ...base, packs: [{ ...base.packs[0]!, entries: [{ ...base.packs[0]!.entries[0]!, bytes: 2_049 }] }] },
    ]
    for (const index of cases) {
      const fixture = signed(index)
      expect(() => verifyConverterPackIndex({
        ...fixture,
        minimumSequence: 0,
        limits: { maxArchiveBytes: 4_096, maxEntries: 1, maxEntryBytes: 2_048, maxExpandedBytes: 2_048 },
      })).toThrowError(expect.objectContaining({ reason: 'index_invalid' }))
    }
  })

  it('accepts a declared zero-byte non-executable entry', () => {
    const base = fixtureIndex()
    const fixture = signed({
      ...base,
      packs: [{
        ...base.packs[0]!,
        entries: [{
          path: 'NOTICE.txt',
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          bytes: 0,
          executable: false,
        }],
      }],
    })
    expect(verifyConverterPackIndex({ ...fixture, minimumSequence: 0 })).toEqual(fixture.index)
  })

  it('selects only an exact approved name, version, platform, and architecture', () => {
    const base = fixtureIndex()
    const index = {
      ...base,
      packs: [
        base.packs[0]!,
        { ...base.packs[0]!, version: '1.3.0', arch: 'x64' as const },
        { ...base.packs[0]!, name: 'media' as const, version: '2.0.0', platform: 'win32' as const, arch: 'x64' as const },
      ],
    }
    const fixture = signed(index)
    const verified = verifyConverterPackIndex({ ...fixture, minimumSequence: 0 })
    expect(selectConverterPack(verified, {
      name: 'image-icon', version: '1.2.3', platform: 'darwin', arch: 'arm64',
    })).toMatchObject({ name: 'image-icon', version: '1.2.3', platform: 'darwin', arch: 'arm64' })
    expect(() => selectConverterPack(verified, {
      name: 'image-icon', version: '1.2.4', platform: 'darwin', arch: 'arm64',
    })).toThrowError(expect.objectContaining({ reason: 'pack_unavailable' }))
    expect(() => selectConverterPack(verified, {
      name: 'image-icon', version: '1.3.0', platform: 'win32', arch: 'arm64',
    })).toThrowError(expect.objectContaining({ reason: 'platform_unsupported' }))
  })

  it('orders valid large semantic-version identifiers without number precision loss', () => {
    const base = fixtureIndex()
    const index = {
      ...base,
      packs: [
        { ...base.packs[0]!, version: '9007199254740992.0.0' },
        { ...base.packs[0]!, version: '9007199254740993.0.0' },
      ],
    }
    const fixture = signed(index)
    const verified = verifyConverterPackIndex({ ...fixture, minimumSequence: 0 })
    expect(selectConverterPack(verified, {
      name: 'image-icon', platform: 'darwin', arch: 'arm64',
    }).version).toBe('9007199254740993.0.0')
  })

  it('prefers a stable version with hyphenated build metadata over its prerelease', () => {
    const base = fixtureIndex()
    const index = {
      ...base,
      packs: [
        { ...base.packs[0]!, version: '1.0.0+build-1' },
        { ...base.packs[0]!, version: '1.0.0-rc.1' },
      ],
    }
    const fixture = signed(index)
    const verified = verifyConverterPackIndex({ ...fixture, minimumSequence: 0 })
    expect(selectConverterPack(verified, {
      name: 'image-icon', platform: 'darwin', arch: 'arm64',
    }).version).toBe('1.0.0+build-1')
  })
})
