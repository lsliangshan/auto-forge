import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { captureHomebrewTarget } from '../../scripts/converter-packs/capture-homebrew-target.mjs'
import { generateTransitiveSourceLock } from '../../scripts/converter-packs/generate-transitive-source-lock.mjs'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'
import { loadConverterClosureLock } from '../../scripts/converter-packs/closure-lock.mjs'

const rootsToRemove: string[] = []
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
type RunOptions = { cwd: string; env: Record<string, string> }
type CapturedCall = { executable: string; args: string[]; options: RunOptions }

afterEach(() => {
  for (const root of rootsToRemove.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-lock-generation-')))
  rootsToRemove.push(root)
  return root
}

function targetForHost() {
  return process.arch === 'x64' ? 'darwin-x64' : 'darwin-arm64'
}

function tagForTarget(target: string) {
  return target === 'darwin-arm64' ? 'arm64_sequoia' : 'sonoma'
}

function cellarForTarget(target: string) {
  return target === 'darwin-arm64' ? '/opt/homebrew/Cellar' : '/usr/local/Cellar'
}

function tarString(header: Buffer, offset: number, length: number, value: string) {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8')
}

function tarOctal(header: Buffer, offset: number, length: number, value: number) {
  tarString(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

function tarFile(path: string, bytes: Buffer, mode: number) {
  const header = Buffer.alloc(512)
  tarString(header, 0, 100, path)
  tarOctal(header, 100, 8, mode)
  tarOctal(header, 108, 8, 0)
  tarOctal(header, 116, 8, 0)
  tarOctal(header, 124, 12, bytes.byteLength)
  tarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  tarString(header, 156, 1, '0')
  tarString(header, 257, 6, 'ustar\0')
  tarString(header, 263, 2, '00')
  const checksum = header.reduce((sum, value) => sum + value, 0)
  tarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return [header, bytes, Buffer.alloc((512 - (bytes.byteLength % 512)) % 512)]
}

function tarDirectory(path: string) {
  const header = Buffer.alloc(512)
  tarString(header, 0, 100, path)
  tarOctal(header, 100, 8, 0o755)
  tarOctal(header, 108, 8, 0)
  tarOctal(header, 116, 8, 0)
  tarOctal(header, 124, 12, 0)
  tarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  tarString(header, 156, 1, '5')
  tarString(header, 257, 6, 'ustar\0')
  tarString(header, 263, 2, '00')
  const checksum = header.reduce((sum, value) => sum + value, 0)
  tarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return header
}

function bottleArchive(formula: string, version: string, entries: Array<{ path: string; bytes: Buffer; mode: number }>) {
  const blocks = [tarDirectory(`${formula}/`), tarDirectory(`${formula}/${version}/`)]
  for (const entry of entries) blocks.push(...tarFile(`${formula}/${version}/${entry.path}`, entry.bytes, entry.mode))
  blocks.push(Buffer.alloc(1_024))
  return gzipSync(Buffer.concat(blocks), { mtime: 0 })
}

function captureFixture(target = targetForHost()) {
  const formulae = [
    { name: 'vips', version: '8.18.6', revision: 0, license: 'LGPL-2.1-or-later', dependencies: ['glib'] },
    { name: 'poppler', version: '26.8.0', revision: 0, license: 'GPL-3.0-only', dependencies: ['glib'] },
    { name: 'glib', version: '2.86.0', revision: 0, license: 'LGPL-2.1-or-later', dependencies: [] },
    { name: 'ffmpeg', version: '9.0.1+1', revision: 1, license: 'GPL-3.0-or-later', dependencies: ['glib'] },
  ]
  const fileBytes = (formula: string, sourcePath: string) => Buffer.from(`${formula}-${sourcePath}`)
  const licenseBytes = (formula: string) => Buffer.from(`${formula}-license`)
  const license = (formula: string) => ({
    formula,
    source: 'LICENSE',
    destination: `LICENSES/${formula}.LICENSE`,
    sha256: sha256(`${formula}-license`),
    bytes: Buffer.byteLength(`${formula}-license`),
  })
  const file = (formula: string, sourcePath: string, destination: string, executable = true, role = executable ? 'executable' : 'code', runtimeRoot = false) => ({
    formula, sourcePath, destination, sha256: sha256(fileBytes(formula, sourcePath)),
    bytes: fileBytes(formula, sourcePath).byteLength, executable, role, runtimeRoot,
  })
  const libreOfficeBytes = Buffer.from(`libreoffice-${target}`)
  const libreOfficeLicenseBytes = Buffer.from('libreoffice-license')
  const emptyFamily = () => ({ files: [], rewrites: [], licenses: [], nativeHelpers: [], engineAssets: [], engineLicenses: [] })
  const closure = {
    schemaVersion: 1,
    target,
    formulae: formulae.map(({ name, version, dependencies }) => ({ name, version, dependencies: [...dependencies] })).sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name))),
    families: {
      'image-icon': {
        ...emptyFamily(),
        files: [
          file('vips', 'bin/vips', 'bin/vips'),
          file('glib', 'lib/libglib.dylib', 'lib/glib/libglib.dylib', false, 'code'),
          file('vips', 'share/vips/runtime.conf', 'share/vips/runtime.conf', false, 'data'),
        ],
        rewrites: [{
          destination: 'bin/vips',
          dependency: '@@HOMEBREW_PREFIX@@/opt/glib/lib/libglib.dylib',
          replacement: '@loader_path/../lib/glib/libglib.dylib',
        }],
        licenses: [license('glib'), license('vips')],
        nativeHelpers: [{ helper: 'autoforge-image-converter', destination: 'bin/autoforge-image-converter' }],
      },
      document: {
        ...emptyFamily(),
        nativeHelpers: [{ helper: 'autoforge-soffice-launcher', destination: 'program/soffice' }],
        engineAssets: [{
          engine: 'libreoffice', source: 'acquisition', destination: 'share/LibreOffice.dmg',
          sha256: sha256(libreOfficeBytes), bytes: libreOfficeBytes.byteLength, executable: false, role: 'data',
        }],
        engineLicenses: [{
          engine: 'libreoffice', source: 'https://downloads.example.test/libreoffice-LICENSE',
          destination: 'LICENSES/libreoffice.LICENSE', sha256: sha256(libreOfficeLicenseBytes),
          bytes: libreOfficeLicenseBytes.byteLength,
        }],
      },
      pdf: {
        ...emptyFamily(),
        files: [
          file('poppler', 'bin/pdfinfo', 'bin/pdfinfo'),
          file('poppler', 'bin/pdftocairo', 'bin/pdftocairo'),
        ],
        rewrites: [], licenses: [license('poppler')],
        nativeHelpers: [{ helper: 'autoforge-pdf-raster', destination: 'bin/autoforge-pdf-raster' }],
      },
      media: {
        ...emptyFamily(),
        files: [file('ffmpeg', 'bin/ffmpeg', 'bin/ffmpeg'), file('ffmpeg', 'bin/ffprobe', 'bin/ffprobe')],
        rewrites: [], licenses: [license('ffmpeg')],
      },
    },
    measurements: {
      downloadBytes: 1,
      compressedPackBytes: { 'image-icon': 101, document: 102, pdf: 103, media: 104 },
      installedReleaseBytes: 1_001,
    },
  }
  const bottleEntries: Record<string, Array<{ path: string; bytes: Buffer; mode: number }>> = {
    ffmpeg: ['bin/ffmpeg', 'bin/ffprobe'].map((path) => ({ path, bytes: fileBytes('ffmpeg', path), mode: 0o555 })),
    glib: [
      { path: 'lib/libglib.dylib', bytes: fileBytes('glib', 'lib/libglib.dylib'), mode: 0o444 },
    ],
    poppler: ['bin/pdfinfo', 'bin/pdftocairo'].map((path) => ({ path, bytes: fileBytes('poppler', path), mode: 0o555 })),
    vips: [
      { path: 'bin/vips', bytes: fileBytes('vips', 'bin/vips'), mode: 0o555 },
      { path: 'share/vips/runtime.conf', bytes: fileBytes('vips', 'share/vips/runtime.conf'), mode: 0o444 },
    ],
  }
  for (const formula of formulae) bottleEntries[formula.name].push({ path: 'LICENSE', bytes: licenseBytes(formula.name), mode: 0o644 })
  const bottleBytes = new Map(formulae.map((formula) => [
    formula.name,
    bottleArchive(formula.name, formula.version, bottleEntries[formula.name]),
  ]))
  const coordinates = Object.fromEntries(formulae.map(({ name }) => {
    const bytes = bottleBytes.get(name)!
    return [name, {
      kind: 'homebrew-bottle', url: `https://downloads.example.test/${name}-${target}.tar.gz`,
      sha256: sha256(bytes), bytes: bytes.byteLength, cellar: cellarForTarget(target),
    }]
  }))
  closure.measurements.downloadBytes = Object.values(coordinates).reduce((sum, coordinate) => sum + coordinate.bytes, 0)
    + libreOfficeBytes.byteLength + libreOfficeLicenseBytes.byteLength
  const roots = {
    formulae: ['ffmpeg', 'poppler', 'vips'],
    homebrewCaskRevision: '2'.repeat(40),
    engines: [
      { name: 'ffmpeg', version: '9.0.1+1', license: 'GPL-3.0-or-later', rootFormula: 'ffmpeg', acquisition: coordinates.ffmpeg, licenses: [] },
      {
        name: 'libreoffice', version: '26.8.0', license: 'MPL-2.0', rootFormula: null,
        acquisition: {
          kind: 'dmg', url: `https://downloads.example.test/libreoffice-${target}.dmg`,
          sha256: sha256(libreOfficeBytes), bytes: libreOfficeBytes.byteLength, cellar: null,
        },
        licenses: [{
          kind: 'download', url: 'https://downloads.example.test/libreoffice-LICENSE',
          sha256: sha256(libreOfficeLicenseBytes), bytes: libreOfficeLicenseBytes.byteLength,
          destination: 'LICENSES/libreoffice.LICENSE',
        }],
      },
      { name: 'libvips', version: '8.18.6', license: 'LGPL-2.1-or-later', rootFormula: 'vips', acquisition: coordinates.vips, licenses: [] },
      { name: 'poppler', version: '26.8.0', license: 'GPL-3.0-only', rootFormula: 'poppler', acquisition: coordinates.poppler, licenses: [] },
    ],
    closure,
  }
  return { bottleBytes, formulae, coordinates, libreOfficeBytes, libreOfficeLicenseBytes, roots, closure }
}

function brewFormulaJson(fixture: ReturnType<typeof captureFixture>, target = targetForHost()) {
  return {
    formulae: fixture.formulae.map((formula) => ({
      name: formula.name,
      full_name: formula.name,
      tap: 'homebrew/core',
      versions: { stable: formula.version },
      revision: formula.revision,
      license: formula.license,
      dependencies: formula.dependencies,
      bottle: {
        stable: {
          files: {
            [tagForTarget(target)]: {
              cellar: cellarForTarget(target),
              url: fixture.coordinates[formula.name].url,
              sha256: fixture.coordinates[formula.name].sha256,
            },
          },
        },
      },
    })),
    casks: [],
  }
}

function syntheticRun(fixture: ReturnType<typeof captureFixture>, calls: CapturedCall[]) {
  const changedDependencies = new Map<string, string>()
  const identities = new Map<string, string>()
  return async (executable: string, args: string[], options: RunOptions) => {
    calls.push({ executable, args: [...args], options })
    if (args[0] === 'tap-info') {
      return { status: 0, stdout: canonicalBytes([{ name: 'homebrew/core', installed: true, HEAD: '1'.repeat(40) }]), stderr: Buffer.alloc(0) }
    }
    if (args[0] === 'deps') {
      const roots = new Set(fixture.roots.formulae)
      const dependencies = fixture.formulae.map(({ name }) => name).filter((name) => !roots.has(name)).sort()
      return { status: 0, stdout: Buffer.from(`${dependencies.join('\n')}\n`), stderr: Buffer.alloc(0) }
    }
    if (args[0] === 'info') {
      return { status: 0, stdout: canonicalBytes(brewFormulaJson(fixture)), stderr: Buffer.alloc(0) }
    }
    if (executable === '/usr/bin/curl') {
      const output = args[args.indexOf('--output') + 1]!
      const url = args.at(-1)!
      const formula = [...fixture.bottleBytes.keys()].find((name) => fixture.coordinates[name].url === url)
      const bytes = formula
        ? fixture.bottleBytes.get(formula)!
        : url.endsWith('libreoffice-LICENSE') ? fixture.libreOfficeLicenseBytes : fixture.libreOfficeBytes
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, bytes)
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    }
    if (executable === '/usr/bin/lipo') return { status: 0, stdout: Buffer.from(targetForHost() === 'darwin-arm64' ? 'arm64\n' : 'x86_64\n'), stderr: Buffer.alloc(0) }
    if (executable === '/usr/bin/install_name_tool') {
      if (args[0] === '-change') changedDependencies.set(args[3]!, args[2]!)
      if (args[0] === '-id') identities.set(args[2]!, args[1]!)
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    }
    if (executable === '/usr/bin/codesign') return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    if (executable === '/usr/bin/otool' && args[0] === '-l') return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    if (executable === '/usr/bin/otool' && args[0] === '-L') {
      const binary = args[1]!
      const dependencies = []
      if (binary.endsWith('/bin/vips')) dependencies.push(changedDependencies.get(binary) ?? '@@HOMEBREW_PREFIX@@/opt/glib/lib/libglib.dylib')
      if (binary.endsWith('/lib/glib/libglib.dylib') || binary.endsWith('/lib/libglib.dylib')) {
        dependencies.push(identities.get(binary) ?? '@@HOMEBREW_CELLAR@@/glib/2.86.0/lib/libglib.dylib')
      }
      const lines = dependencies.map((dependency) => `\t${dependency} (compatibility version 1.0.0, current version 1.0.0)`).join('\n')
      return { status: 0, stdout: Buffer.from(`${binary}:\n${lines}${lines ? '\n' : ''}`), stderr: Buffer.alloc(0) }
    }
    if (args.includes('-encoders')) return { status: 0, stdout: Buffer.from('libmp3lame pcm_s16le aac flac libvorbis libopus libx264 libvpx-vp9 gif'), stderr: Buffer.alloc(0) }
    if (args.includes('-muxers')) return { status: 0, stdout: Buffer.from('mp3 wav ipod adts flac ogg opus mp4 webm mov gif'), stderr: Buffer.alloc(0) }
    if (args[0] === '-l' && args[1] === 'foreign') {
      return { status: 0, stdout: Buffer.from('jpegload jpegsave pngload pngsave webpload webpsave heifload heifsave tiffload tiffsave gifload svgload magicksave'), stderr: Buffer.alloc(0) }
    }
    if (args.includes('--version') || args.includes('-version') || args.includes('-v')) return { status: 0, stdout: Buffer.from('version'), stderr: Buffer.alloc(0) }
    throw new Error(`unexpected command: ${executable} ${args.join(' ')}`)
  }
}

