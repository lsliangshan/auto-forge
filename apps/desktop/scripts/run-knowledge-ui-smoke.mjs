import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const executable = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
const entry = join(root, 'out', 'e2e', 'knowledge-ui-smoke-main.js')
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [entry], { cwd: root, env: environment, stdio: 'inherit' })
const timeout = globalThis.setTimeout(() => {
  process.stderr.write('knowledge-ui-smoke: timed out after 60 seconds\n')
  child.kill('SIGTERM')
  globalThis.setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
}, 60_000)

child.once('error', (error) => {
  globalThis.clearTimeout(timeout)
  process.stderr.write(`${error.stack ?? String(error)}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  globalThis.clearTimeout(timeout)
  process.exitCode = code ?? (signal ? 1 : 0)
})
