import {
  parseParserRequest,
  PARSER_RESPONSE_CHUNK_BYTES,
  type ParsedDocument,
  type ParserMediaType,
  type ParserResponse,
} from '../main/knowledge/parser-protocol.js'
import { DocumentParserError, enforceDocument } from './parsers/shared.js'

const SNAPSHOT_MAGIC = new TextEncoder().encode('AFKBSNP1')
const NONCE_BYTES = 12
const TAG_BYTES = 16

function clearUnparsedRequestBuffers(input: unknown): void {
  if (typeof input !== 'object' || input === null) return
  const descriptors = Object.getOwnPropertyDescriptors(input)
  for (const name of ['encryptedSnapshot', 'oneTimeKey']) {
    const value = descriptors[name]?.value
    if (value instanceof ArrayBuffer) new Uint8Array(value).fill(0)
  }
}

async function decryptSnapshot(envelope: ArrayBuffer, oneTimeKey: ArrayBuffer): Promise<Uint8Array> {
  const bytes = new Uint8Array(envelope)
  const minimumLength = SNAPSHOT_MAGIC.length + NONCE_BYTES + TAG_BYTES
  if (
    bytes.length < minimumLength
    || !SNAPSHOT_MAGIC.every((value, index) => bytes[index] === value)
  ) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  const nonceStart = SNAPSHOT_MAGIC.length
  const ciphertextStart = nonceStart + NONCE_BYTES
  try {
    const key = await crypto.subtle.importKey('raw', oneTimeKey, { name: 'AES-GCM' }, false, ['decrypt'])
    return new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: bytes.subarray(nonceStart, ciphertextStart),
      additionalData: SNAPSHOT_MAGIC,
      tagLength: 128,
    }, key, bytes.subarray(ciphertextStart)))
  } catch {
    throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  }
}

async function parseDocument(
  mediaType: ParserMediaType,
  bytes: Uint8Array,
  limits: ReturnType<typeof parseParserRequest>['limits'],
): Promise<ParsedDocument> {
  if (bytes.byteLength > limits.maxFileBytes) throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
  const document = mediaType === 'text/plain'
    ? (await import('./parsers/text.js')).parseText(bytes)
    : mediaType === 'text/markdown'
      ? (await import('./parsers/markdown.js')).parseMarkdown(bytes)
      : mediaType === 'text/html'
        ? (await import('./parsers/html.js')).parseHtml(bytes)
        : mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          ? await (await import('./parsers/docx.js')).parseDocx(bytes, limits)
          : await (await import('./parsers/pdf.js')).parsePdf(bytes, limits)
  return enforceDocument(document, limits)
}

export async function parseEncryptedDocument(input: unknown): Promise<ParserResponse> {
  let jobId = 'invalid'
  let request: ReturnType<typeof parseParserRequest>
  try {
    request = parseParserRequest(input)
    jobId = request.jobId
  } catch {
    clearUnparsedRequestBuffers(input)
    return { version: 1, type: 'error', jobId, code: 'PARSER_PROTOCOL_INVALID' }
  }
  let cleartext: Uint8Array | undefined
  try {
    if (request.encryptedSnapshot.byteLength > request.limits.maxEncryptedBytes) {
      throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
    }
    cleartext = await decryptSnapshot(request.encryptedSnapshot, request.oneTimeKey)
    const document = await parseDocument(request.mediaType, cleartext, request.limits)
    const response = { version: 1, type: 'result', jobId, document } as const
    if (new TextEncoder().encode(JSON.stringify(response)).byteLength > request.limits.maxResponseBytes) {
      throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
    }
    return response
  } catch (error) {
    return {
      version: 1,
      type: 'error',
      jobId,
      code: error instanceof DocumentParserError ? error.code : 'PARSER_INTERNAL_ERROR',
    }
  } finally {
    cleartext?.fill(0)
    new Uint8Array(request.encryptedSnapshot).fill(0)
    new Uint8Array(request.oneTimeKey).fill(0)
  }
}

interface ParserResponsePort {
  postMessage(message: unknown): void
  close(): void
}

export function postParserResponse(port: ParserResponsePort, response: ParserResponse): void {
  let encoded: Uint8Array | undefined
  let currentChunk: Uint8Array | undefined
  try {
    encoded = new TextEncoder().encode(JSON.stringify(response))
    const totalChunks = Math.ceil(encoded.byteLength / PARSER_RESPONSE_CHUNK_BYTES)
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * PARSER_RESPONSE_CHUNK_BYTES
      currentChunk = encoded.slice(start, start + PARSER_RESPONSE_CHUNK_BYTES)
      port.postMessage({
        version: 1,
        type: 'response-chunk',
        index,
        totalChunks,
        totalBytes: encoded.byteLength,
        bytes: currentChunk,
      })
      currentChunk.fill(0)
      currentChunk = undefined
    }
  } finally {
    currentChunk?.fill(0)
    encoded?.fill(0)
    port.close()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const port = event.ports[0]
    if (!port) return
    void parseEncryptedDocument(event.data).then((response) => {
      try {
        postParserResponse(port, response)
      } catch {
        // The supervisor owns job failure once the response port is unavailable.
      }
    })
  }, { once: true })
}
