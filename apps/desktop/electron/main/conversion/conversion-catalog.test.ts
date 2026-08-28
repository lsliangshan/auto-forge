import { describe, expect, it } from 'vitest'
import type { ConversionTargetFormat } from '@autoforge/shared'
import { deflateSync } from 'node:zlib'
import {
  assertAttachmentBatchLimits,
  probeConversionInput,
  resolveConversionRoute,
} from './conversion-catalog.js'

const MiB = 1024 * 1024

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.byteLength, 0)
  typeBytes.copy(header, 4)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([header, data, crc])
}

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const scanline = width * height <= 10_000 ? Buffer.alloc((width * 4 + 1) * height) : Buffer.from([0])
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanline)),
    chunk('IEND'),
  ])
}

function gif(width: number, height: number, frames: number): Buffer {
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from([width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0]),
    ...Array.from({ length: frames }, () => Buffer.from([
      0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0,
      2, 2, 0x44, 0x01, 0,
    ])),
    Buffer.from([0x3b]),
  ])
}

function pdf(pageCount: number, streamDecoy = false): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(' ')}] >>`,
    ...Array.from({ length: pageCount }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] >>'),
    ...(streamDecoy ? ['<< /Length 11 >>\nstream\n/Type /Page\nendstream'] : []),
  ]
  let body = '%PDF-1.7\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}

function zip(entries: Array<{ name: string; data: string; uncompressedSize?: number }>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.byteLength, 18)
    local.writeUInt32LE(entry.uncompressedSize ?? data.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    locals.push(local, name, data)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(data.byteLength, 20)
    header.writeUInt32LE(entry.uncompressedSize ?? data.byteLength, 24)
    header.writeUInt16LE(name.byteLength, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)
    offset += local.byteLength + name.byteLength + data.byteLength
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

const docx = (bomb = false) => zip([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'word/document.xml', data: '<w:document/>', ...(bomb ? { uncompressedSize: 0x40000000 } : {}) },
])

function opus(): Buffer {
  const packet = Buffer.from('OpusHead', 'ascii')
  const header = Buffer.alloc(28)
  Buffer.from('OggS', 'ascii').copy(header)
  header[4] = 0
  header[5] = 0x06
  header[26] = 1
  header[27] = packet.byteLength
  return Buffer.concat([header, packet])
}

function isoBox(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + data.byteLength)
  header.write(type, 4, 'ascii')
  return Buffer.concat([header, data])
}

function avifWithPayloadIspe(): Buffer {
  const ftyp = isoBox('ftyp', Buffer.concat([
    Buffer.from('avif', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('avif', 'ascii'),
  ]))
  const forgedIspe = Buffer.alloc(20)
  forgedIspe.writeUInt32BE(20)
  forgedIspe.write('ispe', 4, 'ascii')
  forgedIspe.writeUInt32BE(2, 12)
  forgedIspe.writeUInt32BE(3, 16)
  return Buffer.concat([ftyp, isoBox('mdat', forgedIspe)])
}

function avif(width: number, height: number): Buffer {
  const ftyp = isoBox('ftyp', Buffer.concat([
    Buffer.from('avif', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('avif', 'ascii'),
  ]))
  const ispe = Buffer.alloc(12)
  ispe.writeUInt32BE(width, 4)
  ispe.writeUInt32BE(height, 8)
  const meta = isoBox('meta', Buffer.concat([
    Buffer.alloc(4),
    isoBox('iprp', isoBox('ipco', isoBox('ispe', ispe))),
  ]))
  return Buffer.concat([ftyp, meta])
}

function bmp(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(58)
  bytes.write('BM')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(width, 18)
  bytes.writeInt32LE(height, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(24, 28)
  bytes.writeUInt32LE(4, 34)
  return bytes
}

function tiff(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(38)
  bytes.write('II')
  bytes.writeUInt16LE(42, 2)
  bytes.writeUInt32LE(8, 4)
  bytes.writeUInt16LE(2, 8)
  bytes.writeUInt16LE(256, 10)
  bytes.writeUInt16LE(4, 12)
  bytes.writeUInt32LE(1, 14)
  bytes.writeUInt32LE(width, 18)
  bytes.writeUInt16LE(257, 22)
  bytes.writeUInt16LE(4, 24)
  bytes.writeUInt32LE(1, 26)
  bytes.writeUInt32LE(height, 30)
  return bytes
}

function ico(): Buffer {
  const image = png(16, 16)
  const bytes = Buffer.alloc(22)
  bytes.writeUInt16LE(1, 2)
  bytes.writeUInt16LE(1, 4)
  bytes[6] = 16
  bytes[7] = 16
  bytes.writeUInt16LE(1, 10)
  bytes.writeUInt16LE(32, 12)
  bytes.writeUInt32LE(image.byteLength, 14)
  bytes.writeUInt32LE(22, 18)
  return Buffer.concat([bytes, image])
}

function icns(): Buffer {
  const image = png(16, 16)
  const header = Buffer.alloc(16)
  header.write('icns')
  header.writeUInt32BE(16 + image.byteLength, 4)
  header.write('icp4', 8)
  header.writeUInt32BE(8 + image.byteLength, 12)
  return Buffer.concat([header, image])
}

function mp3(): Buffer {
  const bytes = Buffer.alloc(417)
  Buffer.from('fffb9064', 'hex').copy(bytes)
  return bytes
}

function ebml(docType: 'webm' | 'matroska'): Buffer {
  const value = Buffer.from(docType)
  const docTypeElement = Buffer.concat([Buffer.from([0x42, 0x82, 0x80 | value.length]), value])
  const header = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from([0x80 | docTypeElement.length]), docTypeElement])
  return Buffer.concat([header, Buffer.from('1853806780', 'hex')])
}

function cfb(streamName: 'WordDocument' | 'Workbook' | 'PowerPoint Document'): Buffer {
  const header = Buffer.alloc(512)
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header)
  header.writeUInt16LE(0x3e, 24)
  header.writeUInt16LE(3, 26)
  header.writeUInt16LE(0xfffe, 28)
  header.writeUInt16LE(9, 30)
  header.writeUInt16LE(6, 32)
  header.writeUInt32LE(1, 44)
  header.writeUInt32LE(1, 48)
  header.writeUInt32LE(0xfffffffe, 60)
  header.writeUInt32LE(0, 68)
  header.fill(0xff, 72)
  header.writeUInt32LE(0, 76)
  const fat = Buffer.alloc(512, 0xff)
  fat.writeUInt32LE(0xfffffffd, 0)
  fat.writeUInt32LE(0xfffffffe, 4)
  const directory = Buffer.alloc(512)
  const name = Buffer.from(`${streamName}\0`, 'utf16le')
  name.copy(directory)
  directory.writeUInt16LE(name.byteLength, 64)
  directory[66] = 2
  return Buffer.concat([header, fat, directory])
}

const probe = (
  bytes: Uint8Array,
  displayName: string,
  mimeType: string,
  byteSize = bytes.byteLength,
) => probeConversionInput({ bytes, displayName, mimeType, byteSize })

describe('conversion catalog input probing', () => {
  it('rejects a forged extension and MIME when PNG magic wins', () => {
    expect(() => probe(png(2, 3), 'portrait.jpg', 'image/jpeg')).toThrowError(
      expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }),
    )
  })

  it('enforces image, audio, video, ordinary-file, request, and attachment limits', () => {
    expect(() => probe(png(1, 1), 'image.png', 'image/png', 20 * MiB + 1)).toThrowError(
      expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }),
    )

    expect(() => assertAttachmentBatchLimits([
      { kind: 'video', byteSize: 130 * MiB },
      { kind: 'audio', byteSize: 50 * MiB },
      { kind: 'file', byteSize: 71 * MiB },
    ])).toThrowError(expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }))

    expect(() => assertAttachmentBatchLimits(Array.from({ length: 6 }, () => ({
      kind: 'image' as const,
      byteSize: 1,
    })))).toThrowError(expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }))

    expect(() => assertAttachmentBatchLimits([
      { kind: 'audio', byteSize: 50 * MiB + 1 },
    ])).toThrowError(expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }))
    expect(() => assertAttachmentBatchLimits([
      { kind: 'video', byteSize: 200 * MiB + 1 },
    ])).toThrowError(expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }))
    expect(() => assertAttachmentBatchLimits([
      { kind: 'file', byteSize: 100 * MiB + 1 },
    ])).toThrowError(expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }))
  })

  it('rejects more than 100 megapixels in one frame and 500 megapixels total', () => {
    expect(() => probe(png(10_001, 10_000), 'huge.png', 'image/png')).toThrowError(
      expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }),
    )
    expect(() => probe(gif(10_000, 10_000, 6), 'huge.gif', 'image/gif')).toThrowError(
      expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }),
    )
  })

  it('rejects a PDF with 101 pages rather than truncating it', () => {
    expect(() => probe(pdf(101), 'large.pdf', 'application/pdf')).toThrowError(
      expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }),
    )
  })

  it('counts PDF page objects structurally and ignores page text inside streams', () => {
    expect(probe(pdf(1, true), 'one.pdf', 'application/pdf')).toMatchObject({ pageCount: 1 })
  })

  it.each([
    ['PNG signature only', Buffer.from('89504e470d0a1a0a', 'hex'), 'broken.png', 'image/png'],
    ['GIF header only', Buffer.from('GIF89a', 'ascii'), 'broken.gif', 'image/gif'],
    ['JPEG without EOI', Buffer.from('ffd8ffe000104a46494600', 'hex'), 'broken.jpeg', 'image/jpeg'],
    ['WebP without complete RIFF chunks', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]), 'broken.webp', 'image/webp'],
    ['PDF without xref/trailer', Buffer.from('%PDF-1.7\n1 0 obj << /Type /Page >>\nendobj\n%%EOF'), 'broken.pdf', 'application/pdf'],
    ['OOXML raw substring without ZIP structure', Buffer.from('PK word/document.xml'), 'broken.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['WAV without fmt/data chunks', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]), 'broken.wav', 'audio/wav'],
    ['MP4 ftyp without media structure', Buffer.from('000000186674797069736f6d0000000069736f6d6d703431', 'hex'), 'broken.mp4', 'video/mp4'],
  ] as const)('rejects truncated or malformed %s', (_label, bytes, name, mimeType) => {
    expect(() => probe(bytes, name, mimeType)).toThrowError(
      expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }),
    )
  })

  it('accepts OOXML only from exact ZIP central-directory entries and rejects decompression bombs', () => {
    expect(probe(docx(), 'document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
      .toMatchObject({ format: 'docx' })
    expect(() => probe(docx(true), 'document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
      .toThrowError(expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }))
  })

  it('rejects AVIF dimensions forged as an ispe substring inside media payload', () => {
    expect(() => probe(avifWithPayloadIspe(), 'image.avif', 'image/avif'))
      .toThrowError(expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }))
  })

  it('distinguishes Ogg Opus from Ogg Vorbis', () => {
    expect(probe(opus(), 'voice.opus', 'audio/opus')).toMatchObject({
      format: 'opus', mimeType: 'audio/opus', kind: 'audio',
    })
  })

  it.each([
    ['avif', avif(3, 2), 'image.avif', 'image/avif'],
    ['bmp', bmp(3, 2), 'image.bmp', 'image/bmp'],
    ['tiff', tiff(3, 2), 'image.tiff', 'image/tiff'],
    ['ico', ico(), 'icon.ico', 'image/vnd.microsoft.icon'],
    ['icns', icns(), 'icon.icns', 'image/icns'],
    ['mp3', mp3(), 'audio.mp3', 'audio/mpeg'],
    ['webm', ebml('webm'), 'video.webm', 'video/webm'],
    ['mkv', ebml('matroska'), 'video.mkv', 'video/x-matroska'],
    ['doc', cfb('WordDocument'), 'document.doc', 'application/msword'],
    ['xls', cfb('Workbook'), 'sheet.xls', 'application/vnd.ms-excel'],
    ['ppt', cfb('PowerPoint Document'), 'slides.ppt', 'application/vnd.ms-powerpoint'],
  ] as const)('establishes mandatory structure for %s', (format, bytes, name, mimeType) => {
    expect(probe(bytes, name, mimeType)).toMatchObject({ format })
  })

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="./x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="file:///tmp/x.svg#icon"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(//example.com/x.css)</style></svg>',
  ])('rejects unsafe SVG content: %s', (svg) => {
    expect(() => probe(Buffer.from(svg), 'unsafe.svg', 'image/svg+xml')).toThrowError(
      expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }),
    )
  })

  it('records contain-and-pad geometry for a non-square icon source without cropping', () => {
    const input = probe(png(300, 150), 'wide.png', 'image/png')
    expect(resolveConversionRoute(input, 'ico')).toMatchObject({
      targetFormat: 'ico',
      iconGeometry: {
        fit: 'contain',
        canvas: 'square',
        crop: false,
        transparentPadding: true,
      },
    })
  })
})

describe('conversion catalog routes', () => {
  it.each([
    ['png', 'jpeg'],
    ['gif', 'mp4'],
    ['svg', 'pdf'],
    ['ico', 'png'],
    ['docx', 'pdf'],
    ['csv', 'xlsx'],
    ['pdf', 'png'],
    ['mp3', 'flac'],
    ['mkv', 'webm'],
    ['mp4', 'opus'],
  ] as const)('allows %s to %s', (sourceFormat, targetFormat) => {
    expect(resolveConversionRoute({
      format: sourceFormat,
      mimeType: 'application/octet-stream',
      kind: sourceFormat === 'mp3' ? 'audio' : sourceFormat === 'mkv' || sourceFormat === 'mp4' ? 'video' : 'file',
      byteSize: 1,
      frameCount: 1,
    }, targetFormat)).toMatchObject({ sourceFormat, targetFormat })
  })

  it.each([
    ['pdf', 'xlsx'],
    ['png', 'svg'],
    ['docx', 'xlsx'],
    ['wav', 'png'],
  ] as const)('fails closed for unsupported %s to %s', (sourceFormat, targetFormat) => {
    expect(() => resolveConversionRoute({
      format: sourceFormat,
      mimeType: 'application/octet-stream',
      kind: 'file',
      byteSize: 1,
      frameCount: 1,
    }, targetFormat as ConversionTargetFormat)).toThrowError(expect.objectContaining({ code: 'CONVERSION_FORMAT_UNSUPPORTED' }))
  })
})
