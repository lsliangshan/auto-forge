import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const verifier = fileURLToPath(new URL('../../../scripts/verify-packaged-native.mjs', import.meta.url))

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-native-packaging-'))
  temporaryDirectories.push(directory)
  return directory
}

function runVerifier(path: string) {
  return spawnSync(process.execPath, [verifier, path], { encoding: 'utf8' })
}

function fakePackagedApp(options: { nativeModule?: boolean; executable?: string } = {}) {
  const app = join(temporaryDirectory(), 'AutoForge.app')
  const resources = join(app, 'Contents', 'Resources')
  const executableDirectory = join(app, 'Contents', 'MacOS')
  mkdirSync(resources, { recursive: true })
  mkdirSync(executableDirectory, { recursive: true })
  writeFileSync(join(resources, 'app.asar'), '')

  if (options.nativeModule) {
    const nativeDirectory = join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
    )
    mkdirSync(nativeDirectory, { recursive: true })
    writeFileSync(join(nativeDirectory, 'better_sqlite3.node'), '')
  }

  if (options.executable) {
    const executable = join(executableDirectory, 'AutoForge')
    writeFileSync(executable, options.executable)
    chmodSync(executable, 0o755)
  }

  return app
}

describe('verify-packaged-native', () => {
  it('reports a missing packaged app archive clearly', () => {
    const result = runVerifier(join(temporaryDirectory(), 'missing.app'))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Packaged app archive not found')
  })

  it('reports a missing packaged native module before launching Electron', () => {
    const result = runVerifier(fakePackagedApp({ executable: '#!/bin/sh\nexit 0\n' }))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Packaged better-sqlite3 native module not found')
  })

  it('reports a failed packaged require probe with its exit code', () => {
    const result = runVerifier(fakePackagedApp({
      nativeModule: true,
      executable: '#!/bin/sh\necho "simulated require failure" >&2\nexit 17\n',
    }))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('simulated require failure')
    expect(result.stderr).toContain('Packaged better-sqlite3 probe failed with exit code 17')
  })
})
