import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderUsageConsistencyError } from '../database/repositories.js'
import {
  createProviderUsageReconciliationLoop,
  type ProviderUsageReconciliationPort,
} from './provider-usage-reconciliation-loop.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createHarness(overrides: Partial<ProviderUsageReconciliationPort> = {}) {
  const reconciler: ProviderUsageReconciliationPort = {
    recoverInterrupted: vi.fn(async () => undefined),
    reconcileDue: vi.fn(async () => undefined),
    ...overrides,
  }
  return {
    reconciler,
    loop: createProviderUsageReconciliationLoop(reconciler),
  }
}

describe('ProviderUsageReconciliationLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts recovery once and schedules its first due round only after recovery settles', async () => {
    const recovery = deferred<void>()
    const harness = createHarness({
      recoverInterrupted: vi.fn(() => recovery.promise),
    })

    harness.loop.start()
    harness.loop.start()
    await vi.advanceTimersByTimeAsync(100_000)

    expect(harness.reconciler.recoverInterrupted).toHaveBeenCalledTimes(1)
    expect(harness.reconciler.reconcileDue).not.toHaveBeenCalled()

    recovery.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(harness.reconciler.reconcileDue).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.reconciler.reconcileDue).toHaveBeenCalledTimes(1)
    await harness.loop.stop()
  })

  it('starts each of exactly three delays after the preceding slow round settles', async () => {
    const first = deferred<void>()
    const reconcileDue = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined)
    const harness = createHarness({ reconcileDue })

    harness.loop.notifyUsageEnded()
    await vi.advanceTimersByTimeAsync(999)
    expect(reconcileDue).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(reconcileDue).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(100_000)
    expect(reconcileDue).toHaveBeenCalledTimes(1)
    first.resolve()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(reconcileDue).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(reconcileDue).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(reconcileDue).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(reconcileDue).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reconcileDue).toHaveBeenCalledTimes(3)

    await harness.loop.stop()
  })

  it('coalesces repeated notifications into one finite round sequence', async () => {
    const harness = createHarness()

    harness.loop.notifyUsageEnded()
    harness.loop.notifyUsageEnded()
    harness.loop.notifyUsageEnded()

    await vi.advanceTimersByTimeAsync(36_000)

    expect(harness.reconciler.reconcileDue).toHaveBeenCalledTimes(3)
    await harness.loop.stop()
  })

  it('clears pending timers on stop', async () => {
    const harness = createHarness()
    harness.loop.notifyUsageEnded()

    await harness.loop.stop()
    await vi.advanceTimersByTimeAsync(100_000)

    expect(harness.reconciler.reconcileDue).not.toHaveBeenCalled()
  })

  it('aborts an in-flight round and treats its cancellation as clean shutdown', async () => {
    let receivedSignal: AbortSignal | undefined
    const reconcileDue = vi.fn(({ signal }: { signal: AbortSignal }) => {
      receivedSignal = signal
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const harness = createHarness({ reconcileDue })
    harness.loop.notifyUsageEnded()
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(harness.loop.stop()).resolves.toBeUndefined()

    expect(receivedSignal?.aborted).toBe(true)
    expect(reconcileDue).toHaveBeenCalledTimes(1)
  })

  it('waits for an in-flight tail that observes abort but settles later', async () => {
    const inFlight = deferred<void>()
    let receivedSignal: AbortSignal | undefined
    const harness = createHarness({
      reconcileDue: vi.fn(({ signal }: { signal: AbortSignal }) => {
        receivedSignal = signal
        return inFlight.promise
      }),
    })
    harness.loop.notifyUsageEnded()
    await vi.advanceTimersByTimeAsync(1_000)

    let stopped = false
    const stopping = harness.loop.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(receivedSignal?.aborted).toBe(true)
    expect(stopped).toBe(false)

    inFlight.resolve()
    await stopping
    expect(stopped).toBe(true)
  })

  it('does not hide an unexpected failure raised while stop aborts the tail', async () => {
    const failure = new ProviderUsageConsistencyError()
    const harness = createHarness({
      reconcileDue: vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(failure), { once: true })
      })),
    })
    harness.loop.notifyUsageEnded()
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(harness.loop.stop()).rejects.toBe(failure)
  })

  it('preserves the first unexpected or consistency failure while later work drains', async () => {
    const first = new Error('first recovery failure')
    const later = new ProviderUsageConsistencyError()
    const harness = createHarness({
      recoverInterrupted: vi.fn(async () => { throw first }),
      reconcileDue: vi.fn(async () => { throw later }),
    })

    harness.loop.start()
    harness.loop.notifyUsageEnded()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(harness.reconciler.reconcileDue).toHaveBeenCalledTimes(1)
    await expect(harness.loop.stop()).rejects.toBe(first)
  })
})
