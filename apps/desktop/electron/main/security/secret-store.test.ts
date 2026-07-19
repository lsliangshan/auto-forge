import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openAppDatabase } from '../database/client.js'
import { SecretStore, type SafeStoragePort } from './secret-store.js'

const temporaryDirectories: string[] = []

function openTestDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-secrets-'))
  temporaryDirectories.push(directory)
  return openAppDatabase(join(directory, 'autoforge.sqlite'))
}

function fakeSafeStorage(options: { available?: boolean; shouldReEncrypt?: boolean } = {}): SafeStoragePort {
  let encryptionCount = 0
  return {
    isAvailable: async () => options.available ?? true,
    encrypt: async (value) => Buffer.from(JSON.stringify({ value, encryptionCount: encryptionCount++ })),
    decrypt: async (value) => ({
      value: (JSON.parse(value.toString()) as { value: string }).value,
      shouldReEncrypt: options.shouldReEncrypt ?? false,
    }),
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('SecretStore', () => {
  it('never stores the OpenRouter key as plaintext', async () => {
    const database = openTestDatabase()
    const store = new SecretStore(database.encryptedSecrets, fakeSafeStorage())

    await store.set('openrouter_api_key', 'sk-or-secret')

    expect(database.encryptedSecrets.raw('openrouter_api_key')).not.toContain('sk-or-secret')
    expect(await store.get('openrouter_api_key')).toBe('sk-or-secret')
  })

  it('rejects a save when encryption is unavailable', async () => {
    const database = openTestDatabase()
    const store = new SecretStore(database.encryptedSecrets, fakeSafeStorage({ available: false }))

    await expect(store.set('openrouter_api_key', 'sk-or-secret')).rejects.toThrow('unavailable')
    expect(database.encryptedSecrets.raw('openrouter_api_key')).toBeUndefined()
  })

  it('re-encrypts secrets when safe storage requests it after decryption', async () => {
    const database = openTestDatabase()
    const store = new SecretStore(database.encryptedSecrets, fakeSafeStorage({ shouldReEncrypt: true }))
    await store.set('openrouter_api_key', 'sk-or-secret')
    const firstCiphertext = database.encryptedSecrets.raw('openrouter_api_key')

    await store.get('openrouter_api_key')

    expect(database.encryptedSecrets.raw('openrouter_api_key')).not.toBe(firstCiphertext)
  })
})
