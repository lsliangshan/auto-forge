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
const cipherDatabasePackage = realpathSync(
  desktopRequire.resolve('better-sqlite3-multiple-ciphers/package.json'),
)
const cipherDatabaseDirectory = dirname(cipherDatabasePackage)
const cipherDatabaseRelativePath = relative(workspaceDirectory, cipherDatabasePackage)

if (
  databaseRelativePath === '..'
  || databaseRelativePath.startsWith(`..${sep}`)
  || isAbsolute(databaseRelativePath)
) {
  throw new Error(`Refusing to rebuild better-sqlite3 outside this workspace: ${databasePackage}`)
}
if (
  cipherDatabaseRelativePath === '..'
  || cipherDatabaseRelativePath.startsWith(`..${sep}`)
  || isAbsolute(cipherDatabaseRelativePath)
) {
  throw new Error('Refusing to rebuild the knowledge database module outside this workspace')
}

export const nativeProbeSource = [
  'const Database = require(process.argv[1])',
  'const CipherDatabase = require(process.argv[2])',
  "const { randomBytes } = require('node:crypto')",
  "const { mkdtempSync, rmSync } = require('node:fs')",
  "const { tmpdir } = require('node:os')",
  "const { join } = require('node:path')",
  "const database = new Database(':memory:')",
  "const row = database.prepare('SELECT 1 AS value').get()",
  'database.close()',
  "if (row?.value !== 1) throw new Error('Unexpected SQLite probe result')",
  "const probeRoot = mkdtempSync(join(tmpdir(), 'autoforge-native-cipher-'))",
  "const cipherDatabase = new CipherDatabase(join(probeRoot, 'probe.sqlite'))",
  'const key = randomBytes(32)',
  'try {',
  'cipherDatabase.key(key)',
  "cipherDatabase.exec(\"CREATE VIRTUAL TABLE temp.__probe USING fts5(body, tokenize='trigram'); DROP TABLE temp.__probe;\")",
  "const cipherRow = cipherDatabase.prepare('SELECT 1 AS value').get()",
  "if (cipherRow?.value !== 1) throw new Error('Unexpected cipher SQLite probe result')",
  '} finally {',
  'key.fill(0)',
  'cipherDatabase.close()',
  'rmSync(probeRoot, { recursive: true, force: true })',
  '}',
].join(';')

export function runNativeProbe({
  electronExecutable: executable = electronExecutable,
  databaseDirectory: directory = databaseDirectory,
  cipherDatabaseDirectory: cipherDirectory = cipherDatabaseDirectory,
  environment = process.env,
  spawn = spawnSync,
} = {}) {
  return spawn(executable, ['-e', nativeProbeSource, directory, cipherDirectory], {
    encoding: 'utf8',
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
  })
}

function probeError(result) {
  if (result.error) return result.error
  const detail = result.stderr?.trim()
  return new Error(
    `Electron ${electronVersion} could not load required database modules after rebuilding${detail ? `: ${detail}` : ''}`,
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
    write(`Database native modules are already compatible with Electron ${electronVersion}\n`)
    return { rebuilt: false }
  }

  write(`Rebuilding database native modules for Electron ${electronVersion} in ${workspaceDirectory}\n`)
  await rebuildNative({
    buildPath: desktopDirectory,
    projectRootPath: workspaceDirectory,
    electronVersion,
    arch: process.arch,
    platform: process.platform,
    onlyModules: ['better-sqlite3', 'better-sqlite3-multiple-ciphers'],
    force: true,
    types: ['prod'],
  })

  const verified = probe()
  if (verified.error || verified.status !== 0) throw probeError(verified)
  write(`Database native modules are compatible with Electron ${electronVersion}\n`)
  return { rebuilt: true }
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await prepareNativeElectron()
}
