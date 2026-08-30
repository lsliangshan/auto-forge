import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import {
  createPostgresRpcClient,
  createUserDataHandler,
} from '../../cloudbase/user-data/function/user-data-handler.js'

const authenticatedContext = { auth: { uid: 'real_uid' } }
const occurredAt = '2026-08-24T00:00:00.000Z'
const opaqueCursor = '123e4567-e89b-12d3-a456-426614174000'

const consent = {
  purpose: 'cloud_sync',
  documentVersion: 'privacy-2026-08',
  consentedAt: occurredAt,
  clientVersion: '2.0.0',
}

const consentMutation = {
  id: 'mutation_1',
  entityId: 'privacy-2026-08',
  baseRevision: 0,
  occurredAt,
  kind: 'privacy.consent',
  payload: consent,
}

function messageMutation(blocks: unknown[]) {
  return {
    id: 'message_mutation_1',
    entityId: 'message_1',
    baseRevision: 0,
    occurredAt,
    kind: 'message.append',
    payload: {
      id: 'message_1',
      conversationId: 'conv_1',
      role: 'user',
      blocks,
      createdAt: occurredAt,
    },
  }
}

function approvalMutation(origin: string) {
  return messageMutation([{
    type: 'approval',
    blockId: 'block_1',
    state: 'pending',
    executionId: 'execution_1',
    workflowId: 'workflow_1',
    workflowName: 'Workflow',
    workflowVersion: '1.0.0',
    source: 'installed',
    actionSummary: 'Open the approved site',
    permissionIndex: 0,
    capability: 'browser.open',
    scope: { origins: [origin] },
    scopeHash: 'a'.repeat(64),
  }])
}

function fileConvertApprovalMutation(
  formats: string[],
  extraScope: Record<string, unknown> = {},
) {
  return messageMutation([{
    type: 'approval',
    blockId: 'conversion_approval_1',
    state: 'pending',
    executionId: 'execution_1',
    workflowId: 'file.convert.universal',
    workflowName: '万象转换',
    workflowVersion: '1.0.0',
    source: 'installed',
    actionSummary: '读取附件 1 并创建 PDF 结果',
    permissionIndex: 0,
    capability: 'file.convert',
    scope: { formats, ...extraScope },
    scopeHash: 'b'.repeat(64),
  }])
}

function conversionBlockMutation(extraBlock: Record<string, unknown> = {}) {
  return messageMutation([{
    type: 'conversion',
    blockId: 'conversion_block_1',
    executionId: 'execution_1',
    state: 'active',
    ...extraBlock,
  }])
}

function conversionTerminalMutation(extraPayload: Record<string, unknown> = {}) {
  return {
    id: 'conversion_terminal_mutation_1',
    entityId: 'message_1',
    baseRevision: 1,
    occurredAt,
    kind: 'message.conversion_block_terminal',
    payload: {
      messageId: 'message_1',
      blockId: 'conversion_block_1',
      executionId: 'execution_1',
      state: 'terminal',
      ...extraPayload,
    },
  }
}

function fileInputMutation(extraBlock: Record<string, unknown> = {}) {
  return messageMutation([{
    type: 'media',
    blockId: 'file_block_1',
    assetId: 'file_asset_1',
    kind: 'file',
    purpose: 'input',
    name: 'notes.txt',
    mimeType: 'text/plain',
    byteSize: 12,
    ...extraBlock,
  }])
}

function projectedConversionMessageMutation(
  providerProjection: unknown = {
    kind: 'local_conversion', targetFormat: 'pdf', attachmentCount: 1,
  },
) {
  const mutation = fileInputMutation()
  return {
    ...mutation,
    payload: {
      ...mutation.payload,
      blocks: [
        { type: 'text', text: 'Convert this attachment to PDF' },
        ...mutation.payload.blocks,
      ],
      providerProjection,
    },
  }
}

function mockRpcResponse(
  value: unknown,
  options: {
    ok?: boolean
    status?: number
    rawBody?: string
    contentLength?: string | null
  } = {},
) {
  const bodyText = options.rawBody ?? JSON.stringify(value)
  const bytes = new TextEncoder().encode(bodyText)
  let consumed = false
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: {
      get: vi.fn((name: string) => name.toLowerCase() === 'content-length'
        ? (options.contentLength === undefined ? String(bytes.byteLength) : options.contentLength)
        : null),
    },
    body: {
      getReader: () => ({
        read: vi.fn(async () => {
          if (consumed) return { done: true, value: undefined }
          consumed = true
          return { done: false, value: bytes }
        }),
        cancel: vi.fn().mockResolvedValue(undefined),
        releaseLock: vi.fn(),
      }),
    },
    json: vi.fn(async () => {
      if (options.rawBody !== undefined) return JSON.parse(options.rawBody)
      return value
    }),
  }
}

