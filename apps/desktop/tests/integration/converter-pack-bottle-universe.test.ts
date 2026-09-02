import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readVerifiedBottleEntries } from '../../scripts/converter-packs/bottle-archive.mjs'
import { extractVerifiedBottle, materializeBottleUniverse } from '../../scripts/converter-packs/bottle-universe.mjs'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-bottle-universe-')))
  temporaryRoots.push(root)
  return root
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function writeString(header: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value, 'utf8').copy(header, offset, 0, length)
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  writeString(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

type TarFixtureEntry = {
  path: string
  type?: '0' | '2' | '5' | 'x' | 'g' | '1' | '3'
  bytes?: Buffer
  linkpath?: string
  mode?: number
  headerSize?: number
  mutateHeader?: (header: Buffer) => void
}

function tarEntry(entry: TarFixtureEntry): Buffer[] {
  const bytes = entry.bytes ?? Buffer.alloc(0)
  const header = Buffer.alloc(512)
  writeString(header, 0, 100, entry.path)
  writeOctal(header, 100, 8, entry.mode ?? (entry.type === '5' ? 0o755 : 0o444))
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, entry.headerSize ?? bytes.byteLength)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  writeString(header, 156, 1, entry.type ?? '0')
  writeString(header, 157, 100, entry.linkpath ?? '')
  writeString(header, 257, 6, 'ustar\0')
  writeString(header, 263, 2, '00')
  const checksum = header.reduce((sum, value) => sum + value, 0)
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  entry.mutateHeader?.(header)
  return [header, bytes, Buffer.alloc((512 - (bytes.byteLength % 512)) % 512)]
}

function gzipTar(entries: TarFixtureEntry[]): Buffer {
  return gzipSync(Buffer.concat([...entries.flatMap(tarEntry), Buffer.alloc(1_024)]), { mtime: 0 })
}

function paxRecord(key: 'path' | 'linkpath' | 'size', value: string): Buffer {
  const body = `${key}=${value}\n`
  let length = Buffer.byteLength(body) + 2
  while (Buffer.byteLength(`${length} ${body}`) !== length) length = Buffer.byteLength(`${length} ${body}`)
  return Buffer.from(`${length} ${body}`)
}

function writeBottleArchive(root: string, name: string, entries: TarFixtureEntry[]) {
  const compressed = gzipTar(entries)
  const archive = join(root, name)
  writeFileSync(archive, compressed)
  return { archive, compressed, sha256: sha256(compressed) }
}

function file(formula: string, sourcePath: string, destination: string, bytes: Buffer, executable: boolean, role: 'executable' | 'code' | 'data') {
  return { formula, sourcePath, destination, sha256: sha256(bytes), bytes: bytes.byteLength, executable, role }
}

