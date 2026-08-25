import { z } from 'zod'

export const DEFAULT_PARSER_LIMITS = Object.freeze({
  maxEncryptedBytes: 64 * 1024 * 1024,
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

const coordinateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pdf'), page: z.number().int().positive(), itemStart: z.number().int().nonnegative(), itemEnd: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('docx'), paragraphId: z.string().min(1).max(64), headingPath: z.array(z.string().max(512)).max(16) }).strict(),
  z.object({ kind: z.literal('txt'), lineStart: z.number().int().positive(), lineEnd: z.number().int().positive(), charStart: z.number().int().nonnegative(), charEnd: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.enum(['markdown', 'html']), path: z.array(z.string().max(512)).max(32), blockIndex: z.number().int().nonnegative() }).strict(),
])

const blockSchema = z.object({ id: z.string().min(1).max(128), text: z.string().max(DEFAULT_PARSER_LIMITS.maxTextChars), coordinate: coordinateSchema }).strict()
const chunkSchema = z.object({ index: z.number().int().nonnegative(), text: z.string().max(DEFAULT_PARSER_LIMITS.maxChunkChars), blockIds: z.array(z.string()).min(1).max(256) }).strict()

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

export function parseParserResponse(value: unknown): ParserResponse {
  const parsed = parserResponseSchema.safeParse(value)
  if (!parsed.success) throw new Error('Knowledge parser protocol is invalid')
  return parsed.data
}
