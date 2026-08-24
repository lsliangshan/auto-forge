import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserContinuationActivity } from './browser-continuation-types.js'
import { BrowserManualResumeCoordinator } from './browser-manual-resume-coordinator.js'

describe('BrowserManualResumeCoordinator', () => {
  let listeners: Array<(activity: BrowserContinuationActivity) => void>
  let unsubscribe: ReturnType<typeof vi.fn<() => void>>
  let coordinator: BrowserManualResumeCoordinator

  beforeEach(() => {
    vi.useFakeTimers()
    listeners = []
    unsubscribe = vi.fn<() => void>(() => { listeners = [] })
    coordinator = new BrowserManualResumeCoordinator({
      onActivity: (listener) => {
        listeners.push(listener)
        return unsubscribe
      },
    })
  })

  afterEach(() => {
    coordinator.dispose()
    vi.useRealTimers()
  })

  const activity = (value: BrowserContinuationActivity) => {
    for (const listener of listeners) listener(value)
  }

  it('arms only after newer physical input and promotes after five quiet seconds', async () => {
    const promote = vi.fn().mockResolvedValue(undefined)
    const waiting = coordinator.wait({
      runId: 'run_1', tabId: 'tab_1', baselineActivityRevision: 4, promote,
    })

    activity({ tabId: 'tab_1', revision: 5, kind: 'page_change' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(promote).not.toHaveBeenCalled()

    activity({ tabId: 'tab_1', revision: 6, kind: 'physical_input' })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(promote).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(promote).toHaveBeenCalledOnce()
    await expect(waiting).resolves.toBeUndefined()
  })

  it('observes physical input before wait registration and uses the remaining quiet time', async () => {
    const promote = vi.fn().mockResolvedValue(undefined)

    activity({ tabId: 'tab_1', revision: 5, kind: 'physical_input' })
    await vi.advanceTimersByTimeAsync(1_000)
    activity({ tabId: 'tab_1', revision: 6, kind: 'page_change' })
    await vi.advanceTimersByTimeAsync(2_000)
    const waiting = coordinator.wait({
      runId: 'run_pre_registration', tabId: 'tab_1', baselineActivityRevision: 4, promote,
    })
    void waiting.catch(() => {})

    await vi.advanceTimersByTimeAsync(2_999)
    expect(promote).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(promote).toHaveBeenCalledOnce()
    await expect(waiting).resolves.toBeUndefined()
  })

  it('ignores other tabs and revisions at or below the latest observed revision', async () => {
    const promote = vi.fn().mockResolvedValue(undefined)
    const waiting = coordinator.wait({
      runId: 'run_stale', tabId: 'tab_1', baselineActivityRevision: 4, promote,
    })

    activity({ tabId: 'tab_other', revision: 8, kind: 'physical_input' })
    activity({ tabId: 'tab_1', revision: 4, kind: 'physical_input' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(promote).not.toHaveBeenCalled()

    activity({ tabId: 'tab_1', revision: 5, kind: 'physical_input' })
    activity({ tabId: 'tab_1', revision: 5, kind: 'page_change' })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(promote).toHaveBeenCalledOnce()
    await expect(waiting).resolves.toBeUndefined()
  })

  it('resets the quiet timer when activity arrives at 4,999 milliseconds', async () => {
    const promote = vi.fn().mockResolvedValue(undefined)
    const waiting = coordinator.wait({
      runId: 'run_reset', tabId: 'tab_1', baselineActivityRevision: 0, promote,
    })

    activity({ tabId: 'tab_1', revision: 1, kind: 'physical_input' })
    await vi.advanceTimersByTimeAsync(4_999)
    activity({ tabId: 'tab_1', revision: 2, kind: 'page_change' })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(promote).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(promote).toHaveBeenCalledOnce()
    await expect(waiting).resolves.toBeUndefined()
  })

  it('invalidates an in-flight promotion and waits for another quiet window', async () => {
    let resolveFirst!: () => void
    const firstPromotion = new Promise<void>((resolve) => { resolveFirst = resolve })
    const promote = vi.fn()
      .mockImplementationOnce(() => firstPromotion)
      .mockResolvedValueOnce(undefined)
    const waiting = coordinator.wait({
      runId: 'run_race', tabId: 'tab_1', baselineActivityRevision: 0, promote,
    })
    let outcome = 'pending'
    void waiting.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })

    activity({ tabId: 'tab_1', revision: 1, kind: 'physical_input' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(promote).toHaveBeenCalledTimes(1)
    activity({ tabId: 'tab_1', revision: 2, kind: 'page_change' })
    resolveFirst()
    await Promise.resolve()

    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(promote).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(promote).toHaveBeenCalledTimes(2)
    await expect(waiting).resolves.toBeUndefined()
  })

  it('keeps the waiter armed and retries after PAGE_CHANGED', async () => {
    const promote = vi.fn()
      .mockRejectedValueOnce({ code: 'PAGE_CHANGED' })
      .mockResolvedValueOnce(undefined)
    const waiting = coordinator.wait({
      runId: 'run_page_changed', tabId: 'tab_1', baselineActivityRevision: 2, promote,
    })

    activity({ tabId: 'tab_1', revision: 3, kind: 'physical_input' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(promote).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(promote).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(promote).toHaveBeenCalledTimes(2)
    await expect(waiting).resolves.toBeUndefined()
  })

  it('rejects terminal promotion failures without retrying', async () => {
    const promote = vi.fn().mockRejectedValue({ code: 'INTERNAL_ERROR' })
    const waiting = coordinator.wait({
      runId: 'run_terminal', tabId: 'tab_1', baselineActivityRevision: 0, promote,
    })
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })

    activity({ tabId: 'tab_1', revision: 1, kind: 'physical_input' })
    await vi.advanceTimersByTimeAsync(5_000)
    await rejected
    await vi.advanceTimersByTimeAsync(60_000)

    expect(promote).toHaveBeenCalledOnce()
  })

  it('rejects duplicate run IDs without disturbing the original waiter', async () => {
    const promote = vi.fn().mockResolvedValue(undefined)
    const first = coordinator.wait({
      runId: 'run_conflict', tabId: 'tab_1', baselineActivityRevision: 0, promote,
    })

    await expect(coordinator.wait({
      runId: 'run_conflict', tabId: 'tab_2', baselineActivityRevision: 0,
      promote: async () => {},
    })).rejects.toMatchObject({ code: 'CONFLICT' })

    activity({ tabId: 'tab_1', revision: 1, kind: 'physical_input' })
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(first).resolves.toBeUndefined()
  })

  it('rejects abort, cancel, and dispose with CANCELLED', async () => {
    const controller = new AbortController()
    const aborted = coordinator.wait({
      runId: 'run_abort', tabId: 'tab_1', baselineActivityRevision: 0,
      signal: controller.signal, promote: async () => {},
    })
    const cancelled = coordinator.wait({
      runId: 'run_cancel', tabId: 'tab_2', baselineActivityRevision: 0,
      promote: async () => {},
    })
    const disposed = coordinator.wait({
      runId: 'run_dispose', tabId: 'tab_3', baselineActivityRevision: 0,
      promote: async () => {},
    })
    const abortedExpectation = expect(aborted).rejects.toMatchObject({ code: 'CANCELLED' })
    const cancelledExpectation = expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' })
    const disposedExpectation = expect(disposed).rejects.toMatchObject({ code: 'CANCELLED' })

    controller.abort()
    coordinator.cancel('run_cancel')
    coordinator.dispose()

    await Promise.all([abortedExpectation, cancelledExpectation, disposedExpectation])
    await expect(coordinator.wait({
      runId: 'run_after_dispose', tabId: 'tab_1', baselineActivityRevision: 0,
      promote: async () => {},
    })).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('cleans timers, abort listeners, and the activity subscription exactly once', async () => {
    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout')
    const waiting = coordinator.wait({
      runId: 'run_cleanup', tabId: 'tab_1', baselineActivityRevision: 0,
      signal: controller.signal, promote: async () => {},
    })
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' })

    activity({ tabId: 'tab_1', revision: 1, kind: 'physical_input' })
    expect(vi.getTimerCount()).toBe(1)
    coordinator.cancel('run_cleanup')
    coordinator.cancel('run_cleanup')
    coordinator.dispose()
    coordinator.dispose()

    await rejected
    expect(vi.getTimerCount()).toBe(0)
    expect(clearTimer).toHaveBeenCalledOnce()
    expect(addListener).toHaveBeenCalledOnce()
    expect(removeListener).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
