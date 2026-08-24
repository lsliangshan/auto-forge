import { afterEach, describe, expect, it } from 'vitest'
import {
  startCloudUserDataFixture,
  type CloudUserDataFixture,
} from '../../tests/e2e/cloud-user-data-sync-fixture.js'

let fixture: CloudUserDataFixture | undefined

interface FixtureCallResponse {
  data: {
    results?: unknown[]
    mutations?: unknown[]
    [key: string]: unknown
  }
}

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

async function call(input: Record<string, unknown>): Promise<FixtureCallResponse> {
  const response = await fetch(`${fixture!.origin}/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-autoforge-fixture-user': 'alice',
    },
    body: JSON.stringify(input),
  })
  expect(response.status).toBe(200)
  return response.json() as Promise<FixtureCallResponse>
}

function createMutation(title: string) {
  return {
    id: 'same_mutation_id',
    kind: 'conversation.create',
    entityId: 'same_conversation_id',
    baseRevision: 0,
    occurredAt: '2026-08-25T00:00:00.000Z',
    payload: {
      title,
      titleState: 'user_named',
      createdAt: '2026-08-25T00:00:00.000Z',
      lastActivityAt: '2026-08-25T00:00:00.000Z',
      metadataUpdatedAt: '2026-08-25T00:00:00.000Z',
    },
  }
}

function legacyImport(title: string) {
  return {
    action: 'importLegacyBatch',
    protocolVersion: 1,
    deviceId: 'fixture_device',
    batchId: 'same_import_batch',
    includeUnowned: false,
    conversations: [{
      id: 'imported_conversation',
      title,
      titleState: 'user_named',
      createdAt: '2026-08-25T00:00:00.000Z',
      lastActivityAt: '2026-08-25T00:00:00.000Z',
      metadataUpdatedAt: '2026-08-25T00:00:00.000Z',
    }],
    messages: [],
    cloudSyncConsent: {
      purpose: 'cloud_sync',
      documentVersion: 'cloud-sync-2026-08',
      consentedAt: '2026-08-25T00:00:00.000Z',
      clientVersion: '0.1.0-e2e',
    },
  }
}

describe('cloud user-data local double receipt identity', () => {
  it('duplicates an identical mutation but rejects changed content under the same ID', async () => {
    fixture = await startCloudUserDataFixture()
    const original = createMutation('原始标题')

    expect((await call({ action: 'syncPush', mutations: [original] })).data.results).toEqual([
      { id: 'same_mutation_id', status: 'applied', revision: 1 },
    ])
    expect((await call({ action: 'syncPush', mutations: [original] })).data.results).toEqual([
      { id: 'same_mutation_id', status: 'duplicate', revision: 1 },
    ])
    expect((await call({
      action: 'syncPush',
      mutations: [createMutation('篡改标题')],
    })).data.results).toEqual([
      { id: 'same_mutation_id', status: 'rejected', errorCode: 'INVALID_INPUT' },
    ])

    expect((await call({ action: 'syncPull', limit: 100 })).data.mutations).toHaveLength(1)
    await expect(fixture.snapshot('alice')).resolves.toMatchObject({
      conversations: [{ title: '原始标题', revision: 1 }],
      duplicateMutationCount: 1,
    })
  })

  it('duplicates an identical import batch but conflicts on changed batch content', async () => {
    fixture = await startCloudUserDataFixture()
    const original = legacyImport('原始迁移标题')

    expect((await call(original)).data).toMatchObject({
      batchId: 'same_import_batch',
      status: 'applied',
      importedConversations: 1,
    })
    expect((await call(original)).data).toEqual({
      batchId: 'same_import_batch',
      status: 'duplicate',
    })
    expect((await call(legacyImport('篡改迁移标题'))).data).toEqual({
      batchId: 'same_import_batch',
      status: 'rejected',
      errorCode: 'SYNC_CONFLICT',
    })

    expect((await call({ action: 'syncPull', limit: 100 })).data.mutations).toHaveLength(2)
    await expect(fixture.snapshot('alice')).resolves.toMatchObject({
      importedBatchCount: 1,
      conversations: [{ title: '原始迁移标题', revision: 1 }],
    })
  })
})
