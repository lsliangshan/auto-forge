import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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

describe('verified converter source license selection', () => {
  it('searches only the source root and its first wrapper level', async () => {
    const root = temporaryRoot()
    const wrapper = join(root, 'libreoffice-26.8.0.3')
    const expected = fixtureFile(wrapper, 'COPYING')
    const deep = join(wrapper, 'vendor', 'large-source-tree')
    mkdirSync(deep, { recursive: true })
    for (let index = 0; index < 512; index += 1) {
      writeFileSync(join(deep, `unrelated-${index.toString().padStart(4, '0')}`), 'fixture')
    }
    fixtureFile(deep, 'COPYING')
    chmodSync(deep, 0o000)

    try {
      await expect(selectVerifiedSourceLicense(root, ['COPYING', 'LICENSE'], 'libreoffice')).resolves.toBe(expected)
    } finally {
      chmodSync(deep, 0o700)
    }
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
    const valid = fixtureFile(symbolicRoot, 'COPYING')
    mkdirSync(join(symbolicRoot, 'wrapper'))
    symlinkSync(valid, join(symbolicRoot, 'wrapper', 'COPYING'))
    await expect(selectVerifiedSourceLicense(symbolicRoot, ['COPYING', 'LICENSE'], 'libreoffice')).rejects.toThrow(/unsupported/iu)

    const nonRegularRoot = temporaryRoot()
    fixtureFile(nonRegularRoot, 'COPYING')
    mkdirSync(join(nonRegularRoot, 'wrapper', 'LICENSE'), { recursive: true })
    await expect(selectVerifiedSourceLicense(nonRegularRoot, ['COPYING', 'LICENSE'], 'libreoffice')).rejects.toThrow(/unsupported/iu)
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

    const library = fixtureFile(payload, 'lib/liba.dylib')
    await expect(relocateMachOClosure({
      payload,
      architecture: 'arm64',
      plan: { files: [{ source: library, destination: 'lib/liba.dylib', executable: false }], rewrites: [] },
      run: async (command: string, args: readonly string[]) => {
        if (command === '/usr/bin/lipo') return { status: 0, stdout: 'arm64\n', stderr: '' }
        if (command === '/usr/bin/otool' && args[0] === '-L') {
          return { status: 0, stdout: `${args[1]}:\n\t@rpath/liba.dylib (compatibility version 1.0.0, current version 1.0.0)\n`, stderr: '' }
        }
        if (command === '/usr/bin/otool' && args[0] === '-l') return { status: 0, stdout: '', stderr: '' }
        if (command === '/usr/bin/install_name_tool') return { status: 0, stdout: '', stderr: '' }
        throw new Error(`unexpected command: ${command}`)
      },
    })).resolves.toBeUndefined()

    const signCalls: string[] = []
    await adhocSignMachOClosure({
      payload,
      plan: {
        files: [
          { source: executable, destination: 'bin/tool', executable: true },
          { source: library, destination: 'lib/liba.dylib', executable: false },
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
    const tool = fixtureFile(root, 'Cellar/tool/1.0/bin/tool')
    const libA = fixtureFile(root, 'Cellar/tool/1.0/lib/liba.1.dylib')
    const libB = fixtureFile(root, 'Cellar/tool/1.0/lib/libb.2.dylib')
    const inspections = new Map([
      [tool, { architectures: ['arm64'], dependencies: [libA, '@rpath/libb.2.dylib', '/usr/lib/libSystem.B.dylib'], rpaths: ['@loader_path/../lib'] }],
      [libA, { architectures: ['arm64'], dependencies: ['@loader_path/libb.2.dylib'], rpaths: [] }],
      [libB, { architectures: ['arm64'], dependencies: ['/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation'], rpaths: [] }],
    ])

    const plan = await planMachOClosure({
      entrypoints: [{ source: tool, destination: 'bin/tool' }],
      architecture: 'arm64',
      inspect: async (path: string) => inspections.get(path),
    })

    expect(plan.files).toEqual([
      { source: tool, destination: 'bin/tool', executable: true },
      { source: libA, destination: 'lib/liba.1.dylib', executable: false },
      { source: libB, destination: 'lib/libb.2.dylib', executable: false },
    ])
    expect(plan.rewrites).toContainEqual({
      destination: 'bin/tool',
      dependency: libA,
      replacement: '@loader_path/../lib/liba.1.dylib',
    })
    expect(plan.rewrites).toContainEqual({
      destination: 'lib/liba.1.dylib',
      dependency: '@loader_path/libb.2.dylib',
      replacement: '@loader_path/libb.2.dylib',
    })
  })

  it('rejects architecture mismatches, unresolved dependencies, and destination collisions', async () => {
    const root = temporaryRoot()
    const tool = fixtureFile(root, 'tool/bin/tool')
    const first = fixtureFile(root, 'first/lib/libsame.dylib')
    const second = fixtureFile(root, 'second/lib/libsame.dylib')

    await expect(planMachOClosure({
      entrypoints: [{ source: tool, destination: 'bin/tool' }],
      architecture: 'arm64',
      inspect: async () => ({ architectures: ['x86_64'], dependencies: [], rpaths: [] }),
    })).rejects.toThrow(/architecture/iu)

    await expect(planMachOClosure({
      entrypoints: [{ source: tool, destination: 'bin/tool' }],
      architecture: 'arm64',
      inspect: async () => ({ architectures: ['arm64'], dependencies: ['@rpath/missing.dylib'], rpaths: [] }),
    })).rejects.toThrow(/unresolved/iu)

    const inspections = new Map([
      [tool, { architectures: ['arm64'], dependencies: [first, second], rpaths: [] }],
      [first, { architectures: ['arm64'], dependencies: [], rpaths: [] }],
      [second, { architectures: ['arm64'], dependencies: [], rpaths: [] }],
    ])
    await expect(planMachOClosure({
      entrypoints: [{ source: tool, destination: 'bin/tool' }],
      architecture: 'arm64',
      inspect: async (path: string) => inspections.get(path),
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
    const source = join(root, 'source')
    const output = join(root, 'release-input')
    const executable = (name: string) => {
      const path = fixtureFile(source, `bin/${name}`)
      chmodSync(path, 0o755)
      return path
    }
    const license = (name: string) => fixtureFile(source, `licenses/${name}.txt`)
    const data = fixtureFile(source, 'share/runtime.dat')
    const families = {
      'image-icon': {
        entrypoints: [
          { source: executable('autoforge-image-converter'), destination: 'bin/autoforge-image-converter' },
          { source: executable('vips'), destination: 'bin/vips' },
        ],
        assets: [
          { source: license('libvips'), destination: 'LICENSES/libvips.txt', role: 'license' },
          { source: data, destination: 'share/runtime.dat', role: 'data' },
        ],
      },
      document: {
        entrypoints: [{ source: executable('soffice'), destination: 'program/soffice' }],
        assets: [{ source: license('libreoffice'), destination: 'LICENSES/libreoffice.txt', role: 'license' }],
      },
      pdf: {
        entrypoints: [
          { source: executable('autoforge-pdf-raster'), destination: 'bin/autoforge-pdf-raster' },
          { source: executable('pdfinfo'), destination: 'bin/pdfinfo' },
          { source: executable('pdftocairo'), destination: 'bin/pdftocairo' },
        ],
        assets: [{ source: license('poppler'), destination: 'LICENSES/poppler.txt', role: 'license' }],
      },
      media: {
        entrypoints: [
          { source: executable('ffmpeg'), destination: 'bin/ffmpeg' },
          { source: executable('ffprobe'), destination: 'bin/ffprobe' },
        ],
        assets: [{ source: license('ffmpeg'), destination: 'LICENSES/ffmpeg.txt', role: 'license' }],
      },
    }
    const probed: string[] = []
    const dependencies = {
      planClosure: async ({ entrypoints }: { entrypoints: Array<{ source: string; destination: string }> }) => ({
        files: entrypoints.map((entrypoint) => ({ ...entrypoint, executable: true })),
        rewrites: [],
      }),
      applyRelocation: async () => undefined,
      probeFamily: async ({ name }: { name: string }) => { probed.push(name) },
    }

    await stageProductionPacks({
      target: 'darwin-arm64',
      output,
      version: '1.2.3',
      sequence: 17,
      generatedAt: '2026-08-31T00:00:00.000Z',
      archiveBaseUrl: 'https://cdn.example.test/converter-packs',
      families,
    }, dependencies)

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
    await stageProductionPacks({
      target: 'darwin-x64', output: x64Output, version: '1.2.3', sequence: 17,
      generatedAt: '2026-08-31T00:00:00.000Z',
      archiveBaseUrl: 'https://cdn.example.test/converter-packs', families,
    }, dependencies)
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
    const tool = fixtureFile(root, 'source/tool')
    chmodSync(tool, 0o755)
    const license = fixtureFile(root, 'source/license.txt')
    const family = (entrypoints: string[]) => ({
      entrypoints: entrypoints.map((destination) => ({ source: tool, destination })),
      assets: [{ source: license, destination: 'LICENSES/license.txt', role: 'license' }],
    })
    const families = {
      'image-icon': family(['bin/autoforge-image-converter', 'bin/vips']),
      document: family(['program/soffice']),
      pdf: family(['bin/autoforge-pdf-raster', 'bin/pdfinfo', 'bin/pdftocairo']),
      media: family(['bin/ffmpeg', 'bin/ffprobe']),
    }

    await expect(stageProductionPacks({
      target: 'darwin-arm64', output, version: '1.2.3', sequence: 17,
      generatedAt: '2026-08-31T00:00:00.000Z',
      archiveBaseUrl: 'https://cdn.example.test/converter-packs', families,
    }, {
      planClosure: async ({ entrypoints }: { entrypoints: Array<{ source: string; destination: string }> }) => ({
        files: entrypoints.map((entrypoint) => ({ ...entrypoint, executable: true })), rewrites: [],
      }),
      applyRelocation: async () => undefined,
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
      families: {},
    }, {})).rejects.toThrow(/target/iu)
  })
})
