import { describe, expect, it, vi } from 'vitest'
import type { GenerationUsageProviderPort } from '../chat/model-provider.js'
import type {
  ProviderUsageEvent,
  ProviderUsageReport,
} from '../database/repositories.js'
import {
  fingerprintApiKey,
  ProviderUsageReconciler,
} from './provider-usage-reconciler.js'

function event(overrides: Partial<ProviderUsageEvent> = {}): ProviderUsageEvent {
  return {
    id: 'usage_1',
    operationKey: 'operation_1',
    userId: 'user_1',
    provider: 'openrouter',
    apiKeyFingerprint: fingerprintApiKey('key_1'),
    requestId: 'request_1',
    model: 'model_1',
    modality: 'text',
    status: 'unknown',
    reconcileAttempts: 0,
    generationId: 'generation_1',
    startedAt: 10,
    endedAt: 20,
    nextReconcileAt: 1_000,
    ...overrides,
  }
}

class FakeProviderUsageRepository {
  readonly events: ProviderUsageEvent[]
  readonly reports: Array<{ operationKey: string; report: ProviderUsageReport }> = []
  readonly failures: Array<{ operationKey: string; nextReconcileAt?: number }> = []
  readonly recoverPending = vi.fn((now: number) => {
    for (const usage of this.events) {
      if (usage.status !== 'pending') continue
      usage.status = 'unknown'
      usage.endedAt ??= now
      usage.nextReconcileAt = usage.provider === 'openrouter' && usage.generationId
        ? now + 1_000
        : undefined
    }
    return 0
  })

  constructor(events: ProviderUsageEvent[]) {
    this.events = events
  }

  listReconcilable(now: number): ProviderUsageEvent[] {
    return this.events.filter((usage) => (
      usage.provider === 'openrouter'
      && usage.status === 'unknown'
      && usage.generationId !== undefined
      && usage.reconcileAttempts < 3
      && usage.nextReconcileAt !== undefined
      && usage.nextReconcileAt <= now
    ))
  }

  report(operationKey: string, report: ProviderUsageReport): ProviderUsageEvent {
    this.reports.push({ operationKey, report })
    const usage = this.find(operationKey)
    usage.status = 'reported'
    usage.costUsd = String(report.costUsd)
    usage.endedAt = report.endedAt
    usage.nextReconcileAt = undefined
    return usage
  }

  recordReconcileFailure(operationKey: string, nextReconcileAt?: number): ProviderUsageEvent {
    this.failures.push({ operationKey, nextReconcileAt })
    const usage = this.find(operationKey)
    usage.reconcileAttempts += 1
    usage.nextReconcileAt = usage.reconcileAttempts >= 3 ? undefined : nextReconcileAt
    return usage
  }

  private find(operationKey: string): ProviderUsageEvent {
    const usage = this.events.find((candidate) => candidate.operationKey === operationKey)
    if (!usage) throw new Error('missing usage')
    return usage
  }
}

function createHarness(options: {
  events?: ProviderUsageEvent[]
  credential?: string
  now?: number
  getGenerationUsage?: GenerationUsageProviderPort['getGenerationUsage']
} = {}) {
  let currentNow = options.now ?? 1_000
  const repository = new FakeProviderUsageRepository(options.events ?? [event()])
  const provider: GenerationUsageProviderPort = {
    getGenerationUsage: options.getGenerationUsage ?? vi.fn(async (generationId) => ({
      generationId,
      costUsd: '0.25',
    })),
  }
  const credential = { get: vi.fn(async () => ('credential' in options ? options.credential : 'key_1')) }
  const reconciler = new ProviderUsageReconciler({
    providerUsage: repository,
    provider,
    credential,
    now: () => currentNow,
  })
  return {
    repository,
    provider,
    credential,
    reconciler,
    setNow(now: number) { currentNow = now },
  }
}

describe('fingerprintApiKey', () => {
  it('returns a stable SHA-256 hex digest without the API key', () => {
    const apiKey = 'sk-openrouter-private'
    const fingerprint = fingerprintApiKey(apiKey)

    expect(fingerprint).toBe('2554fbd80a4b44540e69c953031bc2504ba00e28b1af9c4d77586c2e7369a4b6')
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(fingerprint).not.toContain(apiKey)
  })
})

