import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
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

it('contains a real KnowledgeService parser probe and its descendants in the parent-owned timeout root', async () => {
  const fixtureDirectory = await mkdtemp(join(process.cwd(), '.autoforge-smoke-real-probe-'))
  directories.push(fixtureDirectory)
  const childSource = join(fixtureDirectory, 'real-probe-child.ts')
  const childEntry = join(fixtureDirectory, 'real-probe-child.mjs')
  const observationPath = join(fixtureDirectory, 'probe-observation.json')
  const knowledgeServicePath = join(process.cwd(), 'electron', 'main', 'knowledge', 'knowledge-service.ts')
  const descendantSource = `
    import { writeFileSync } from 'node:fs'
    const probeDirectory = process.argv[2]
    process.on('SIGTERM', () => {})
    writeFileSync(probeDirectory + '/descendant.pid', String(process.pid))
    setInterval(() => writeFileSync(probeDirectory + '/descendant-artifact', 'plaintext'), 10)
  `
  await writeFile(childSource, `
    import { spawn } from 'node:child_process'
    import { readFile, readdir, writeFile } from 'node:fs/promises'
    import { dirname, join } from 'node:path'
    import { KnowledgeService } from ${JSON.stringify(knowledgeServicePath)}

    process.on('SIGTERM', () => {})
    const smokeRoot = process.env.AUTOFORGE_KNOWLEDGE_SMOKE_ROOT
    const observationPath = process.env.AUTOFORGE_SMOKE_TEST_OBSERVATION_PATH
    if (!smokeRoot || !observationPath) throw new Error('missing smoke test environment')
    const service = new KnowledgeService({
      rootDirectory: join(smokeRoot, 'knowledge'),
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async value => Buffer.from(value),
        decrypt: async value => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      createParser: async () => ({
        parse: async input => {
          const probeDirectory = dirname(input.objectPath)
          const descendantEntry = join(smokeRoot, 'probe-descendant.mjs')
          await writeFile(descendantEntry, ${JSON.stringify(descendantSource)})
          const descendant = spawn(process.execPath, [descendantEntry, probeDirectory], { stdio: 'ignore' })
          let descendantArtifactSize = 0
          for (let attempt = 0; attempt < 100 && descendantArtifactSize === 0; attempt += 1) {
            try {
              descendantArtifactSize = (await readFile(join(probeDirectory, 'descendant-artifact'))).byteLength
            } catch {
              await new Promise(resolve => setTimeout(resolve, 10))
            }
          }
          if (descendantArtifactSize === 0) throw new Error('descendant artifact was not created')
          await writeFile(observationPath, JSON.stringify({
            smokeRoot,
            tempEnvironment: {
              TMPDIR: process.env.TMPDIR,
              TMP: process.env.TMP,
              TEMP: process.env.TEMP,
            },
            probeDirectory,
            probeFiles: await readdir(probeDirectory),
            sourceSize: (await readFile(join(probeDirectory, 'probe.txt'))).byteLength,
            encryptedSize: (await readFile(input.objectPath)).byteLength,
            descendantArtifactSize,
            childPid: process.pid,
            descendantPid: descendant.pid,
          }))
          await new Promise(() => {})
        },
        terminateAll: async () => undefined,
      }),
      chooseImportFile: async () => undefined,
      chooseExportPath: async () => undefined,
      ownsConversation: async () => true,
      platform: process.platform,
      arch: process.arch,
      runtimeAvailable: true,
    })
    await service.getFeatureAvailability({ userId: 'smoke_probe_user' })
  `)
  await build({
    entryPoints: [childSource], outfile: childEntry, bundle: true,
    platform: 'node', format: 'esm', packages: 'external',
  })
  const runnerUrl = pathToFileURL(join(process.cwd(), 'scripts', 'knowledge-smoke-runner.mjs')).href
  const runner = await import(runnerUrl) as {
    runKnowledgeSmoke(options: {
      executable: string
      entry: string
      timeoutMs: number
      killGraceMs: number
      environment: Record<string, string>
      runAsNode: boolean
      onWorkspaceCreated(path: string): void
    }): Promise<number>
  }
  let workspace = ''
  const running = runner.runKnowledgeSmoke({
    executable: process.execPath,
    entry: childEntry,
    timeoutMs: 1_000,
    killGraceMs: 100,
    runAsNode: true,
    environment: {
      AUTOFORGE_KNOWLEDGE_SMOKE_ROOT: fixtureDirectory,
      AUTOFORGE_SMOKE_TEST_OBSERVATION_PATH: observationPath,
      TMPDIR: fixtureDirectory,
      TMP: fixtureDirectory,
      TEMP: fixtureDirectory,
    },
    onWorkspaceCreated: path => { workspace = path },
  })
  await expect.poll(() => readFile(observationPath, 'utf8')).toMatch(/probeDirectory/)
  const observation = JSON.parse(await readFile(observationPath, 'utf8')) as {
    smokeRoot: string
    tempEnvironment: Record<'TMPDIR' | 'TMP' | 'TEMP', string>
    probeDirectory: string
    probeFiles: string[]
    sourceSize: number
    encryptedSize: number
    descendantArtifactSize: number
    childPid: number
    descendantPid: number
  }
  directories.push(observation.probeDirectory)

  await expect(running).resolves.toBe(1)
  const probeRelative = relative(workspace, observation.probeDirectory)
  expect(probeRelative).not.toBe('')
  expect(probeRelative.startsWith('..') || isAbsolute(probeRelative)).toBe(false)
  expect(observation.smokeRoot).toBe(workspace)
  expect(observation.tempEnvironment).toEqual({ TMPDIR: workspace, TMP: workspace, TEMP: workspace })
  expect(observation.probeFiles).toEqual(expect.arrayContaining([
    'probe.txt', 'probe.afobj', 'descendant.pid', 'descendant-artifact',
  ]))
  expect(observation.sourceSize).toBeGreaterThan(0)
  expect(observation.encryptedSize).toBeGreaterThan(0)
  expect(observation.descendantArtifactSize).toBeGreaterThan(0)
  await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' })
  for (const pid of [observation.childPid, observation.descendantPid]) {
    await expect.poll(() => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }, { timeout: 5_000 }).toBe(false)
  }
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
