import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConverterClosureLock, validateTargetClosureLock } from '../../scripts/converter-packs/closure-lock.mjs'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-closure-lock-')))
  temporaryRoots.push(root)
  return root
}

function file(formula: string, sourcePath: string, destination: string, character: string) {
  return { formula, sourcePath, destination, sha256: character.repeat(64), bytes: 10, executable: true, role: 'executable' }
}

function license(formula: string, character: string) {
  return {
    formula, source: 'LICENSE', destination: `licenses/${formula}.LICENSE`,
    sha256: character.repeat(64), bytes: 12,
  }
}

function emptyFamily() {
  return { files: [], rewrites: [], licenses: [] }
}

function closureFixture(target = 'darwin-arm64') {
  return {
    schemaVersion: 1,
    target,
    formulae: [
      { name: 'ffmpeg', version: '9.0.1+1', dependencies: ['glib'] },
      { name: 'glib', version: '2.86.0', dependencies: [] },
      { name: 'poppler', version: '26.8.0', dependencies: ['glib'] },
      { name: 'vips', version: '8.18.6', dependencies: ['glib'] },
    ],
    families: {
      'image-icon': { files: [file('vips', 'bin/vips', 'bin/vips', 'c')], rewrites: [], licenses: [license('vips', 'c')] },
      document: emptyFamily(),
      pdf: { files: [file('poppler', 'bin/pdfinfo', 'bin/pdfinfo', 'd')], rewrites: [], licenses: [license('poppler', 'd')] },
      media: { files: [file('ffmpeg', 'bin/ffmpeg', 'bin/ffmpeg', 'a')], rewrites: [], licenses: [license('ffmpeg', 'a')] },
    },
    measurements: {
      downloadBytes: 600,
      compressedPackBytes: { 'image-icon': 20, document: 20, pdf: 20, media: 20 },
      installedReleaseBytes: 1_000,
    },
  }
}

function bottle(name: string, target: string, character: string, bytes: number) {
  return {
    kind: 'homebrew-bottle', url: `https://downloads.example.test/${name}-${target}.tar.gz`,
    sha256: character.repeat(64), bytes,
    cellar: target === 'darwin-arm64' ? '/opt/homebrew/Cellar' : '/usr/local/Cellar',
  }
}

function sourceFixture(closureBytes: Buffer, target = 'darwin-arm64') {
  const makeFormula = (name: string, version: string, character: string, bytes: number) => ({
    name, version, revision: 0, license: 'MIT',
    acquisitions: {
      'darwin-arm64': bottle(name, 'darwin-arm64', character, bytes),
      'darwin-x64': bottle(name, 'darwin-x64', character, bytes + 1),
    },
    licenses: [{
      kind: 'bottle-entry', target: 'darwin-arm64', path: 'LICENSE', sha256: character.repeat(64), bytes: 12,
      destination: `licenses/${name}.LICENSE`,
    }, {
      kind: 'bottle-entry', target: 'darwin-x64', path: 'LICENSE', sha256: character.repeat(64), bytes: 12,
      destination: `licenses/${name}.LICENSE`,
    }],
  })
  const formulae = [
    makeFormula('ffmpeg', '9.0.1+1', 'a', 100),
    makeFormula('glib', '2.86.0', 'e', 110),
    makeFormula('poppler', '26.8.0', 'd', 130),
    makeFormula('vips', '8.18.6', 'c', 120),
  ]
  const root = (name: string) => formulae.find((entry) => entry.name === name)!
  const closureCoordinate = {
    path: `closures/${target}.lock.json`,
    sha256: createHash('sha256').update(closureBytes).digest('hex'), bytes: closureBytes.byteLength,
  }
  return {
    schemaVersion: 2, homebrewCoreRevision: '1'.repeat(40), homebrewCaskRevision: '2'.repeat(40),
    targets: ['darwin-arm64', 'darwin-x64'],
    engines: [
      { name: 'ffmpeg', version: '9.0.1+1', license: 'GPL-3.0-or-later', rootFormula: 'ffmpeg', acquisitions: structuredClone(root('ffmpeg').acquisitions) },
      {
        name: 'libreoffice', version: '26.8.0', license: 'MPL-2.0', rootFormula: null,
        acquisitions: {
          'darwin-arm64': { kind: 'dmg', url: 'https://downloads.example.test/libreoffice-arm64.dmg', sha256: 'b'.repeat(64), bytes: 140, cellar: null },
          'darwin-x64': { kind: 'dmg', url: 'https://downloads.example.test/libreoffice-x64.dmg', sha256: 'f'.repeat(64), bytes: 141, cellar: null },
        },
      },
      { name: 'libvips', version: '8.18.6', license: 'LGPL-2.1-or-later', rootFormula: 'vips', acquisitions: structuredClone(root('vips').acquisitions) },
      { name: 'poppler', version: '26.8.0', license: 'GPL-3.0-only', rootFormula: 'poppler', acquisitions: structuredClone(root('poppler').acquisitions) },
    ],
    formulae,
    closureLocks: {
      'darwin-arm64': target === 'darwin-arm64' ? closureCoordinate : { path: 'closures/darwin-arm64.lock.json', sha256: '6'.repeat(64), bytes: 1 },
      'darwin-x64': target === 'darwin-x64' ? closureCoordinate : { path: 'closures/darwin-x64.lock.json', sha256: '7'.repeat(64), bytes: 1 },
    },
  }
}

