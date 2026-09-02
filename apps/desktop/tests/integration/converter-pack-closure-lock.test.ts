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
  return {
    formula, sourcePath, destination, sha256: character.repeat(64), bytes: 10,
    executable: true, role: 'executable', runtimeRoot: false,
  }
}

function codeFile(formula: string, sourcePath: string, destination: string, character: string, runtimeRoot = false) {
  return {
    formula, sourcePath, destination, sha256: character.repeat(64), bytes: 10,
    executable: false, role: 'code', runtimeRoot,
  }
}

function license(formula: string, character: string) {
  return {
    formula, source: 'LICENSE', destination: `licenses/${formula}.LICENSE`,
    sha256: character.repeat(64), bytes: 12,
  }
}

function emptyFamily() {
  return { files: [], rewrites: [], licenses: [], nativeHelpers: [], engineAssets: [], engineLicenses: [] }
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
      'image-icon': {
        ...emptyFamily(), files: [file('vips', 'bin/vips', 'bin/vips', 'c')], licenses: [license('vips', 'c')],
        nativeHelpers: [{ helper: 'autoforge-image-converter', destination: 'bin/autoforge-image-converter' }],
      },
      document: {
        ...emptyFamily(),
        nativeHelpers: [{ helper: 'autoforge-soffice-launcher', destination: 'program/soffice' }],
        engineAssets: [{
          engine: 'libreoffice', source: 'acquisition', destination: 'share/LibreOffice.dmg',
          sha256: (target === 'darwin-arm64' ? 'b' : 'f').repeat(64), bytes: target === 'darwin-arm64' ? 140 : 141,
          executable: false, role: 'data',
        }],
        engineLicenses: [{
          engine: 'libreoffice', source: 'https://downloads.example.test/libreoffice-LICENSE',
          destination: 'licenses/libreoffice.LICENSE', sha256: '9'.repeat(64), bytes: 15,
        }],
      },
      pdf: {
        ...emptyFamily(), files: [file('poppler', 'bin/pdfinfo', 'bin/pdfinfo', 'd')], licenses: [license('poppler', 'd')],
        nativeHelpers: [{ helper: 'autoforge-pdf-raster', destination: 'bin/autoforge-pdf-raster' }],
      },
      media: {
        ...emptyFamily(),
        files: [
          file('ffmpeg', 'bin/ffmpeg', 'bin/ffmpeg', 'a'),
          codeFile('ffmpeg', 'lib/libffmpeg.dylib', 'lib/ffmpeg/libffmpeg.dylib', '8'),
        ],
        rewrites: [{
          destination: 'bin/ffmpeg',
          dependency: '@@HOMEBREW_CELLAR@@/ffmpeg/9.0.1+1/lib/libffmpeg.dylib',
          replacement: '@loader_path/../lib/ffmpeg/libffmpeg.dylib',
        }],
        licenses: [license('ffmpeg', 'a')],
      },
    },
    measurements: {
      downloadBytes: target === 'darwin-arm64' ? 615 : 620,
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
      { name: 'ffmpeg', version: '9.0.1+1', license: 'GPL-3.0-or-later', rootFormula: 'ffmpeg', acquisitions: structuredClone(root('ffmpeg').acquisitions), licenses: [] },
      {
        name: 'libreoffice', version: '26.8.0', license: 'MPL-2.0', rootFormula: null,
        acquisitions: {
          'darwin-arm64': { kind: 'dmg', url: 'https://downloads.example.test/libreoffice-arm64.dmg', sha256: 'b'.repeat(64), bytes: 140, cellar: null },
          'darwin-x64': { kind: 'dmg', url: 'https://downloads.example.test/libreoffice-x64.dmg', sha256: 'f'.repeat(64), bytes: 141, cellar: null },
        },
        licenses: [{
          kind: 'download', url: 'https://downloads.example.test/libreoffice-LICENSE',
          sha256: '9'.repeat(64), bytes: 15, destination: 'licenses/libreoffice.LICENSE',
        }],
      },
      { name: 'libvips', version: '8.18.6', license: 'LGPL-2.1-or-later', rootFormula: 'vips', acquisitions: structuredClone(root('vips').acquisitions), licenses: [] },
      { name: 'poppler', version: '26.8.0', license: 'GPL-3.0-only', rootFormula: 'poppler', acquisitions: structuredClone(root('poppler').acquisitions), licenses: [] },
    ],
    formulae,
    provenance: {
      repositoryRevision: '3'.repeat(40),
      captures: {
        'darwin-arm64': { captureSha256: '4'.repeat(64), probesSha256: '5'.repeat(64) },
        'darwin-x64': { captureSha256: '6'.repeat(64), probesSha256: '7'.repeat(64) },
      },
    },
    closureLocks: {
      'darwin-arm64': target === 'darwin-arm64' ? closureCoordinate : { path: 'closures/darwin-arm64.lock.json', sha256: '6'.repeat(64), bytes: 1 },
      'darwin-x64': target === 'darwin-x64' ? closureCoordinate : { path: 'closures/darwin-x64.lock.json', sha256: '7'.repeat(64), bytes: 1 },
    },
  }
}

