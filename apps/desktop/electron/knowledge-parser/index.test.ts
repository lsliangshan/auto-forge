import { createCipheriv, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PARSER_LIMITS,
  type ParserLimits,
  type ParserMediaType,
  type ParserRequest,
} from '../main/knowledge/parser-protocol.js'
import {
  compressedPdf,
  encryptedPdf,
  minimalDocx,
  minimalPdf,
} from '../main/knowledge/test-fixtures/document-fixtures.js'
import { parseEncryptedDocument } from './index.js'

const MAGIC = Buffer.from('AFKBSNP1', 'ascii')
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

async function fixture(name: string): Promise<Buffer> {
  return readFile(new URL(`../main/knowledge/test-fixtures/${name}`, import.meta.url))
}

function encryptedRequest(
  mediaType: ParserMediaType,
  cleartext: Uint8Array,
  limits: ParserLimits = DEFAULT_PARSER_LIMITS,
): ParserRequest {
  const key = randomBytes(32)
  const nonce = Buffer.alloc(12, 7)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(MAGIC)
  const ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()])
  const envelope = Buffer.concat([MAGIC, nonce, ciphertext, cipher.getAuthTag()])
  return {
    version: 1,
    type: 'parse',
    jobId: `job-${mediaType}`,
    mediaType,
    encryptedSnapshot: Uint8Array.from(envelope).buffer,
    oneTimeKey: Uint8Array.from(key).buffer,
    limits,
  }
}

