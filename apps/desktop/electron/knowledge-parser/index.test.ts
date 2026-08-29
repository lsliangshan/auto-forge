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
  brotliPdf,
  encryptedPdf,
  minimalDocx,
  minimalPdf,
} from '../main/knowledge/test-fixtures/document-fixtures.js'
import { parseEncryptedDocument, postParserResponse } from './index.js'
import { parseDocx } from './parsers/docx.js'
import { parsePdf } from './parsers/pdf.js'

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
  it('clears renderer snapshot and key buffers when strict request parsing fails', async () => {
    const encryptedSnapshot = new ArrayBuffer(64)
    const oneTimeKey = new ArrayBuffer(32)
    new Uint8Array(encryptedSnapshot).fill(7)
    new Uint8Array(oneTimeKey).fill(9)
    await expect(parseEncryptedDocument({
      version: 1,
      type: 'parse',
      jobId: 'invalid-extra-field',
      mediaType: 'text/plain',
      encryptedSnapshot,
      oneTimeKey,
      limits: DEFAULT_PARSER_LIMITS,
      forbidden: true,
    })).resolves.toMatchObject({ type: 'error', code: 'PARSER_PROTOCOL_INVALID' })
    expect(new Uint8Array(encryptedSnapshot).every(byte => byte === 0)).toBe(true)
    expect(new Uint8Array(oneTimeKey).every(byte => byte === 0)).toBe(true)
  })

  it('clears renderer snapshot and key buffers on the lowered encrypted-byte early limit', async () => {
    const request = encryptedRequest('text/plain', Buffer.from('bounded'))
    request.limits = {
      ...request.limits,
      maxEncryptedBytes: request.encryptedSnapshot.byteLength - 1,
    }
    await expect(parseEncryptedDocument(request))
      .resolves.toMatchObject({ type: 'error', code: 'PARSER_LIMIT_EXCEEDED' })
    expect(new Uint8Array(request.encryptedSnapshot).every(byte => byte === 0)).toBe(true)
    expect(new Uint8Array(request.oneTimeKey).every(byte => byte === 0)).toBe(true)
  })

  it('clears encoded response and current chunk and closes the port when postMessage throws', () => {
    const originalEncode = TextEncoder.prototype.encode
    let encoded: Uint8Array<ArrayBuffer> | undefined
    const encodeSpy = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
      this: TextEncoder,
      input?: string,
    ): Uint8Array<ArrayBuffer> {
      encoded = originalEncode.call(this, input) as Uint8Array<ArrayBuffer>
      return encoded
    })
    let currentChunk: Uint8Array | undefined
    const port = {
      postMessage: vi.fn((frame: { bytes: Uint8Array }) => {
        currentChunk = frame.bytes
        throw new Error('port closed')
      }),
      close: vi.fn(),
    }
    expect(() => postParserResponse(port, {
      version: 1,
      type: 'error',
      jobId: 'post-failure',
      code: 'PARSER_INTERNAL_ERROR',
    })).toThrow('port closed')
    expect(encoded?.every(byte => byte === 0)).toBe(true)
    expect(currentChunk?.every(byte => byte === 0)).toBe(true)
    expect(port.close).toHaveBeenCalledOnce()
    encodeSpy.mockRestore()
  })

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

    for (const dangerous of [
      '# Safe\n\n<script/>steal()',
      '# Safe\n\n<iframe/>steal()',
    ]) {
      const result = await parseEncryptedDocument(encryptedRequest('text/markdown', Buffer.from(dangerous)))
      expect(result).toMatchObject({ type: 'result', document: { text: 'Safe' } })
      expect(JSON.stringify(result)).not.toContain('steal')
    }
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
    await expect(parseEncryptedDocument(encryptedRequest(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      minimalDocx(0, undefined, true),
    ))).resolves.toMatchObject({ type: 'result' })

    const badDescriptor = Buffer.from(minimalDocx(0, undefined, true))
    const firstDescriptor = badDescriptor.indexOf(Buffer.from('PK\x07\x08', 'binary'))
    badDescriptor[firstDescriptor + 4] ^= 0xff
    await expect(parseEncryptedDocument(encryptedRequest(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      badDescriptor,
    ))).resolves.toMatchObject({ type: 'error', code: 'PARSER_MALFORMED_DOCUMENT' })

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

    const mutateHeaders = (
      mutation: (archive: Buffer, central: number, local: number) => void,
    ): Buffer => {
      const archive = Buffer.from(minimalDocx())
      const end = archive.lastIndexOf(Buffer.from('PK\x05\x06', 'binary'))
      const central = archive.readUInt32LE(end + 16)
      const local = archive.readUInt32LE(central + 42)
      mutation(archive, central, local)
      return archive
    }
    const corruptions = [
      mutateHeaders((archive, central, local) => {
        archive.writeUInt32LE((archive.readUInt32LE(central + 16) ^ 0xffffffff) >>> 0, central + 16)
        archive.writeUInt32LE(archive.readUInt32LE(central + 16), local + 14)
      }),
      mutateHeaders((archive, _central, local) => archive.writeUInt32LE(1, local + 18)),
      mutateHeaders((archive, _central, local) => archive.writeUInt32LE(1, local + 22)),
      mutateHeaders((archive, central, local) => {
        archive.writeUInt16LE(0x40, central + 8)
        archive.writeUInt16LE(0x40, local + 6)
      }),
      minimalDocx(0, '..\\escape.xml'),
      minimalDocx(0, 'C:\\escape.xml'),
    ]
    for (const corruption of corruptions) {
      await expect(parseEncryptedDocument(encryptedRequest(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        corruption,
      ))).resolves.toMatchObject({ type: 'error', code: 'PARSER_MALFORMED_DOCUMENT' })
    }

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
          { text: 'PDF first', coordinate: { kind: 'pdf', page: 1, itemStart: 0, itemEnd: 1 } },
          { text: 'PDF second', coordinate: { kind: 'pdf', page: 2, itemStart: 0, itemEnd: 1 } },
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
      brotliPdf('x'.repeat(2_048)),
      { ...DEFAULT_PARSER_LIMITS, maxExpandedBytes: 256 },
    ))).resolves.toMatchObject({ type: 'error', code: 'PARSER_LIMIT_EXCEEDED' })
    await expect(parseEncryptedDocument(encryptedRequest(
      'application/pdf',
      brotliPdf('', true),
    ))).resolves.toMatchObject({ type: 'error', code: 'PARSER_MALFORMED_DOCUMENT' })
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

  it('clears parser-owned PDF and DOCX input copies after dependency use', async () => {
    const docx = new Uint8Array(minimalDocx())
    const originalDocxSlice = docx.slice.bind(docx)
    let docxCopy: Uint8Array | undefined
    Object.defineProperty(docx, 'slice', {
      value: (...args: Parameters<Uint8Array['slice']>) => {
        const copy = originalDocxSlice(...args)
        if (args.length === 0) docxCopy = copy
        return copy
      },
    })
    await parseDocx(docx, DEFAULT_PARSER_LIMITS)
    expect(docxCopy).toBeDefined()
    expect(docxCopy?.every(byte => byte === 0)).toBe(true)

    const pdf = new Uint8Array(minimalPdf(['copy cleanup']))
    const originalPdfSlice = pdf.slice.bind(pdf)
    let pdfCopy: Uint8Array | undefined
    Object.defineProperty(pdf, 'slice', {
      value: (...args: Parameters<Uint8Array['slice']>) => {
        const copy = originalPdfSlice(...args)
        if (args.length === 0) pdfCopy = copy
        return copy
      },
    })
    await parsePdf(pdf, DEFAULT_PARSER_LIMITS)
    expect(pdfCopy).toBeDefined()
    expect(pdfCopy?.byteLength === 0 || pdfCopy?.every(byte => byte === 0)).toBe(true)
  })
})
