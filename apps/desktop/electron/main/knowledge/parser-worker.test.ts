import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { brotliCompressSync, deflateSync } from 'node:zlib'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEncryptedObjectSnapshot, readEncryptedObjectSnapshot, unwrapSnapshotFileKey } from './encrypted-object-store.js'
import { DEFAULT_PARSER_LIMITS, type ParserFormat, type ParserLimits, type ParserRequest } from './parser-protocol.js'
import { parseEncryptedDocument } from './parser-worker.js'
import { consumeMarkdownHtml, markdownHtmlActive } from './parsers/document-parsers.js'

const directories: string[] = []
const require = createRequire(import.meta.url)

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async path => (await import('node:fs/promises')).rm(path, { recursive: true, force: true })))
})

async function encryptedRequest(format: ParserFormat, plaintext: Uint8Array, limits: ParserLimits = DEFAULT_PARSER_LIMITS): Promise<ParserRequest> {
  const directory = await mkdtemp(join(tmpdir(), 'autoforge-parser-'))
  directories.push(directory)
  const sourcePath = join(directory, 'source')
  const objectPath = join(directory, 'object')
  const userKey = Buffer.alloc(32, 7)
  await writeFile(sourcePath, plaintext)
  const snapshot = await createEncryptedObjectSnapshot({ sourcePath, objectPath, userKey })
  const fileKey = unwrapSnapshotFileKey(snapshot.wrappedFileKey, userKey)
  const encrypted = await readEncryptedObjectSnapshot(objectPath)
  const request: ParserRequest = {
    version: 1, type: 'parse', jobId: `job-${format}`, format,
    encryptedBytes: Uint8Array.from(encrypted).buffer,
    fileKey: Uint8Array.from(fileKey).buffer,
    limits,
  }
  fileKey.fill(0)
  userKey.fill(0)
  return request
}

function minimalPdf(text?: string): Uint8Array {
  const stream = text === undefined ? '' : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

function filteredPdf(filter: 'FlateDecode' | 'BrotliDecode', compressed: Uint8Array): Uint8Array {
  const beforeStream = Buffer.from(`<< /Filter /${filter} /Length ${compressed.length} >>\nstream\n`)
  const streamObject = Buffer.concat([beforeStream, compressed, Buffer.from('\nendstream')])
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    streamObject,
  ]
  const parts = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  let length = parts[0]!.length
  objects.forEach((object, index) => {
    offsets.push(length)
    const entry = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')])
    parts.push(entry)
    length += entry.length
  })
  const xref = length
  const trailer = Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat([...parts, trailer])
}

function compressedPdf(text: string): Uint8Array {
  return filteredPdf('FlateDecode', deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`)))
}

const PDF_PASSWORD_PADDING = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

function rc4(key: Uint8Array, input: Uint8Array): Buffer {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index)
  let j = 0
  for (let index = 0; index < 256; index += 1) {
    j = (j + state[index]! + key[index % key.length]!) & 0xff
    ;[state[index], state[j]] = [state[j]!, state[index]!]
  }
  const output = Buffer.alloc(input.length)
  let i = 0
  j = 0
  for (let index = 0; index < input.length; index += 1) {
    i = (i + 1) & 0xff
    j = (j + state[i]!) & 0xff
    ;[state[i], state[j]] = [state[j]!, state[i]!]
    output[index] = input[index]! ^ state[(state[i]! + state[j]!) & 0xff]!
  }
  return output
}

function passwordProtectedPdf(password = 'test'): Uint8Array {
  const pad = (password: string) => Buffer.concat([Buffer.from(password, 'ascii'), PDF_PASSWORD_PADDING]).subarray(0, 32)
  const digest = (...parts: Uint8Array[]) => createHash('md5').update(Buffer.concat(parts)).digest()
  const userPassword = pad(password)
  const ownerKey = digest(pad('owner')).subarray(0, 5)
  const ownerEntry = rc4(ownerKey, userPassword)
  const permissions = Buffer.alloc(4)
  permissions.writeInt32LE(-4)
  const fileId = digest(Buffer.from('autoforge-parser-password-fixture', 'ascii'))
  const encryptionKey = digest(userPassword, ownerEntry, permissions, fileId).subarray(0, 5)
  const userEntry = rc4(encryptionKey, PDF_PASSWORD_PADDING)
  const objectNumber = Buffer.from([5, 0, 0, 0, 0])
  const streamKey = digest(encryptionKey, objectNumber).subarray(0, 10)
  const encryptedStream = rc4(streamKey, Buffer.from('BT /F1 12 Tf 20 20 Td (Encrypted PDF) Tj ET', 'ascii'))
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 50] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>'),
    Buffer.concat([Buffer.from(`<< /Length ${encryptedStream.length} >>\nstream\n`), encryptedStream, Buffer.from('\nendstream')]),
    Buffer.from(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${ownerEntry.toString('hex')}> /U <${userEntry.toString('hex')}> /P -4 >>`),
  ]
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets: number[] = []
  let length = parts[0]!.length
  objects.forEach((object, index) => {
    offsets.push(length)
    const entry = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')])
    parts.push(entry)
    length += entry.length
  })
  parts.push(Buffer.from(`xref\n0 7\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>] >>\nstartxref\n${length}\n%%EOF\n`))
  return Buffer.concat(parts)
}

