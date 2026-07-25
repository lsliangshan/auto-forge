import { describe, expect, it } from 'vitest'
import { detectMediaType } from './media-sniffer.js'

const ascii = (value: string) => Buffer.from(value, 'ascii')
const box = (brand: string) => Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  ascii('ftyp'),
  ascii(brand),
  Buffer.alloc(12),
])

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
    ['OGG', ascii('OggS\u0000\u0002'), { kind: 'audio', mimeType: 'audio/ogg', extension: 'ogg', inlineSafe: true }],
    ['FLAC', ascii('fLaC'), { kind: 'audio', mimeType: 'audio/flac', extension: 'flac', inlineSafe: true }],
    ['M4A', box('M4A '), { kind: 'audio', mimeType: 'audio/mp4', extension: 'm4a', inlineSafe: true }],
    ['MP4', box('isom'), { kind: 'video', mimeType: 'video/mp4', extension: 'mp4', inlineSafe: true }],
    ['WebM', Buffer.from('1a45dfa39f42868101', 'hex'), { kind: 'video', mimeType: 'video/webm', extension: 'webm', inlineSafe: true }],
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

  it('never scans beyond the bounded 64 KiB prefix for an SVG root', () => {
    const bytes = Buffer.concat([Buffer.alloc(64 * 1024, 0x20), Buffer.from('<svg></svg>')])
    expect(detectMediaType(bytes)).toBeUndefined()
  })
})
