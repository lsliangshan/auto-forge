import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const verifierSource = fileURLToPath(new URL('../../../scripts/verify-packaged-native.mjs', import.meta.url))
const nativePathsSource = fileURLToPath(new URL('../../../scripts/native-package-paths.mjs', import.meta.url))
const builderConfig = fileURLToPath(new URL('../../../electron-builder.yml', import.meta.url))

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

function packagingFixture() {
  const desktop = temporaryDirectory()
  const scripts = join(desktop, 'scripts')
  mkdirSync(scripts)
  const verifier = join(scripts, 'verify-packaged-native.mjs')
  copyFileSync(verifierSource, verifier)
  copyFileSync(nativePathsSource, join(scripts, 'native-package-paths.mjs'))
  return { desktop, verifier }
}

function runVerifier(fixture: ReturnType<typeof packagingFixture>, pathOrArguments?: string | readonly string[]) {
  const arguments_ = typeof pathOrArguments === 'string'
    ? [pathOrArguments]
    : pathOrArguments ?? []
  return spawnSync(process.execPath, [fixture.verifier, ...arguments_], {
    encoding: 'utf8',
  })
}

function fakeWindowsPackagedApp(fixture: ReturnType<typeof packagingFixture>) {
  const app = join(fixture.desktop, 'dist', 'win-unpacked')
  const resources = join(app, 'resources')
  mkdirSync(resources, { recursive: true })
  writeFileSync(join(resources, 'app.asar'), 'structural ASAR fixture')
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
  mkdirSync(join(resources, 'app.asar.unpacked', 'node_modules', 'esbuild'), { recursive: true })
  writeFileSync(join(app, 'AutoForge.exe'), 'MZ structural fixture')
  return realpathSync(app)
}

