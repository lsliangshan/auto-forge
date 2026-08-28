import { describe, expect, it } from 'vitest'
import { detectMediaType } from './media-sniffer.js'

const ascii = (value: string) => Buffer.from(value, 'ascii')
const box = (brand: string) => Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  ascii('ftyp'),
  ascii(brand),
  Buffer.alloc(12),
])
const extendedBox = (brand: string) => Buffer.concat([
  Buffer.from([0, 0, 0, 1]),
  ascii('ftyp'),
  Buffer.from([0, 0, 0, 0, 0, 0, 0, 32]),
  ascii(brand),
  Buffer.alloc(12),
])
const ffmpegM4aFtyp = Buffer.from(
  '0000001c667479704d344120000002004d34412069736f6d69736f32',
  'hex',
)
const oggAudio = (codec: Buffer) => Buffer.concat([
  ascii('OggS'),
  Buffer.from([0, 0x02]),
  Buffer.alloc(20),
  Buffer.from([1, codec.byteLength]),
  codec,
])
const ebml = (docType: string) => {
  const docTypeElement = Buffer.concat([Buffer.from([0x42, 0x82, 0x80 | docType.length]), ascii(docType)])
  return Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from([0x80 | docTypeElement.length]), docTypeElement])
}

describe('detectMediaType', () => {
  it.each([
    ['PNG', Buffer.from('89504e470d0a1a0a', 'hex'), { kind: 'image', mimeType: 'image/png', extension: 'png', inlineSafe: true }],
    ['JPEG', Buffer.from('ffd8ffe000104a46494600', 'hex'), { kind: 'image', mimeType: 'image/jpeg', extension: 'jpg', inlineSafe: true }],
    ['WebP', Buffer.concat([ascii('RIFF'), Buffer.alloc(4), ascii('WEBPVP8 ')]), { kind: 'image', mimeType: 'image/webp', extension: 'webp', inlineSafe: true }],
    ['GIF', ascii('GIF89a'), { kind: 'image', mimeType: 'image/gif', extension: 'gif', inlineSafe: true }],
    ['AVIF', box('avif'), { kind: 'image', mimeType: 'image/avif', extension: 'avif', inlineSafe: true }],
    ['SVG', Buffer.from('<?xml version="1.0"?><!--safe--><svg viewBox="0 0 1 1"></svg>'), { kind: 'image', mimeType: 'image/svg+xml', extension: 'svg', inlineSafe: false }],
    ['MP3 with ID3', ascii('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000'), { kind: 'audio', mimeType: 'audio/mpeg', extension: 'mp3', inlineSafe: true }],
    ['MP3 frame', Buffer.from('fffb9064', 'hex'), { kind: 'audio', mimeType: 'audio/mpeg', extension: 'mp3', inlineSafe: true }],
    ['WAV', Buffer.concat([ascii('RIFF'), Buffer.alloc(4), ascii('WAVEfmt ')]), { kind: 'audio', mimeType: 'audio/wav', extension: 'wav', inlineSafe: true }],
    ['Ogg Opus', oggAudio(ascii('OpusHead')), { kind: 'audio', mimeType: 'audio/opus', extension: 'opus', inlineSafe: true }],
    ['Ogg Vorbis', oggAudio(Buffer.concat([Buffer.from([0x01]), ascii('vorbis')])), { kind: 'audio', mimeType: 'audio/ogg', extension: 'ogg', inlineSafe: true }],
    ['FLAC', ascii('fLaC'), { kind: 'audio', mimeType: 'audio/flac', extension: 'flac', inlineSafe: true }],
    ['M4A', ffmpegM4aFtyp, { kind: 'audio', mimeType: 'audio/mp4', extension: 'm4a', inlineSafe: true }],
    ['MP4', box('isom'), { kind: 'video', mimeType: 'video/mp4', extension: 'mp4', inlineSafe: true }],
    ['WebM', ebml('webm'), { kind: 'video', mimeType: 'video/webm', extension: 'webm', inlineSafe: true }],
    ['QuickTime', box('qt  '), { kind: 'video', mimeType: 'video/quicktime', extension: 'mov', inlineSafe: true }],
  ] as const)('detects %s from bytes', (_label, bytes, expected) => {
    expect(detectMediaType(bytes)).toMatchObject(expected)
  })

  it('does not trust names, extensions, or generic text containing an svg element', () => {
    expect(detectMediaType(ascii('not a png despite a .png name'))).toBeUndefined()
    expect(detectMediaType(Buffer.from('<html><svg></svg></html>'))).toBeUndefined()
    expect(detectMediaType(Buffer.from([0xc3, 0x28, 0x3c, 0x73, 0x76, 0x67]))).toBeUndefined()
    expect(detectMediaType(Buffer.from('fffb0064', 'hex'))).toBeUndefined()
  })

  it.each([
    ['truncated ID3', ascii('ID3')],
    ['invalid syncsafe ID3 size', Buffer.from('49443304000080000000', 'hex')],
    ['truncated Ogg page', ascii('OggS')],
    ['Ogg video codec', oggAudio(Buffer.concat([Buffer.from([0x80]), ascii('theora')]))],
    ['Ogg unknown codec', oggAudio(ascii('unknown!'))],
    ['truncated EBML', Buffer.from('1a45dfa3', 'hex')],
    ['Matroska DocType', ebml('matroska')],
    ['EBML without DocType', Buffer.from('1a45dfa38442868101', 'hex')],
    ['undersized ftyp', Buffer.concat([Buffer.from([0, 0, 0, 12]), ascii('ftypavif')])],
    ['oversized truncated ftyp', Buffer.concat([Buffer.from([0, 0, 0, 32]), ascii('ftypavif'), Buffer.alloc(4)])],
    ['truncated extended ftyp', Buffer.concat([Buffer.from([0, 0, 0, 1]), ascii('ftyp'), Buffer.alloc(4)])],
    ['unsupported ftyp brand', box('zzzz')],
    ['conflicting ftyp brands', Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      ascii('ftyp'),
      ascii('avif'),
      Buffer.alloc(4),
      ascii('M4A '),
      Buffer.alloc(4),
    ])],
    ['M4A with conflicting AVIF compatibility', Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      ascii('ftyp'),
      ascii('M4A '),
      Buffer.alloc(4),
      ascii('avif'),
      Buffer.alloc(4),
    ])],
  ] as const)('rejects %s', (_label, bytes) => {
    expect(detectMediaType(bytes)).toBeUndefined()
  })

  it('accepts a structurally valid extended-size ftyp box', () => {
    expect(detectMediaType(extendedBox('avif'))).toMatchObject({
      kind: 'image',
      mimeType: 'image/avif',
      extension: 'avif',
    })
  })

  it('never scans beyond the bounded 64 KiB prefix for an SVG root', () => {
    const bytes = Buffer.concat([Buffer.alloc(64 * 1024, 0x20), Buffer.from('<svg></svg>')])
    expect(detectMediaType(bytes)).toBeUndefined()
  })
})
