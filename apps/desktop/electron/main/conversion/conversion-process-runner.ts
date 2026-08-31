import { spawn as nodeSpawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import type {
  AppErrorCode,
  ConversionPreset,
  ConversionTargetFormat,
} from '@autoforge/shared'
import type { ConversionArtifactMetadata } from '../database/repositories.js'
import type { ProbedConversionInput } from './conversion-catalog.js'
import type { ConverterPackLease } from './converter-pack-types.js'

export const CONVERSION_TIMEOUTS = Object.freeze({
  image: 2 * 60 * 1_000,
  icon: 2 * 60 * 1_000,
  document: 5 * 60 * 1_000,
  pdf: 5 * 60 * 1_000,
  audio: 10 * 60 * 1_000,
  video: 30 * 60 * 1_000,
})

export const CONVERSION_OUTPUT_CAPTURE_BYTES = 64 * 1024
export const CONVERSION_POST_EXIT_DRAIN_MS = 1_000
const truncatedMarker = Buffer.from('\n[truncated]', 'utf8')
const allowedTimeouts = new Set<number>(Object.values(CONVERSION_TIMEOUTS))
const allowedEnvironmentKeys = ['LANG', 'LC_ALL', 'PATH', 'TEMP', 'TMP', 'TMPDIR'] as const

export interface ConversionRequest {
  readonly inputPath: string
  readonly targetFormat: ConversionTargetFormat
  readonly preset?: ConversionPreset
}

export interface ConversionExpectedOutput {
  readonly path: string
  readonly format: ConversionTargetFormat
  readonly metadata?: ConversionArtifactMetadata
  readonly iconSlots?: readonly ConversionIcnsSlot[]
}

export interface ConversionIcnsSlot {
  readonly type: 'icp4' | 'ic11' | 'icp5' | 'ic12' | 'ic07' | 'ic13' | 'ic08' | 'ic14' | 'ic09' | 'ic10'
  readonly logicalSize: 16 | 32 | 128 | 256 | 512
  readonly scale: 1 | 2
  readonly pixelSize: 16 | 32 | 64 | 128 | 256 | 512 | 1024
}

export type ConversionOutputContract =
  | { readonly kind: 'single' }
  | { readonly kind: 'pdf-pages'; readonly count: number }
  | { readonly kind: 'icon-representations'; readonly count: number }

export interface ConversionProcessPlan {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly outputContract: ConversionOutputContract
  readonly outputPaths: readonly string[]
  readonly outputs: readonly ConversionExpectedOutput[]
}

export interface ConverterAdapter {
  supports(input: ProbedConversionInput, target: ConversionTargetFormat): boolean
  plan(
    input: ProbedConversionInput,
    request: ConversionRequest,
    lease: ConverterPackLease,
    outputRoot: string,
  ): ConversionProcessPlan
}

export interface ConversionProcessSpawnOptions {
  readonly shell: false
  readonly windowsHide: true
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export interface ConversionProcessExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: unknown
}

export interface ConversionProcessHandle {
  readonly pid: number | undefined
  readonly processGroupId?: number
  readonly stdout: AsyncIterable<Uint8Array | string>
  readonly stderr: AsyncIterable<Uint8Array | string>
  waitForExit(): Promise<ConversionProcessExit>
}

export interface ConversionProcessTreePort {
  spawn(executable: string, args: readonly string[], options: ConversionProcessSpawnOptions): ConversionProcessHandle
  terminateTree(process: ConversionProcessHandle): Promise<void>
}

export interface WindowsJobObjectProcessTreePort extends ConversionProcessTreePort {
  readonly treeKind: 'windows-job-object'
}

export interface ConversionProcessResult {
  readonly exitCode: 0
  readonly stdout: string
  readonly stderr: string
}

const stableMessages: Partial<Record<AppErrorCode, string>> = {
  CONVERSION_COMPONENT_UNAVAILABLE: 'The required conversion component is unavailable.',
  CONVERSION_INPUT_INVALID: 'The input file cannot be converted.',
  CONVERSION_TIMEOUT: 'The conversion timed out.',
  CONVERSION_CANCELLED: 'The conversion was cancelled.',
  CONVERSION_INTERRUPTED: 'The conversion was interrupted.',
  CONVERSION_FORMAT_UNSUPPORTED: 'The requested output format is not supported.',
}

export class ConversionProcessError extends Error {
  readonly code: AppErrorCode
  readonly exitCode: number | null
  readonly stderrSummary: string

  constructor(code: AppErrorCode, exitCode: number | null = null, stderrSummary = '') {
    super(stableMessages[code] ?? 'The conversion was interrupted.')
    this.code = code
    this.exitCode = exitCode
    this.stderrSummary = stderrSummary
  }
}

function failure(code: AppErrorCode, exitCode: number | null = null, stderrSummary = ''): ConversionProcessError {
  return new ConversionProcessError(code, exitCode, stderrSummary)
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function hasNull(value: string): boolean {
  return value.includes('\0')
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function exactPlainRecord(value: Readonly<Record<string, string>>, expectedKeys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) return false
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function createConversionEnvironment(executable: string, workDirectory: string): Readonly<Record<string, string>> {
  return Object.freeze({
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: dirname(executable),
    TEMP: workDirectory,
    TMP: workDirectory,
    TMPDIR: workDirectory,
  })
}

export function requireLeaseExecutable(lease: ConverterPackLease, relativePath: string): string {
  const executable = lease.executables[relativePath]
  if (typeof executable !== 'string' || executable.length === 0 || hasNull(executable)) {
    throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
  }
  return executable
}

function validatePlanShape(plan: ConversionProcessPlan): void {
  if (
    typeof plan.executable !== 'string'
    || !isAbsolute(plan.executable)
    || hasNull(plan.executable)
    || typeof plan.cwd !== 'string'
    || !isAbsolute(plan.cwd)
    || hasNull(plan.cwd)
    || !Array.isArray(plan.args)
    || plan.args.length === 0
    || plan.args.length > 256
    || plan.args.some((arg) => typeof arg !== 'string' || hasNull(arg) || Buffer.byteLength(arg) > 32 * 1024)
    || !allowedTimeouts.has(plan.timeoutMs)
    || !Array.isArray(plan.outputPaths)
    || plan.outputPaths.length === 0
    || !Array.isArray(plan.outputs)
    || plan.outputs.length !== plan.outputPaths.length
  ) throw failure('CONVERSION_INPUT_INVALID')
  const contract = plan.outputContract
  if (typeof contract !== 'object' || contract === null || Array.isArray(contract)) {
    throw failure('CONVERSION_INPUT_INVALID')
  }
  if (contract.kind === 'single') {
    if (Object.keys(contract).length !== 1 || plan.outputPaths.length !== 1) throw failure('CONVERSION_INPUT_INVALID')
    return
  }
  if (
    (contract.kind !== 'pdf-pages' && contract.kind !== 'icon-representations')
    || Object.keys(contract).length !== 2
    || !Number.isSafeInteger(contract.count)
    || contract.count !== plan.outputPaths.length
    || contract.count < 1
    || (contract.kind === 'pdf-pages' && contract.count > 100)
    || (contract.kind === 'icon-representations' && contract.count > 256)
  ) throw failure('CONVERSION_INPUT_INVALID')
}

async function verifyExecutable(plan: ConversionProcessPlan, lease: ConverterPackLease): Promise<{ root: string; executable: string; cwd: string }> {
  try {
    const rootMetadata = await lstat(lease.root)
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
    const root = await realpath(lease.root)
    if (root !== lease.root) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
    const declaredPath = Object.values(lease.executables).find((value) => value === plan.executable)
    if (declaredPath === undefined) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
    const executableMetadata = await lstat(plan.executable)
    if (executableMetadata.isSymbolicLink() || !executableMetadata.isFile()) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
    const executable = await realpath(plan.executable)
    const declared = await realpath(declaredPath)
    if (executable !== declared || !inside(root, executable)) throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
    const cwdMetadata = await lstat(plan.cwd)
    if (cwdMetadata.isSymbolicLink() || !cwdMetadata.isDirectory()) throw failure('CONVERSION_INPUT_INVALID')
    const cwd = await realpath(plan.cwd)
    return { root, executable, cwd }
  } catch (error) {
    if (error instanceof ConversionProcessError) throw error
    throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
  }
}

function validateEnvironment(plan: ConversionProcessPlan, executable: string, cwd: string): void {
  if (!exactPlainRecord(plan.env, allowedEnvironmentKeys)) throw failure('CONVERSION_INPUT_INVALID')
  const expected = createConversionEnvironment(executable, cwd)
  if (allowedEnvironmentKeys.some((key) => plan.env[key] !== expected[key] || hasNull(plan.env[key]!))) {
    throw failure('CONVERSION_INPUT_INVALID')
  }
}

function validateOutputs(plan: ConversionProcessPlan, cwd: string): void {
  const seen = new Set<string>()
  for (let index = 0; index < plan.outputPaths.length; index += 1) {
    const path = plan.outputPaths[index]
    const output = plan.outputs[index]
    if (
      typeof path !== 'string'
      || !isAbsolute(path)
      || hasNull(path)
      || !inside(cwd, path)
      || seen.has(path)
      || output === undefined
      || output.path !== path
    ) throw failure('CONVERSION_INPUT_INVALID')
    if (plan.outputContract.kind === 'pdf-pages' && output.metadata?.pdfPage !== index + 1) {
      throw failure('CONVERSION_INPUT_INVALID')
    }
    seen.add(path)
  }
}

interface CapturedProcessOutput {
  readonly text: string
  readonly streamFailed: boolean
}

async function collectBounded(
  stream: AsyncIterable<Uint8Array | string>,
  stop: Promise<void>,
): Promise<CapturedProcessOutput> {
  const retainedLimit = CONVERSION_OUTPUT_CAPTURE_BYTES - truncatedMarker.byteLength
  const chunks: Buffer[] = []
  let retained = 0
  let truncated = false
  let streamFailed = false
  const iterator = stream[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await Promise.race([
        iterator.next().then((result) => ({ kind: 'chunk' as const, result })),
        stop.then(() => ({ kind: 'stop' as const })),
      ])
      if (next.kind === 'stop') {
        void Promise.resolve(iterator.return?.()).catch(() => undefined)
        break
      }
      if (next.result.done === true) break
      const chunk = next.result.value
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      const available = retainedLimit - retained
      if (available > 0) {
        const kept = Math.min(available, bytes.byteLength)
        chunks.push(Buffer.from(bytes.subarray(0, kept)))
        retained += kept
      }
      if (bytes.byteLength > Math.max(0, available)) truncated = true
    }
  } catch {
    streamFailed = true
  }
  if (truncated) chunks.push(truncatedMarker)
  return { text: Buffer.concat(chunks).toString('utf8'), streamFailed }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sanitize(text: string, paths: readonly string[]): string {
  let safe = text
  for (const path of [...new Set(paths)].sort((left, right) => right.length - left.length)) {
    if (path.length > 0) safe = safe.replace(new RegExp(escapeRegExp(path), 'gu'), '<path>')
  }
  safe = safe
    .replace(
      /\b([A-Za-z0-9_-]*(?:api[-_]?key|token|secret|passwords?|credentials?|authorization)[A-Za-z0-9_-]*)\s*[:=]\s*(?:(?:Basic|Bearer)\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
      '$1=<redacted>',
    )
    .replace(/\b(Basic|Bearer)\s+[^\s,;]+/giu, '$1 <redacted>')
    .replace(/[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s\\]*/gu, '<path>')
    .replace(/\/(?:[^\s/]+\/)+[^\s/]*/gu, '<path>')
  const bytes = Buffer.from(safe, 'utf8')
  return bytes.byteLength <= CONVERSION_OUTPUT_CAPTURE_BYTES
    ? safe
    : Buffer.concat([bytes.subarray(0, CONVERSION_OUTPUT_CAPTURE_BYTES - truncatedMarker.byteLength), truncatedMarker]).toString('utf8')
}

export interface ConversionProcessRunner {
  run(
    plan: ConversionProcessPlan,
    lease: ConverterPackLease,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ConversionProcessResult>
}

export function createConversionProcessRunner(options: { processTree: ConversionProcessTreePort }): ConversionProcessRunner {
  return {
    async run(plan, lease, runOptions = {}) {
      if (runOptions.signal?.aborted) throw failure('CONVERSION_CANCELLED')
      validatePlanShape(plan)
      const verified = await verifyExecutable(plan, lease)
      validateEnvironment(plan, verified.executable, verified.cwd)
      validateOutputs(plan, verified.cwd)
      if (runOptions.signal?.aborted) throw failure('CONVERSION_CANCELLED')

      const spawnOptions: ConversionProcessSpawnOptions = Object.freeze({
        shell: false,
        windowsHide: true,
        cwd: verified.cwd,
        env: plan.env,
      })
      let process: ConversionProcessHandle
      try {
        process = options.processTree.spawn(verified.executable, Object.freeze([...plan.args]), spawnOptions)
      } catch (error) {
        if (error instanceof ConversionProcessError) throw error
        throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
      }

      const stopCapture = deferred<void>()
      const stdoutTask = collectBounded(process.stdout, stopCapture.promise)
      const stderrTask = collectBounded(process.stderr, stopCapture.promise)
      const captureTask = Promise.all([stdoutTask, stderrTask])
      const exitTask = process.waitForExit()
      const termination = deferred<'cancelled' | 'timeout'>()
      const onAbort = () => termination.resolve('cancelled')
      runOptions.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => termination.resolve('timeout'), plan.timeoutMs)
      const waitForBoundedCapture = async (): Promise<readonly [CapturedProcessOutput, CapturedProcessOutput]> => {
        let drainTimer: ReturnType<typeof setTimeout> | undefined
        const drained = await Promise.race([
          captureTask.then(() => true),
          new Promise<false>((resolve) => {
            drainTimer = setTimeout(() => resolve(false), CONVERSION_POST_EXIT_DRAIN_MS)
          }),
        ])
        if (drainTimer !== undefined) clearTimeout(drainTimer)
        if (!drained) stopCapture.resolve(undefined)
        return captureTask
      }
      const terminateTree = async (): Promise<void> => {
        try {
          await options.processTree.terminateTree(process)
        } catch (error) {
          stopCapture.resolve(undefined)
          await captureTask
          if (error instanceof ConversionProcessError) throw error
          throw failure('CONVERSION_INTERRUPTED')
        }
      }
      try {
        const winner = await Promise.race([
          exitTask.then((exit) => ({ kind: 'exit' as const, exit })),
          termination.promise.then((reason) => ({ kind: 'termination' as const, reason })),
        ])

        let exit: ConversionProcessExit
        let captured: readonly [CapturedProcessOutput, CapturedProcessOutput]
        let terminationReason: 'cancelled' | 'timeout' | undefined
        let lingeringAfterExit = false
        if (winner.kind === 'termination') {
          terminationReason = winner.reason
          await terminateTree()
          exit = await exitTask
          captured = await waitForBoundedCapture()
        } else {
          exit = winner.exit
          let lingeringTimer: ReturnType<typeof setTimeout> | undefined
          const afterExit = await Promise.race([
            captureTask.then((value) => ({ kind: 'captured' as const, value })),
            termination.promise.then((reason) => ({ kind: 'termination' as const, reason })),
            new Promise<{ readonly kind: 'lingering' }>((resolve) => {
              lingeringTimer = setTimeout(() => resolve({ kind: 'lingering' }), CONVERSION_POST_EXIT_DRAIN_MS)
            }),
          ])
          if (lingeringTimer !== undefined) clearTimeout(lingeringTimer)
          if (afterExit.kind === 'captured') {
            captured = afterExit.value
          } else {
            terminationReason = afterExit.kind === 'termination' ? afterExit.reason : undefined
            lingeringAfterExit = afterExit.kind === 'lingering'
            await terminateTree()
            if (lingeringAfterExit) stopCapture.resolve(undefined)
            captured = lingeringAfterExit ? await captureTask : await waitForBoundedCapture()
          }
        }
        const [capturedStdout, capturedStderr] = captured
        const sensitivePaths = [verified.root, verified.executable, verified.cwd, ...plan.args.filter(isAbsolute), ...plan.outputPaths]
        const stdout = sanitize(capturedStdout.text, sensitivePaths)
        const stderr = sanitize(capturedStderr.text, sensitivePaths)

        if (terminationReason !== undefined) {
          throw failure(terminationReason === 'cancelled' ? 'CONVERSION_CANCELLED' : 'CONVERSION_TIMEOUT', exit.code, stderr)
        }
        if (lingeringAfterExit || capturedStdout.streamFailed || capturedStderr.streamFailed) {
          throw failure('CONVERSION_INTERRUPTED', exit.code, stderr)
        }
        if (exit.error !== undefined) throw failure('CONVERSION_COMPONENT_UNAVAILABLE', exit.code, stderr)
        if (exit.code !== 0) {
          throw failure(exit.signal === null ? 'CONVERSION_INPUT_INVALID' : 'CONVERSION_INTERRUPTED', exit.code, stderr)
        }
        return { exitCode: 0, stdout, stderr }
      } finally {
        clearTimeout(timer)
        runOptions.signal?.removeEventListener('abort', onAbort)
        stopCapture.resolve(undefined)
      }
    },
  }
}

export interface NodeProcessTreeOptions {
  readonly platform?: NodeJS.Platform
  readonly windowsJobObject?: WindowsJobObjectProcessTreePort
  readonly spawn?: typeof nodeSpawn
  readonly kill?: typeof process.kill
  readonly terminationGraceMs?: number
}

export function createNodeConversionProcessTreePort(options: NodeProcessTreeOptions = {}): ConversionProcessTreePort {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    if (options.windowsJobObject === undefined || options.windowsJobObject.treeKind !== 'windows-job-object') {
      throw failure('CONVERSION_COMPONENT_UNAVAILABLE')
    }
    return options.windowsJobObject
  }
  if (platform !== 'darwin') throw failure('CONVERSION_COMPONENT_UNAVAILABLE')

  const spawn = options.spawn ?? nodeSpawn
  const kill = options.kill ?? process.kill
  const graceMs = options.terminationGraceMs ?? 1_000
  const children = new WeakSet<ConversionProcessHandle>()
  return {
    spawn(executable, args, spawnOptions) {
      const child = spawn(executable, [...args], {
        shell: spawnOptions.shell,
        windowsHide: spawnOptions.windowsHide,
        cwd: spawnOptions.cwd,
        env: { ...spawnOptions.env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const exit = deferred<ConversionProcessExit>()
      let settled = false
      child.once('error', (error) => {
        if (settled) return
        settled = true
        exit.resolve({ code: null, signal: null, error })
      })
      child.once('exit', (code, signal) => {
        if (settled) return
        settled = true
        exit.resolve({ code, signal })
      })
      const handle: ConversionProcessHandle = {
        pid: child.pid,
        processGroupId: child.pid,
        stdout: child.stdout,
        stderr: child.stderr,
        waitForExit: () => exit.promise,
      }
      children.add(handle)
      return handle
    },
    async terminateTree(handle) {
      if (handle.processGroupId === undefined || !children.has(handle)) throw failure('CONVERSION_INTERRUPTED')
      try {
        kill(-handle.processGroupId, 'SIGTERM')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw failure('CONVERSION_INTERRUPTED')
      }
      await new Promise<void>((resolve) => setTimeout(resolve, graceMs))
      try {
        kill(-handle.processGroupId, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw failure('CONVERSION_INTERRUPTED')
      }
      await handle.waitForExit()
    },
  }
}
