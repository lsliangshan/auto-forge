import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  adhocSignMachOClosure,
  inspectMachO,
  parseOtoolLibraries,
  parseOtoolRpaths,
  planMachOClosure,
  relocateMachOClosure,
} from '../../scripts/converter-packs/macho-closure.mjs'
import { probeConverterFamily, stageProductionPacks } from '../../scripts/converter-packs/stage-production-packs.mjs'
import { buildConverterPackIndex } from '../../scripts/converter-packs/build-index.mjs'
import { selectVerifiedSourceLicense } from '../../scripts/converter-packs/prepare-production-staging.mjs'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-converter-staging-')))
  temporaryRoots.push(root)
  return root
}

function fixtureFile(root: string, relative: string): string {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, basename(path))
  return realpathSync(path)
}

function lockedFile(root: string, formula: string, version: string, sourcePath: string, destination: string, executable = false, role = executable ? 'executable' : 'code') {
  const source = fixtureFile(root, `Cellar/${formula}/${version}/${sourcePath}`)
  const bytes = readFileSync(source)
  return {
    source,
    lock: {
      formula, sourcePath, destination,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
      executable,
      role,
    },
  }
}

function syntheticUniverse(root: string, versions: Record<string, string>) {
  const selectedRoot = realpathSync(root)
  return {
    target: 'darwin-arm64',
    cellar(formula: string, version: string) {
      if (versions[formula] !== version) throw new Error('formula is not locked')
      return realpathSync(join(selectedRoot, 'Cellar', formula, version))
    },
    opt(formula: string) {
      const version = versions[formula]
      if (!version) throw new Error('formula is not locked')
      return realpathSync(join(selectedRoot, 'Cellar', formula, version))
    },
    resolveLockedFile(formula: string, sourcePath: string) {
      const version = versions[formula]
      if (!version) throw new Error('formula is not locked')
      return join(selectedRoot, 'Cellar', formula, version, ...sourcePath.split('/'))
    },
    contains(path: string) { return path === selectedRoot || path.startsWith(`${selectedRoot}/`) },
  }
}

function stagingFixture(root: string) {
  const universeRoot = join(root, 'universe')
  mkdirSync(universeRoot)
  const versions: Record<string, string> = {}
  const destinationSets: Record<string, string[]> = {
    'image-icon': ['bin/autoforge-image-converter', 'bin/vips'],
    document: ['program/soffice'],
    pdf: ['bin/autoforge-pdf-raster', 'bin/pdfinfo', 'bin/pdftocairo'],
    media: ['bin/ffmpeg', 'bin/ffprobe'],
  }
  const families = Object.fromEntries(Object.entries(destinationSets).map(([name, destinations]) => {
    const formula = name.replace('-', '_')
    versions[formula] = '1.0'
    const files = destinations.map((destination) => lockedFile(universeRoot, formula, '1.0', destination, destination, true).lock)
    if (name === 'image-icon') files.push(lockedFile(universeRoot, formula, '1.0', 'share/runtime.dat', 'share/runtime.dat', false, 'data').lock)
    const licenseFile = lockedFile(universeRoot, formula, '1.0', 'LICENSE', `LICENSES/${formula}.txt`, false, 'data')
    return [name, {
      files,
      rewrites: [],
      licenses: [{
        formula,
        source: 'LICENSE',
        destination: `LICENSES/${formula}.txt`,
        sha256: licenseFile.lock.sha256,
        bytes: licenseFile.lock.bytes,
      }],
    }]
  }))
  const closure = {
    schemaVersion: 1,
    target: 'darwin-arm64',
    formulae: Object.entries(versions).map(([name, version]) => ({ name, version, dependencies: [] })).sort((left, right) => left.name.localeCompare(right.name)),
    families,
    measurements: {
      downloadBytes: 1,
      compressedPackBytes: { 'image-icon': 1, document: 1, pdf: 1, media: 1 },
      installedReleaseBytes: 1,
    },
  }
  const universe = syntheticUniverse(universeRoot, versions)
  const closureLockPath = join(root, 'closure.lock.json')
  writeFileSync(closureLockPath, canonicalBytes(closure))
  const request = (target: 'darwin-arm64' | 'darwin-x64', output: string) => ({
    target, output, version: '1.2.3', sequence: 17,
    generatedAt: '2026-08-31T00:00:00.000Z',
    archiveBaseUrl: 'https://cdn.example.test/converter-packs',
    closureLockPath,
    universeRoot,
  })
  const dependencies = {
    loadClosure: async ({ target }: { target: string }) => ({ ...closure, target }),
    openUniverse: async ({ closureLock }: { closureLock: { target: string } }) => ({ ...universe, target: closureLock.target }),
    planClosure: async ({ expectedFiles }: { expectedFiles: Array<{ formula: string; sourcePath: string; destination: string; executable: boolean; role: string }> }) => ({
      files: expectedFiles.map((file) => ({
        source: universe.resolveLockedFile(file.formula, file.sourcePath),
        destination: file.destination,
        executable: file.executable,
        formula: file.formula,
        role: file.role,
      })),
      rewrites: [],
    }),
    applyRelocation: async () => undefined,
    probeFamily: async () => undefined,
  }
  return { closure, universe, request, dependencies }
}