function writeAuthenticatedFixture(
  root: string,
  closure = closureFixture(),
  mutateSource?: (source: ReturnType<typeof sourceFixture>) => void,
) {
  const closureBytes = canonicalBytes(closure)
  mkdirSync(join(root, 'closures'))
  const closurePath = join(root, 'closures', `${closure.target}.lock.json`)
  writeFileSync(closurePath, closureBytes)
  const otherTarget = closure.target === 'darwin-arm64' ? 'darwin-x64' : 'darwin-arm64'
  const otherClosure = closureFixture(otherTarget)
  const otherBytes = canonicalBytes(otherClosure)
  writeFileSync(join(root, 'closures', `${otherTarget}.lock.json`), otherBytes)
  const sourcePath = join(root, 'sources.lock.json')
  const source = sourceFixture(closureBytes, closure.target)
  source.closureLocks[otherTarget] = {
    path: `closures/${otherTarget}.lock.json`,
    sha256: createHash('sha256').update(otherBytes).digest('hex'),
    bytes: otherBytes.byteLength,
  }
  mutateSource?.(source)
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
    expect(x64.closureLock.measurements.downloadBytes).toBe(620)
  })

  it.each([
    ['unknown key', (value: ReturnType<typeof closureFixture>) => { Object.assign(value, { typo: true }) }],
    ['unsorted formulae', (value: ReturnType<typeof closureFixture>) => { value.formulae.reverse() }],
    ['duplicate formula', (value: ReturnType<typeof closureFixture>) => { value.formulae[1] = structuredClone(value.formulae[0]!) }],
    ['unknown dependency', (value: ReturnType<typeof closureFixture>) => { value.formulae[0]!.dependencies = ['unknown'] }],
    ['duplicate dependency', (value: ReturnType<typeof closureFixture>) => { value.formulae[0]!.dependencies = ['glib', 'glib'] }],
    ['unsafe closure formula version', (value: ReturnType<typeof closureFixture>) => { value.formulae[0]!.version = '9.0/1' }],
    ['dot closure formula version', (value: ReturnType<typeof closureFixture>) => { value.formulae[0]!.version = '.' }],
    ['backslash closure formula version', (value: ReturnType<typeof closureFixture>) => { value.formulae[0]!.version = '9.0\\1' }],
    ['target mismatch', (value: ReturnType<typeof closureFixture>) => { value.target = 'darwin-x64' }],
    ['undeclared file formula', (value: ReturnType<typeof closureFixture>) => { value.families.media.files[0]!.formula = 'unknown' }],
    ['unsafe sourcePath', (value: ReturnType<typeof closureFixture>) => { value.families.media.files[0]!.sourcePath = '../ffmpeg' }],
    ['missing runtimeRoot', (value: ReturnType<typeof closureFixture>) => { delete (value.families.media.files[0] as Record<string, unknown>).runtimeRoot }],
    ['runtimeRoot executable', (value: ReturnType<typeof closureFixture>) => { value.families.media.files[0]!.runtimeRoot = true }],
    ['runtimeRoot data', (value: ReturnType<typeof closureFixture>) => {
      value.families.media.files[0]!.executable = false
      value.families.media.files[0]!.role = 'data'
      value.families.media.files[0]!.runtimeRoot = true
    }],
    ['duplicate family file', (value: ReturnType<typeof closureFixture>) => { value.families.media.files.push(structuredClone(value.families.media.files[0]!)) }],
    ['case-folded destination collision', (value: ReturnType<typeof closureFixture>) => {
      value.families.media.files.push(file('ffmpeg', 'bin/ffprobe', 'BIN/FFMPEG', '9'))
    }],
    ['cross-provenance destination collision', (value: ReturnType<typeof closureFixture>) => {
      value.families['image-icon'].nativeHelpers[0]!.destination = 'BIN/VIPS'
    }],
    ['invalid rewrite', (value: ReturnType<typeof closureFixture>) => {
      value.families.media.rewrites.push({ destination: 'bin/missing', dependency: '@rpath/libx.dylib', replacement: '/usr/local/libx.dylib' } as never)
    }],
    ['incomplete family record', (value: ReturnType<typeof closureFixture>) => { delete (value.families as Record<string, unknown>).document }],
    ['zero pack measurement', (value: ReturnType<typeof closureFixture>) => { value.measurements.compressedPackBytes.media = 0 }],
    ['zero download measurement', (value: ReturnType<typeof closureFixture>) => { value.measurements.downloadBytes = 0 }],
    ['download measurement above the 1.8 GB ceiling', (value: ReturnType<typeof closureFixture>) => { value.measurements.downloadBytes = 1_800_000_001 }],
    ['zero release measurement', (value: ReturnType<typeof closureFixture>) => { value.measurements.installedReleaseBytes = 0 }],
  ])('rejects %s', (_label, mutate) => {
    const value = closureFixture()
    mutate(value)
    expect(() => validateTargetClosureLock(value, 'darwin-arm64'))
      .toThrow('Target closure lock has an invalid schema.')
  })

  it.each([
    ['uppercase protocol', 'HTTPS://licenses.example.test/LICENSE'],
    ['uppercase host', 'https://LICENSES.example.test/LICENSE'],
    ['default port', 'https://licenses.example.test:443/LICENSE'],
    ['internal newline', 'https://licenses.example.test/LIC\nENSE'],
    ['raw space', 'https://licenses.example.test/LIC ENSE'],
    ['backslash', 'https://licenses.example.test\\LICENSE'],
  ])('rejects a noncanonical direct-license URL with %s', (_label, source) => {
    const value = closureFixture()
    value.families.media.licenses[0]!.source = source
    expect(() => validateTargetClosureLock(value, 'darwin-arm64'))
      .toThrow('Target closure lock has an invalid schema.')
  })

  it('rejects a cyclic dependency graph with a fixed diagnostic', () => {
    const value = closureFixture()
    value.formulae[1]!.dependencies = ['ffmpeg']
    expect(() => validateTargetClosureLock(value, 'darwin-arm64'))
      .toThrow('Converter formula dependency graph contains a cycle.')
  })

  it('requires rewrite replacements to resolve to declared family files', () => {
    const value = closureFixture()
    value.families.media.rewrites[0]!.replacement = '@loader_path/../lib/ffmpeg/missing.dylib'
    expect(() => validateTargetClosureLock(value, 'darwin-arm64'))
      .toThrow('Target closure lock has an invalid schema.')
  })

  it('rejects two semantic rewrites for the same destination and dependency', () => {
    const value = closureFixture()
    value.families.media.files.push(codeFile(
      'ffmpeg', 'lib/libother.dylib', 'lib/ffmpeg/libother.dylib', '9',
    ))
    value.families.media.rewrites.push({
      destination: 'bin/ffmpeg',
      dependency: '@@HOMEBREW_CELLAR@@/ffmpeg/9.0.1+1/lib/libffmpeg.dylib',
      replacement: '@loader_path/../lib/ffmpeg/libother.dylib',
    })
    expect(() => validateTargetClosureLock(value, 'darwin-arm64'))
      .toThrow('Target closure lock has an invalid schema.')
  })

  it('authenticates both bottle-entry and direct-download family licenses', async () => {
    const root = temporaryRoot()
    const closure = closureFixture()
    const download = {
      kind: 'download', url: 'https://licenses.example.test/vips-COPYING', sha256: '5'.repeat(64),
      bytes: 15, destination: 'licenses/vips.LICENSE',
    }
    closure.families['image-icon'].licenses[0] = {
      formula: 'vips', source: download.url, destination: download.destination,
      sha256: download.sha256, bytes: download.bytes,
    }
    closure.measurements.downloadBytes += download.bytes
    const { sourcePath } = writeAuthenticatedFixture(root, closure, (source) => {
      source.formulae[3]!.licenses = [download]
    })

    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .resolves.toMatchObject({ target: 'darwin-arm64' })
  })

  it.each([
    ['missing family formula license', (closure: ReturnType<typeof closureFixture>) => { closure.families.media.licenses = [] }],
    ['mismatched family license tuple', (closure: ReturnType<typeof closureFixture>) => { closure.families.media.licenses[0]!.sha256 = '0'.repeat(64) }],
  ])('rejects %s', async (_label, mutate) => {
    const closure = closureFixture()
    mutate(closure)
    const { sourcePath } = writeAuthenticatedFixture(temporaryRoot(), closure)
    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .rejects.toThrow('Target closure lock license inventory is inconsistent.')
  })

  it.each([
    ['missing engine license', (closure: ReturnType<typeof closureFixture>) => { closure.families.document.engineLicenses = [] }, 'engine license'],
    ['license-only engine', (closure: ReturnType<typeof closureFixture>) => { closure.families.document.engineAssets = [] }, 'engine license'],
    ['mismatched engine acquisition', (closure: ReturnType<typeof closureFixture>) => { closure.families.document.engineAssets[0]!.sha256 = '0'.repeat(64) }, 'engine inventory'],
    ['mismatched engine license', (closure: ReturnType<typeof closureFixture>) => { closure.families.document.engineLicenses[0]!.bytes += 1 }, 'engine license'],
  ])('rejects %s', async (_label, mutate, diagnostic) => {
    const closure = closureFixture()
    mutate(closure)
    const { sourcePath } = writeAuthenticatedFixture(temporaryRoot(), closure)
    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .rejects.toThrow(diagnostic)
  })

  it('rejects a closure formula unreachable from engines and family inventory', async () => {
    const closure = closureFixture()
    closure.formulae.push({ name: 'zlib', version: '1.3.1', dependencies: [] })
    const { sourcePath } = writeAuthenticatedFixture(temporaryRoot(), closure, (source) => {
      const zlib = structuredClone(source.formulae[3]!)
      zlib.name = 'zlib'
      zlib.version = '1.3.1'
      zlib.acquisitions['darwin-arm64'] = bottle('zlib', 'darwin-arm64', '9', 150)
      zlib.acquisitions['darwin-x64'] = bottle('zlib', 'darwin-x64', '9', 151)
      zlib.licenses = zlib.licenses.map((entry) => ({
        ...entry, sha256: '9'.repeat(64), destination: 'licenses/zlib.LICENSE',
      }))
      source.formulae.push(zlib)
    })
    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .rejects.toThrow('Target closure lock contains an unreachable formula.')
  })

  it('does not let a valid license-only formula make an orphan reachable', async () => {
    const closure = closureFixture()
    closure.formulae.push({ name: 'zlib', version: '1.3.1', dependencies: [] })
    closure.families.media.licenses.push(license('zlib', '9'))
    closure.measurements.downloadBytes += 150
    const { sourcePath } = writeAuthenticatedFixture(temporaryRoot(), closure, (source) => {
      const zlib = structuredClone(source.formulae[3]!)
      zlib.name = 'zlib'
      zlib.version = '1.3.1'
      zlib.acquisitions['darwin-arm64'] = bottle('zlib', 'darwin-arm64', '9', 150)
      zlib.acquisitions['darwin-x64'] = bottle('zlib', 'darwin-x64', '9', 151)
      zlib.licenses = zlib.licenses.map((entry) => ({
        ...entry, sha256: '9'.repeat(64), destination: 'licenses/zlib.LICENSE',
      }))
      source.formulae.push(zlib)
    })

    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .rejects.toThrow('Target closure lock contains an unreachable formula.')
  })

  it('rejects a license-only formula even when that formula is otherwise reachable', async () => {
    const closure = closureFixture()
    closure.families.media.licenses.push(license('glib', 'e'))
    const { sourcePath } = writeAuthenticatedFixture(temporaryRoot(), closure)

    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .rejects.toThrow('Target closure lock license inventory is inconsistent.')
  })

  it('validates a deep acyclic dependency graph without overflowing the call stack', () => {
    const closure = closureFixture()
    const count = 15_000
    const chain = Array.from({ length: count }, (_unused, index) => ({
      name: `n${String(index).padStart(5, '0')}`,
      version: '1',
      dependencies: index + 1 === count ? [] : [`n${String(index + 1).padStart(5, '0')}`],
    }))
    closure.formulae[0]!.dependencies = ['glib', 'n00000']
    closure.formulae.splice(2, 0, ...chain)

    expect(() => validateTargetClosureLock(closure, 'darwin-arm64')).not.toThrow()
  })

  it('loads a deep reachable source relationship without overflowing the call stack', async () => {
    const closure = closureFixture()
    const count = 10_000
    const chain = Array.from({ length: count }, (_unused, index) => ({
      name: `n${String(index).padStart(5, '0')}`,
      version: '1',
      dependencies: index + 1 === count ? [] : [`n${String(index + 1).padStart(5, '0')}`],
    }))
    closure.formulae.splice(2, 0, ...chain)
    closure.families.media.files.push(file('n00000', 'share/runtime', 'zz/runtime', '1'))
    closure.families.media.licenses.push({
      formula: 'n00000', source: 'https://e.test/a', destination: 'licenses/n00000.LICENSE',
      sha256: '1'.repeat(64), bytes: 1,
    })
    closure.measurements.downloadBytes += 1

    const { sourcePath } = writeAuthenticatedFixture(temporaryRoot(), closure, (source) => {
      const formulae = chain.map(({ name }) => ({
        name,
        version: '1',
        revision: 0,
        license: 'MIT',
        acquisitions: {
          'darwin-arm64': {
            kind: 'homebrew-bottle', url: 'https://e.test/a', sha256: '1'.repeat(64), bytes: 1,
            cellar: '/opt/homebrew/Cellar',
          },
          'darwin-x64': {
            kind: 'homebrew-bottle', url: 'https://e.test/a', sha256: '1'.repeat(64), bytes: 1,
            cellar: '/usr/local/Cellar',
          },
        },
        licenses: [{
          kind: 'download', url: 'https://e.test/a', sha256: '1'.repeat(64), bytes: 1,
          destination: `licenses/${name}.LICENSE`,
        }],
      }))
      source.formulae.splice(2, 0, ...formulae)
    })

    const loaded = await loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' })
    expect(loaded.closureLock.formulae.some(({ name }: { name: string }) => name === 'n09999')).toBe(true)
  }, 20_000)

  it('matches multiple canonical license tuples through the per-formula index', async () => {
    const closure = closureFixture()
    const notices = [{
      kind: 'download', url: 'https://licenses.example.test/ffmpeg-NOTICE', sha256: '5'.repeat(64),
      bytes: 5, destination: 'licenses/ffmpeg.NOTICE',
    }, {
      kind: 'download', url: 'https://licenses.example.test/ffmpeg-PATENTS', sha256: '6'.repeat(64),
      bytes: 6, destination: 'licenses/ffmpeg.PATENTS',
    }]
    closure.families.media.licenses.push(...notices.map((asset) => ({
      formula: 'ffmpeg', source: asset.url, destination: asset.destination,
      sha256: asset.sha256, bytes: asset.bytes,
    })))
    closure.measurements.downloadBytes += 11
    const { sourcePath } = writeAuthenticatedFixture(temporaryRoot(), closure, (source) => {
      source.formulae[0]!.licenses.push(...notices)
    })

    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .resolves.toMatchObject({ closureLock: { measurements: { downloadBytes: 626 } } })
  })

  it.each([
    ['URL', 'https://licenses.example.test/conflict', 140],
    ['byte length', 'https://downloads.example.test/libreoffice-arm64.dmg', 7],
  ])('rejects a conflicting %s identity for one selected SHA', async (_label, url, bytes) => {
    const { sourcePath } = writeAuthenticatedFixture(temporaryRoot(), closureFixture(), (source) => {
      source.formulae[0]!.licenses.push({
        kind: 'download', url, sha256: 'b'.repeat(64), bytes,
        destination: 'licenses/ffmpeg-extra.LICENSE',
      })
    })
    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .rejects.toThrow('Selected network artifacts conflict for one SHA-256.')
  })

  it('deduplicates selected network bytes by SHA-256', async () => {
    const { sourcePath } = writeAuthenticatedFixture(temporaryRoot(), closureFixture(), (source) => {
      source.formulae[0]!.licenses.push({
        kind: 'download', url: 'https://downloads.example.test/libreoffice-arm64.dmg', sha256: 'b'.repeat(64),
        bytes: 140, destination: 'licenses/ffmpeg-extra.LICENSE',
      })
    })
    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .resolves.toMatchObject({ closureLock: { measurements: { downloadBytes: 615 } } })
  })

  it('ignores conflicting artifacts from source formulae outside the current closure', async () => {
    const { sourcePath } = writeAuthenticatedFixture(temporaryRoot(), closureFixture(), (source) => {
      const zlib = structuredClone(source.formulae[3]!)
      zlib.name = 'zlib'
      zlib.version = '1.3.1'
      zlib.acquisitions['darwin-arm64'] = {
        ...bottle('zlib', 'darwin-arm64', 'b', 7),
        url: 'https://downloads.example.test/unselected-zlib.tar.gz',
      }
      zlib.acquisitions['darwin-x64'] = bottle('zlib', 'darwin-x64', '9', 151)
      zlib.licenses = zlib.licenses.map((entry) => ({
        ...entry, sha256: '9'.repeat(64), destination: 'licenses/zlib.LICENSE',
      }))
      source.formulae.push(zlib)
    })

    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' }))
      .resolves.toMatchObject({ closureLock: { measurements: { downloadBytes: 615 } } })
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