describe('ProviderUsageReconciler', () => {
  it('recovers pending usage, then reconciles only events due before the new 1s delay', async () => {
    const due = event({ id: 'due', operationKey: 'due', nextReconcileAt: 1_000 })
    const pending = event({
      id: 'pending',
      operationKey: 'pending',
      status: 'pending',
      nextReconcileAt: undefined,
    })
    const harness = createHarness({ events: [due, pending] })

    await harness.reconciler.recoverInterrupted()

    expect(harness.repository.recoverPending).toHaveBeenCalledWith(1_000)
    expect(harness.provider.getGenerationUsage).toHaveBeenCalledTimes(1)
    expect(harness.provider.getGenerationUsage).toHaveBeenCalledWith('generation_1')
    expect(pending).toMatchObject({ status: 'unknown', endedAt: 20, nextReconcileAt: 2_000 })
  })

  it('reports a zero generation cost and does not query reported usage twice', async () => {
    const usage = event({ nextReconcileAt: 1_000 })
    const harness = createHarness({
      events: [usage],
      getGenerationUsage: vi.fn(async (generationId) => ({ generationId, costUsd: '0' })),
    })

    await harness.reconciler.reconcileDue()
    await harness.reconciler.reconcileDue()

    expect(harness.repository.reports).toEqual([{
      operationKey: 'operation_1',
      report: { costUsd: '0', endedAt: 1_000 },
    }])
    expect(harness.provider.getGenerationUsage).toHaveBeenCalledTimes(1)
  })

  it('does not query events for another API key, absent credentials, or absent generations', async () => {
    const differentKey = event({ id: 'different', operationKey: 'different', apiKeyFingerprint: fingerprintApiKey('key_2') })
    const noGeneration = event({ id: 'no_generation', operationKey: 'no_generation', generationId: undefined })
    const matching = event({ id: 'matching', operationKey: 'matching' })
    const differentKeyHarness = createHarness({ events: [differentKey, noGeneration] })
    const noCredentialHarness = createHarness({ events: [matching], credential: undefined })

    await differentKeyHarness.reconciler.reconcileDue()
    await noCredentialHarness.reconciler.reconcileDue()

    expect(differentKeyHarness.provider.getGenerationUsage).not.toHaveBeenCalled()
    expect(differentKeyHarness.repository.failures).toEqual([])
    expect(noCredentialHarness.provider.getGenerationUsage).not.toHaveBeenCalled()
    expect(noCredentialHarness.repository.failures).toEqual([])
  })

  it('schedules missing costs and retryable errors at 5s then 30s, then terminates after three queries', async () => {
    const getGenerationUsage = vi.fn<GenerationUsageProviderPort['getGenerationUsage']>()
      .mockResolvedValueOnce({ generationId: 'generation_1' })
      .mockRejectedValueOnce({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
      .mockRejectedValueOnce({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
    const harness = createHarness({ getGenerationUsage })

    await harness.reconciler.reconcileDue()
    harness.setNow(6_000)
    await harness.reconciler.reconcileDue()
    harness.setNow(36_000)
    await harness.reconciler.reconcileDue()
    harness.setNow(100_000)
    await harness.reconciler.reconcileDue()

    expect(harness.repository.failures).toEqual([
      { operationKey: 'operation_1', nextReconcileAt: 6_000 },
      { operationKey: 'operation_1', nextReconcileAt: 36_000 },
      { operationKey: 'operation_1', nextReconcileAt: undefined },
    ])
    expect(harness.provider.getGenerationUsage).toHaveBeenCalledTimes(3)
    expect(harness.repository.events[0]).toMatchObject({
      status: 'unknown', reconcileAttempts: 3, nextReconcileAt: undefined,
    })
  })

  it.each(['CREDENTIAL_INVALID', 'MODEL_PROVIDER_ACCESS_DENIED'] as const)(
    'terminates immediately for %s',
    async (code) => {
      const harness = createHarness({
        getGenerationUsage: vi.fn(async () => { throw { code } }),
      })

      await harness.reconciler.reconcileDue()

      expect(harness.repository.failures).toEqual([
        { operationKey: 'operation_1', nextReconcileAt: undefined },
      ])
      expect(harness.repository.events[0]).toMatchObject({ reconcileAttempts: 1, nextReconcileAt: undefined })
    },
  )
})
