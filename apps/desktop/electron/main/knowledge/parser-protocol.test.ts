import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARSER_LIMITS,
  PARSER_RESPONSE_CHUNK_BYTES,
  parseParserRequest,
  parseParserResponse,
  parseParserResponseChunk,
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

  it('rejects uncoordinated text and unstable or repeated format coordinates', () => {
    const context = {
      jobId: 'job-1',
      mediaType: 'text/plain' as const,
      limits: DEFAULT_PARSER_LIMITS,
    }
    const block = (id: string, text: string, line: number, start: number) => ({
      id,
      text,
      coordinate: {
        kind: 'txt' as const,
        lineStart: line,
        lineEnd: line,
        charStart: start,
        charEnd: start + text.length,
      },
    })
    for (const document of [
      { mediaType: 'text/plain', text: 'prefix\na', blocks: [block('line-1', 'a', 1, 7)] },
      { mediaType: 'text/plain', text: 'a\nsuffix', blocks: [block('line-1', 'a', 1, 0)] },
      {
        mediaType: 'text/plain',
        text: 'a\nb',
        blocks: [block('line-2', 'a', 2, 0), block('line-1', 'b', 1, 2)],
      },
    ]) {
      expect(() => parseParserResponse({ version: 1, type: 'result', jobId: 'job-1', document }, context))
        .toThrow(/protocol/i)
    }

    const pdfContext = { ...context, mediaType: 'application/pdf' as const }
    expect(() => parseParserResponse({
      version: 1,
      type: 'result',
      jobId: 'job-1',
      document: {
        mediaType: 'application/pdf',
        text: 'later\nearlier',
        blocks: [
          { id: 'page-2', text: 'later', coordinate: { kind: 'pdf', page: 2, itemStart: 0, itemEnd: 1 } },
          { id: 'page-1', text: 'earlier', coordinate: { kind: 'pdf', page: 1, itemStart: 0, itemEnd: 1 } },
        ],
      },
    }, pdfContext)).toThrow(/protocol/i)

    const docxContext = {
      ...context,
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const,
    }
    expect(() => parseParserResponse({
      version: 1,
      type: 'result',
      jobId: 'job-1',
      document: {
        mediaType: docxContext.mediaType,
        text: 'a',
        blocks: [{
          id: 'p-9',
          text: 'a',
          coordinate: { kind: 'docx', paragraphId: 'p-9', headingPath: [] },
        }],
      },
    }, docxContext)).toThrow(/protocol/i)
  })

  it('accepts only canonical bounded Uint8Array response chunks', () => {
    const frame = (bytes: ArrayBufferView) => ({
      version: 1,
      type: 'response-chunk',
      index: 0,
      totalChunks: 1,
      totalBytes: bytes.byteLength,
      bytes,
    })
    expect(parseParserResponseChunk(frame(new Uint8Array([1])), 128).bytes)
      .toEqual(new Uint8Array([1]))

    const giantBacking = new Uint8Array(PARSER_RESPONSE_CHUNK_BYTES * 4)
    for (const bytes of [
      giantBacking.subarray(1, 2),
      new DataView(new ArrayBuffer(1)),
      new Uint16Array(1),
      new Uint8Array(PARSER_RESPONSE_CHUNK_BYTES + 1),
    ]) {
      expect(() => parseParserResponseChunk(frame(bytes), PARSER_RESPONSE_CHUNK_BYTES * 2))
        .toThrow(/protocol/i)
    }
  })

  it('rejects non-canonical PDF item coordinates', () => {
    const context = {
      jobId: 'job-1',
      mediaType: 'application/pdf' as const,
      limits: DEFAULT_PARSER_LIMITS,
    }
    const response = (itemStart: number, itemEnd: number) => ({
      version: 1,
      type: 'result',
      jobId: 'job-1',
      document: {
        mediaType: 'application/pdf',
        text: 'page text',
        blocks: [{
          id: 'page-1',
          text: 'page text',
          coordinate: { kind: 'pdf', page: 1, itemStart, itemEnd },
        }],
      },
    })
    expect(() => parseParserResponse(response(1, 2), context)).toThrow(/protocol/i)
    expect(() => parseParserResponse(response(0, 0), context)).toThrow(/protocol/i)
  })
})
