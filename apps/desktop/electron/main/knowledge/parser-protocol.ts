import { z } from 'zod'

export const DEFAULT_PARSER_LIMITS = Object.freeze({
  maxEncryptedBytes: 64 * 1024 * 1024 + 64,
  maxFileBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 128 * 1024 * 1024,
  maxPages: 200,
  maxTextChars: 5_000_000,
  maxBlocks: 50_000,
  maxMemoryBytes: 256 * 1024 * 1024,
  timeoutMs: 120_000,
  maxResponseBytes: 16 * 1024 * 1024,
})

export const PARSER_MEDIA_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/html',
] as const

const mediaTypeSchema = z.enum(PARSER_MEDIA_TYPES)
const limitsSchema = z.object({
  maxEncryptedBytes: z.number().int().positive().max(DEFAULT_PARSER_LIMITS.maxEncryptedBytes),
  maxFileBytes: z.number().int().positive().max(DEFAULT_PARSER_LIMITS.maxFileBytes),
  maxExpandedBytes: z.number().int().positive().max(DEFAULT_PARSER_LIMITS.maxExpandedBytes),
  maxPages: z.number().int().positive().max(DEFAULT_PARSER_LIMITS.maxPages),
  maxTextChars: z.number().int().positive().max(DEFAULT_PARSER_LIMITS.maxTextChars),
  maxBlocks: z.number().int().positive().max(DEFAULT_PARSER_LIMITS.maxBlocks),
  maxMemoryBytes: z.number().int().min(32 * 1024 * 1024).max(DEFAULT_PARSER_LIMITS.maxMemoryBytes),
  timeoutMs: z.number().int().min(50).max(DEFAULT_PARSER_LIMITS.timeoutMs),
  maxResponseBytes: z.number().int().min(128).max(DEFAULT_PARSER_LIMITS.maxResponseBytes),
}).strict()

const arrayBufferSchema = z.custom<ArrayBuffer>(value => value instanceof ArrayBuffer)

export const parserRequestSchema = z.object({
  version: z.literal(1),
  type: z.literal('parse'),
  jobId: z.string().trim().min(1).max(128),
  mediaType: mediaTypeSchema,
  encryptedSnapshot: arrayBufferSchema.refine(value => (
    value.byteLength > 0 && value.byteLength <= DEFAULT_PARSER_LIMITS.maxEncryptedBytes
  )),
  oneTimeKey: arrayBufferSchema.refine(value => value.byteLength === 32),
  limits: limitsSchema,
}).strict()

const safeNonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const safePositive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const coordinateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pdf'),
    page: safePositive,
    itemStart: safeNonnegative,
    itemEnd: safeNonnegative,
  }).strict(),
  z.object({
    kind: z.literal('docx'),
    paragraphId: z.string().min(1).max(64),
    headingPath: z.array(z.string().max(512)).max(16),
  }).strict(),
  z.object({
    kind: z.literal('txt'),
    lineStart: safePositive,
    lineEnd: safePositive,
    charStart: safeNonnegative,
    charEnd: safeNonnegative,
  }).strict(),
  z.object({
    kind: z.enum(['markdown', 'html']),
    path: z.array(z.string().max(512)).max(32),
    blockIndex: safeNonnegative,
  }).strict(),
])

const blockSchema = z.object({
  id: z.string().min(1).max(128),
  text: z.string().max(DEFAULT_PARSER_LIMITS.maxTextChars),
  coordinate: coordinateSchema,
}).strict()

const documentSchema = z.object({
  mediaType: mediaTypeSchema,
  text: z.string().max(DEFAULT_PARSER_LIMITS.maxTextChars),
  blocks: z.array(blockSchema).max(DEFAULT_PARSER_LIMITS.maxBlocks),
}).strict()

const resultSchema = z.object({
  version: z.literal(1),
  type: z.literal('result'),
  jobId: z.string().min(1).max(128),
  document: documentSchema,
}).strict()

export const parserErrorCodeSchema = z.enum([
  'PARSER_UNSUPPORTED_FORMAT',
  'PARSER_MALFORMED_DOCUMENT',
  'PARSER_ENCRYPTED_DOCUMENT',
  'PARSER_SCANNED_DOCUMENT',
  'PARSER_LIMIT_EXCEEDED',
  'PARSER_CANCELLED',
  'PARSER_TIMEOUT',
  'PARSER_PROTOCOL_INVALID',
  'PARSER_INTERNAL_ERROR',
])

