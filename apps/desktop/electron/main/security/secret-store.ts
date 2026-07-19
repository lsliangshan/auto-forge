import type { EncryptedSecretsRepository } from '../database/repositories.js'

export interface SafeStoragePort {
  isAvailable(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<{ value: string; shouldReEncrypt: boolean }>
}

export class SecretStore {
  constructor(
    private readonly repository: EncryptedSecretsRepository,
    private readonly safeStorage: SafeStoragePort,
  ) {}

  async set(key: string, value: string): Promise<void> {
    if (!await this.safeStorage.isAvailable()) {
      throw new Error('Secure storage encryption is unavailable')
    }

    const ciphertext = await this.safeStorage.encrypt(value)
    this.repository.set(key, ciphertext.toString('base64'))
  }

  async get(key: string): Promise<string | undefined> {
    const secret = this.repository.get(key)
    if (!secret) return undefined
    if (!await this.safeStorage.isAvailable()) {
      throw new Error('Secure storage encryption is unavailable')
    }

    const decrypted = await this.safeStorage.decrypt(Buffer.from(secret.ciphertextBase64, 'base64'))
    if (decrypted.shouldReEncrypt) await this.set(key, decrypted.value)
    return decrypted.value
  }

  delete(key: string): void {
    this.repository.delete(key)
  }
}
