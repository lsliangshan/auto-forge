import { createHash } from 'node:crypto'
import type { ConversionTargetFormat } from '@autoforge/shared'
import { toSafeAppError, type AppError, type AppErrorCode } from '@autoforge/shared'
import { detectMediaType, isSafeSvg } from '../media/media-sniffer.js'

const MiB = 1024 * 1024

export const CONVERSION_LIMITS = {
  attachments: 5,
  imageBytes: 20 * MiB,
  audioBytes: 50 * MiB,
  videoBytes: 200 * MiB,
  fileBytes: 100 * MiB,
  requestBytes: 250 * MiB,
  outputBytes: 500 * MiB,
  pixelsPerFrame: 100_000_000,
  totalPixels: 500_000_000,
  pdfPages: 100,
} as const

export type ConversionInputKind = 'image' | 'audio' | 'video' | 'file'
export type ConversionInputFormat =
  | 'png' | 'jpeg' | 'webp' | 'avif' | 'tiff' | 'bmp' | 'gif' | 'svg' | 'ico' | 'icns'
  | 'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx'
  | 'odt' | 'ods' | 'odp' | 'rtf' | 'csv' | 'html' | 'markdown' | 'txt' | 'pdf'
  | 'mp3' | 'wav' | 'm4a' | 'aac' | 'flac' | 'ogg' | 'opus'
  | 'mp4' | 'webm' | 'mov' | 'mkv' | 'avi'

export interface ProbedIcnsSlot {
  readonly type: 'icp4' | 'ic11' | 'icp5' | 'ic12' | 'icp6' | 'ic07' | 'ic13' | 'ic08' | 'ic14' | 'ic09' | 'ic10'
  readonly logicalSize: 16 | 32 | 64 | 128 | 256 | 512
  readonly scale: 1 | 2
  readonly pixelSize: 16 | 32 | 64 | 128 | 256 | 512 | 1024
}

export interface ProbedIcoRepresentation {
  readonly sourceIndex: number
  readonly width: number
  readonly height: number
  readonly payloadSha256: string
}

export interface ProbedConversionInput {
  format: ConversionInputFormat
  mimeType: string
  kind: ConversionInputKind
  byteSize: number
  width?: number
  height?: number
  frameCount: number
  pageCount?: number
  iconSlots?: readonly ProbedIcnsSlot[]
  icoRepresentations?: readonly ProbedIcoRepresentation[]
}

export interface ConversionRoute {
  sourceFormat: ConversionInputFormat
  targetFormat: ConversionTargetFormat
  frameSelection?: 'first'
  iconGeometry?: {
    fit: 'contain'
    canvas: 'square'
    crop: false
    transparentPadding: true
  }
}

const extensionAliases: Record<string, ConversionInputFormat> = {
  jpg: 'jpeg', jpeg: 'jpeg', tif: 'tiff', tiff: 'tiff', md: 'markdown', markdown: 'markdown',
  htm: 'html', html: 'html',
}

const mimeFormats: Record<string, ConversionInputFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/icns': 'icns',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'markdown',
  'text/plain': 'txt',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
}

const canonicalMime: Record<ConversionInputFormat, string> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', tiff: 'image/tiff',
  bmp: 'image/bmp', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/vnd.microsoft.icon', icns: 'image/icns',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', rtf: 'application/rtf', csv: 'text/csv', html: 'text/html',
  markdown: 'text/markdown', txt: 'text/plain', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
}

const imageFormats = new Set<ConversionInputFormat>(['png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'svg', 'ico', 'icns'])
const audioFormats = new Set<ConversionInputFormat>(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'])
const videoFormats = new Set<ConversionInputFormat>(['mp4', 'webm', 'mov', 'mkv', 'avi'])

function failure(code: AppErrorCode): AppError {
  return toSafeAppError({ code })
}

function ascii(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
}

function extensionOf(displayName: string): ConversionInputFormat | undefined {
  const index = displayName.lastIndexOf('.')
  if (index <= 0 || index === displayName.length - 1) return undefined
  const extension = displayName.slice(index + 1).toLowerCase()
  return extensionAliases[extension] ?? (extension in canonicalMime ? extension as ConversionInputFormat : undefined)
}

interface StructuralProbe {
  format: ConversionInputFormat
  width?: number
  height?: number
  frameCount: number
  pageCount?: number
  pixelCounts?: number[]
  iconSlots?: readonly ProbedIcnsSlot[]
  icoRepresentations?: readonly ProbedIcoRepresentation[]
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngProbe(bytes: Uint8Array): StructuralProbe | undefined {
  if (!Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return undefined
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let width: number | undefined
  let height: number | undefined
  let sawData = false
  let sawEnd = false
  while (offset + 12 <= bytes.length) {
    const length = buffer.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) return undefined
    const type = ascii(bytes.subarray(offset + 4, offset + 8))
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (buffer.readUInt32BE(offset + 8 + length) !== crc32(bytes.subarray(offset + 4, offset + 8 + length))) return undefined
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) return undefined
      width = buffer.readUInt32BE(offset + 8)
      height = buffer.readUInt32BE(offset + 12)
      if (!width || !height || ![1, 2, 4, 8, 16].includes(data[8]!) || data[10] !== 0 || data[11] !== 0) return undefined
    } else if (type === 'IHDR') return undefined
    if (type === 'IDAT') sawData = true
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length) return undefined
      sawEnd = true
      offset = end
      break
    }
    offset = end
  }
  return width && height && sawData && sawEnd && offset === bytes.length
    ? { format: 'png', width, height, frameCount: 1, pixelCounts: [width * height] }
    : undefined
}

function gifProbe(bytes: Uint8Array): StructuralProbe | undefined {
  if (ascii(bytes.subarray(0, 6)) !== 'GIF87a' && ascii(bytes.subarray(0, 6)) !== 'GIF89a') return undefined
  if (bytes.length < 14) return undefined
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const canvasWidth = buffer.readUInt16LE(6)
  const canvasHeight = buffer.readUInt16LE(8)
  if (!canvasWidth || !canvasHeight) return undefined
  let offset = 13
  if ((bytes[10]! & 0x80) !== 0) offset += 3 * (1 << ((bytes[10]! & 0x07) + 1))
  const pixels: number[] = []
  const skipBlocks = () => {
    while (offset < bytes.length) {
      const size = bytes[offset++]!
      if (size === 0) return true
      if (offset + size > bytes.length) return false
      offset += size
    }
    return false
  }
  while (offset < bytes.length) {
    const marker = bytes[offset++]!
    if (marker === 0x3b) {
      if (offset !== bytes.length || pixels.length === 0) return undefined
      return { format: 'gif', width: canvasWidth, height: canvasHeight, frameCount: pixels.length, pixelCounts: pixels }
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) return undefined
      offset += 1
      if (!skipBlocks()) return undefined
      continue
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return undefined
    const left = buffer.readUInt16LE(offset)
    const top = buffer.readUInt16LE(offset + 2)
    const width = buffer.readUInt16LE(offset + 4)
    const height = buffer.readUInt16LE(offset + 6)
    const packed = bytes[offset + 8]!
    offset += 9
    if (!width || !height || left + width > canvasWidth || top + height > canvasHeight) return undefined
    pixels.push(canvasWidth * canvasHeight)
    if ((packed & 0x80) !== 0) offset += 3 * (1 << ((packed & 0x07) + 1))
    if (offset >= bytes.length || bytes[offset]! < 2 || bytes[offset]! > 8) return undefined
    offset += 1
    if (!skipBlocks()) return undefined
  }
  return undefined
}

