import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const nativeRoot = join(desktopRoot, 'converter-packs', 'native')
const buildScript = join(desktopRoot, 'scripts', 'converter-packs', 'build-native-helpers.mjs')
const temporaryRoots: string[] = []
let harness = ''
let harnessRoot = ''
let imageHelper = ''
let pdfHelper = ''

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-native-helper-')))
  temporaryRoots.push(root)
  return root
}

function run(args: readonly string[]) {
  return spawnSync(harness, args, { encoding: 'utf8' })
}

beforeAll(() => {
  harnessRoot = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-native-harness-')))
  harness = join(harnessRoot, 'helper-contract-harness')
  const result = spawnSync('/usr/bin/clang', [
    '-std=c11', '-Wall', '-Wextra', '-Werror',
    join(nativeRoot, 'common', 'arguments.c'),
    join(nativeRoot, 'image-converter', 'icon-container.c'),
    join(nativeRoot, 'tests', 'helper-contract-harness.c'),
    '-I', join(nativeRoot, 'common'),
    '-I', join(nativeRoot, 'image-converter'),
    '-o', harness,
  ], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)

  const binRoot = join(harnessRoot, 'bin')
  mkdirSync(binRoot)
  const fakeVips = join(binRoot, 'vips')
  const fakeEngine = spawnSync('/usr/bin/clang', [
    '-std=c11', '-Wall', '-Wextra', '-Werror',
    join(nativeRoot, 'tests', 'fake-engine.c'),
    '-o', fakeVips,
  ], { encoding: 'utf8' })
  expect(fakeEngine.status, fakeEngine.stderr).toBe(0)
  copyFileSync(fakeVips, join(binRoot, 'pdftocairo'))
  chmodSync(join(binRoot, 'pdftocairo'), 0o755)

  imageHelper = join(binRoot, 'autoforge-image-converter')
  const imageBuild = spawnSync('/usr/bin/clang', [
    '-std=c11', '-Wall', '-Wextra', '-Werror',
    join(nativeRoot, 'common', 'arguments.c'),
    join(nativeRoot, 'common', 'process.c'),
    join(nativeRoot, 'image-converter', 'icon-container.c'),
    join(nativeRoot, 'image-converter', 'main.c'),
    '-I', join(nativeRoot, 'common'),
    '-I', join(nativeRoot, 'image-converter'),
    '-o', imageHelper,
  ], { encoding: 'utf8' })
  expect(imageBuild.status, imageBuild.stderr).toBe(0)

  pdfHelper = join(binRoot, 'autoforge-pdf-raster')
  const pdfBuild = spawnSync('/usr/bin/clang', [
    '-std=c11', '-Wall', '-Wextra', '-Werror',
    join(nativeRoot, 'common', 'arguments.c'),
    join(nativeRoot, 'common', 'process.c'),
    join(nativeRoot, 'pdf-raster', 'main.c'),
    '-I', join(nativeRoot, 'common'),
    '-o', pdfHelper,
  ], { encoding: 'utf8' })
  expect(pdfBuild.status, pdfBuild.stderr).toBe(0)
})

afterAll(() => {
  if (harnessRoot) rmSync(harnessRoot, { recursive: true, force: true })
})

