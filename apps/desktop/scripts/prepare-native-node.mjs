import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import process from 'node:process'
import { URL } from 'node:url'

const packageManager = process.env.npm_execpath
if (!packageManager) throw new Error('The package manager executable is unavailable')

const desktopRequire = createRequire(new URL('../package.json', import.meta.url))
const databasePackage = desktopRequire.resolve('better-sqlite3/package.json')
const result = spawnSync(process.execPath, [packageManager, 'run', 'install'], {
  cwd: dirname(databasePackage),
  env: process.env,
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
