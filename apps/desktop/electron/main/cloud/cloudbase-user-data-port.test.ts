import { describe, expect, it, vi } from 'vitest'
import type { SyncMutation } from '@autoforge/shared'
import {
  CloudBaseUserDataPort,
  type CloudBaseUserDataCall,
} from './cloudbase-user-data-port.js'

const mutation: SyncMutation = {
  id: 'mutation_1',
  kind: 'conversation.create',
  entityId: 'conversation_1',
  baseRevision: 0,
  payload: {
    title: 'Conversation',
    titleState: 'user_named',
    createdAt: '2026-08-25T00:00:00.000Z',
    lastActivityAt: '2026-08-25T00:00:00.000Z',
    metadataUpdatedAt: '2026-08-25T00:00:00.000Z',
  },
  occurredAt: '2026-08-25T00:00:00.000Z',
}

describe('CloudBaseUserDataPort', () => {
  it('validates and forwards sync push and pull calls through the authenticated function port', async () => {
    const callFunction = vi.fn()
      .mockResolvedValueOnce({
        result: {
          ok: true,
          data: { results: [{ id: mutation.id, status: 'applied', revision: 1 }], cursor: 'cursor_push_0001' },
        },
      })
      .mockResolvedValueOnce({
        result: {
          ok: true,
          data: {
            mutations: [{
              id: mutation.id,
              kind: mutation.kind,
              entityId: mutation.entityId,
              baseRevision: mutation.baseRevision,
              resultRevision: 1,
              payload: mutation.payload,
              receivedAt: mutation.occurredAt,
            }],
            cursor: 'cursor_pull_0001',
          },
        },
      })
    const port = new CloudBaseUserDataPort({ callFunction })

    await expect(port.call({
      action: 'syncPush', protocolVersion: 1, deviceId: 'device-a', mutations: [mutation],
    })).resolves.toMatchObject({ ok: true, data: { cursor: 'cursor_push_0001' } })
    await expect(port.call({
      action: 'syncPull', protocolVersion: 1, deviceId: 'device-a', limit: 100,
    })).resolves.toMatchObject({ ok: true, data: { cursor: 'cursor_pull_0001' } })
    expect(callFunction).toHaveBeenNthCalledWith(1, {
      name: 'autoforge-user-data',
      data: { action: 'syncPush', protocolVersion: 1, deviceId: 'device-a', mutations: [mutation] },
    })
    expect(callFunction).toHaveBeenNthCalledWith(2, {
      name: 'autoforge-user-data',
      data: { action: 'syncPull', protocolVersion: 1, deviceId: 'device-a', limit: 100 },
    })
  })

  it('strictly forwards the existing legacy import, preference, and usage actions without an owner', async () => {
    const callFunction = vi.fn()
      .mockResolvedValueOnce({ result: { ok: true, data: {
        batchId: 'batch_1-0', status: 'applied', importedConversations: 1, importedMessages: 0,
      } } })
      .mockResolvedValueOnce({ result: { ok: true, data: {
        timezone: 'Asia/Shanghai', displayCurrency: 'CNY', revision: 1,
        updatedAt: '2026-08-25T00:00:00.000Z',
      } } })
      .mockResolvedValueOnce({ result: { ok: true, data: {
        startedAt: '2026-08-01T00:00:00.000Z', endedAt: '2026-08-25T00:00:00.000Z',
        inputTokens: 10, outputTokens: 5, estimatedCostUsd: '0.010000000000',
        estimatedCount: 1, unavailableCount: 2,
      } } })
    const port = new CloudBaseUserDataPort({ callFunction })
    const consent = {
      purpose: 'cloud_sync' as const, documentVersion: 'cloud-sync-2026-08',
      consentedAt: '2026-08-25T00:00:00.000Z', clientVersion: '0.1.0',
    }

    await expect(port.call({
      action: 'importLegacyBatch', protocolVersion: 1, deviceId: 'device-a', batchId: 'batch_1-0',
      includeUnowned: false, conversations: [{
        id: 'legacy_1', title: 'Legacy', titleState: 'user_named',
        createdAt: '2026-08-01T00:00:00.000Z', lastActivityAt: '2026-08-01T00:00:00.000Z',
        metadataUpdatedAt: '2026-08-01T00:00:00.000Z',
      }], messages: [], cloudSyncConsent: consent,
    })).resolves.toMatchObject({ ok: true, data: { status: 'applied' } })
    await expect(port.call({ action: 'getUserDataPreferences' }))
      .resolves.toMatchObject({ ok: true, data: { revision: 1 } })
    await expect(port.call({
      action: 'getUsageSnapshot', startedAt: '2026-08-01T00:00:00.000Z',
      endedAt: '2026-08-25T00:00:00.000Z',
    })).resolves.toMatchObject({
      ok: true, data: { estimatedCostUsd: '0.01', estimatedCount: 1 },
    })
    expect(JSON.stringify(callFunction.mock.calls)).not.toContain('ownerUserId')
    expect(JSON.stringify(callFunction.mock.calls)).not.toContain('userId')
  })

  it('records only legacy-import transport metadata when the remote rejects a batch', async () => {
    const diagnostics = vi.fn()
    const port = new CloudBaseUserDataPort({
      callFunction: vi.fn().mockResolvedValue({
        result: { ok: false, error: { code: 'INVALID_INPUT' } },
      }),
    }, undefined, diagnostics)

    await expect(port.call({
      action: 'importLegacyBatch', protocolVersion: 1, deviceId: 'device-a', batchId: 'batch_1-0',
      includeUnowned: false, conversations: [], messages: [], cloudSyncConsent: {
        purpose: 'cloud_sync', documentVersion: 'cloud-sync-2026-08',
        consentedAt: '2026-08-25T00:00:00.000Z', clientVersion: '0.1.0',
      },
    })).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })

    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      action: 'importLegacyBatch', stage: 'remote_error', code: 'INVALID_INPUT',
      conversationCount: 0, messageCount: 0,
    }))
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('cloud-sync-2026-08')
  })

  it('rejects oversized or secret-bearing dedicated action payloads before transport', async () => {
    const callFunction = vi.fn()
    const port = new CloudBaseUserDataPort({ callFunction })
    const base = {
      action: 'importLegacyBatch' as const, protocolVersion: 1 as const, deviceId: 'device-a',
      batchId: 'batch_1-0', includeUnowned: false, conversations: [], messages: [],
      cloudSyncConsent: {
        purpose: 'cloud_sync' as const, documentVersion: 'cloud-sync-2026-08',
        consentedAt: '2026-08-25T00:00:00.000Z', clientVersion: '0.1.0',
      },
    }
    await expect(port.call({ ...base, apiKey: 'secret' } as never))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(port.call({
      ...base,
      conversations: Array.from({ length: 101 }, (_, index) => ({
        id: `legacy_${index}`, title: 'Legacy', titleState: 'user_named' as const,
        createdAt: '2026-08-01T00:00:00.000Z', lastActivityAt: '2026-08-01T00:00:00.000Z',
        metadataUpdatedAt: '2026-08-01T00:00:00.000Z',
      })),
    })).rejects.toMatchObject({ code: 'OUTBOX_LIMIT_EXCEEDED' })
    expect(callFunction).not.toHaveBeenCalled()
  })

  it('maps an oversized mutation count to the Task 3 outbox limit', async () => {
    const callFunction = vi.fn()
    const port = new CloudBaseUserDataPort({ callFunction })

    await expect(port.call({
      action: 'syncPush',
      protocolVersion: 1,
      deviceId: 'device-a',
      mutations: Array.from({ length: 101 }, () => mutation),
    })).rejects.toMatchObject({ code: 'OUTBOX_LIMIT_EXCEEDED' })
    expect(callFunction).not.toHaveBeenCalled()
  })

  it('validates the exact push object before classifying its mutation count', async () => {
    const callFunction = vi.fn()
    const port = new CloudBaseUserDataPort({ callFunction })

    await expect(port.call({
      action: 'syncPush',
      protocolVersion: 1,
      deviceId: 'device-a',
      mutations: Array.from({ length: 101 }, () => mutation),
      secret: 'must-not-be-accepted',
    } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(callFunction).not.toHaveBeenCalled()
  })

  it('classifies unsupported protocol versions before schema validation', async () => {
    const callFunction = vi.fn()
    const port = new CloudBaseUserDataPort({ callFunction })

    await expect(port.call({
      action: 'syncPull', protocolVersion: 4, deviceId: 'device-a', limit: 100,
    } as never)).rejects.toMatchObject({ code: 'UPGRADE_REQUIRED' })
    expect(callFunction).not.toHaveBeenCalled()
  })

  it.each([2, 3] as const)(
    'accepts and forwards protocol v%s while retaining v1 compatibility',
    async (protocolVersion) => {
      for (const action of ['syncPush', 'syncPull'] as const) {
        const response = action === 'syncPush'
          ? { results: [{ id: mutation.id, status: 'applied', revision: 1 }] }
          : { mutations: [], cursor: null }
        const callFunction = vi.fn().mockResolvedValue({ result: { ok: true, data: response } })
        const port = new CloudBaseUserDataPort({ callFunction })
        const input: CloudBaseUserDataCall = action === 'syncPush'
          ? { action, protocolVersion, deviceId: 'device-a', mutations: [mutation] }
          : { action, protocolVersion, deviceId: 'device-a', limit: 100 }

        await expect(port.call(input)).resolves.toMatchObject({ ok: true })
        expect(callFunction).toHaveBeenCalledWith({
          name: 'autoforge-user-data',
          data: input,
        })
      }
    },
  )

  it('keeps the separate legacy import transaction on protocol v1', async () => {
    const callFunction = vi.fn()
    const port = new CloudBaseUserDataPort({ callFunction })

    await expect(port.call({
      action: 'importLegacyBatch',
      protocolVersion: 2,
      deviceId: 'device-a',
      batchId: 'batch_v2',
      includeUnowned: false,
      conversations: [],
      messages: [],
      cloudSyncConsent: {
        purpose: 'cloud_sync',
        documentVersion: 'cloud-sync-2026-08',
        consentedAt: '2026-08-25T00:00:00.000Z',
        clientVersion: '0.1.0',
      },
    } as never)).rejects.toMatchObject({ code: 'UPGRADE_REQUIRED' })
    expect(callFunction).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'device identifier',
      call: { action: 'syncPull', protocolVersion: 1, deviceId: ' device-a', limit: 100 },
    },
    {
      label: 'mutation identifier',
      call: {
        action: 'syncPush', protocolVersion: 1, deviceId: 'device-a',
        mutations: [{ ...mutation, id: ' mutation_1' }],
      },
    },
  ])('rejects rather than trims a whitespace-padded $label', async ({ call }) => {
    const callFunction = vi.fn()
    const port = new CloudBaseUserDataPort({ callFunction })

    await expect(port.call(call as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(callFunction).not.toHaveBeenCalled()
  })

  it('enforces the Task 3 one-mebibyte serialized event boundary', async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: { ok: true, data: { results: [], cursor: 'cursor_boundary_01' } },
    })
    const port = new CloudBaseUserDataPort({ callFunction })
    const event = {
      action: 'syncPush' as const,
      protocolVersion: 1 as const,
      deviceId: 'device-a',
      mutations: [{ ...mutation, payload: { ...mutation.payload, title: '' } }],
    }
    const fixedBytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
    const exact = {
      ...event,
      mutations: [{
        ...mutation,
        payload: { ...mutation.payload, title: 'x'.repeat(1_048_576 - fixedBytes) },
      }],
    }

    await port.call(exact)
    await expect(port.call({
      ...exact,
      mutations: [{
        ...exact.mutations[0],
        payload: { ...exact.mutations[0].payload, title: `${exact.mutations[0].payload.title}x` },
      }],
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(callFunction).toHaveBeenCalledOnce()
    expect(Buffer.byteLength(JSON.stringify(callFunction.mock.calls[0]?.[0].data), 'utf8'))
      .toBe(1_048_576)
  })

  it('accepts Task 3 reduced legacy receipts on pull', async () => {
    const receipt = {
      id: 'legacy_receipt_1',
      kind: 'legacy.import' as const,
      entityId: 'legacy_batch_1',
      baseRevision: 0,
      resultRevision: 0,
      payload: { batchId: 'legacy_batch_1', includeUnowned: false },
      receivedAt: '2026-08-25T00:00:00.000Z',
    }
    const port = new CloudBaseUserDataPort({
      callFunction: vi.fn().mockResolvedValue({
        result: { ok: true, data: { mutations: [receipt], cursor: 'cursor_legacy_pull_1' } },
      }),
    })

    await expect(port.call({
      action: 'syncPull', protocolVersion: 1, deviceId: 'device-a', limit: 100,
    })).resolves.toEqual({ ok: true, data: { mutations: [receipt], cursor: 'cursor_legacy_pull_1' } })
  })

  it('returns only strict safe error envelopes', async () => {
    const port = new CloudBaseUserDataPort({
      callFunction: vi.fn().mockResolvedValue({
        result: { ok: false, error: { code: 'AUTH_REQUIRED' } },
      }),
    })

    await expect(port.call({
      action: 'syncPull', protocolVersion: 1, deviceId: 'device-a', limit: 100,
    })).resolves.toEqual({ ok: false, error: { code: 'AUTH_REQUIRED' } })
  })

  it('rejects safe application codes outside Task 3 user-data errors', async () => {
    const port = new CloudBaseUserDataPort({
      callFunction: vi.fn().mockResolvedValue({
        result: { ok: false, error: { code: 'SYNC_FAILED' } },
      }),
    })

    await expect(port.call({
      action: 'syncPull', protocolVersion: 1, deviceId: 'device-a', limit: 100,
    })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('discards CloudBase transport metadata outside the strict result envelope', async () => {
    const port = new CloudBaseUserDataPort({
      callFunction: vi.fn().mockResolvedValue({
        requestId: 'cloudbase-request-1',
        result: { ok: true, data: { mutations: [], cursor: null } },
      }),
    })

    await expect(port.call({
      action: 'syncPull', protocolVersion: 1, deviceId: 'device-a', limit: 100,
    })).resolves.toEqual({ ok: true, data: { mutations: [], cursor: null } })
  })

  it.each([
    { label: 'extra secret field', value: { result: { ok: false, error: { code: 'AUTH_REQUIRED', secret: 'token-value' } } } },
    { label: 'malformed success', value: { result: { ok: true, data: { mutations: [], cursor: null, content: 'private' } } } },
    { label: 'sensitive remote row', value: { result: { ok: true, data: { mutations: [{
      id: mutation.id,
      kind: mutation.kind,
      entityId: mutation.entityId,
      baseRevision: mutation.baseRevision,
      resultRevision: 1,
      payload: mutation.payload,
      receivedAt: mutation.occurredAt,
      clientSecret: 'token-value',
    }], cursor: 'cursor_pull_0001' } } } },
  ])('rejects $label without exposing remote values', async ({ value }) => {
    const port = new CloudBaseUserDataPort({ callFunction: vi.fn().mockResolvedValue(value) })

    const error = await port.call({
      action: 'syncPull', protocolVersion: 1, deviceId: 'device-a', limit: 100,
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Unexpected application error' })
    expect(JSON.stringify(error)).not.toContain('token-value')
    expect(JSON.stringify(error)).not.toContain('private')
  })

  it.each([
    { failure: new Error('socket leaked /secret/path'), code: 'SERVICE_UNAVAILABLE' },
    { failure: { statusCode: 503, message: 'upstream body' }, code: 'SERVICE_UNAVAILABLE' },
    { failure: { statusCode: 401, message: 'session token' }, code: 'AUTH_REQUIRED' },
    { failure: { statusCode: 422, message: 'request payload' }, code: 'INVALID_INPUT' },
  ])('classifies invocation failures as $code without leaking details', async ({ failure, code }) => {
    const port = new CloudBaseUserDataPort({ callFunction: vi.fn().mockRejectedValue(failure) })

    const error = await port.call({
      action: 'syncPull', protocolVersion: 1, deviceId: 'device-a', limit: 100,
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code })
    expect(JSON.stringify(error)).not.toContain('secret')
    expect(JSON.stringify(error)).not.toContain('payload')
    expect(JSON.stringify(error)).not.toContain('upstream')
  })
})
