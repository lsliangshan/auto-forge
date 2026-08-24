import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  createPostgresRpcClient,
  createUserDataHandler,
} from '../../cloudbase/user-data/function/user-data-handler.js'

const authenticatedContext = { auth: { uid: 'real_uid' } }
const occurredAt = '2026-08-24T00:00:00.000Z'

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

describe('CloudBase user data function', () => {
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
    const rpc = vi.fn().mockResolvedValue({ accepted: true })
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
        parameters: {
          p_caller_user_id: 'real_uid', p_protocol_version: 1,
          p_device_id: 'dev_1', p_mutations: [consentMutation],
        },
      },
      {
        event: { action: 'syncPull', protocolVersion: 1, deviceId: 'dev_1', cursor: 'opaque-cursor-0001', limit: 25 },
        rpcName: 'autoforge_sync_pull',
        parameters: {
          p_caller_user_id: 'real_uid', p_protocol_version: 1, p_device_id: 'dev_1',
          p_cursor: 'opaque-cursor-0001', p_limit: 25,
        },
      },
      {
        event: { action: 'listConversations', limit: 50, cursor: 'opaque-cursor-0001' },
        rpcName: 'autoforge_list_conversations',
        parameters: {
          p_caller_user_id: 'real_uid', p_limit: 50,
          p_cursor: 'opaque-cursor-0001', p_include_deleted: false,
        },
      },
      {
        event: { action: 'listMessages', conversationId: 'conv_1', limit: 100 },
        rpcName: 'autoforge_list_messages',
        parameters: {
          p_caller_user_id: 'real_uid', p_conversation_id: 'conv_1',
          p_limit: 100, p_cursor: null,
        },
      },
      {
        event: { action: 'previewLegacyImport', ownedCount: 1, unownedCount: 2 },
        rpcName: 'autoforge_preview_legacy_import',
        parameters: { p_caller_user_id: 'real_uid', p_owned_count: 1, p_unowned_count: 2 },
      },
      {
        event: {
          action: 'importLegacyBatch', protocolVersion: 1, deviceId: 'dev_1', batchId: 'batch_1',
          includeUnowned: false, conversations: [conversation], messages: [message],
          cloudSyncConsent: consent,
        },
        rpcName: 'autoforge_import_legacy_batch',
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
        parameters: {
          p_caller_user_id: 'real_uid', p_protocol_version: 1,
          p_device_id: 'dev_1', p_mutations: [consentMutation],
        },
      },
      {
        event: { action: 'getUserDataPreferences' },
        rpcName: 'autoforge_get_user_data_preferences',
        parameters: { p_caller_user_id: 'real_uid' },
      },
      {
        event: {
          action: 'updateUserDataPreferences', timezone: 'Asia/Shanghai',
          displayCurrency: 'CNY', expectedRevision: 2,
        },
        rpcName: 'autoforge_update_user_data_preferences',
        parameters: {
          p_caller_user_id: 'real_uid', p_timezone: 'Asia/Shanghai',
          p_display_currency: 'CNY', p_expected_revision: 2,
        },
      },
      {
        event: { action: 'getUsageSnapshot', startedAt: occurredAt, endedAt: '2026-08-25T00:00:00.000Z' },
        rpcName: 'autoforge_get_usage_snapshot',
        parameters: {
          p_caller_user_id: 'real_uid', p_started_at: occurredAt,
          p_ended_at: '2026-08-25T00:00:00.000Z',
        },
      },
    ]

    for (const { event, rpcName, parameters } of cases) {
      rpc.mockClear()
      await expect(handler(event, authenticatedContext)).resolves.toEqual({ ok: true, data: { accepted: true } })
      expect(rpc).toHaveBeenCalledOnce()
      expect(rpc).toHaveBeenCalledWith(rpcName, parameters)
    }
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

  it('enforces protocol, identifier, batch, and request-size limits before RPC', async () => {
    const rpc = vi.fn()
    const handler = createUserDataHandler({ rpc })

    await expect(handler({
      action: 'syncPull', protocolVersion: 2, deviceId: 'dev_1',
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
    }, authenticatedContext)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
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
    expect(rpc).not.toHaveBeenCalled()
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
    const unknown = createUserDataHandler({ rpc: vi.fn().mockRejectedValue({
      code: 'SQL_FAILURE', message: 'select service_key from secrets',
      details: { token: 'secret', payload: 'private', path: '/internal/rpc' },
    }) })

    await expect(stable({ action: 'getUserDataPreferences' }, authenticatedContext)).resolves.toEqual({
      ok: false, error: { code: 'SYNC_CONFLICT' },
    })
    await expect(unknown({ action: 'getUserDataPreferences' }, authenticatedContext)).resolves.toEqual({
      ok: false, error: { code: 'INTERNAL_ERROR' },
    })
  })
})

describe('CloudBase PostgreSQL user data RPC client', () => {
  it('uses the service key only in the bearer header and returns successful JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ items: [] }),
    })
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest/',
      serviceKey: 'server-secret',
      fetchImpl,
    })

    await expect(rpc('autoforge_get_user_data_preferences', {
      p_caller_user_id: 'real_uid',
    })).resolves.toEqual({ items: [] })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://autoforge.example/v1/rdb/rest/rpc/autoforge_get_user_data_preferences',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer server-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ p_caller_user_id: 'real_uid' }),
      },
    )
  })

  it('maps only stable upstream errors without exposing response bodies', async () => {
    const rejected = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: vi.fn().mockResolvedValue({
          code: 'SQL_FAILURE', message: 'private SQL', serviceKey: 'server-secret', payload: 'private',
        }),
      }),
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
