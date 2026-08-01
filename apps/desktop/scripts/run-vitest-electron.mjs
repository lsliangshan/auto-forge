import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'

const desktopRequire = createRequire(new URL('../package.json', import.meta.url))

export function resolvePinnedTestRuntime() {
  const vitestPackageDirectory = dirname(desktopRequire.resolve('vitest/package.json'))
  return {
    electronExecutable: desktopRequire('electron'),
    vitestCli: join(vitestPackageDirectory, 'vitest.mjs'),
    vitestPackageDirectory,
  }
}

export function runVitestInElectron(args, {
  runtime = resolvePinnedTestRuntime(),
  cwd = process.cwd(),
  environment = process.env,
  spawn = spawnSync,
} = {}) {
  const result = spawn(
    runtime.electronExecutable,
    [runtime.vitestCli, ...args],
    {
      cwd,
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
    },
  )
  if (result.error) throw result.error
  return result.status ?? 1
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  process.exitCode = runVitestInElectron(process.argv.slice(2))
}
