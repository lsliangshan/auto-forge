import { describe, expect, it, vi } from 'vitest'

interface WatchdogModule {
  isProcessAlive(pid: number, sendSignal?: (pid: number, signal: 0) => boolean): boolean
  startDevelopmentParentWatchdog(options: Record<string, unknown>): () => void
}

async function loadWatchdog(): Promise<WatchdogModule> {
  return import('./development-parent-watchdog.js') as unknown as Promise<WatchdogModule>
}

function createTimerHarness() {
  let callback: () => void = () => undefined
  const timer = { unref: vi.fn() }
  const schedule = vi.fn((next: () => void) => {
    callback = next
    return timer
  })
  const cancel = vi.fn()
  return { cancel, schedule, timer, tick: () => callback() }
}

describe('development parent watchdog', () => {
  it('treats ESRCH as missing and other errors as alive', async () => {
    const watchdog = await loadWatchdog()
    const missing = Object.assign(new Error('missing'), { code: 'ESRCH' })
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' })
    expect(watchdog.isProcessAlive(42, () => { throw missing })).toBe(false)
    expect(watchdog.isProcessAlive(42, () => { throw denied })).toBe(true)
    expect(watchdog.isProcessAlive(42, () => true)).toBe(true)
  })

  it('does not schedule in a packaged app', async () => {
    const watchdog = await loadWatchdog()
    const harness = createTimerHarness()
    const quit = vi.fn()
    const dispose = watchdog.startDevelopmentParentWatchdog({
      packaged: true,
      parentPid: 42,
      quit,
      schedule: harness.schedule,
      cancel: harness.cancel,
    })
    dispose()
    expect(harness.schedule).not.toHaveBeenCalled()
    expect(harness.cancel).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('quits once only after a development parent disappears', async () => {
    const watchdog = await loadWatchdog()
    const harness = createTimerHarness()
    const quit = vi.fn()
    watchdog.startDevelopmentParentWatchdog({
      packaged: false,
      parentPid: 42,
      quit,
      isParentAlive: () => false,
      schedule: harness.schedule,
      cancel: harness.cancel,
    })
    harness.tick()
    harness.tick()
    expect(quit).toHaveBeenCalledTimes(1)
    expect(harness.timer.unref).toHaveBeenCalledTimes(1)
  })

  it('does nothing while the parent is alive', async () => {
    const watchdog = await loadWatchdog()
    const harness = createTimerHarness()
    const quit = vi.fn()
    watchdog.startDevelopmentParentWatchdog({
      packaged: false,
      parentPid: 42,
      quit,
      isParentAlive: () => true,
      schedule: harness.schedule,
      cancel: harness.cancel,
    })
    harness.tick()
    expect(quit).not.toHaveBeenCalled()
  })

  it('does not quit after disposal or a probe exception', async () => {
    const watchdog = await loadWatchdog()
    const disposed = createTimerHarness()
    const failed = createTimerHarness()
    const quit = vi.fn()
    const dispose = watchdog.startDevelopmentParentWatchdog({
      packaged: false,
      parentPid: 42,
      quit,
      isParentAlive: () => false,
      schedule: disposed.schedule,
      cancel: disposed.cancel,
    })
    dispose()
    disposed.tick()
    watchdog.startDevelopmentParentWatchdog({
      packaged: false,
      parentPid: 42,
      quit,
      isParentAlive: () => { throw new Error('probe failed') },
      schedule: failed.schedule,
      cancel: failed.cancel,
    })
    failed.tick()
    expect(disposed.cancel).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
  })
})
