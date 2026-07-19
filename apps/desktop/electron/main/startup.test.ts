import { describe, expect, it, vi } from 'vitest'
import { startDesktopApplication } from './startup.js'

describe('startDesktopApplication', () => {
  it('waits for readiness, migration, and recovery before creating a window', async () => {
    const order: string[] = []
    await startDesktopApplication({
      whenReady: async () => { order.push('ready') },
      initialize: async () => { order.push('migration'); return { recover: async () => { order.push('recovery') } } },
      createWindow: async () => { order.push('window') },
      showStartupError: vi.fn(),
      quit: vi.fn(),
    })
    expect(order).toEqual(['ready', 'migration', 'recovery', 'window'])
  })

  it('shows a safe failure and quits without creating a half-initialized window', async () => {
    const createWindow = vi.fn()
    const showStartupError = vi.fn()
    const quit = vi.fn()
    await startDesktopApplication({
      whenReady: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockRejectedValue(new Error('sqlite path /private/user secret')),
      createWindow,
      showStartupError,
      quit,
    })
    expect(createWindow).not.toHaveBeenCalled()
    expect(showStartupError).toHaveBeenCalledWith('AutoForge could not start safely.')
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('still quits when the native startup error dialog is unavailable', async () => {
    const quit = vi.fn()
    await startDesktopApplication({
      whenReady: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockRejectedValue(new Error('migration failed')),
      createWindow: vi.fn(),
      showStartupError: vi.fn().mockRejectedValue(new Error('dialog failed')),
      quit,
    })
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('closes initialized resources when window creation fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    await startDesktopApplication({
      whenReady: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockReturnValue({ recover: vi.fn(), close }),
      createWindow: vi.fn().mockRejectedValue(new Error('renderer failed')),
      showStartupError: vi.fn(),
      quit: vi.fn(),
    })
    expect(close).toHaveBeenCalledTimes(1)
  })
})