function jpegProbe(bytes: Uint8Array): StructuralProbe | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2
  let width: number | undefined
  let height: number | undefined
  let sawScan = false
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return undefined
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset++]
    if (marker === undefined) return undefined
    if (marker === 0xd9) {
      return offset === bytes.length && sawScan && width && height
        ? { format: 'jpeg', width, height, frameCount: 1, pixelCounts: [width * height] }
        : undefined
    }
    if (marker === 0xda) {
      if (offset + 2 > bytes.length) return undefined
      const length = buffer.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) return undefined
      sawScan = true
      offset += length
      while (offset + 1 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1
          continue
        }
        const next = bytes[offset + 1]!
        if (next !== 0x00 && (next < 0xd0 || next > 0xd7)) break
        offset += 2
      }
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return undefined
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) return undefined
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 8) return undefined
      height = buffer.readUInt16BE(offset + 3)
      width = buffer.readUInt16BE(offset + 5)
    }
    offset += length
  }
  return undefined
}

function webpProbe(bytes: Uint8Array): StructuralProbe | undefined {
  if (ascii(bytes.subarray(0, 4)) !== 'RIFF' || ascii(bytes.subarray(8, 12)) !== 'WEBP' || bytes.length < 20) return undefined
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.readUInt32LE(4) + 8 !== bytes.length) return undefined
  let offset = 12
  let width: number | undefined
  let height: number | undefined
  let extended = false
  let animated = false
  let imagePayloads = 0
  let frames = 0
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes.subarray(offset, offset + 4))
    const length = buffer.readUInt32LE(offset + 4)
    const data = offset + 8
    const end = data + length
    if (end > bytes.length) return undefined
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10) return undefined
      extended = true
      animated = (bytes[data]! & 0x02) !== 0
      width = 1 + bytes[data + 4]! + bytes[data + 5]! * 256 + bytes[data + 6]! * 65_536
      height = 1 + bytes[data + 7]! + bytes[data + 8]! * 256 + bytes[data + 9]! * 65_536
    } else if (type === 'VP8 ') {
      if (length < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return undefined
      width ??= buffer.readUInt16LE(data + 6) & 0x3fff
      height ??= buffer.readUInt16LE(data + 8) & 0x3fff
      imagePayloads += 1
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[data] !== 0x2f) return undefined
      const bits = buffer.readUInt32LE(data + 1)
      width ??= (bits & 0x3fff) + 1
      height ??= ((bits >>> 14) & 0x3fff) + 1
      imagePayloads += 1
    } else if (type === 'ANMF') {
      if (length < 16) return undefined
      frames += 1
    }
    offset = end + (length & 1)
  }
  if (offset !== bytes.length || !width || !height || (animated ? frames < 1 : imagePayloads !== 1)) return undefined
  if (!extended && frames > 0) return undefined
  const frameCount = animated ? frames : 1
  return { format: 'webp', width, height, frameCount, pixelCounts: Array(frameCount).fill(width * height) }
}

function riffProbe(bytes: Uint8Array): StructuralProbe | undefined {
  if (ascii(bytes.subarray(0, 4)) !== 'RIFF' || bytes.length < 12) return undefined
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.readUInt32LE(4) + 8 !== bytes.length) return undefined
  const form = ascii(bytes.subarray(8, 12))
  let offset = 12
  let sawFormat = false
  let sawData = false
  let sawAviHeader = false
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes.subarray(offset, offset + 4))
    const length = buffer.readUInt32LE(offset + 4)
    if (offset + 8 + length > bytes.length) return undefined
    if (type === 'fmt ' && length >= 16) sawFormat = true
    if (type === 'data') sawData = true
    if (type === 'avih' && length >= 40) sawAviHeader = true
    offset += 8 + length + (length & 1)
  }
  if (offset !== bytes.length) return undefined
  if (form === 'WAVE' && sawFormat && sawData) return { format: 'wav', frameCount: 1 }
  if (form === 'AVI ' && sawAviHeader) return { format: 'avi', frameCount: 1 }
  return undefined
}

interface ZipEntry {
  name: string
  compressedSize: number
  uncompressedSize: number
  method: number
  localOffset: number
  recordEnd: number
  data?: Uint8Array
}

function zipEntries(bytes: Uint8Array): ZipEntry[] | undefined {
  if (bytes.length < 22) return undefined
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const searchStart = Math.max(0, bytes.length - 65_557)
  let endOffset = -1
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break }
  }
  if (endOffset < 0 || endOffset + 22 + buffer.readUInt16LE(endOffset + 20) !== bytes.length) return undefined
  if (buffer.readUInt16LE(endOffset + 4) !== 0 || buffer.readUInt16LE(endOffset + 6) !== 0) return undefined
  const count = buffer.readUInt16LE(endOffset + 10)
  if (count !== buffer.readUInt16LE(endOffset + 8) || count > 10_000) return undefined
  const centralSize = buffer.readUInt32LE(endOffset + 12)
  const centralOffset = buffer.readUInt32LE(endOffset + 16)
  if (centralOffset + centralSize !== endOffset) return undefined
  const entries: ZipEntry[] = []
  let offset = centralOffset
  let totalUncompressed = 0
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== 0x02014b50) return undefined
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength
    if ((flags & ~0x0808) !== 0 || ![0, 8].includes(method) || entryEnd > endOffset) return undefined
    const name = Buffer.from(bytes.subarray(offset + 46, offset + 46 + nameLength)).toString('utf8')
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) return undefined
    totalUncompressed += uncompressedSize
    if (totalUncompressed > 500 * MiB || uncompressedSize > 200 * MiB) return undefined
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > 1_000)) return undefined
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) return undefined
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    if (dataOffset + compressedSize > centralOffset) return undefined
    if (Buffer.from(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)).toString('utf8') !== name) return undefined
    if (buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method) return undefined
    const data = bytes.subarray(dataOffset, dataOffset + compressedSize)
    let recordEnd = dataOffset + compressedSize
    const centralCrc = buffer.readUInt32LE(offset + 16)
    if ((flags & 0x0008) !== 0) {
      if (
        buffer.readUInt32LE(localOffset + 14) !== 0
        || buffer.readUInt32LE(localOffset + 18) !== 0
        || buffer.readUInt32LE(localOffset + 22) !== 0
      ) return undefined
      if (recordEnd + 12 > centralOffset) return undefined
      if (buffer.readUInt32LE(recordEnd) === 0x08074b50) recordEnd += 4
      if (
        recordEnd + 12 > centralOffset
        || buffer.readUInt32LE(recordEnd) !== centralCrc
        || buffer.readUInt32LE(recordEnd + 4) !== compressedSize
        || buffer.readUInt32LE(recordEnd + 8) !== uncompressedSize
      ) return undefined
      recordEnd += 12
    } else if (
      buffer.readUInt32LE(localOffset + 14) !== centralCrc
      || buffer.readUInt32LE(localOffset + 18) !== compressedSize
      || buffer.readUInt32LE(localOffset + 22) !== uncompressedSize
    ) return undefined
    if (method === 0 && (compressedSize !== uncompressedSize || crc32(data) !== centralCrc)) return undefined
    entries.push({ name, compressedSize, uncompressedSize, method, localOffset, recordEnd, ...(method === 0 ? { data } : {}) })
    offset = entryEnd
  }
  if (offset !== endOffset) return undefined
  const localOrder = [...entries].sort((left, right) => left.localOffset - right.localOffset)
  if (localOrder[0]?.localOffset !== 0) return undefined
  for (let index = 0; index < localOrder.length; index += 1) {
    if (localOrder[index]!.recordEnd !== (localOrder[index + 1]?.localOffset ?? centralOffset)) return undefined
  }
  return entries
}

