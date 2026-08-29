import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { imageIconAdapter } from '../../electron/main/conversion/adapters/image-icon.js'
import { documentAdapter } from '../../electron/main/conversion/adapters/document.js'
import { pdfAdapter } from '../../electron/main/conversion/adapters/pdf.js'
import { mediaAdapter } from '../../electron/main/conversion/adapters/media.js'
import { probeConversionInput, type ProbedConversionInput } from '../../electron/main/conversion/conversion-catalog.js'
import {
  createConversionProcessRunner,
  createNodeConversionProcessTreePort,
  type ConversionExpectedOutput,
  type ConversionRequest,
  type ConverterAdapter,
} from '../../electron/main/conversion/conversion-process-runner.js'
import { ConverterPackManager } from '../../electron/main/conversion/converter-pack-manager.js'
import type { ConverterPackIndex, ConverterPackLease, ConverterPackName } from '../../electron/main/conversion/converter-pack-types.js'
import { isAbsoluteConverterPackTestRoot } from './converter-pack-test-root.js'

const externalGate = 'EXTERNAL GATE: set AUTOFORGE_TEST_CONVERTER_PACK_ROOT to an absolute signed fixture bundle; local fixture evidence is not production release acceptance.'
const bundleRoot = process.env.AUTOFORGE_TEST_CONVERTER_PACK_ROOT
const enabled = typeof bundleRoot === 'string' && bundleRoot.length > 0

if (!enabled) console.warn(externalGate)

