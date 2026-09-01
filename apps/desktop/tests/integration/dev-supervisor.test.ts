import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface SupervisorModule {
  buildWorkflowRunner(options: Record<string, unknown>): number
  resolveLocalDevelopmentConverterReleaseRoot(cwd: string): string
  resolvePinnedElectronViteCli(): string
  resolvePinnedTsupCli(): string
  runElectronViteDev(options: Record<string, unknown>): Promise<number>
}

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true)
}

async function loadSupervisor(): Promise<SupervisorModule> {
  return import('../../scripts/dev.mjs') as Promise<SupervisorModule>
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHarness(platform: NodeJS.Platform = 'darwin') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-dev-supervisor-')))
  roots.push(root)
  const cwd = join(root, 'desktop')
  const fingerprint = 'a'.repeat(64)
  const cacheRoot = join(cwd, 'node_modules', '.cache', 'autoforge-converter-packs')
  const releaseRoot = join(cacheRoot, 'releases', fingerprint)
  mkdirSync(releaseRoot, { recursive: true })
  writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${fingerprint}","schemaVersion":1}\n`)
  const child = new FakeChild()
  const signals = new EventEmitter()
  const buildWorkflowRunner = vi.fn(() => 0)
  const spawn = vi.fn(() => child)
  return {
    buildWorkflowRunner,
    cacheRoot,
    child,
    cwd,
    fingerprint,
    releaseRoot,
    signals,
    spawn,
    options: {
      cli: '/workspace/electron-vite.js',
      executable: '/runtime/node',
      cwd,
      environment: { EXISTING: 'preserved' },
      platform,
      buildWorkflowRunner,
      spawn,
      signals,
    },
  }
}

