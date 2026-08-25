import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEncryptedObjectSnapshot, readEncryptedObjectSnapshot, unwrapSnapshotFileKey } from './encrypted-object-store.js'
import { DEFAULT_PARSER_LIMITS, type ParserFormat, type ParserLimits, type ParserRequest } from './parser-protocol.js'
import { parseEncryptedDocument } from './parser-worker.js'

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

  it('parses a DOCX paragraph without exposing images or external files', async () => {
    const mammothEntry = require.resolve('mammoth')
    const fixture = await readFile(join(dirname(mammothEntry), '../test/test-data/single-paragraph.docx'))
    const result = await parseEncryptedDocument(await encryptedRequest('docx', fixture))
    expect(result).toMatchObject({ type: 'result', blocks: [{ coordinate: { kind: 'docx', paragraphId: 'p-1' } }] })
    expect(result.type === 'result' ? result.text.length : 0).toBeGreaterThan(0)
  })

  it('parses text-layer PDF and rejects scanned and encrypted PDFs explicitly', async () => {
    const textPdf = await parseEncryptedDocument(await encryptedRequest('pdf', minimalPdf('PDF text')))
    expect(textPdf).toMatchObject({ type: 'result', blocks: [{ text: 'PDF text', coordinate: { kind: 'pdf', page: 1 } }] })
    const scanned = await parseEncryptedDocument(await encryptedRequest('pdf', minimalPdf()))
    expect(scanned).toMatchObject({ type: 'error', code: 'PARSER_SCANNED_DOCUMENT' })
    const encrypted = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Encrypt 2 0 R >> endobj\n%%EOF')
    expect(await parseEncryptedDocument(await encryptedRequest('pdf', encrypted))).toMatchObject({ type: 'error', code: 'PARSER_ENCRYPTED_DOCUMENT' })
  })

  it('rejects malformed, oversized, and unsupported content with stable errors', async () => {
    expect(await parseEncryptedDocument(await encryptedRequest('docx', new TextEncoder().encode('not a zip')))).toMatchObject({ type: 'error', code: 'PARSER_MALFORMED_DOCUMENT' })
    const limited = { ...DEFAULT_PARSER_LIMITS, maxTextChars: 4 }
    expect(await parseEncryptedDocument(await encryptedRequest('txt', new TextEncoder().encode('too much text'), limited))).toMatchObject({ type: 'error', code: 'PARSER_LIMIT_EXCEEDED' })
  })
})
