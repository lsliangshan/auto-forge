import { describe, expect, it } from 'vitest'
import type { ConversionTargetFormat } from '@autoforge/shared'
import {
  assertAttachmentBatchLimits,
  probeConversionInput,
  resolveConversionRoute,
} from './conversion-catalog.js'

const MiB = 1024 * 1024

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function gif(width: number, height: number, frames: number): Buffer {
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from([width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0]),
    ...Array.from({ length: frames }, () => Buffer.from([0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0])),
    Buffer.from([0x3b]),
  ])
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
    const pdf = Buffer.from(`%PDF-1.7\n${'/Type /Page\n'.repeat(101)}%%EOF`)
    expect(() => probe(pdf, 'large.pdf', 'application/pdf')).toThrowError(
      expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }),
    )
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