describe('native converter helper contracts', () => {
  it('builds the two current-architecture Mach-O helpers into the exact pack paths', () => {
    const root = temporaryRoot()
    const output = join(root, 'helpers')
    const target = `darwin-${process.arch}`
    const result = spawnSync(process.execPath, [
      buildScript, '--target', target, '--output', output, '--compiler', '/usr/bin/clang',
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    for (const name of ['autoforge-image-converter', 'autoforge-pdf-raster']) {
      const path = join(output, 'bin', name)
      expect(lstatSync(path).isFile()).toBe(true)
      expect(lstatSync(path).mode & 0o111).not.toBe(0)
      const identified = spawnSync('/usr/bin/file', ['-b', path], { encoding: 'utf8' })
      expect(identified.status, identified.stderr).toBe(0)
      expect(identified.stdout).toContain('Mach-O 64-bit executable')
      expect(identified.stdout).toContain(process.arch === 'arm64' ? 'arm64' : 'x86_64')
    }
  })

  it('accepts one exact option set and preserves the post-delimiter input verbatim', () => {
    const result = run(['parse', '--format', 'png', '--all', '--', '-hostile-looking-input.jpg'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('format=png all=1 input=-hostile-looking-input.jpg\n')
  })

  it.each([
    [['parse', '--format', 'png', '--format', 'jpeg', '--', 'input.jpg'], 'duplicate option'],
    [['parse', '--unknown', 'png', '--', 'input.jpg'], 'unknown option'],
    [['parse', '--all', '--', 'input.jpg'], 'missing required option'],
    [['parse', '--format', 'png', 'input.jpg'], 'missing input delimiter'],
    [['parse', '--format', 'png', '--', 'one.jpg', 'two.jpg'], 'exactly one input'],
  ])('rejects malformed argument vector %j', (args, message) => {
    const result = run(args)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(message)
  })

  it('writes deterministic ICO offsets and little-endian lengths', () => {
    const root = temporaryRoot()
    const output = join(root, 'fixture.ico')
    const result = run(['write-ico', output])
    expect(result.status, result.stderr).toBe(0)
    const bytes = readFileSync(output)

    expect(bytes.byteLength).toBe(43)
    expect([...bytes.subarray(0, 6)]).toEqual([0, 0, 1, 0, 2, 0])
    expect([...bytes.subarray(6, 22)]).toEqual([
      16, 16, 0, 0, 1, 0, 32, 0, 3, 0, 0, 0, 38, 0, 0, 0,
    ])
    expect([...bytes.subarray(22, 38)]).toEqual([
      0, 0, 0, 0, 1, 0, 32, 0, 2, 0, 0, 0, 41, 0, 0, 0,
    ])
    expect([...bytes.subarray(38)]).toEqual([1, 2, 3, 4, 5])
    expect(run(['validate-ico', output]).status).toBe(0)
  })

  it('writes deterministic ICNS types and big-endian entry lengths', () => {
    const root = temporaryRoot()
    const output = join(root, 'fixture.icns')
    const result = run(['write-icns', output])
    expect(result.status, result.stderr).toBe(0)
    const bytes = readFileSync(output)

    expect(bytes.byteLength).toBe(29)
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(bytes.readUInt32BE(4)).toBe(29)
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('icp4')
    expect(bytes.readUInt32BE(12)).toBe(11)
    expect([...bytes.subarray(16, 19)]).toEqual([1, 2, 3])
    expect(bytes.subarray(19, 23).toString('ascii')).toBe('ic10')
    expect(bytes.readUInt32BE(23)).toBe(10)
    expect([...bytes.subarray(27)]).toEqual([4, 5])
    expect(run(['validate-icns', output]).status).toBe(0)
  })

  it('rejects malformed ICO and ICNS declared lengths', () => {
    const root = temporaryRoot()
    const ico = join(root, 'malformed.ico')
    const icns = join(root, 'malformed.icns')
    writeFileSync(ico, Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 255, 255, 255, 255, 22, 0, 0, 0]))
    writeFileSync(icns, Buffer.from('69636e73000000096963703400000008', 'hex'))

    expect(run(['validate-ico', ico]).status).not.toBe(0)
    expect(run(['validate-icns', icns]).status).not.toBe(0)
  })

  it('runs the fixed image conversion contract through the sibling vips executable', () => {
    const root = temporaryRoot()
    const input = join(root, 'input.jpg')
    const output = join(root, 'output.png')
    writeFileSync(input, 'input')

    const result = spawnSync(imageHelper, [
      'convert', '--input-format', 'jpeg', '--output-format', 'png', '--output', output, '--', input,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe('converted')
  })

  it('creates a multi-representation ICO through fixed thumbnail and gravity commands', () => {
    const root = temporaryRoot()
    const input = join(root, 'input.jpg')
    const output = join(root, 'output.ico')
    writeFileSync(input, 'input')

    const result = spawnSync(imageHelper, [
      'create-icon', '--format', 'ico', '--sizes', '16,32',
      '--fit', 'contain', '--canvas', 'square', '--background', 'transparent', '--crop', 'never',
      '--output', output, '--', input,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(output).readUInt16LE(4)).toBe(2)
    expect(run(['validate-ico', output]).status).toBe(0)
  })

  it('creates ICNS entries with the exact typed representation contract', () => {
    const root = temporaryRoot()
    const input = join(root, 'input.jpg')
    const output = join(root, 'output.icns')
    writeFileSync(input, 'input')

    const result = spawnSync(imageHelper, [
      'create-icon', '--format', 'icns', '--representations', 'icp4=16@1x,ic11=16@2x',
      '--fit', 'contain', '--canvas', 'square', '--background', 'transparent', '--crop', 'never',
      '--output', output, '--', input,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(output).subarray(8, 12).toString('ascii')).toBe('icp4')
    expect(run(['validate-icns', output]).status).toBe(0)
  })

  it('rejects overflowing ICNS representation dimensions', () => {
    const root = temporaryRoot()
    const input = join(root, 'input.jpg')
    const output = join(root, 'output.icns')
    writeFileSync(input, 'input')

    const result = spawnSync(imageHelper, [
      'create-icon', '--format', 'icns', '--representations', 'icp4=18446744073709551617@1x',
      '--fit', 'contain', '--canvas', 'square', '--background', 'transparent', '--crop', 'never',
      '--output', output, '--', input,
    ], { encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('invalid icon sizes')
  })

  it('extracts every requested ICO representation to the fixed output pattern', () => {
    const root = temporaryRoot()
    const input = join(root, 'input.ico')
    const source = join(root, 'source.jpg')
    writeFileSync(source, 'input')
    const created = spawnSync(imageHelper, [
      'create-icon', '--format', 'ico', '--sizes', '16,32',
      '--fit', 'contain', '--canvas', 'square', '--background', 'transparent', '--crop', 'never',
      '--output', input, '--', source,
    ], { encoding: 'utf8' })
    expect(created.status, created.stderr).toBe(0)

    const result = spawnSync(imageHelper, [
      'extract-icon', '--input-format', 'ico', '--output-format', 'png', '--all-representations',
      '--representation-indexes', '1,2', '--output-pattern', join(root, 'representation-%03d.png'), '--', input,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(root, 'representation-001.png'), 'utf8')).toBe('converted')
    expect(readFileSync(join(root, 'representation-002.png'), 'utf8')).toBe('converted')

    const jpegResult = spawnSync(imageHelper, [
      'extract-icon', '--input-format', 'ico', '--output-format', 'jpeg', '--all-representations',
      '--representation-indexes', '1,2', '--output-pattern', join(root, 'jpeg-%03d.jpeg'), '--', input,
    ], { encoding: 'utf8' })
    expect(jpegResult.status, jpegResult.stderr).toBe(0)
    expect(readFileSync(join(root, 'jpeg-001.jpeg'), 'utf8')).toBe('converted')
  })

  it('normalizes Poppler page outputs to the adapter zero-padded contract', () => {
    const root = temporaryRoot()
    const input = join(root, 'input.pdf')
    const pattern = join(root, 'page-%03d.png')
    writeFileSync(input, '%PDF fixture')

    const result = spawnSync(pdfHelper, [
      'raster', '--format', 'png', '--pages', 'all', '--page-number-width', '3',
      '--output-pattern', pattern, '--', input,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(root, 'page-001.png'), 'utf8')).toBe('page-1')
    expect(readFileSync(join(root, 'page-002.png'), 'utf8')).toBe('page-2')
  })

  it('rejects helper options outside the fixed adapter contract before launching an engine', () => {
    const root = temporaryRoot()
    const input = join(root, 'input.jpg')
    const output = join(root, 'output.png')
    writeFileSync(input, 'input')

    const result = spawnSync(imageHelper, [
      'convert', '--input-format', 'jpeg', '--output-format', 'png', '--quality', '100',
      '--output', output, '--', input,
    ], { encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unknown option')

    const unsupportedFormat = spawnSync(imageHelper, [
      'convert', '--input-format', 'jpeg', '--output-format', 'unapproved',
      '--output', output, '--', input,
    ], { encoding: 'utf8' })
    expect(unsupportedFormat.status).not.toBe(0)
    expect(unsupportedFormat.stderr).toContain('unsupported image format')
  })
})
