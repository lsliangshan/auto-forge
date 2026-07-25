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
  if (bytes.byteLength < 12 || ascii(bytes, 4, 4) !== 'ftyp') return undefined
  const boxSize = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readUInt32BE(0)
  const boundedSize = Math.min(bytes.byteLength, boxSize >= 12 ? boxSize : bytes.byteLength)
  const brands = new Set<string>()
  brands.add(ascii(bytes, 8, 4))
  for (let offset = 16; offset + 4 <= boundedSize; offset += 4) brands.add(ascii(bytes, offset, 4))

  if (brands.has('avif') || brands.has('avis')) return detected('image', 'image/avif', 'avif')
  if (brands.has('M4A ') || brands.has('M4B ')) return detected('audio', 'audio/mp4', 'm4a')
  if (brands.has('qt  ')) return detected('video', 'video/quicktime', 'mov')
  if ([...brands].some((brand) => (
    brand === 'isom'
    || brand === 'iso2'
    || brand === 'mp41'
    || brand === 'mp42'
    || brand === 'avc1'
    || brand.startsWith('3g')
  ))) return detected('video', 'video/mp4', 'mp4')
  return undefined
}

function detectSvg(bytes: Uint8Array): DetectedMedia | undefined {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
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
  return /^<svg(?:\s|>)/i.test(text)
    ? detected('image', 'image/svg+xml', 'svg', false)
    : undefined
}

function isMp3Frame(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) return false
  const version = (bytes[1]! >> 3) & 0x03
  const layer = (bytes[1]! >> 1) & 0x03
  const bitrate = (bytes[2]! >> 4) & 0x0f
  const sampleRate = (bytes[2]! >> 2) & 0x03
  return version !== 0x01 && layer !== 0 && bitrate !== 0 && bitrate !== 0x0f && sampleRate !== 0x03
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

  const isoMedia = detectIsoMedia(bytes)
  if (isoMedia) return isoMedia

  if (ascii(bytes, 0, 3) === 'ID3' || isMp3Frame(bytes)) return detected('audio', 'audio/mpeg', 'mp3')
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    return detected('audio', 'audio/wav', 'wav')
  }
  if (ascii(bytes, 0, 4) === 'OggS') return detected('audio', 'audio/ogg', 'ogg')
  if (ascii(bytes, 0, 4) === 'fLaC') return detected('audio', 'audio/flac', 'flac')

  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return detected('video', 'video/webm', 'webm')

  return detectSvg(bytes)
}