describe('CloudBase user data function', () => {
  it.each([
    { label: 'data object', envelope: (payload: unknown) => ({ data: payload }) },
    { label: 'body JSON', envelope: (payload: unknown) => ({ body: JSON.stringify(payload) }) },
    { label: 'request_data JSON', envelope: (payload: unknown) => ({ request_data: JSON.stringify(payload) }) },
    { label: 'direct data with TCB context', envelope: (payload: object) => ({ ...payload, tcbContext: 'platform metadata' }) },
  ])('unwraps the CloudBase $label envelope before strict action validation', async ({ envelope }) => {
    const rpc = vi.fn().mockResolvedValue({
      batchId: 'batch_1', status: 'applied', importedConversations: 0, importedMessages: 0,
    })
    const handler = createUserDataHandler({ rpc })

    await expect(handler(envelope({
      action: 'importLegacyBatch', protocolVersion: 1, deviceId: 'dev_1', batchId: 'batch_1',
      includeUnowned: false, conversations: [], messages: [], cloudSyncConsent: consent,
    }), authenticatedContext)).resolves.toEqual({
      ok: true,
      data: { batchId: 'batch_1', status: 'applied', importedConversations: 0, importedMessages: 0 },
    })
    expect(rpc).toHaveBeenCalledWith('autoforge_import_legacy_batch', expect.objectContaining({
      p_batch_id: 'batch_1',
    }))
  })

  it('labels legacy-import validation failures without returning user content', async () => {
    const handler = createUserDataHandler({ rpc: vi.fn() })

    await expect(handler({
      action: 'importLegacyBatch', protocolVersion: 1, deviceId: 'dev_1', batchId: 'batch_1',
      includeUnowned: false, conversations: [{ id: 'conv_1' }], messages: [], cloudSyncConsent: consent,
    }, authenticatedContext)).resolves.toEqual({
      ok: false, error: { code: 'INVALID_INPUT', stage: 'conversation' },
    })
  })


  it('uses a CommonJS entry compatible with the CloudBase index.main loader', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../../cloudbase/user-data/function/package.json', import.meta.url),
      'utf8',
    ))
    const entry = await readFile(
      new URL('../../cloudbase/user-data/function/index.js', import.meta.url),
      'utf8',
    )

    expect(packageJson).toMatchObject({ name: 'autoforge-user-data', type: 'commonjs', main: 'index.js' })
    expect(entry).toContain('exports.main = main')
    expect(entry).not.toMatch(/\bexport\s+(?:default|async|function|const|let|var|class)/)
  })

  it('requires a trusted context UID and rejects every event owner alias', async () => {
    const rpc = vi.fn()
    const handler = createUserDataHandler({ rpc })

    await expect(handler({
      action: 'syncPull', protocolVersion: 1, deviceId: 'dev_1',
    }, {})).resolves.toEqual({ ok: false, error: { code: 'AUTH_REQUIRED' } })

    for (const forgedIdentity of [
      { userId: 'forged' },
      { uid: 'forged' },
      { ownerUserId: 'forged' },
      { owner_user_id: 'forged' },
    ]) {
      await expect(handler({
        action: 'syncPull', protocolVersion: 1, deviceId: 'dev_1', ...forgedIdentity,
      }, authenticatedContext)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('derives compatible context identities and normalizes them to p_caller_user_id', async () => {
    const rpc = vi.fn().mockResolvedValue({ mutations: [], cursor: null })
    const handler = createUserDataHandler({ rpc })

    for (const context of [
      authenticatedContext,
      { userInfo: { uid: 'real_uid' } },
      { UID: 'real_uid' },
      { environment: JSON.stringify({ TCB_UUID: 'real_uid' }) },
    ]) {
      await expect(handler({
        action: 'syncPull', protocolVersion: 1, deviceId: 'dev_1',
      }, context)).resolves.toEqual({ ok: true, data: { mutations: [], cursor: null } })
    }

    for (const call of rpc.mock.calls) {
      expect(call).toEqual(['autoforge_sync_pull', {
        p_caller_user_id: 'real_uid',
        p_protocol_version: 1,
        p_device_id: 'dev_1',
        p_cursor: null,
        p_limit: 100,
      }])
    }
  })

  it('maps every strict action to the existing service-role RPC contract', async () => {
    const rpc = vi.fn()
    const handler = createUserDataHandler({ rpc })
    const conversation = {
      id: 'conv_1',
      title: 'Imported conversation',
      titleState: 'user_named',
      createdAt: occurredAt,
      lastActivityAt: occurredAt,
      metadataUpdatedAt: occurredAt,
    }
    const message = {
      id: 'message_1',
      conversationId: 'conv_1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      createdAt: occurredAt,
    }

    const cases = [
      {
        event: { action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1', mutations: [consentMutation] },
        rpcName: 'autoforge_sync_push',
        output: { results: [{ id: 'mutation_1', status: 'applied', revision: 0 }], cursor: opaqueCursor },
        parameters: {
          p_caller_user_id: 'real_uid', p_protocol_version: 1,
          p_device_id: 'dev_1', p_mutations: [consentMutation],
        },
      },
      {
        event: { action: 'syncPull', protocolVersion: 1, deviceId: 'dev_1', cursor: 'opaque-cursor-0001', limit: 25 },
        rpcName: 'autoforge_sync_pull',
        output: { mutations: [], cursor: 'opaque-cursor-0001' },
        parameters: {
          p_caller_user_id: 'real_uid', p_protocol_version: 1, p_device_id: 'dev_1',
          p_cursor: 'opaque-cursor-0001', p_limit: 25,
        },
      },
      {
        event: { action: 'listConversations', limit: 50, cursor: 'opaque-cursor-0001' },
        rpcName: 'autoforge_list_conversations',
        output: { items: [] },
        parameters: {
          p_caller_user_id: 'real_uid', p_limit: 50,
          p_cursor: 'opaque-cursor-0001', p_include_deleted: false,
        },
      },
      {
        event: { action: 'listMessages', protocolVersion: 2, conversationId: 'conv_1', limit: 100 },
        rpcName: 'autoforge_list_messages',
        output: { items: [] },
        parameters: {
          p_caller_user_id: 'real_uid', p_conversation_id: 'conv_1',
          p_limit: 100, p_cursor: null,
        },
      },
      {
        event: { action: 'previewLegacyImport', ownedCount: 1, unownedCount: 2 },
        rpcName: 'autoforge_preview_legacy_import',
        output: { ownedCount: 1, unownedCount: 2, requiresUnownedConfirmation: true },
        parameters: { p_caller_user_id: 'real_uid', p_owned_count: 1, p_unowned_count: 2 },
      },
      {
        event: {
          action: 'importLegacyBatch', protocolVersion: 1, deviceId: 'dev_1', batchId: 'batch_1',
          includeUnowned: false, conversations: [conversation], messages: [message],
          cloudSyncConsent: consent,
        },
        rpcName: 'autoforge_import_legacy_batch',
        output: { batchId: 'batch_1', status: 'applied', importedConversations: 1, importedMessages: 1 },
        parameters: {
          p_caller_user_id: 'real_uid', p_protocol_version: 1, p_device_id: 'dev_1',
          p_batch_id: 'batch_1', p_include_unowned: false,
          p_conversations: [conversation], p_messages: [message],
          p_cloud_sync_consent: consent, p_unowned_import_consent: null,
        },
      },
      {
        event: { action: 'recordConsent', protocolVersion: 1, deviceId: 'dev_1', mutation: consentMutation },
        rpcName: 'autoforge_sync_push',
        output: { results: [{ id: 'mutation_1', status: 'applied', revision: 0 }], cursor: opaqueCursor },
        parameters: {
          p_caller_user_id: 'real_uid', p_protocol_version: 1,
          p_device_id: 'dev_1', p_mutations: [consentMutation],
        },
      },
      {
        event: { action: 'getUserDataPreferences' },
        rpcName: 'autoforge_get_user_data_preferences',
        output: { timezone: 'Asia/Shanghai', displayCurrency: 'CNY', revision: 0, updatedAt: occurredAt },
        parameters: { p_caller_user_id: 'real_uid' },
      },
      {
        event: {
          action: 'updateUserDataPreferences', timezone: 'Asia/Shanghai',
          displayCurrency: 'CNY', expectedRevision: 2,
        },
        rpcName: 'autoforge_update_user_data_preferences',
        output: { timezone: 'Asia/Shanghai', displayCurrency: 'CNY', revision: 3 },
        parameters: {
          p_caller_user_id: 'real_uid', p_timezone: 'Asia/Shanghai',
          p_display_currency: 'CNY', p_expected_revision: 2,
        },
      },
      {
        event: { action: 'getUsageSnapshot', startedAt: occurredAt, endedAt: '2026-08-25T00:00:00.000Z' },
        rpcName: 'autoforge_get_usage_snapshot',
        output: {
          startedAt: occurredAt,
          endedAt: '2026-08-25T00:00:00.000Z',
          inputTokens: 12,
          outputTokens: 4,
          estimatedCostUsd: '0.001200000000',
          estimatedCount: 1,
          unavailableCount: 0,
        },
        parameters: {
          p_caller_user_id: 'real_uid', p_started_at: occurredAt,
          p_ended_at: '2026-08-25T00:00:00.000Z',
        },
      },
    ]

    for (const { event, rpcName, parameters, output } of cases) {
      rpc.mockClear()
      rpc.mockResolvedValueOnce(output)
      await expect(handler(event, authenticatedContext)).resolves.toEqual({ ok: true, data: output })
      expect(rpc).toHaveBeenCalledOnce()
      expect(rpc).toHaveBeenCalledWith(rpcName, parameters)
    }
  })

  it('strictly accepts conversation generation preferences for push and pull', async () => {
    const preferencesMutation = {
      id: 'preferences_mutation_1',
      entityId: 'conv_1',
      baseRevision: 1,
      occurredAt,
      kind: 'conversation.preferences',
      payload: {
        preferences: {
          outputType: 'image',
          models: { image: 'openrouter/image-model' },
          generation: {
            image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
            audio: { format: 'mp3' },
            video: {
              durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false,
            },
          },
        },
        metadataUpdatedAt: occurredAt,
      },
    }
    const rpc = vi.fn()
      .mockResolvedValueOnce({ results: [{ id: preferencesMutation.id, status: 'applied', revision: 2 }] })
      .mockResolvedValueOnce({
        mutations: [{
          id: preferencesMutation.id,
          kind: preferencesMutation.kind,
          entityId: preferencesMutation.entityId,
          baseRevision: preferencesMutation.baseRevision,
          resultRevision: 2,
          payload: preferencesMutation.payload,
          receivedAt: occurredAt,
        }],
        cursor: opaqueCursor,
      })
    const handler = createUserDataHandler({ rpc })

    await expect(handler({
      action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1', mutations: [preferencesMutation],
    }, authenticatedContext)).resolves.toMatchObject({ ok: true })
    await expect(handler({
      action: 'syncPull', protocolVersion: 1, deviceId: 'dev_1', limit: 100,
    }, authenticatedContext)).resolves.toMatchObject({
      ok: true,
      data: { mutations: [expect.objectContaining({ kind: 'conversation.preferences' })] },
    })

    const invalid = {
      ...preferencesMutation,
      payload: {
        ...preferencesMutation.payload,
        preferences: { ...preferencesMutation.payload.preferences, ownerUserId: 'forged' },
      },
    }
    await expect(handler({
      action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1', mutations: [invalid],
    }, authenticatedContext)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('accepts only canonical unique file-convert scopes and payload-free conversion blocks', async () => {
    const rpc = vi.fn().mockResolvedValue({
      results: [{ id: 'message_mutation_1', status: 'applied', revision: 1 }],
    })
    const handler = createUserDataHandler({ rpc })

    for (const mutation of [
      fileConvertApprovalMutation(['pdf', 'png']),
      fileInputMutation(),
      conversionBlockMutation(),
      conversionTerminalMutation(),
    ]) {
      await expect(handler({
        action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1', mutations: [mutation],
      }, authenticatedContext)).resolves.toMatchObject({ ok: true })
    }
    expect(rpc).toHaveBeenCalledTimes(4)

    const invalidMutations = [
      fileConvertApprovalMutation([]),
      fileConvertApprovalMutation(['pdf', 'pdf']),
      fileConvertApprovalMutation(['docx']),
      fileConvertApprovalMutation(['pdf'], { paths: ['/private/input.pdf'] }),
      fileInputMutation({ purpose: 'output' }),
      conversionBlockMutation({ state: 'terminal' }),
      ...['bytes', 'path', 'sha256', 'artifactId', 'jobId'].map((key) => (
        conversionBlockMutation({ [key]: 'private-local-value' })
      )),
      conversionTerminalMutation({ jobId: 'job_1' }),
    ]

    for (const mutation of invalidMutations) {
      await expect(handler({
        action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1', mutations: [mutation],
      }, authenticatedContext)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    }
    expect(rpc).toHaveBeenCalledTimes(4)
  })

  it('passes only an exact structured message projection to sync RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({
      results: [{ id: 'message_mutation_1', status: 'applied', revision: 1 }],
    })
    const handler = createUserDataHandler({ rpc })
    const valid = projectedConversionMessageMutation()

    await expect(handler({
      action: 'syncPush', protocolVersion: 3, deviceId: 'dev_1', mutations: [valid],
    }, authenticatedContext)).resolves.toMatchObject({ ok: true })
    expect(rpc).toHaveBeenCalledWith('autoforge_sync_push', expect.objectContaining({
      p_mutations: [expect.objectContaining({
        payload: expect.objectContaining({
          providerProjection: {
            kind: 'local_conversion', targetFormat: 'pdf', attachmentCount: 1,
          },
        }),
      })],
    }))

    await expect(handler({
      action: 'syncPush', protocolVersion: 2, deviceId: 'dev_1', mutations: [valid],
    }, authenticatedContext)).resolves.toEqual({
      ok: false, error: { code: 'INVALID_INPUT' },
    })

    for (const providerProjection of [
      { kind: 'local_conversion', targetFormat: 'docx', attachmentCount: 1 },
      { kind: 'local_conversion', targetFormat: 'pdf', attachmentCount: 0 },
      { kind: 'local_conversion', targetFormat: 'pdf', attachmentCount: 1, content: 'raw' },
      { kind: 'ordinary', targetFormat: 'pdf', attachmentCount: 1 },
      { version: 2, kind: 'local_conversion', targetFormat: 'pdf', attachmentCount: 1 },
    ]) {
      await expect(handler({
        action: 'syncPush', protocolVersion: 3, deviceId: 'dev_1',
        mutations: [projectedConversionMessageMutation(providerProjection)],
      }, authenticatedContext)).resolves.toEqual({
        ok: false, error: { code: 'INVALID_INPUT' },
      })
    }
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('negotiates projection fields only for protocol v3 list and pull responses', async () => {
    const projectedMessage = projectedConversionMessageMutation().payload
    const pulled = {
      id: 'message_mutation_1', kind: 'message.append', entityId: 'message_1',
      baseRevision: 0, resultRevision: 1, payload: projectedMessage, receivedAt: occurredAt,
    }
    const rpc = vi.fn(async (name: string) => name === 'autoforge_list_messages'
      ? { items: [projectedMessage] }
      : { mutations: [pulled], cursor: null })
    const handler = createUserDataHandler({ rpc })

    const legacyList = await handler({
      action: 'listMessages', conversationId: 'conv_1', limit: 100,
    }, authenticatedContext)
    expect(legacyList).toHaveProperty('ok', true)
    expect(legacyList).not.toHaveProperty('data.items.0.providerProjection')
    expect(Object.keys((legacyList as { data: { items: object[] } }).data.items[0]!).sort())
      .toEqual(['blocks', 'conversationId', 'createdAt', 'id', 'role'])

    for (const protocolVersion of [1, 2] as const) {
      await expect(handler({
        action: 'listMessages', protocolVersion, conversationId: 'conv_1', limit: 100,
      }, authenticatedContext)).resolves.not.toHaveProperty('data.items.0.providerProjection')
      await expect(handler({
        action: 'syncPull', protocolVersion, deviceId: 'dev_1', limit: 100,
      }, authenticatedContext)).resolves.not.toHaveProperty(
        'data.mutations.0.payload.providerProjection',
      )
    }
    await expect(handler({
      action: 'listMessages', protocolVersion: 3, conversationId: 'conv_1', limit: 100,
    }, authenticatedContext)).resolves.toHaveProperty(
      'data.items.0.providerProjection.targetFormat', 'pdf',
    )
    await expect(handler({
      action: 'syncPull', protocolVersion: 3, deviceId: 'dev_1', limit: 100,
    }, authenticatedContext)).resolves.toHaveProperty(
      'data.mutations.0.payload.providerProjection.targetFormat', 'pdf',
    )
  })

  it('rejects extra action and nested union keys before calling RPC', async () => {
    const rpc = vi.fn()
    const handler = createUserDataHandler({ rpc })

    for (const event of [
      { action: 'getUserDataPreferences', extra: true },
      {
        action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1',
        mutations: [{ ...consentMutation, ownerUserId: 'forged' }],
      },
      {
        action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1',
        mutations: [{ ...consentMutation, payload: { ...consent, userId: 'forged' } }],
      },
      {
        action: 'recordConsent', protocolVersion: 1, deviceId: 'dev_1',
        mutation: { ...consentMutation, kind: 'conversation.create' },
      },
    ]) {
      await expect(handler(event, authenticatedContext)).resolves.toEqual({
        ok: false, error: { code: 'INVALID_INPUT' },
      })
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects an extra key on every action branch', async () => {
    const rpc = vi.fn()
    const handler = createUserDataHandler({ rpc })
    const conversation = {
      id: 'conv_1', title: 'title', titleState: 'user_named', createdAt: occurredAt,
      lastActivityAt: occurredAt, metadataUpdatedAt: occurredAt,
    }

    const validEvents = [
      { action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1', mutations: [consentMutation] },
      { action: 'syncPull', protocolVersion: 1, deviceId: 'dev_1' },
      { action: 'listConversations', limit: 50 },
      { action: 'listMessages', protocolVersion: 2, conversationId: 'conv_1', limit: 100 },
      { action: 'previewLegacyImport', ownedCount: 1, unownedCount: 0 },
      {
        action: 'importLegacyBatch', protocolVersion: 1, deviceId: 'dev_1', batchId: 'batch_1',
        includeUnowned: false, conversations: [conversation], messages: [], cloudSyncConsent: consent,
      },
      { action: 'recordConsent', protocolVersion: 1, deviceId: 'dev_1', mutation: consentMutation },
      { action: 'getUserDataPreferences' },
      {
        action: 'updateUserDataPreferences', timezone: 'Asia/Shanghai',
        displayCurrency: 'CNY', expectedRevision: 0,
      },
      { action: 'getUsageSnapshot', startedAt: occurredAt, endedAt: '2026-08-25T00:00:00.000Z' },
    ]

    for (const event of validEvents) {
      await expect(handler({ ...event, unexpected: true }, authenticatedContext)).resolves.toMatchObject({
        ok: false, error: { code: 'INVALID_INPUT' },
      })
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('mirrors canonical nested message block and BYOK decimal validation', async () => {
    const rpc = vi.fn()
    const handler = createUserDataHandler({ rpc })
    const invalidMutations = [
      messageMutation([{
        type: 'browser_status',
        blockId: 'block_1',
        requestId: 'request_1',
        bindingId: 'binding_1',
        siteLabel: 'Unsafe site',
        origin: 'http://example.com',
        state: 'inspecting',
      }]),
      messageMutation([{
        type: 'workflow_status',
        blockId: 'block_1',
        executionId: 'execution_1',
        status: 'queued',
        executionAvailable: true,
        executionIndex: 1,
        executionLimit: 1,
        workflowId: 'workflow_1',
        workflowName: 'Workflow',
        workflowVersion: '1.0.0',
        source: 'installed',
      }]),
      messageMutation([{
        type: 'workflow_status',
        blockId: 'block_1',
        executionId: 'execution_1',
        status: 'running',
        executionAvailable: true,
        executionIndex: 1,
        executionLimit: 1,
        workflowId: 'workflow_1',
        workflowName: 'Workflow',
        workflowVersion: '1.0.0',
        source: 'installed',
        errorCode: 'INTERNAL_ERROR',
        errorSummary: 'must not accompany an active state',
      }]),
      {
        id: 'usage_mutation_1',
        entityId: 'usage_1',
        baseRevision: 0,
        occurredAt,
        kind: 'usage.record',
        payload: {
          id: 'usage_1',
          operationId: 'operation_1',
          purpose: 'chat_reply',
          credentialOwner: 'user',
          billable: false,
          provider: 'openrouter',
          model: 'openai/gpt-5',
          modality: 'text',
          costStatus: 'estimated',
          estimatedCostUsd: '0.0010',
          occurredAt,
        },
      },
    ]

    for (const mutation of invalidMutations) {
      await expect(handler({
        action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1', mutations: [mutation],
      }, authenticatedContext)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('matches Task 1 generic error-code and HTTPS URL-pattern edge semantics', async () => {
    const genericErrorRpc = vi.fn().mockResolvedValue({
      results: [{ id: 'message_mutation_1', status: 'applied', revision: 1 }],
      cursor: opaqueCursor,
    })
    const genericErrorHandler = createUserDataHandler({ rpc: genericErrorRpc })
    await expect(genericErrorHandler({
      action: 'syncPush',
      protocolVersion: 1,
      deviceId: 'dev_1',
      mutations: [messageMutation([{
        type: 'error', code: 'VENDOR_SPECIFIC_FAILURE', message: 'Provider failed',
      }])],
    }, authenticatedContext)).resolves.toEqual({
      ok: true,
      data: {
        results: [{ id: 'message_mutation_1', status: 'applied', revision: 1 }],
        cursor: opaqueCursor,
      },
    })
    expect(genericErrorRpc).toHaveBeenCalledOnce()

    const malformedRpc = vi.fn()
    const malformedHandler = createUserDataHandler({ rpc: malformedRpc })
    await expect(malformedHandler({
      action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1',
      mutations: [approvalMutation('https://foo..bar/*')],
    }, authenticatedContext)).resolves.toEqual({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
    expect(malformedRpc).not.toHaveBeenCalled()

    const uppercaseRpc = vi.fn().mockResolvedValue({
      results: [{ id: 'message_mutation_1', status: 'applied', revision: 1 }],
    })
    const uppercaseHandler = createUserDataHandler({ rpc: uppercaseRpc })
    await expect(uppercaseHandler({
      action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1',
      mutations: [approvalMutation('HTTPS://*.Example.com/*')],
    }, authenticatedContext)).resolves.toEqual({
      ok: true,
      data: { results: [{ id: 'message_mutation_1', status: 'applied', revision: 1 }] },
    })
    expect(uppercaseRpc).toHaveBeenCalledOnce()
  })

  it('does not invent text limits absent from the Task 1 wire contract', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        results: [{ id: 'conversation_mutation_1', status: 'rejected', errorCode: 'INVALID_INPUT' }],
      })
      .mockResolvedValueOnce({
        results: [{ id: 'usage_mutation_1', status: 'applied', revision: 0 }],
        cursor: opaqueCursor,
      })
    const handler = createUserDataHandler({ rpc })
    const longTitleMutation = {
      id: 'conversation_mutation_1',
      entityId: 'conv_1',
      baseRevision: 0,
      occurredAt,
      kind: 'conversation.create',
      payload: {
        title: 't'.repeat(501),
        titleState: 'user_named',
        createdAt: occurredAt,
        lastActivityAt: occurredAt,
        metadataUpdatedAt: occurredAt,
      },
    }
    const longModelMutation = {
      id: 'usage_mutation_1',
      entityId: 'usage_1',
      baseRevision: 0,
      occurredAt,
      kind: 'usage.record',
      payload: {
        id: 'usage_1',
        operationId: 'operation_1',
        purpose: 'chat_reply',
        credentialOwner: 'user',
        billable: false,
        provider: 'openrouter',
        model: 'm'.repeat(255),
        modality: 'text',
        costStatus: 'unavailable',
        occurredAt,
      },
    }

    await expect(handler({
      action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1', mutations: [longTitleMutation],
    }, authenticatedContext)).resolves.toEqual({
      ok: true,
      data: { results: [{ id: 'conversation_mutation_1', status: 'rejected', errorCode: 'INVALID_INPUT' }] },
    })
    await expect(handler({
      action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1', mutations: [longModelMutation],
    }, authenticatedContext)).resolves.toEqual({
      ok: true,
      data: { results: [{ id: 'usage_mutation_1', status: 'applied', revision: 0 }], cursor: opaqueCursor },
    })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('accepts v1/v2/v3, rejects later protocols, and enforces identifiers, batches, and request size', async () => {
    const rpc = vi.fn()
    const handler = createUserDataHandler({ rpc })

    await expect(handler({
      action: 'syncPull', protocolVersion: 2, deviceId: 'dev_1',
    }, authenticatedContext)).resolves.toEqual({ ok: true, data: undefined })
    expect(rpc).toHaveBeenLastCalledWith('autoforge_sync_pull', expect.objectContaining({
      p_protocol_version: 2,
    }))
    await expect(handler({
      action: 'syncPull', protocolVersion: 4, deviceId: 'dev_1',
    }, authenticatedContext)).resolves.toEqual({ ok: false, error: { code: 'UPGRADE_REQUIRED' } })
    await expect(handler({
      action: 'syncPull', protocolVersion: 1, deviceId: ' dev_1',
    }, authenticatedContext)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    await expect(handler({
      action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1',
      mutations: Array.from({ length: 101 }, (_, index) => ({
        ...consentMutation, id: `mutation_${index}`,
      })),
    }, authenticatedContext)).resolves.toEqual({ ok: false, error: { code: 'OUTBOX_LIMIT_EXCEEDED' } })
    await expect(handler({
      action: 'importLegacyBatch', protocolVersion: 1, deviceId: 'dev_1', batchId: 'batch_1',
      includeUnowned: false,
      conversations: Array.from({ length: 51 }, (_, index) => ({
        id: `conv_${index}`, title: 'title', titleState: 'user_named', createdAt: occurredAt,
        lastActivityAt: occurredAt, metadataUpdatedAt: occurredAt,
      })),
      messages: Array.from({ length: 50 }, (_, index) => ({
        id: `message_${index}`, conversationId: 'conv_1', role: 'user', blocks: [], createdAt: occurredAt,
      })),
      cloudSyncConsent: consent,
    }, authenticatedContext)).resolves.toEqual({
      ok: false, error: { code: 'INVALID_INPUT', stage: 'batch' },
    })
    await expect(handler({
      action: 'syncPush', protocolVersion: 1, deviceId: 'dev_1',
      mutations: [{
        id: 'message_mutation_1', entityId: 'message_1', baseRevision: 0,
        occurredAt, kind: 'message.append',
        payload: {
          id: 'message_1', conversationId: 'conv_1', role: 'user',
          blocks: [{ type: 'text', text: 'x'.repeat(1_048_576) }], createdAt: occurredAt,
        },
      }],
    }, authenticatedContext)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('rejects non-datetime date strings before RPC', async () => {
    const rpc = vi.fn()
    const handler = createUserDataHandler({ rpc })

    await expect(handler({
      action: 'getUsageSnapshot', startedAt: '2026-08-24', endedAt: '2026-08-25T00:00:00.000Z',
    }, authenticatedContext)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns only stable errors and never returns upstream or SQL details', async () => {
    const stable = createUserDataHandler({ rpc: vi.fn().mockRejectedValue({ code: 'SYNC_CONFLICT' }) })
    const importConfirmation = createUserDataHandler({
      rpc: vi.fn().mockRejectedValue({ message: 'IMPORT_CONFIRMATION_REQUIRED' }),
    })
    const unknown = createUserDataHandler({ rpc: vi.fn().mockRejectedValue({
      code: 'SQL_FAILURE', message: 'select service_key from secrets',
      details: { token: 'secret', payload: 'private', path: '/internal/rpc' },
    }) })

    await expect(stable({ action: 'getUserDataPreferences' }, authenticatedContext)).resolves.toEqual({
      ok: false, error: { code: 'SYNC_CONFLICT' },
    })
    await expect(importConfirmation({ action: 'getUserDataPreferences' }, authenticatedContext)).resolves.toEqual({
      ok: false, error: { code: 'IMPORT_CONFIRMATION_REQUIRED' },
    })
    await expect(unknown({ action: 'getUserDataPreferences' }, authenticatedContext)).resolves.toEqual({
      ok: false, error: { code: 'INTERNAL_ERROR' },
    })
  })

  it('returns a safe envelope when function environment configuration is missing', async () => {
    const require = createRequire(import.meta.url)
    const entryPath = require.resolve('../../cloudbase/user-data/function/index.js')
    const previousBaseUrl = process.env.AUTOFORGE_PG_RPC_BASE_URL
    const previousServiceKey = process.env.AUTOFORGE_PG_SERVICE_KEY
    delete process.env.AUTOFORGE_PG_RPC_BASE_URL
    delete process.env.AUTOFORGE_PG_SERVICE_KEY
    delete require.cache[entryPath]

    try {
      const { main } = require(entryPath) as { main: (event: unknown, context: unknown) => Promise<unknown> }
      await expect(main({ action: 'getUserDataPreferences' }, authenticatedContext)).resolves.toEqual({
        ok: false, error: { code: 'SERVICE_UNAVAILABLE' },
      })
    } finally {
      if (previousBaseUrl === undefined) delete process.env.AUTOFORGE_PG_RPC_BASE_URL
      else process.env.AUTOFORGE_PG_RPC_BASE_URL = previousBaseUrl
      if (previousServiceKey === undefined) delete process.env.AUTOFORGE_PG_SERVICE_KEY
      else process.env.AUTOFORGE_PG_SERVICE_KEY = previousServiceKey
      delete require.cache[entryPath]
    }
  })
})

describe('CloudBase PostgreSQL user data RPC client', () => {
  const validOutputs = {
    autoforge_sync_push: {
      results: [{ id: 'mutation_1', status: 'applied', revision: 0 }],
      cursor: opaqueCursor,
    },
    autoforge_sync_pull: {
      mutations: [{
        id: 'mutation_1',
        kind: 'privacy.consent',
        entityId: 'privacy-2026-08',
        baseRevision: 0,
        resultRevision: 0,
        payload: consent,
        receivedAt: occurredAt,
      }],
      cursor: opaqueCursor,
    },
    autoforge_list_conversations: {
      items: [{
        id: 'conv_1',
        title: 'Conversation',
        titleState: 'user_named',
        revision: 2,
        syncState: 'synced',
        createdAt: occurredAt,
        lastActivityAt: occurredAt,
        metadataUpdatedAt: occurredAt,
      }],
      nextCursor: opaqueCursor,
    },
    autoforge_list_messages: {
      items: [{
        id: 'message_1',
        conversationId: 'conv_1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'safe response' }],
        executionId: 'execution_1',
        createdAt: occurredAt,
      }],
      previousCursor: opaqueCursor,
    },
    autoforge_preview_legacy_import: {
      ownedCount: 2,
      unownedCount: 1,
      requiresUnownedConfirmation: true,
    },
    autoforge_import_legacy_batch: {
      batchId: 'batch_1',
      status: 'applied',
      importedConversations: 2,
      importedMessages: 3,
    },
    autoforge_get_usage_snapshot: {
      startedAt: occurredAt,
      endedAt: '2026-08-25T00:00:00.000Z',
      inputTokens: 12,
      outputTokens: 4,
      estimatedCostUsd: '0.001200000000',
      estimatedCount: 1,
      unavailableCount: 0,
    },
    autoforge_get_user_data_preferences: {
      timezone: 'Asia/Shanghai',
      displayCurrency: 'CNY',
      revision: 2,
      updatedAt: occurredAt,
    },
    autoforge_update_user_data_preferences: {
      timezone: 'Asia/Shanghai',
      displayCurrency: 'CNY',
      revision: 3,
    },
  } as const

  it('parses a realistic explicit safe output for every allowlisted RPC', async () => {
    for (const [name, output] of Object.entries(validOutputs)) {
      const fetchImpl = vi.fn().mockResolvedValue(mockRpcResponse(output))
      const rpc = createPostgresRpcClient({
        baseUrl: 'https://autoforge.example/v1/rdb/rest/',
        serviceKey: 'server-secret',
        fetchImpl,
      })

      await expect(rpc(name, { p_caller_user_id: 'real_uid' })).resolves.toEqual(output)
      expect(fetchImpl).toHaveBeenCalledWith(
        `https://autoforge.example/v1/rdb/rest/rpc/${name}`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer server-secret',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ p_caller_user_id: 'real_uid' }),
          signal: expect.any(AbortSignal),
        },
      )
      expect(fetchImpl.mock.calls[0]?.[1].signal.aborted).toBe(true)
    }
  })

  it('strictly parses structured projections from message list and sync pull responses', async () => {
    const projectedPayload = projectedConversionMessageMutation().payload
    const projectedMessage = {
      ...projectedPayload,
      providerProjection: {
        kind: 'local_conversion', targetFormat: 'pdf', attachmentCount: 1,
      },
    }
    for (const [name, output] of [
      ['autoforge_list_messages', { items: [projectedMessage] }],
      ['autoforge_sync_pull', {
        mutations: [{
          id: 'message_mutation_1', kind: 'message.append', entityId: 'message_1',
          baseRevision: 0, resultRevision: 1, payload: projectedMessage, receivedAt: occurredAt,
        }],
        cursor: null,
      }],
    ] as const) {
      const rpc = createPostgresRpcClient({
        baseUrl: 'https://autoforge.example/v1/rdb/rest', serviceKey: 'server-secret',
        fetchImpl: vi.fn().mockResolvedValue(mockRpcResponse(output)),
      })
      await expect(rpc(name, {})).resolves.toEqual(output)
    }

    for (const providerProjection of [
      { kind: 'local_conversion', targetFormat: 'docx', attachmentCount: 1 },
      { kind: 'local_conversion', targetFormat: 'pdf', attachmentCount: 1, raw: 'text' },
      { version: 99, kind: 'local_conversion', targetFormat: 'pdf', attachmentCount: 1 },
    ]) {
      const rpc = createPostgresRpcClient({
        baseUrl: 'https://autoforge.example/v1/rdb/rest', serviceKey: 'server-secret',
        fetchImpl: vi.fn().mockResolvedValue(mockRpcResponse({
          items: [{ ...projectedMessage, providerProjection }],
        })),
      })
      await expect(rpc('autoforge_list_messages', {})).rejects.toEqual({
        code: 'SERVICE_UNAVAILABLE',
      })
    }
  })

  it('rejects arbitrary, missing, and extra-key 2xx bodies for every allowlisted RPC', async () => {
    for (const [name, output] of Object.entries(validOutputs)) {
      for (const body of [{ accepted: true }, { ...output, unexpected: true }]) {
        const rpc = createPostgresRpcClient({
          baseUrl: 'https://autoforge.example/v1/rdb/rest',
          serviceKey: 'server-secret',
          fetchImpl: vi.fn().mockResolvedValue(mockRpcResponse(body)),
        })
        await expect(rpc(name, {})).rejects.toEqual({ code: 'SERVICE_UNAVAILABLE' })
      }
    }
  })

  it('requires revisions for successful mutation results and error codes for failures', async () => {
    for (const result of [
      { id: 'mutation_1', status: 'applied' },
      { id: 'mutation_1', status: 'duplicate' },
      { id: 'mutation_1', status: 'conflict', errorCode: 'SYNC_CONFLICT', revision: 1 },
      { id: 'mutation_1', status: 'conflict' },
      { id: 'mutation_1', status: 'rejected', errorCode: 'INVALID_INPUT', revision: 1 },
      { id: 'mutation_1', status: 'rejected' },
    ]) {
      const rpc = createPostgresRpcClient({
        baseUrl: 'https://autoforge.example/v1/rdb/rest',
        serviceKey: 'server-secret',
        fetchImpl: vi.fn().mockResolvedValue(mockRpcResponse({ results: [result] })),
      })
      await expect(rpc('autoforge_sync_push', {})).rejects.toEqual({ code: 'SERVICE_UNAVAILABLE' })
    }
  })

  it('preserves ordinary opaque args while recursively redacting sensitive named variants', async () => {
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      fetchImpl: vi.fn().mockResolvedValue(mockRpcResponse({
          items: [{
            id: 'message_1',
            conversationId: 'conv_1',
            role: 'assistant',
            blocks: [{
              type: 'workflow_proposal',
              workflowId: 'workflow_1',
              workflowName: 'Workflow',
              args: {
                query: 'status:open',
                fluid: 'hydraulic',
                liquid: 'water',
                sql: 'select-secret-must-not-cross',
                ServiceKey: 'service-key-must-not-cross',
                rootPath: '/Users/private/project',
                nested: {
                  Authorization: 'authorization-must-not-cross',
                  authorizationHeader: 'authorization-header-must-not-cross',
                  cookieValue: 'cookie-must-not-cross',
                  uidValue: 'uid-must-not-cross',
                  filePathValue: 'file-path-must-not-cross',
                  callerUserId: 'user-id-must-not-cross',
                  access_token: 'token-must-not-cross',
                  passwordValue: 'password-must-not-cross',
                  promptText: 'prompt-must-not-cross',
                  response_body: 'response-must-not-cross',
                  imageBase64: 'base64-must-not-cross',
                  credentialOwner: 'owner-must-not-cross',
                },
              },
            }],
            createdAt: occurredAt,
          }],
        })),
    })

    const result = await rpc('autoforge_list_messages', {})
    expect(result).toEqual({
      items: [{
        id: 'message_1',
        conversationId: 'conv_1',
        role: 'assistant',
        blocks: [{
          type: 'workflow_proposal',
          workflowId: 'workflow_1',
          workflowName: 'Workflow',
          args: {
            query: 'status:open',
            fluid: 'hydraulic',
            liquid: 'water',
            sql: '[REDACTED]',
            ServiceKey: '[REDACTED]',
            rootPath: '[REDACTED]',
            nested: {
              Authorization: '[REDACTED]',
              authorizationHeader: '[REDACTED]',
              cookieValue: '[REDACTED]',
              uidValue: '[REDACTED]',
              filePathValue: '[REDACTED]',
              callerUserId: '[REDACTED]',
              access_token: '[REDACTED]',
              passwordValue: '[REDACTED]',
              promptText: '[REDACTED]',
              response_body: '[REDACTED]',
              imageBase64: '[REDACTED]',
              credentialOwner: '[REDACTED]',
            },
          },
        }],
        createdAt: occurredAt,
      }],
    })
    expect(JSON.stringify(result)).not.toMatch(
      /select-secret-must-not-cross|service-key-must-not-cross|Users\/private|authorization-must-not-cross|authorization-header-must-not-cross|cookie-must-not-cross|uid-must-not-cross|file-path-must-not-cross|user-id-must-not-cross|token-must-not-cross|password-must-not-cross|prompt-must-not-cross|response-must-not-cross|base64-must-not-cross|owner-must-not-cross/,
    )
  })

  it('parses the distinct stored legacy-import receipt emitted by sync pull', async () => {
    const output = {
      mutations: [{
        id: 'batch_1',
        kind: 'legacy.import',
        entityId: 'batch_1',
        baseRevision: 0,
        resultRevision: 0,
        payload: { batchId: 'batch_1', includeUnowned: false },
        receivedAt: occurredAt,
      }],
      cursor: opaqueCursor,
    }
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      fetchImpl: vi.fn().mockResolvedValue(mockRpcResponse(output)),
    })

    await expect(rpc('autoforge_sync_pull', {})).resolves.toEqual(output)
  })

  it('accepts only payload-free compacted receipts emitted by sync pull', async () => {
    const output = {
      mutations: [{
        id: 'message_mutation_1', kind: 'message.append', entityId: 'message_1',
        conversationId: 'conversation_1', baseRevision: 1, resultRevision: 2,
        compacted: true, receivedAt: occurredAt,
      }],
      cursor: opaqueCursor,
    }
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      fetchImpl: vi.fn().mockResolvedValue(mockRpcResponse(output)),
    })
    await expect(rpc('autoforge_sync_pull', {})).resolves.toEqual(output)

    const forged = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      fetchImpl: vi.fn().mockResolvedValue(mockRpcResponse({
        ...output,
        mutations: [{ ...output.mutations[0], payload: { blocks: ['secret'] } }],
      })),
    })
    await expect(forged('autoforge_sync_pull', {}))
      .rejects.toEqual({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('accepts only strict remote-only compacted conversion terminal receipts', async () => {
    const receipt = {
      id: 'conversion_terminal_mutation_1',
      kind: 'message.conversion_block_terminal',
      entityId: 'message_1',
      conversationId: 'conversation_1',
      baseRevision: 1,
      resultRevision: 2,
      compacted: true,
      receivedAt: occurredAt,
    }
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      fetchImpl: vi.fn().mockResolvedValue(mockRpcResponse({ mutations: [receipt], cursor: opaqueCursor })),
    })
    await expect(rpc('autoforge_sync_pull', {})).resolves.toEqual({
      mutations: [receipt], cursor: opaqueCursor,
    })

    for (const forgedReceipt of [
      { ...receipt, conversationId: undefined },
      { ...receipt, payload: { state: 'terminal' } },
    ]) {
      const forged = createPostgresRpcClient({
        baseUrl: 'https://autoforge.example/v1/rdb/rest',
        serviceKey: 'server-secret',
        fetchImpl: vi.fn().mockResolvedValue(mockRpcResponse({
          mutations: [forgedReceipt], cursor: opaqueCursor,
        })),
      })
      await expect(forged('autoforge_sync_pull', {}))
        .rejects.toEqual({ code: 'SERVICE_UNAVAILABLE' })
    }
  })

  it('rejects pulled mutations whose entity identity disagrees with the strict payload', async () => {
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      fetchImpl: vi.fn().mockResolvedValue(mockRpcResponse({
          mutations: [{
            id: 'mutation_1',
            kind: 'privacy.consent',
            entityId: 'forged-document-version',
            baseRevision: 0,
            resultRevision: 0,
            payload: consent,
            receivedAt: occurredAt,
          }],
          cursor: opaqueCursor,
        })),
    })

    await expect(rpc('autoforge_sync_pull', {})).rejects.toEqual({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('maps a 2xx JSON parse failure to a stable unavailable error', async () => {
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      fetchImpl: vi.fn().mockResolvedValue(mockRpcResponse(undefined, { rawBody: '{' })),
    })

    await expect(rpc('autoforge_get_user_data_preferences', {})).rejects.toEqual({
      code: 'SERVICE_UNAVAILABLE',
    })
  })

  it('rejects oversized or invalid Content-Length before reading the response stream', async () => {
    for (const contentLength of ['8388609', 'not-a-number']) {
      const getReader = vi.fn()
      let requestSignal: AbortSignal | undefined
      const rpc = createPostgresRpcClient({
        baseUrl: 'https://autoforge.example/v1/rdb/rest',
        serviceKey: 'server-secret',
        fetchImpl: vi.fn((_url: string, init: { signal: AbortSignal }) => {
          requestSignal = init.signal
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: vi.fn().mockReturnValue(contentLength) },
            body: { getReader },
            json: vi.fn().mockResolvedValue(
              validOutputs.autoforge_get_user_data_preferences,
            ),
          })
        }),
      })

      await expect(rpc('autoforge_get_user_data_preferences', {})).rejects.toEqual({
        code: 'SERVICE_UNAVAILABLE',
      })
      expect(getReader).not.toHaveBeenCalled()
      expect(requestSignal?.aborted).toBe(true)
    }
  })

  it('cancels a response stream that crosses the 8 MiB byte ceiling', async () => {
    vi.useFakeTimers()
    const chunks = [
      new Uint8Array(4 * 1024 * 1024),
      new Uint8Array(4 * 1024 * 1024),
      new Uint8Array([0]),
    ]
    let index = 0
    const cancel = vi.fn().mockResolvedValue(undefined)
    const releaseLock = vi.fn()
    const read = vi.fn().mockImplementation(async () => (
      index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }
    ))
    let requestSignal: AbortSignal | undefined
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      fetchImpl: vi.fn((_url: string, init: { signal: AbortSignal }) => {
        requestSignal = init.signal
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: vi.fn().mockReturnValue(null) },
          body: { getReader: () => ({ read, cancel, releaseLock }) },
          json: vi.fn().mockResolvedValue(validOutputs.autoforge_get_user_data_preferences),
        })
      }),
    })

    try {
      await expect(rpc('autoforge_get_user_data_preferences', {})).rejects.toEqual({
        code: 'SERVICE_UNAVAILABLE',
      })
      expect(cancel).toHaveBeenCalledOnce()
      expect(releaseLock).toHaveBeenCalledOnce()
      expect(requestSignal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('aborts a timed-out fetch and clears its timer', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    let rejectFetch: ((error: Error) => void) | undefined
    const fetchImpl = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      requestSignal = init.signal
      return new Promise((_resolve, reject) => {
        rejectFetch = reject
        init.signal.addEventListener('abort', () => {
          const error = new Error('timed out')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    })
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      fetchImpl,
      timeoutMs: 50,
    })
    const pending = rpc('autoforge_get_user_data_preferences', {})
    const rejected = expect(pending).rejects.toEqual({ code: 'SERVICE_UNAVAILABLE' })

    try {
      await vi.advanceTimersByTimeAsync(50)
      expect(requestSignal?.aborted).toBe(true)
      await rejected
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      rejectFetch?.(new Error('test cleanup'))
      await pending.catch(() => undefined)
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('times out body parsing and clears timers on both timeout and success', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    let rejectBody: ((error: Error) => void) | undefined
    const hangingBodyRpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      timeoutMs: 50,
      fetchImpl: vi.fn((_url: string, init: { signal: AbortSignal }) => {
        requestSignal = init.signal
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: vi.fn().mockReturnValue(null) },
          body: {
            getReader: () => ({
              read: () => new Promise((_resolve, reject) => { rejectBody = reject }),
              cancel: vi.fn().mockResolvedValue(undefined),
              releaseLock: vi.fn(),
            }),
          },
          json: () => new Promise((_resolve, reject) => { rejectBody = reject }),
        })
      }),
    })
    const pending = hangingBodyRpc('autoforge_get_user_data_preferences', {})
    const rejected = expect(pending).rejects.toEqual({ code: 'SERVICE_UNAVAILABLE' })

    try {
      await vi.advanceTimersByTimeAsync(50)
      expect(requestSignal?.aborted).toBe(true)
      await rejected
      expect(vi.getTimerCount()).toBe(0)

      const successfulRpc = createPostgresRpcClient({
        baseUrl: 'https://autoforge.example/v1/rdb/rest',
        serviceKey: 'server-secret',
        timeoutMs: 50,
        fetchImpl: vi.fn().mockResolvedValue(
          mockRpcResponse(validOutputs.autoforge_get_user_data_preferences),
        ),
      })
      await expect(successfulRpc('autoforge_get_user_data_preferences', {})).resolves.toEqual(
        validOutputs.autoforge_get_user_data_preferences,
      )
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      rejectBody?.(new Error('test cleanup'))
      await pending.catch(() => undefined)
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('maps only stable upstream errors without exposing response bodies', async () => {
    const rejected = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      fetchImpl: vi.fn().mockResolvedValue(mockRpcResponse({
          code: 'SQL_FAILURE', message: 'private SQL', serviceKey: 'server-secret', payload: 'private',
        }, { ok: false, status: 400 })),
    })
    const unavailable = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      fetchImpl: vi.fn().mockRejectedValue(new Error('network includes /private/path')),
    })

    await expect(rejected('autoforge_sync_pull', {})).rejects.toEqual({ code: 'INTERNAL_ERROR' })
    await expect(unavailable('autoforge_sync_pull', {})).rejects.toEqual({ code: 'SERVICE_UNAVAILABLE' })
  })
})
