import { createHash } from 'node:crypto'
import type {
  GenerationUsageProviderPort,
  ModelCredentialPort,
} from '../chat/model-provider.js'
import type { ProviderUsageRepository } from '../database/repositories.js'

const retryDelaysMs = [1_000, 5_000, 30_000] as const

type ProviderUsageReconcilerRepository = Pick<
  ProviderUsageRepository,
  'recoverPending' | 'listReconcilable' | 'report' | 'recordReconcileFailure'
>

export interface ProviderUsageReconcilerDependencies {
  providerUsage: ProviderUsageReconcilerRepository
  provider: GenerationUsageProviderPort
  credential: ModelCredentialPort
  now?: () => number
}

export function fingerprintApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex')
}

function isTerminalError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const { code } = error
  return code === 'CREDENTIAL_INVALID' || code === 'MODEL_PROVIDER_ACCESS_DENIED'
}

export class ProviderUsageReconciler {
  private readonly now: () => number

  constructor(private readonly dependencies: ProviderUsageReconcilerDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  async recoverInterrupted(now = this.now()): Promise<void> {
    this.dependencies.providerUsage.recoverPending(now)
    await this.reconcileDue(now)
  }

  async reconcileDue(now = this.now()): Promise<void> {
    const apiKey = await this.dependencies.credential.get()
    if (!apiKey) return
    const apiKeyFingerprint = fingerprintApiKey(apiKey)
    const usages = this.dependencies.providerUsage.listReconcilable(now)

    for (const usage of usages) {
      if (usage.apiKeyFingerprint !== apiKeyFingerprint || usage.generationId === undefined) continue
      try {
        const generation = await this.dependencies.provider.getGenerationUsage(usage.generationId)
        if (generation.costUsd !== undefined) {
          this.dependencies.providerUsage.report(usage.operationKey, {
            costUsd: generation.costUsd,
            endedAt: now,
          })
          continue
        }
      } catch (error) {
        if (isTerminalError(error)) {
          this.dependencies.providerUsage.recordReconcileFailure(usage.operationKey)
          continue
        }
      }

      const nextReconcileAt = usage.reconcileAttempts === 0
        ? now + retryDelaysMs[1]
        : usage.reconcileAttempts === 1
          ? now + retryDelaysMs[2]
          : undefined
      this.dependencies.providerUsage.recordReconcileFailure(usage.operationKey, nextReconcileAt)
    }
  }
}