function fakePackagedApp(
  fixture: ReturnType<typeof packagingFixture>,
  outputDirectory = 'mac-arm64',
  options: { nativeModule?: boolean; executable?: string } = {},
) {
  const app = join(fixture.desktop, 'dist', outputDirectory, 'AutoForge.app')
  const resources = join(app, 'Contents', 'Resources')
  const executableDirectory = join(app, 'Contents', 'MacOS')
  mkdirSync(resources, { recursive: true })
  mkdirSync(executableDirectory, { recursive: true })
  writeFileSync(join(resources, 'app.asar'), 'structural ASAR fixture')
  mkdirSync(join(resources, 'app.asar.unpacked', 'node_modules', 'esbuild'), { recursive: true })

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
    const result = runVerifier(packagingFixture())

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Packaged app archive not found')
  })

  it('reports a missing packaged native module before launching Electron', () => {
    const fixture = packagingFixture()
    fakePackagedApp(fixture, 'mac-arm64', { executable: '#!/bin/sh\nexit 0\n' })
    const result = runVerifier(fixture)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Packaged better-sqlite3 native module not found')
  })

  it('reports a failed packaged require probe with its exit code', () => {
    const fixture = packagingFixture()
    fakePackagedApp(fixture, 'mac-arm64', {
      nativeModule: true,
      executable: '#!/bin/sh\necho "simulated require failure" >&2\nexit 17\n',
    })
    const result = runVerifier(fixture)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('simulated require failure')
    expect(result.stderr).toContain('Packaged runtime dependency probe failed with exit code 17')
  })

  it('verifies the current mac-arm64 target instead of an older valid sibling', () => {
    const fixture = packagingFixture()
    fakePackagedApp(fixture, 'mac', {
      nativeModule: true,
      executable: '#!/bin/sh\nexit 0\n',
    })
    fakePackagedApp(fixture, 'mac-arm64', {
      nativeModule: true,
      executable: '#!/bin/sh\necho "current target failed" >&2\nexit 23\n',
    })

    const result = runVerifier(fixture)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('current target failed')
    expect(result.stderr).toContain('Packaged runtime dependency probe failed with exit code 23')
  })

  it('rejects an explicitly requested package for the wrong architecture', () => {
    const fixture = packagingFixture()
    const wrongArchitecture = fakePackagedApp(fixture, 'mac', {
      nativeModule: true,
      executable: '#!/bin/sh\nexit 0\n',
    })

    const result = runVerifier(fixture, wrongArchitecture)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not match the supported packaged target')
  })

  it('rejects a packaged target whose real path escapes the desktop dist directory', () => {
    const fixture = packagingFixture()
    const outside = fakePackagedApp(packagingFixture(), 'mac-arm64', {
      nativeModule: true,
      executable: '#!/bin/sh\nexit 0\n',
    })
    const target = join(realpathSync(fixture.desktop), 'dist', 'mac-arm64', 'AutoForge.app')
    mkdirSync(join(fixture.desktop, 'dist', 'mac-arm64'), { recursive: true })
    symlinkSync(outside, target)

    const result = runVerifier(fixture, target)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('resolves outside the desktop dist directory')
  })

  it('validates the native win32-x64 package structure without claiming platform execution', () => {
    const fixture = packagingFixture()
    const app = fakeWindowsPackagedApp(fixture)
    const result = runVerifier(fixture, [
      '--packaged-app', app,
      '--platform', 'win32',
      '--arch', 'x64',
      '--structural-only',
    ])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('win32-x64 packaged native structure verified')
    expect(result.stdout).toContain('runtime execution not performed')
  })

  it('requires the exact configured Darwin executable and ignores an executable decoy', () => {
    const fixture = packagingFixture()
    const app = fakePackagedApp(fixture, 'mac-arm64', { nativeModule: true })
    const executableDirectory = join(app, 'Contents', 'MacOS')
    mkdirSync(join(executableDirectory, 'AutoForge'))
    writeFileSync(join(executableDirectory, '00-decoy'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(executableDirectory, '00-decoy'), 0o755)

    const result = runVerifier(fixture, ['--structural-only'])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('AutoForge')
    expect(result.stderr.toLowerCase()).toContain('regular file')
  })

  it('accepts the exact configured Darwin executable only when it is executable', () => {
    const fixture = packagingFixture()
    fakePackagedApp(fixture, 'mac-arm64', {
      nativeModule: true,
      executable: '#!/bin/sh\nexit 0\n',
    })
    expect(runVerifier(fixture, ['--structural-only']).status).toBe(0)

    chmodSync(join(fixture.desktop, 'dist', 'mac-arm64', 'AutoForge.app', 'Contents', 'MacOS', 'AutoForge'), 0o644)
    const nonExecutable = runVerifier(fixture, ['--structural-only'])
    expect(nonExecutable.status).not.toBe(0)
    expect(nonExecutable.stderr.toLowerCase()).toContain('executable')
  })

  it.each([
    ['app.asar', (app: string) => join(app, 'resources', 'app.asar')],
    ['native module', (app: string) => join(app, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')],
    ['app executable', (app: string) => join(app, 'AutoForge.exe')],
  ])('rejects a directory in place of the required %s regular file', (_label, target) => {
    const fixture = packagingFixture()
    const app = fakeWindowsPackagedApp(fixture)
    const path = target(app)
    if (path.endsWith('.asar')) renameSync(path, `${path}.regular-file`)
    else rmSync(path)
    mkdirSync(path)
    const result = runVerifier(fixture, [
      '--packaged-app', app, '--platform', 'win32', '--arch', 'x64', '--structural-only',
    ])
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('regular file')
  })

  it.skipIf(process.platform === 'win32')('rejects a special node in place of a required native file', () => {
    const fixture = packagingFixture()
    const app = fakeWindowsPackagedApp(fixture)
    const native = join(app, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
    rmSync(native)
    expect(spawnSync('mkfifo', [native]).status).toBe(0)
    const result = runVerifier(fixture, [
      '--packaged-app', app, '--platform', 'win32', '--arch', 'x64', '--structural-only',
    ])
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('regular file')
  })

})

describe('desktop package branding', () => {
  it('uses the approved logo for macOS and Windows packages', () => {
    const config = readFileSync(builderConfig, 'utf8')
    const verifier = readFileSync(verifierSource, 'utf8')

    expect(config).toContain('productName: AutoForge')
    expect(verifier).toContain("executableName: 'AutoForge'")
    expect(config).toContain('mac:\n  icon: resources/branding/autoforge-logo.icns')
    expect(config).toContain('win:\n  icon: resources/branding/autoforge-logo.ico')
  })
})
