export interface DetectedMedia {
  kind: 'image' | 'audio' | 'video'
  mimeType: string
  extension: string
  inlineSafe: boolean
  width?: number
  height?: number
}

const MAX_SNIFF_BYTES = 64 * 1024

function detected(
  kind: DetectedMedia['kind'],
  mimeType: string,
  extension: string,
  inlineSafe = true,
): DetectedMedia {
  return { kind, mimeType, extension, inlineSafe }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset + offset, Math.min(length, bytes.byteLength - offset)).toString('ascii')
}

function detectIsoMedia(bytes: Uint8Array): DetectedMedia | undefined {
  if (bytes.byteLength < 16 || ascii(bytes, 4, 4) !== 'ftyp') return undefined
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size32 = buffer.readUInt32BE(0)
  let headerBytes = 8
  let boxSize = size32
  if (size32 === 1) {
    if (bytes.byteLength < 24) return undefined
    const size64 = buffer.readBigUInt64BE(8)
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
    boxSize = Number(size64)
    headerBytes = 16
  } else if (size32 === 0) {
    return undefined
  }
  if (boxSize < headerBytes + 8 || boxSize > bytes.byteLength || (boxSize - headerBytes) % 4 !== 0) {
    return undefined
  }
  const brands = new Set<string>([ascii(bytes, headerBytes, 4)])
  for (let offset = headerBytes + 8; offset + 4 <= boxSize; offset += 4) {
    brands.add(ascii(bytes, offset, 4))
  }

  const specificFormats = new Set<string>()
  if (brands.has('avif') || brands.has('avis')) specificFormats.add('avif')
  if (brands.has('M4A ') || brands.has('M4B ')) specificFormats.add('m4a')
  if (brands.has('qt  ')) specificFormats.add('quicktime')
  if (specificFormats.size > 1) return undefined
  const [specificFormat] = specificFormats
  if (specificFormat === 'avif') return detected('image', 'image/avif', 'avif')
  if (specificFormat === 'm4a') return detected('audio', 'audio/mp4', 'm4a')
  if (specificFormat === 'quicktime') return detected('video', 'video/quicktime', 'mov')

  const genericMp4 = [...brands].some((brand) => (
    brand === 'isom'
    || brand === 'iso2'
    || brand === 'mp41'
    || brand === 'mp42'
    || brand === 'avc1'
    || brand.startsWith('3g')
  ))
  return genericMp4 ? detected('video', 'video/mp4', 'mp4') : undefined
}

export function isSafeSvg(bytes: Uint8Array): boolean {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  text = text.replace(/^\uFEFF/, '')
  let previous: string
  do {
    previous = text
    text = text
      .replace(/^\s+/, '')
      .replace(/^<\?xml(?:\s[^?]*)?\?>/i, '')
      .replace(/^<!--[\s\S]*?-->/, '')
  } while (text !== previous)
  if (!/^<svg(?:\s|>)/i.test(text)) return false
  const hasExternalAttribute = [...text.matchAll(/\b(?:href|src)\s*=\s*["']([^"']*)["']/gi)]
    .some((match) => !/^(?:#|data:)/i.test(match[1]!.trim()))
  const hasExternalCssUrl = [...text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)]
    .some((match) => !/^(?:#|data:)/i.test(match[1]!.trim()))
  return !(
    /<!DOCTYPE\b|<!ENTITY\b|<script\b|<foreignObject\b/i.test(text)
    || /\son[a-z]+\s*=/i.test(text)
    || /@import\b/i.test(text)
    || hasExternalAttribute
    || hasExternalCssUrl
  )
}

function detectSvg(bytes: Uint8Array): DetectedMedia | undefined {
  return isSafeSvg(bytes) ? detected('image', 'image/svg+xml', 'svg', false) : undefined
}

function isMp3Frame(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) return false
  const version = (bytes[1]! >> 3) & 0x03
  const layer = (bytes[1]! >> 1) & 0x03
  const bitrate = (bytes[2]! >> 4) & 0x0f
  const sampleRate = (bytes[2]! >> 2) & 0x03
  return version !== 0x01 && layer !== 0 && bitrate !== 0 && bitrate !== 0x0f && sampleRate !== 0x03
}

function isId3Header(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 10 || ascii(bytes, 0, 3) !== 'ID3') return false
  const version = bytes[3]!
  if (version < 2 || version > 4 || bytes[4] === 0xff) return false
  const allowedFlags = version === 2 ? 0xc0 : version === 3 ? 0xe0 : 0xf0
  if ((bytes[5]! & ~allowedFlags) !== 0) return false
  return bytes.subarray(6, 10).every((value) => value < 0x80)
}

function isSupportedOggAudio(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength < 28
    || ascii(bytes, 0, 4) !== 'OggS'
    || bytes[4] !== 0
    || (bytes[5]! & ~0x07) !== 0
  ) return false
  const segmentCount = bytes[26]!
  if (segmentCount === 0 || 27 + segmentCount > bytes.byteLength) return false
  let pageBodyBytes = 0
  let firstPacketBytes = 0
  let firstPacketComplete = false
  for (let index = 0; index < segmentCount; index += 1) {
    const length = bytes[27 + index]!
    pageBodyBytes += length
    if (!firstPacketComplete) {
      firstPacketBytes += length
      firstPacketComplete = length < 255
    }
  }
  const bodyOffset = 27 + segmentCount
  if (!firstPacketComplete || bodyOffset + pageBodyBytes > bytes.byteLength) return false
  const packet = bytes.subarray(bodyOffset, bodyOffset + firstPacketBytes)
  return (
    ascii(packet, 0, 8) === 'OpusHead'
    || (packet[0] === 0x01 && ascii(packet, 1, 6) === 'vorbis')
    || (packet[0] === 0x7f && ascii(packet, 1, 4) === 'FLAC')
    || ascii(packet, 0, 8) === 'Speex   '
  )
}

