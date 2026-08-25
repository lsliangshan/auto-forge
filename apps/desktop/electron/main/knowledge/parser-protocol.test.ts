import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARSER_LIMITS,
  parseParserRequest,
  parseParserResponse,
} from './parser-protocol.js'

function request(): unknown {
  return {
    version: 1,
    type: 'parse',
    jobId: 'job-1',
    format: 'txt',
    encryptedBytes: new ArrayBuffer(32),
    fileKey: new ArrayBuffer(32),
    limits: DEFAULT_PARSER_LIMITS,
  }
}

describe('knowledge parser protocol', () => {
  it('accepts only encrypted bytes, one-time file key, format, job id, and bounded limits', () => {
    expect(parseParserRequest(request())).toMatchObject({ version: 1, jobId: 'job-1', format: 'txt' })
    for (const forbidden of ['path', 'userMasterKey', 'safeStorage', 'env', 'providerKey', 'cloudbaseCredential']) {
      expect(() => parseParserRequest({ ...(request() as object), [forbidden]: 'secret' })).toThrow(/protocol/i)
    }
  })

  it('rejects unsupported formats, invalid keys, excessive limits, and extra response fields', () => {
    expect(() => parseParserRequest({ ...(request() as object), format: 'xlsx' })).toThrow(/protocol/i)
    expect(() => parseParserRequest({ ...(request() as object), fileKey: new ArrayBuffer(31) })).toThrow(/protocol/i)
    expect(() => parseParserRequest({ ...(request() as object), limits: { ...DEFAULT_PARSER_LIMITS, maxPages: 10_000 } })).toThrow(/protocol/i)
    expect(() => parseParserResponse({
      version: 1, type: 'error', jobId: 'job-1', code: 'PARSER_CANCELLED', leakedPath: '/secret',
    })).toThrow(/protocol/i)
  })

  it('allows the AEAD envelope around a maximum-size decrypted object', () => {
    const encryptedBytes = new ArrayBuffer(DEFAULT_PARSER_LIMITS.maxEncryptedBytes)
    expect(() => parseParserRequest({ ...(request() as object), encryptedBytes })).not.toThrow()
  })

  it('enforces caller-lowered aggregate response limits and format coordinates', () => {
    const response = {
      version: 1, type: 'result', jobId: 'job-1', text: '123456',
      blocks: [{ id: 'line-1', text: '123456', coordinate: { kind: 'txt', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 6 } }],
      chunks: [{ index: 0, text: '123456', blockIds: ['line-1'] }],
    }
    const limits = { ...DEFAULT_PARSER_LIMITS, maxTextChars: 5, maxChunkChars: 128 }
    expect(() => parseParserResponse(response, { jobId: 'job-1', format: 'txt', limits })).toThrow(/protocol/i)
    expect(() => parseParserResponse({
      ...response, text: '123', blocks: [{ id: 'line-1', text: '123', coordinate: { kind: 'pdf', page: 1, itemStart: 0, itemEnd: 1 } }],
      chunks: [{ index: 0, text: '123', blockIds: ['line-1'] }],
    }, { jobId: 'job-1', format: 'txt', limits: DEFAULT_PARSER_LIMITS })).toThrow(/protocol/i)
  })
})