describe.skipIf(!enabled)(`real signed converter engines (${enabled ? 'enabled' : externalGate})`, () => {
  const temporaryRoots: string[] = []
  const leases = new Map<ConverterPackName, ConverterPackLease>()
  let fixtureRoot: string
  let manager: ConverterPackManager
  let runner: ReturnType<typeof createConversionProcessRunner>

  beforeAll(async () => {
    if (!bundleRoot || !isAbsoluteConverterPackTestRoot(bundleRoot, process.platform)) throw new Error(externalGate)
    const releaseRoot = join(bundleRoot, 'release')
    const publicKeyPath = join(bundleRoot, 'test-root-public-key.pem')
    fixtureRoot = join(bundleRoot, 'fixtures')
    const index = JSON.parse(readFileSync(join(releaseRoot, 'index.json'), 'utf8')) as ConverterPackIndex
    const signature = readFileSync(join(releaseRoot, 'index.sig'), 'utf8').trim()
    const rootPublicKeyPem = readFileSync(publicKeyPath, 'utf8')
    manager = new ConverterPackManager({
      packsRoot: join(bundleRoot, 'installed'),
      rootPublicKeyPem,
      platform: process.platform,
      arch: process.arch,
    })
    await manager.initialize()
    for (const name of ['image-icon', 'document', 'pdf', 'media'] as const) {
      // Signature verification happens before installed-pack resolution. An
      // unsigned/invalid bundle therefore fails here and never reaches PATH.
      leases.set(name, await manager.acquire({ signedIndex: { index, signature }, name }))
    }
    runner = createConversionProcessRunner({ processTree: createNodeConversionProcessTreePort() })
    expect(readFileSync(join(fixtureRoot, 'PROVENANCE.md'), 'utf8')).toContain('self-created')
  }, 30_000)

  afterAll(() => {
    for (const lease of leases.values()) lease.release()
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function workRoot(label: string): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `autoforge-engine-${label}-`)))
    temporaryRoots.push(root)
    return root
  }

  async function convert(
    adapter: ConverterAdapter,
    pack: ConverterPackName,
    input: ProbedConversionInput,
    inputPath: string,
    request: Omit<ConversionRequest, 'inputPath'>,
    label: string,
  ): Promise<readonly ConversionExpectedOutput[]> {
    const outputRoot = workRoot(label)
    const lease = leases.get(pack)
    if (!lease) throw new Error(`Missing signed ${pack} lease`)
    const plan = adapter.plan(input, { ...request, inputPath }, lease, outputRoot)
    await runner.run(plan, lease)
    for (const output of plan.outputs) expect(readFileSync(output.path).byteLength).toBeGreaterThan(0)
    return plan.outputs
  }

  function probe(path: string, displayName: string, mimeType: string) {
    const bytes = readFileSync(path)
    return probeConversionInput({ displayName, mimeType, byteSize: bytes.byteLength, bytes })
  }

  function probeBytes(bytes: Buffer, displayName: string, mimeType: string) {
    return probeConversionInput({ displayName, mimeType, byteSize: bytes.byteLength, bytes })
  }

  function icoRepresentations(path: string): Array<{ width: number; height: number }> {
    const bytes = readFileSync(path)
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]))
    const count = bytes.readUInt16LE(4)
    expect(probeBytes(bytes, 'icon.ico', 'image/vnd.microsoft.icon')).toMatchObject({ format: 'ico', frameCount: count })
    return Array.from({ length: count }, (_, index) => {
      const entry = 6 + index * 16
      const width = bytes[entry] || 256
      const height = bytes[entry + 1] || 256
      const payloadBytes = bytes.readUInt32LE(entry + 8)
      const payloadOffset = bytes.readUInt32LE(entry + 12)
      expect(bytes[entry + 2]).toBe(0)
      expect(bytes[entry + 3]).toBe(0)
      expect(bytes.readUInt16LE(entry + 4)).toBe(1)
      expect(bytes.readUInt16LE(entry + 6)).toBe(32)
      expect(payloadOffset).toBeGreaterThanOrEqual(6 + count * 16)
      expect(payloadOffset + payloadBytes).toBeLessThanOrEqual(bytes.byteLength)
      expect(probeBytes(bytes.subarray(payloadOffset, payloadOffset + payloadBytes), `ico-${index}.png`, 'image/png'))
        .toMatchObject({ format: 'png', width, height, frameCount: 1 })
      return { width, height }
    })
  }

  const expectedIcnsSlots = [
    { type: 'icp4', logicalSize: 16, scale: 1, pixelSize: 16 },
    { type: 'ic11', logicalSize: 16, scale: 2, pixelSize: 32 },
    { type: 'icp5', logicalSize: 32, scale: 1, pixelSize: 32 },
    { type: 'ic12', logicalSize: 32, scale: 2, pixelSize: 64 },
    { type: 'ic07', logicalSize: 128, scale: 1, pixelSize: 128 },
    { type: 'ic13', logicalSize: 128, scale: 2, pixelSize: 256 },
    { type: 'ic08', logicalSize: 256, scale: 1, pixelSize: 256 },
    { type: 'ic14', logicalSize: 256, scale: 2, pixelSize: 512 },
    { type: 'ic09', logicalSize: 512, scale: 1, pixelSize: 512 },
    { type: 'ic10', logicalSize: 512, scale: 2, pixelSize: 1024 },
  ] as const

  function icnsRepresentations(path: string): Array<{
    type: string
    logicalSize: number
    scale: number
    pixelSize: number
    width: number
    height: number
  }> {
    const bytes = readFileSync(path)
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(bytes.readUInt32BE(4)).toBe(bytes.byteLength)
    const representations: Array<{
      type: string
      logicalSize: number
      scale: number
      pixelSize: number
      width: number
      height: number
    }> = []
    let offset = 8
    while (offset < bytes.byteLength) {
      const type = bytes.subarray(offset, offset + 4).toString('ascii')
      const length = bytes.readUInt32BE(offset + 4)
      expect(length).toBeGreaterThan(8)
      expect(offset + length).toBeLessThanOrEqual(bytes.byteLength)
      const embedded = probeBytes(bytes.subarray(offset + 8, offset + length), `${type}.png`, 'image/png')
      expect(embedded).toMatchObject({ format: 'png', frameCount: 1 })
      expect(embedded.width).toBe(embedded.height)
      const slot = expectedIcnsSlots.find((candidate) => candidate.type === type)
      expect(slot, `approved ICNS representation ${type}`).toBeDefined()
      expect(embedded.width).toBe(slot?.pixelSize)
      representations.push({ ...slot!, width: embedded.width!, height: embedded.height! })
      offset += length
    }
    expect(offset).toBe(bytes.byteLength)
    expect(probeBytes(bytes, 'icon.icns', 'image/icns')).toMatchObject({
      format: 'icns', width: 1024, height: 1024, frameCount: 10, iconSlots: expectedIcnsSlots,
    })
    return representations
  }

  function ebmlVint(bytes: Buffer, offset: number, preserveMarker: boolean): { value: number; next: number } {
    const first = bytes[offset]
    if (first === undefined || first === 0) throw new Error('Invalid EBML variable-length integer')
    let marker = 0x80
    let length = 1
    while ((first & marker) === 0) {
      marker >>= 1
      length += 1
    }
    if (length > 8 || offset + length > bytes.byteLength) throw new Error('Truncated EBML variable-length integer')
    let value = preserveMarker ? first : first & (marker - 1)
    for (let index = 1; index < length; index += 1) value = value * 256 + bytes[offset + index]!
    return { value, next: offset + length }
  }

  function ebmlDocType(bytes: Buffer): string {
    const header = ebmlVint(bytes, 0, true)
    expect(header.value).toBe(0x1a45dfa3)
    const headerSize = ebmlVint(bytes, header.next, false)
    const end = headerSize.next + headerSize.value
    expect(end).toBeLessThanOrEqual(bytes.byteLength)
    let offset = headerSize.next
    const docTypes: string[] = []
    while (offset < end) {
      const id = ebmlVint(bytes, offset, true)
      const size = ebmlVint(bytes, id.next, false)
      const valueEnd = size.next + size.value
      expect(valueEnd).toBeLessThanOrEqual(end)
      if (id.value === 0x4282) docTypes.push(bytes.subarray(size.next, valueEnd).toString('ascii'))
      offset = valueEnd
    }
    if (offset !== end || docTypes.length !== 1) throw new Error('EBML must contain exactly one DocType')
    return docTypes[0]!
  }

  function pngCornerAlpha(path: string): number {
    const bytes = readFileSync(path)
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'))
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    expect(bytes[24]).toBe(8)
    expect(bytes[25]).toBe(6)
    const chunks: Buffer[] = []
    let offset = 8
    while (offset < bytes.byteLength) {
      const length = bytes.readUInt32BE(offset)
      if (bytes.subarray(offset + 4, offset + 8).toString('ascii') === 'IDAT') {
        chunks.push(bytes.subarray(offset + 8, offset + 8 + length))
      }
      offset += 12 + length
    }
    const compressed = inflateSync(Buffer.concat(chunks))
    const stride = width * 4
    const rows: Buffer[] = []
    const paeth = (left: number, up: number, upperLeft: number) => {
      const estimate = left + up - upperLeft
      const leftDistance = Math.abs(estimate - left)
      const upDistance = Math.abs(estimate - up)
      const upperLeftDistance = Math.abs(estimate - upperLeft)
      return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft
    }
    for (let y = 0; y < height; y += 1) {
      const filter = compressed[y * (stride + 1)]!
      const source = compressed.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
      const row = Buffer.alloc(stride)
      for (let x = 0; x < stride; x += 1) {
        const left = x >= 4 ? row[x - 4]! : 0
        const up = rows[y - 1]?.[x] ?? 0
        const upperLeft = x >= 4 ? rows[y - 1]?.[x - 4] ?? 0 : 0
        const predictor = filter === 0 ? 0
          : filter === 1 ? left
            : filter === 2 ? up
              : filter === 3 ? Math.floor((left + up) / 2)
                : filter === 4 ? paeth(left, up, upperLeft) : -1
        expect(predictor).toBeGreaterThanOrEqual(0)
        row[x] = (source[x]! + predictor) & 0xff
      }
      rows.push(row)
    }
    return rows[0]![3]!
  }

  function signedProbe(executable: string, args: readonly string[]) {
    const cwd = workRoot('probe')
    const result = spawnSync(executable, [...args], {
      cwd,
      encoding: 'utf8',
      env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: dirname(executable), TEMP: cwd, TMP: cwd, TMPDIR: cwd },
    })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  }

  function mediaMetadata(path: string) {
    const ffprobe = leases.get('media')?.executables['bin/ffprobe']
    if (!ffprobe) throw new Error('Signed media pack must declare bin/ffprobe')
    return JSON.parse(signedProbe(ffprobe, [
      '-v', 'error', '-count_frames',
      '-show_entries', 'format=format_name,duration:format_tags:stream=index,codec_name,codec_type,width,height,nb_frames,nb_read_frames:stream_tags:chapter=id,start_time,end_time:chapter_tags',
      '-of', 'json', path,
    ])) as {
      format: { format_name: string; duration?: string; tags?: Record<string, string> }
      streams: Array<Record<string, string | number | Record<string, string>>>
      chapters: Array<{ id: number; start_time: string; end_time: string; tags?: Record<string, string> }>
    }
  }

  function expectNoSentinelMetadata(metadata: ReturnType<typeof mediaMetadata>) {
    expect(JSON.stringify(metadata)).not.toContain('AUTOFORGE_')
    expect(metadata.chapters).toEqual([])
  }

  function expectMagic(path: string, target: 'mp4' | 'mov' | 'webm' | 'mp3') {
    const bytes = readFileSync(path)
    if (target === 'mp4') expect(bytes.subarray(4, 12).toString('ascii')).toBe('ftypisom')
    if (target === 'mov') expect(bytes.subarray(4, 12).toString('ascii')).toBe('ftypqt  ')
    if (target === 'webm') {
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from('1a45dfa3', 'hex'))
      expect(ebmlDocType(bytes)).toBe('webm')
    }
    if (target === 'mp3') {
      expect(bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe6) === 0xe2)).toBe(true)
    }
  }

  function pdfPages(path: string): number {
    const pdfinfo = leases.get('pdf')?.executables['bin/pdfinfo']
    if (!pdfinfo) throw new Error('Signed PDF pack must declare bin/pdfinfo')
    const output = signedProbe(pdfinfo, [path])
    const match = /^Pages:\s+(\d+)$/mu.exec(output)
    if (!match) throw new Error('Signed pdfinfo returned no page count')
    return Number(match[1])
  }

  it('creates default/favicon ICO and ICNS from a transparent non-square PNG, then extracts every representation to PNG', async () => {
    const inputPath = join(fixtureRoot, 'transparent-nonsquare.png')
    const input: ProbedConversionInput = {
      format: 'png', mimeType: 'image/png', kind: 'image', byteSize: readFileSync(inputPath).byteLength,
      width: 40, height: 20, frameCount: 1,
    }
    const defaultIco = (await convert(imageIconAdapter, 'image-icon', input, inputPath, { targetFormat: 'ico' }, 'ico-default'))[0]!
    const favicon = (await convert(imageIconAdapter, 'image-icon', input, inputPath, { targetFormat: 'ico', preset: 'favicon' }, 'ico-favicon'))[0]!
    const icns = (await convert(imageIconAdapter, 'image-icon', input, inputPath, { targetFormat: 'icns' }, 'icns'))[0]!

    expect(icoRepresentations(defaultIco.path)).toEqual([16, 24, 32, 48, 64, 128, 256].map((size) => ({ width: size, height: size })))
    expect(icoRepresentations(favicon.path)).toEqual([16, 32, 48].map((size) => ({ width: size, height: size })))
    expect(defaultIco.metadata).toMatchObject({ iconRepresentations: [16, 24, 32, 48, 64, 128, 256], transparentPadding: true })
    expect(icnsRepresentations(icns.path)).toEqual(expectedIcnsSlots.map((slot) => ({
      ...slot, width: slot.pixelSize, height: slot.pixelSize,
    })))
    expect(icns.metadata).toMatchObject({ iconRepresentations: [16, 32, 64, 128, 256, 512, 1024], transparentPadding: true })

    const extractedIco = await convert(imageIconAdapter, 'image-icon', {
      format: 'ico', mimeType: 'image/vnd.microsoft.icon', kind: 'image', byteSize: readFileSync(defaultIco.path).byteLength,
      width: 256, height: 256, frameCount: 7,
    }, defaultIco.path, { targetFormat: 'png' }, 'extract-ico')
    expect(extractedIco.map((output) => probe(output.path, 'representation.png', 'image/png').width))
      .toEqual([16, 24, 32, 48, 64, 128, 256])
    expect(extractedIco.map((output) => pngCornerAlpha(output.path))).toEqual(Array(7).fill(0))

    const extractedIcns = await convert(
      imageIconAdapter,
      'image-icon',
      probe(icns.path, 'icon.icns', 'image/icns'),
      icns.path,
      { targetFormat: 'png' },
      'extract-icns',
    )
    expect(extractedIcns.map((output) => probe(output.path, 'representation.png', 'image/png').width))
      .toEqual([16, 32, 32, 64, 128, 256, 256, 512, 512, 1024])
    expect(extractedIcns.map((output) => output.metadata)).toEqual(expectedIcnsSlots.map((slot) => ({
      iconRepresentation: {
        sourceType: slot.type,
        logicalWidth: slot.logicalSize,
        logicalHeight: slot.logicalSize,
        pixelWidth: slot.pixelSize,
        pixelHeight: slot.pixelSize,
        scale: slot.scale,
      },
    })))
    expect(extractedIcns.map((output) => pngCornerAlpha(output.path))).toEqual(Array(10).fill(0))
  }, 120_000)

  it('converts animated WebP to GIF, MP4, and a first-frame PNG with truthful frames and codecs', async () => {
    const inputPath = join(fixtureRoot, 'animated-two-frame.webp')
    const input = probe(inputPath, 'animated-two-frame.webp', 'image/webp')
    expect(input.frameCount).toBe(2)
    const gif = (await convert(mediaAdapter, 'media', input, inputPath, { targetFormat: 'gif' }, 'webp-gif'))[0]!
    const mp4 = (await convert(mediaAdapter, 'media', input, inputPath, { targetFormat: 'mp4' }, 'webp-mp4'))[0]!
    const png = (await convert(imageIconAdapter, 'image-icon', input, inputPath, { targetFormat: 'png' }, 'webp-png'))[0]!
    const gifProbe = probe(gif.path, 'animated.gif', 'image/gif')
    expect(gifProbe).toMatchObject({ format: 'gif', width: 32, height: 20, frameCount: 2 })
    const mp4Metadata = mediaMetadata(mp4.path)
    expect(mp4Metadata.format.format_name).toBe('mov,mp4,m4a,3gp,3g2,mj2')
    expectMagic(mp4.path, 'mp4')
    expect(mp4Metadata.streams).toHaveLength(1)
    expect(mp4Metadata.streams[0]).toMatchObject({ codec_type: 'video', codec_name: 'h264', width: 32, height: 20 })
    expect(Number(mp4Metadata.streams[0]?.nb_read_frames)).toBe(2)
    expectNoSentinelMetadata(mp4Metadata)
    expect(probe(png.path, 'first.png', 'image/png')).toMatchObject({ format: 'png', width: 32, height: 20, frameCount: 1 })
    expect(png.metadata).toEqual({ frameSelection: 'first' })
  }, 120_000)

  it.each([
    ['sample.docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['sample.xlsx', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['sample.pptx', 'pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['sample.csv', 'csv', 'text/csv'],
  ] as const)('converts %s to a readable one-page PDF', async (name, format, mimeType) => {
    const inputPath = join(fixtureRoot, name)
    const input = probe(inputPath, name, mimeType)
    expect(input.format).toBe(format)
    const pdf = (await convert(documentAdapter, 'document', input, inputPath, { targetFormat: 'pdf' }, `${format}-pdf`))[0]!
    expect(readFileSync(pdf.path).subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(pdfPages(pdf.path)).toBe(1)
  }, 120_000)

  it('converts CSV to a structurally valid XLSX workbook', async () => {
    const inputPath = join(fixtureRoot, 'sample.csv')
    const input = probe(inputPath, 'sample.csv', 'text/csv')
    const output = (await convert(documentAdapter, 'document', input, inputPath, { targetFormat: 'xlsx' }, 'csv-xlsx'))[0]!
    expect(readFileSync(output.path).subarray(0, 4)).toEqual(Buffer.from('504b0304', 'hex'))
    expect(probe(output.path, 'sample.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').format).toBe('xlsx')
  }, 120_000)

  it.each(['png', 'jpeg'] as const)('rasterizes every page of a three-page PDF to %s with page metadata', async (targetFormat) => {
    const inputPath = join(fixtureRoot, 'three-page.pdf')
    const input: ProbedConversionInput = {
      format: 'pdf', mimeType: 'application/pdf', kind: 'file', byteSize: readFileSync(inputPath).byteLength,
      frameCount: 1, pageCount: 3,
    }
    const outputs = await convert(pdfAdapter, 'pdf', input, inputPath, { targetFormat }, `pdf-${targetFormat}`)
    expect(outputs).toHaveLength(3)
    expect(outputs.map((output) => output.metadata?.pdfPage)).toEqual([1, 2, 3])
    for (const output of outputs) {
      const inspected = probe(output.path, `page.${targetFormat}`, targetFormat === 'png' ? 'image/png' : 'image/jpeg')
      expect(inspected).toMatchObject({ format: targetFormat, frameCount: 1 })
      expect(inspected.width).toBeGreaterThan(100)
      expect(inspected.height).toBeGreaterThan(100)
    }
  }, 120_000)

  it('converts WAV to every approved audio target with the fixed codec family and stripped metadata', async () => {
    const inputPath = join(fixtureRoot, 'tone.wav')
    const input = probe(inputPath, 'tone.wav', 'audio/wav')
    const sourceMetadata = mediaMetadata(inputPath)
    expect(sourceMetadata.format.tags).toMatchObject({
      title: 'AUTOFORGE_WAV_FORMAT_SENTINEL',
      artist: 'AUTOFORGE_WAV_ARTIST_SENTINEL',
      comment: 'AUTOFORGE_WAV_COMMENT_SENTINEL',
    })
    const expected = {
      mp3: { codec: 'mp3', container: 'mp3', mime: 'audio/mpeg' },
      wav: { codec: 'pcm_s16le', container: 'wav', mime: 'audio/wav' },
      m4a: { codec: 'aac', container: 'mov,mp4,m4a,3gp,3g2,mj2', mime: 'audio/mp4' },
      aac: { codec: 'aac', container: 'aac', mime: 'audio/aac' },
      flac: { codec: 'flac', container: 'flac', mime: 'audio/flac' },
      ogg: { codec: 'vorbis', container: 'ogg', mime: 'audio/ogg' },
      opus: { codec: 'opus', container: 'ogg', mime: 'audio/opus' },
    } as const
    for (const targetFormat of Object.keys(expected) as Array<keyof typeof expected>) {
      const output = (await convert(mediaAdapter, 'media', input, inputPath, { targetFormat }, `wav-${targetFormat}`))[0]!
      const metadata = mediaMetadata(output.path)
      expect(metadata.format.format_name).toBe(expected[targetFormat].container)
      let structuralFormat: string
      try {
        structuralFormat = probe(output.path, `tone.${targetFormat}`, expected[targetFormat].mime).format
      } catch (error) {
        throw new Error(`Structural probe rejected the real ${targetFormat} output`, { cause: error })
      }
      expect(structuralFormat).toBe(targetFormat)
      expect(metadata.streams).toHaveLength(1)
      expect(metadata.streams[0]).toMatchObject({ codec_type: 'audio', codec_name: expected[targetFormat].codec })
      expectNoSentinelMetadata(metadata)
    }
  }, 180_000)

  it('converts MP4 to MP4/WebM/MOV/GIF/MP3 with exact container, stream, dimension, frame, and metadata policy', async () => {
    const inputPath = join(fixtureRoot, 'sample.mp4')
    const sourceMetadata = mediaMetadata(inputPath)
    expect(sourceMetadata.format.format_name).toBe('mov,mp4,m4a,3gp,3g2,mj2')
    expect(sourceMetadata.format.tags).toMatchObject({
      title: 'AUTOFORGE_MP4_FORMAT_SENTINEL',
      artist: 'AUTOFORGE_MP4_ARTIST_SENTINEL',
      comment: 'AUTOFORGE_MP4_COMMENT_SENTINEL',
    })
    expect(sourceMetadata.streams.map((stream) => (stream.tags as Record<string, string> | undefined)?.handler_name))
      .toEqual(['AUTOFORGE_VIDEO_STREAM_SENTINEL', 'AUTOFORGE_AUDIO_STREAM_SENTINEL', 'SubtitleHandler'])
    expect(sourceMetadata.chapters).toEqual([
      expect.objectContaining({ tags: { title: 'AUTOFORGE_CHAPTER_SENTINEL' } }),
    ])
    const input: ProbedConversionInput = {
      format: 'mp4', mimeType: 'video/mp4', kind: 'video', byteSize: readFileSync(inputPath).byteLength,
      width: 48, height: 32, frameCount: 12,
    }
    const targets = {
      mp4: { format: 'mov,mp4,m4a,3gp,3g2,mj2', video: 'h264', audio: 'aac' },
      webm: { format: 'matroska,webm', video: 'vp9', audio: 'opus' },
      mov: { format: 'mov,mp4,m4a,3gp,3g2,mj2', video: 'h264', audio: 'aac' },
      gif: { format: 'gif', video: 'gif', audio: undefined },
      mp3: { format: 'mp3', video: undefined, audio: 'mp3' },
    } as const
    for (const [targetFormat, expected] of Object.entries(targets) as Array<[keyof typeof targets, (typeof targets)[keyof typeof targets]]>) {
      const output = (await convert(mediaAdapter, 'media', input, inputPath, { targetFormat }, `mp4-${targetFormat}`))[0]!
      if (targetFormat === 'gif') {
        expect(probe(output.path, 'video.gif', 'image/gif')).toMatchObject({ format: 'gif', width: 48, height: 32 })
      }
      if (targetFormat === 'webm') {
        let webmProbe: ProbedConversionInput
        try {
          webmProbe = probe(output.path, 'video.webm', 'video/webm')
        } catch (error) {
          throw new Error('Production structural probe rejected the real webm output', { cause: error })
        }
        expect(webmProbe).toMatchObject({ format: 'webm' })
      }
      const metadata = mediaMetadata(output.path)
      expect(metadata.format.format_name).toBe(expected.format)
      const video = metadata.streams.find((stream) => stream.codec_type === 'video')
      const audio = metadata.streams.find((stream) => stream.codec_type === 'audio')
      if (expected.video) {
        expect(video).toMatchObject({ codec_name: expected.video, width: 48, height: 32 })
        expect(Number(video?.nb_read_frames)).toBe(12)
      }
      else expect(video).toBeUndefined()
      if (expected.audio) expect(audio?.codec_name).toBe(expected.audio)
      else expect(audio).toBeUndefined()
      expect(metadata.streams.map((stream) => stream.codec_type)).toEqual([
        ...(expected.video ? ['video'] : []), ...(expected.audio ? ['audio'] : []),
      ])
      if (targetFormat !== 'gif') expectMagic(output.path, targetFormat)
      expect(Number(metadata.format.duration)).toBeGreaterThan(0)
      expectNoSentinelMetadata(metadata)
    }
  }, 180_000)
})