describe('verified converter source license selection', () => {
  it('searches only the source root and its first wrapper level', async () => {
    const root = temporaryRoot()
    const wrapper = join(root, 'libreoffice-26.8.0.3')
    const expected = fixtureFile(wrapper, 'LICENSE')
    const deep = join(wrapper, 'vendor', 'large-source-tree')
    mkdirSync(deep, { recursive: true })
    for (let index = 0; index < 512; index += 1) {
      writeFileSync(join(deep, `unrelated-${index.toString().padStart(4, '0')}`), 'fixture')
    }
    fixtureFile(deep, 'COPYING')

    await expect(selectVerifiedSourceLicense(root, ['COPYING', 'LICENSE'], 'libreoffice')).resolves.toBe(expected)
  })

  it('uses license-name priority, shortest path, and UTF-8 byte order deterministically', async () => {
    const root = temporaryRoot()
    fixtureFile(root, 'LICENSE')
    const byteFirst = fixtureFile(root, 'a/COPYING')
    fixtureFile(root, 'z/COPYING')

    await expect(selectVerifiedSourceLicense(root, ['COPYING', 'LICENSE'], 'libreoffice')).resolves.toBe(byteFirst)

    const shortest = fixtureFile(root, 'COPYING')
    await expect(selectVerifiedSourceLicense(root, ['COPYING', 'LICENSE'], 'libreoffice')).resolves.toBe(shortest)
  })

  it('fails closed when an exact license-name match is symbolic or non-regular', async () => {
    const symbolicRoot = temporaryRoot()
    const outsideRoot = temporaryRoot()
    const outside = fixtureFile(outsideRoot, 'COPYING')
    symlinkSync(outside, join(symbolicRoot, 'COPYING'))
    await expect(selectVerifiedSourceLicense(symbolicRoot, ['COPYING', 'LICENSE'], 'libreoffice')).rejects.toThrow(/unsupported/iu)

    const nonRegularRoot = temporaryRoot()
    fixtureFile(nonRegularRoot, 'COPYING')
    mkdirSync(join(nonRegularRoot, 'wrapper', 'LICENSE'), { recursive: true })
    await expect(selectVerifiedSourceLicense(nonRegularRoot, ['COPYING', 'LICENSE'], 'libreoffice')).rejects.toThrow(/unsupported/iu)
  })

  it('requires a canonical non-symbolic root and wrapper hierarchy', async () => {
    const sourceRoot = temporaryRoot()
    fixtureFile(sourceRoot, 'COPYING')
    const aliasParent = temporaryRoot()
    const rootAlias = join(aliasParent, 'source-alias')
    symlinkSync(sourceRoot, rootAlias)
    await expect(selectVerifiedSourceLicense(rootAlias, ['COPYING'], 'libreoffice')).rejects.toThrow(/canonical|symbolic/iu)
    await expect(selectVerifiedSourceLicense(`${sourceRoot}/.`, ['COPYING'], 'libreoffice')).rejects.toThrow(/canonical/iu)

    const wrapperRoot = temporaryRoot()
    const outsideRoot = temporaryRoot()
    fixtureFile(outsideRoot, 'COPYING')
    symlinkSync(outsideRoot, join(wrapperRoot, 'source-wrapper'))
    await expect(selectVerifiedSourceLicense(wrapperRoot, ['COPYING'], 'libreoffice')).rejects.toThrow(/symbolic|wrapper/iu)
  })

  it('returns a resolved canonical regular path contained by the canonical root', async () => {
    const root = temporaryRoot()
    const expected = fixtureFile(root, 'wrapper/COPYING')

    const selected = await selectVerifiedSourceLicense(root, ['COPYING'], 'libreoffice')

    expect(selected).toBe(realpathSync(expected))
    expect(relative(root, selected)).toBe('wrapper/COPYING')
  })

  it('fails closed for missing, excessive-wrapper, and excessive-candidate inventories', async () => {
    const missingRoot = temporaryRoot()
    fixtureFile(missingRoot, 'wrapper/COPYING.txt')
    await expect(selectVerifiedSourceLicense(missingRoot, ['COPYING', 'LICENSE'], 'libreoffice')).rejects.toThrow(/missing/iu)

    const wrapperRoot = temporaryRoot()
    for (let index = 0; index < 65; index += 1) mkdirSync(join(wrapperRoot, `wrapper-${index.toString().padStart(2, '0')}`))
    await expect(selectVerifiedSourceLicense(wrapperRoot, ['COPYING'], 'libreoffice')).rejects.toThrow(/too many directories/iu)

    const candidateRoot = temporaryRoot()
    for (let index = 0; index < 33; index += 1) fixtureFile(candidateRoot, `wrapper-${index.toString().padStart(2, '0')}/COPYING`)
    await expect(selectVerifiedSourceLicense(candidateRoot, ['COPYING'], 'libreoffice')).rejects.toThrow(/too many candidates/iu)
  })
})

