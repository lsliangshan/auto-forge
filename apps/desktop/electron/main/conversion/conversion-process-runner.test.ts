import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConverterPackLease } from './converter-pack-types.js'
import {
  CONVERSION_OUTPUT_CAPTURE_BYTES,
  CONVERSION_TIMEOUTS,
  ConversionProcessError,
  createConversionEnvironment,
  createNodeConversionProcessTreePort,
  createConversionProcessRunner,
  type ConversionProcessExit,
  type ConversionProcessHandle,
  type ConversionProcessPlan,
  type ConversionProcessSpawnOptions,
  type ConversionProcessTreePort,
  type WindowsJobObjectProcessTreePort,
} from './conversion-process-runner.js'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

async function observedWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<
  | { readonly settled: true; readonly value: T }
  | { readonly settled: false }
> {
  return new Promise((resolve) => {
    let finished = false
    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      resolve({ settled: false })
    }, timeoutMs)
    void promise.then((value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ settled: true, value })
    })
  })
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function resolveTestNodeExecutable(): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    try {
      const candidate = await realpath(join(directory, 'node'))
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  throw new Error('A real Node executable is required for the process-tree regression test.')
}

class FakeProcess implements ConversionProcessHandle {
  readonly pid = 4321
  readonly processGroupId = 4321
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private readonly exit = deferred<ConversionProcessExit>()

  waitForExit(): Promise<ConversionProcessExit> {
    return this.exit.promise
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitOnly(code, signal)
    this.closeOutput()
  }

  exitOnly(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exit.resolve({ code, signal })
  }

  closeOutput(): void {
    this.stdout.end()
    this.stderr.end()
  }
}

class FakeProcessTree implements ConversionProcessTreePort {
  readonly child = new FakeProcess()
  readonly spawns: Array<{ executable: string; args: readonly string[]; options: ConversionProcessSpawnOptions }> = []
  readonly terminations: ConversionProcessHandle[] = []
  terminate = async () => {}

  spawn(executable: string, args: readonly string[], options: ConversionProcessSpawnOptions): ConversionProcessHandle {
    this.spawns.push({ executable, args, options })
    return this.child
  }

  async terminateTree(process: ConversionProcessHandle): Promise<void> {
    this.terminations.push(process)
    await this.terminate()
  }
}

const temporaryRoots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  work: string
  executable: string
  lease: ConverterPackLease
  plan: ConversionProcessPlan
}> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'autoforge-process-runner-')))
  temporaryRoots.push(parent)
  const root = join(parent, 'signed pack')
  const executable = join(root, 'bin', 'fake-converter')
  const work = join(parent, 'private work')
  await mkdir(dirname(executable), { recursive: true })
  await mkdir(work)
  await writeFile(executable, 'fixture executable')
  await chmod(executable, 0o755)
  const lease: ConverterPackLease = Object.freeze({
    name: 'image-icon', version: '1.0.0', platform: 'darwin', arch: 'arm64', root,
    executables: Object.freeze({ 'bin/fake-converter': executable }),
    release() {},
  })
  return {
    root,
    work,
    executable,
    lease,
    plan: {
      executable,
      args: Object.freeze(['convert', '--output', join(work, 'result.png'), '--', join(work, '- input "quoted"\nname.png')]),
      cwd: work,
      env: createConversionEnvironment(executable, work),
      timeoutMs: CONVERSION_TIMEOUTS.image,
      outputContract: Object.freeze({ kind: 'single' }),
      outputPaths: Object.freeze([join(work, 'result.png')]),
      outputs: Object.freeze([{ path: join(work, 'result.png'), format: 'png' }]),
    },
  }
}

