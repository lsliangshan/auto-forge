import { z } from 'zod'

export const DEFAULT_PARSER_LIMITS = Object.freeze({
  maxEncryptedBytes: 64 * 1024 * 1024 + 8 + 12 + 16,
  maxDecryptedBytes: 64 * 1024 * 1024,
  maxDecompressedBytes: 128 * 1024 * 1024,
  maxPages: 200,
  maxTextChars: 5_000_000,
  maxBlocks: 50_000,
  maxChunks: 10_000,
  maxChunkChars: 2_000,
  maxMemoryBytes: 256 * 1024 * 1024,
  timeoutMs: 120_000,
})

const limitsSchema = z.object({
  maxEncryptedBytes: z.number().int().positive().max(DEFAULT_PARSER_LIMITS.maxEncryptedBytes),
  maxDecryptedBytes: z.number().int().positive().max(DEFAULT_PARSER_LIMITS.maxDecryptedBytes),
  maxDecompressedBytes: z.number().int().positive().max(DEFAULT_PARSER_LIMITS.maxDecompressedBytes),
  maxPages: z.number().int().positive().max(DEFAULT_PARSER_LIMITS.maxPages),
  maxTextChars: z.number().int().positive().max(DEFAULT_PARSER_LIMITS.maxTextChars),
  maxBlocks: z.number().int().positive().max(DEFAULT_PARSER_LIMITS.maxBlocks),
  maxChunks: z.number().int().positive().max(DEFAULT_PARSER_LIMITS.maxChunks),
  maxChunkChars: z.number().int().min(128).max(DEFAULT_PARSER_LIMITS.maxChunkChars),
  maxMemoryBytes: z.number().int().min(64 * 1024 * 1024).max(DEFAULT_PARSER_LIMITS.maxMemoryBytes),
  timeoutMs: z.number().int().min(100).max(DEFAULT_PARSER_LIMITS.timeoutMs),
}).strict()

const arrayBufferSchema = z.custom<ArrayBuffer>(value => value instanceof ArrayBuffer)
const formatSchema = z.enum(['pdf', 'docx', 'txt', 'markdown', 'html'])

export const parserRequestSchema = z.object({
  version: z.literal(1),
  type: z.literal('parse'),
  jobId: z.string().trim().min(1).max(128),
  format: formatSchema,
  encryptedBytes: arrayBufferSchema.refine(value => value.byteLength > 0 && value.byteLength <= DEFAULT_PARSER_LIMITS.maxEncryptedBytes),
  fileKey: arrayBufferSchema.refine(value => value.byteLength === 32),
  limits: limitsSchema,
}).strict()

const safeNonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const safePositive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const coordinateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pdf'), page: safePositive, itemStart: safeNonnegative, itemEnd: safeNonnegative }).strict(),
  z.object({ kind: z.literal('docx'), paragraphId: z.string().min(1).max(64), headingPath: z.array(z.string().max(512)).max(16) }).strict(),
  z.object({ kind: z.literal('txt'), lineStart: safePositive, lineEnd: safePositive, charStart: safeNonnegative, charEnd: safeNonnegative }).strict(),
  z.object({ kind: z.enum(['markdown', 'html']), path: z.array(z.string().max(512)).max(32), blockIndex: safeNonnegative }).strict(),
])

const blockSchema = z.object({ id: z.string().min(1).max(128), text: z.string().max(DEFAULT_PARSER_LIMITS.maxTextChars), coordinate: coordinateSchema }).strict()
const chunkSchema = z.object({ index: safeNonnegative, text: z.string().max(DEFAULT_PARSER_LIMITS.maxChunkChars), blockIds: z.array(z.string().min(1).max(128)).min(1).max(256) }).strict()

