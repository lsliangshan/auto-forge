import { spawn as spawnChild, spawnSync as spawnChildSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'

const desktopRequire = createRequire(new URL('../package.json', import.meta.url))

export function resolvePinnedElectronViteCli() {
  const packageDirectory = dirname(desktopRequire.resolve('electron-vite/package.json'))
  return join(packageDirectory, 'bin', 'electron-vite.js')
}

export function resolvePinnedTsupCli() {
  const packageDirectory = dirname(desktopRequire.resolve('tsup/package.json'))
  return join(packageDirectory, 'dist', 'cli-default.js')
}

export function buildWorkflowRunner({
  cli = resolvePinnedTsupCli(),
  executable = process.execPath,
  cwd = process.cwd(),
  environment = process.env,
  spawnSync = spawnChildSync,
} = {}) {
  const result = spawnSync(executable, [
    cli,
    'electron/workers/workflow-runner.ts',
    '--format', 'cjs',
    '--platform', 'node',
    '--out-dir', 'out/workers',
    '--clean', 'false',
  ], {
    cwd,
    env: environment,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

export function localDevelopmentConverterReleaseRoot(cwd) {
  return resolve(cwd, 'node_modules', '.cache', 'autoforge-converter-packs', 'release')
}

export async function runElectronViteDev({
  cli = resolvePinnedElectronViteCli(),
  executable = process.execPath,
  cwd = process.cwd(),
  environment = process.env,
  platform = process.platform,
  buildWorkflowRunner: buildRunner = buildWorkflowRunner,
  spawn = spawnChild,
  signals = process,
} = {}) {
  const buildStatus = buildRunner({ cwd, environment })
  if (buildStatus !== 0) return Promise.resolve(buildStatus)
  return new Promise((resolveStatus, reject) => {
    const childEnvironment = {
      ...environment,
      AUTOFORGE_DEV_CONVERTER_RELEASE_ROOT: localDevelopmentConverterReleaseRoot(cwd),
    }
    const child = spawn(executable, [cli, 'dev'], {
      cwd,
      env: childEnvironment,
      stdio: 'inherit',
    })
    let interruptReceived = false
    let interrupted = false
    let settled = false
    const cleanup = () => {
      signals.removeListener('SIGINT', onSigint)
      signals.removeListener('SIGTERM', onSigterm)
    }
    const interrupt = (signal) => {
      if (interruptReceived || settled) return
      interruptReceived = true
      try {
        interrupted = child.kill(platform === 'win32' ? 'SIGTERM' : signal)
      } catch {
        settled = true
        cleanup()
        resolveStatus(1)
      }
    }
    const onSigint = () => { interrupt('SIGINT') }
    const onSigterm = () => { interrupt('SIGTERM') }
    signals.on('SIGINT', onSigint)
    signals.on('SIGTERM', onSigterm)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolveStatus(interrupted ? 0 : (code ?? 1))
    })
  })
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    process.exitCode = await runElectronViteDev()
  } catch (error) {
    process.stderr.write(`${error}\n`)
    process.exitCode = 1
  }
}