function zipProbe(bytes: Uint8Array): StructuralProbe | undefined {
  const entries = zipEntries(bytes)
  if (!entries) return undefined
  const names = new Set(entries.map(({ name }) => name))
  if (names.has('[Content_Types].xml') && names.has('word/document.xml')) return { format: 'docx', frameCount: 1 }
  if (names.has('[Content_Types].xml') && names.has('xl/workbook.xml')) return { format: 'xlsx', frameCount: 1 }
  if (names.has('[Content_Types].xml') && names.has('ppt/presentation.xml')) return { format: 'pptx', frameCount: 1 }
  const mimetype = entries.find(({ name }) => name === 'mimetype')
  const mime = mimetype?.data ? Buffer.from(mimetype.data).toString('ascii') : ''
  if (names.has('content.xml') && mime === 'application/vnd.oasis.opendocument.text') return { format: 'odt', frameCount: 1 }
  if (names.has('content.xml') && mime === 'application/vnd.oasis.opendocument.spreadsheet') return { format: 'ods', frameCount: 1 }
  if (names.has('content.xml') && mime === 'application/vnd.oasis.opendocument.presentation') return { format: 'odp', frameCount: 1 }
  return undefined
}

function pdfProbe(bytes: Uint8Array): StructuralProbe | undefined {
  const text = Buffer.from(bytes).toString('latin1')
  if (!/^%PDF-1\.[0-7](?:\r?\n|\r)/.test(text) || !/%%EOF\s*$/.test(text)) return undefined
  const start = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)
  if (!start) return undefined
  const xref = Number(start[1])
  if (!Number.isSafeInteger(xref) || text.slice(xref, xref + 4) !== 'xref') return undefined
  let cursor = xref + 4
  const objectOffsets: Array<{ object: number; generation: number; offset: number }> = []
  const line = () => {
    while (text[cursor] === '\r' || text[cursor] === '\n' || text[cursor] === ' ' || text[cursor] === '\t') cursor += 1
    const end = text.indexOf('\n', cursor)
    if (end < 0) return undefined
    const value = text.slice(cursor, end).replace(/\r$/, '')
    cursor = end + 1
    return value
  }
  while (true) {
    while (/\s/.test(text[cursor] ?? '')) cursor += 1
    if (text.startsWith('trailer', cursor)) break
    const subsection = line()?.match(/^(\d+)\s+(\d+)$/)
    if (!subsection) return undefined
    const first = Number(subsection[1])
    const count = Number(subsection[2])
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count < 1 || count > 100_000) return undefined
    for (let index = 0; index < count; index += 1) {
      const entry = line()?.match(/^(\d{10})\s(\d{5})\s([nf])\s*$/)
      if (!entry) return undefined
      if (entry[3] === 'n') objectOffsets.push({ object: first + index, generation: Number(entry[2]), offset: Number(entry[1]) })
    }
  }
  cursor += 'trailer'.length
  const trailerEnd = text.indexOf('startxref', cursor)
  if (trailerEnd < 0) return undefined
  const trailer = text.slice(cursor, trailerEnd)
  if (
    !/<<[\s\S]*>>/.test(trailer)
    || !/\/Size\s+\d+/.test(trailer)
    || !/\/Root\s+\d+\s+\d+\s+R/.test(trailer)
  ) return undefined
  let pageCount = 0
  for (const entry of objectOffsets) {
    if (entry.offset <= 0 || entry.offset >= xref) return undefined
    const prefix = `${entry.object} ${entry.generation} obj`
    if (!text.startsWith(prefix, entry.offset)) return undefined
    const dictionaryStart = text.indexOf('<<', entry.offset + prefix.length)
    if (dictionaryStart < 0 || dictionaryStart >= xref) continue
    let depth = 0
    let dictionaryEnd = -1
    for (let index = dictionaryStart; index + 1 < xref; index += 1) {
      const pair = text.slice(index, index + 2)
      if (pair === '<<') { depth += 1; index += 1 }
      else if (pair === '>>') {
        depth -= 1
        index += 1
        if (depth === 0) { dictionaryEnd = index + 1; break }
      }
    }
    if (dictionaryEnd < 0) return undefined
    const tokens = text.slice(dictionaryStart + 2, dictionaryEnd - 2).match(/\/[A-Za-z0-9_.+-]+|[^\s<>()[\]{}%]+/g) ?? []
    for (let index = 0; index + 1 < tokens.length; index += 1) {
      if (tokens[index] === '/Type' && tokens[index + 1] === '/Page') { pageCount += 1; break }
    }
  }
  return pageCount > 0 ? { format: 'pdf', frameCount: 1, pageCount } : undefined
}

