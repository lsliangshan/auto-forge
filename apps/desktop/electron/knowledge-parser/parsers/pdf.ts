import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'
import type { ParsedDocument, ParserLimits } from '../../main/knowledge/parser-protocol.js'
import { DocumentParserError, normalized } from './shared.js'

if (typeof window !== 'undefined') GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export async function parsePdf(bytes: Uint8Array, limits: ParserLimits): Promise<ParsedDocument> {
  let task: ReturnType<typeof getDocument> | undefined
  const pdfBytes = bytes.slice()
  try {
    task = getDocument({
      data: pdfBytes,
      maxDecodedStreamBytes: limits.maxExpandedBytes,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
      enableXfa: false,
      stopAtErrors: true,
      verbosity: 0,
    })
    const pdf = await task.promise
    if (await pdf.getPermissions() !== null) throw new DocumentParserError('PARSER_ENCRYPTED_DOCUMENT')
    if (pdf.numPages > limits.maxPages) throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
    const blocks: ParsedDocument['blocks'] = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const text = normalized(content.items.map(item => ('str' in item ? item.str : '')).join(' '))
        if (text) {
          blocks.push({
            id: `page-${pageNumber}`,
            text,
            coordinate: { kind: 'pdf', page: pageNumber, itemStart: 0, itemEnd: content.items.length },
          })
        }
      } finally {
        page.cleanup()
      }
    }
    if (blocks.length === 0) throw new DocumentParserError('PARSER_SCANNED_DOCUMENT')
    return { mediaType: 'application/pdf', text: blocks.map(block => block.text).join('\n'), blocks }
  } catch (error) {
    if (error instanceof DocumentParserError) throw error
    if (/PasswordException/i.test(String((error as Error).name))) {
      throw new DocumentParserError('PARSER_ENCRYPTED_DOCUMENT')
    }
    if (/PDF decoded stream limit exceeded/.test(String((error as Error).message))) {
      throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
    }
    throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  } finally {
    await task?.destroy().catch(() => undefined)
    if (pdfBytes.byteLength > 0) pdfBytes.fill(0)
  }
}
