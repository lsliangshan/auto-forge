import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'

const supportedTarget = {
  platform: 'darwin',
  arch: 'arm64',
  outputDirectory: 'mac-arm64',
  productDirectory: 'AutoForge.app',
}

if (process.platform !== supportedTarget.platform || process.arch !== supportedTarget.arch) {
  throw new Error(
    `Packaged native verification supports darwin/arm64 only; received ${process.platform}/${process.arch}`,
  )
}

const desktopDirectory = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const distDirectory = join(desktopDirectory, 'dist')
const expectedPackage = join(
  distDirectory,
  supportedTarget.outputDirectory,
  supportedTarget.productDirectory,
)
const requestedPackage = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : expectedPackage
if (requestedPackage !== expectedPackage) {
  throw new Error(
    `Requested package does not match the supported packaged target: ${expectedPackage}`,
  )
}
if (!existsSync(requestedPackage)) {
  throw new Error(`Packaged app archive not found: ${requestedPackage}`)
}

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
if (packageDirectory !== requestedPackage) {
  throw new Error(`Packaged target must not resolve through a symbolic link: ${requestedPackage}`)
}

const resourcesDirectory = join(packageDirectory, 'Contents', 'Resources')
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

const encryptedNativeModule = join(
  resourcesDirectory,
  'app.asar.unpacked',
  'node_modules',
  'better-sqlite3-multiple-ciphers',
  'prebuilds',
  'darwin-arm64.node',
)
if (!existsSync(encryptedNativeModule)) {
  throw new Error(`Packaged encrypted SQLite native module not found: ${encryptedNativeModule}`)
}

const executable = resolvePackagedExecutable(packageDirectory)
const databasePackage = join(appArchive, 'node_modules', 'better-sqlite3')
const encryptedDatabasePackage = join(
  appArchive,
  'node_modules',
  'better-sqlite3-multiple-ciphers',
)
const httpsProxyAgentPackage = join(appArchive, 'node_modules', 'https-proxy-agent', 'dist', 'index.js')
const socksProxyAgentPackage = join(appArchive, 'node_modules', 'socks-proxy-agent', 'dist', 'index.js')
const workflowCompilerPackage = join(
  resourcesDirectory,
  'app.asar.unpacked',
  'node_modules',
  'esbuild',
)

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
  'const fs = require("node:fs")',
  'const os = require("node:os")',
  'const path = require("node:path")',
  'const encryptedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "autoforge-packaged-cipher-"))',
  'const encryptedKey = Buffer.alloc(32, 1)',
  'try {',
  '  const EncryptedDatabase = require(process.argv[5])',
  '  const encryptedPath = path.join(encryptedDirectory, "probe.sqlite")',
  '  let encrypted = new EncryptedDatabase(encryptedPath)',
  '  encrypted.rekey(encryptedKey)',
  '  encrypted.pragma("temp_store = MEMORY")',
  '  encrypted.exec("CREATE VIRTUAL TABLE probe USING fts5(body, tokenize=trigram)")',
  '  encrypted.prepare("INSERT INTO probe(body) VALUES (?)").run("packaged probe content")',
  '  encrypted.close()',
  '  encrypted = new EncryptedDatabase(encryptedPath)',
  '  encrypted.key(encryptedKey)',
  '  encrypted.pragma("temp_store = MEMORY")',
  '  const encryptedResult = encrypted.prepare("SELECT count(*) AS count FROM probe WHERE probe MATCH ?").get("packaged")',
  '  const tempStore = encrypted.pragma("temp_store", { simple: true })',
  '  encrypted.close()',
  '  if (encryptedResult.count !== 1 || tempStore !== 2) throw new Error("Packaged encrypted SQLite probe failed")',
  '} finally {',
  '  encryptedKey.fill(0)',
  '  fs.rmSync(encryptedDirectory, { recursive: true, force: true })',
  '}',
  'console.log(`Packaged proxy agents, SQLite drivers, and workflow compiler loaded under Electron ${process.versions.electron}`)',
].join(';')

const result = spawnSync(executable, [
  '-e',
  probe,
  databasePackage,
  httpsProxyAgentPackage,
  socksProxyAgentPackage,
  workflowCompilerPackage,
  encryptedDatabasePackage,
], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) {
  throw new Error(`Packaged runtime dependency probe failed with exit code ${result.status ?? 'unknown'}`)
}

function resolvePackagedExecutable(appDirectory) {
  const executableDirectory = join(appDirectory, 'Contents', 'MacOS')
  const executableName = readdirSync(executableDirectory).find((name) =>
    statSync(join(executableDirectory, name)).isFile(),
  )
  if (!executableName) throw new Error(`No packaged executable found in ${executableDirectory}`)
  return join(executableDirectory, executableName)
}
