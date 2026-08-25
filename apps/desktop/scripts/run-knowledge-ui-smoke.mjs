import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runKnowledgeSmoke } from './knowledge-smoke-runner.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const executable = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
const entry = join(root, 'out', 'e2e', 'knowledge-ui-smoke-main.js')
process.exitCode = await runKnowledgeSmoke({ executable, entry })