async function captureWithFixture(
  root: string,
  fixture: ReturnType<typeof captureFixture>,
  run = syntheticRun(fixture, []),
  overrides: Record<string, unknown> = {},
) {
  return captureHomebrewTarget({
    target: targetForHost(), brew: '/opt/test/bin/brew', coreRevision: '1'.repeat(40),
    roots: fixture.roots, output: join(root, 'capture.json'), run,
    ...overrides,
  })
}

function captureDocument(target: 'darwin-arm64' | 'darwin-x64') {
  const fixture = captureFixture(target)
  const licenses = (formula: string) => {
    const values = Object.values(fixture.closure.families).flatMap((family) => family.licenses)
      .filter((license) => license.formula === formula)
      .map((license) => ({
        kind: 'bottle-entry', target, path: license.source, sha256: license.sha256,
        bytes: license.bytes, destination: license.destination,
      }))
    return [...new Map(values.map((value) => [canonicalBytes(value).toString('utf8'), value])).values()]
      .sort((left, right) => Buffer.from(`${left.target}\0${left.destination}\0${left.path}`).compare(Buffer.from(`${right.target}\0${right.destination}\0${right.path}`)))
  }
  const formulae = fixture.formulae.map((formula) => ({
    name: formula.name,
    version: formula.version,
    revision: formula.revision,
    license: formula.license,
    dependencies: [...formula.dependencies].sort(),
    acquisition: structuredClone(fixture.coordinates[formula.name]),
    licenses: licenses(formula.name),
  })).sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))
  const payload = {
    schemaVersion: 1,
    target,
    homebrewCoreRevision: '1'.repeat(40),
    homebrewCaskRevision: '2'.repeat(40),
    roots: [...fixture.roots.formulae],
    engines: structuredClone(fixture.roots.engines),
    formulae,
    probes: {
      'image-icon': sha256('image-icon-probe'),
      document: sha256('document-probe'),
      pdf: sha256('pdf-probe'),
      media: sha256('media-probe'),
    },
    closure: structuredClone(fixture.closure),
  }
  return { payloadSha256: sha256(canonicalBytes(payload)), payload }
}

