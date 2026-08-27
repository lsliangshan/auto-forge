import {
  parseParserRequest,
  type ParsedDocument,
  type ParserMediaType,
  type ParserResponse,
} from '../main/knowledge/parser-protocol.js'
import { DocumentParserError, enforceDocument } from './parsers/shared.js'

const SNAPSHOT_MAGIC = new TextEncoder().encode('AFKBSNP1')
const NONCE_BYTES = 12
const TAG_BYTES = 16

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
    return { version: 1, type: 'error', jobId, code: 'PARSER_PROTOCOL_INVALID' }
  }
  if (request.encryptedSnapshot.byteLength > request.limits.maxEncryptedBytes) {
    return { version: 1, type: 'error', jobId, code: 'PARSER_LIMIT_EXCEEDED' }
  }

  let cleartext: Uint8Array | undefined
  try {
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

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const port = event.ports[0]
    if (!port) return
    void parseEncryptedDocument(event.data).then((response) => {
      port.postMessage(response)
      port.close()
    })
  }, { once: true })
}