function writeAuthenticatedFixture(root: string, closure = closureFixture()) {
  const closureBytes = canonicalBytes(closure)
  mkdirSync(join(root, 'closures'))
  const closurePath = join(root, 'closures', `${closure.target}.lock.json`)
  writeFileSync(closurePath, closureBytes)
  const otherTarget = closure.target === 'darwin-arm64' ? 'darwin-x64' : 'darwin-arm64'
  const otherClosure = closureFixture(otherTarget)
  otherClosure.measurements.downloadBytes = otherTarget === 'darwin-arm64' ? 600 : 605
  const otherBytes = canonicalBytes(otherClosure)
  writeFileSync(join(root, 'closures', `${otherTarget}.lock.json`), otherBytes)
  const sourcePath = join(root, 'sources.lock.json')
  const source = sourceFixture(closureBytes, closure.target)
  source.closureLocks[otherTarget] = {
    path: `closures/${otherTarget}.lock.json`,
    sha256: createHash('sha256').update(otherBytes).digest('hex'),
    bytes: otherBytes.byteLength,
  }
  writeFileSync(sourcePath, canonicalBytes(source))
  return { sourcePath, closurePath, closureBytes }
}

describe('converter target closure lock', () => {
  it('loads an authenticated canonical closure and returns frozen records', async () => {
    const { sourcePath } = writeAuthenticatedFixture(temporaryRoot())

    const loaded = await loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' })

    expect(loaded.target).toBe('darwin-arm64')
    expect(loaded.closureLock).toEqual(closureFixture())
    expect(loaded.sourceLock.formulae.map(({ name }: { name: string }) => name)).toEqual(['ffmpeg', 'glib', 'poppler', 'vips'])
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(Object.isFrozen(loaded.closureLock.families.media.files[0])).toBe(true)
  })

  it('authenticates and selects each of the two canonical target fixtures', async () => {
    const { sourcePath } = writeAuthenticatedFixture(temporaryRoot())

    const arm64 = await loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' })
    const x64 = await loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-x64' })

    expect(arm64.closureLock.target).toBe('darwin-arm64')
    expect(x64.closureLock.target).toBe('darwin-x64')
    expect(x64.closureLock.measurements.downloadBytes).toBe(605)
  })

  it.each([
    ['unknown key', (value: ReturnType<typeof closureFixture>) => { Object.assign(value, { typo: true }) }],
    ['unsorted formulae', (value: ReturnType<typeof closureFixture>) => { value.formulae.reverse() }],
    ['duplicate formula', (value: ReturnType<typeof closureFixture>) => { value.formulae[1] = structuredClone(value.formulae[0]!) }],
    ['unknown dependency', (value: ReturnType<typeof closureFixture>) => { value.formulae[0]!.dependencies = ['unknown'] }],
    ['duplicate dependency', (value: ReturnType<typeof closureFixture>) => { value.formulae[0]!.dependencies = ['glib', 'glib'] }],
    ['target mismatch', (value: ReturnType<typeof closureFixture>) => { value.target = 'darwin-x64' }],
    ['undeclared file formula', (value: ReturnType<typeof closureFixture>) => { value.families.media.files[0]!.formula = 'unknown' }],
    ['unsafe sourcePath', (value: ReturnType<typeof closureFixture>) => { value.families.media.files[0]!.sourcePath = '../ffmpeg' }],
    ['duplicate family file', (value: ReturnType<typeof closureFixture>) => { value.families.media.files.push(structuredClone(value.families.media.files[0]!)) }],
    ['case-folded destination collision', (value: ReturnType<typeof closureFixture>) => {
      value.families.media.files.push(file('ffmpeg', 'bin/ffprobe', 'BIN/FFMPEG', '9'))
    }],
    ['invalid rewrite', (value: ReturnType<typeof closureFixture>) => {
      value.families.media.rewrites.push({ destination: 'bin/missing', dependency: '@rpath/libx.dylib', replacement: '/usr/local/libx.dylib' } as never)
    }],
    ['incomplete family record', (value: ReturnType<typeof closureFixture>) => { delete (value.families as Record<string, unknown>).document }],
    ['zero pack measurement', (value: ReturnType<typeof closureFixture>) => { value.measurements.compressedPackBytes.media = 0 }],
    ['zero download measurement', (value: ReturnType<typeof closureFixture>) => { value.measurements.downloadBytes = 0 }],
    ['zero release measurement', (value: ReturnType<typeof closureFixture>) => { value.measurements.installedReleaseBytes = 0 }],
  ])('rejects %s', (_label, mutate) => {
    const value = closureFixture()
    mutate(value)
    expect(() => validateTargetClosureLock(value, 'darwin-arm64'))
      .toThrow('Target closure lock has an invalid schema.')
  })

  it('rejects a cyclic dependency graph with a fixed diagnostic', () => {
    const value = closureFixture()
    value.formulae[1]!.dependencies = ['ffmpeg']
    expect(() => validateTargetClosureLock(value, 'darwin-arm64'))
      .toThrow('Converter formula dependency graph contains a cycle.')
  })

  it('rejects a closure byte mismatch before JSON parsing', async () => {
    const root = temporaryRoot()
    const { sourcePath, closurePath } = writeAuthenticatedFixture(root)
    writeFileSync(closurePath, Buffer.from('{'))
    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .rejects.toThrow('Target closure lock byte length does not match its source lock.')
  })

  it('rejects a closure hash mismatch and noncanonical closure JSON', async () => {
    const root = temporaryRoot()
    const closure = closureFixture()
    const canonical = canonicalBytes(closure)
    const source = sourceFixture(canonical)
    mkdirSync(join(root, 'closures'))
    const sourcePath = join(root, 'sources.lock.json')
    const closurePath = join(root, 'closures', 'darwin-arm64.lock.json')

    writeFileSync(sourcePath, canonicalBytes({
      ...source,
      closureLocks: { ...source.closureLocks, 'darwin-arm64': { ...source.closureLocks['darwin-arm64'], sha256: '0'.repeat(64) } },
    }))
    writeFileSync(closurePath, canonical)
    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .rejects.toThrow('Target closure lock hash does not match its source lock.')

    const pretty = Buffer.from(JSON.stringify(closure, null, 2))
    writeFileSync(sourcePath, canonicalBytes(sourceFixture(pretty)))
    writeFileSync(closurePath, pretty)
    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .rejects.toThrow('Target closure lock is not canonical JSON.')
  })

  it('rejects a closure symlink', async () => {
    const root = temporaryRoot()
    const { sourcePath, closurePath, closureBytes } = writeAuthenticatedFixture(root)
    rmSync(closurePath)
    const other = join(root, 'other.json')
    writeFileSync(other, closureBytes)
    symlinkSync(other, closurePath)
    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .rejects.toThrow('Target closure lock must be one regular, non-linked file; symbolic links are forbidden.')
  })

  it('rejects a measurement that disagrees with unique selected downloads', async () => {
    const root = temporaryRoot()
    const closure = closureFixture()
    closure.measurements.downloadBytes += 1
    const { sourcePath } = writeAuthenticatedFixture(root, closure)
    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .rejects.toThrow('Target closure lock download measurement is inconsistent.')
  })
})
