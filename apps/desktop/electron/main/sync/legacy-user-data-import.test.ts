import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LegacyImportConfirmRequest } from '@autoforge/shared'
import type { AppRepositories, Conversation, Message } from '../database/repositories.js'
import { CloudBaseUserDataPort, type CloudBaseUserDataCall } from '../cloud/cloudbase-user-data-port.js'
import { UserDataStoreManager } from '../database/user-data-client.js'
import { UserDataSyncEngine } from './user-data-sync-engine.js'
import { LegacyUserDataImporter } from './legacy-user-data-import.js'

const roots: string[] = []
const MAX_WIRE_BYTES = 1_048_576

const cloudConsent = {
  purpose: 'cloud_sync' as const,
  documentVersion: 'cloud-sync-2026-08',
  consentedAt: '2026-08-25T00:00:00.000Z',
  clientVersion: '0.1.0',
}
const unownedConsent = {
  purpose: 'legacy_unowned_import' as const,
  documentVersion: 'legacy-import-2026-08',
  consentedAt: '2026-08-25T00:00:01.000Z',
  clientVersion: '0.1.0',
}

function conversation(id: string, userId?: string, title = id, createdAt = 100): Conversation {
  return { id, title, titleState: 'user_named', ...(userId ? { userId } : {}), createdAt, updatedAt: createdAt + 10 }
}

function message(id: string, conversationId: string, createdAt = 200): Message {
  return { id, conversationId, role: 'user', blocks: [{ type: 'text', text: id }], createdAt } as Message
}

function harness(conversations: Conversation[], messages: Message[] = []) {
  const legacy = {
    conversations: {
      list: vi.fn(() => conversations.map((item) => ({ ...item }))),
      claimLegacyAndListForUser: vi.fn(() => { throw new Error('must stay read-only') }),
    },
    messages: {
      listForConversation: vi.fn((id: string) => messages
        .filter((item) => item.conversationId === id)
        .map((item) => ({ ...item }))),
    },
  } as unknown as Pick<AppRepositories, 'conversations' | 'messages'>
  const importLegacyBatch = vi.fn().mockResolvedValue({
    batchId: 'batch_1-0', status: 'applied', importedConversations: 1, importedMessages: 1,
  })
  const captureBinding = vi.fn(() => ({ userId: 'alice', generation: 1 }))
  const canImportLegacyBatch = vi.fn((_binding, input) => Buffer.byteLength(JSON.stringify({
    action: 'importLegacyBatch', protocolVersion: 1, deviceId: 'device-a', ...input,
  }), 'utf8') <= MAX_WIRE_BYTES)
  const importer = new LegacyUserDataImporter(legacy, {
    captureBinding, canImportLegacyBatch, importLegacyBatch,
  })
  return { importer, legacy, importLegacyBatch }
}

