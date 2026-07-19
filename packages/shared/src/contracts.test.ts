import { describe, expect, it } from 'vitest'
import { approvalDecisionSchema, toSafeAppError, workerMessageSchema } from './index'

describe('cross-process contracts', () => {
  it('rejects a persistent approval without an exact workflow version', () => {
    expect(() => approvalDecisionSchema.parse({
      executionId: 'exec_1', decision: 'always', workflowId: 'browser.search.baidu',
      capability: 'browser.open', scope: { origins: ['https://www.baidu.com'] },
    })).toThrow()
  })

  it('rejects an unknown worker message instead of forwarding it', () => {
    expect(() => workerMessageSchema.parse({ type: 'shell', command: 'pwd' })).toThrow()
  })

  it('accepts a version-bound persistent approval', () => {
    expect(approvalDecisionSchema.parse({
      executionId: 'exec_1', decision: 'always', workflowId: 'browser.search.baidu',
      workflowVersion: '1.0.0', capability: 'browser.open',
      scope: { origins: ['https://www.baidu.com'] },
    })).toMatchObject({ decision: 'always', workflowVersion: '1.0.0' })
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
})
