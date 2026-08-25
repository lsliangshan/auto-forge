import { spawn } from 'node:child_process'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import process from 'node:process'

async function terminateTree(child, signal) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      killer.once('error', () => resolve())
      killer.once('exit', () => resolve())
    })
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

export async function runKnowledgeSmoke({
  executable,
  entry,
  timeoutMs = 60_000,
  killGraceMs = 2_000,
  environment = {},
  runAsNode = false,
  onWorkspaceCreated = () => undefined,
}) {
  const temporaryRoot = await realpath(tmpdir())
  const workspace = await realpath(await mkdtemp(join(temporaryRoot, 'autoforge-knowledge-ui-smoke-')))
  const workspaceRelative = relative(temporaryRoot, workspace)
  if (!workspaceRelative || workspaceRelative.startsWith('..') || isAbsolute(workspaceRelative)) {
    await rm(workspace, { recursive: true, force: true })
    throw new Error('Knowledge smoke workspace escaped the parent temporary root')
  }
  onWorkspaceCreated(workspace)
  const childEnvironment = {
    ...process.env,
    ...environment,
    AUTOFORGE_KNOWLEDGE_SMOKE_ROOT: workspace,
    TMPDIR: workspace,
    TMP: workspace,
    TEMP: workspace,
  }
  if (runAsNode) childEnvironment.ELECTRON_RUN_AS_NODE = '1'
  else delete childEnvironment.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [entry], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    env: childEnvironment,
    stdio: 'inherit',
  })

  return new Promise((resolve) => {
    let finished = false
    let timedOut = false
    let forceTimer
    const timeout = globalThis.setTimeout(() => {
      timedOut = true
      process.stderr.write(`knowledge-ui-smoke: timed out after ${timeoutMs} milliseconds\n`)
      void terminateTree(child, 'SIGTERM').finally(() => {
        forceTimer = globalThis.setTimeout(() => {
          void terminateTree(child, 'SIGKILL').finally(() => finish(1))
        }, killGraceMs)
      })
    }, timeoutMs)

    async function finish(code) {
      if (finished) return
      finished = true
      globalThis.clearTimeout(timeout)
      if (forceTimer !== undefined) globalThis.clearTimeout(forceTimer)
      if (code === 0) {
        try {
          await access(join(workspace, '.knowledge-smoke-complete'))
        } catch {
          process.stderr.write('knowledge-ui-smoke: child exited before completing assertions\n')
          code = 1
        }
      }
      try {
        await rm(workspace, { recursive: true, force: true })
      } catch (error) {
        process.stderr.write(`knowledge-ui-smoke: temporary workspace cleanup failed: ${error?.code ?? 'unknown'}\n`)
        code = 1
      }
      resolve(code)
    }

    child.once('error', (error) => {
      process.stderr.write(`${error.stack ?? String(error)}\n`)
      void finish(1)
    })
    child.once('exit', (code, signal) => {
      if (timedOut) return
      void finish(code ?? (signal ? 1 : 0))
    })
  })
}
