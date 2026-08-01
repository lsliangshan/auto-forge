import { describe, expect, it } from 'vitest'
import type { Message } from '../database/repositories.js'
import {
  currentMediaTokenReserve,
  estimateRequestTokens,
  estimateTextTokens,
  serializeHistoricalMessage,
} from './conversation-context.js'

describe('conversation context primitives', () => {
  it('serializes text, workflows, failures, and attachment metadata without payloads, paths, or asset IDs', () => {
    const message: Message = {
      id: 'm1', conversationId: 'c1', role: 'assistant', ordinal: 1, createdAt: 1,
      blocks: [
        { type: 'text', text: '结果如下' },
        { type: 'workflow_proposal', workflowId: 'browser.search.baidu', workflowName: '百度搜索', args: { keyword: '天气' } },
        { type: 'execution_result', executionId: 'e1', summary: 'Workflow completed.' },
        { type: 'media', blockId: 'b1', assetId: 'asset-private-id', kind: 'image', purpose: 'output', name: 'weather.png', mimeType: 'image/png', byteSize: 2048 },
      ],
    }

    const serialized = serializeHistoricalMessage(message)
    const body = JSON.stringify(serialized)

    expect(serialized).toEqual({
      role: 'assistant',
      content: expect.stringContaining('weather.png'),
    })
    expect(body).toContain('browser.search.baidu')
    expect(body).not.toContain('asset-private-id')
    expect(body).not.toMatch(/base64|\/Users\/|file:\/\/|https?:\/\//i)
  })

  it('omits transient-only history and rejects unknown roles', () => {
    expect(serializeHistoricalMessage({
      id: 'm2', conversationId: 'c1', role: 'assistant', ordinal: 2, createdAt: 2,
      blocks: [{ type: 'reasoning_status', label: '思考中' }],
    })).toBeUndefined()
    expect(() => serializeHistoricalMessage({
      id: 'm3', conversationId: 'c1', role: 'system', ordinal: 3,
      createdAt: 3, blocks: [],
    })).toThrow('Historical message role is invalid')
  })

  it('serializes every non-transient parsed block without unapproved fields', () => {
    const serialized = serializeHistoricalMessage({
      id: 'm4', conversationId: 'c1', role: 'assistant', ordinal: 4, createdAt: 4,
      blocks: [
        { type: 'approval', executionId: 'execution-secret', workflowId: 'workflow', workflowVersion: '1.0.0', permissionIndex: 0, capability: 'filesystem.write', scope: { paths: ['/Users/private'] }, scopeHash: 'a'.repeat(64) },
        { type: 'workflow_execution', executionId: 'execution-1' },
        { type: 'error', code: 'WORKFLOW_FAILED', message: 'did not complete' },
        { type: 'media_generation', blockId: 'block-secret', jobId: 'job-secret', kind: 'video', status: 'failed', errorCode: 'MEDIA_GENERATION_FAILED' },
      ],
    })

    expect(serialized).toEqual({
      role: 'assistant',
      content: [
        '[工作流等待权限审批: workflow@1.0.0; 能力: filesystem.write]',
        '[工作流执行: execution-1]',
        '[请求失败: WORKFLOW_FAILED; did not complete]',
        '[video 生成状态: failed; MEDIA_GENERATION_FAILED]',
      ].join('\n'),
    })
    expect(JSON.stringify(serialized)).not.toMatch(/execution-secret|\/Users\/private|block-secret|job-secret/)
  })

  it('rejects unparsed historical block fields instead of serializing arbitrary media data', () => {
    expect(() => serializeHistoricalMessage({
      id: 'm5', conversationId: 'c1', role: 'user', ordinal: 5, createdAt: 5,
      blocks: [{
        type: 'media', blockId: 'b5', assetId: 'a5', kind: 'image', purpose: 'input',
        name: 'safe.png', mimeType: 'image/png', byteSize: 1,
        dataBase64: 'base64-private-payload',
      }],
    })).toThrow()
  })

  it('uses deterministic CJK, JSON, protocol, and tool overhead', () => {
    const short = estimateRequestTokens({
      messages: [{ role: 'user', content: 'hello 你好' }],
      tools: [],
      currentMedia: [],
    })
    const withTool = estimateRequestTokens({
      messages: [{ role: 'user', content: 'hello 你好' }],
      tools: [{ type: 'function', function: { name: 'search', description: '搜索', parameters: { type: 'object' } } }],
      currentMedia: [],
    })

    expect(estimateTextTokens('hello 你好')).toBe(4)
    expect(short).toBeGreaterThan(2)
    expect(withTool).toBeGreaterThan(short)
  })

  it('reserves exact media budgets, including duration caps', () => {
    expect(currentMediaTokenReserve({ kind: 'image' })).toBe(2_048)
    expect(currentMediaTokenReserve({ kind: 'audio', durationMs: 10_000 })).toBe(2_048)
    expect(currentMediaTokenReserve({ kind: 'audio' })).toBe(8_192)
    expect(currentMediaTokenReserve({ kind: 'audio', durationMs: 300_000 })).toBe(16_384)
    expect(currentMediaTokenReserve({ kind: 'video', durationMs: 60_000 })).toBe(7_680)
    expect(currentMediaTokenReserve({ kind: 'video' })).toBe(16_384)
    expect(currentMediaTokenReserve({ kind: 'video', durationMs: 300_000 })).toBe(16_384)
  })
})