describe('conversion process runner', () => {
  it('passes hostile-looking names only as argv with a closed environment and no shell', async () => {
    const { executable, lease, plan, work } = await fixture()
    const tree = new FakeProcessTree()
    const previousProxy = process.env.HTTP_PROXY
    const previousToken = process.env.AUTOFORGE_TEST_TOKEN
    process.env.HTTP_PROXY = 'http://proxy.invalid'
    process.env.AUTOFORGE_TEST_TOKEN = 'must-not-leak'
    try {
      const running = createConversionProcessRunner({ processTree: tree }).run(plan, lease)
      tree.child.finish(0)

      await expect(running).resolves.toMatchObject({ exitCode: 0 })
      expect(tree.spawns).toEqual([{
        executable,
        args: plan.args,
        options: {
          shell: false,
          windowsHide: true,
          cwd: work,
          env: {
            LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: dirname(executable),
            TEMP: work, TMP: work, TMPDIR: work,
          },
        },
      }])
      expect(tree.spawns[0]!.options.env).not.toHaveProperty('HTTP_PROXY')
      expect(tree.spawns[0]!.options.env).not.toHaveProperty('AUTOFORGE_TEST_TOKEN')
    } finally {
      if (previousProxy === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = previousProxy
      if (previousToken === undefined) delete process.env.AUTOFORGE_TEST_TOKEN
      else process.env.AUTOFORGE_TEST_TOKEN = previousToken
    }
  })

  it.each(['outside', 'unsigned'] as const)('rejects a %s executable before spawning', async (kind) => {
    const { lease, plan, work } = await fixture()
    const tree = new FakeProcessTree()
    const executable = kind === 'outside' ? join(dirname(lease.root), 'outside') : join(lease.root, 'bin', 'unsigned')
    await writeFile(executable, 'not signed', { mode: 0o755 })
    const unsafeLease = kind === 'outside'
      ? { ...lease, executables: Object.freeze({ 'bin/fake-converter': executable }) }
      : lease

    await expect(createConversionProcessRunner({ processTree: tree }).run({
      ...plan,
      executable,
      env: createConversionEnvironment(executable, work),
    }, unsafeLease)).rejects.toMatchObject({ code: 'CONVERSION_COMPONENT_UNAVAILABLE' })
    expect(tree.spawns).toHaveLength(0)
  })

  it.each([
    ['inherited proxy', { HTTP_PROXY: 'http://proxy.invalid' }],
    ['credential', { OPENAI_API_KEY: 'secret' }],
    ['system path', { PATH: '/usr/bin:/bin' }],
    ['home', { HOME: '/Users/example' }],
  ] as const)('rejects %s environment data before spawning', async (_name, injected) => {
    const { lease, plan } = await fixture()
    const tree = new FakeProcessTree()
    await expect(createConversionProcessRunner({ processTree: tree }).run({
      ...plan,
      env: Object.freeze({ ...plan.env, ...injected }),
    }, lease)).rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    expect(tree.spawns).toHaveLength(0)
  })

  it('rejects output paths outside the private working directory', async () => {
    const { lease, plan } = await fixture()
    const tree = new FakeProcessTree()
    await expect(createConversionProcessRunner({ processTree: tree }).run({
      ...plan,
      outputPaths: ['/tmp/escaped.png'],
      outputs: [{ path: '/tmp/escaped.png', format: 'png' }],
    }, lease)).rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    expect(tree.spawns).toHaveLength(0)
  })

  it('allows 256 outputs only for a trusted icon-representation contract', async () => {
    const { lease, plan, work } = await fixture()
    const tree = new FakeProcessTree()
    const outputs = Array.from({ length: 256 }, (_, index) => ({
      path: join(work, `representation-${String(index + 1).padStart(3, '0')}.png`),
      format: 'png' as const,
    }))
    const running = createConversionProcessRunner({ processTree: tree }).run({
      ...plan,
      outputContract: { kind: 'icon-representations', count: 256 },
      outputPaths: outputs.map((output) => output.path),
      outputs,
    }, lease)
    await vi.waitFor(() => expect(tree.spawns).toHaveLength(1))
    tree.child.finish(0)

    await expect(running).resolves.toMatchObject({ exitCode: 0 })
  })

  it('keeps the typed PDF page contract capped at 100 outputs', async () => {
    const { lease, plan, work } = await fixture()
    const tree = new FakeProcessTree()
    const outputs = Array.from({ length: 101 }, (_, index) => ({
      path: join(work, `page-${String(index + 1).padStart(3, '0')}.png`),
      format: 'png' as const,
      metadata: { pdfPage: index + 1 },
    }))

    await expect(createConversionProcessRunner({ processTree: tree }).run({
      ...plan,
      outputContract: { kind: 'pdf-pages', count: 101 },
      outputPaths: outputs.map((output) => output.path),
      outputs,
    }, lease)).rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    expect(tree.spawns).toHaveLength(0)
  })

  it('rejects output counts that do not match the typed trusted operation', async () => {
    const { lease, plan, work } = await fixture()
    const tree = new FakeProcessTree()
    const second = { path: join(work, 'second.png'), format: 'png' as const }

    await expect(createConversionProcessRunner({ processTree: tree }).run({
      ...plan,
      outputPaths: [...plan.outputPaths, second.path],
      outputs: [...plan.outputs, second],
    }, lease)).rejects.toMatchObject({ code: 'CONVERSION_INPUT_INVALID' })
    expect(tree.spawns).toHaveLength(0)
  })

  it('bounds stdout and stderr retained in memory', async () => {
    const { lease, plan } = await fixture()
    const tree = new FakeProcessTree()
    const running = createConversionProcessRunner({ processTree: tree }).run(plan, lease)
    tree.child.stdout.end(Buffer.alloc(CONVERSION_OUTPUT_CAPTURE_BYTES * 3, 0x61))
    tree.child.stderr.end(Buffer.alloc(CONVERSION_OUTPUT_CAPTURE_BYTES * 3, 0x62))
    tree.child.finish(0)

    const result = await running
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(CONVERSION_OUTPUT_CAPTURE_BYTES)
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(CONVERSION_OUTPUT_CAPTURE_BYTES)
    expect(result.stdout).toContain('[truncated]')
    expect(result.stderr).toContain('[truncated]')
  })

  it('returns only a stable code, exit code, and bounded sanitized stderr on engine failure', async () => {
    const { executable, lease, plan, root, work } = await fixture()
    const tree = new FakeProcessTree()
    const running = createConversionProcessRunner({ processTree: tree }).run(plan, lease)
      .catch((error: unknown) => error)
    tree.child.stderr.write(`${root}/private ${work}/source api_key=super-secret Bearer credential ${executable}`)
    tree.child.finish(7)

    const error = await running
    expect(error).toBeInstanceOf(ConversionProcessError)
    expect(Object.keys(error as object).sort()).toEqual(['code', 'exitCode', 'stderrSummary'])
    expect(error).toMatchObject({ code: 'CONVERSION_INPUT_INVALID', exitCode: 7 })
    expect((error as ConversionProcessError).stderrSummary).not.toContain(root)
    expect((error as ConversionProcessError).stderrSummary).not.toContain(work)
    expect((error as ConversionProcessError).stderrSummary).not.toContain('super-secret')
    expect((error as ConversionProcessError).stderrSummary).not.toContain('credential')
    expect(Buffer.byteLength((error as ConversionProcessError).stderrSummary)).toBeLessThanOrEqual(CONVERSION_OUTPUT_CAPTURE_BYTES)
  })

  it('redacts authorization schemes and credential-shaped prefixed names from engine errors', async () => {
    const { lease, plan } = await fixture()
    const tree = new FakeProcessTree()
    const rawValues = [
      'basic-value-123',
      'bearer-value-456',
      'openai-value-789',
      'service-token-abc',
      'build-secret-def',
      'database-password-ghi',
      'client-credential-jkl',
      'header-api-key-mno',
    ]
    const running = createConversionProcessRunner({ processTree: tree }).run(plan, lease)
      .catch((error: unknown) => error)
    tree.child.stderr.write([
      `Authorization: Basic ${rawValues[0]}`,
      `authorization=Bearer ${rawValues[1]}`,
      `OPENAI_API_KEY=${rawValues[2]}`,
      `SERVICE_TOKEN: ${rawValues[3]}`,
      `BUILD_SECRET=${rawValues[4]}`,
      `DB_PASSWORD: ${rawValues[5]}`,
      `clientCredential=${rawValues[6]}`,
      `X-Api-Key: ${rawValues[7]}`,
    ].join('\n'))
    tree.child.finish(9)

    const error = await running
    expect(error).toBeInstanceOf(ConversionProcessError)
    expect(error).toMatchObject({ code: 'CONVERSION_INPUT_INVALID', exitCode: 9 })
    for (const rawValue of rawValues) {
      expect((error as ConversionProcessError).stderrSummary).not.toContain(rawValue)
    }
  })

  it('maps process output stream failures to a stable error without leaking the raw stream error', async () => {
    const { lease, plan, work } = await fixture()
    const tree = new FakeProcessTree()
    const running = createConversionProcessRunner({ processTree: tree }).run(plan, lease)
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(tree.spawns).toHaveLength(1))
    tree.child.stderr.destroy(new Error(`stream failed at ${work}/secret`))
    tree.child.finish(0)

    const error = await running
    expect(error).toBeInstanceOf(ConversionProcessError)
    expect(error).toMatchObject({ code: 'CONVERSION_INTERRUPTED', exitCode: 0 })
    expect((error as ConversionProcessError).stderrSummary).not.toContain(work)
    expect((error as ConversionProcessError).stderrSummary).not.toContain('secret')
  })

  it('terminates the full process tree and waits for both termination and exit on cancellation', async () => {
    const { lease, plan } = await fixture()
    const tree = new FakeProcessTree()
    const termination = deferred<void>()
    tree.terminate = () => termination.promise
    const abort = new AbortController()
    let settled = false
    const running = createConversionProcessRunner({ processTree: tree }).run(plan, lease, { signal: abort.signal })
      .catch((error: unknown) => error)
      .finally(() => { settled = true })

    await vi.waitFor(() => expect(tree.spawns).toHaveLength(1))
    abort.abort()
    await vi.waitFor(() => expect(tree.terminations).toEqual([tree.child]))
    expect(settled).toBe(false)
    termination.resolve(undefined)
    await Promise.resolve()
    expect(settled).toBe(false)
    tree.child.finish(null, 'SIGTERM')

    await expect(running).resolves.toMatchObject({ code: 'CONVERSION_CANCELLED' })
  })

  it('uses the exact adapter timeout, terminates the tree, and waits for exit', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { lease, plan } = await fixture()
    const tree = new FakeProcessTree()
    const running = createConversionProcessRunner({ processTree: tree }).run(plan, lease)
      .catch((error: unknown) => error)

    await vi.waitFor(() => expect(tree.spawns).toHaveLength(1), { interval: 1, timeout: 100 })
    const elapsed = Date.now()
    await vi.advanceTimersByTimeAsync(CONVERSION_TIMEOUTS.image - elapsed - 1)
    expect(tree.terminations).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(tree.terminations).toEqual([tree.child]), { interval: 1, timeout: 100 })
    tree.child.finish(null, 'SIGKILL')

    await expect(running).resolves.toMatchObject({ code: 'CONVERSION_TIMEOUT' })
  })

  it('bounds lingering descendant pipes after normal root exit and terminates the retained tree', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { lease, plan } = await fixture()
    const tree = new FakeProcessTree()
    let settled = false
    const running = createConversionProcessRunner({ processTree: tree }).run(plan, lease)
      .catch((error: unknown) => error)
      .finally(() => { settled = true })
    await vi.waitFor(() => expect(tree.spawns).toHaveLength(1), { interval: 1, timeout: 100 })

    tree.child.exitOnly(0)
    await vi.advanceTimersByTimeAsync(1_001)
    const settledAtBound = settled
    tree.child.closeOutput()
    const result = await running

    expect(settledAtBound).toBe(true)
    expect(tree.terminations).toEqual([tree.child])
    expect(result).toMatchObject({ code: 'CONVERSION_INTERRUPTED', exitCode: 0 })
  })

  it('settles cancellation after tree termination when descendants retain inherited pipes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { lease, plan } = await fixture()
    const tree = new FakeProcessTree()
    tree.terminate = async () => { tree.child.exitOnly(null, 'SIGTERM') }
    const abort = new AbortController()
    let settled = false
    const running = createConversionProcessRunner({ processTree: tree }).run(plan, lease, { signal: abort.signal })
      .catch((error: unknown) => error)
      .finally(() => { settled = true })
    await vi.waitFor(() => expect(tree.spawns).toHaveLength(1), { interval: 1, timeout: 100 })

    abort.abort()
    await vi.waitFor(() => expect(tree.terminations).toEqual([tree.child]), { interval: 1, timeout: 100 })
    await vi.advanceTimersByTimeAsync(1_001)
    const settledAtBound = settled
    tree.child.closeOutput()
    const result = await running

    expect(settledAtBound).toBe(true)
    expect(result).toMatchObject({ code: 'CONVERSION_CANCELLED', exitCode: null })
  })

  it('settles timeout after tree termination when descendants retain inherited pipes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { lease, plan } = await fixture()
    const tree = new FakeProcessTree()
    tree.terminate = async () => { tree.child.exitOnly(null, 'SIGKILL') }
    let settled = false
    const running = createConversionProcessRunner({ processTree: tree }).run(plan, lease)
      .catch((error: unknown) => error)
      .finally(() => { settled = true })
    await vi.waitFor(() => expect(tree.spawns).toHaveLength(1), { interval: 1, timeout: 100 })

    await vi.advanceTimersByTimeAsync(CONVERSION_TIMEOUTS.image - Date.now())
    await vi.waitFor(() => expect(tree.terminations).toEqual([tree.child]), { interval: 1, timeout: 100 })
    await vi.advanceTimersByTimeAsync(1_001)
    const settledAtBound = settled
    tree.child.closeOutput()
    const result = await running

    expect(settledAtBound).toBe(true)
    expect(result).toMatchObject({ code: 'CONVERSION_TIMEOUT', exitCode: null })
  })
})

