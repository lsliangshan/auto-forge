import { describe, expect, it, vi } from 'vitest'
import type { SyncMutation } from '@autoforge/shared'
import { CloudBaseUserDataPort } from './cloudbase-user-data-port.js'

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

  it('rejects invalid action input before calling CloudBase', async () => {
    const callFunction = vi.fn()
    const port = new CloudBaseUserDataPort({ callFunction })

    await expect(port.call({
      action: 'syncPush',
      protocolVersion: 1,
      deviceId: 'device-a',
      mutations: Array.from({ length: 101 }, () => mutation),
    })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'The request is invalid.' })
    expect(callFunction).not.toHaveBeenCalled()
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
