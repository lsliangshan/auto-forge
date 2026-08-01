import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { rebuild } from '@electron/rebuild'

const desktopDirectory = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const workspaceDirectory = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)))
const desktopRequire = createRequire(new URL('../package.json', import.meta.url))
const electronVersion = desktopRequire('electron/package.json').version
const electronExecutable = desktopRequire('electron')
const databasePackage = realpathSync(desktopRequire.resolve('better-sqlite3/package.json'))
const databaseDirectory = dirname(databasePackage)
const databaseRelativePath = relative(workspaceDirectory, databasePackage)

if (
  databaseRelativePath === '..'
  || databaseRelativePath.startsWith(`..${sep}`)
  || isAbsolute(databaseRelativePath)
) {
  throw new Error(`Refusing to rebuild better-sqlite3 outside this workspace: ${databasePackage}`)
}

export const nativeProbeSource = [
  'const Database = require(process.argv[1])',
  "const database = new Database(':memory:')",
  "const row = database.prepare('SELECT 1 AS value').get()",
  'database.close()',
  "if (row?.value !== 1) throw new Error('Unexpected SQLite probe result')",
].join(';')

export function runNativeProbe({
  electronExecutable: executable = electronExecutable,
  databaseDirectory: directory = databaseDirectory,
  environment = process.env,
  spawn = spawnSync,
} = {}) {
  return spawn(executable, ['-e', nativeProbeSource, directory], {
    encoding: 'utf8',
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
  })
}

function probeError(result) {
  if (result.error) return result.error
  const detail = result.stderr?.trim()
  return new Error(
    `Electron ${electronVersion} could not load better-sqlite3 after rebuilding${detail ? `: ${detail}` : ''}`,
  )
}

export async function prepareNativeElectron({
  probe = runNativeProbe,
  rebuildNative = rebuild,
  write = (message) => process.stdout.write(message),
} = {}) {
  const initial = probe()
  if (initial.error) throw initial.error
  if (initial.status === 0) {
    write(`better-sqlite3 is already compatible with Electron ${electronVersion}\n`)
    return { rebuilt: false }
  }

  write(`Rebuilding better-sqlite3 for Electron ${electronVersion} in ${workspaceDirectory}\n`)
  await rebuildNative({
    buildPath: desktopDirectory,
    projectRootPath: workspaceDirectory,
    electronVersion,
    arch: process.arch,
    platform: process.platform,
    onlyModules: ['better-sqlite3'],
    force: true,
    types: ['prod'],
  })

  const verified = probe()
  if (verified.error || verified.status !== 0) throw probeError(verified)
  write(`better-sqlite3 is compatible with Electron ${electronVersion}\n`)
  return { rebuilt: true }
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await prepareNativeElectron()
}