const resultSchema = z.object({
  version: z.literal(1), type: z.literal('result'), jobId: z.string().min(1).max(128),
  text: z.string().max(DEFAULT_PARSER_LIMITS.maxTextChars),
  blocks: z.array(blockSchema).max(DEFAULT_PARSER_LIMITS.maxBlocks),
  chunks: z.array(chunkSchema).max(DEFAULT_PARSER_LIMITS.maxChunks),
}).strict()
const errorCodeSchema = z.enum([
  'PARSER_UNSUPPORTED_FORMAT', 'PARSER_MALFORMED_DOCUMENT', 'PARSER_ENCRYPTED_DOCUMENT',
  'PARSER_SCANNED_DOCUMENT', 'PARSER_LIMIT_EXCEEDED', 'PARSER_TIMEOUT', 'PARSER_CANCELLED',
  'PARSER_PROTOCOL_INVALID', 'PARSER_INTERNAL_ERROR',
])
const errorSchema = z.object({ version: z.literal(1), type: z.literal('error'), jobId: z.string().min(1).max(128), code: errorCodeSchema }).strict()
export const parserResponseSchema = z.discriminatedUnion('type', [resultSchema, errorSchema])

export type ParserRequest = z.infer<typeof parserRequestSchema>
export type ParserResponse = z.infer<typeof parserResponseSchema>
export type ParserLimits = z.infer<typeof limitsSchema>
export type ParserFormat = z.infer<typeof formatSchema>
export type ParserBlock = z.infer<typeof blockSchema>

export function parseParserRequest(value: unknown): ParserRequest {
  const parsed = parserRequestSchema.safeParse(value)
  if (!parsed.success) throw new Error('Knowledge parser protocol is invalid')
  return parsed.data
}

export interface ParserResponseContext {
  readonly jobId: string
  readonly format: ParserFormat
  readonly limits: ParserLimits
}

function responseMatchesContext(response: ParserResponse, context: ParserResponseContext): boolean {
  if (response.jobId !== context.jobId) return false
  if (response.type === 'error') return true
  const { limits, format } = context
  if (response.text.length > limits.maxTextChars || response.blocks.length > limits.maxBlocks || response.chunks.length > limits.maxChunks) return false
  if (response.blocks.reduce((total, block) => total + block.text.length, 0) > limits.maxTextChars) return false
  if (response.chunks.reduce((total, chunk) => total + chunk.text.length, 0) > limits.maxTextChars) return false
  const ids = new Set<string>()
  let idCharacters = 0
  let coordinateCharacters = 0
  for (const block of response.blocks) {
    if (ids.has(block.id)) return false
    ids.add(block.id)
    idCharacters += block.id.length
    if (idCharacters > limits.maxBlocks * 128) return false
    if (block.text.length > limits.maxTextChars || block.coordinate.kind !== format) return false
    const coordinate = block.coordinate
    if (coordinate.kind === 'pdf' && (coordinate.page > limits.maxPages || coordinate.itemStart > coordinate.itemEnd || coordinate.itemEnd > limits.maxTextChars)) return false
    if (coordinate.kind === 'txt' && (coordinate.lineStart > coordinate.lineEnd || coordinate.lineEnd > limits.maxTextChars + 1 || coordinate.charStart > coordinate.charEnd || coordinate.charEnd > limits.maxTextChars)) return false
    if ((coordinate.kind === 'markdown' || coordinate.kind === 'html') && coordinate.blockIndex >= limits.maxBlocks) return false
    if (coordinate.kind === 'docx') coordinateCharacters += coordinate.paragraphId.length + coordinate.headingPath.reduce((total, part) => total + part.length, 0)
    if (coordinate.kind === 'markdown' || coordinate.kind === 'html') coordinateCharacters += coordinate.path.reduce((total, part) => total + part.length, 0)
    if (coordinateCharacters > limits.maxTextChars + response.blocks.length * 128) return false
  }
  let referenceCount = 0
  let referenceCharacters = 0
  for (const [index, chunk] of response.chunks.entries()) {
    if (chunk.index !== index || chunk.text.length > limits.maxChunkChars || chunk.blockIds.length > Math.min(256, limits.maxBlocks)) return false
    if (chunk.blockIds.some(id => !ids.has(id))) return false
    referenceCount += chunk.blockIds.length
    referenceCharacters += chunk.blockIds.reduce((total, id) => total + id.length, 0)
    if (referenceCount > response.chunks.length || referenceCharacters > response.chunks.length * 128) return false
  }
  return true
}

export function parseParserResponse(value: unknown, context?: ParserResponseContext): ParserResponse {
  const parsed = parserResponseSchema.safeParse(value)
  if (!parsed.success || context && !responseMatchesContext(parsed.data, context)) throw new Error('Knowledge parser protocol is invalid')
  return parsed.data
}