function confirmation(includeUnowned: boolean): LegacyImportConfirmRequest {
  return {
    batchId: 'batch_1', includeUnowned, cloudSyncConsent: cloudConsent,
    ...(includeUnowned ? { unownedImportConsent: unownedConsent } : {}),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('LegacyUserDataImporter', () => {
  it('previews owned and unowned conversations without claiming rows or exposing foreign owners', () => {
    const test = harness([
      conversation('owned_1', 'alice'), conversation('owned_2', 'alice'),
      conversation('unowned_1'), conversation('foreign_1', 'bob'),
    ])

    expect(test.importer.preview('alice')).toEqual({
      ownedCount: 2, unownedCount: 1, requiresUnownedConfirmation: true,
    })
    expect(test.legacy.conversations.claimLegacyAndListForUser).not.toHaveBeenCalled()
  })

  it('rejects missing unowned consent before reading messages or starting a remote import', async () => {
    const test = harness([conversation('unowned_1')])
    const invalid = { ...confirmation(true), unownedImportConsent: undefined }

    await expect(test.importer.import('alice', invalid)).rejects.toMatchObject({
      code: 'IMPORT_CONFIRMATION_REQUIRED',
    })
    expect(test.legacy.messages.listForConversation).not.toHaveBeenCalled()
    expect(test.importLegacyBatch).not.toHaveBeenCalled()
  })

  it('derives stable item identities, preserves relationships and timestamps, and excludes foreign rows', async () => {
    const original = [
      conversation('owned', 'alice', 'Owned', 1_000),
      conversation('unowned', undefined, 'Unowned', 2_000),
      conversation('foreign', 'bob', 'Foreign', 3_000),
    ]
    const test = harness(original, [
      message('owned_message', 'owned', 1_100),
      message('unowned_message', 'unowned', 2_100),
      message('foreign_message', 'foreign', 3_100),
    ])

    await test.importer.import('alice', confirmation(true))
    const request = test.importLegacyBatch.mock.calls[0]![1]

    expect(request).toMatchObject({
      batchId: 'batch_1-0', includeUnowned: true,
      cloudSyncConsent: cloudConsent, unownedImportConsent: unownedConsent,
    })
    expect(request.conversations).toEqual([
      {
        id: 'legacy_caea47fe6c05ff0e1442f734acdac795', title: 'Owned', titleState: 'user_named',
        createdAt: '1970-01-01T00:00:01.000Z', lastActivityAt: '1970-01-01T00:00:01.100Z',
        metadataUpdatedAt: '1970-01-01T00:00:01.010Z',
      },
      {
        id: 'legacy_6ce38694d7062dc9f9bf65633e515f89', title: 'Unowned', titleState: 'user_named',
        createdAt: '1970-01-01T00:00:02.000Z', lastActivityAt: '1970-01-01T00:00:02.100Z',
        metadataUpdatedAt: '1970-01-01T00:00:02.010Z', sourceUnowned: true,
      },
    ])
    expect(request.messages).toEqual([
      expect.objectContaining({
        id: 'legacy_a577d45669c37799b50364882dfda4d3',
        conversationId: 'legacy_caea47fe6c05ff0e1442f734acdac795',
        createdAt: '1970-01-01T00:00:01.100Z',
      }),
      expect.objectContaining({
        id: 'legacy_e912104b1029adc3343203f59a05e80f',
        conversationId: 'legacy_6ce38694d7062dc9f9bf65633e515f89',
        createdAt: '1970-01-01T00:00:02.100Z', sourceUnowned: true,
      }),
    ])
    expect(JSON.stringify(request)).not.toContain('foreign')
    expect(original).toEqual([
      conversation('owned', 'alice', 'Owned', 1_000),
      conversation('unowned', undefined, 'Unowned', 2_000),
      conversation('foreign', 'bob', 'Foreign', 3_000),
    ])
  })

  it('uses deterministic duplicate requests and caps every batch at 100 records and one MiB', async () => {
    const rows = Array.from({ length: 105 }, (_, index) => (
      conversation(`owned_${index}`, 'alice', index === 0 ? 'x'.repeat(700_000) : `Owned ${index}`, index + 1)
    ))
    const test = harness(rows)
    test.importLegacyBatch.mockResolvedValue({ batchId: 'ignored', status: 'duplicate' })

    await test.importer.import('alice', confirmation(false))
    const firstRun = test.importLegacyBatch.mock.calls.map(([, request]) => request)
    test.importLegacyBatch.mockClear()
    await test.importer.import('alice', confirmation(false))
    const secondRun = test.importLegacyBatch.mock.calls.map(([, request]) => request)

    expect(secondRun).toEqual(firstRun)
    expect(firstRun.length).toBeGreaterThan(1)
    for (const request of firstRun) {
      expect(request.conversations.length + request.messages.length).toBeLessThanOrEqual(100)
      expect(Buffer.byteLength(JSON.stringify(request), 'utf8')).toBeLessThanOrEqual(1_048_576)
    }
  })

  it('stops after a rejected remote batch and surfaces only a safe failure', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => (
      conversation(`owned_${index}`, 'alice', `Owned ${index}`, index + 1)
    ))
    const test = harness(rows)
    test.importLegacyBatch.mockResolvedValueOnce({
      batchId: 'batch_1-0', status: 'rejected', errorCode: 'SYNC_CONFLICT',
    })

    await expect(test.importer.import('alice', confirmation(false)))
      .rejects.toMatchObject({ code: 'SYNC_CONFLICT' })
    expect(test.importLegacyBatch).toHaveBeenCalledTimes(1)
  })

  it('omits a legacy null execution id on the strict wire and preserves a string id', async () => {
    const legacy = harness([conversation('owned', 'alice', 'Owned', 1_000)], [
      { ...message('without_execution', 'owned', 1_100), executionId: null } as unknown as Message,
      { ...message('with_execution', 'owned', 1_200), executionId: 'execution_1' },
    ]).legacy
    const wireCalls: Extract<CloudBaseUserDataCall, { action: 'importLegacyBatch' }>[] = []
    const port = new CloudBaseUserDataPort({
      callFunction: vi.fn(async ({ data }) => {
        const batch = data as Extract<CloudBaseUserDataCall, { action: 'importLegacyBatch' }>
        wireCalls.push(structuredClone(batch))
        return { result: { ok: true, data: { batchId: batch.batchId, status: 'applied' } } }
      }),
    })
    const root = mkdtempSync(join(tmpdir(), 'autoforge-legacy-execution-id-'))
    roots.push(root)
    const stores = new UserDataStoreManager(root)
    const engine = new UserDataSyncEngine(port, stores)
    await engine.start('alice', 'device-a')
    const importer = new LegacyUserDataImporter(legacy, engine)

    await expect(importer.import('alice', confirmation(false))).resolves.toHaveLength(1)
    expect(wireCalls).toHaveLength(1)
    expect(wireCalls[0]!.messages).toEqual([
      expect.not.objectContaining({ executionId: expect.anything() }),
      expect.objectContaining({ executionId: 'execution_1' }),
    ])
    await engine.pause()
    stores.close()
  })

  it('splits at the exact final wire-call threshold through the real engine and strict port', async () => {
    const calibration = harness([
      conversation('owned', 'alice', 'Small', 1_000),
      conversation('large', 'alice', 'x', 2_000),
    ])
    await calibration.importer.import('alice', confirmation(false))
    const template = calibration.importLegacyBatch.mock.calls[0]![1]
    const templateCall = {
      action: 'importLegacyBatch' as const,
      protocolVersion: 1 as const,
      deviceId: 'device-a',
      ...template,
    }
    const padding = MAX_WIRE_BYTES - Buffer.byteLength(JSON.stringify(templateCall), 'utf8') + 1
    expect(padding).toBeGreaterThan(0)

    const legacy = harness([
      conversation('owned', 'alice', 'Small', 1_000),
      conversation('large', 'alice', 'x'.repeat(padding + 1), 2_000),
    ]).legacy
    const wireCalls: CloudBaseUserDataCall[] = []
    const port = new CloudBaseUserDataPort({
      callFunction: vi.fn(async ({ data }) => {
        wireCalls.push(structuredClone(data as CloudBaseUserDataCall))
        const batch = data as Extract<CloudBaseUserDataCall, { action: 'importLegacyBatch' }>
        return { result: { ok: true, data: { batchId: batch.batchId, status: 'applied' } } }
      }),
    })
    const root = mkdtempSync(join(tmpdir(), 'autoforge-legacy-wire-limit-'))
    roots.push(root)
    const stores = new UserDataStoreManager(root)
    const engine = new UserDataSyncEngine(port, stores)
    await engine.start('alice', 'device-a')
    const importer = new LegacyUserDataImporter(legacy, engine)

    await expect(importer.import('alice', confirmation(false))).resolves.toHaveLength(2)
    expect(wireCalls).toHaveLength(2)
    expect(wireCalls.map((call) => Buffer.byteLength(JSON.stringify(call), 'utf8')))
      .toEqual([expect.any(Number), expect.any(Number)])
    for (const call of wireCalls) {
      expect(Buffer.byteLength(JSON.stringify(call), 'utf8')).toBeLessThanOrEqual(MAX_WIRE_BYTES)
    }
    expect(wireCalls.map((call) => (
      call.action === 'importLegacyBatch' ? call.conversations.length : 0
    ))).toEqual([1, 1])
    await engine.pause()
    stores.close()
  })

  it('rejects one legacy record whose final wire call cannot fit', async () => {
    const test = harness([
      conversation('oversized', 'alice', 'x'.repeat(MAX_WIRE_BYTES), 1_000),
    ])

    await expect(test.importer.import('alice', confirmation(false)))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(test.importLegacyBatch).not.toHaveBeenCalled()
  })
})
