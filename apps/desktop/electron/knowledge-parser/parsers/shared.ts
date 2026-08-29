import type {
  ParsedDocument,
  ParserErrorCode,
  ParserLimits,
} from '../../main/knowledge/parser-protocol.js'

export class DocumentParserError extends Error {
  constructor(readonly code: ParserErrorCode) {
    super(code)
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new DocumentParserError('PARSER_MALFORMED_DOCUMENT')
  }
}

export function normalized(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
}

export function enforceDocument(document: ParsedDocument, limits: ParserLimits): ParsedDocument {
  const blockTextChars = document.blocks.reduce((total, block) => total + block.text.length, 0)
  if (
    document.text.length > limits.maxTextChars
    || blockTextChars > limits.maxTextChars
    || document.blocks.length > limits.maxBlocks
  ) {
    throw new DocumentParserError('PARSER_LIMIT_EXCEEDED')
  }
  return document
}