describe('sandbox knowledge parser', () => {
  it('decodes fatal UTF-8 TXT with stable line and character coordinates', async () => {
    const valid = await parseEncryptedDocument(encryptedRequest('text/plain', await fixture('valid.txt')))
    expect(valid).toMatchObject({
      type: 'result',
      document: {
        mediaType: 'text/plain',
        blocks: [
          { text: '第一行', coordinate: { kind: 'txt', lineStart: 1, charStart: 0 } },
          { text: 'second line', coordinate: { kind: 'txt', lineStart: 2, charStart: 4 } },
        ],
      },
    })
    const invalidBytes = Buffer.from((await fixture('invalid-utf8.hex')).toString('ascii').trim(), 'hex')
    await expect(parseEncryptedDocument(encryptedRequest('text/plain', invalidBytes)))
      .resolves.toMatchObject({ type: 'error', code: 'PARSER_MALFORMED_DOCUMENT' })
  })

  it('parses Markdown and HTML structure without active content or external requests', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => { throw new Error('network must not run') })
    globalThis.fetch = fetchSpy
    const markdown = await parseEncryptedDocument(encryptedRequest('text/markdown', await fixture('valid.md')))
    expect(markdown).toMatchObject({
      type: 'result',
      document: { blocks: [{ text: 'Heading' }, { text: 'Safe markdown text.' }] },
    })
    expect(JSON.stringify(markdown)).not.toMatch(/invalid\.example|steal|script/i)

    const html = await parseEncryptedDocument(encryptedRequest('text/html', await fixture('dangerous.html')))
    expect(html).toMatchObject({
      type: 'result',
      document: { blocks: [{ text: 'Safe title' }, { text: 'Safe paragraph' }] },
    })
    expect(JSON.stringify(html)).not.toMatch(/invalid\.example|steal|onload|onerror|iframe|script|style/i)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('parses DOCX heading and paragraph identity and measures actual ZIP expansion', async () => {
    const valid = await parseEncryptedDocument(encryptedRequest(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      minimalDocx(),
    ))
    expect(valid).toMatchObject({
      type: 'result',
      document: {
        blocks: [
          { text: 'DOCX heading', coordinate: { kind: 'docx', paragraphId: 'p-1', headingPath: ['DOCX heading'] } },
          { text: 'DOCX paragraph', coordinate: { kind: 'docx', paragraphId: 'p-2', headingPath: ['DOCX heading'] } },
        ],
      },
    })

    const limited = { ...DEFAULT_PARSER_LIMITS, maxExpandedBytes: 512 }
    await expect(parseEncryptedDocument(encryptedRequest(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      minimalDocx(2_048),
      limited,
    ))).resolves.toMatchObject({ type: 'error', code: 'PARSER_LIMIT_EXCEEDED' })

    const inconsistentHeaders = Buffer.from(minimalDocx())
    inconsistentHeaders.writeUInt16LE(8, 8)
    await expect(parseEncryptedDocument(encryptedRequest(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      inconsistentHeaders,
    ))).resolves.toMatchObject({ type: 'error', code: 'PARSER_MALFORMED_DOCUMENT' })

    const invalidEntryName = Buffer.from(minimalDocx())
    const end = invalidEntryName.lastIndexOf(Buffer.from('PK\x05\x06', 'binary'))
    const centralOffset = invalidEntryName.readUInt32LE(end + 16)
    invalidEntryName[centralOffset + 46] = 0xff
    await expect(parseEncryptedDocument(encryptedRequest(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      invalidEntryName,
    ))).resolves.toMatchObject({ type: 'error', code: 'PARSER_MALFORMED_DOCUMENT' })
  })

  it('returns stable PDF page positions and distinguishes scanned, encrypted, and malformed PDFs', async () => {
    const valid = await parseEncryptedDocument(encryptedRequest('application/pdf', minimalPdf(['PDF first', 'PDF second'])))
    expect(valid).toMatchObject({
      type: 'result',
      document: {
        blocks: [
          { text: 'PDF first', coordinate: { kind: 'pdf', page: 1, itemStart: 0 } },
          { text: 'PDF second', coordinate: { kind: 'pdf', page: 2, itemStart: 0 } },
        ],
      },
    })
    await expect(parseEncryptedDocument(encryptedRequest('application/pdf', minimalPdf([undefined]))))
      .resolves.toMatchObject({ type: 'error', code: 'PARSER_SCANNED_DOCUMENT' })
    await expect(parseEncryptedDocument(encryptedRequest('application/pdf', encryptedPdf())))
      .resolves.toMatchObject({ type: 'error', code: 'PARSER_ENCRYPTED_DOCUMENT' })
    await expect(parseEncryptedDocument(encryptedRequest('application/pdf', Buffer.from('%PDF broken'))))
      .resolves.toMatchObject({ type: 'error', code: 'PARSER_MALFORMED_DOCUMENT' })
  })

  it('enforces file, page, text, block, and serialized response budgets', async () => {
    await expect(parseEncryptedDocument(encryptedRequest(
      'text/plain',
      Buffer.from('123456'),
      { ...DEFAULT_PARSER_LIMITS, maxFileBytes: 5 },
    ))).resolves.toMatchObject({ type: 'error', code: 'PARSER_LIMIT_EXCEEDED' })
    await expect(parseEncryptedDocument(encryptedRequest(
      'application/pdf',
      compressedPdf('x'.repeat(2_048)),
      { ...DEFAULT_PARSER_LIMITS, maxExpandedBytes: 256 },
    ))).resolves.toMatchObject({ type: 'error', code: 'PARSER_LIMIT_EXCEEDED' })
    await expect(parseEncryptedDocument(encryptedRequest(
      'application/pdf',
      minimalPdf(['first', 'second']),
      { ...DEFAULT_PARSER_LIMITS, maxPages: 1 },
    ))).resolves.toMatchObject({ type: 'error', code: 'PARSER_LIMIT_EXCEEDED' })
    await expect(parseEncryptedDocument(encryptedRequest(
      'text/plain',
      Buffer.from('123456'),
      { ...DEFAULT_PARSER_LIMITS, maxTextChars: 5 },
    ))).resolves.toMatchObject({ type: 'error', code: 'PARSER_LIMIT_EXCEEDED' })
    await expect(parseEncryptedDocument(encryptedRequest(
      'text/plain',
      Buffer.from('one\ntwo'),
      { ...DEFAULT_PARSER_LIMITS, maxBlocks: 1 },
    ))).resolves.toMatchObject({ type: 'error', code: 'PARSER_LIMIT_EXCEEDED' })
    await expect(parseEncryptedDocument(encryptedRequest(
      'text/plain',
      Buffer.from('response budget'),
      { ...DEFAULT_PARSER_LIMITS, maxResponseBytes: 128 },
    ))).resolves.toMatchObject({ type: 'error', code: 'PARSER_LIMIT_EXCEEDED' })
  })
})
