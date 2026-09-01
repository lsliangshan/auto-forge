import { spawn as spawnChild, spawnSync as spawnChildSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
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

export function resolveLocalDevelopmentConverterReleaseRoot(cwd) {
  const cacheRoot = resolve(cwd, 'node_modules', '.cache', 'autoforge-converter-packs')
  const releasesRoot = join(cacheRoot, 'releases')
  const markerPath = join(cacheRoot, 'active-release.json')
  const markerDetails = lstatSync(markerPath)
  if (!markerDetails.isFile() || markerDetails.isSymbolicLink()) {
    throw new Error('Development release marker must be a regular file')
  }

  const markerBytes = readFileSync(markerPath, 'utf8')
  let marker
  try {
    marker = JSON.parse(markerBytes)
  } catch {
    throw new Error('Development release marker is invalid')
  }
  if (Object.getPrototypeOf(marker) !== Object.prototype || Object.keys(marker).length !== 2
    || marker.schemaVersion !== 1 || typeof marker.fingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(marker.fingerprint)
    || markerBytes !== `{"fingerprint":"${marker.fingerprint}","schemaVersion":1}\n`) {
    throw new Error('Development release marker schema is invalid')
  }

  const releaseRoot = join(releasesRoot, marker.fingerprint)
  if (relative(releasesRoot, releaseRoot) !== marker.fingerprint) {
    throw new Error('Development release is outside releases')
  }
  const releaseDetails = lstatSync(releaseRoot)
  if (!releaseDetails.isDirectory() || releaseDetails.isSymbolicLink()) {
    throw new Error('Development release must be a non-symbolic directory')
  }
  const canonicalRelease = realpathSync(releaseRoot)
  if (canonicalRelease !== releaseRoot || relative(releasesRoot, canonicalRelease) !== marker.fingerprint) {
    throw new Error('Development release must be canonical and remain inside releases')
  }
  return releaseRoot
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
  const developmentReleaseRoot = resolveLocalDevelopmentConverterReleaseRoot(cwd)
  const buildStatus = buildRunner({ cwd, environment })
  if (buildStatus !== 0) return Promise.resolve(buildStatus)
  return new Promise((resolveStatus, reject) => {
    const childEnvironment = {
      ...environment,
      AUTOFORGE_DEV_CONVERTER_RELEASE_ROOT: developmentReleaseRoot,
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