function oggProbe(bytes: Uint8Array): StructuralProbe | undefined {
  let offset = 0
  let firstPacket = Buffer.alloc(0)
  let firstComplete = false
  let expectedSequence = 0
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || ascii(bytes.subarray(offset, offset + 4)) !== 'OggS' || bytes[offset + 4] !== 0) return undefined
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset)
    if (buffer.readUInt32LE(18) !== expectedSequence) return undefined
    expectedSequence += 1
    const segments = bytes[offset + 26]!
    if (offset + 27 + segments > bytes.length) return undefined
    let bodySize = 0
    for (let index = 0; index < segments; index += 1) bodySize += bytes[offset + 27 + index]!
    const bodyOffset = offset + 27 + segments
    if (bodyOffset + bodySize > bytes.length) return undefined
    if (!firstComplete) {
      let packetBytes = 0
      for (let index = 0; index < segments; index += 1) {
        const size = bytes[offset + 27 + index]!
        packetBytes += size
        if (size < 255) { firstComplete = true; break }
      }
      firstPacket = Buffer.concat([firstPacket, Buffer.from(bytes.subarray(bodyOffset, bodyOffset + packetBytes))])
    }
    offset = bodyOffset + bodySize
  }
  if (!firstComplete) return undefined
  if (ascii(firstPacket.subarray(0, 8)) === 'OpusHead') return { format: 'opus', frameCount: 1 }
  if (firstPacket[0] === 0x01 && ascii(firstPacket.subarray(1, 7)) === 'vorbis') return { format: 'ogg', frameCount: 1 }
  return undefined
}

interface IsoBox { type: string; dataOffset: number; end: number }

function isoBoxes(bytes: Uint8Array, start: number, end: number): IsoBox[] | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boxes: IsoBox[] = []
  let offset = start
  while (offset < end) {
    if (boxes.length >= 100_000 || offset + 8 > end) return undefined
    let size = buffer.readUInt32BE(offset)
    const type = ascii(bytes.subarray(offset + 4, offset + 8))
    let header = 8
    if (size === 1) {
      if (offset + 16 > end) return undefined
      const large = buffer.readBigUInt64BE(offset + 8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
      size = Number(large)
      header = 16
    } else if (size === 0) size = end - offset
    if (size < header || offset + size > end) return undefined
    boxes.push({ type, dataOffset: offset + header, end: offset + size })
    offset += size
  }
  return offset === end ? boxes : undefined
}

function isoProbe(bytes: Uint8Array): StructuralProbe | undefined {
  if (bytes.length < 16 || ascii(bytes.subarray(4, 8)) !== 'ftyp') return undefined
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const top = isoBoxes(bytes, 0, bytes.length)
  if (!top || top[0]?.type !== 'ftyp') return undefined
  const ftyp = top[0]
  if (ftyp.end - ftyp.dataOffset < 8 || (ftyp.end - ftyp.dataOffset) % 4 !== 0) return undefined
  const brands = new Set<string>()
  for (let brandOffset = ftyp.dataOffset; brandOffset + 4 <= ftyp.end; brandOffset += 4) {
    if (brandOffset === ftyp.dataOffset + 4) continue
    brands.add(ascii(bytes.subarray(brandOffset, brandOffset + 4)))
  }
  if (!top.some(({ type }) => type === 'moov' || type === 'meta' || type === 'mdat')) return undefined

  let dimensions: { width: number; height: number } | undefined
  const meta = top.find(({ type }) => type === 'meta')
  if (meta && meta.dataOffset + 4 <= meta.end) {
    const metaChildren = isoBoxes(bytes, meta.dataOffset + 4, meta.end)
    const iprp = metaChildren?.find(({ type }) => type === 'iprp')
    const iprpChildren = iprp ? isoBoxes(bytes, iprp.dataOffset, iprp.end) : undefined
    const ipco = iprpChildren?.find(({ type }) => type === 'ipco')
    const properties = ipco ? isoBoxes(bytes, ipco.dataOffset, ipco.end) : undefined
    const spatialExtents = properties?.filter(({ type }) => type === 'ispe') ?? []
    if (spatialExtents.length === 1) {
      const ispe = spatialExtents[0]!
      if (ispe.end - ispe.dataOffset === 12) {
        const width = buffer.readUInt32BE(ispe.dataOffset + 4)
        const height = buffer.readUInt32BE(ispe.dataOffset + 8)
        if (width && height) dimensions = { width, height }
      }
    }
  }
  if (brands.has('avif') && !brands.has('avis')) return dimensions
    ? {
        format: 'avif',
        width: dimensions.width,
        height: dimensions.height,
        frameCount: 1,
        pixelCounts: [dimensions.width * dimensions.height],
      }
    : undefined
  if (brands.has('M4A ') || brands.has('M4B ')) return { format: 'm4a', frameCount: 1 }
  if (brands.has('qt  ')) return { format: 'mov', frameCount: 1 }
  if ([...brands].some((brand) => ['isom', 'iso2', 'mp41', 'mp42', 'avc1'].includes(brand) || brand.startsWith('3g'))) {
    return { format: 'mp4', frameCount: 1 }
  }
  return undefined
}

function textProbe(bytes: Uint8Array, declaredExtension: ConversionInputFormat | undefined): StructuralProbe | undefined {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '') } catch { return undefined }
  if (text.includes('\0')) return undefined
  if (/^\s*\{\\rtf[1-9]\b/.test(text)) {
    let depth = 0
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === '\\') { index += 1; continue }
      if (text[index] === '{') depth += 1
      if (text[index] === '}' && --depth < 0) return undefined
    }
    return depth === 0 ? { format: 'rtf', frameCount: 1 } : undefined
  }
  if (/^\s*(?:<!doctype\s+html\b[^>]*>\s*)?<html\b/i.test(text) && /<\/html>\s*$/i.test(text)) return { format: 'html', frameCount: 1 }
  if (declaredExtension === 'csv') {
    let quoted = false
    let delimiters = 0
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === '"') {
        if (quoted && text[index + 1] === '"') index += 1
        else quoted = !quoted
      } else if (!quoted && [',', ';', '\t'].includes(text[index]!)) delimiters += 1
    }
    return !quoted && delimiters > 0 ? { format: 'csv', frameCount: 1 } : undefined
  }
  if (declaredExtension === 'markdown' || declaredExtension === 'txt') return { format: declaredExtension, frameCount: 1 }
  return undefined
}

function simpleBinaryProbe(bytes: Uint8Array): StructuralProbe | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (ascii(bytes.subarray(0, 4)) === 'fLaC' && bytes.length >= 42 && (bytes[4]! & 0x7f) === 0 && buffer.readUIntBE(5, 3) === 34) return { format: 'flac', frameCount: 1 }
  if (bytes.length >= 7 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) {
    let offset = 0
    while (offset < bytes.length) {
      if (offset + 7 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xf6) !== 0xf0) return undefined
      const length = ((bytes[offset + 3]! & 0x03) << 11) | (bytes[offset + 4]! << 3) | (bytes[offset + 5]! >>> 5)
      if (length < 7 || offset + length > bytes.length) return undefined
      offset += length
    }
    return { format: 'aac', frameCount: 1 }
  }
  return undefined
}

