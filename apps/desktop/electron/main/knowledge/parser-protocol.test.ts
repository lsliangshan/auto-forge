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
})
