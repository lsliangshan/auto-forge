import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error The native preparation entry point is a plain Node ESM script.
import {
  nativeProbeSource,
  prepareNativeElectron,
  runNativeProbe,
} from '../../scripts/prepare-native-electron.mjs'

describe('prepare-native-electron', () => {
  it('probes by opening and querying an in-memory database', () => {
    expect(nativeProbeSource).toContain("new Database(':memory:')")
    expect(nativeProbeSource).toContain('SELECT 1 AS value')
    expect(nativeProbeSource).toContain('database.close()')
  })

  it('runs the probe with Electron Node mode and the resolved database directory', () => {
    const spawn = vi.fn(() => ({ status: 0 }))

    runNativeProbe({
      electronExecutable: '/runtime/Electron',
      databaseDirectory: '/workspace/node_modules/better-sqlite3',
      environment: { EXISTING: 'preserved' },
      spawn,
    })

    expect(spawn).toHaveBeenCalledWith(
      '/runtime/Electron',
      ['-e', nativeProbeSource, '/workspace/node_modules/better-sqlite3'],
      expect.objectContaining({
        encoding: 'utf8',
        env: { EXISTING: 'preserved', ELECTRON_RUN_AS_NODE: '1' },
      }),
    )
  })

  it('skips rebuilding when the Electron probe succeeds', async () => {
    const probe = vi.fn(() => ({ status: 0 }))
    const rebuildNative = vi.fn()
    const write = vi.fn()

    await expect(prepareNativeElectron({ probe, rebuildNative, write }))
      .resolves.toEqual({ rebuilt: false })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(rebuildNative).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledWith(expect.stringContaining('already compatible'))
  })

  it('rebuilds once after a failed probe and verifies the result', async () => {
    const probe = vi.fn()
      .mockReturnValueOnce({ status: 1, stderr: 'ABI mismatch' })
      .mockReturnValueOnce({ status: 0 })
    const rebuildNative = vi.fn(async () => undefined)

    await expect(prepareNativeElectron({ probe, rebuildNative, write: vi.fn() }))
      .resolves.toEqual({ rebuilt: true })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(rebuildNative).toHaveBeenCalledTimes(1)
    expect(rebuildNative).toHaveBeenCalledWith(expect.objectContaining({
      onlyModules: ['better-sqlite3'],
      force: true,
      types: ['prod'],
    }))
  })

  it('propagates rebuild failures without running a second probe', async () => {
    const failure = new Error('rebuild failed')
    const probe = vi.fn(() => ({ status: 1 }))
    const rebuildNative = vi.fn(async () => { throw failure })

    await expect(prepareNativeElectron({ probe, rebuildNative, write: vi.fn() }))
      .rejects.toBe(failure)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('fails when the rebuilt artifact still cannot run under Electron', async () => {
    const probe = vi.fn()
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 1, stderr: 'still incompatible' })

    await expect(prepareNativeElectron({
      probe,
      rebuildNative: vi.fn(async () => undefined),
      write: vi.fn(),
    })).rejects.toThrow('still incompatible')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('does not rebuild when Electron itself cannot be spawned', async () => {
    const failure = new Error('spawn failed')
    const probe = vi.fn(() => ({ error: failure, status: null }))
    const rebuildNative = vi.fn()

    await expect(prepareNativeElectron({ probe, rebuildNative, write: vi.fn() }))
      .rejects.toBe(failure)
    expect(rebuildNative).not.toHaveBeenCalled()
  })
})
