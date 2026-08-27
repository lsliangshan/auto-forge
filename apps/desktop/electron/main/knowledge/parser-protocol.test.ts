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
    mediaType: 'text/plain',
    encryptedSnapshot: new ArrayBuffer(64),
    oneTimeKey: new ArrayBuffer(32),
    limits: DEFAULT_PARSER_LIMITS,
  }
}

describe('knowledge parser protocol', () => {
  it('accepts only an encrypted snapshot, one-time key, media type, job id, and bounded limits', () => {
    expect(parseParserRequest(request())).toMatchObject({
      version: 1,
      jobId: 'job-1',
      mediaType: 'text/plain',
    })

    for (const forbidden of [
      'path',
      'objectHandle',
      'masterKey',
      'safeStorage',
      'env',
      'providerCredential',
      'cloudbaseCredential',
    ]) {
      expect(() => parseParserRequest({ ...(request() as object), [forbidden]: 'secret' }))
        .toThrow(/protocol/i)
    }
  })

  it('rejects unsupported media, invalid keys, excessive limits, and extra response fields', () => {
    expect(() => parseParserRequest({ ...(request() as object), mediaType: 'application/vnd.ms-excel' }))
      .toThrow(/protocol/i)
    expect(() => parseParserRequest({ ...(request() as object), oneTimeKey: new ArrayBuffer(31) }))
      .toThrow(/protocol/i)
    expect(() => parseParserRequest({
      ...(request() as object),
      limits: { ...DEFAULT_PARSER_LIMITS, maxPages: DEFAULT_PARSER_LIMITS.maxPages + 1 },
    })).toThrow(/protocol/i)
    expect(() => parseParserResponse({
      version: 1,
      type: 'error',
      jobId: 'job-1',
      code: 'PARSER_CANCELLED',
      leakedPath: '/private/document.txt',
    })).toThrow(/protocol/i)
  })

  it('enforces caller-lowered text, block, response, and coordinate limits', () => {
    const response = {
      version: 1,
      type: 'result',
      jobId: 'job-1',
      document: {
        mediaType: 'text/plain',
        text: '123456',
        blocks: [{
          id: 'line-1',
          text: '123456',
          coordinate: {
            kind: 'txt',
            lineStart: 1,
            lineEnd: 1,
            charStart: 0,
            charEnd: 6,
          },
        }],
      },
    }
    const lowered = {
      ...DEFAULT_PARSER_LIMITS,
      maxTextChars: 5,
      maxResponseBytes: 256,
    }
    expect(() => parseParserResponse(response, {
      jobId: 'job-1',
      mediaType: 'text/plain',
      limits: lowered,
    })).toThrow(/protocol/i)

    const wrongCoordinate = {
      ...response,
      document: {
        ...response.document,
        text: '123',
        blocks: [{
          id: 'page-1',
          text: '123',
          coordinate: { kind: 'pdf', page: 1, itemStart: 0, itemEnd: 1 },
        }],
      },
    }
    expect(() => parseParserResponse(wrongCoordinate, {
      jobId: 'job-1',
      mediaType: 'text/plain',
      limits: DEFAULT_PARSER_LIMITS,
    })).toThrow(/protocol/i)
  })

  it('rejects aggregate metadata amplification and oversized serialized responses', () => {
    const limits = {
      ...DEFAULT_PARSER_LIMITS,
      maxTextChars: 8,
      maxBlocks: 2,
      maxResponseBytes: 220,
    }
    const response = {
      version: 1,
      type: 'result',
      jobId: 'job-1',
      document: {
        mediaType: 'text/markdown',
        text: 'ab',
        blocks: [
          { id: 'a', text: 'a', coordinate: { kind: 'markdown', path: ['x'.repeat(512)], blockIndex: 0 } },
          { id: 'b', text: 'b', coordinate: { kind: 'markdown', path: ['y'.repeat(512)], blockIndex: 1 } },
        ],
      },
    }
    expect(() => parseParserResponse(response, {
      jobId: 'job-1',
      mediaType: 'text/markdown',
      limits,
    })).toThrow(/protocol/i)
  })

  it('rejects coordinates outside returned text and text that disagrees with structural blocks', () => {
    const response = {
      version: 1,
      type: 'result',
      jobId: 'job-1',
      document: {
        mediaType: 'text/plain',
        text: 'abc',
        blocks: [{
          id: 'line-1',
          text: 'abc',
          coordinate: {
            kind: 'txt',
            lineStart: 1,
            lineEnd: 1,
            charStart: 0,
            charEnd: 99,
          },
        }],
      },
    }
    expect(() => parseParserResponse(response, {
      jobId: 'job-1',
      mediaType: 'text/plain',
      limits: DEFAULT_PARSER_LIMITS,
    })).toThrow(/protocol/i)
    expect(() => parseParserResponse({
      ...response,
      document: {
        ...response.document,
        text: 'different',
        blocks: [{
          ...response.document.blocks[0],
          coordinate: { ...response.document.blocks[0]!.coordinate, charEnd: 3 },
        }],
      },
    }, {
      jobId: 'job-1',
      mediaType: 'text/plain',
      limits: DEFAULT_PARSER_LIMITS,
    })).toThrow(/protocol/i)
  })
})