describe('platform process-tree port', () => {
  it('spawns a detached Darwin process group and terminates the negative group id before waiting for exit', async () => {
    vi.useFakeTimers()
    const child = new EventEmitter() as EventEmitter & {
      pid: number
      stdout: PassThrough
      stderr: PassThrough
    }
    child.pid = 9876
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const spawnCalls: unknown[][] = []
    const spawn = ((...args: unknown[]) => {
      spawnCalls.push(args)
      return child
    }) as never
    const kills: Array<[number, NodeJS.Signals]> = []
    const kill = ((pid: number, signal: NodeJS.Signals) => {
      kills.push([pid, signal])
      return true
    }) as typeof process.kill
    const port = createNodeConversionProcessTreePort({ platform: 'darwin', spawn, kill, terminationGraceMs: 10 })
    const handle = port.spawn('/signed/bin/converter', ['--', '/input/-name'], {
      shell: false, windowsHide: true, cwd: '/private/work', env: { LANG: 'C.UTF-8' },
    })
    expect(spawnCalls).toEqual([[
      '/signed/bin/converter', ['--', '/input/-name'], {
        shell: false, windowsHide: true, cwd: '/private/work', env: { LANG: 'C.UTF-8' },
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      },
    ]])
    expect(handle.processGroupId).toBe(9876)

    const terminating = port.terminateTree(handle)
    expect(kills).toEqual([[-9876, 'SIGTERM']])
    child.emit('exit', null, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(10)
    expect(kills).toEqual([[-9876, 'SIGTERM'], [-9876, 'SIGKILL']])
    await expect(terminating).resolves.toBeUndefined()
  })

  it.runIf(process.platform === 'darwin')('observes a real root exit before inherited pipes close and removes its descendant', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'autoforge-real-process-tree-')))
    temporaryRoots.push(work)
    const descendantPidPath = join(work, 'descendant.pid')
    const nodeExecutable = await resolveTestNodeExecutable()
    const nodeRoot = await realpath(dirname(nodeExecutable))
    const lease: ConverterPackLease = Object.freeze({
      name: 'image-icon', version: '1.0.0', platform: 'darwin', arch: process.arch === 'arm64' ? 'arm64' : 'x64', root: nodeRoot,
      executables: Object.freeze({ node: nodeExecutable }), release() {},
    })
    const script = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })",
      'descendant.unref()',
      'writeFileSync(process.argv[1], String(descendant.pid))',
    ].join(';')
    const plan: ConversionProcessPlan = {
      executable: nodeExecutable,
      args: ['-e', script, descendantPidPath],
      cwd: work,
      env: createConversionEnvironment(nodeExecutable, work),
      timeoutMs: CONVERSION_TIMEOUTS.image,
      outputContract: { kind: 'single' },
      outputPaths: [join(work, 'unused.png')],
      outputs: [{ path: join(work, 'unused.png'), format: 'png' }],
    }
    const realPort = createNodeConversionProcessTreePort({ platform: 'darwin', terminationGraceMs: 10 })
    let spawned: ConversionProcessHandle | undefined
    let terminations = 0
    const processTree: ConversionProcessTreePort = {
      spawn(executable, args, options) {
        spawned = realPort.spawn(executable, args, options)
        return spawned
      },
      async terminateTree(handle) {
        terminations += 1
        await realPort.terminateTree(handle)
      },
    }
    const abort = new AbortController()
    const running = createConversionProcessRunner({ processTree }).run(plan, lease, { signal: abort.signal })
      .catch((error: unknown) => error)
    let descendantPid: number | undefined
    let rootExit: Awaited<ReturnType<typeof observedWithin<ConversionProcessExit>>> | undefined
    let runnerResult: Awaited<ReturnType<typeof observedWithin<unknown>>> | undefined
    let terminationsBeforeFallback: number | undefined
    let descendantGoneBeforeFallback = false
    let cleanupSettled: boolean | undefined
    try {
      await vi.waitFor(() => expect(spawned).toBeDefined(), { interval: 5, timeout: 500 })
      await vi.waitFor(async () => {
        descendantPid = Number(await readFile(descendantPidPath, 'utf8'))
        expect(Number.isSafeInteger(descendantPid)).toBe(true)
      }, { interval: 5, timeout: 500 })
      ;[rootExit, runnerResult] = await Promise.all([
        observedWithin(spawned!.waitForExit(), 1_000),
        observedWithin(running, 2_500),
      ])
      terminationsBeforeFallback = terminations
      if (runnerResult.settled && descendantPid !== undefined) {
        await vi.waitFor(() => expect(processExists(descendantPid!)).toBe(false), { interval: 10, timeout: 500 })
        descendantGoneBeforeFallback = true
      }
    } finally {
      abort.abort()
      if (spawned?.processGroupId !== undefined) {
        try { process.kill(-spawned.processGroupId, 'SIGKILL') } catch {
          // The runner may already have removed the process group.
        }
      }
      if (descendantPid !== undefined) {
        try { process.kill(descendantPid, 'SIGKILL') } catch {
          // The group signal may already have removed the descendant.
        }
      }
      const cleanup = await observedWithin(running, 1_000)
      cleanupSettled = cleanup.settled
      if (descendantPid !== undefined) {
        await vi.waitFor(() => expect(processExists(descendantPid!)).toBe(false), { interval: 10, timeout: 500 })
      }
    }

    expect(rootExit).toEqual({ settled: true, value: { code: 0, signal: null } })
    expect(runnerResult).toMatchObject({
      settled: true,
      value: { code: 'CONVERSION_INTERRUPTED', exitCode: 0 },
    })
    expect(terminationsBeforeFallback).toBe(1)
    expect(descendantGoneBeforeFallback).toBe(true)
    expect(cleanupSettled).toBe(true)
  }, 5_000)

  it('fails closed on Windows without a Job Object port and delegates only to the branded port', () => {
    expect(() => createNodeConversionProcessTreePort({ platform: 'win32' })).toThrowError(
      expect.objectContaining({ code: 'CONVERSION_COMPONENT_UNAVAILABLE' }),
    )
    const windowsJobObject: WindowsJobObjectProcessTreePort = {
      treeKind: 'windows-job-object',
      spawn() { return new FakeProcess() },
      async terminateTree() {},
    }
    expect(createNodeConversionProcessTreePort({ platform: 'win32', windowsJobObject })).toBe(windowsJobObject)
  })
})