function bmpProbe(bytes: Uint8Array): StructuralProbe | undefined {
  if (ascii(bytes.subarray(0, 2)) !== 'BM' || bytes.length < 54) return undefined
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fileSize = buffer.readUInt32LE(2)
  const pixelOffset = buffer.readUInt32LE(10)
  const dibSize = buffer.readUInt32LE(14)
  const width = Math.abs(buffer.readInt32LE(18))
  const height = Math.abs(buffer.readInt32LE(22))
  const planes = buffer.readUInt16LE(26)
  const bits = buffer.readUInt16LE(28)
  const imageSize = buffer.readUInt32LE(34)
  if (fileSize !== bytes.length || dibSize < 40 || pixelOffset < 14 + dibSize || pixelOffset > bytes.length) return undefined
  if (!width || !height || planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bits) || pixelOffset + imageSize > bytes.length) return undefined
  return { format: 'bmp', width, height, frameCount: 1, pixelCounts: [width * height] }
}

function tiffProbe(bytes: Uint8Array): StructuralProbe | undefined {
  if (bytes.length < 14) return undefined
  const little = ascii(bytes.subarray(0, 2)) === 'II'
  if (!little && ascii(bytes.subarray(0, 2)) !== 'MM') return undefined
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const read16 = (offset: number) => little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
  const read32 = (offset: number) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
  if (read16(2) !== 42) return undefined
  let ifd = read32(4)
  const seen = new Set<number>()
  const pixels: number[] = []
  let maxWidth = 0
  let maxHeight = 0
  while (ifd !== 0) {
    if (seen.has(ifd) || seen.size >= 100 || ifd + 2 > bytes.length) return undefined
    seen.add(ifd)
    const count = read16(ifd)
    const entriesEnd = ifd + 2 + count * 12
    if (count > 4_096 || entriesEnd + 4 > bytes.length) return undefined
    let width: number | undefined
    let height: number | undefined
    for (let index = 0; index < count; index += 1) {
      const offset = ifd + 2 + index * 12
      const tag = read16(offset)
      const type = read16(offset + 2)
      const values = read32(offset + 4)
      if ((tag === 256 || tag === 257) && values === 1 && (type === 3 || type === 4)) {
        const value = type === 3 ? read16(offset + 8) : read32(offset + 8)
        if (tag === 256) width = value
        else height = value
      }
    }
    if (!width || !height) return undefined
    pixels.push(width * height)
    maxWidth = Math.max(maxWidth, width)
    maxHeight = Math.max(maxHeight, height)
    ifd = read32(entriesEnd)
  }
  return pixels.length > 0 ? { format: 'tiff', width: maxWidth, height: maxHeight, frameCount: pixels.length, pixelCounts: pixels } : undefined
}

function iconProbe(bytes: Uint8Array): StructuralProbe | undefined {
  if (bytes.length < 22 || bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 1 || bytes[3] !== 0) return undefined
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = buffer.readUInt16LE(4)
  if (count < 1 || count > 256 || 6 + count * 16 > bytes.length) return undefined
  const pixels: number[] = []
  const icoRepresentations: ProbedIcoRepresentation[] = []
  const seenRepresentations = new Set<string>()
  const payloadRanges: Array<{ start: number; end: number }> = []
  let width = 0
  let height = 0
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16
    const entryWidth = bytes[entry] || 256
    const entryHeight = bytes[entry + 1] || 256
    const colorCount = bytes[entry + 2]!
    const reserved = bytes[entry + 3]!
    const planes = buffer.readUInt16LE(entry + 4)
    const bitCount = buffer.readUInt16LE(entry + 6)
    const size = buffer.readUInt32LE(entry + 8)
    const offset = buffer.readUInt32LE(entry + 12)
    const end = offset + size
    if (reserved !== 0 || size < 12 || offset < 6 + count * 16 || end > bytes.length || end < offset) return undefined
    if (payloadRanges.some((range) => offset < range.end && end > range.start)) return undefined
    payloadRanges.push({ start: offset, end })
    const payload = bytes.subarray(offset, offset + size)
    const png = pngProbe(payload)
    if (png) {
      if (!((planes === 1 && bitCount === 32) || (planes === 0 && bitCount === 0)) || colorCount !== 0) return undefined
      if (png.width !== entryWidth || png.height !== entryHeight) return undefined
    } else {
      if (planes !== 1 || ![1, 4, 8, 24, 32].includes(bitCount)) return undefined
      const approvedColorCount = bitCount === 1 ? [0, 2] : bitCount === 4 ? [0, 16] : [0]
      if (!approvedColorCount.includes(colorCount)) return undefined
      if (size < 40) return undefined
      const headerSize = buffer.readUInt32LE(offset)
      if (![40, 108, 124].includes(headerSize) || headerSize > size) return undefined
      const dibWidth = buffer.readInt32LE(offset + 4)
      const dibHeight = buffer.readInt32LE(offset + 8)
      const dibPlanes = buffer.readUInt16LE(offset + 12)
      const dibBitCount = buffer.readUInt16LE(offset + 14)
      const compression = buffer.readUInt32LE(offset + 16)
      const imageSize = buffer.readUInt32LE(offset + 20)
      const colorsUsed = buffer.readUInt32LE(offset + 32)
      const supportedCompression = compression === 0
      if (
        dibWidth <= 0
        || dibHeight <= 0
        || dibWidth !== entryWidth
        || dibHeight !== entryHeight * 2
        || dibPlanes !== 1
        || dibBitCount !== bitCount
        || !supportedCompression
      ) return undefined
      const maximumPaletteEntries = bitCount <= 8 ? 2 ** bitCount : 0
      if (colorsUsed > maximumPaletteEntries || (bitCount > 8 && colorsUsed !== 0)) return undefined
      const paletteEntries = bitCount <= 8 ? (colorsUsed || maximumPaletteEntries) : 0
      const xorStride = Math.ceil((entryWidth * bitCount) / 32) * 4
      const maskStride = Math.ceil(entryWidth / 32) * 4
      const xorBytes = xorStride * entryHeight
      const maskBytes = maskStride * entryHeight
      if (imageSize !== 0 && imageSize !== xorBytes) return undefined
      const requiredSize = headerSize + paletteEntries * 4 + xorBytes + maskBytes
      if (requiredSize !== size) return undefined
    }
    const payloadSha256 = createHash('sha256').update(payload).digest('hex')
    const representationKey = `${entryWidth}x${entryHeight}:${payloadSha256}`
    if (!seenRepresentations.has(representationKey)) {
      seenRepresentations.add(representationKey)
      width = Math.max(width, entryWidth)
      height = Math.max(height, entryHeight)
      pixels.push(entryWidth * entryHeight)
      icoRepresentations.push({ sourceIndex: index + 1, width: entryWidth, height: entryHeight, payloadSha256 })
    }
  }
  return {
    format: 'ico', width, height, frameCount: icoRepresentations.length,
    pixelCounts: pixels, icoRepresentations,
  }
}

