import { describe, expect, it } from 'vitest'
import {
  appErrorCodeSchema,
  appSettingsSchema,
  approvalDecisionSchema,
  chatBlockSchema,
  executionEventSchema,
  ipcRequestSchemas,
  ipcChannels,
  providerCredentialStatusSchema,
  toSafeAppError,
  workerMessageSchema,
} from './index'

describe('cross-process contracts', () => {
  it('accepts only fixed model providers with independent defaults', () => {
    const settings = appSettingsSchema.parse({
      theme: 'system',
      language: 'zh-CN',
      dataDirectory: '/data',
      logDirectory: '/logs',
      activeProvider: 'deepseek',
      defaultModels: {
        deepseek: 'deepseek-v4-flash',
        openrouter: 'openai/gpt-4.1-mini',
      },
      showCosts: true,
      developerMode: false,
      permissionDefault: 'ask',
    })

    expect(settings.activeProvider).toBe('deepseek')
    expect(() => appSettingsSchema.parse({ ...settings, activeProvider: 'custom' })).toThrow()
  })

  it('requires provider-scoped credential status without exposing a key', () => {
    const status = providerCredentialStatusSchema.parse({
      provider: 'deepseek',
      configured: true,
      validation: 'valid',
    })

    expect(status).toEqual({
      provider: 'deepseek',
      configured: true,
      validation: 'valid',
    })
    expect(status).not.toHaveProperty('apiKey')
    expect(providerCredentialStatusSchema.parse({
      provider: 'openrouter',
      configured: true,
      validation: 'denied',
    }).validation).toBe('denied')
  })

  it('declares provider-aware settings channels and a neutral provider error', () => {
    expect(ipcChannels.settingsSaveProviderApiKey).toBe('settings:save-provider-api-key')
    expect(ipcChannels.settingsClearProviderApiKey).toBe('settings:clear-provider-api-key')
    expect(ipcChannels.settingsValidateProviderCredential).toBe('settings:validate-provider-credential')
    expect(ipcChannels.settingsListProviderModels).toBe('settings:list-provider-models')
    expect(appErrorCodeSchema.parse('MODEL_PROVIDER_ACCESS_DENIED')).toBe('MODEL_PROVIDER_ACCESS_DENIED')
    expect(appErrorCodeSchema.parse('MODEL_PROVIDER_REQUEST_FAILED')).toBe('MODEL_PROVIDER_REQUEST_FAILED')
    expect(appErrorCodeSchema.parse('OPENROUTER_REQUEST_FAILED')).toBe('OPENROUTER_REQUEST_FAILED')
  })

  it('requires exact pending workflow identity on approval blocks', () => {
    expect(() => chatBlockSchema.parse({
      type: 'approval', executionId: 'exec_1', permissionIndex: 0,
      capability: 'browser.navigate', scope: { origins: ['https://www.baidu.com'] }, scopeHash: 'a'.repeat(64),
    })).toThrow()
  })
  it('requires exact workflow identity for removal', () => {
    expect(ipcRequestSchemas[ipcChannels.workflowsRemove].parse({ id: 'browser.search.baidu', version: '1.0.0' }))
      .toEqual({ id: 'browser.search.baidu', version: '1.0.0' })
    expect(() => ipcRequestSchemas[ipcChannels.workflowsRemove].parse({ id: 'browser.search.baidu' })).toThrow()
  })

  it('requires a conversation identity when reading persisted messages', () => {
    expect(ipcRequestSchemas[ipcChannels.chatListMessages].parse({ conversationId: 'conversation_1' }))
      .toEqual({ conversationId: 'conversation_1' })
    expect(() => ipcRequestSchemas[ipcChannels.chatListMessages].parse({})).toThrow()
  })

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
