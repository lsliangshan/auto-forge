import { describe, expect, it, vi } from 'vitest'
import { completeApplicationShutdown } from './application-shutdown-completion.js'

describe('application shutdown completion', () => {
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

  it('still defers one development quit when cleanup rejects', async () => {
    const failure = new Error('cleanup failed')
    const scheduled: Array<() => void> = []
    const quit = vi.fn()

    const completion = completeApplicationShutdown({
      packaged: false,
      shutdown: async () => { throw failure },
      quit,
      defer: (callback) => { scheduled.push(callback) },
    })

    await expect(completion).rejects.toBe(failure)
    expect(quit).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    scheduled[0]!()
    expect(quit).toHaveBeenCalledTimes(1)
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
})