const errorSchema = z.object({
  version: z.literal(1),
  type: z.literal('error'),
  jobId: z.string().min(1).max(128),
  code: parserErrorCodeSchema,
}).strict()

export const parserResponseSchema = z.discriminatedUnion('type', [resultSchema, errorSchema])

export type ParserLimits = z.infer<typeof limitsSchema>
export type ParserMediaType = z.infer<typeof mediaTypeSchema>
export type ParserRequest = z.infer<typeof parserRequestSchema>
export type ParserResponse = z.infer<typeof parserResponseSchema>
export type ParserErrorCode = z.infer<typeof parserErrorCodeSchema>
export type ParserBlock = z.infer<typeof blockSchema>
export type ParsedDocument = z.infer<typeof documentSchema>

export function parseParserRequest(value: unknown): ParserRequest {
  const parsed = parserRequestSchema.safeParse(value)
  if (!parsed.success) throw new Error('Knowledge parser protocol is invalid')
  return parsed.data
}

export interface ParserResponseContext {
  readonly jobId: string
  readonly mediaType: ParserMediaType
  readonly limits: ParserLimits
}

function coordinateMatchesMediaType(block: ParserBlock, mediaType: ParserMediaType): boolean {
  if (mediaType === 'application/pdf') return block.coordinate.kind === 'pdf'
  if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return block.coordinate.kind === 'docx'
  }
  if (mediaType === 'text/plain') return block.coordinate.kind === 'txt'
  if (mediaType === 'text/markdown') return block.coordinate.kind === 'markdown'
  return block.coordinate.kind === 'html'
}

function responseMatchesContext(response: ParserResponse, context: ParserResponseContext): boolean {
  if (response.jobId !== context.jobId) return false
  const serializedBytes = new TextEncoder().encode(JSON.stringify(response)).byteLength
  if (serializedBytes > context.limits.maxResponseBytes) return false
  if (response.type === 'error') return true

  const { document } = response
  if (document.mediaType !== context.mediaType) return false
  if (document.text.length > context.limits.maxTextChars) return false
  if (document.blocks.length > context.limits.maxBlocks) return false

  let blockTextChars = 0
  let metadataChars = 0
  let textCursor = 0
  const ids = new Set<string>()
  for (const [blockIndex, block] of document.blocks.entries()) {
    if (ids.has(block.id) || !coordinateMatchesMediaType(block, context.mediaType)) return false
    ids.add(block.id)
    blockTextChars += block.text.length
    metadataChars += block.id.length
    if (blockTextChars > context.limits.maxTextChars) return false
    const textPosition = document.text.indexOf(block.text, textCursor)
    if (textPosition < textCursor) return false
    textCursor = textPosition + block.text.length

    const coordinate = block.coordinate
    if (coordinate.kind === 'pdf') {
      if (coordinate.page > context.limits.maxPages || coordinate.itemStart > coordinate.itemEnd) return false
    } else if (coordinate.kind === 'txt') {
      if (
        coordinate.lineStart > coordinate.lineEnd
        || coordinate.charStart > coordinate.charEnd
        || coordinate.charEnd > document.text.length
        || document.text.slice(coordinate.charStart, coordinate.charEnd) !== block.text
      ) return false
    } else if (coordinate.kind === 'docx') {
      metadataChars += coordinate.paragraphId.length
        + coordinate.headingPath.reduce((total, part) => total + part.length, 0)
    } else {
      if (coordinate.blockIndex !== blockIndex) return false
      metadataChars += coordinate.path.reduce((total, part) => total + part.length, 0)
    }
    if (metadataChars > context.limits.maxResponseBytes) return false
  }
  return true
}

export function parseParserResponse(value: unknown, context?: ParserResponseContext): ParserResponse {
  const parsed = parserResponseSchema.safeParse(value)
  if (!parsed.success || (context && !responseMatchesContext(parsed.data, context))) {
    throw new Error('Knowledge parser protocol is invalid')
  }
  return parsed.data
}