function icnsProbe(bytes: Uint8Array): StructuralProbe | undefined {
  if (ascii(bytes.subarray(0, 4)) !== 'icns' || bytes.length < 16) return undefined
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.readUInt32BE(4) !== bytes.length) return undefined
  const slots = new Map<string, ProbedIcnsSlot>([
    ['icp4', { type: 'icp4', logicalSize: 16, scale: 1, pixelSize: 16 }],
    ['ic11', { type: 'ic11', logicalSize: 16, scale: 2, pixelSize: 32 }],
    ['icp5', { type: 'icp5', logicalSize: 32, scale: 1, pixelSize: 32 }],
    ['ic12', { type: 'ic12', logicalSize: 32, scale: 2, pixelSize: 64 }],
    ['icp6', { type: 'icp6', logicalSize: 64, scale: 1, pixelSize: 64 }],
    ['ic07', { type: 'ic07', logicalSize: 128, scale: 1, pixelSize: 128 }],
    ['ic13', { type: 'ic13', logicalSize: 128, scale: 2, pixelSize: 256 }],
    ['ic08', { type: 'ic08', logicalSize: 256, scale: 1, pixelSize: 256 }],
    ['ic14', { type: 'ic14', logicalSize: 256, scale: 2, pixelSize: 512 }],
    ['ic09', { type: 'ic09', logicalSize: 512, scale: 1, pixelSize: 512 }],
    ['ic10', { type: 'ic10', logicalSize: 512, scale: 2, pixelSize: 1024 }],
  ])
  const pixels: number[] = []
  const iconSlots: ProbedIcnsSlot[] = []
  const seenTypes = new Set<string>()
  let offset = 8
  let largest = 0
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes.subarray(offset, offset + 4))
    const length = buffer.readUInt32BE(offset + 4)
    if (length < 8 || offset + length > bytes.length) return undefined
    const slot = slots.get(type)
    if (slot) {
      if (seenTypes.has(type)) return undefined
      seenTypes.add(type)
      const png = pngProbe(bytes.subarray(offset + 8, offset + length))
      if (!png || png.width !== slot.pixelSize || png.height !== slot.pixelSize) return undefined
      largest = Math.max(largest, slot.pixelSize)
      pixels.push(slot.pixelSize * slot.pixelSize)
      iconSlots.push(slot)
    }
    offset += length
  }
  return offset === bytes.length && pixels.length > 0
    ? { format: 'icns', width: largest, height: largest, frameCount: pixels.length, pixelCounts: pixels, iconSlots }
    : undefined
}

function mp3Probe(bytes: Uint8Array): StructuralProbe | undefined {
  let offset = 0
  if (ascii(bytes.subarray(0, 3)) === 'ID3') {
    if (bytes.length < 10 || bytes.subarray(6, 10).some((value) => value >= 0x80)) return undefined
    offset = 10 + (bytes[6]! << 21) + (bytes[7]! << 14) + (bytes[8]! << 7) + bytes[9]!
  }
  let frames = 0
  const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
  const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const baseSampleRates = [44_100, 48_000, 32_000]
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xe6) !== 0xe2) return undefined
    const version = (bytes[offset + 1]! >>> 3) & 0x03
    if (version === 1) return undefined
    const bitrate = (version === 3 ? mpeg1Bitrates : mpeg2Bitrates)[bytes[offset + 2]! >>> 4]
    const baseSampleRate = baseSampleRates[(bytes[offset + 2]! >>> 2) & 0x03]
    const sampleRate = baseSampleRate === undefined ? undefined : baseSampleRate / (version === 3 ? 1 : version === 2 ? 2 : 4)
    if (!bitrate || !sampleRate) return undefined
    const length = Math.floor(((version === 3 ? 144_000 : 72_000) * bitrate) / sampleRate) + ((bytes[offset + 2]! >>> 1) & 1)
    if (length < 4 || offset + length > bytes.length) return undefined
    offset += length
    frames += 1
  }
  return frames > 0 ? { format: 'mp3', frameCount: 1 } : undefined
}

function readEbmlVint(bytes: Uint8Array, offset: number, maskMarker: boolean): { length: number; value: number } | undefined {
  const first = bytes[offset]
  if (!first) return undefined
  let marker = 0x80
  let length = 1
  while ((first & marker) === 0) { marker >>>= 1; length += 1 }
  if (length > 8 || offset + length > bytes.length) return undefined
  let value = maskMarker ? first & (marker - 1) : first
  for (let index = 1; index < length; index += 1) value = value * 256 + bytes[offset + index]!
  return Number.isSafeInteger(value) ? { length, value } : undefined
}

interface EbmlElement { id: number; dataOffset: number; end: number }

function ebmlElements(bytes: Uint8Array, start: number, end: number): EbmlElement[] | undefined {
  const elements: EbmlElement[] = []
  let offset = start
  while (offset < end) {
    if (elements.length >= 10_000) return undefined
    const id = readEbmlVint(bytes, offset, false)
    if (!id) return undefined
    offset += id.length
    const size = readEbmlVint(bytes, offset, true)
    if (!size || size.value === 2 ** (7 * size.length) - 1) return undefined
    offset += size.length
    const elementEnd = offset + size.value
    if (elementEnd > end) return undefined
    elements.push({ id: id.value, dataOffset: offset, end: elementEnd })
    offset = elementEnd
  }
  return offset === end ? elements : undefined
}

function positiveEbmlInteger(bytes: Uint8Array, element: EbmlElement | undefined): number | bigint | undefined {
  if (!element || element.end <= element.dataOffset || element.end - element.dataOffset > 8) return undefined
  let value = 0n
  for (const byte of bytes.subarray(element.dataOffset, element.end)) value = value * 256n + BigInt(byte)
  if (value === 0n) return undefined
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value
}