function underreportZipOutput(input: Uint8Array): Uint8Array {
  const bytes = Buffer.from(input)
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue
    bytes.writeUInt32LE(1, offset + 24)
    const localOffset = bytes.readUInt32LE(offset + 42)
    if (localOffset + 30 <= bytes.length && bytes.readUInt32LE(localOffset) === 0x04034b50) bytes.writeUInt32LE(1, localOffset + 22)
    offset += 45 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
  }
  return bytes
}

describe('sandbox parser core', () => {
  it('parses fatal UTF-8 TXT with line and character coordinates', async () => {
    const result = await parseEncryptedDocument(await encryptedRequest('txt', new TextEncoder().encode('第一行\nsecond line')))
    expect(result.type).toBe('result')
    if (result.type === 'result') {
      expect(result.text).toBe('第一行\nsecond line')
      expect(result.blocks[1]?.coordinate).toMatchObject({ kind: 'txt', lineStart: 2, charStart: 4 })
    }
    const invalid = await parseEncryptedDocument(await encryptedRequest('txt', Uint8Array.of(0xc3, 0x28)))
    expect(invalid).toMatchObject({ type: 'error', code: 'PARSER_MALFORMED_DOCUMENT' })
  })

  it('parses Markdown and HTML structure while dropping scripts and external resources', async () => {
    const markdown = await parseEncryptedDocument(await encryptedRequest('markdown', new TextEncoder().encode('# 标题\n\n正文 **粗体**\n\n<script src="https://evil.test/a">steal()</script>')))
    expect(markdown).toMatchObject({ type: 'result', blocks: [{ text: '标题' }, { text: '正文 粗体' }] })
    expect(JSON.stringify(markdown)).not.toMatch(/evil\.test|steal/)

    const html = await parseEncryptedDocument(await encryptedRequest('html', new TextEncoder().encode(
      '<h1>Title</h1><script>steal()</script><img src="https://evil.test/a"><p>Safe text</p>',
    )))
    expect(html).toMatchObject({ type: 'result', blocks: [{ text: 'Title' }, { text: 'Safe text' }] })
    expect(JSON.stringify(html)).not.toContain('evil.test')
    expect(JSON.stringify(html)).not.toContain('steal')
  })

  it('drops nested Markdown raw HTML and preserves safe body/div HTML text', async () => {
    const markdown = await parseEncryptedDocument(await encryptedRequest('markdown', new TextEncoder().encode(
      'Before <span>safe</span> after <script>evil()</script>',
    )))
    expect(markdown).toMatchObject({ type: 'result', text: 'Before safe after' })
    expect(JSON.stringify(markdown)).not.toMatch(/<span>|script|evil/)

    const html = await parseEncryptedDocument(await encryptedRequest('html', new TextEncoder().encode(
      '<body>loose<div>safe <span>inner</span><script>bad()</script></div><p>paragraph</p></body>',
    )))
    expect(html).toMatchObject({ type: 'result', blocks: [{ text: 'loose' }, { text: 'safe inner' }, { text: 'paragraph' }] })
    expect(JSON.stringify(html)).not.toContain('bad')
  })

  it('keeps dangerous Markdown HTML state quote-aware across the whole document', async () => {
    const quoted = await parseEncryptedDocument(await encryptedRequest('markdown', new TextEncoder().encode(
      'Before <script title="/>">evil()</script> after',
    )))
    expect(quoted).toMatchObject({ type: 'result', text: 'Before after' })
    expect(JSON.stringify(quoted)).not.toContain('evil')

    const split = await parseEncryptedDocument(await encryptedRequest('markdown', new TextEncoder().encode(
      'Before <script>\n\nevil across paragraphs\n\n</script> after',
    )))
    expect(split).toMatchObject({ type: 'result', text: 'Before\nafter' })
    expect(JSON.stringify(split)).not.toContain('evil')
  })

  it('resynchronizes an incomplete safe Markdown tag at a dangerous opener', async () => {
    const result = await parseEncryptedDocument(await encryptedRequest('markdown', new TextEncoder().encode(
      '<div\n\nBefore <script>evil()</script> after',
    )))
    expect(result).toMatchObject({ type: 'result', text: 'Before after' })
    expect(JSON.stringify(result)).not.toContain('evil')
  })

  it('keeps a truly split dangerous Markdown tag suppressed', () => {
    const state = { depths: new Map<string, number>(), pendingTag: '' }
    consumeMarkdownHtml('<scr', state)
    consumeMarkdownHtml('ipt>', state)
    expect(markdownHtmlActive(state) ? '' : 'evil()').toBe('')
    consumeMarkdownHtml('</script>', state)
    expect(markdownHtmlActive(state)).toBe(false)
  })

  it('parses a DOCX paragraph without exposing images or external files', async () => {
    const mammothEntry = require.resolve('mammoth')
    const fixture = await readFile(join(dirname(mammothEntry), '../test/test-data/single-paragraph.docx'))
    const result = await parseEncryptedDocument(await encryptedRequest('docx', fixture))
    expect(result).toMatchObject({ type: 'result', blocks: [{ coordinate: { kind: 'docx', paragraphId: 'p-1' } }] })
    expect(result.type === 'result' ? result.text.length : 0).toBeGreaterThan(0)
  })

  it('measures actual DOCX inflation instead of trusting ZIP metadata', async () => {
    const mammothEntry = require.resolve('mammoth')
    const fixture = await readFile(join(dirname(mammothEntry), '../test/test-data/single-paragraph.docx'))
    const limits = { ...DEFAULT_PARSER_LIMITS, maxDecompressedBytes: 256 }
    expect(await parseEncryptedDocument(await encryptedRequest('docx', underreportZipOutput(fixture), limits))).toMatchObject({
      type: 'error', code: 'PARSER_LIMIT_EXCEEDED',
    })
  })

  it('parses text-layer PDF and rejects scanned and encrypted PDFs explicitly', async () => {
    const textPdf = await parseEncryptedDocument(await encryptedRequest('pdf', minimalPdf('PDF text')))
    expect(textPdf).toMatchObject({ type: 'result', blocks: [{ text: 'PDF text', coordinate: { kind: 'pdf', page: 1 } }] })
    const scanned = await parseEncryptedDocument(await encryptedRequest('pdf', minimalPdf()))
    expect(scanned).toMatchObject({ type: 'error', code: 'PARSER_SCANNED_DOCUMENT' })
    const encrypted = passwordProtectedPdf()
    expect(await parseEncryptedDocument(await encryptedRequest('pdf', encrypted))).toMatchObject({ type: 'error', code: 'PARSER_ENCRYPTED_DOCUMENT' })
    expect(await parseEncryptedDocument(await encryptedRequest('pdf', passwordProtectedPdf('')))).toMatchObject({ type: 'error', code: 'PARSER_ENCRYPTED_DOCUMENT' })
    expect(await parseEncryptedDocument(await encryptedRequest('pdf', minimalPdf('/Encrypt is ordinary text')))).toMatchObject({ type: 'result', text: '/Encrypt is ordinary text' })
  })

  it('stops PDF decoded streams before they exceed the caller decompression budget', async () => {
    const expanding = compressedPdf('A'.repeat(2_048))
    const limits = { ...DEFAULT_PARSER_LIMITS, maxDecompressedBytes: 256 }
    expect(await parseEncryptedDocument(await encryptedRequest('pdf', expanding, limits))).toMatchObject({
      type: 'error', code: 'PARSER_LIMIT_EXCEEDED',
    })
  })

  it('fails closed before invoking the synchronous Brotli fallback under a hard budget', async () => {
    const native = Object.getOwnPropertyDescriptor(globalThis, 'DecompressionStream')
    class NoNativeBrotli extends DecompressionStream {
      constructor(format: CompressionFormat) {
        if (String(format) === 'brotli') throw new TypeError('forced native Brotli failure')
        super(format)
      }
    }
    Object.defineProperty(globalThis, 'DecompressionStream', { configurable: true, value: NoNativeBrotli })
    try {
      const limits = { ...DEFAULT_PARSER_LIMITS, maxDecompressedBytes: 256 }
      const expandingBrotli = filteredPdf('BrotliDecode', brotliCompressSync(Buffer.from('A'.repeat(2_048))))
      expect(await parseEncryptedDocument(await encryptedRequest('pdf', expandingBrotli, limits))).toMatchObject({
        type: 'error', code: 'PARSER_LIMIT_EXCEEDED',
      })
      const invalidBrotli = filteredPdf('BrotliDecode', Uint8Array.of(0xff, 0xff, 0xff, 0xff))
      expect(await parseEncryptedDocument(await encryptedRequest('pdf', invalidBrotli, limits))).toMatchObject({
        type: 'error', code: 'PARSER_LIMIT_EXCEEDED',
      })
      const workerSource = await readFile(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'), 'utf8')
      const brotliMethod = workerSource.slice(workerSource.indexOf('class BrotliStream'), workerSource.indexOf(';// ./external/jbig2'))
      expect(brotliMethod.indexOf('if (maxDecodedStreamBytes > 0)')).toBeGreaterThan(0)
      expect(brotliMethod.indexOf('if (maxDecodedStreamBytes > 0)')).toBeLessThan(brotliMethod.indexOf('this.#isAsync = false'))
    } finally {
      if (native) Object.defineProperty(globalThis, 'DecompressionStream', native)
    }
  })

  it('rejects malformed, oversized, and unsupported content with stable errors', async () => {
    expect(await parseEncryptedDocument(await encryptedRequest('docx', new TextEncoder().encode('not a zip')))).toMatchObject({ type: 'error', code: 'PARSER_MALFORMED_DOCUMENT' })
    const limited = { ...DEFAULT_PARSER_LIMITS, maxTextChars: 4 }
    expect(await parseEncryptedDocument(await encryptedRequest('txt', new TextEncoder().encode('too much text'), limited))).toMatchObject({ type: 'error', code: 'PARSER_LIMIT_EXCEEDED' })
  })
})
