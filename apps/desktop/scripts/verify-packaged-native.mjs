import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'

const targets = new Map([
  ['darwin-arm64', { platform: 'darwin', arch: 'arm64', outputDirectory: 'mac-arm64', productDirectory: 'AutoForge.app' }],
  ['darwin-x64', { platform: 'darwin', arch: 'x64', outputDirectory: 'mac', productDirectory: 'AutoForge.app' }],
  ['win32-x64', { platform: 'win32', arch: 'x64', outputDirectory: 'win-unpacked', productDirectory: '' }],
])

function parseArguments(argv) {
  if (argv.length === 1 && !argv[0].startsWith('--')) return { packagedApp: argv[0], structuralOnly: false }
  const result = { structuralOnly: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--structural-only') {
      if (result.structuralOnly) throw new Error('Invalid command arguments')
      result.structuralOnly = true
      continue
    }
    if (!['--packaged-app', '--platform', '--arch'].includes(flag)) throw new Error('Invalid command arguments')
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error('Invalid command arguments')
    const key = flag === '--packaged-app' ? 'packagedApp' : flag.slice(2)
    if (result[key] !== undefined) throw new Error('Invalid command arguments')
    result[key] = value
    index += 1
  }
  return result
}

function sameHostPath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

const desktopDirectory = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const distDirectory = join(desktopDirectory, 'dist')
const arguments_ = parseArguments(process.argv.slice(2))
const platform = arguments_.platform ?? process.platform
const arch = arguments_.arch ?? process.arch
const target = targets.get(`${platform}-${arch}`)
if (!target) throw new Error(`Packaged native verification does not support ${platform}/${arch}`)

const expectedPackage = join(distDirectory, target.outputDirectory, target.productDirectory)
const requestedPackage = arguments_.packagedApp
  ? resolve(process.cwd(), arguments_.packagedApp)
  : expectedPackage
if (!sameHostPath(requestedPackage, expectedPackage)) {
  throw new Error(`Requested package does not match the supported packaged target: ${expectedPackage}`)
}
if (!existsSync(requestedPackage)) throw new Error(`Packaged app archive not found: ${requestedPackage}`)

const packageDirectory = realpathSync(requestedPackage)
const realDistDirectory = realpathSync(distDirectory)
const packageRelativePath = relative(realDistDirectory, packageDirectory)
if (
  packageRelativePath === '..'
  || packageRelativePath.startsWith(`..${sep}`)
  || isAbsolute(packageRelativePath)
) {
  throw new Error(`Packaged target resolves outside the desktop dist directory: ${packageDirectory}`)
}
if (!sameHostPath(packageDirectory, requestedPackage)) {
  throw new Error(`Packaged target must not resolve through a symbolic link: ${requestedPackage}`)
}

const resourcesDirectory = platform === 'darwin'
  ? join(packageDirectory, 'Contents', 'Resources')
  : join(packageDirectory, 'resources')
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

const workflowCompilerPackage = join(resourcesDirectory, 'app.asar.unpacked', 'node_modules', 'esbuild')
if (!existsSync(workflowCompilerPackage)) {
  throw new Error(`Packaged workflow compiler not found: ${workflowCompilerPackage}`)
}

const executable = platform === 'darwin'
  ? resolveDarwinExecutable(packageDirectory)
  : join(packageDirectory, 'AutoForge.exe')
if (!existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`)

if (arguments_.structuralOnly) {
  process.stdout.write(`${platform}-${arch} packaged native structure verified; runtime execution not performed\n`)
  process.exit(0)
}
if (platform !== process.platform || arch !== process.arch) {
  throw new Error(`Cross-platform package ${platform}/${arch} requires --structural-only; runtime execution was not performed`)
}

const databasePackage = join(appArchive, 'node_modules', 'better-sqlite3')
const httpsProxyAgentPackage = join(appArchive, 'node_modules', 'https-proxy-agent', 'dist', 'index.js')
const socksProxyAgentPackage = join(appArchive, 'node_modules', 'socks-proxy-agent', 'dist', 'index.js')
const probe = [
  'const Database = require(process.argv[1])',
  'const { HttpsProxyAgent } = require(process.argv[2])',
  'const { SocksProxyAgent } = require(process.argv[3])',
  'if (typeof HttpsProxyAgent !== "function") throw new Error("Packaged https-proxy-agent load failed")',
  'if (typeof SocksProxyAgent !== "function") throw new Error("Packaged socks-proxy-agent load failed")',
  'const database = new Database(":memory:")',
  'const result = database.prepare("select 1 as ok").get()',
  'database.close()',
  'if (result.ok !== 1) throw new Error("Packaged SQLite query failed")',
  'const { transformSync } = require(process.argv[4])',
  'const transformed = transformSync("const answer: number = 42", { loader: "ts" })',
  'if (!transformed.code.includes("42")) throw new Error("Packaged workflow compiler output was invalid")',
  'console.log(`Packaged proxy agents, better-sqlite3, and workflow compiler loaded under Electron ${process.versions.electron}`)',
].join(';')

const result = spawnSync(executable, [
  '-e',
  probe,
  databasePackage,
  httpsProxyAgentPackage,
  socksProxyAgentPackage,
  workflowCompilerPackage,
], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) {
  throw new Error(`Packaged runtime dependency probe failed with exit code ${result.status ?? 'unknown'}`)
}

function resolveDarwinExecutable(appDirectory) {
  const executableDirectory = join(appDirectory, 'Contents', 'MacOS')
  const executableName = readdirSync(executableDirectory).find((name) =>
    statSync(join(executableDirectory, name)).isFile(),
  )
  if (!executableName) throw new Error(`No packaged executable found in ${executableDirectory}`)
  return join(executableDirectory, executableName)
}
