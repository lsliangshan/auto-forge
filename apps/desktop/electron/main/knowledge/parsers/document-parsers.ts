import * as mammoth from 'mammoth/mammoth.browser.js'
import { parse as parseHtmlDocument } from 'parse5'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'
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

const DROPPED_MARKDOWN_HTML = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math'])

interface MarkdownHtmlState {
  readonly depths: Map<string, number>
  pendingTag: string
}

function consumeMarkdownHtml(value: string, state: MarkdownHtmlState): void {
  const source = state.pendingTag + value
  state.pendingTag = ''
  for (let start = source.indexOf('<'); start >= 0; start = source.indexOf('<', start + 1)) {
    let quote = ''
    let end = start + 1
    for (; end < source.length; end += 1) {
      const character = source[end]!
      if (quote) {
        if (character === quote) quote = ''
      } else if (character === '"' || character === "'") {
        quote = character
      } else if (character === '>') {
        break
      }
    }
    if (end >= source.length) {
      state.pendingTag = source.slice(start)
      return
    }
    const boundary = source.slice(start + 1, end).trim()
    start = end
    const closing = boundary.startsWith('/')
    const match = boundary.match(/^\/?\s*([a-z0-9-]+)\b/i)
    const tag = match?.[1]?.toLowerCase()
    if (!tag || !DROPPED_MARKDOWN_HTML.has(tag)) continue
    if (closing) state.depths.set(tag, Math.max(0, (state.depths.get(tag) ?? 0) - 1))
    else if (!boundary.endsWith('/')) state.depths.set(tag, (state.depths.get(tag) ?? 0) + 1)
  }
}

function markdownHtmlActive(state: MarkdownHtmlState): boolean {
  return [...state.depths.values()].some(depth => depth > 0)
}

