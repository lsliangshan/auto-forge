import { describe, expect, it } from 'vitest'
import { approvalDecisionSchema, executionEventSchema, toSafeAppError, workerMessageSchema } from './index'

describe('cross-process contracts', () => {
  it('rejects a persistent approval without an exact workflow version', () => {
    expect(() => approvalDecisionSchema.parse({
      executionId: 'exec_1', decision: 'always', workflowId: 'browser.search.baidu',
      permissionIndex: 0, scopeHash: 'a'.repeat(64),
      capability: 'browser.open', scope: { origins: ['https://www.baidu.com'] },
    })).toThrow()
  })

  it('rejects an unknown worker message instead of forwarding it', () => {
    expect(() => workerMessageSchema.parse({ type: 'shell', command: 'pwd' })).toThrow()
  })

  it('accepts a version-bound persistent approval', () => {
    expect(approvalDecisionSchema.parse({
      executionId: 'exec_1', decision: 'always', workflowId: 'browser.search.baidu',
      permissionIndex: 0, scopeHash: 'a'.repeat(64),
      workflowVersion: '1.0.0', capability: 'browser.open',
      scope: { origins: ['https://www.baidu.com'] },
    })).toMatchObject({ decision: 'always', workflowVersion: '1.0.0' })
  })

  it('requires exact identity on a dynamic execution approval event', () => {
    expect(executionEventSchema.parse({
      type: 'approval_required',
      executionId: 'exec_1',
      permissionIndex: 1,
      capability: 'browser.fill',
      scope: { origins: ['https://www.baidu.com'] },
      scopeHash: 'a'.repeat(64),
      occurredAt: '2026-07-19T00:00:00.000Z',
    })).toMatchObject({ type: 'approval_required', permissionIndex: 1 })
  })

  it('accepts a fixed worker response discriminator', () => {
    expect(workerMessageSchema.parse({
      type: 'log', level: 'info', message: 'Opening browser',
    })).toMatchObject({ type: 'log', level: 'info' })
  })

  it('normalizes unknown errors without exposing their value', () => {
    expect(toSafeAppError('secret')).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Unexpected application error',
    })
  })

  it('does not expose a native error message containing credentials', () => {
    const result = toSafeAppError(new Error('Authorization: Bearer sk-secret'))

    expect(result).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Unexpected application error',
    })
    expect(JSON.stringify(result)).not.toContain('sk-secret')
  })

  it('keeps only the safe code from an error-like object with sensitive details', () => {
    const result = toSafeAppError({
      code: 'INVALID_INPUT',
      message: 'Invalid request',
      details: { apiKey: 'sk-secret', path: '/private/user/path' },
    })

    expect(result).toEqual({
      code: 'INVALID_INPUT',
      message: 'The request is invalid.',
    })
    expect(JSON.stringify(result)).not.toContain('sk-secret')
    expect(JSON.stringify(result)).not.toContain('/private/user/path')
  })
})
