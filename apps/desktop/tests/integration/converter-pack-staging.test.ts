import { createHash } from 'node:crypto'
import { chmodSync, cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  adhocSignMachOClosure,
  discoverMachOClosure,
  inspectMachO,
  parseOtoolLibraries,
  parseOtoolRpaths,
  planMachOClosure,
  relocateMachOClosure,
} from '../../scripts/converter-packs/macho-closure.mjs'
import { probeConverterFamily, stageProductionPacks, stageProductionPacksMain } from '../../scripts/converter-packs/stage-production-packs.mjs'
import { buildConverterPackIndex } from '../../scripts/converter-packs/build-index.mjs'
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

function lockedFile(root: string, formula: string, version: string, sourcePath: string, destination: string, executable = false, role = executable ? 'executable' : 'code', runtimeRoot = false) {
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
      runtimeRoot,
    },
  }
}

function discoveryFile(root: string, formula: string, version: string, sourcePath: string) {
  const source = fixtureFile(root, `Cellar/${formula}/${version}/${sourcePath}`)
  const bytes = readFileSync(source)
  return {
    formula,
    version,
    sourcePath,
    source,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
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
    'image-icon': ['bin/vips'],
    document: [],
    pdf: ['bin/pdfinfo', 'bin/pdftocairo'],
    media: ['bin/ffmpeg', 'bin/ffprobe'],
  }
  const formulaNames: Record<string, string> = { 'image-icon': 'vips', pdf: 'poppler', media: 'ffmpeg' }
  const nativeHelpers: Record<string, Array<{ helper: string; destination: string }>> = {
    'image-icon': [{ helper: 'autoforge-image-converter', destination: 'bin/autoforge-image-converter' }],
    document: [{ helper: 'autoforge-soffice-launcher', destination: 'program/soffice' }],
    pdf: [{ helper: 'autoforge-pdf-raster', destination: 'bin/autoforge-pdf-raster' }],
    media: [],
  }
  const helpersRoot = join(root, 'helpers')
  mkdirSync(helpersRoot)
  const helperRecords = new Map()
  for (const helper of Object.values(nativeHelpers).flat()) {
    const path = fixtureFile(helpersRoot, helper.destination)
    chmodSync(path, 0o755)
    const bytes = readFileSync(path)
    helperRecords.set(helper.helper, {
      ...helper, path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength, mode: 0o755,
    })
  }
  const engineAssetsRoot = join(root, 'engine-assets')
  mkdirSync(engineAssetsRoot)
  const dmgPath = fixtureFile(engineAssetsRoot, 'Assets/dmg')
  const engineLicensePath = fixtureFile(engineAssetsRoot, 'Licenses/libreoffice')
  const dmgBytes = readFileSync(dmgPath)
  const engineLicenseBytes = readFileSync(engineLicensePath)
  const documentAsset = {
    engine: 'libreoffice', source: 'acquisition', destination: 'share/LibreOffice.dmg',
    sha256: createHash('sha256').update(dmgBytes).digest('hex'), bytes: dmgBytes.byteLength,
    executable: false, role: 'data',
  }
  const documentLicense = {
    engine: 'libreoffice', source: 'https://licenses.example.test/libreoffice',
    destination: 'LICENSES/libreoffice.txt',
    sha256: createHash('sha256').update(engineLicenseBytes).digest('hex'), bytes: engineLicenseBytes.byteLength,
  }
  const families = Object.fromEntries(Object.entries(destinationSets).map(([name, destinations]) => {
    const formula = formulaNames[name]
    const files = formula ? destinations.map((destination) => lockedFile(universeRoot, formula, '1.0', destination, destination, true).lock) : []
    if (formula) versions[formula] = '1.0'
    if (name === 'image-icon') files.push(lockedFile(universeRoot, formula, '1.0', 'share/runtime.dat', 'share/runtime.dat', false, 'data').lock)
    const licenseFile = formula ? lockedFile(universeRoot, formula, '1.0', 'LICENSE', `LICENSES/${formula}.txt`, false, 'data') : undefined
    return [name, {
      files,
      rewrites: [],
      licenses: licenseFile ? [{
        formula,
        source: 'LICENSE',
        destination: `LICENSES/${formula}.txt`,
        sha256: licenseFile.lock.sha256,
        bytes: licenseFile.lock.bytes,
      }] : [],
      nativeHelpers: nativeHelpers[name],
      engineAssets: name === 'document' ? [documentAsset] : [],
      engineLicenses: name === 'document' ? [documentLicense] : [],
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
  const sourceLockPath = join(root, 'sources.lock.json')
  writeFileSync(sourceLockPath, canonicalBytes({ fixture: true }))
  const sourceLock = { target: 'darwin-arm64', engines: [] }
  const request = (target: 'darwin-arm64' | 'darwin-x64', output: string) => ({
    target, output, version: '1.2.3', sequence: 17,
    generatedAt: '2026-08-31T00:00:00.000Z',
    archiveBaseUrl: 'https://cdn.example.test/converter-packs',
    sourceLockPath,
    universeRoot,
    helpersRoot,
    engineAssetsRoot,
  })
  const dependencies = {
    loadClosure: async ({ target }: { target: string }) => ({ sourceLock: { ...sourceLock, target }, closureLock: { ...closure, target }, target }),
    openUniverse: async ({ closureLock }: { closureLock: { target: string } }) => ({
      ...universe,
      target: closureLock.target,
      resolveLockedLicense(license: { source: string; sha256: string }) {
        if (Object.keys(license).sort().join('\0') !== ['bytes', 'formula', 'sha256', 'source'].join('\0')) {
          throw new Error('downloaded license resolver received an inexact request')
        }
        return license.source.startsWith('https://')
          ? join(universeRoot, 'Licenses', license.sha256)
          : universe.resolveLockedFile((license as { formula: string }).formula, license.source)
      },
    }),
    openHelpers: async ({ target }: { target: string }) => ({
      target,
      async resolveHelper(helper: string) { return helperRecords.get(helper) },
    }),
    openEngineAssets: async ({ target }: { target: string }) => ({
      target,
      async resolveEngineAsset() { return dmgPath },
      async resolveEngineLicense() { return engineLicensePath },
    }),
    inspectHelper: async () => ({ architectures: ['arm64', 'x86_64'], dependencies: ['/usr/lib/libSystem.B.dylib'], rpaths: [] }),
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

describe('converter pack Mach-O closure', () => {
  it('discovers fixed family entrypoints, recursive Mach-O dependencies, runtime policy files, and bottle licenses', async () => {
    const root = temporaryRoot()
    const vips = discoveryFile(root, 'vips', '8.18.6', 'bin/vips')
    const libvips = discoveryFile(root, 'vips', '8.18.6', 'lib/libvips.42.dylib')
    const glib = discoveryFile(root, 'glib', '2.86.0', 'lib/libglib-2.0.0.dylib')
    const schemas = discoveryFile(root, 'glib', '2.86.0', 'share/glib-2.0/schemas/gschemas.compiled')
    const ignoredData = discoveryFile(root, 'glib', '2.86.0', 'share/arbitrary/host-controlled.dat')
    const vipsLicense = discoveryFile(root, 'vips', '8.18.6', 'share/licenses/vips/COPYING')
    const vipsLowerPriorityLicense = discoveryFile(root, 'vips', '8.18.6', 'share/licenses/vips/LICENSE.third-party')
    const glibLicense = discoveryFile(root, 'glib', '2.86.0', 'share/licenses/glib/LICENSE')
    const dependency = '@@HOMEBREW_CELLAR@@/vips/8.18.6/lib/libvips.42.dylib'
    const prefixDependency = '@@HOMEBREW_PREFIX@@/opt/glib/lib/libglib-2.0.0.dylib'
    const inspections = new Map([
      [vips.source, { architectures: ['arm64'], dependencies: [dependency, prefixDependency, '/usr/lib/libSystem.B.dylib'], rpaths: [] }],
      [libvips.source, { architectures: ['arm64'], dependencies: [], rpaths: [] }],
      [glib.source, { architectures: ['arm64'], dependencies: [], rpaths: [] }],
    ])

    const discovered = await discoverMachOClosure({
      family: 'image-icon',
      architecture: 'arm64',
      files: [ignoredData, glibLicense, vipsLowerPriorityLicense, schemas, glib, vipsLicense, libvips, vips],
      inspect: async (path: string) => inspections.get(path),
    })

    expect(discovered.entrypoints).toEqual([{ source: vips.source, destination: 'bin/vips' }])
    expect(discovered.files).toEqual([
      { ...vips, destination: 'bin/vips', executable: true, role: 'executable', runtimeRoot: false },
      { ...glib, destination: 'lib/glib/libglib-2.0.0.dylib', executable: false, role: 'code', runtimeRoot: false },
      { ...libvips, destination: 'lib/vips/libvips.42.dylib', executable: false, role: 'code', runtimeRoot: false },
      { ...schemas, destination: 'share/runtime/glib/share/glib-2.0/schemas/gschemas.compiled', executable: false, role: 'data', runtimeRoot: false },
    ])
    expect(discovered.rewrites).toEqual([
      { destination: 'bin/vips', dependency, replacement: '@loader_path/../lib/vips/libvips.42.dylib' },
      { destination: 'bin/vips', dependency: prefixDependency, replacement: '@loader_path/../lib/glib/libglib-2.0.0.dylib' },
    ])
    expect(discovered.licenses).toEqual([
      { ...glibLicense, destination: 'LICENSES/glib.LICENSE' },
      { ...vipsLicense, destination: 'LICENSES/vips.COPYING' },
    ])
    expect(discovered.files.some((file: { sourcePath: string }) => file.sourcePath === ignoredData.sourcePath)).toBe(false)

    const plan = await planMachOClosure({
      architecture: 'arm64',
      entrypoints: discovered.entrypoints,
      expectedFiles: discovered.files.map((file) => ({
        formula: file.formula,
        sourcePath: file.sourcePath,
        destination: file.destination,
        sha256: file.sha256,
        bytes: file.bytes,
        executable: file.executable,
        role: file.role,
        runtimeRoot: file.runtimeRoot,
      })),
      expectedRewrites: discovered.rewrites,
      inspect: async (path: string) => inspections.get(path),
      universe: syntheticUniverse(root, { vips: '8.18.6', glib: '2.86.0' }),
    })
    expect(plan.rewrites).toEqual(discovered.rewrites)
  })

  it('fails closed when a discovered contributing formula has no bottle license', async () => {
    const root = temporaryRoot()
    const tool = discoveryFile(root, 'vips', '8.18.6', 'bin/vips')
    await expect(discoverMachOClosure({
      family: 'image-icon',
      architecture: 'arm64',
      files: [tool],
      inspect: async () => ({ architectures: ['arm64'], dependencies: [], rpaths: [] }),
    })).rejects.toThrow(/license/iu)
  })

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
    await expect(planMachOClosure({ ...request(), inspect: async (path: string) => path === tool.source ? { architectures: ['arm64'], dependencies: ['/usr/lib/../local/libsame.dylib'], rpaths: [] } : inspect(path) })).rejects.toThrow(/absolute|host|system/iu)
    await expect(planMachOClosure({ ...request(), inspect: async (path: string) => path === tool.source ? { architectures: ['arm64'], dependencies: ['@@HOMEBREW_CELLAR@@/glib/0/lib/libsame.dylib'], rpaths: [] } : inspect(path) })).rejects.toThrow(/locked|version|formula/iu)
    await expect(planMachOClosure({
      ...request(),
      inspect: async (path: string) => path === tool.source
        ? { architectures: ['arm64'], dependencies: ['@loader_path/../../../glib/2.86.0/share/runtime.dat'], rpaths: [] }
        : inspect(path),
      expectedRewrites: [],
    })).rejects.toThrow(/code file/iu)

    const otherExecutable = lockedFile(root, 'vips', '8.18.6', 'bin/tool-two', 'bin/tool-two', true)
    await expect(planMachOClosure({
      ...request(),
      inspect: async (path: string) => path === tool.source
        ? { architectures: ['arm64'], dependencies: ['@loader_path/tool-two'], rpaths: [] }
        : inspect(path),
      expectedFiles: [...request().expectedFiles, otherExecutable.lock],
      expectedRewrites: [],
    })).rejects.toThrow(/code file/iu)

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
    const library = fixtureFile(payload, 'lib/a/liba.dylib')
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
        files: [
          { source: executable, destination: 'bin/tool', executable: true, formula: 'tool', role: 'executable' },
          { source: library, destination: 'lib/a/liba.dylib', executable: false, formula: 'a', role: 'code' },
        ],
        rewrites: [{ destination: 'bin/tool', dependency: '/brew/liba.dylib', replacement: '@loader_path/../lib/a/liba.dylib' }],
      },
      run,
    })

    expect(calls).toContainEqual({
      executable: '/usr/bin/install_name_tool',
      args: ['-change', '/brew/liba.dylib', '@loader_path/../lib/a/liba.dylib', executable],
    })
    expect(calls.every((call) => call.executable.startsWith('/usr/bin/'))).toBe(true)

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

  it.each([
    ['missing', '@loader_path/../lib/a/ghost.dylib'],
    ['data', '@loader_path/../share/runtime.dat'],
    ['executable', '@loader_path/tool'],
    ['noncanonical system', '/usr/lib/../local/libbad.dylib'],
  ])('rejects a post-relocation %s dependency outside the exact code inventory', async (_label, dependency) => {
    const root = temporaryRoot()
    const payload = join(root, 'payload')
    const tool = fixtureFile(payload, 'bin/tool')
    const data = fixtureFile(payload, 'share/runtime.dat')
    const plan = {
      files: [
        { source: tool, destination: 'bin/tool', executable: true, formula: 'tool', role: 'executable' },
        { source: data, destination: 'share/runtime.dat', executable: false, formula: 'tool', role: 'data' },
      ],
      rewrites: [],
    }
    const run = async (command: string, args: readonly string[]) => {
      if (command === '/usr/bin/lipo') return { status: 0, stdout: 'arm64\n', stderr: '' }
      if (command === '/usr/bin/otool' && args[0] === '-L') return { status: 0, stdout: `${args[1]}:\n\t${dependency} (compatibility version 1.0.0, current version 1.0.0)\n`, stderr: '' }
      if (command === '/usr/bin/otool' && args[0] === '-l') return { status: 0, stdout: '', stderr: '' }
      if (command === '/usr/bin/install_name_tool') return { status: 0, stdout: '', stderr: '' }
      throw new Error('unexpected command')
    }
    await expect(relocateMachOClosure({ payload, architecture: 'arm64', plan, run })).rejects.toThrow(/unresolved|inventory/iu)
  })

  it.each([
    ['data', '@loader_path/../share/runtime.dat'],
    ['executable', '@loader_path/tool-two'],
  ])('rejects a rewrite whose replacement resolves to a %s file', async (_label, replacement) => {
    const root = temporaryRoot()
    const payload = join(root, 'payload')
    const tool = fixtureFile(payload, 'bin/tool')
    const toolTwo = fixtureFile(payload, 'bin/tool-two')
    const data = fixtureFile(payload, 'share/runtime.dat')
    let calls = 0
    await expect(relocateMachOClosure({
      payload,
      architecture: 'arm64',
      plan: {
        files: [
          { source: tool, destination: 'bin/tool', executable: true, formula: 'tool', role: 'executable' },
          { source: toolTwo, destination: 'bin/tool-two', executable: true, formula: 'tool', role: 'executable' },
          { source: data, destination: 'share/runtime.dat', executable: false, formula: 'tool', role: 'data' },
        ],
        rewrites: [{ destination: 'bin/tool', dependency: '@rpath/bad.dylib', replacement }],
      },
      run: async () => { calls += 1; return { status: 0, stdout: '', stderr: '' } },
    })).rejects.toThrow(/code destination/iu)
    expect(calls).toBe(0)
  })

  it('rejects symbolic payload roots and symbolic or hard-linked binaries before invoking tools', async () => {
    const root = temporaryRoot()
    const realPayload = join(root, 'real-payload')
    const tool = fixtureFile(realPayload, 'bin/tool')
    const symbolicPayload = join(root, 'payload-link')
    symlinkSync(realPayload, symbolicPayload)
    let calls = 0
    const run = async () => { calls += 1; return { status: 0, stdout: '', stderr: '' } }
    const plan = { files: [{ source: tool, destination: 'bin/tool', executable: true, formula: 'tool', role: 'executable' }], rewrites: [] }
    await expect(relocateMachOClosure({ payload: symbolicPayload, architecture: 'arm64', plan, run })).rejects.toThrow(/payload|symbolic|canonical/iu)
    await expect(adhocSignMachOClosure({ payload: symbolicPayload, plan, run })).rejects.toThrow(/payload|symbolic|canonical/iu)

    const outside = fixtureFile(root, 'outside/tool')
    rmSync(tool)
    symlinkSync(outside, tool)
    await expect(relocateMachOClosure({ payload: realPayload, architecture: 'arm64', plan, run })).rejects.toThrow(/binary|symbolic|regular/iu)
    await expect(adhocSignMachOClosure({ payload: realPayload, plan, run })).rejects.toThrow(/binary|symbolic|regular/iu)
    rmSync(tool)
    linkSync(outside, tool)
    await expect(relocateMachOClosure({ payload: realPayload, architecture: 'arm64', plan, run })).rejects.toThrow(/binary|regular/iu)
    await expect(adhocSignMachOClosure({ payload: realPayload, plan, run })).rejects.toThrow(/binary|regular/iu)
    expect(calls).toBe(0)
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

  it('accepts an exact empty bottle closure and seeds an explicit runtime code root', async () => {
    const root = temporaryRoot()
    const universe = syntheticUniverse(root, {})
    await expect(planMachOClosure({
      entrypoints: [], architecture: 'arm64', inspect: async () => undefined,
      universe, expectedFiles: [], expectedRewrites: [],
    })).resolves.toEqual({ files: [], rewrites: [] })

    const module = lockedFile(root, 'module', '1.0', 'lib/module.dylib', 'lib/module/module.dylib', false, 'code', true)
    const moduleUniverse = syntheticUniverse(root, { module: '1.0' })
    await expect(planMachOClosure({
      entrypoints: [], architecture: 'arm64',
      inspect: async () => ({ architectures: ['arm64'], dependencies: ['/usr/lib/libSystem.B.dylib'], rpaths: [] }),
      universe: moduleUniverse, expectedFiles: [module.lock], expectedRewrites: [],
    })).resolves.toMatchObject({ files: [{ destination: 'lib/module/module.dylib' }] })
    await expect(planMachOClosure({
      entrypoints: [{ source: module.source, destination: module.lock.destination }], architecture: 'arm64',
      inspect: async () => ({ architectures: ['arm64'], dependencies: [], rpaths: [] }),
      universe: moduleUniverse, expectedFiles: [module.lock], expectedRewrites: [],
    })).rejects.toThrow('Mach-O entrypoint is not in the locked inventory.')

    const executable = lockedFile(root, 'module', '1.0', 'bin/tool', 'bin/tool', true)
    const plan = await planMachOClosure({
      entrypoints: [{ source: executable.source, destination: executable.lock.destination }], architecture: 'arm64',
      inspect: async () => ({ architectures: ['arm64'], dependencies: [], rpaths: [] }),
      universe: moduleUniverse, expectedFiles: [executable.lock, module.lock], expectedRewrites: [],
    })
    expect(plan.files.map((file) => file.destination)).toEqual(['bin/tool', 'lib/module/module.dylib'])
  })

  it('preserves entrypoint executable-path resolution when reachable code is also a runtime root', async () => {
    const root = temporaryRoot()
    const tool = lockedFile(root, 'tool', '1.0', 'bin/tool', 'bin/tool', true)
    const module = lockedFile(root, 'tool', '1.0', 'lib/module.dylib', 'lib/tool/module.dylib', false, 'code', true)
    const companion = lockedFile(root, 'tool', '1.0', 'bin/companion.dylib', 'lib/tool/companion.dylib')
    const inspections = new Map([
      [tool.source, { architectures: ['arm64'], dependencies: ['@@HOMEBREW_CELLAR@@/tool/1.0/lib/module.dylib'], rpaths: [] }],
      [module.source, { architectures: ['arm64'], dependencies: ['@executable_path/companion.dylib'], rpaths: [] }],
      [companion.source, { architectures: ['arm64'], dependencies: [], rpaths: [] }],
    ])

    const plan = await planMachOClosure({
      entrypoints: [{ source: tool.source, destination: tool.lock.destination }],
      architecture: 'arm64',
      inspect: async (path: string) => inspections.get(path),
      universe: syntheticUniverse(root, { tool: '1.0' }),
      expectedFiles: [tool.lock, module.lock, companion.lock],
      expectedRewrites: [
        { destination: 'bin/tool', dependency: '@@HOMEBREW_CELLAR@@/tool/1.0/lib/module.dylib', replacement: '@loader_path/../lib/tool/module.dylib' },
        { destination: 'lib/tool/module.dylib', dependency: '@executable_path/companion.dylib', replacement: '@loader_path/companion.dylib' },
      ],
    })
    expect(plan.files.map((file) => file.destination)).toContain('lib/tool/companion.dylib')
  })

  it('rejects executable-path dependencies from an independent runtime root without a host executable', async () => {
    const root = temporaryRoot()
    const module = lockedFile(root, 'module', '1.0', 'lib/module.dylib', 'lib/module/module.dylib', false, 'code', true)

    await expect(planMachOClosure({
      entrypoints: [], architecture: 'arm64',
      inspect: async () => ({ architectures: ['arm64'], dependencies: ['@executable_path/companion.dylib'], rpaths: [] }),
      universe: syntheticUniverse(root, { module: '1.0' }), expectedFiles: [module.lock], expectedRewrites: [],
    })).rejects.toThrow('Independent Mach-O runtime root cannot resolve @executable_path.')
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

    await stageProductionPacks(fixture.request('darwin-arm64', output), dependencies)

    expect(probed.sort()).toEqual(['document', 'image-icon', 'media', 'pdf'])
    expect(JSON.parse(readFileSync(join(output, 'release.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      generatedAt: '2026-08-31T00:00:00.000Z',
      sequence: 17,
    })
    const packNames = ['document', 'image-icon', 'media', 'pdf']
    const expectedExecutables: Record<string, string[]> = {
      'image-icon': ['bin/autoforge-image-converter', 'bin/vips'],
      document: ['program/soffice'],
      pdf: ['bin/autoforge-pdf-raster', 'bin/pdfinfo', 'bin/pdftocairo'],
      media: ['bin/ffmpeg', 'bin/ffprobe'],
    }
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
      expect(manifest.files.filter((file) => file.role === 'executable').map((file) => file.path).sort())
        .toEqual(expectedExecutables[name]!.sort())
    }
    expect(readFileSync(join(output, 'packs/document-darwin-arm64/payload/share/LibreOffice.dmg'))).toBeTruthy()
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

  it('preserves the staging failure first when output cleanup also fails', async () => {
    const root = temporaryRoot()
    const output = join(root, 'release-input')
    const fixture = stagingFixture(root)
    const failure = await stageProductionPacks(fixture.request('darwin-arm64', output), {
      ...fixture.dependencies,
      probeFamily: async () => { throw new Error('capability primary') },
      removeOutput: async () => {
        const error = new Error('output rm EACCES') as Error & { code: string }
        error.code = 'EACCES'
        throw error
      },
    }).then(() => undefined, (error: unknown) => error as AggregateError)

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.message).toBe('capability primary')
    expect(failure.errors.map((error) => (error as Error).message))
      .toEqual(['capability primary', 'output rm EACCES'])
  })

  it('rejects a native helper with any non-system dependency', async () => {
    const root = temporaryRoot()
    const output = join(root, 'release-input')
    const fixture = stagingFixture(root)
    await expect(stageProductionPacks(fixture.request('darwin-arm64', output), {
      ...fixture.dependencies,
      inspectHelper: async () => ({
        architectures: ['arm64'], dependencies: ['@loader_path/libhost.dylib'], rpaths: [],
      }),
    })).rejects.toThrow('Native helper Mach-O inventory is invalid.')
    expect(() => realpathSync(output)).toThrow()
  })

  it('rejects a non-canonical absolute dependency disguised by a system prefix', async () => {
    const root = temporaryRoot()
    const output = join(root, 'release-input')
    const fixture = stagingFixture(root)
    await expect(stageProductionPacks(fixture.request('darwin-arm64', output), {
      ...fixture.dependencies,
      inspectHelper: async () => ({
        architectures: ['arm64'], dependencies: ['/usr/lib/../local/libhost.dylib'], rpaths: [],
      }),
    })).rejects.toThrow('Native helper Mach-O inventory is invalid.')
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
      sourceLockPath: join(root, 'sources.lock.json'),
      universeRoot: join(root, 'universe'),
      helpersRoot: join(root, 'helpers'),
      engineAssetsRoot: join(root, 'engine-assets'),
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

  it('stages an authenticated downloaded license only from universe/Licenses/<sha256>', async () => {
    const root = temporaryRoot()
    const fixture = stagingFixture(root)
    const license = fixture.closure.families.media.licenses[0]
    const bytes = readFileSync(fixture.universe.resolveLockedFile(license.formula, license.source))
    license.source = 'https://licenses.example.test/media.txt'
    mkdirSync(join(fixture.request('darwin-arm64', join(root, 'ignored')).universeRoot, 'Licenses'))
    writeFileSync(join(fixture.request('darwin-arm64', join(root, 'ignored')).universeRoot, 'Licenses', license.sha256), bytes)
    const output = join(root, 'download-license-output')

    await stageProductionPacks(fixture.request('darwin-arm64', output), fixture.dependencies)

    expect(readFileSync(join(output, 'packs/media-darwin-arm64/payload', license.destination))).toEqual(bytes)
  })

  it('reports CLI failures with a fixed path-free message', async () => {
    const root = temporaryRoot()
    const secretPath = join(root, 'private-plan.json')
    const output: string[] = []
    const exitCode = await stageProductionPacksMain(['--plan', secretPath], {
      stdout: { write: (value: string) => { output.push(value); return true } },
      stderr: { write: (value: string) => { output.push(value); return true } },
    })
    expect(exitCode).toBe(1)
    expect(output.join('')).toBe('converter pack staging failed\n')
    expect(output.join('')).not.toContain(root)
  })
})