function textOf(node: MarkdownNode, state: MarkdownHtmlState): string {
  if (node.type === 'html') {
    consumeMarkdownHtml(node.value ?? '', state)
    return ''
  }
  if (typeof node.value === 'string') return markdownHtmlActive(state) ? '' : node.value
  let output = ''
  for (const child of node.children ?? []) {
    output += textOf(child, state)
  }
  return output
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
  const htmlState: MarkdownHtmlState = { depths: new Map(), pendingTag: '' }
  for (const node of root.children ?? []) {
    const text = normalized(textOf(node, htmlState))
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
const HTML_CONTAINERS = new Set(['body', 'div'])

function htmlText(node: TreeNode): string {
  if (node.nodeName === '#text') return node.value ?? ''
  if (node.tagName && DROPPED_HTML.has(node.tagName)) return ''
  return (node.childNodes ?? []).map(htmlText).join(' ')
}

function htmlContainerText(node: TreeNode): string {
  if (node.nodeName === '#text') return node.value ?? ''
  if (node.tagName && (DROPPED_HTML.has(node.tagName) || HTML_BLOCKS.has(node.tagName) || HTML_CONTAINERS.has(node.tagName))) return ''
  return (node.childNodes ?? []).map(htmlContainerText).join(' ')
}

function parseHtml(bytes: Uint8Array): ParsedDocument {
  let source: string
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT') }
  let root: TreeNode
  try { root = parseHtmlDocument(source) as unknown as TreeNode } catch { throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT') }
  const blocks: ParserBlock[] = []
  const headings: string[] = []
  const addBlock = (text: string) => {
    blocks.push({ id: `html-${blocks.length + 1}`, text, coordinate: { kind: 'html', path: headings.filter(Boolean), blockIndex: blocks.length } })
  }
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
        addBlock(text)
      }
      return
    }
    if (node.tagName && HTML_CONTAINERS.has(node.tagName)) {
      const text = normalized((node.childNodes ?? []).map(htmlContainerText).join(' '))
      if (text) addBlock(text)
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(root)
  return { text: blocks.map(block => block.text).join('\n'), blocks }
}

async function inspectDocxArchive(bytes: Uint8Array, limits: ParserLimits): Promise<void> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let offset = bytes.length - 22, minimum = Math.max(0, bytes.length - 65_557); offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset
      break
    }
  }
  if (end < 0) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  const commentLength = view.getUint16(end + 20, true)
  const entries = view.getUint16(end + 10, true)
  const centralSize = view.getUint32(end + 12, true)
  const centralOffset = view.getUint32(end + 16, true)
  if (end + 22 + commentLength !== bytes.length || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 8, true) !== entries || entries === 0 || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff || centralOffset + centralSize > end) {
    throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  }
  if (entries > limits.maxBlocks) throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
  let total = 0
  let offset = centralOffset
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    const flags = view.getUint16(offset + 8, true)
    if ((flags & 1) !== 0) throw new DocumentParserError('PARSER_ENCRYPTED_DOCUMENT')
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const declaredSize = view.getUint32(offset + 24, true)
    const name = view.getUint16(offset + 28, true)
    const extra = view.getUint16(offset + 30, true)
    const comment = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const next = offset + 46 + name + extra + comment
    if (next > end || compressedSize === 0xffffffff || declaredSize === 0xffffffff || localOffset === 0xffffffff || localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    }
    const localName = view.getUint16(localOffset + 26, true)
    const localExtra = view.getUint16(localOffset + 28, true)
    if ((view.getUint16(localOffset + 6, true) & 1) !== 0) throw new DocumentParserError('PARSER_ENCRYPTED_DOCUMENT')
    if (view.getUint16(localOffset + 8, true) !== method) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    const dataStart = localOffset + 30 + localName + localExtra
    const dataEnd = dataStart + compressedSize
    if (dataEnd > bytes.length) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')

    let actualSize = 0
    if (method === 0) {
      actualSize = compressedSize
      total += actualSize
      if (total > limits.maxDecompressedBytes) throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
    } else if (method === 8) {
      try {
        const compressed = bytes.slice(dataStart, dataEnd).buffer as ArrayBuffer
        const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          actualSize += chunk.value.byteLength
          total += chunk.value.byteLength
          if (total > limits.maxDecompressedBytes) {
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
    if (actualSize !== declaredSize) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
    offset = next
  }
  if (offset !== centralOffset + centralSize) throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
}

async function parseDocx(bytes: Uint8Array, limits: ParserLimits): Promise<ParsedDocument> {
  await inspectDocxArchive(bytes, limits)
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
  let task: ReturnType<typeof getDocument> | undefined
  try {
    task = getDocument({
      data: bytes.slice(),
      maxDecodedStreamBytes: limits.maxDecompressedBytes,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
      enableXfa: false,
      verbosity: 0,
    })
    const document = await task.promise
    if (await document.getPermissions() !== null) throw new DocumentParserError('PARSER_ENCRYPTED_DOCUMENT')
    if (document.numPages > limits.maxPages) throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
    const blocks: ParserBlock[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = normalized(content.items.map(item => ('str' in item ? item.str : '')).join(' '))
      if (text) blocks.push({ id: `page-${pageNumber}`, text, coordinate: { kind: 'pdf', page: pageNumber, itemStart: 0, itemEnd: content.items.length } })
      page.cleanup()
    }
    if (blocks.length === 0) throw new DocumentParserError('PARSER_SCANNED_DOCUMENT')
    return { text: blocks.map(block => block.text).join('\n'), blocks }
  } catch (error) {
    if (error instanceof DocumentParserError) throw error
    const name = String((error as Error).name)
    if (/PasswordException/i.test(name)) throw new DocumentParserError('PARSER_ENCRYPTED_DOCUMENT')
    if (/PDF decoded stream limit exceeded/.test(String((error as Error).message))) {
      throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
    }
    throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  } finally {
    await task?.destroy().catch(() => undefined)
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
