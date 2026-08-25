import * as mammoth from 'mammoth/mammoth.browser.js'
import { parse as parseHtmlDocument } from 'parse5'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { ParserBlock, ParserFormat, ParserLimits } from '../parser-protocol.js'

if (typeof window !== 'undefined') GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export class DocumentParserError extends Error {
  constructor(readonly code: 'PARSER_MALFORMED_DOCUMENT' | 'PARSER_ENCRYPTED_DOCUMENT' | 'PARSER_SCANNED_DOCUMENT' | 'PARSER_LIMIT_EXCEEDED') {
    super(code)
  }
}

interface ParsedDocument { text: string; blocks: ParserBlock[] }
interface TreeNode { nodeName?: string; tagName?: string; value?: string; childNodes?: TreeNode[] }
interface MarkdownNode { type?: string; value?: string; depth?: number; children?: MarkdownNode[] }

function normalized(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').trim()
}

function enforce(document: ParsedDocument, limits: ParserLimits): ParsedDocument {
  if (document.text.length > limits.maxTextChars || document.blocks.length > limits.maxBlocks) {
    throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
  }
  return document
}

function textOf(node: { value?: string; children?: MarkdownNode[] }): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(textOf).join('')
}

function parseTxt(bytes: Uint8Array): ParsedDocument {
  let text: string
  try { text = normalized(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT') }
  let character = 0
  const blocks = text.split('\n').map((line, index) => {
    const start = character
    character += line.length + (index < text.split('\n').length - 1 ? 1 : 0)
    return { id: `line-${index + 1}`, text: line, coordinate: { kind: 'txt' as const, lineStart: index + 1, lineEnd: index + 1, charStart: start, charEnd: start + line.length } }
  }).filter(block => block.text.length > 0)
  return { text, blocks }
}

function parseMarkdown(bytes: Uint8Array): ParsedDocument {
  let source: string
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT') }
  let root: MarkdownNode
  try { root = unified().use(remarkParse).parse(source) as MarkdownNode } catch { throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT') }
  const blocks: ParserBlock[] = []
  const headings: string[] = []
  for (const node of root.children ?? []) {
    if (node.type === 'html') continue
    const text = normalized(textOf(node))
    if (!text) continue
    if (node.type === 'heading') {
      const depth = node.depth ?? 1
      headings.splice(depth - 1)
      headings[depth - 1] = text
    }
    blocks.push({ id: `md-${blocks.length + 1}`, text, coordinate: { kind: 'markdown', path: headings.filter(Boolean), blockIndex: blocks.length } })
  }
  return { text: blocks.map(block => block.text).join('\n'), blocks }
}

const DROPPED_HTML = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math'])
const HTML_BLOCKS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'pre', 'blockquote', 'td', 'th'])

function htmlText(node: TreeNode): string {
  if (node.nodeName === '#text') return node.value ?? ''
  if (node.tagName && DROPPED_HTML.has(node.tagName)) return ''
  return (node.childNodes ?? []).map(htmlText).join(' ')
}

function parseHtml(bytes: Uint8Array): ParsedDocument {
  let source: string
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT') }
  let root: TreeNode
  try { root = parseHtmlDocument(source) as unknown as TreeNode } catch { throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT') }
  const blocks: ParserBlock[] = []
  const headings: string[] = []
  const visit = (node: TreeNode) => {
    if (node.tagName && DROPPED_HTML.has(node.tagName)) return
    if (node.tagName && HTML_BLOCKS.has(node.tagName)) {
      const text = normalized(htmlText(node))
      if (text) {
        if (/^h[1-6]$/.test(node.tagName)) {
          const depth = Number(node.tagName[1])
          headings.splice(depth - 1)
          headings[depth - 1] = text
        }
        blocks.push({ id: `html-${blocks.length + 1}`, text, coordinate: { kind: 'html', path: headings.filter(Boolean), blockIndex: blocks.length } })
      }
      return
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(root)
  return { text: blocks.map(block => block.text).join('\n'), blocks }
}

function inspectDocxArchive(bytes: Uint8Array, limits: ParserLimits): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let entries = 0
  let total = 0
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    entries += 1
    const flags = view.getUint16(offset + 8, true)
    if ((flags & 1) !== 0) throw new DocumentParserError('PARSER_ENCRYPTED_DOCUMENT')
    total += view.getUint32(offset + 24, true)
    if (total > limits.maxDecompressedBytes || entries > limits.maxBlocks) throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
    const name = view.getUint16(offset + 28, true)
    const extra = view.getUint16(offset + 30, true)
    const comment = view.getUint16(offset + 32, true)
    offset += 45 + name + extra + comment
  }
  if (entries === 0) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
}

async function parseDocx(bytes: Uint8Array, limits: ParserLimits): Promise<ParsedDocument> {
  inspectDocxArchive(bytes, limits)
  try {
    const copy = bytes.slice().buffer
    const result = await mammoth.convertToHtml({ arrayBuffer: copy }, {
      externalFileAccess: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
    })
    const html = parseHtml(new TextEncoder().encode(result.value))
    const headings: string[] = []
    const blocks = html.blocks.map((block, index) => {
      const path = block.coordinate.kind === 'html' ? block.coordinate.path : headings
      headings.splice(0, headings.length, ...path)
      return { id: `p-${index + 1}`, text: block.text, coordinate: { kind: 'docx' as const, paragraphId: `p-${index + 1}`, headingPath: [...headings] } }
    })
    return { text: blocks.map(block => block.text).join('\n'), blocks }
  } catch (error) {
    if (error instanceof DocumentParserError) throw error
    const message = String((error as Error).message)
    if (/password|encrypt/i.test(message)) throw new DocumentParserError('PARSER_ENCRYPTED_DOCUMENT')
    throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  }
}

async function parsePdf(bytes: Uint8Array, limits: ParserLimits): Promise<ParsedDocument> {
  if (new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1_048_576))).includes('/Encrypt')) {
    throw new DocumentParserError('PARSER_ENCRYPTED_DOCUMENT')
  }
  try {
    const task = getDocument({
      data: bytes.slice(),
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
      enableXfa: false,
      verbosity: 0,
    })
    const document = await task.promise
    if (document.numPages > limits.maxPages) throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
    const blocks: ParserBlock[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = normalized(content.items.map(item => ('str' in item ? item.str : '')).join(' '))
      if (text) blocks.push({ id: `page-${pageNumber}`, text, coordinate: { kind: 'pdf', page: pageNumber, itemStart: 0, itemEnd: content.items.length } })
      page.cleanup()
    }
    await task.destroy()
    if (blocks.length === 0) throw new DocumentParserError('PARSER_SCANNED_DOCUMENT')
    return { text: blocks.map(block => block.text).join('\n'), blocks }
  } catch (error) {
    if (error instanceof DocumentParserError) throw error
    const name = String((error as Error).name)
    if (/PasswordException/i.test(name)) throw new DocumentParserError('PARSER_ENCRYPTED_DOCUMENT')
    throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  }
}

export async function parseDocument(format: ParserFormat, bytes: Uint8Array, limits: ParserLimits): Promise<ParsedDocument> {
  if (bytes.byteLength > limits.maxDecryptedBytes) throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
  const result = format === 'txt' ? parseTxt(bytes)
    : format === 'markdown' ? parseMarkdown(bytes)
      : format === 'html' ? parseHtml(bytes)
        : format === 'docx' ? await parseDocx(bytes, limits)
          : await parsePdf(bytes, limits)
  return enforce(result, limits)
}