function ebmlProbe(bytes: Uint8Array): StructuralProbe | undefined {
  if (!Buffer.from(bytes.subarray(0, 4)).equals(Buffer.from('1a45dfa3', 'hex'))) return undefined
  const headerSize = readEbmlVint(bytes, 4, true)
  if (!headerSize) return undefined
  let offset = 4 + headerSize.length
  const headerEnd = offset + headerSize.value
  if (headerEnd > bytes.length) return undefined
  let docType: string | undefined
  let docTypeCount = 0
  while (offset < headerEnd) {
    const id = readEbmlVint(bytes, offset, false)
    if (!id) return undefined
    offset += id.length
    const size = readEbmlVint(bytes, offset, true)
    if (!size) return undefined
    offset += size.length
    if (offset + size.value > headerEnd) return undefined
    if (id.value === 0x4282) {
      docTypeCount += 1
      docType = ascii(bytes.subarray(offset, offset + size.value))
    }
    offset += size.value
  }
  if (offset !== headerEnd || docTypeCount !== 1 || (docType !== 'webm' && docType !== 'matroska')) return undefined
  const segmentId = readEbmlVint(bytes, offset, false)
  if (!segmentId || segmentId.value !== 0x18538067) return undefined
  offset += segmentId.length
  const segmentSize = readEbmlVint(bytes, offset, true)
  if (!segmentSize || segmentSize.value === 2 ** (7 * segmentSize.length) - 1) return undefined
  offset += segmentSize.length
  if (offset + segmentSize.value !== bytes.length) return undefined
  const segment = ebmlElements(bytes, offset, bytes.length)
  const info = segment?.find(({ id }) => id === 0x1549a966)
  const tracks = segment?.find(({ id }) => id === 0x1654ae6b)
  if (!info || !tracks) return undefined
  const infoChildren = ebmlElements(bytes, info.dataOffset, info.end)
  if (
    !infoChildren?.some(({ id, dataOffset, end }) => id === 0x4d80 && end > dataOffset)
    || !infoChildren.some(({ id, dataOffset, end }) => id === 0x5741 && end > dataOffset)
  ) return undefined
  const trackEntries = ebmlElements(bytes, tracks.dataOffset, tracks.end)?.filter(({ id }) => id === 0xae)
  if (!trackEntries?.length) return undefined
  for (const entry of trackEntries) {
    const fields = ebmlElements(bytes, entry.dataOffset, entry.end)
    if (!fields) return undefined
    const number = positiveEbmlInteger(bytes, fields.find(({ id }) => id === 0xd7))
    const uid = positiveEbmlInteger(bytes, fields.find(({ id }) => id === 0x73c5))
    const type = positiveEbmlInteger(bytes, fields.find(({ id }) => id === 0x83))
    const codecElement = fields.find(({ id }) => id === 0x86)
    const codec = codecElement ? ascii(bytes.subarray(codecElement.dataOffset, codecElement.end)) : ''
    if (!number || !uid || (type !== 1 && type !== 2) || !/^[A-Z]_[A-Za-z0-9_.-]{1,62}$/.test(codec)) return undefined
    if ((type === 1 && !codec.startsWith('V_')) || (type === 2 && !codec.startsWith('A_'))) return undefined
  }
  return { format: docType === 'webm' ? 'webm' : 'mkv', frameCount: 1 }
}

function cfbProbe(bytes: Uint8Array): StructuralProbe | undefined {
  if (!Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')) || bytes.length < 1536) return undefined
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.readUInt16LE(28) !== 0xfffe) return undefined
  const sectorShift = buffer.readUInt16LE(30)
  if (sectorShift !== 9 && sectorShift !== 12) return undefined
  const sectorSize = 1 << sectorShift
  if ((bytes.length - 512) % sectorSize !== 0) return undefined
  const sectorCount = (bytes.length - 512) / sectorSize
  const fatCount = buffer.readUInt32LE(44)
  const directorySector = buffer.readUInt32LE(48)
  if (fatCount < 1 || fatCount > 109 || directorySector >= sectorCount) return undefined
  const fatEntries: number[] = []
  for (let index = 0; index < fatCount; index += 1) {
    const sector = buffer.readUInt32LE(76 + index * 4)
    if (sector >= sectorCount) return undefined
    const start = 512 + sector * sectorSize
    for (let offset = start; offset < start + sectorSize; offset += 4) fatEntries.push(buffer.readUInt32LE(offset))
  }
  const names = new Set<string>()
  let sector = directorySector
  const seen = new Set<number>()
  while (sector !== 0xfffffffe) {
    if (sector >= sectorCount || seen.has(sector) || seen.size > sectorCount) return undefined
    seen.add(sector)
    const start = 512 + sector * sectorSize
    for (let offset = start; offset + 128 <= start + sectorSize; offset += 128) {
      const nameLength = buffer.readUInt16LE(offset + 64)
      const type = bytes[offset + 66]
      if (type === 2 && nameLength >= 2 && nameLength <= 64 && nameLength % 2 === 0) {
        names.add(Buffer.from(bytes.subarray(offset, offset + nameLength - 2)).toString('utf16le'))
      }
    }
    sector = fatEntries[sector] ?? 0xffffffff
  }
  if (names.has('WordDocument')) return { format: 'doc', frameCount: 1 }
  if (names.has('Workbook')) return { format: 'xls', frameCount: 1 }
  if (names.has('PowerPoint Document')) return { format: 'ppt', frameCount: 1 }
  return undefined
}

