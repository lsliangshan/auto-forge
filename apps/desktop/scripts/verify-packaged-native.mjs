import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'

const desktopDirectory = fileURLToPath(new URL('..', import.meta.url))
const packageDirectory = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : findPackagedResources(join(desktopDirectory, 'dist'))
if (!packageDirectory) throw new Error('Packaged app archive not found')

const resourcesDirectory = existsSync(join(packageDirectory, 'app.asar'))
  ? packageDirectory
  : join(packageDirectory, 'Contents', 'Resources')
const appArchive = join(resourcesDirectory, 'app.asar')
if (!existsSync(appArchive)) throw new Error(`Packaged app archive not found: ${appArchive}`)

const nativeModule = join(
  resourcesDirectory,
  'app.asar.unpacked',
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
)
if (!existsSync(nativeModule)) {
  throw new Error(`Packaged better-sqlite3 native module not found: ${nativeModule}`)
}

const executable = resolvePackagedExecutable(resourcesDirectory)
const databasePackage = join(appArchive, 'node_modules', 'better-sqlite3')

const probe = [
  'const Database = require(process.argv[1])',
  'const database = new Database(":memory:")',
  'const result = database.prepare("select 1 as ok").get()',
  'database.close()',
  'if (result.ok !== 1) throw new Error("Packaged SQLite query failed")',
  'console.log(`Packaged better-sqlite3 loaded under Electron ${process.versions.electron}`)',
].join(';')

const result = spawnSync(executable, ['-e', probe, databasePackage], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) {
  throw new Error(`Packaged better-sqlite3 probe failed with exit code ${result.status ?? 'unknown'}`)
}

function findPackagedResources(directory) {
  if (!existsSync(directory)) return undefined
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app')) return path
      const found = findPackagedResources(path)
      if (found) return found
    }
    if (entry.isFile() && entry.name === 'app.asar') return dirname(path)
  }
  return undefined
}

function resolvePackagedExecutable(resourcesPath) {
  if (basename(dirname(resourcesPath)) === 'Contents') {
    const executableDirectory = join(dirname(resourcesPath), 'MacOS')
    const executableName = readdirSync(executableDirectory).find((name) =>
      statSync(join(executableDirectory, name)).isFile(),
    )
    if (!executableName) throw new Error(`No packaged executable found in ${executableDirectory}`)
    return join(executableDirectory, executableName)
  }

  const executableDirectory = dirname(resourcesPath)
  const executableName = readdirSync(executableDirectory).find((name) => {
    const path = join(executableDirectory, name)
    if (!statSync(path).isFile()) return false
    return process.platform === 'win32'
      ? name.endsWith('.exe') && !name.toLowerCase().includes('uninstall')
      : (statSync(path).mode & 0o111) !== 0 && !name.startsWith('chrome_') && name !== 'chrome-sandbox'
  })
  if (!executableName) throw new Error(`No packaged executable found in ${executableDirectory}`)
  return join(executableDirectory, executableName)
}