interface Vint {
  length: number
  value: number
}

function readVint(bytes: Uint8Array, offset: number, maximumLength: number): Vint | undefined {
  const first = bytes[offset]
  if (first === undefined || first === 0) return undefined
  let marker = 0x80
  let length = 1
  while ((first & marker) === 0) {
    marker >>= 1
    length += 1
  }
  if (length > maximumLength || offset + length > bytes.byteLength) return undefined
  let value = first & (marker - 1)
  let allOnes = value === marker - 1
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[offset + index]!
    value = value * 256 + byte
    allOnes = allOnes && byte === 0xff
    if (!Number.isSafeInteger(value)) return undefined
  }
  return allOnes ? undefined : { length, value }
}

function isWebm(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return false
  const headerSize = readVint(bytes, 4, 8)
  if (!headerSize) return false
  let offset = 4 + headerSize.length
  const end = offset + headerSize.value
  if (end > bytes.byteLength) return false
  let docType: string | undefined
  while (offset < end) {
    const idStart = offset
    const id = readVint(bytes, offset, 4)
    if (!id) return false
    offset += id.length
    const size = readVint(bytes, offset, 8)
    if (!size) return false
    offset += size.length
    const elementEnd = offset + size.value
    if (elementEnd > end) return false
    if (id.length === 2 && bytes[idStart] === 0x42 && bytes[idStart + 1] === 0x82) {
      if (docType !== undefined) return false
      docType = ascii(bytes, offset, size.value)
    }
    offset = elementEnd
  }
  return offset === end && docType === 'webm'
}

export function detectMediaType(prefix: Uint8Array): DetectedMedia | undefined {
  const bytes = prefix.subarray(0, MAX_SNIFF_BYTES)
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return detected('image', 'image/png', 'png')
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return detected('image', 'image/jpeg', 'jpg')
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return detected('image', 'image/webp', 'webp')
  }
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') {
    return detected('image', 'image/gif', 'gif')
  }
  if (
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00])
    || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  ) return detected('image', 'image/tiff', 'tiff', false)
  if (ascii(bytes, 0, 2) === 'BM') return detected('image', 'image/bmp', 'bmp', false)
  if (
    bytes.byteLength >= 6
    && bytes[0] === 0
    && bytes[1] === 0
    && (bytes[2] === 1 || bytes[2] === 2)
    && bytes[3] === 0
  ) return detected('image', 'image/vnd.microsoft.icon', 'ico', false)
  if (ascii(bytes, 0, 4) === 'icns') return detected('image', 'image/icns', 'icns', false)

  const isoMedia = detectIsoMedia(bytes)
  if (isoMedia) return isoMedia

  if (isId3Header(bytes) || isMp3Frame(bytes)) return detected('audio', 'audio/mpeg', 'mp3')
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    return detected('audio', 'audio/wav', 'wav')
  }
  if (isSupportedOggAudio(bytes)) return detected('audio', 'audio/ogg', 'ogg')
  if (ascii(bytes, 0, 4) === 'fLaC') return detected('audio', 'audio/flac', 'flac')

  if (isWebm(bytes)) return detected('video', 'video/webm', 'webm')

  return detectSvg(bytes)
}