describe('converter pack Mach-O closure', () => {
  it('expands locked Homebrew placeholders and matches the exact namespaced closure', async () => {
    const root = temporaryRoot()
    const vips = lockedFile(root, 'vips', '8.18.6', 'bin/vips', 'bin/vips', true)
    const libvips = lockedFile(root, 'vips', '8.18.6', 'lib/libvips.42.dylib', 'lib/vips/libvips.42.dylib')
    const local = lockedFile(root, 'vips', '8.18.6', 'lib/liblocal.dylib', 'lib/vips/liblocal.dylib')
    const glib = lockedFile(root, 'glib', '2.86.0', 'lib/libglib-2.0.0.dylib', 'lib/glib/libglib-2.0.0.dylib')
    const png = lockedFile(root, 'libpng', '1.6.50', 'lib/libpng16.16.dylib', 'lib/libpng/libpng16.16.dylib')
    const expectedFiles = [vips.lock, libvips.lock, local.lock, glib.lock, png.lock]
    const expectedRewrites = [
      { destination: 'bin/vips', dependency: '@@HOMEBREW_CELLAR@@/vips/8.18.6/lib/libvips.42.dylib', replacement: '@loader_path/../lib/vips/libvips.42.dylib' },
      { destination: 'bin/vips', dependency: '@@HOMEBREW_PREFIX@@/opt/glib/lib/libglib-2.0.0.dylib', replacement: '@loader_path/../lib/glib/libglib-2.0.0.dylib' },
      { destination: 'bin/vips', dependency: '@loader_path/../lib/liblocal.dylib', replacement: '@loader_path/../lib/vips/liblocal.dylib' },
      { destination: 'bin/vips', dependency: '@rpath/libpng16.16.dylib', replacement: '@loader_path/../lib/libpng/libpng16.16.dylib' },
    ]
    const inspections = new Map([
      [vips.source, {
        architectures: ['arm64'],
        dependencies: expectedRewrites.map(({ dependency }) => dependency).concat('/usr/lib/libSystem.B.dylib'),
        rpaths: ['@@HOMEBREW_PREFIX@@/opt/libpng/lib'],
      }],
      ...[libvips, local, glib, png].map(({ source }) => [source, { architectures: ['arm64'], dependencies: [], rpaths: [] }] as const),
    ])

    const plan = await planMachOClosure({
      entrypoints: [{ source: vips.source, destination: 'bin/vips' }],
      architecture: 'arm64',
      inspect: async (path: string) => inspections.get(path),
      universe: syntheticUniverse(root, { vips: '8.18.6', glib: '2.86.0', libpng: '1.6.50' }),
      expectedFiles,
      expectedRewrites,
    })

    expect(plan.files).toEqual(expectedFiles.map((file) => ({
      source: join(root, 'Cellar', file.formula, ({ vips: '8.18.6', glib: '2.86.0', libpng: '1.6.50' } as Record<string, string>)[file.formula], ...file.sourcePath.split('/')),
      destination: file.destination,
      executable: file.executable,
      formula: file.formula,
      role: file.role,
    })).sort((left, right) => left.destination.localeCompare(right.destination)))
    expect(plan.rewrites).toEqual(expectedRewrites)
  })

  it('rejects inventory, rewrite, source-integrity, namespace, and universe-boundary differences', async () => {
    const root = temporaryRoot()
    const tool = lockedFile(root, 'vips', '8.18.6', 'bin/vips', 'bin/vips', true)
    const library = lockedFile(root, 'glib', '2.86.0', 'lib/libsame.dylib', 'lib/glib/libsame.dylib')
    const data = lockedFile(root, 'glib', '2.86.0', 'share/runtime.dat', 'share/glib/runtime.dat', false, 'data')
    const universe = syntheticUniverse(root, { vips: '8.18.6', glib: '2.86.0' })
    const dependency = '@@HOMEBREW_PREFIX@@/opt/glib/lib/libsame.dylib'
    const rewrite = { destination: 'bin/vips', dependency, replacement: '@loader_path/../lib/glib/libsame.dylib' }
    const inspect = async (path: string) => path === tool.source
      ? { architectures: ['arm64'], dependencies: [dependency], rpaths: [] }
      : { architectures: ['arm64'], dependencies: [], rpaths: [] }
    const request = () => ({
      entrypoints: [{ source: tool.source, destination: 'bin/vips' }], architecture: 'arm64', inspect, universe,
      expectedFiles: [tool.lock, library.lock, data.lock], expectedRewrites: [rewrite],
    })

    await expect(planMachOClosure({ ...request(), expectedFiles: [...request().expectedFiles, { ...library.lock, sourcePath: 'lib/unreached.dylib', destination: 'lib/glib/unreached.dylib' }] })).rejects.toThrow(/locked|inventory|unreached/iu)
    await expect(planMachOClosure({ ...request(), expectedFiles: [tool.lock, data.lock] })).rejects.toThrow(/undeclared|inventory/iu)
    await expect(planMachOClosure({ ...request(), expectedFiles: [tool.lock, { ...library.lock, sha256: '0'.repeat(64) }, data.lock] })).rejects.toThrow(/hash|inventory/iu)
    await expect(planMachOClosure({ ...request(), expectedRewrites: [] })).rejects.toThrow(/rewrite/iu)
    await expect(planMachOClosure({ ...request(), expectedRewrites: [{ ...rewrite, replacement: '@loader_path/../lib/glib/other.dylib' }] })).rejects.toThrow(/rewrite/iu)
    await expect(planMachOClosure({ ...request(), expectedFiles: [tool.lock, { ...library.lock, destination: 'lib/libsame.dylib' }, data.lock] })).rejects.toThrow(/namespace|destination/iu)
    await expect(planMachOClosure({ ...request(), inspect: async (path: string) => path === tool.source ? { architectures: ['arm64'], dependencies: ['/opt/homebrew/lib/libsame.dylib'], rpaths: [] } : inspect(path) })).rejects.toThrow(/absolute|host|unresolved/iu)
    await expect(planMachOClosure({ ...request(), inspect: async (path: string) => path === tool.source ? { architectures: ['arm64'], dependencies: ['@@HOMEBREW_CELLAR@@/glib/0/lib/libsame.dylib'], rpaths: [] } : inspect(path) })).rejects.toThrow(/locked|version|formula/iu)

    writeFileSync(library.source, 'changed')
    await expect(planMachOClosure(request())).rejects.toThrow(/hash|size|inventory/iu)
    writeFileSync(library.source, basename(library.source))
    const unused = lockedFile(root, 'glib', '2.86.0', 'lib/libunused.dylib', 'lib/glib/libunused.dylib')
    await expect(planMachOClosure({ ...request(), expectedFiles: [...request().expectedFiles, unused.lock] })).rejects.toThrow(/unreachable/iu)

    rmSync(library.source)
    symlinkSync(data.source, library.source)
    await expect(planMachOClosure(request())).rejects.toThrow(/symbolic|regular/iu)
  })
  it('parses literal otool dependency and rpath output without locale-sensitive text matching', () => {
    expect(parseOtoolLibraries(`/tmp/tool:\n\t/opt/homebrew/opt/a/lib/liba.1.dylib (compatibility version 1.0.0, current version 1.2.0)\n\t@rpath/libb.2.dylib (compatibility version 2.0.0, current version 2.1.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`)).toEqual([
      '/opt/homebrew/opt/a/lib/liba.1.dylib',
      '@rpath/libb.2.dylib',
      '/usr/lib/libSystem.B.dylib',
    ])
    expect(parseOtoolRpaths(`Load command 10\n          cmd LC_RPATH\n      cmdsize 32\n         path @loader_path/../lib (offset 12)\nLoad command 11\n          cmd LC_LOAD_DYLIB\n`)).toEqual(['@loader_path/../lib'])
  })

  it('inspects and relocates only through fixed absolute Apple tool paths', async () => {
    const root = temporaryRoot()
    const payload = join(root, 'payload')
    const executable = fixtureFile(payload, 'bin/tool')
    chmodSync(executable, 0o755)
    const calls: Array<{ executable: string; args: readonly string[] }> = []
    const run = async (command: string, args: readonly string[]) => {
      calls.push({ executable: command, args })
      if (command === '/usr/bin/lipo') return { status: 0, stdout: 'arm64\n', stderr: '' }
      if (command === '/usr/bin/otool' && args[0] === '-L') {
        return { status: 0, stdout: `${args[1]}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`, stderr: '' }
      }
      if (command === '/usr/bin/otool' && args[0] === '-l') return { status: 0, stdout: '', stderr: '' }
      if (command === '/usr/bin/install_name_tool') return { status: 0, stdout: '', stderr: '' }
      throw new Error(`unexpected command: ${command}`)
    }

    await expect(inspectMachO(executable, { run })).resolves.toEqual({
      architectures: ['arm64'],
      dependencies: ['/usr/lib/libSystem.B.dylib'],
      rpaths: [],
    })
    await relocateMachOClosure({
      payload,
      architecture: 'arm64',
      plan: {
        files: [{ source: executable, destination: 'bin/tool', executable: true }],
        rewrites: [{ destination: 'bin/tool', dependency: '/brew/liba.dylib', replacement: '@loader_path/../lib/liba.dylib' }],
      },
      run,
    })

    expect(calls).toContainEqual({
      executable: '/usr/bin/install_name_tool',
      args: ['-change', '/brew/liba.dylib', '@loader_path/../lib/liba.dylib', executable],
    })
    expect(calls.every((call) => call.executable.startsWith('/usr/bin/'))).toBe(true)

    const library = fixtureFile(payload, 'lib/a/liba.dylib')
    await expect(relocateMachOClosure({
      payload,
      architecture: 'arm64',
      plan: { files: [{ source: library, destination: 'lib/a/liba.dylib', executable: false, formula: 'a', role: 'code' }], rewrites: [] },
      run: async (command: string, args: readonly string[]) => {
        calls.push({ executable: command, args })
        if (command === '/usr/bin/lipo') return { status: 0, stdout: 'arm64\n', stderr: '' }
        if (command === '/usr/bin/otool' && args[0] === '-L') {
          return { status: 0, stdout: `${args[1]}:\n\t@rpath/autoforge/a/liba.dylib (compatibility version 1.0.0, current version 1.0.0)\n`, stderr: '' }
        }
        if (command === '/usr/bin/otool' && args[0] === '-l') return { status: 0, stdout: '', stderr: '' }
        if (command === '/usr/bin/install_name_tool') return { status: 0, stdout: '', stderr: '' }
        throw new Error(`unexpected command: ${command}`)
      },
    })).resolves.toBeUndefined()
    expect(calls).toContainEqual({
      executable: '/usr/bin/install_name_tool',
      args: ['-id', '@rpath/autoforge/a/liba.dylib', library],
    })

    await expect(relocateMachOClosure({
      payload,
      architecture: 'arm64',
      plan: { files: [{ source: library, destination: 'lib/a/liba.dylib', executable: false, formula: 'a', role: 'code' }], rewrites: [] },
      run: async (command: string, args: readonly string[]) => {
        if (command === '/usr/bin/lipo') return { status: 0, stdout: 'arm64\n', stderr: '' }
        if (command === '/usr/bin/otool' && args[0] === '-L') {
          return { status: 0, stdout: `${args[1]}:\n\t@loader_path/@@HOMEBREW_PREFIX@@/libbad.dylib (compatibility version 1.0.0, current version 1.0.0)\n`, stderr: '' }
        }
        if (command === '/usr/bin/otool' && args[0] === '-l') return { status: 0, stdout: '', stderr: '' }
        if (command === '/usr/bin/install_name_tool') return { status: 0, stdout: '', stderr: '' }
        throw new Error(`unexpected command: ${command}`)
      },
    })).rejects.toThrow(/unresolved/iu)

    const signCalls: string[] = []
    await adhocSignMachOClosure({
      payload,
      plan: {
        files: [
          { source: executable, destination: 'bin/tool', executable: true },
          { source: library, destination: 'lib/a/liba.dylib', executable: false, formula: 'a', role: 'code' },
        ],
        rewrites: [],
      },
      run: async (command: string, args: readonly string[]) => {
        expect(command).toBe('/usr/bin/codesign')
        signCalls.push(args.at(-1) ?? '')
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    expect(signCalls).toEqual([library, executable])
  })

  it('plans a transitive closure, excludes system libraries, and emits loader-relative rewrites', async () => {
    const root = temporaryRoot()
    const tool = lockedFile(root, 'tool', '1.0', 'bin/tool', 'bin/tool', true)
    const libA = lockedFile(root, 'tool', '1.0', 'lib/liba.1.dylib', 'lib/tool/liba.1.dylib')
    const libB = lockedFile(root, 'tool', '1.0', 'lib/libb.2.dylib', 'lib/tool/libb.2.dylib')
    const inspections = new Map([
      [tool.source, { architectures: ['arm64'], dependencies: ['@@HOMEBREW_CELLAR@@/tool/1.0/lib/liba.1.dylib', '@rpath/libb.2.dylib', '/usr/lib/libSystem.B.dylib'], rpaths: ['@loader_path/../lib'] }],
      [libA.source, { architectures: ['arm64'], dependencies: ['@loader_path/libb.2.dylib'], rpaths: [] }],
      [libB.source, { architectures: ['arm64'], dependencies: ['/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation'], rpaths: [] }],
    ])
    const expectedRewrites = [
      { destination: 'bin/tool', dependency: '@@HOMEBREW_CELLAR@@/tool/1.0/lib/liba.1.dylib', replacement: '@loader_path/../lib/tool/liba.1.dylib' },
      { destination: 'bin/tool', dependency: '@rpath/libb.2.dylib', replacement: '@loader_path/../lib/tool/libb.2.dylib' },
      { destination: 'lib/tool/liba.1.dylib', dependency: '@loader_path/libb.2.dylib', replacement: '@loader_path/libb.2.dylib' },
    ]

    const plan = await planMachOClosure({
      entrypoints: [{ source: tool.source, destination: 'bin/tool' }],
      architecture: 'arm64',
      inspect: async (path: string) => inspections.get(path),
      universe: syntheticUniverse(root, { tool: '1.0' }),
      expectedFiles: [tool.lock, libA.lock, libB.lock],
      expectedRewrites,
    })

    expect(plan.files).toEqual([
      { source: tool.source, destination: 'bin/tool', executable: true, formula: 'tool', role: 'executable' },
      { source: libA.source, destination: 'lib/tool/liba.1.dylib', executable: false, formula: 'tool', role: 'code' },
      { source: libB.source, destination: 'lib/tool/libb.2.dylib', executable: false, formula: 'tool', role: 'code' },
    ])
    expect(plan.rewrites).toContainEqual({
      destination: 'bin/tool',
      dependency: '@@HOMEBREW_CELLAR@@/tool/1.0/lib/liba.1.dylib',
      replacement: '@loader_path/../lib/tool/liba.1.dylib',
    })
    expect(plan.rewrites).toContainEqual({
      destination: 'lib/tool/liba.1.dylib',
      dependency: '@loader_path/libb.2.dylib',
      replacement: '@loader_path/libb.2.dylib',
    })
  })

  it('rejects architecture mismatches, unresolved dependencies, and destination collisions', async () => {
    const root = temporaryRoot()
    const tool = lockedFile(root, 'tool', '1.0', 'bin/tool', 'bin/tool', true)
    const first = lockedFile(root, 'first', '1.0', 'lib/libsame.dylib', 'lib/first/libsame.dylib')
    const second = lockedFile(root, 'second', '1.0', 'lib/libsame.dylib', 'lib/second/libsame.dylib')
    const universe = syntheticUniverse(root, { tool: '1.0', first: '1.0', second: '1.0' })
    const base = { entrypoints: [{ source: tool.source, destination: 'bin/tool' }], architecture: 'arm64', universe }

    await expect(planMachOClosure({
      ...base,
      inspect: async () => ({ architectures: ['x86_64'], dependencies: [], rpaths: [] }),
      expectedFiles: [tool.lock], expectedRewrites: [],
    })).rejects.toThrow(/architecture/iu)

    await expect(planMachOClosure({
      ...base,
      inspect: async () => ({ architectures: ['arm64'], dependencies: ['@rpath/missing.dylib'], rpaths: [] }),
      expectedFiles: [tool.lock], expectedRewrites: [],
    })).rejects.toThrow(/unresolved/iu)

    const inspections = new Map([
      [tool.source, { architectures: ['arm64'], dependencies: ['@@HOMEBREW_PREFIX@@/opt/first/lib/libsame.dylib'], rpaths: [] }],
      [first.source, { architectures: ['arm64'], dependencies: [], rpaths: [] }],
      [second.source, { architectures: ['arm64'], dependencies: [], rpaths: [] }],
    ])
    await expect(planMachOClosure({
      ...base,
      inspect: async (path: string) => inspections.get(path),
      expectedFiles: [tool.lock, first.lock, { ...second.lock, destination: first.lock.destination }],
      expectedRewrites: [],
    })).rejects.toThrow(/collision/iu)
  })
})

describe('converter pack target staging', () => {
  it('requires every media codec and muxer used by the production adapter', async () => {
    const root = temporaryRoot()
    const ffmpeg = fixtureFile(root, 'payload/bin/ffmpeg')
    const ffprobe = fixtureFile(root, 'payload/bin/ffprobe')
    chmodSync(ffmpeg, 0o755)
    chmodSync(ffprobe, 0o755)
    const executables = { 'bin/ffmpeg': ffmpeg, 'bin/ffprobe': ffprobe }
    const codecs = 'libmp3lame pcm_s16le aac flac libvorbis libopus libx264 libvpx-vp9 gif'
    const muxers = 'mp3 wav ipod adts flac ogg opus mp4 webm mov gif'
    const run = async (_executable: string, args: readonly string[]) => ({
      status: 0,
      stdout: args.includes('-encoders') ? codecs : args.includes('-muxers') ? muxers : 'version',
      stderr: '',
    })

    await expect(probeConverterFamily({ name: 'media', payload: join(root, 'payload'), executables }, { run })).resolves.toBeUndefined()
    await expect(probeConverterFamily({ name: 'media', payload: join(root, 'payload'), executables }, {
      run: async (_executable: string, args: readonly string[]) => ({
        status: 0,
        stdout: args.includes('-encoders') ? codecs.replace('libx264', '') : muxers,
        stderr: '',
      }),
    })).rejects.toThrow(/libx264/iu)
  })

  it('stages exactly four families with required executables, data, and licenses', async () => {
    const root = temporaryRoot()
    const output = join(root, 'release-input')
    const fixture = stagingFixture(root)
    const probed: string[] = []
    const dependencies = { ...fixture.dependencies,
      probeFamily: async ({ name }: { name: string }) => { probed.push(name) },
    }

    await stageProductionPacks(fixture.request('darwin-arm64', output), {
      planClosure: dependencies.planClosure,
      applyRelocation: dependencies.applyRelocation,
      probeFamily: dependencies.probeFamily,
    })

    expect(probed.sort()).toEqual(['document', 'image-icon', 'media', 'pdf'])
    expect(JSON.parse(readFileSync(join(output, 'release.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      generatedAt: '2026-08-31T00:00:00.000Z',
      sequence: 17,
    })
    const packNames = ['document', 'image-icon', 'media', 'pdf']
    for (const name of packNames) {
      const pack = join(output, 'packs', `${name}-darwin-arm64`)
      const manifest = JSON.parse(readFileSync(join(pack, 'pack.json'), 'utf8')) as {
        name: string
        archiveUrl: string
        files: Array<{ path: string; role: string }>
      }
      expect(manifest.name).toBe(name)
      expect(manifest.archiveUrl).toBe(`https://cdn.example.test/converter-packs/${name}-1.2.3-darwin-arm64.tar`)
      expect(manifest.files.some((file) => file.role === 'license')).toBe(true)
      expect(manifest.files.map((file) => file.path)).toEqual([...manifest.files.map((file) => file.path)].sort())
    }
    const release = join(root, 'release')
    await buildConverterPackIndex({ input: output, output: release, mode: 'test' })
    expect(JSON.parse(readFileSync(join(release, 'index.json'), 'utf8')).packs).toHaveLength(4)

    const x64Output = join(root, 'release-input-x64')
    await stageProductionPacks(fixture.request('darwin-x64', x64Output), dependencies)
    const combined = join(root, 'combined')
    mkdirSync(join(combined, 'packs'), { recursive: true })
    writeFileSync(join(combined, 'release.json'), readFileSync(join(output, 'release.json')))
    for (const staged of [output, x64Output]) {
      for (const name of packNames) {
        const target = staged === output ? 'darwin-arm64' : 'darwin-x64'
        cpSync(join(staged, 'packs', `${name}-${target}`), join(combined, 'packs', `${name}-${target}`), { recursive: true })
      }
    }
    const productionRelease = join(root, 'production-release')
    await buildConverterPackIndex({ input: combined, output: productionRelease, mode: 'production' })
    expect(JSON.parse(readFileSync(join(productionRelease, 'index.json'), 'utf8')).packs).toHaveLength(8)
  })

  it('removes its new output when a capability probe fails', async () => {
    const root = temporaryRoot()
    const output = join(root, 'release-input')
    const fixture = stagingFixture(root)

    await expect(stageProductionPacks(fixture.request('darwin-arm64', output), {
      ...fixture.dependencies,
      probeFamily: async () => { throw new Error('capability missing') },
    })).rejects.toThrow('capability missing')

    expect(() => realpathSync(output)).toThrow()
  })

  it('rejects target strings with trailing components', async () => {
    const root = temporaryRoot()
    await expect(stageProductionPacks({
      target: 'darwin-arm64-extra',
      output: join(root, 'release-input'),
      version: '1.2.3',
      sequence: 17,
      generatedAt: '2026-08-31T00:00:00.000Z',
      archiveBaseUrl: 'https://cdn.example.test/converter-packs',
      closureLockPath: join(root, 'closure.lock.json'),
      universeRoot: join(root, 'universe'),
    }, {})).rejects.toThrow(/target/iu)
  })

  it('rejects legacy host-path family declarations and planner source substitution', async () => {
    const root = temporaryRoot()
    const fixture = stagingFixture(root)
    const output = join(root, 'legacy-output')
    await expect(stageProductionPacks({
      ...fixture.request('darwin-arm64', output),
      families: { media: { entrypoints: [{ source: '/opt/homebrew/bin/ffmpeg', destination: 'bin/ffmpeg' }], assets: [] } },
    }, fixture.dependencies)).rejects.toThrow(/request/iu)

    await expect(stageProductionPacks(fixture.request('darwin-arm64', output), {
      ...fixture.dependencies,
      planClosure: async ({ expectedFiles }: { expectedFiles: Array<{ formula: string; sourcePath: string; destination: string; executable: boolean; role: string }> }) => ({
        files: expectedFiles.map((file, index) => ({
          source: index === 0 ? '/opt/homebrew/bin/substitute' : fixture.universe.resolveLockedFile(file.formula, file.sourcePath),
          destination: file.destination,
          executable: file.executable,
          formula: file.formula,
          role: file.role,
        })),
        rewrites: [],
      }),
    })).rejects.toThrow(/locked inventory/iu)
  })
})
