import { describe, expect, it, vi } from 'vitest'
import {
  closeDesktopApplicationResources,
  completeApplicationShutdown,
} from './application-shutdown-completion.js'

describe('application shutdown completion', () => {
  it('waits for conversion drain before closing application and user databases', async () => {
    let releaseStop!: () => void
    const stop = new Promise<void>((resolve) => { releaseStop = resolve })
    const order: string[] = []

    const completion = closeDesktopApplicationResources({
      stopConversionJobs: async () => {
        order.push('stop-conversions')
        await stop
      },
      closeApplication: async () => { order.push('application') },
      resetUserDataStores: () => { order.push('reset-user-stores') },
      closeUserDataStores: () => { order.push('close-user-stores') },
    })

    await Promise.resolve()
    expect(order).toEqual(['stop-conversions'])
    releaseStop()
    await completion
    expect(order).toEqual(['stop-conversions', 'application', 'reset-user-stores', 'close-user-stores'])
  })

  it('closes and resets user stores after application close rejects while preserving that error', async () => {
    const applicationFailure = new Error('application close failed')
    const userStoreFailure = new Error('user store close failed')
    const order: string[] = []

    const completion = closeDesktopApplicationResources({
      closeApplication: async () => {
        order.push('application')
        throw applicationFailure
      },
      resetUserDataStores: () => { order.push('reset-user-stores') },
      closeUserDataStores: () => {
        order.push('close-user-stores')
        throw userStoreFailure
      },
    })

    await expect(completion).rejects.toBe(applicationFailure)
    expect(order).toEqual(['application', 'reset-user-stores', 'close-user-stores'])
  })

  it('defers the final development quit until the scheduled callback runs', async () => {
    const scheduled: Array<() => void> = []
    const quit = vi.fn()

    await completeApplicationShutdown({
      packaged: false,
      shutdown: async () => undefined,
      quit,
      defer: (callback) => { scheduled.push(callback) },
    })

    expect(quit).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    scheduled[0]!()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('keeps a development cleanup rejection unsettled until the deferred quit runs', async () => {
    const failure = new Error('cleanup failed')
    const scheduled: Array<() => void> = []
    const quit = vi.fn()

    const completion = completeApplicationShutdown({
      packaged: false,
      shutdown: async () => { throw failure },
      quit,
      defer: (callback) => { scheduled.push(callback) },
    })

    let settled = false
    void completion.finally(() => { settled = true }).catch(() => undefined)

    for (let microtask = 0; microtask < 5; microtask += 1) {
      await Promise.resolve()
    }

    expect(quit).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    expect(settled).toBe(false)
    scheduled[0]!()

    await expect(completion).rejects.toBe(failure)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('uses setImmediate for the default development deferral', async () => {
    const quit = vi.fn()
    const setImmediateSpy = vi.spyOn(globalThis, 'setImmediate')

    try {
      await completeApplicationShutdown({
        packaged: false,
        shutdown: async () => undefined,
        quit,
      })

      expect(setImmediateSpy).toHaveBeenCalledTimes(1)
      expect(quit).not.toHaveBeenCalled()

      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(quit).toHaveBeenCalledTimes(1)
    } finally {
      setImmediateSpy.mockRestore()
    }
  })

  it('preserves the immediate packaged final quit', async () => {
    const defer = vi.fn()
    const quit = vi.fn()

    await completeApplicationShutdown({
      packaged: true,
      shutdown: async () => undefined,
      quit,
      defer,
    })

    expect(defer).not.toHaveBeenCalled()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('preserves the immediate packaged final quit when cleanup rejects', async () => {
    const failure = new Error('cleanup failed')
    const defer = vi.fn()
    const quit = vi.fn()

    const completion = completeApplicationShutdown({
      packaged: true,
      shutdown: async () => { throw failure },
      quit,
      defer,
    })

    await expect(completion).rejects.toBe(failure)
    expect(defer).not.toHaveBeenCalled()
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
