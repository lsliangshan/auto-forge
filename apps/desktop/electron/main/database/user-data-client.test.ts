import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SyncMutation } from '@autoforge/shared'
import { openAppDatabase } from './client.js'
import { UserDataStoreManager } from './user-data-client.js'

const temporaryDirectories: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoforge-user-cache-'))
  temporaryDirectories.push(root)
  return root
}

function createConversationMutation(id: string, entityId: string): SyncMutation {
  return {
    id,
    kind: 'conversation.create',
    entityId,
    baseRevision: 0,
    occurredAt: '2026-08-24T00:00:00.000Z',
    payload: {
      title: `Title ${entityId}`,
      titleState: 'pending',
      createdAt: '2026-08-24T00:00:00.000Z',
      lastActivityAt: '2026-08-24T00:00:00.000Z',
      metadataUpdatedAt: '2026-08-24T00:00:00.000Z',
    },
  }
}

function deleteConversationMutation(index: number): SyncMutation {
  return {
    id: `mutation_delete_${index}`,
    kind: 'conversation.delete',
    entityId: `conversation_delete_${index}`,
    baseRevision: 1,
    occurredAt: '2026-08-24T00:00:00.000Z',
    payload: {},
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('UserDataStoreManager', () => {
  it('isolates users behind domain-separated hash-only filenames', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    const alice = manager.open('cloud-alice')

    expect(manager.current()).toBe(alice)
    alice.outbox.recordWithConversation(createConversationMutation('mutation_alice', 'conversation_alice'))

    const expectedScope = createHash('sha256')
      .update('autoforge-user-cache-v1\0')
      .update('cloud-alice')
      .digest('hex')
      .slice(0, 32)
    const aliceFiles = readdirSync(root)
    expect(aliceFiles).toContain(`${expectedScope}.sqlite`)
    expect(aliceFiles.join('\n')).not.toContain('cloud-alice')

    manager.closeAndDelete('cloud-alice')
    expect(manager.current()).toBeUndefined()
    const bob = manager.open('cloud-bob')
    expect(bob.conversations.listPage({ limit: 50 })).toEqual({ items: [] })
    expect(readdirSync(root).some((name) => name.includes('cloud-alice'))).toBe(false)
    manager.close()
  })

  it('rolls back conversation state when its matching outbox insertion fails', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    store.outbox.record(createConversationMutation('duplicate_mutation', 'existing_conversation'))

    expect(() => store.outbox.recordWithConversation(
      createConversationMutation('duplicate_mutation', 'rolled_back_conversation'),
    )).toThrow()
    expect(store.conversations.get('rolled_back_conversation')).toBeUndefined()
    expect(store.outbox.countPending()).toBe(1)
    manager.close()
  })

  it('enforces the pending outbox cap before optimistic conversation state commits', () => {
    const manager = new UserDataStoreManager(temporaryRoot())
    const store = manager.open('cloud-alice')
    for (let index = 0; index < 10_000; index += 1) {
      store.outbox.record(deleteConversationMutation(index))
    }

    expect(() => store.outbox.recordWithConversation(
      createConversationMutation('mutation_over_limit', 'conversation_over_limit'),
    )).toThrow(expect.objectContaining({ code: 'OUTBOX_LIMIT_EXCEEDED' }))
    expect(store.conversations.get('conversation_over_limit')).toBeUndefined()
    expect(store.outbox.countPending()).toBe(10_000)
    manager.close()
  })

  it('deletes only the exact validated database and SQLite sidecars', () => {
    const root = temporaryRoot()
    const manager = new UserDataStoreManager(root)
    manager.open('cloud-alice')
    const databaseName = readdirSync(root).find((name) => name.endsWith('.sqlite'))
    expect(databaseName).toBeDefined()
    const databasePath = join(root, databaseName!)
    const preserved = join(root, `${databaseName}.backup`)
    const uidDecoy = join(root, 'cloud-alice.sqlite')
    manager.close()
    writeFileSync(`${databasePath}-wal`, '')
    writeFileSync(`${databasePath}-shm`, '')
    writeFileSync(`${databasePath}-journal`, '')
    writeFileSync(preserved, 'keep')
    writeFileSync(uidDecoy, 'keep')

    manager.closeAndDelete('cloud-alice')

    expect(existsSync(databasePath)).toBe(false)
    expect(existsSync(`${databasePath}-wal`)).toBe(false)
    expect(existsSync(`${databasePath}-shm`)).toBe(false)
    expect(existsSync(`${databasePath}-journal`)).toBe(false)
    expect(existsSync(preserved)).toBe(true)
    expect(existsSync(uidDecoy)).toBe(true)
    expect(basename(databasePath)).toMatch(/^[0-9a-f]{32}\.sqlite$/)
  })
})

describe('global legacy conversation storage', () => {
  it('does not auto-claim or clear legacy conversation rows from production paths', () => {
    const root = temporaryRoot()
    const database = openAppDatabase(join(root, 'autoforge.sqlite'))
    database.conversations.insert({ id: 'legacy_unowned', title: 'Legacy' })

    expect(database.conversations.claimLegacyAndListForUser('cloud-alice')).toEqual([])
    expect(database.conversations.get('legacy_unowned')?.userId).toBeUndefined()

    database.clearConversations()
    database.clearLocalData('conversations')
    database.clearLocalData('all')
    expect(database.conversations.get('legacy_unowned')).toMatchObject({ id: 'legacy_unowned' })
    database.close()
  })
})