describe('development supervisor', () => {
  it('resolves the canonical active local converter release under the ignored dependency cache', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()

    expect(supervisor.resolveLocalDevelopmentConverterReleaseRoot(harness.cwd)).toBe(harness.releaseRoot)
  })

  it.each([
    ['missing marker', (harness: ReturnType<typeof createHarness>) => {
      rmSync(join(harness.cacheRoot, 'active-release.json'))
    }],
    ['malformed marker', (harness: ReturnType<typeof createHarness>) => {
      writeFileSync(join(harness.cacheRoot, 'active-release.json'), '{not json}\n')
    }],
    ['marker with unknown keys', (harness: ReturnType<typeof createHarness>) => {
      writeFileSync(join(harness.cacheRoot, 'active-release.json'), `{"fingerprint":"${harness.fingerprint}","schemaVersion":1,"extra":true}\n`)
    }],
    ['path escape marker', (harness: ReturnType<typeof createHarness>) => {
      writeFileSync(join(harness.cacheRoot, 'active-release.json'), '{"fingerprint":"../../escape","schemaVersion":1}\n')
    }],
    ['missing release', (harness: ReturnType<typeof createHarness>) => {
      rmSync(harness.releaseRoot, { recursive: true })
    }],
    ['symlinked release', (harness: ReturnType<typeof createHarness>) => {
      const external = join(harness.cwd, 'external-release')
      mkdirSync(external)
      rmSync(harness.releaseRoot, { recursive: true })
      symlinkSync(external, harness.releaseRoot)
    }],
    ['noncanonical release', (harness: ReturnType<typeof createHarness>) => {
      const releases = join(harness.cacheRoot, 'releases')
      const external = join(harness.cwd, 'external-releases')
      rmSync(releases, { recursive: true })
      mkdirSync(join(external, harness.fingerprint), { recursive: true })
      symlinkSync(external, releases)
    }],
  ])('fails closed for a %s', async (_name, mutate) => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()

    mutate(harness)

    expect(() => supervisor.resolveLocalDevelopmentConverterReleaseRoot(harness.cwd)).toThrow()
  })

  it('resolves the pinned electron-vite CLI', async () => {
    const supervisor = await loadSupervisor()
    expect(supervisor.resolvePinnedElectronViteCli()).toMatch(
      /electron-vite.+bin[/\\]electron-vite\.js$/,
    )
  })

  it('builds the workflow runner before launching electron-vite', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()
    const order: string[] = []
    harness.buildWorkflowRunner.mockImplementation(() => { order.push('build'); return 0 })
    harness.spawn.mockImplementation(() => { order.push('spawn'); return harness.child })

    const status = supervisor.runElectronViteDev(harness.options)
    harness.child.emit('close', 0, null)

    await expect(status).resolves.toBe(0)
    expect(order).toEqual(['build', 'spawn'])
  })

  it('does not launch electron-vite when the workflow runner build fails', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()
    harness.buildWorkflowRunner.mockReturnValue(9)

    const status = supervisor.runElectronViteDev(harness.options)
    harness.child.emit('close', 0, null)

    await expect(status).resolves.toBe(9)
    expect(harness.spawn).not.toHaveBeenCalled()
  })

  it('builds a runner that accepts the current workflow inspection protocol', async () => {
    const supervisor = await loadSupervisor()
    const desktopRoot = resolve(import.meta.dirname, '../..')
    const workflowEntry = join(desktopRoot, 'node_modules', '.cache', 'autoforge-dev-worker-protocol.mjs')
    await mkdir(join(desktopRoot, 'node_modules', '.cache'), { recursive: true })
    await writeFile(workflowEntry, 'export default { async run() { return null } }\n')

    try {
      expect(supervisor.buildWorkflowRunner({ cwd: desktopRoot })).toBe(0)
      const result = spawnSync(process.execPath, [
        '--experimental-vm-modules',
        join(desktopRoot, 'out', 'workers', 'workflow-runner.cjs'),
      ], {
        cwd: desktopRoot,
        encoding: 'utf8',
        env: { ...process.env, AUTOFORGE_EXECUTION_NONCE: 'dev-supervisor-protocol-test' },
        input: `${JSON.stringify({
          type: 'inspect_config',
          inspectionId: 'inspection_test',
          workflowId: 'workflow.test',
          workflowVersion: '1.0.0',
          entryPath: workflowEntry,
        })}\n`,
      })

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout.trim())).toEqual({
        type: 'workflow_config',
        inspectionId: 'inspection_test',
        implemented: false,
      })
    } finally {
      await rm(workflowEntry, { force: true })
    }
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

  it('forwards one termination signal and reports intentional shutdown as success', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()
    const status = supervisor.runElectronViteDev(harness.options)
    harness.signals.emit('SIGTERM')
    harness.signals.emit('SIGTERM')
    harness.child.emit('close', null, 'SIGTERM')
    await expect(status).resolves.toBe(0)
    expect(harness.child.kill).toHaveBeenCalledTimes(1)
    expect(harness.child.kill).toHaveBeenCalledWith('SIGTERM')
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
        cwd: harness.cwd,
        env: {
          AUTOFORGE_DEV_CONVERTER_RELEASE_ROOT: harness.releaseRoot,
          EXISTING: 'preserved',
        },
        stdio: 'inherit',
      },
    )
  })

  it('preserves a nonzero close after signal forwarding fails', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()
    harness.child.kill.mockReturnValue(false)
    const status = supervisor.runElectronViteDev(harness.options)
    harness.signals.emit('SIGINT')
    harness.signals.emit('SIGTERM')
    harness.signals.emit('SIGINT')
    harness.child.emit('close', 7, null)
    await expect(status).resolves.toBe(7)
    expect(harness.child.kill).toHaveBeenCalledTimes(1)
    expect(harness.child.kill).toHaveBeenCalledWith('SIGINT')
  })

  it('reports failure and removes listeners when signal forwarding throws', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()
    harness.child.kill.mockImplementation(() => { throw new Error('kill failed') })
    const status = supervisor.runElectronViteDev(harness.options)
    harness.signals.emit('SIGINT')
    await expect(status).resolves.toBe(1)
    expect(harness.signals.listenerCount('SIGINT')).toBe(0)
    expect(harness.signals.listenerCount('SIGTERM')).toBe(0)
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