function structuralProbe(bytes: Uint8Array, declaredExtension: ConversionInputFormat | undefined): StructuralProbe | undefined {
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return pngProbe(bytes)
  if (ascii(bytes.subarray(0, 6)) === 'GIF87a' || ascii(bytes.subarray(0, 6)) === 'GIF89a') return gifProbe(bytes)
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegProbe(bytes)
  if (ascii(bytes.subarray(0, 4)) === 'RIFF') {
    return ascii(bytes.subarray(8, 12)) === 'WEBP' ? webpProbe(bytes) : riffProbe(bytes)
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return zipProbe(bytes)
  if (ascii(bytes.subarray(0, 5)) === '%PDF-') return pdfProbe(bytes)
  if (ascii(bytes.subarray(0, 4)) === 'OggS') return oggProbe(bytes)
  if (ascii(bytes.subarray(4, 8)) === 'ftyp') return isoProbe(bytes)
  if (ascii(bytes.subarray(0, 4)) === 'fLaC' || (bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0)) return simpleBinaryProbe(bytes)
  if (ascii(bytes.subarray(0, 2)) === 'BM') return bmpProbe(bytes)
  if (ascii(bytes.subarray(0, 2)) === 'II' || ascii(bytes.subarray(0, 2)) === 'MM') return tiffProbe(bytes)
  if (bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || bytes[2] === 2) && bytes[3] === 0) return iconProbe(bytes)
  if (ascii(bytes.subarray(0, 4)) === 'icns') return icnsProbe(bytes)
  if (ascii(bytes.subarray(0, 3)) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe6) === 0xe2)) return mp3Probe(bytes)
  if (Buffer.from(bytes.subarray(0, 4)).equals(Buffer.from('1a45dfa3', 'hex'))) return ebmlProbe(bytes)
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) return cfbProbe(bytes)
  const media = detectMediaType(bytes)
  if (media?.extension === 'svg' && isSafeSvg(bytes)) {
    const text = Buffer.from(bytes).toString('utf8')
    const width = /\bwidth\s*=\s*["']\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1]
    const height = /\bheight\s*=\s*["']\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1]
    const viewBox = /\bviewBox\s*=\s*["']\s*[-+\d.]+[\s,]+[-+\d.]+[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(text)
    const parsedWidth = width ? Math.ceil(Number(width)) : viewBox ? Math.ceil(Number(viewBox[1])) : undefined
    const parsedHeight = height ? Math.ceil(Number(height)) : viewBox ? Math.ceil(Number(viewBox[2])) : undefined
    if (parsedWidth && parsedHeight) return { format: 'svg', width: parsedWidth, height: parsedHeight, frameCount: 1, pixelCounts: [parsedWidth * parsedHeight] }
  }
  return textProbe(bytes, declaredExtension)
}

function kindFor(format: ConversionInputFormat): ConversionInputKind {
  if (imageFormats.has(format)) return 'image'
  if (audioFormats.has(format)) return 'audio'
  if (videoFormats.has(format)) return 'video'
  return 'file'
}

function byteLimit(kind: ConversionInputKind): number {
  if (kind === 'image') return CONVERSION_LIMITS.imageBytes
  if (kind === 'audio') return CONVERSION_LIMITS.audioBytes
  if (kind === 'video') return CONVERSION_LIMITS.videoBytes
  return CONVERSION_LIMITS.fileBytes
}

export function assertAttachmentBatchLimits(inputs: readonly Pick<ProbedConversionInput, 'kind' | 'byteSize'>[]): void {
  if (inputs.length === 0 || inputs.length > CONVERSION_LIMITS.attachments) throw failure('CONVERSION_INPUT_INVALID')
  let total = 0
  for (const input of inputs) {
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0 || input.byteSize > byteLimit(input.kind)) {
      throw failure('CONVERSION_INPUT_INVALID')
    }
    total += input.byteSize
    if (total > CONVERSION_LIMITS.requestBytes) throw failure('CONVERSION_INPUT_INVALID')
  }
}

export function probeConversionInput(input: {
  bytes: Uint8Array
  displayName: string
  mimeType: string
  byteSize?: number
}): ProbedConversionInput {
  const byteSize = input.byteSize ?? input.bytes.byteLength
  if (!Number.isSafeInteger(byteSize) || byteSize < input.bytes.byteLength || byteSize < 1) throw failure('CONVERSION_INPUT_INVALID')
  const declaredExtension = extensionOf(input.displayName)
  const structure = structuralProbe(input.bytes, declaredExtension)
  if (!structure) throw failure('CONVERSION_INPUT_INVALID')
  const { format } = structure
  const declaredMime = mimeFormats[input.mimeType.toLowerCase()]
  if (declaredExtension !== format || (declaredMime !== undefined && declaredMime !== format)) {
    throw failure('CONVERSION_INPUT_INVALID')
  }
  if (format === 'svg' && !isSafeSvg(input.bytes)) throw failure('CONVERSION_INPUT_INVALID')
  const kind = kindFor(format)
  if (byteSize > byteLimit(kind)) throw failure('CONVERSION_INPUT_INVALID')
  const pixelCounts = structure.pixelCounts ?? []
  if (imageFormats.has(format) && pixelCounts.length !== structure.frameCount) throw failure('CONVERSION_INPUT_INVALID')
  if (pixelCounts.some((pixels) => !Number.isSafeInteger(pixels) || pixels <= 0 || pixels > CONVERSION_LIMITS.pixelsPerFrame)) {
    throw failure('CONVERSION_INPUT_INVALID')
  }
  if (pixelCounts.reduce((total, pixels) => total + pixels, 0) > CONVERSION_LIMITS.totalPixels) throw failure('CONVERSION_INPUT_INVALID')
  const pageCount = structure.pageCount
  if (pageCount !== undefined && (pageCount < 1 || pageCount > CONVERSION_LIMITS.pdfPages)) {
    throw failure('CONVERSION_INPUT_INVALID')
  }
  return {
    format,
    mimeType: canonicalMime[format],
    kind,
    byteSize,
    ...(structure.width === undefined ? {} : { width: structure.width }),
    ...(structure.height === undefined ? {} : { height: structure.height }),
    frameCount: structure.frameCount,
    ...(pageCount === undefined ? {} : { pageCount }),
    ...(structure.iconSlots === undefined ? {} : { iconSlots: structure.iconSlots }),
    ...(structure.icoRepresentations === undefined ? {} : { icoRepresentations: structure.icoRepresentations }),
  }
}

const staticImages = new Set<ConversionInputFormat>(['png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp'])
const staticTargets = new Set<ConversionTargetFormat>(['png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp'])
const pdfImageSources = new Set<ConversionInputFormat>([...staticImages, 'gif'])
const iconSources = new Set<ConversionInputFormat>(['png', 'jpeg', 'webp', 'avif', 'svg'])
const documents = new Set<ConversionInputFormat>(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'csv', 'html', 'markdown', 'txt'])
const audioTargets = new Set<ConversionTargetFormat>(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'])
const videoTargets = new Set<ConversionTargetFormat>(['mp4', 'webm', 'mov', 'gif'])

export function resolveConversionRoute(input: ProbedConversionInput, targetFormat: ConversionTargetFormat): ConversionRoute {
  const sourceFormat = input.format
  const allowed = (
    (staticImages.has(sourceFormat) && staticTargets.has(targetFormat))
    || ((sourceFormat === 'gif' || (sourceFormat === 'webp' && input.frameCount > 1))
      && (targetFormat === 'gif' || targetFormat === 'mp4' || staticTargets.has(targetFormat)))
    || (pdfImageSources.has(sourceFormat) && targetFormat === 'pdf')
    || (sourceFormat === 'svg' && ['png', 'jpeg', 'webp', 'pdf'].includes(targetFormat))
    || ((sourceFormat === 'ico' || sourceFormat === 'icns') && staticTargets.has(targetFormat))
    || (iconSources.has(sourceFormat) && (targetFormat === 'ico' || targetFormat === 'icns'))
    || (documents.has(sourceFormat) && targetFormat === 'pdf')
    || (sourceFormat === 'csv' && targetFormat === 'xlsx')
    || (sourceFormat === 'pdf' && (targetFormat === 'png' || targetFormat === 'jpeg'))
    || (audioFormats.has(sourceFormat) && audioTargets.has(targetFormat))
    || (videoFormats.has(sourceFormat) && (videoTargets.has(targetFormat) || audioTargets.has(targetFormat)))
  )
  if (!allowed) throw failure('CONVERSION_FORMAT_UNSUPPORTED')
  const animatedToStatic = input.frameCount > 1 && (staticTargets.has(targetFormat) || targetFormat === 'pdf')
  const iconGeometry = (targetFormat === 'ico' || targetFormat === 'icns')
    && input.width !== undefined && input.height !== undefined && input.width !== input.height
    ? { fit: 'contain' as const, canvas: 'square' as const, crop: false as const, transparentPadding: true as const }
    : undefined
  return {
    sourceFormat,
    targetFormat,
    ...(animatedToStatic ? { frameSelection: 'first' as const } : {}),
    ...(iconGeometry ? { iconGeometry } : {}),
  }
}

export function expectedMimeType(format: ConversionTargetFormat): string {
  return canonicalMime[format]
}
