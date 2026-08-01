import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error The Electron Vitest launcher is a plain Node ESM script.
import {
  resolvePinnedTestRuntime,
  runVitestInElectron,
} from '../../scripts/run-vitest-electron.mjs'

describe('run-vitest-electron', () => {
  it('resolves the workspace-pinned Electron executable and Vitest CLI', () => {
    const runtime = resolvePinnedTestRuntime()

    expect(runtime.electronExecutable).toContain('electron')
    expect(runtime.vitestCli).toBe(join(
      runtime.vitestPackageDirectory,
      'vitest.mjs',
    ))
  })

  it('forwards arguments, cwd, environment, and Electron Node mode', () => {
    const spawn = vi.fn(() => ({ status: 7 }))
    const status = runVitestInElectron(['run', 'tests/workspace.test.ts'], {
      runtime: {
        electronExecutable: '/runtime/Electron',
        vitestCli: '/workspace/vitest.mjs',
        vitestPackageDirectory: '/workspace',
      },
      cwd: '/workspace',
      environment: { EXISTING: 'preserved' },
      spawn,
    })

    expect(spawn).toHaveBeenCalledWith(
      '/runtime/Electron',
      ['/workspace/vitest.mjs', 'run', 'tests/workspace.test.ts'],
      {
        cwd: '/workspace',
        env: { EXISTING: 'preserved', ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'inherit',
      },
    )
    expect(status).toBe(7)
  })

  it('throws spawn failures', () => {
    const failure = new Error('spawn failed')

    expect(() => runVitestInElectron([], {
      runtime: {
        electronExecutable: 'Electron',
        vitestCli: 'vitest.mjs',
        vitestPackageDirectory: '.',
      },
      spawn: () => ({ error: failure, status: null }),
    })).toThrow(failure)
  })

  it('returns failure when a child exits without a status', () => {
    expect(runVitestInElectron([], {
      runtime: {
        electronExecutable: 'Electron',
        vitestCli: 'vitest.mjs',
        vitestPackageDirectory: '.',
      },
      spawn: () => ({ status: null }),
    })).toBe(1)
  })
})
