import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserLoginWaitCoordinator } from './browser-login-wait-coordinator.js'

describe('BrowserLoginWaitCoordinator', () => {
  let listeners: Array<(tabId: string) => void>
  let coordinator: BrowserLoginWaitCoordinator
  let now: number

  beforeEach(() => {
    vi.useFakeTimers()
    listeners = []
    now = 0
    coordinator = new BrowserLoginWaitCoordinator({
      onPageInvalidated: (listener) => {
        listeners.push(listener)
        return () => { listeners = listeners.filter((candidate) => candidate !== listener) }
      },
      now: () => now,
    })
  })

  afterEach(() => {
    coordinator.dispose()
    vi.useRealTimers()
  })

  const invalidate = (tabId: string) => {
    for (const listener of listeners) listener(tabId)
  }

  it('debounces matching page events and resolves only after authentication', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce('required')
      .mockResolvedValueOnce('authenticated')
    const waiting = coordinator.wait({ runId: 'run_1', tabId: 'tab_1', probe })

    invalidate('tab_other')
    invalidate('tab_1')
    invalidate('tab_1')
    await vi.advanceTimersByTimeAsync(499)
    expect(probe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(probe).toHaveBeenCalledTimes(1)

    invalidate('tab_1')
    await vi.advanceTimersByTimeAsync(500)
    await expect(waiting).resolves.toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('uses a three-second fallback before one minute and ten seconds afterward', async () => {
    const probe = vi.fn()
      .mockImplementationOnce(async () => {
        now = 60_000
        return 'unknown' as const
      })
      .mockResolvedValueOnce('authenticated')
    const waiting = coordinator.wait({ runId: 'run_2', tabId: 'tab_2', probe })

    await vi.advanceTimersByTimeAsync(2_999)
    expect(probe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(waiting).resolves.toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('ignores an authenticated result invalidated while its probe is in flight', async () => {
    let resolveFirst!: (state: 'authenticated') => void
    const first = new Promise<'authenticated'>((resolve) => { resolveFirst = resolve })
    const probe = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce('authenticated')
    const waiting = coordinator.wait({ runId: 'run_race', tabId: 'tab_1', probe })
    let outcome = 'pending'
    void waiting.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })

    await vi.advanceTimersByTimeAsync(3_000)
    expect(probe).toHaveBeenCalledTimes(1)
    invalidate('tab_1')
    resolveFirst('authenticated')
    await Promise.resolve()

    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(499)
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(waiting).resolves.toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('retries a transient page change instead of ending the login wait', async () => {
    const probe = vi.fn()
      .mockRejectedValueOnce({ code: 'PAGE_CHANGED' })
      .mockResolvedValueOnce('authenticated')
    const waiting = coordinator.wait({ runId: 'run_page_change', tabId: 'tab_1', probe })
    let outcome = 'pending'
    void waiting.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })

    await vi.advanceTimersByTimeAsync(3_000)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(waiting).resolves.toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('rejects a second waiter for the same run without disturbing the first', async () => {
    const first = coordinator.wait({
      runId: 'run_conflict', tabId: 'tab_1', probe: async () => 'authenticated',
    })

    await expect(coordinator.wait({
      runId: 'run_conflict', tabId: 'tab_2', probe: async () => 'authenticated',
    })).rejects.toMatchObject({ code: 'CONFLICT' })

    invalidate('tab_1')
    await vi.advanceTimersByTimeAsync(500)
    await expect(first).resolves.toBeUndefined()
  })

  it('cancels an indefinite wait and removes its timers', async () => {
    const probe = vi.fn().mockResolvedValue('required')
    const waiting = coordinator.wait({ runId: 'run_cancel', tabId: 'tab_1', probe })

    coordinator.cancel('run_cancel')

    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.runAllTimersAsync()
    expect(probe).not.toHaveBeenCalled()
  })

  it('aborts and disposes without retaining page listeners', async () => {
    const controller = new AbortController()
    const waiting = coordinator.wait({
      runId: 'run_abort', tabId: 'tab_1', signal: controller.signal,
      probe: async () => 'required',
    })
    expect(listeners).toHaveLength(1)

    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' })
    coordinator.dispose()

    expect(listeners).toHaveLength(0)
  })
})
