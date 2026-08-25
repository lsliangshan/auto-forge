import { parseParserRequest, type ParserRequest, type ParserResponse } from './parser-protocol.js'
import { DocumentParserError, parseDocument } from './parsers/document-parsers.js'

const OBJECT_MAGIC = new TextEncoder().encode('AFKBOBJ1')
const IV_BYTES = 12
const TAG_BYTES = 16

async function decryptObject(envelope: ArrayBuffer, fileKey: ArrayBuffer): Promise<Uint8Array> {
  const bytes = new Uint8Array(envelope)
  if (bytes.length < OBJECT_MAGIC.length + IV_BYTES + TAG_BYTES || !OBJECT_MAGIC.every((value, index) => bytes[index] === value)) {
    throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  }
  const ivStart = OBJECT_MAGIC.length
  const tagStart = ivStart + IV_BYTES
  const ciphertextStart = tagStart + TAG_BYTES
  const webCiphertext = new Uint8Array(bytes.length - ciphertextStart + TAG_BYTES)
  webCiphertext.set(bytes.subarray(ciphertextStart))
  webCiphertext.set(bytes.subarray(tagStart, ciphertextStart), bytes.length - ciphertextStart)
  try {
    const key = await crypto.subtle.importKey('raw', fileKey, { name: 'AES-GCM' }, false, ['decrypt'])
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(ivStart, tagStart), additionalData: OBJECT_MAGIC, tagLength: 128 }, key, webCiphertext))
  } catch {
    throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  }
}

function chunks(blocks: Extract<ParserResponse, { type: 'result' }>['blocks'], maxChars: number, maxChunks: number) {
  const output: Extract<ParserResponse, { type: 'result' }>['chunks'] = []
  for (const block of blocks) {
    for (let start = 0; start < block.text.length; start += maxChars) {
      if (output.length >= maxChunks) throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
      output.push({ index: output.length, text: block.text.slice(start, start + maxChars), blockIds: [block.id] })
    }
  }
  return output
}

export async function parseEncryptedDocument(input: unknown): Promise<ParserResponse> {
  let request: ParserRequest
  try { request = parseParserRequest(input) } catch { return { version: 1, type: 'error', jobId: 'invalid', code: 'PARSER_PROTOCOL_INVALID' } }
  if (request.encryptedBytes.byteLength > request.limits.maxEncryptedBytes) return { version: 1, type: 'error', jobId: request.jobId, code: 'PARSER_LIMIT_EXCEEDED' }
  try {
    const decrypted = await decryptObject(request.encryptedBytes, request.fileKey)
    try {
      const parsed = await parseDocument(request.format, decrypted, request.limits)
      return { version: 1, type: 'result', jobId: request.jobId, text: parsed.text, blocks: parsed.blocks, chunks: chunks(parsed.blocks, request.limits.maxChunkChars, request.limits.maxChunks) }
    } finally {
      decrypted.fill(0)
    }
  } catch (error) {
    return { version: 1, type: 'error', jobId: request.jobId, code: error instanceof DocumentParserError ? error.code : 'PARSER_INTERNAL_ERROR' }
  } finally {
    new Uint8Array(request.encryptedBytes).fill(0)
    new Uint8Array(request.fileKey).fill(0)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const port = event.ports[0]
    if (!port) return
    void parseEncryptedDocument(event.data).then(response => { port.postMessage(response); port.close() })
  }, { once: true })
}
