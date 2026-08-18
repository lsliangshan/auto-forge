import { createHash } from 'node:crypto'
import type { ModelProviderSnapshotSource } from '../chat/model-provider.js'
import type { ProviderUsageRepository } from '../database/repositories.js'

const retryDelaysMs = [1_000, 5_000, 30_000] as const

type ProviderUsageReconcilerRepository = Pick<
  ProviderUsageRepository,
  'recoverPending' | 'listReconcilable' | 'report' | 'recordReconcileFailure'
>

export interface ProviderUsageReconcilerDependencies {
  providerUsage: ProviderUsageReconcilerRepository
  providers: ModelProviderSnapshotSource
  now?: () => number
}

export interface ReconcileProviderUsageOptions {
  signal: AbortSignal
  now?: number
}

export function fingerprintApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex')
}

function isTerminalError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const { code } = error
  return code === 'CREDENTIAL_INVALID' || code === 'MODEL_PROVIDER_ACCESS_DENIED'
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function nextReconcileAt(now: number, attempts: number): number | undefined {
  if (attempts === 0) return now + retryDelaysMs[1]
  if (attempts === 1) return now + retryDelaysMs[2]
  return undefined
}

export class ProviderUsageReconciler {
  private readonly now: () => number

  constructor(private readonly dependencies: ProviderUsageReconcilerDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  async recoverInterrupted(options: ReconcileProviderUsageOptions): Promise<void> {
    options.signal.throwIfAborted()
    const now = options.now ?? this.now()
    this.dependencies.providerUsage.recoverPending(now)
    await this.reconcileDue({ signal: options.signal, now })
  }

  async reconcileDue(options: ReconcileProviderUsageOptions): Promise<void> {
    const { signal } = options
    signal.throwIfAborted()
    const now = options.now ?? this.now()
    let snapshot
    try {
      snapshot = await this.dependencies.providers.acquire('openrouter')
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      if (hasCode(error, 'CREDENTIAL_UNAVAILABLE')) return
      throw error
    }
    signal.throwIfAborted()
    const getGenerationUsage = snapshot.provider.getGenerationUsage
    if (snapshot.apiKeyFingerprint === undefined || typeof getGenerationUsage !== 'function') return
    const usages = this.dependencies.providerUsage.listReconcilable(now)

    for (const usage of usages) {
      signal.throwIfAborted()
      if (usage.apiKeyFingerprint !== snapshot.apiKeyFingerprint || usage.generationId === undefined) continue
      let generation
      try {
        signal.throwIfAborted()
        generation = await getGenerationUsage.call(snapshot.provider, usage.generationId, signal)
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        if (isTerminalError(error)) {
          this.dependencies.providerUsage.recordReconcileFailure(usage.operationKey)
          continue
        }
        this.dependencies.providerUsage.recordReconcileFailure(
          usage.operationKey,
          nextReconcileAt(now, usage.reconcileAttempts),
        )
        continue
      }
      signal.throwIfAborted()

      if (generation.costUsd !== undefined) {
        this.dependencies.providerUsage.report(usage.operationKey, {
          costUsd: generation.costUsd,
          endedAt: now,
        })
        continue
      }
      this.dependencies.providerUsage.recordReconcileFailure(
        usage.operationKey,
        nextReconcileAt(now, usage.reconcileAttempts),
      )
    }
  }
}
