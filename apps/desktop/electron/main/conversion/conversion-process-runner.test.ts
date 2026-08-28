import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

class FakeProcess implements ConversionProcessHandle {
  readonly pid = 4321
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private readonly exit = deferred<ConversionProcessExit>()

  waitForExit(): Promise<ConversionProcessExit> {
    return this.exit.promise
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end()
    this.stderr.end()
    this.exit.resolve({ code, signal })
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
})

describe('platform process-tree port', () => {
  it('spawns a detached Darwin process group and terminates the negative group id before waiting for exit', async () => {
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

    const terminating = port.terminateTree(handle)
    expect(kills).toEqual([[-9876, 'SIGTERM']])
    child.emit('close', null, 'SIGTERM')
    await expect(terminating).resolves.toBeUndefined()
  })

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
