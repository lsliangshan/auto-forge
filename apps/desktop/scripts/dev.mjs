import { spawn as spawnChild } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'

const desktopRequire = createRequire(new URL('../package.json', import.meta.url))

export function resolvePinnedElectronViteCli() {
  const packageDirectory = dirname(desktopRequire.resolve('electron-vite/package.json'))
  return join(packageDirectory, 'bin', 'electron-vite.js')
}

export async function runElectronViteDev({
  cli = resolvePinnedElectronViteCli(),
  executable = process.execPath,
  cwd = process.cwd(),
  environment = process.env,
  platform = process.platform,
  spawn = spawnChild,
  signals = process,
} = {}) {
  return new Promise((resolveStatus, reject) => {
    const child = spawn(executable, [cli, 'dev'], {
      cwd,
      env: environment,
      stdio: 'inherit',
    })
    let interrupted = false
    let settled = false
    const cleanup = () => {
      signals.removeListener('SIGINT', onSigint)
      signals.removeListener('SIGTERM', onSigterm)
    }
    const interrupt = (signal) => {
      if (interrupted || settled) return
      interrupted = true
      child.kill(platform === 'win32' ? 'SIGTERM' : signal)
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