describe('converter bottle universe', () => {
  it('materializes one verified formula once for multiple families behind immutable exact lookups', async () => {
    const root = temporaryRoot()
    const executable = Buffer.from('#!/bin/sh\necho vips\n')
    const library = Buffer.from('fixture dylib bytes')
    const license = Buffer.from('fixture license\n')
    const compressed = gzipTar([
      { path: 'vips/', type: '5' },
      { path: 'vips/8.18.6/', type: '5' },
      { path: 'vips/8.18.6/bin/', type: '5' },
      { path: 'vips/8.18.6/bin/vips', bytes: executable, mode: 0o555 },
      { path: 'vips/8.18.6/lib/', type: '5' },
      { path: 'vips/8.18.6/lib/libvips.dylib', bytes: library },
      { path: 'vips/8.18.6/LICENSE', bytes: license },
      { path: 'vips/8.18.6/share/', type: '5' },
      { path: 'vips/8.18.6/share/not-selected.dat', bytes: Buffer.from('must not be materialized') },
    ])
    const archive = join(root, 'vips.tar.gz')
    writeFileSync(archive, compressed)
    const acquisition = {
      kind: 'homebrew-bottle', url: 'https://downloads.example.test/vips.tar.gz',
      sha256: sha256(compressed), bytes: compressed.byteLength, cellar: '/opt/homebrew/Cellar',
    }
    const vipsExecutable = file('vips', 'bin/vips', 'bin/vips', executable, true, 'executable')
    const vipsLibrary = file('vips', 'lib/libvips.dylib', 'lib/libvips.dylib', library, false, 'code')
    const closureLock = {
      target: 'darwin-arm64', formulae: [{ name: 'vips', version: '8.18.6', dependencies: [] }],
      families: {
        'image-icon': {
          files: [vipsExecutable, vipsLibrary], rewrites: [],
          licenses: [{ formula: 'vips', source: 'LICENSE', destination: 'licenses/vips.txt', sha256: sha256(license), bytes: license.byteLength }],
        },
        document: { files: [], rewrites: [], licenses: [] },
        pdf: { files: [structuredClone(vipsLibrary)], rewrites: [], licenses: [] },
        media: { files: [], rewrites: [], licenses: [] },
      },
    }
    const formulae = [{
      name: 'vips', version: '8.18.6', acquisition,
      licenses: [{ kind: 'bottle-entry', target: 'darwin-arm64', path: 'LICENSE', sha256: sha256(license), bytes: license.byteLength, destination: 'licenses/vips.txt' }],
    }]

    const entries = await readVerifiedBottleEntries({
      archive, expectedBytes: compressed.byteLength, expectedSha256: sha256(compressed),
    })
    expect(entries.map((entry: { path: string }) => entry.path)).toContain('vips/8.18.6/bin/vips')

    const outputRoot = join(root, 'universe')
    const universe = await materializeBottleUniverse({
      target: 'darwin-arm64', closureLock, formulae,
      blobs: new Map([[acquisition.sha256, { path: archive, sha256: acquisition.sha256, bytes: acquisition.bytes, networkBytes: 0 }]]),
      outputRoot,
    })

    const versionRoot = join(outputRoot, 'Cellar', 'vips', '8.18.6')
    expect(universe.target).toBe('darwin-arm64')
    expect(universe.cellar('vips', '8.18.6')).toBe(versionRoot)
    expect(universe.opt('vips')).toBe(versionRoot)
    expect(universe.resolveLockedFile('vips', 'bin/vips')).toBe(join(versionRoot, 'bin', 'vips'))
    expect(universe.contains(join(versionRoot, 'lib', 'libvips.dylib'))).toBe(true)
    expect(universe.contains(join(versionRoot, 'share', 'not-selected.dat'))).toBe(false)
    expect(universe.contains(join(root, 'outside'))).toBe(false)
    expect(() => universe.cellar('vips', 'wrong-version')).toThrow('not locked')
    expect(() => universe.opt('unknown')).toThrow('not locked')
    expect(() => universe.resolveLockedFile('vips', 'share/not-selected.dat')).toThrow('not locked')
    expect(Object.isFrozen(universe)).toBe(true)
    expect(readFileSync(join(versionRoot, 'bin', 'vips'))).toEqual(executable)
    expect(readFileSync(join(versionRoot, 'lib', 'libvips.dylib'))).toEqual(library)
    expect(readFileSync(join(versionRoot, 'LICENSE'))).toEqual(license)
    expect(existsSync(join(versionRoot, 'share', 'not-selected.dat'))).toBe(false)
    expect(statSync(join(versionRoot, 'bin', 'vips')).mode & 0o777).toBe(0o755)
    expect(statSync(join(versionRoot, 'lib', 'libvips.dylib')).mode & 0o777).toBe(0o644)
    expect(existsSync(join(outputRoot, 'opt'))).toBe(false)
  })

  it('applies bounded local PAX records and copies a selected internal symlink as verified regular bytes', async () => {
    const root = temporaryRoot()
    const library = Buffer.from('versioned library')
    const paxPath = 'vips/8.18.6/lib/libvips.1.dylib'
    const aliasPath = 'vips/8.18.6/lib/libvips.dylib'
    const compressed = gzipTar([
      { path: 'vips/', type: '5' },
      { path: 'vips/8.18.6/', type: '5' },
      { path: 'vips/8.18.6/lib/', type: '5' },
      { path: 'PaxHeaders/libvips', type: 'x', bytes: Buffer.concat([paxRecord('path', paxPath), paxRecord('size', String(library.byteLength))]) },
      { path: 'placeholder', bytes: library, headerSize: 0 },
      { path: 'PaxHeaders/alias', type: 'x', bytes: Buffer.concat([paxRecord('path', aliasPath), paxRecord('linkpath', 'libvips.1.dylib')]) },
      { path: 'alias', type: '2', linkpath: 'placeholder', mode: 0o777 },
    ])
    const archive = join(root, 'vips-pax.tar.gz')
    writeFileSync(archive, compressed)
    const acquisition = {
      kind: 'homebrew-bottle', url: 'https://downloads.example.test/vips-pax.tar.gz',
      sha256: sha256(compressed), bytes: compressed.byteLength, cellar: '/opt/homebrew/Cellar',
    }
    const selectedEntries = ['lib/libvips.1.dylib', 'lib/libvips.dylib'].map((sourcePath) => ({
      sourcePath, sha256: sha256(library), bytes: library.byteLength, executable: false, role: 'code',
    }))
    const destinationParent = join(root, 'Cellar', 'vips')
    mkdirSync(destinationParent, { recursive: true })
    const destination = join(destinationParent, '8.18.6')

    await extractVerifiedBottle({
      archive,
      coordinate: { name: 'vips', version: '8.18.6', acquisition },
      selectedEntries,
      destination,
    })

    expect(readFileSync(join(destination, 'lib', 'libvips.1.dylib'))).toEqual(library)
    expect(readFileSync(join(destination, 'lib', 'libvips.dylib'))).toEqual(library)
    expect(statSync(join(destination, 'lib', 'libvips.dylib')).isSymbolicLink()).toBe(false)
    expect(statSync(join(destination, 'lib', 'libvips.dylib')).mode & 0o777).toBe(0o644)
  })

  it.each([
    ['malformed PAX length', [{ path: 'PaxHeaders/bad', type: 'x' as const, bytes: Buffer.from('99 path=x\n') }]],
    ['global PAX header', [{ path: 'GlobalHead', type: 'g' as const, bytes: paxRecord('path', 'vips/8.18.6/bin/vips') }]],
    ['traversal', [{ path: '../escape', bytes: Buffer.from('x') }]],
    ['hard link', [{ path: 'vips/8.18.6/bin/vips', type: '1' as const, linkpath: 'target' }]],
    ['special file', [{ path: 'vips/8.18.6/device', type: '3' as const }]],
    ['absolute symbolic link', [{ path: 'vips/8.18.6/lib/alias', type: '2' as const, linkpath: '/tmp/target', mode: 0o777 }]],
    ['escaping symbolic link', [{ path: 'vips/8.18.6/lib/alias', type: '2' as const, linkpath: '../../../../escape', mode: 0o777 }]],
    ['case-fold collision', [
      { path: 'vips/8.18.6/bin/tool', bytes: Buffer.from('a') },
      { path: 'vips/8.18.6/BIN/TOOL', bytes: Buffer.from('b') },
    ]],
    ['duplicate entry', [
      { path: 'vips/8.18.6/bin/tool', bytes: Buffer.from('a') },
      { path: 'vips/8.18.6/bin/tool', bytes: Buffer.from('a') },
    ]],
    ['bad header checksum', [{
      path: 'vips/8.18.6/bin/tool', bytes: Buffer.from('a'), mutateHeader: (header: Buffer) => { header[0] ^= 1 },
    }]],
    ['expanded size beyond four GiB', [
      { path: 'PaxHeaders/huge', type: 'x' as const, bytes: paxRecord('size', String(4 * 1024 * 1024 * 1024 + 1)) },
      { path: 'vips/8.18.6/huge', bytes: Buffer.alloc(0) },
    ]],
  ])('rejects an archive containing %s', async (_name, entries) => {
    const root = temporaryRoot()
    const fixture = writeBottleArchive(root, 'invalid.tar.gz', entries)

    await expect(readVerifiedBottleEntries({
      archive: fixture.archive,
      expectedBytes: fixture.compressed.byteLength,
      expectedSha256: fixture.sha256,
    })).rejects.toThrow('Bottle archive is invalid.')
  })

  it('authenticates compressed bytes before parsing gzip or tar content', async () => {
    const root = temporaryRoot()
    const fixture = writeBottleArchive(root, 'authenticated.tar.gz', [{ path: 'vips/8.18.6/bin/vips', bytes: Buffer.from('vips') }])

    await expect(readVerifiedBottleEntries({
      archive: fixture.archive,
      expectedBytes: fixture.compressed.byteLength + 1,
      expectedSha256: fixture.sha256,
    })).rejects.toThrow()
    await expect(readVerifiedBottleEntries({
      archive: fixture.archive,
      expectedBytes: fixture.compressed.byteLength,
      expectedSha256: '0'.repeat(64),
    })).rejects.toThrow('Bottle archive is invalid.')
    const linkedArchive = join(root, 'linked.tar.gz')
    symlinkSync(fixture.archive, linkedArchive)
    await expect(readVerifiedBottleEntries({
      archive: linkedArchive,
      expectedBytes: fixture.compressed.byteLength,
      expectedSha256: fixture.sha256,
    })).rejects.toThrow('symbolic links')

    const malformed = join(root, 'not-gzip.tar.gz')
    const bytes = Buffer.from('not gzip')
    writeFileSync(malformed, bytes)
    await expect(readVerifiedBottleEntries({
      archive: malformed, expectedBytes: bytes.byteLength, expectedSha256: sha256(bytes),
    })).rejects.toThrow('Bottle archive is invalid.')
  })

  it.each([
    ['link cycle', () => ({
      entries: [
        { path: 'vips/', type: '5' as const },
        { path: 'vips/8.18.6/', type: '5' as const },
        { path: 'vips/8.18.6/lib/a', type: '2' as const, linkpath: 'b', mode: 0o777 },
        { path: 'vips/8.18.6/lib/b', type: '2' as const, linkpath: 'a', mode: 0o777 },
      ],
      selected: [{ sourcePath: 'lib/a', sha256: sha256(Buffer.from('x')), bytes: 1, executable: false, role: 'code' }],
    })],
    ['undeclared formula/version', () => {
      const bytes = Buffer.from('tool')
      return {
        entries: [
          { path: 'vips/', type: '5' as const },
          { path: 'vips/8.18.6/', type: '5' as const },
          { path: 'vips/8.18.6/bin/tool', bytes, mode: 0o555 },
          { path: 'other/1.0/file', bytes: Buffer.from('other') },
        ],
        selected: [{ sourcePath: 'bin/tool', sha256: sha256(bytes), bytes: bytes.byteLength, executable: true, role: 'executable' }],
      }
    }],
    ['file hash disagreement', () => {
      const bytes = Buffer.from('tool')
      return {
        entries: [{ path: 'vips/8.18.6/bin/tool', bytes, mode: 0o555 }],
        selected: [{ sourcePath: 'bin/tool', sha256: '0'.repeat(64), bytes: bytes.byteLength, executable: true, role: 'executable' }],
      }
    }],
    ['file byte-length disagreement', () => {
      const bytes = Buffer.from('tool')
      return {
        entries: [{ path: 'vips/8.18.6/bin/tool', bytes, mode: 0o555 }],
        selected: [{ sourcePath: 'bin/tool', sha256: sha256(bytes), bytes: bytes.byteLength + 1, executable: true, role: 'executable' }],
      }
    }],
    ['file mode disagreement', () => {
      const bytes = Buffer.from('library')
      return {
        entries: [{ path: 'vips/8.18.6/lib/library', bytes, mode: 0o755 }],
        selected: [{ sourcePath: 'lib/library', sha256: sha256(bytes), bytes: bytes.byteLength, executable: false, role: 'code' }],
      }
    }],
    ['extra selected file', () => {
      const bytes = Buffer.from('tool')
      return {
        entries: [{ path: 'vips/8.18.6/bin/tool', bytes, mode: 0o555 }],
        selected: [
          { sourcePath: 'bin/tool', sha256: sha256(bytes), bytes: bytes.byteLength, executable: true, role: 'executable' },
          { sourcePath: 'bin/missing', sha256: sha256(bytes), bytes: bytes.byteLength, executable: true, role: 'executable' },
        ],
      }
    }],
    ['selected link whose regular target is not selected', () => {
      const bytes = Buffer.from('library')
      return {
        entries: [
          { path: 'vips/8.18.6/lib/library.1', bytes },
          { path: 'vips/8.18.6/lib/library', type: '2' as const, linkpath: 'library.1', mode: 0o777 },
        ],
        selected: [{ sourcePath: 'lib/library', sha256: sha256(bytes), bytes: bytes.byteLength, executable: false, role: 'code' }],
      }
    }],
  ])('rejects %s and removes its private extraction root', async (_name, fixtureFactory) => {
    const root = temporaryRoot()
    const fixture = fixtureFactory()
    const bottle = writeBottleArchive(root, 'rejected.tar.gz', fixture.entries)
    const parent = join(root, 'Cellar', 'vips')
    mkdirSync(parent, { recursive: true })
    const destination = join(parent, '8.18.6')

    await expect(extractVerifiedBottle({
      archive: bottle.archive,
      coordinate: {
        name: 'vips', version: '8.18.6',
        acquisition: { kind: 'homebrew-bottle', sha256: bottle.sha256, bytes: bottle.compressed.byteLength },
      },
      selectedEntries: fixture.selected,
      destination,
    })).rejects.toThrow('Bottle universe inventory is invalid.')
    expect(existsSync(destination)).toBe(false)
    expect(readdirSync(parent).filter((name) => name.startsWith('.bottle-extract-'))).toEqual([])
  })

  it('rejects an existing output symlink without modifying its target', async () => {
    const root = temporaryRoot()
    const bytes = Buffer.from('tool')
    const bottle = writeBottleArchive(root, 'output-link.tar.gz', [{ path: 'vips/8.18.6/bin/tool', bytes, mode: 0o555 }])
    const parent = join(root, 'Cellar', 'vips')
    const external = join(root, 'external')
    mkdirSync(parent, { recursive: true })
    mkdirSync(external)
    writeFileSync(join(external, 'keep'), 'keep')
    const destination = join(parent, '8.18.6')
    symlinkSync(external, destination)

    await expect(extractVerifiedBottle({
      archive: bottle.archive,
      coordinate: {
        name: 'vips', version: '8.18.6',
        acquisition: { kind: 'homebrew-bottle', sha256: bottle.sha256, bytes: bottle.compressed.byteLength },
      },
      selectedEntries: [{ sourcePath: 'bin/tool', sha256: sha256(bytes), bytes: bytes.byteLength, executable: true, role: 'executable' }],
      destination,
    })).rejects.toThrow('Bottle universe inventory is invalid.')
    expect(readFileSync(join(external, 'keep'), 'utf8')).toBe('keep')
  })

  it('publishes the whole universe atomically and removes it when a later formula fails verification', async () => {
    const root = temporaryRoot()
    const alphaBytes = Buffer.from('alpha executable')
    const betaBytes = Buffer.from('beta executable')
    const alphaBottle = writeBottleArchive(root, 'alpha.tar.gz', [{ path: 'alpha/1.0/bin/alpha', bytes: alphaBytes, mode: 0o555 }])
    const betaBottle = writeBottleArchive(root, 'beta.tar.gz', [{ path: 'beta/2.0/bin/beta', bytes: betaBytes, mode: 0o555 }])
    const alphaAcquisition = {
      kind: 'homebrew-bottle', sha256: alphaBottle.sha256, bytes: alphaBottle.compressed.byteLength,
    }
    const betaAcquisition = {
      kind: 'homebrew-bottle', sha256: betaBottle.sha256, bytes: betaBottle.compressed.byteLength,
    }
    const closureLock = {
      target: 'darwin-arm64',
      formulae: [
        { name: 'alpha', version: '1.0', dependencies: [] },
        { name: 'beta', version: '2.0', dependencies: [] },
      ],
      families: {
        'image-icon': {
          files: [
            file('alpha', 'bin/alpha', 'bin/alpha', alphaBytes, true, 'executable'),
            { ...file('beta', 'bin/beta', 'bin/beta', betaBytes, true, 'executable'), sha256: '0'.repeat(64) },
          ],
          rewrites: [], licenses: [],
        },
        document: { files: [], rewrites: [], licenses: [] },
        pdf: { files: [], rewrites: [], licenses: [] },
        media: { files: [], rewrites: [], licenses: [] },
      },
    }
    const outputRoot = join(root, 'universe')

    await expect(materializeBottleUniverse({
      target: 'darwin-arm64', closureLock,
      formulae: [
        { name: 'alpha', version: '1.0', acquisition: alphaAcquisition, licenses: [] },
        { name: 'beta', version: '2.0', acquisition: betaAcquisition, licenses: [] },
      ],
      blobs: new Map([
        [alphaBottle.sha256, { path: alphaBottle.archive, sha256: alphaBottle.sha256, bytes: alphaBottle.compressed.byteLength }],
        [betaBottle.sha256, { path: betaBottle.archive, sha256: betaBottle.sha256, bytes: betaBottle.compressed.byteLength }],
      ]),
      outputRoot,
    })).rejects.toThrow('Bottle universe inventory is invalid.')

    expect(existsSync(outputRoot)).toBe(false)
    expect(readdirSync(root).filter((name) => name.startsWith('.bottle-universe-'))).toEqual([])
  })
})
