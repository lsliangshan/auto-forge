import * as mammoth from 'mammoth/mammoth.browser.js'
import type { ParsedDocument, ParserLimits } from '../../main/knowledge/parser-protocol.js'
import { parseHtml } from './html.js'
import { DocumentParserError } from './shared.js'

function crc32(bytes: Uint8Array, initial = 0xffffffff): number {
  let value = initial
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
    }
  }
  return value >>> 0
}

function invalidEntryName(name: string): boolean {
  const normalizedName = name.replace(/\\/g, '/')
  return (
    name.length === 0
    || name.includes('\0')
    || /^[\\/]/.test(name)
    || /^[a-z]:/i.test(name)
    || normalizedName.split('/').includes('..')
  )
}

async function inspectArchive(bytes: Uint8Array, limits: ParserLimits): Promise<void> {
  if (bytes.byteLength < 22) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let offset = bytes.length - 22, minimum = Math.max(0, bytes.length - 65_557); offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset
      break
    }
  }
  if (end < 0) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  const entries = view.getUint16(end + 10, true)
  const centralSize = view.getUint32(end + 12, true)
  const centralOffset = view.getUint32(end + 16, true)
  const commentLength = view.getUint16(end + 20, true)
  if (
    end + 22 + commentLength !== bytes.length
    || view.getUint16(end + 4, true) !== 0
    || view.getUint16(end + 6, true) !== 0
    || view.getUint16(end + 8, true) !== entries
    || entries === 0
    || entries === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
    || centralOffset + centralSize > end
  ) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')

  let totalExpanded = 0
  let offset = centralOffset
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) {
      throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    }
    const flags = view.getUint16(offset + 8, true)
    if ((flags & 1) !== 0) throw new DocumentParserError('PARSER_ENCRYPTED_DOCUMENT')
    if ((flags & ~0x080e) !== 0) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    const method = view.getUint16(offset + 10, true)
    if (method !== 8 && (flags & 0x6) !== 0) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    const declaredCrc = view.getUint32(offset + 16, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const declaredSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const entryCommentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const next = offset + 46 + nameLength + extraLength + entryCommentLength
    if (
      next > end
      || compressedSize === 0xffffffff
      || declaredSize === 0xffffffff
      || localOffset === 0xffffffff
      || localOffset + 30 > bytes.length
      || view.getUint32(localOffset, true) !== 0x04034b50
    ) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (invalidEntryName(name)) {
      throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    }
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const localName = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    )
    if (
      view.getUint16(localOffset + 6, true) !== flags
      || view.getUint16(localOffset + 8, true) !== method
      || localName !== name
    ) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    const localCrc = view.getUint32(localOffset + 14, true)
    const localCompressedSize = view.getUint32(localOffset + 18, true)
    const localDeclaredSize = view.getUint32(localOffset + 22, true)
    const hasDescriptor = (flags & 0x8) !== 0
    if (!hasDescriptor && (
      localCrc !== declaredCrc
      || localCompressedSize !== compressedSize
      || localDeclaredSize !== declaredSize
    )) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    if (hasDescriptor && !(
      (localCrc === 0 && localCompressedSize === 0 && localDeclaredSize === 0)
      || (
        localCrc === declaredCrc
        && localCompressedSize === compressedSize
        && localDeclaredSize === declaredSize
      )
    )) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > centralOffset) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    if (hasDescriptor) {
      let descriptorOffset = dataEnd
      if (descriptorOffset + 4 <= centralOffset && view.getUint32(descriptorOffset, true) === 0x08074b50) {
        descriptorOffset += 4
      }
      if (
        descriptorOffset + 12 > centralOffset
        || view.getUint32(descriptorOffset, true) !== declaredCrc
        || view.getUint32(descriptorOffset + 4, true) !== compressedSize
        || view.getUint32(descriptorOffset + 8, true) !== declaredSize
      ) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    }

    let actualSize = 0
    let actualCrc = 0xffffffff
    if (method === 0) {
      actualSize = compressedSize
      totalExpanded += actualSize
      actualCrc = crc32(bytes.subarray(dataStart, dataEnd), actualCrc)
    } else if (method === 8) {
      try {
        const reader = new Blob([bytes.slice(dataStart, dataEnd)])
          .stream()
          .pipeThrough(new DecompressionStream('deflate-raw'))
          .getReader()
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          actualSize += chunk.value.byteLength
          totalExpanded += chunk.value.byteLength
          actualCrc = crc32(chunk.value, actualCrc)
          if (totalExpanded > limits.maxExpandedBytes) {
            await reader.cancel().catch(() => undefined)
            throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
          }
        }
      } catch (error) {
        if (error instanceof DocumentParserError) throw error
        throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
      }
    } else {
      throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    }
    if (totalExpanded > limits.maxExpandedBytes) throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
    if (actualSize !== declaredSize) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    if (((actualCrc ^ 0xffffffff) >>> 0) !== declaredCrc) {
      throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    }
    offset = next
  }
  if (offset !== centralOffset + centralSize) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
}

export async function parseDocx(bytes: Uint8Array, limits: ParserLimits): Promise<ParsedDocument> {
  let documentBytes: Uint8Array | undefined
  try {
    await inspectArchive(bytes, limits)
    documentBytes = bytes.slice()
    const converted = await mammoth.convertToHtml({ arrayBuffer: documentBytes.buffer as ArrayBuffer }, {
      externalFileAccess: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
    })
    const html = parseHtml(new TextEncoder().encode(converted.value))
    const headings: string[] = []
    const blocks = html.blocks.map((block, index) => {
      const htmlCoordinate = block.coordinate.kind === 'html' ? block.coordinate : undefined
      if (htmlCoordinate?.path.length) {
        headings.splice(0, headings.length, ...htmlCoordinate.path)
      }
      return {
        id: `p-${index + 1}`,
        text: block.text,
        coordinate: {
          kind: 'docx' as const,
          paragraphId: `p-${index + 1}`,
          headingPath: [...headings],
        },
      }
    })
    return {
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      text: blocks.map(block => block.text).join('\n'),
      blocks,
    }
  } catch (error) {
    if (error instanceof DocumentParserError) throw error
    if (/password|encrypt/i.test(String((error as Error).message))) {
      throw new DocumentParserError('PARSER_ENCRYPTED_DOCUMENT')
    }
    throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  } finally {
    documentBytes?.fill(0)
  }
}
