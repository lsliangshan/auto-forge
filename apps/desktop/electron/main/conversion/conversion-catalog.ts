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

export interface ProbedConversionInput {
  format: ConversionInputFormat
  mimeType: string
  kind: ConversionInputKind
  byteSize: number
  width?: number
  height?: number
  frameCount: number
  pageCount?: number
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

function imageDimensions(format: ConversionInputFormat, bytes: Uint8Array): { width?: number; height?: number; frameCount: number } {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (format === 'png' && bytes.byteLength >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), frameCount: 1 }
  }
  if (format === 'gif' && bytes.byteLength >= 10) {
    let frameCount = 0
    for (const byte of bytes.subarray(13)) if (byte === 0x2c) frameCount += 1
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), frameCount: Math.max(1, frameCount) }
  }
  if (format === 'bmp' && bytes.byteLength >= 26) {
    return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)), frameCount: 1 }
  }
  if (format === 'ico' && bytes.byteLength >= 6) {
    const count = buffer.readUInt16LE(4)
    let width = 0
    let height = 0
    for (let index = 0; index < count && 6 + index * 16 + 1 < bytes.byteLength; index += 1) {
      width = Math.max(width, bytes[6 + index * 16] || 256)
      height = Math.max(height, bytes[7 + index * 16] || 256)
    }
    return { width, height, frameCount: Math.max(1, count) }
  }
  if (format === 'svg') {
    const text = Buffer.from(bytes).toString('utf8')
    const width = /\bwidth\s*=\s*["']\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1]
    const height = /\bheight\s*=\s*["']\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1]
    const viewBox = /\bviewBox\s*=\s*["']\s*[-+\d.]+[\s,]+[-+\d.]+[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(text)
    return {
      width: width ? Math.ceil(Number(width)) : viewBox ? Math.ceil(Number(viewBox[1])) : undefined,
      height: height ? Math.ceil(Number(height)) : viewBox ? Math.ceil(Number(viewBox[2])) : undefined,
      frameCount: 1,
    }
  }
  if (format === 'jpeg') {
    let offset = 2
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) { offset += 1; continue }
      const marker = bytes[offset + 1]!
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue }
      const length = buffer.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > bytes.byteLength) break
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), frameCount: 1 }
      }
      offset += 2 + length
    }
  }
  if (format === 'webp' && bytes.byteLength >= 30 && ascii(bytes.subarray(12, 16)) === 'VP8X') {
    const width = 1 + bytes[24]! + bytes[25]! * 256 + bytes[26]! * 65_536
    const height = 1 + bytes[27]! + bytes[28]! * 256 + bytes[29]! * 65_536
    const matches = ascii(bytes).match(/ANMF/g)
    return { width, height, frameCount: Math.max(1, matches?.length ?? 1) }
  }
  if (format === 'avif') {
    const marker = ascii(bytes).indexOf('ispe')
    if (marker >= 4 && marker + 16 <= bytes.byteLength) {
      return { width: buffer.readUInt32BE(marker + 8), height: buffer.readUInt32BE(marker + 12), frameCount: 1 }
    }
  }
  return { frameCount: 1 }
}

function detectDocumentFormat(bytes: Uint8Array, declaredExtension: ConversionInputFormat | undefined): ConversionInputFormat | undefined {
  const text = ascii(bytes)
  if (text.startsWith('%PDF-')) return 'pdf'
  if (/^\s*\{\\rtf[1-9]/.test(text)) return 'rtf'
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) {
    if (text.includes('WordDocument')) return 'doc'
    if (text.includes('Workbook')) return 'xls'
    if (text.includes('PowerPoint Document')) return 'ppt'
    return undefined
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if (text.includes('word/')) return 'docx'
    if (text.includes('xl/')) return 'xlsx'
    if (text.includes('ppt/')) return 'pptx'
    if (text.includes('application/vnd.oasis.opendocument.text')) return 'odt'
    if (text.includes('application/vnd.oasis.opendocument.spreadsheet')) return 'ods'
    if (text.includes('application/vnd.oasis.opendocument.presentation')) return 'odp'
    return undefined
  }
  let utf8: string
  try {
    utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    return undefined
  }
  if (/^\s*<!doctype\s+html\b|^\s*<html\b/i.test(utf8)) return 'html'
  if (declaredExtension === 'csv' && /[,;\t]/.test(utf8)) return 'csv'
  if (declaredExtension === 'markdown' || declaredExtension === 'txt' || declaredExtension === 'html') return declaredExtension
  return undefined
}

function detectedFormat(bytes: Uint8Array, declaredExtension: ConversionInputFormat | undefined): ConversionInputFormat | undefined {
  const media = detectMediaType(bytes)
  if (media) return media.extension === 'jpg' ? 'jpeg' : media.extension as ConversionInputFormat
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && (bytes[2] === 0x01 || bytes[2] === 0x02) && bytes[3] === 0x00) return 'ico'
  if (ascii(bytes.subarray(0, 4)) === 'icns') return 'icns'
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)) return 'tiff'
  if (ascii(bytes.subarray(0, 2)) === 'BM') return 'bmp'
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return 'aac'
  if (ascii(bytes.subarray(0, 4)) === 'RIFF' && ascii(bytes.subarray(8, 12)) === 'AVI ') return 'avi'
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 && ascii(bytes).includes('matroska')) return 'mkv'
  return detectDocumentFormat(bytes, declaredExtension)
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
  const format = detectedFormat(input.bytes, declaredExtension)
  if (!format) throw failure('CONVERSION_INPUT_INVALID')
  const declaredMime = mimeFormats[input.mimeType.toLowerCase()]
  if (declaredExtension !== format || (declaredMime !== undefined && declaredMime !== format)) {
    throw failure('CONVERSION_INPUT_INVALID')
  }
  if (format === 'svg' && !isSafeSvg(input.bytes)) throw failure('CONVERSION_INPUT_INVALID')
  const kind = kindFor(format)
  if (byteSize > byteLimit(kind)) throw failure('CONVERSION_INPUT_INVALID')
  const dimensions = imageDimensions(format, input.bytes)
  if (dimensions.width !== undefined && dimensions.height !== undefined) {
    const pixels = dimensions.width * dimensions.height
    if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > CONVERSION_LIMITS.pixelsPerFrame) {
      throw failure('CONVERSION_INPUT_INVALID')
    }
    if (pixels * dimensions.frameCount > CONVERSION_LIMITS.totalPixels) throw failure('CONVERSION_INPUT_INVALID')
  }
  const pageCount = format === 'pdf'
    ? (ascii(input.bytes).match(/\/Type\s*\/Page(?!s)\b/g)?.length ?? 0)
    : undefined
  if (pageCount !== undefined && (pageCount < 1 || pageCount > CONVERSION_LIMITS.pdfPages)) {
    throw failure('CONVERSION_INPUT_INVALID')
  }
  return {
    format,
    mimeType: canonicalMime[format],
    kind,
    byteSize,
    ...dimensions,
    ...(pageCount === undefined ? {} : { pageCount }),
  }
}

const staticImages = new Set<ConversionInputFormat>(['png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp'])
const staticTargets = new Set<ConversionTargetFormat>(['png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp'])
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
  const animatedToStatic = input.frameCount > 1 && staticTargets.has(targetFormat)
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
