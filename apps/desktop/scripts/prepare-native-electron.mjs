import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { rebuild } from '@electron/rebuild'

const desktopDirectory = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const workspaceDirectory = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)))
const desktopRequire = createRequire(new URL('../package.json', import.meta.url))
const electronVersion = desktopRequire('electron/package.json').version
const databasePackage = realpathSync(desktopRequire.resolve('better-sqlite3/package.json'))
const databaseRelativePath = relative(workspaceDirectory, databasePackage)

if (
  databaseRelativePath === '..'
  || databaseRelativePath.startsWith(`..${sep}`)
  || isAbsolute(databaseRelativePath)
) {
  throw new Error(`Refusing to rebuild better-sqlite3 outside this workspace: ${databasePackage}`)
}

process.stdout.write(`Rebuilding better-sqlite3 for Electron ${electronVersion} in ${workspaceDirectory}\n`)
await rebuild({
  buildPath: desktopDirectory,
  projectRootPath: workspaceDirectory,
  electronVersion,
  arch: process.arch,
  platform: process.platform,
  onlyModules: ['better-sqlite3'],
  force: true,
  types: ['prod'],
})
