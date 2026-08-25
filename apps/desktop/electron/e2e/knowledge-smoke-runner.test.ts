import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it('kills the timed-out smoke process tree and removes the parent-owned plaintext workspace', async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'autoforge-smoke-runner-test-'))
  directories.push(fixtureDirectory)
  const childEntry = join(fixtureDirectory, 'child.mjs')
  const grandchildEntry = join(fixtureDirectory, 'grandchild.mjs')
  await writeFile(grandchildEntry, `
    import { writeFileSync } from 'node:fs'
    const root = process.env.AUTOFORGE_KNOWLEDGE_SMOKE_ROOT
    process.on('SIGTERM', () => {})
    writeFileSync(root + '/descendant.pid', String(process.pid))
    setInterval(() => writeFileSync(root + '/descendant-artifact', 'plaintext'), 10)
  `)
  await writeFile(childEntry, `
    import { spawn } from 'node:child_process'
    import { writeFileSync } from 'node:fs'
    const root = process.env.AUTOFORGE_KNOWLEDGE_SMOKE_ROOT
    writeFileSync(root + '/source.txt', 'plaintext source')
    spawn(process.execPath, [${JSON.stringify(grandchildEntry)}], { stdio: 'ignore' })
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1000)
  `)
  const runnerUrl = pathToFileURL(join(process.cwd(), 'scripts', 'knowledge-smoke-runner.mjs')).href
  const runner = await import(runnerUrl) as {
    runKnowledgeSmoke(options: {
      executable: string
      entry: string
      timeoutMs: number
      killGraceMs: number
      runAsNode: boolean
      onWorkspaceCreated(path: string): void
    }): Promise<number>
  }
  let workspace = ''
  const running = runner.runKnowledgeSmoke({
    executable: process.execPath,
    entry: childEntry,
    timeoutMs: 500,
    killGraceMs: 100,
    runAsNode: true,
    onWorkspaceCreated: path => { workspace = path },
  })
  await expect.poll(async () => workspace && await readFile(join(workspace, 'descendant.pid'), 'utf8')).toMatch(/^\d+$/)
  const descendantPid = Number(await readFile(join(workspace, 'descendant.pid'), 'utf8'))

  await expect(running).resolves.toBe(1)
  await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect.poll(() => {
    try {
      process.kill(descendantPid, 0)
      return true
    } catch {
      return false
    }
  }, { timeout: 5_000 }).toBe(false)
})

it('rejects a clean child exit without the explicit completed-smoke marker', async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'autoforge-smoke-runner-exit-test-'))
  directories.push(fixtureDirectory)
  const childEntry = join(fixtureDirectory, 'early-exit.mjs')
  await writeFile(childEntry, 'process.exit(0)\n')
  const runnerUrl = pathToFileURL(join(process.cwd(), 'scripts', 'knowledge-smoke-runner.mjs')).href
  const runner = await import(runnerUrl) as {
    runKnowledgeSmoke(options: {
      executable: string
      entry: string
      timeoutMs: number
      runAsNode: boolean
      onWorkspaceCreated(path: string): void
    }): Promise<number>
  }
  let workspace = ''

  await expect(runner.runKnowledgeSmoke({
    executable: process.execPath,
    entry: childEntry,
    timeoutMs: 5_000,
    runAsNode: true,
    onWorkspaceCreated: path => { workspace = path },
  })).resolves.toBe(1)
  await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' })
})
