import { describe, expect, it, vi } from 'vitest'
import type {
  GenerationUsageProviderPort,
  ModelProviderSnapshot,
  ModelProviderSnapshotSource,
} from '../chat/model-provider.js'
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

function providerSnapshot(options: {
  fingerprint?: string
  includeCapability?: boolean
  getGenerationUsage?: GenerationUsageProviderPort['getGenerationUsage']
} = {}): ModelProviderSnapshot {
  const getGenerationUsage = options.getGenerationUsage
    ?? vi.fn(async (generationId: string) => ({ generationId, costUsd: '0.25' }))
  return {
    providerId: 'openrouter',
    ...(options.fingerprint === undefined
      ? { apiKeyFingerprint: fingerprintApiKey('key_1') }
      : options.fingerprint === '' ? {} : { apiKeyFingerprint: options.fingerprint }),
    provider: {
      listModels: async () => [],
      validateCredential: async () => ({ valid: true }),
      stream: async function* () {},
      ...(options.includeCapability === false ? {} : { getGenerationUsage }),
    },
  }
}

function createHarness(options: {
  events?: ProviderUsageEvent[]
  now?: number
  snapshot?: ModelProviderSnapshot
  acquire?: ModelProviderSnapshotSource['acquire']
} = {}) {
  let currentNow = options.now ?? 1_000
  const repository = new FakeProviderUsageRepository(options.events ?? [event()])
  const snapshot = options.snapshot ?? providerSnapshot()
  const providers: ModelProviderSnapshotSource = {
    acquire: options.acquire ?? vi.fn(async () => snapshot),
  }
  const reconciler = new ProviderUsageReconciler({
    providerUsage: repository,
    providers,
    now: () => currentNow,
  })
  return {
    repository,
    snapshot,
    providers,
    reconciler,
    setNow(now: number) { currentNow = now },
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
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
  it('rejects an already-aborted round before recovery or snapshot acquisition', async () => {
    const controller = new AbortController()
    controller.abort()
    const harness = createHarness()

    await expect(harness.reconciler.recoverInterrupted({ signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })

    expect(harness.repository.recoverPending).not.toHaveBeenCalled()
    expect(harness.providers.acquire).not.toHaveBeenCalled()
    expect(harness.repository.failures).toEqual([])
  })

  it('recovers pending usage, then reconciles only events due before the new 1s delay', async () => {
    const due = event({ id: 'due', operationKey: 'due', nextReconcileAt: 1_000 })
    const pending = event({ id: 'pending', operationKey: 'pending', status: 'pending', nextReconcileAt: undefined })
    const harness = createHarness({ events: [due, pending] })

    await harness.reconciler.recoverInterrupted({ signal: signal() })

    expect(harness.repository.recoverPending).toHaveBeenCalledWith(1_000)
    expect(harness.snapshot.provider.getGenerationUsage).toHaveBeenCalledTimes(1)
    expect(pending).toMatchObject({ status: 'unknown', endedAt: 20, nextReconcileAt: 2_000 })
  })

  it('acquires one credential-bound snapshot for fingerprint comparison and every lookup in a round', async () => {
    const lookup = vi.fn(async (generationId: string, requestSignal?: AbortSignal) => ({
      generationId,
      costUsd: '0.25',
      requestSignal,
    }))
    const snapshot = providerSnapshot({ getGenerationUsage: lookup })
    const harness = createHarness({
      events: [event({ operationKey: 'one' }), event({ id: 'two', operationKey: 'two', generationId: 'generation_2' })],
      snapshot,
    })
    const roundSignal = signal()

    await harness.reconciler.reconcileDue({ signal: roundSignal })

    expect(harness.providers.acquire).toHaveBeenCalledTimes(1)
    expect(harness.providers.acquire).toHaveBeenCalledWith('openrouter')
    expect(lookup).toHaveBeenNthCalledWith(1, 'generation_1', roundSignal)
    expect(lookup).toHaveBeenNthCalledWith(2, 'generation_2', roundSignal)
  })

  it('does not consume an attempt when cancellation aborts an in-flight lookup', async () => {
    const controller = new AbortController()
    const lookup = vi.fn((_generationId: string, requestSignal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      requestSignal?.addEventListener('abort', () => reject(requestSignal.reason), { once: true })
    }))
    const harness = createHarness({ snapshot: providerSnapshot({ getGenerationUsage: lookup }) })
    const running = harness.reconciler.reconcileDue({ signal: controller.signal })
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))

    controller.abort()

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(harness.repository.failures).toEqual([])
    expect(harness.repository.events[0]?.reconcileAttempts).toBe(0)
  })

  it.each([
    ['missing credentials', async () => { throw { code: 'CREDENTIAL_UNAVAILABLE' } }, providerSnapshot()],
    ['missing capability', undefined, providerSnapshot({ includeCapability: false })],
    ['missing fingerprint', undefined, providerSnapshot({ fingerprint: '' })],
    ['a different fingerprint', undefined, providerSnapshot({ fingerprint: fingerprintApiKey('key_2') })],
  ])('does not consume an attempt for %s', async (_description, acquire, snapshot) => {
    const harness = createHarness({
      snapshot,
      ...(acquire === undefined ? {} : { acquire }),
    })

    await harness.reconciler.reconcileDue({ signal: signal() })

    expect(harness.repository.failures).toEqual([])
    expect(harness.repository.events[0]?.reconcileAttempts).toBe(0)
    if (snapshot.provider.getGenerationUsage === undefined) {
      expect(snapshot.provider.getGenerationUsage).toBeUndefined()
    } else {
      expect(snapshot.provider.getGenerationUsage).not.toHaveBeenCalled()
    }
  })

  it('reports a zero generation cost and does not query reported usage twice', async () => {
    const lookup = vi.fn(async (generationId: string) => ({ generationId, costUsd: '0' }))
    const harness = createHarness({ snapshot: providerSnapshot({ getGenerationUsage: lookup }) })

    await harness.reconciler.reconcileDue({ signal: signal() })
    await harness.reconciler.reconcileDue({ signal: signal() })

    expect(harness.repository.reports).toEqual([{
      operationKey: 'operation_1',
      report: { costUsd: '0', endedAt: 1_000 },
    }])
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('schedules missing costs and retryable errors at 5s then 30s, then terminates after three queries', async () => {
    const lookup = vi.fn<GenerationUsageProviderPort['getGenerationUsage']>()
      .mockResolvedValueOnce({ generationId: 'generation_1' })
      .mockRejectedValueOnce({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
      .mockRejectedValueOnce({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
    const harness = createHarness({ snapshot: providerSnapshot({ getGenerationUsage: lookup }) })

    await harness.reconciler.reconcileDue({ signal: signal() })
    harness.setNow(6_000)
    await harness.reconciler.reconcileDue({ signal: signal() })
    harness.setNow(36_000)
    await harness.reconciler.reconcileDue({ signal: signal() })
    harness.setNow(100_000)
    await harness.reconciler.reconcileDue({ signal: signal() })

    expect(harness.repository.failures).toEqual([
      { operationKey: 'operation_1', nextReconcileAt: 6_000 },
      { operationKey: 'operation_1', nextReconcileAt: 36_000 },
      { operationKey: 'operation_1', nextReconcileAt: undefined },
    ])
    expect(lookup).toHaveBeenCalledTimes(3)
  })

  it.each(['CREDENTIAL_INVALID', 'MODEL_PROVIDER_ACCESS_DENIED'] as const)(
    'terminates immediately for %s',
    async (code) => {
      const lookup = vi.fn(async () => { throw { code } })
      const harness = createHarness({ snapshot: providerSnapshot({ getGenerationUsage: lookup }) })

      await harness.reconciler.reconcileDue({ signal: signal() })

      expect(harness.repository.failures).toEqual([
        { operationKey: 'operation_1', nextReconcileAt: undefined },
      ])
      expect(harness.repository.events[0]).toMatchObject({ reconcileAttempts: 1, nextReconcileAt: undefined })
    },
  )
})
