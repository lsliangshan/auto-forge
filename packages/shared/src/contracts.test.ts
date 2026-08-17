import { describe, expect, it } from 'vitest'
import {
  appErrorCodeSchema,
  appSettingsSchema,
  approvalDecisionSchema,
  authCredentialsSchema,
  chatBlockSchema,
  chatEventSchema,
  chatSendInputSchema,
  executionEventSchema,
  generationOptionsSchema,
  ipcRequestSchemas,
  ipcResponseSchemas,
  ipcChannels,
  mediaAssetSchema,
  mediaBlockSchema,
  modelInfoSchema,
  normalizeProxySettings,
  parseProxyBypassText,
  providerCredentialStatusSchema,
  proxySettingsSchema,
  toSafeAppError,
  tokenUsageSnapshotSchema,
  workerMessageSchema,
} from './index'

describe('cross-process contracts', () => {
  it('validates local authentication credentials by normalized account and code-point password length', () => {
    expect(authCredentialsSchema.parse({ account: '  Alice_1  ', password: '密码密码密码密码' }))
      .toEqual({ account: 'Alice_1', password: '密码密码密码密码' })
    expect(() => authCredentialsSchema.parse({ account: 'a b', password: 'password' })).toThrow()
    expect(() => authCredentialsSchema.parse({ account: 'alice', password: 'short' })).toThrow()
    expect(() => authCredentialsSchema.parse({ account: 'alice', password: 'x'.repeat(73) })).toThrow()
  })

  it('exposes fixed authentication IPC contracts', () => {
    expect(ipcChannels.authGetSession).toBe('auth:get-session')
    expect(ipcRequestSchemas[ipcChannels.authLogin].parse({ account: 'alice', password: 'password' }))
      .toEqual({ account: 'alice', password: 'password' })
    expect(ipcResponseSchemas[ipcChannels.authGetSession].parse(null)).toBeNull()
    expect(ipcResponseSchemas[ipcChannels.authRegister].parse({
      user: { id: 'user_1', account: 'Alice' },
      authenticatedAt: '2026-08-07T00:00:00.000Z',
    })).toMatchObject({ user: { account: 'Alice' } })
  })

  it.each(['AUTH_REQUIRED', 'AUTH_INVALID_CREDENTIALS', 'AUTH_ACCOUNT_EXISTS'] as const)(
    'keeps %s as a safe application error',
    (code) => expect(toSafeAppError({ code })).toMatchObject({ code }),
  )

  it('accepts only fixed model providers with independent defaults', () => {
    const settings = appSettingsSchema.parse({
      theme: 'system',
      language: 'zh-CN',
      dataDirectory: '/data',
      logDirectory: '/logs',
      activeProvider: 'deepseek',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openai/gpt-4.1-mini' },
      },
      showCosts: true,
      developerMode: false,
      permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    })

    expect(settings.activeProvider).toBe('deepseek')
    expect(() => appSettingsSchema.parse({ ...settings, activeProvider: 'custom' })).toThrow()
  })

  it('validates and normalizes strict proxy settings', () => {
    const proxy = {
      enabled: true,
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'https://proxy.example.com:8443',
      socketProxy: 'socks5://127.0.0.1:7891',
      bypassDomains: ['example.com', '*.internal.example', '10.0.0.0/8'],
    }

    expect(proxySettingsSchema.parse(proxy)).toEqual(proxy)
    expect(appSettingsSchema.parse({
      theme: 'system',
      language: 'zh-CN',
      dataDirectory: '/data',
      logDirectory: '/logs',
      activeProvider: 'deepseek',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openai/gpt-4.1-mini' },
      },
      showCosts: true,
      developerMode: false,
      permissionDefault: 'ask',
      proxy,
    }).proxy).toEqual(proxy)
    expect(appErrorCodeSchema.parse('NETWORK_PROXY_APPLY_FAILED'))
      .toBe('NETWORK_PROXY_APPLY_FAILED')

    expect(() => proxySettingsSchema.parse({ enabled: true, bypassDomains: [] })).toThrow()
    expect(() => proxySettingsSchema.parse({
      enabled: true,
      httpProxy: 'http://user:pass@127.0.0.1:7890',
      bypassDomains: [],
    })).toThrow()
    expect(() => proxySettingsSchema.parse({
      enabled: true,
      socketProxy: 'http://127.0.0.1:7891',
      bypassDomains: [],
    })).toThrow()
    expect(() => proxySettingsSchema.parse({
      enabled: true,
      httpsProxy: 'http://127.0.0.1',
      bypassDomains: [],
    })).toThrow()

    expect(parseProxyBypassText('Example.com,\n*.internal.example\nexample.com'))
      .toEqual(['example.com', '*.internal.example'])
    expect(parseProxyBypassText('example.com/24\nlocalhost/24')).toEqual([])
    expect(normalizeProxySettings({
      enabled: false,
      httpProxy: ' http://LOCALHOST:7890 ',
      bypassDomains: [' Example.com ', 'example.com'],
    })).toEqual({
      enabled: false,
      httpProxy: 'http://localhost:7890',
      bypassDomains: ['example.com'],
    })
  })

  it('preserves explicit default proxy ports for domains and IPv6 literals', () => {
    for (const [field, address, canonical] of [
      ['httpProxy', 'http://PROXY.example:80', 'http://proxy.example:80'],
      ['httpsProxy', 'https://PROXY.example:443', 'https://proxy.example:443'],
      ['httpProxy', 'http://[2001:db8::1]:80', 'http://[2001:db8::1]:80'],
      ['httpsProxy', 'https://[2001:db8::1]:443', 'https://[2001:db8::1]:443'],
    ] as const) {
      expect(normalizeProxySettings({
        enabled: true,
        [field]: address,
        bypassDomains: [],
      })).toEqual({
        enabled: true,
        [field]: canonical,
        bypassDomains: [],
      })
    }

    expect(() => proxySettingsSchema.parse({
      enabled: true,
      httpProxy: 'http://proxy.example',
      bypassDomains: [],
    })).toThrow()
  })

  it.each([
    ['httpProxy', 'http://proxy.example:0'],
    ['httpsProxy', 'https://proxy.example:0'],
    ['socketProxy', 'socks4://proxy.example:0'],
    ['socketProxy', 'socks5://proxy.example:0'],
  ] as const)('rejects port zero for %s', (field, address) => {
    expect(() => proxySettingsSchema.parse({
      enabled: true,
      [field]: address,
      bypassDomains: [],
    })).toThrow()
  })

  it('rejects every invalid bypass array entry instead of filtering it', () => {
    for (const bypassEntry of [
      'https://example.com',
      'example.com:443',
      'example.com/path',
      '',
      '   ',
      'example.com,internal.example',
      'example.com\ninternal.example',
    ]) {
      expect(() => proxySettingsSchema.parse({
        enabled: false,
        bypassDomains: [bypassEntry],
      })).toThrow()
    }

    expect(() => normalizeProxySettings({
      enabled: false,
      bypassDomains: ['example.com', 'https://private.example'],
    })).toThrow()
  })

  it('accepts strict persisted media blocks without paths or encoded bytes', () => {
    expect(chatBlockSchema.parse({
      type: 'media',
      blockId: 'block_1',
      assetId: 'asset_1',
      kind: 'image',
      purpose: 'input',
      name: 'photo.png',
      mimeType: 'image/png',
      byteSize: 12,
    })).toMatchObject({ assetId: 'asset_1', purpose: 'input' })

    expect(() => chatBlockSchema.parse({
      type: 'media',
      blockId: 'block_1',
      assetId: 'asset_1',
      kind: 'image',
      purpose: 'input',
      name: 'photo.png',
      mimeType: 'image/png',
      byteSize: 12,
      path: '/private/photo.png',
    })).toThrow()

    expect(() => mediaBlockSchema.parse({
      type: 'media',
      blockId: 'block_1',
      assetId: 'asset_1',
      kind: 'image',
      purpose: 'input',
      name: 'photo.png',
      mimeType: 'image/png',
      byteSize: 12,
      base64: 'c2VjcmV0',
    })).toThrow()
  })

  it('rejects paths and encoded bytes from public media asset metadata', () => {
    const asset = {
      id: 'asset_1',
      kind: 'image' as const,
      name: 'photo.png',
      mimeType: 'image/png',
      byteSize: 12,
    }

    expect(mediaAssetSchema.parse(asset)).toEqual(asset)
    expect(() => mediaAssetSchema.parse({ ...asset, path: '/private/photo.png' })).toThrow()
    expect(() => mediaAssetSchema.parse({ ...asset, base64: 'c2VjcmV0' })).toThrow()
  })

  it('requires exact conversation ownership for public draft removal', () => {
    const schema = ipcRequestSchemas[ipcChannels.mediaRemoveDraft]
    expect(schema.parse({
      conversationId: 'conversation_1',
      assetId: 'asset_1',
    })).toEqual({
      conversationId: 'conversation_1',
      assetId: 'asset_1',
    })
    expect(() => schema.parse({ assetId: 'asset_1' })).toThrow()
    expect(() => schema.parse({
      conversationId: 'conversation_1',
      assetId: 'asset_1',
      extra: true,
    })).toThrow()
  })

  it('applies only the documented generation defaults', () => {
    expect(generationOptionsSchema.parse({
      image: { count: 1 },
      audio: {},
      video: {},
    })).toEqual({
      image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      audio: { format: 'mp3' },
      video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
    })
  })

  it('requires capability-rich model metadata', () => {
    const model = modelInfoSchema.parse({
      id: 'openai/image-model',
      name: 'Image model',
      inputModalities: ['text', 'image'],
      outputModalities: ['image'],
      supportsTools: false,
      generation: {
        image: {
          resolutions: ['1K'],
          aspectRatios: ['auto'],
          formats: ['png'],
          maxCount: 1,
        },
      },
    })

    expect(model.generation.image?.formats).toEqual(['png'])
    expect(() => modelInfoSchema.parse({ ...model, supportsTools: undefined })).toThrow()
  })

  it('recognizes every safe media error code and no unknown code', () => {
    const safeMediaCodes = [
      'MEDIA_TYPE_UNSUPPORTED',
      'MEDIA_ATTACHMENT_LIMIT_EXCEEDED',
      'MEDIA_SIZE_LIMIT_EXCEEDED',
      'MEDIA_MIME_MISMATCH',
      'MEDIA_IMPORT_FAILED',
      'MEDIA_ASSET_UNAVAILABLE',
      'MEDIA_STORAGE_FULL',
      'MODEL_MODALITY_UNSUPPORTED',
      'MEDIA_GENERATION_FAILED',
      'MEDIA_DOWNLOAD_FAILED',
      'MEDIA_GENERATION_TIMEOUT',
    ] as const

    expect(safeMediaCodes.map((code) => appErrorCodeSchema.parse(code))).toEqual(safeMediaCodes)
    expect(() => appErrorCodeSchema.parse('MEDIA_UNKNOWN')).toThrow()
  })

  it('recognizes the safe context-limit error code', () => {
    expect(appErrorCodeSchema.parse('CONTEXT_LIMIT_EXCEEDED'))
      .toBe('CONTEXT_LIMIT_EXCEEDED')
  })

  it('replaces only the matching media block through a strict block update event', () => {
    expect(chatEventSchema.parse({
      type: 'block_update',
      conversationId: 'conversation_1',
      messageId: 'message_1',
      blockId: 'block_1',
      block: {
        type: 'media_generation',
        blockId: 'block_1',
        jobId: 'job_1',
        kind: 'video',
        status: 'in_progress',
      },
    })).toMatchObject({ type: 'block_update', blockId: 'block_1' })

    expect(() => chatEventSchema.parse({
      type: 'block_update',
      conversationId: 'conversation_1',
      messageId: 'message_1',
      blockId: 'block_1',
      block: {
        type: 'media_generation',
        blockId: 'block_2',
        jobId: 'job_1',
        kind: 'video',
        status: 'in_progress',
      },
    })).toThrow()
  })

  it('allows attachment-only understanding but rejects empty or encoded sends', () => {
    expect(chatSendInputSchema.parse({
      conversationId: 'conversation_1',
      content: '',
      assetIds: ['asset_1'],
      outputType: 'auto',
      generation: { image: { count: 1 }, audio: {}, video: {} },
    })).toMatchObject({ assetIds: ['asset_1'], outputType: 'auto' })

    expect(() => chatSendInputSchema.parse({
      conversationId: 'conversation_1',
      content: '',
      assetIds: [],
      outputType: 'text',
      generation: { image: { count: 1 }, audio: {}, video: {} },
    })).toThrow()

    expect(() => chatSendInputSchema.parse({
      conversationId: 'conversation_1',
      content: 'describe this image',
      assetIds: ['asset_1'],
      outputType: 'auto',
      generation: { image: { count: 1 }, audio: {}, video: {} },
      base64: 'c2VjcmV0',
    })).toThrow()
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

  it('requires internally consistent token usage snapshots', () => {
    const snapshot = {
      monthStartedAt: '2026-08-01T00:00:00.000Z',
      month: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        models: [{ model: 'alpha/model', inputTokens: 7, outputTokens: 3, totalTokens: 10 }],
      },
      allTime: {
        inputTokens: 9,
        outputTokens: 6,
        totalTokens: 15,
        models: [
          { model: 'alpha/model', inputTokens: 7, outputTokens: 3, totalTokens: 10 },
          { model: 'beta/model', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        ],
      },
    }

    expect(tokenUsageSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      month: { ...snapshot.month, totalTokens: 9 },
    })).toThrow()
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      allTime: {
        ...snapshot.allTime,
        models: [...snapshot.allTime.models, snapshot.allTime.models[0]],
      },
    })).toThrow()
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      month: { ...snapshot.month, inputTokens: Number.MAX_SAFE_INTEGER + 1 },
    })).toThrow()
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      monthStartedAt: 'not-a-timestamp',
    })).toThrow()
    for (const inputTokens of [-1, 1.5]) {
      expect(() => tokenUsageSnapshotSchema.parse({
        ...snapshot,
        month: { ...snapshot.month, inputTokens },
      })).toThrow()
    }
    expect(ipcChannels.settingsGetTokenUsage).toBe('settings:get-token-usage')
    expect(ipcRequestSchemas[ipcChannels.settingsGetTokenUsage].parse(undefined)).toBeUndefined()
    expect(ipcResponseSchemas[ipcChannels.settingsGetTokenUsage].parse(snapshot)).toEqual(snapshot)
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