function writeCapture(root: string, name: string, value: ReturnType<typeof captureDocument>) {
  const path = join(root, name)
  writeFileSync(path, canonicalBytes(value))
  return path
}

describe('converter pack lock generation', () => {
  it('exposes the target capture and dual-target merge seams', () => {
    expect(captureHomebrewTarget).toBeTypeOf('function')
    expect(generateTransitiveSourceLock).toBeTypeOf('function')
  })

  it('registers explicit maintainer commands without adding lock generation to predev', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    expect(packageJson.scripts['converter-packs:capture-lock-target']).toBe('node scripts/converter-packs/capture-homebrew-target.mjs')
    expect(packageJson.scripts['converter-packs:generate-lock']).toBe('node scripts/converter-packs/generate-transitive-source-lock.mjs')
    expect(packageJson.scripts.predev).not.toContain('capture-lock-target')
    expect(packageJson.scripts.predev).not.toContain('generate-lock')
  })

  it('defines isolated dual-target capture jobs and a review-only merge workflow', () => {
    const workflowPath = join(process.cwd(), '..', '..', '.github', 'workflows', 'converter-pack-lock.yml')
    const source = readFileSync(workflowPath, 'utf8')
    const workflow = parse(source)
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.on.workflow_dispatch.inputs.core_revision).toMatchObject({ required: true, type: 'string' })
    expect(workflow.on.workflow_dispatch.inputs.roots_directory).toMatchObject({ required: true, type: 'string' })
    expect(workflow.jobs.capture_arm64).toMatchObject({ 'runs-on': 'macos-15', env: { AUTOFORGE_CONVERTER_TARGET: 'darwin-arm64' } })
    expect(workflow.jobs.capture_x64).toMatchObject({ 'runs-on': 'macos-15-intel', env: { AUTOFORGE_CONVERTER_TARGET: 'darwin-x64' } })
    expect(workflow.jobs.merge.needs).toEqual(['capture_arm64', 'capture_x64'])
    expect(JSON.stringify(workflow)).not.toContain('secrets.')
    for (const job of Object.values(workflow.jobs) as Array<{ steps: Array<{ uses?: string; with?: Record<string, unknown> }> }>) {
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u)
        if (step.uses?.startsWith('actions/upload-artifact@')) expect(step.with['retention-days']).toBe(1)
      }
    }
    const captureSource = JSON.stringify([workflow.jobs.capture_arm64, workflow.jobs.capture_x64])
    expect(captureSource).toContain('converter-packs:capture-lock-target')
    expect(captureSource).toContain('checkout --detach')
    expect(captureSource).toContain('core_revision')
    const mergeSource = JSON.stringify(workflow.jobs.merge)
    expect(mergeSource).toContain('converter-packs:generate-lock')
    expect(mergeSource).not.toMatch(/\bgit (?:commit|push)\b|converter-packs:publish/u)
  })

  it.runIf(process.platform === 'darwin')('captures one canonical target from fixed Homebrew commands and verified downloads', async () => {
    const root = temporaryRoot()
    const fixture = captureFixture()
    const output = join(root, 'capture.json')
    const calls: CapturedCall[] = []

    await captureHomebrewTarget({
      target: targetForHost(),
      brew: '/opt/test/bin/brew',
      coreRevision: '1'.repeat(40),
      roots: fixture.roots,
      output,
      run: syntheticRun(fixture, calls),
    })

    const bytes = readFileSync(output)
    const value = JSON.parse(bytes.toString('utf8'))
    expect(bytes).toEqual(canonicalBytes(value))
    expect(value.payload.target).toBe(targetForHost())
    expect(value.payload.formulae.map((formula: { name: string }) => formula.name)).toEqual(['ffmpeg', 'glib', 'poppler', 'vips'])
    expect(value.payload.formulae.find((formula: { name: string }) => formula.name === 'glib').dependencies).toEqual([])
    expect(value.payloadSha256).toBe(sha256(canonicalBytes(value.payload)))
    expect(value.payload.closure).toMatchObject({
      target: fixture.closure.target,
      formulae: fixture.closure.formulae,
      families: fixture.closure.families,
      measurements: {
        downloadBytes: fixture.closure.measurements.downloadBytes,
        compressedPackBytes: { 'image-icon': expect.any(Number), document: expect.any(Number), pdf: expect.any(Number), media: expect.any(Number) },
        installedReleaseBytes: expect.any(Number),
      },
    })
    expect(calls.slice(0, 3).map(({ executable, args }) => ({ executable, args }))).toEqual([
      { executable: '/opt/test/bin/brew', args: ['tap-info', '--json=v1', 'homebrew/core'] },
      { executable: '/opt/test/bin/brew', args: ['deps', '--union', '--formula', 'ffmpeg', 'poppler', 'vips'] },
      { executable: '/opt/test/bin/brew', args: ['info', '--json=v2', '--formula', 'ffmpeg', 'glib', 'poppler', 'vips'] },
    ])
    expect(calls.every(({ options }) => (
      options.env.LANG === 'C'
      && options.env.LC_ALL === 'C'
      && options.env.HOMEBREW_NO_AUTO_UPDATE === '1'
      && options.env.HOMEBREW_NO_INSTALL_FROM_API === '1'
    ))).toBe(true)
    expect(calls.filter(({ executable }) => executable === '/usr/bin/curl')).toHaveLength(6)
    expect(calls.flatMap(({ args }) => args).filter(isAbsolute).every((path) => path === '/opt/test/bin/brew' || path.startsWith(root) || path.startsWith('/private/var/') || path.startsWith('/var/'))).toBe(true)

    const secondRoot = temporaryRoot()
    await captureWithFixture(secondRoot, fixture)
    expect(readFileSync(join(secondRoot, 'capture.json'))).toEqual(bytes)
  })

  it.runIf(process.platform === 'darwin')('rejects unpinned revisions, host mismatches, and non-absolute brew before discovery', async () => {
    const fixture = captureFixture()
    const root = temporaryRoot()
    let calls = 0
    const neverRun = async () => { calls += 1; throw new Error('must not run') }
    await expect(captureWithFixture(root, fixture, neverRun, { coreRevision: 'A'.repeat(40) })).rejects.toThrow(/40-hex|revision/iu)
    await expect(captureWithFixture(root, fixture, neverRun, { brew: 'brew' })).rejects.toThrow(/absolute/iu)
    const otherTarget = targetForHost() === 'darwin-arm64' ? 'darwin-x64' : 'darwin-arm64'
    await expect(captureWithFixture(root, fixture, neverRun, { target: otherTarget })).rejects.toThrow(/host|target/iu)
    expect(calls).toBe(0)
  })

  it.runIf(process.platform === 'darwin').each([
    ['tap revision mismatch', (fixture: ReturnType<typeof captureFixture>, base: ReturnType<typeof syntheticRun>) => async (executable: string, args: string[], options: RunOptions) => (
      args[0] === 'tap-info'
        ? { status: 0, stdout: canonicalBytes([{ name: 'homebrew/core', installed: true, HEAD: '3'.repeat(40) }]), stderr: Buffer.alloc(0) }
        : base(executable, args, options)
    )],
    ['non-HTTPS bottle URL', (fixture: ReturnType<typeof captureFixture>, base: ReturnType<typeof syntheticRun>) => {
      fixture.coordinates.glib.url = 'http://downloads.example.test/glib.tar.gz'
      return base
    }],
    ['missing selected target bottle', (fixture: ReturnType<typeof captureFixture>, base: ReturnType<typeof syntheticRun>) => async (executable: string, args: string[], options: RunOptions) => {
      if (args[0] !== 'info') return base(executable, args, options)
      const json = brewFormulaJson(fixture)
      json.formulae.find((formula) => formula.name === 'glib')!.bottle.stable.files = {
        unexpected_target: json.formulae.find((formula) => formula.name === 'glib')!.bottle.stable.files[tagForTarget(targetForHost())],
      } as never
      return { status: 0, stdout: canonicalBytes(json), stderr: Buffer.alloc(0) }
    }],
    ['inconsistent formula version', (fixture: ReturnType<typeof captureFixture>, base: ReturnType<typeof syntheticRun>) => {
      fixture.formulae.find((formula) => formula.name === 'vips')!.version = '8.18.7'
      return base
    }],
    ['duplicate formula metadata', (fixture: ReturnType<typeof captureFixture>, base: ReturnType<typeof syntheticRun>) => async (executable: string, args: string[], options: RunOptions) => {
      if (args[0] !== 'info') return base(executable, args, options)
      const json = brewFormulaJson(fixture)
      json.formulae.push(structuredClone(json.formulae[0]!))
      return { status: 0, stdout: canonicalBytes(json), stderr: Buffer.alloc(0) }
    }],
    ['unreachable formula', (fixture: ReturnType<typeof captureFixture>, base: ReturnType<typeof syntheticRun>) => async (executable: string, args: string[], options: RunOptions) => {
      if (args[0] === 'deps') return { status: 0, stdout: Buffer.from('glib\norphan\n'), stderr: Buffer.alloc(0) }
      if (args[0] !== 'info') return base(executable, args, options)
      const json = brewFormulaJson(fixture)
      json.formulae.push({
        ...structuredClone(json.formulae.find((formula) => formula.name === 'glib')!),
        name: 'orphan', full_name: 'orphan', dependencies: [],
      })
      return { status: 0, stdout: canonicalBytes(json), stderr: Buffer.alloc(0) }
    }],
    ['command output above 64 MiB', () => async () => ({
      status: 0, stdout: Buffer.alloc(64 * 1024 * 1024 + 1), stderr: Buffer.alloc(0),
    })],
  ])('rejects %s without publishing a capture', async (_label, makeRun) => {
    const root = temporaryRoot()
    const fixture = captureFixture()
    const base = syntheticRun(fixture, [])
    await expect(captureWithFixture(root, fixture, makeRun(fixture, base))).rejects.toThrow()
    expect(() => readFileSync(join(root, 'capture.json'))).toThrow()
  })

  it.runIf(process.platform === 'darwin')('rejects downloaded bottle bytes that disagree with Homebrew metadata', async () => {
    const root = temporaryRoot()
    const fixture = captureFixture()
    const base = syntheticRun(fixture, [])
    const run = async (executable: string, args: string[], options: RunOptions) => {
      const result = await base(executable, args, options)
      if (executable === '/usr/bin/curl' && args.at(-1) === fixture.coordinates.glib.url) {
        writeFileSync(args[args.indexOf('--output') + 1]!, 'tampered')
      }
      return result
    }
    await expect(captureWithFixture(root, fixture, run)).rejects.toThrow(/hash|byte/iu)
  })

  it.runIf(process.platform === 'darwin')('prunes declared Homebrew dependencies that are absent from the authenticated runtime closure', async () => {
    const root = temporaryRoot()
    const fixture = captureFixture()
    const bytes = bottleArchive('unused', '1.0.0', [{ path: 'LICENSE', bytes: Buffer.from('unused-license'), mode: 0o644 }])
    fixture.formulae.find(({ name }) => name === 'glib')!.dependencies.push('unused')
    fixture.formulae.push({ name: 'unused', version: '1.0.0', revision: 0, license: 'MIT', dependencies: [] })
    fixture.bottleBytes.set('unused', bytes)
    fixture.coordinates.unused = {
      kind: 'homebrew-bottle', url: `https://downloads.example.test/unused-${targetForHost()}.tar.gz`,
      sha256: sha256(bytes), bytes: bytes.byteLength, cellar: cellarForTarget(targetForHost()),
    }

    await captureWithFixture(root, fixture)

    const capture = JSON.parse(readFileSync(join(root, 'capture.json'), 'utf8'))
    expect(capture.payload.formulae.map(({ name }: { name: string }) => name)).not.toContain('unused')
    expect(capture.payload.formulae.find(({ name }: { name: string }) => name === 'glib').dependencies).toEqual([])
  })

  it('merges two authenticated probed captures into canonical closures and writes the source lock last', async () => {
    const root = temporaryRoot()
    const captures = join(root, 'captures')
    const outputRoot = join(root, 'locks')
    mkdirSync(captures)
    mkdirSync(outputRoot)
    const arm64Capture = writeCapture(captures, 'arm64.json', captureDocument('darwin-arm64'))
    const x64Capture = writeCapture(captures, 'x64.json', captureDocument('darwin-x64'))

    await generateTransitiveSourceLock({ arm64Capture, x64Capture, outputRoot })

    const sourcePath = join(outputRoot, 'sources.lock.json')
    const arm64ClosurePath = join(outputRoot, 'closures', 'darwin-arm64.lock.json')
    const x64ClosurePath = join(outputRoot, 'closures', 'darwin-x64.lock.json')
    const sourceBytes = readFileSync(sourcePath)
    const source = JSON.parse(sourceBytes.toString('utf8'))
    expect(sourceBytes).toEqual(canonicalBytes(source))
    expect(source.schemaVersion).toBe(2)
    expect(source.targets).toEqual(['darwin-arm64', 'darwin-x64'])
    expect(source.formulae.map((formula: { name: string }) => formula.name)).toEqual(['ffmpeg', 'glib', 'poppler', 'vips'])
    expect(source.formulae.find((formula: { name: string }) => formula.name === 'glib').acquisitions).toEqual({
      'darwin-arm64': captureDocument('darwin-arm64').payload.formulae.find((formula) => formula.name === 'glib')!.acquisition,
      'darwin-x64': captureDocument('darwin-x64').payload.formulae.find((formula) => formula.name === 'glib')!.acquisition,
    })
    expect(source.formulae.find((formula: { name: string }) => formula.name === 'glib').licenses).toHaveLength(2)
    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-arm64' })).resolves.toMatchObject({ target: 'darwin-arm64' })
    await expect(loadConverterClosureLock({ sourceLockPath: sourcePath, target: 'darwin-x64' })).resolves.toMatchObject({ target: 'darwin-x64' })
    expect(statSync(sourcePath).mtimeMs).toBeGreaterThanOrEqual(statSync(arm64ClosurePath).mtimeMs)
    expect(statSync(sourcePath).mtimeMs).toBeGreaterThanOrEqual(statSync(x64ClosurePath).mtimeMs)

    const snapshot = [sourcePath, arm64ClosurePath, x64ClosurePath].map((path) => readFileSync(path))
    await generateTransitiveSourceLock({ arm64Capture, x64Capture, outputRoot })
    expect([sourcePath, arm64ClosurePath, x64ClosurePath].map((path) => readFileSync(path))).toEqual(snapshot)
  })

  it.each([
    ['capture hash mismatch', (capture: ReturnType<typeof captureDocument>) => { capture.payloadSha256 = '0'.repeat(64) }],
    ['target mismatch', (capture: ReturnType<typeof captureDocument>) => { capture.payload.target = 'darwin-arm64' }],
    ['unprobed family', (capture: ReturnType<typeof captureDocument>) => { capture.payload.probes.media = '0'.repeat(64) }],
    ['formula identity mismatch', (capture: ReturnType<typeof captureDocument>) => { capture.payload.formulae.find((formula) => formula.name === 'glib')!.license = 'MIT' }],
    ['closure target mismatch', (capture: ReturnType<typeof captureDocument>) => { capture.payload.closure.target = 'darwin-arm64' }],
  ])('rejects %s before publishing generated locks', async (_label, mutate) => {
    const root = temporaryRoot()
    const captures = join(root, 'captures')
    const outputRoot = join(root, 'locks')
    mkdirSync(captures)
    mkdirSync(outputRoot)
    const arm = captureDocument('darwin-arm64')
    const x64 = captureDocument('darwin-x64')
    mutate(x64)
    if (_label !== 'capture hash mismatch') x64.payloadSha256 = sha256(canonicalBytes(x64.payload))
    const arm64Capture = writeCapture(captures, 'arm64.json', arm)
    const x64Capture = writeCapture(captures, 'x64.json', x64)
    await expect(generateTransitiveSourceLock({ arm64Capture, x64Capture, outputRoot })).rejects.toThrow()
    expect(() => readFileSync(join(outputRoot, 'sources.lock.json'))).toThrow()
  })

  it('refuses to overwrite a generated file unless all bytes are identical', async () => {
    const root = temporaryRoot()
    const captures = join(root, 'captures')
    const outputRoot = join(root, 'locks')
    mkdirSync(captures)
    mkdirSync(join(outputRoot, 'closures'), { recursive: true })
    const arm64Capture = writeCapture(captures, 'arm64.json', captureDocument('darwin-arm64'))
    const x64Capture = writeCapture(captures, 'x64.json', captureDocument('darwin-x64'))
    const existing = join(outputRoot, 'closures', 'darwin-x64.lock.json')
    writeFileSync(existing, 'do-not-overwrite')

    await expect(generateTransitiveSourceLock({ arm64Capture, x64Capture, outputRoot })).rejects.toThrow(/overwrite|differs|existing/iu)
    expect(readFileSync(existing, 'utf8')).toBe('do-not-overwrite')
    expect(() => readFileSync(join(outputRoot, 'sources.lock.json'))).toThrow()
    expect(() => readFileSync(join(outputRoot, 'closures', 'darwin-arm64.lock.json'))).toThrow()
  })
})
