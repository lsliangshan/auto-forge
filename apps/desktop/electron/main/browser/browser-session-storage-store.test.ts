import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openAppDatabase } from '../database/client.js'
import { SecretStore, type SafeStoragePort } from '../security/secret-store.js'
import {
  EncryptedBrowserSessionStorageStore,
  browserSessionStorageSecretKey,
} from './browser-session-storage-store.js'

const temporaryDirectories: string[] = []
const databases: Array<ReturnType<typeof openAppDatabase>> = []

function testStore(safeStorageOverride?: SafeStoragePort) {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-browser-session-storage-'))
  temporaryDirectories.push(directory)
  const database = openAppDatabase(join(directory, 'autoforge.sqlite'))
  databases.push(database)
  const safeStorage: SafeStoragePort = safeStorageOverride ?? {
    isAvailable: async () => true,
    encrypt: async (value) => Buffer.from(value).reverse(),
    decrypt: async (value) => ({ value: Buffer.from(value).reverse().toString(), shouldReEncrypt: false }),
  }
  const secrets = new SecretStore(database.encryptedSecrets, safeStorage)
  return {
    database,
    secrets,
    store: new EncryptedBrowserSessionStorageStore(secrets),
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('EncryptedBrowserSessionStorageStore', () => {
  it('round-trips encrypted records while isolating AutoForge users and HTTPS origins', async () => {
    const { database, store } = testStore()

    await store.apply('user_alice', {
      type: 'set', origin: 'https://fw.example', key: 'PTOKEN', value: 'alice-private-token',
    })
    await store.apply('user_alice', {
      type: 'set', origin: 'https://portal.example', key: 'state', value: 'alice-portal-state',
    })
    await store.apply('user_bob', {
      type: 'set', origin: 'https://fw.example', key: 'PTOKEN', value: 'bob-private-token',
    })
    await store.drain()

    expect(await store.get('user_alice', ['https://fw.example'])).toEqual({
      'https://fw.example': { PTOKEN: 'alice-private-token' },
    })
    expect(await store.get('user_alice', ['https://portal.example'])).toEqual({
      'https://portal.example': { state: 'alice-portal-state' },
    })
    expect(await store.get('user_bob', ['https://fw.example'])).toEqual({
      'https://fw.example': { PTOKEN: 'bob-private-token' },
    })
    expect(database.encryptedSecrets.raw(browserSessionStorageSecretKey('user_alice')))
      .not.toMatch(/alice-private-token|alice-portal-state/)
    expect(database.encryptedSecrets.raw(browserSessionStorageSecretKey('user_bob')))
      .not.toContain('bob-private-token')
  })

  it('applies ordered set, remove, and origin-clear mutations', async () => {
    let releaseFirstEncryption!: () => void
    const firstEncryption = new Promise<void>((resolve) => { releaseFirstEncryption = resolve })
    let encryptionCount = 0
    const safeStorage: SafeStoragePort = {
      isAvailable: async () => true,
      encrypt: async (value) => {
        if (encryptionCount++ === 0) await firstEncryption
        return Buffer.from(value).reverse()
      },
      decrypt: async (value) => ({ value: Buffer.from(value).reverse().toString(), shouldReEncrypt: false }),
    }
    const { store } = testStore(safeStorage)

    const first = store.apply('user_alice', {
      type: 'set', origin: 'https://fw.example', key: 'PTOKEN', value: 'old-token',
    })
    const second = store.apply('user_alice', {
      type: 'set', origin: 'https://fw.example', key: 'PTOKEN', value: 'new-token',
    })
    releaseFirstEncryption()
    await Promise.all([first, second])
    expect(await store.get('user_alice', ['https://fw.example'])).toEqual({
      'https://fw.example': { PTOKEN: 'new-token' },
    })

    await store.apply('user_alice', {
      type: 'set', origin: 'https://fw.example', key: 'checkState', value: 'ready',
    })
    await store.apply('user_alice', {
      type: 'remove', origin: 'https://fw.example', key: 'PTOKEN',
    })
    expect(await store.get('user_alice', ['https://fw.example'])).toEqual({
      'https://fw.example': { checkState: 'ready' },
    })

    await store.apply('user_alice', { type: 'clear', origin: 'https://fw.example' })
    expect(await store.get('user_alice', ['https://fw.example'])).toEqual({})
  })

  it('rejects malformed or non-HTTPS persisted records without returning partial data', async () => {
    const { secrets } = testStore()
    await secrets.set(browserSessionStorageSecretKey('user_alice'), JSON.stringify({
      version: 1,
      origins: {
        'https://fw.example': { PTOKEN: 'must-not-partially-restore' },
        'http://unsafe.example': { state: 'unsafe' },
      },
    }))
    const reloaded = new EncryptedBrowserSessionStorageStore(secrets)

    expect(await reloaded.get('user_alice', [
      'https://fw.example',
      'http://unsafe.example',
    ])).toEqual({})
    await reloaded.apply('user_alice', {
      type: 'set', origin: 'http://unsafe.example', key: 'state', value: 'ignored',
    })
    expect(await reloaded.get('user_alice', ['http://unsafe.example'])).toEqual({})
  })

  it('clears only the selected AutoForge user encrypted record', async () => {
    const { database, store } = testStore()
    for (const userId of ['user_alice', 'user_bob']) {
      await store.apply(userId, {
        type: 'set', origin: 'https://fw.example', key: 'PTOKEN', value: `${userId}-token`,
      })
    }

    await store.clear('user_alice')

    expect(await store.get('user_alice', ['https://fw.example'])).toEqual({})
    expect(await store.get('user_bob', ['https://fw.example'])).toEqual({
      'https://fw.example': { PTOKEN: 'user_bob-token' },
    })
    expect(database.encryptedSecrets.raw(browserSessionStorageSecretKey('user_alice'))).toBeUndefined()
    expect(database.encryptedSecrets.raw(browserSessionStorageSecretKey('user_bob'))).toBeDefined()
  })

  it('drains a failed encrypted write without blocking browser shutdown', async () => {
    let releaseEncryption!: () => void
    const encryptionStarted = new Promise<void>((resolve) => { releaseEncryption = resolve })
    const { store } = testStore({
      isAvailable: async () => true,
      encrypt: async () => {
        await encryptionStarted
        throw new Error('Secure storage encryption is unavailable')
      },
      decrypt: async () => ({ value: '', shouldReEncrypt: false }),
    })
    const applying = store.apply('user_alice', {
      type: 'set', origin: 'https://fw.example', key: 'PTOKEN', value: 'private-token',
    })
    const draining = store.drain()

    releaseEncryption()
    await expect(applying).rejects.toThrow('unavailable')
    await expect(draining).resolves.toBeUndefined()
  })
})
