import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

interface SupervisorModule {
  resolvePinnedElectronViteCli(): string
  runElectronViteDev(options: Record<string, unknown>): Promise<number>
}

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true)
}

async function loadSupervisor(): Promise<SupervisorModule> {
  return import('../../scripts/dev.mjs') as Promise<SupervisorModule>
}

function createHarness(platform: NodeJS.Platform = 'darwin') {
  const child = new FakeChild()
  const signals = new EventEmitter()
  const spawn = vi.fn(() => child)
  return {
    child,
    signals,
    spawn,
    options: {
      cli: '/workspace/electron-vite.js',
      executable: '/runtime/node',
      cwd: '/workspace/apps/desktop',
      environment: { EXISTING: 'preserved' },
      platform,
      spawn,
      signals,
    },
  }
}

describe('development supervisor', () => {
  it('resolves the pinned electron-vite CLI', async () => {
    const supervisor = await loadSupervisor()
    expect(supervisor.resolvePinnedElectronViteCli()).toMatch(
      /electron-vite.+bin[/\\]electron-vite\.js$/,
    )
  })

  it('forwards one interrupt and reports intentional shutdown as success', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()
    const status = supervisor.runElectronViteDev(harness.options)
    harness.signals.emit('SIGINT')
    harness.signals.emit('SIGINT')
    harness.child.emit('close', null, 'SIGINT')
    await expect(status).resolves.toBe(0)
    expect(harness.child.kill).toHaveBeenCalledTimes(1)
    expect(harness.child.kill).toHaveBeenCalledWith('SIGINT')
    expect(harness.signals.listenerCount('SIGINT')).toBe(0)
    expect(harness.signals.listenerCount('SIGTERM')).toBe(0)
  })

  it('uses supported termination semantics on Windows', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness('win32')
    const status = supervisor.runElectronViteDev(harness.options)
    harness.signals.emit('SIGINT')
    harness.child.emit('close', 0, null)
    await expect(status).resolves.toBe(0)
    expect(harness.child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('preserves spawn boundaries and a real nonzero exit', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()
    const status = supervisor.runElectronViteDev(harness.options)
    harness.child.emit('close', 7, null)
    await expect(status).resolves.toBe(7)
    expect(harness.spawn).toHaveBeenCalledWith(
      '/runtime/node',
      ['/workspace/electron-vite.js', 'dev'],
      {
        cwd: '/workspace/apps/desktop',
        env: { EXISTING: 'preserved' },
        stdio: 'inherit',
      },
    )
  })

  it('maps an unexpected signal to failure', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()
    const status = supervisor.runElectronViteDev(harness.options)
    harness.child.emit('close', null, 'SIGKILL')
    await expect(status).resolves.toBe(1)
  })

  it('rejects spawn failures', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()
    const failure = new Error('spawn failed')
    const status = supervisor.runElectronViteDev(harness.options)
    harness.child.emit('error', failure)
    await expect(status).rejects.toBe(failure)
  })
})
