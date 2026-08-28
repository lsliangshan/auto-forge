import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppErrorCode, ConversionJobStatus } from '@autoforge/shared'
import { openAppDatabase } from '../database/client.js'
import type {
  ConversionArtifact,
  ConversionJob,
} from '../database/repositories.js'
import type {
  ManagedOutputWriter,
  VerifiedConversionOutput,
} from './conversion-artifact-service.js'
import type { ConverterPackLease } from './converter-pack-types.js'
import {
  createConversionJobRunner,
  type ConversionConcurrencyClass,
  type ConversionJobEvent,
  type ConversionJobRuntime,
} from './conversion-job-runner.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

function conversionFailure(code: AppErrorCode): Error & { code: AppErrorCode } {
  return Object.assign(new Error(code), { code })
}

class ControlledWriter implements ManagedOutputWriter {
  readonly tempPath: string
  readonly started = deferred<void>()
  readonly releaseCommit = deferred<void>()
  readonly artifacts: ConversionArtifact[] = []
  commits = 0
  aborts = 0
  private aborted = false

  constructor(
    private readonly job: ConversionJob,
    private readonly mode: 'immediate' | 'controlled' | 'fail',
  ) {
    this.tempPath = join(tmpdir(), `${job.id}-${job.epoch}.partial`)
  }

  async commit(): Promise<ConversionArtifact> {
    this.commits += 1
    this.started.resolve(undefined)
    if (this.mode === 'controlled') await this.releaseCommit.promise
    if (this.aborted) throw conversionFailure('CONVERSION_CANCELLED')
    if (this.mode === 'fail') throw conversionFailure('CONVERSION_INPUT_INVALID')
    const artifact: ConversionArtifact = {
      id: `artifact-${this.job.id}-${this.job.epoch}`,
      ownerUserId: this.job.ownerUserId,
      executionId: this.job.executionId,
      conversionJobId: this.job.id,
      role: 'output',
      displayName: `result.${this.job.targetFormat}`,
      detectedFormat: this.job.targetFormat,
      mimeType: 'application/octet-stream',
      byteSize: 1,
      sha256: 'a'.repeat(64),
      relativePath: `results/${this.job.id}.${this.job.targetFormat}`,
      status: 'ready',
      createdAt: 1,
      updatedAt: 1,
    }
    this.artifacts.push(artifact)
    return artifact
  }

  async abort(): Promise<void> {
    this.aborts += 1
    this.aborted = true
    this.releaseCommit.resolve(undefined)
  }
}

interface ControlledAttempt extends Deferred<VerifiedConversionOutput> {
  onProgress?: (progress: number) => boolean
}

class ControlledRuntime implements ConversionJobRuntime {
  readonly attempts = new Map<string, ControlledAttempt>()
  readonly writers = new Map<string, ControlledWriter>()
  readonly writerModes = new Map<string, 'immediate' | 'controlled' | 'fail'>()
  readonly acquireFailures = new Map<string, AppErrorCode>()
  readonly starts: string[] = []
  readonly releases = new Map<string, number>()
  maxGlobal = 0
  maxDocument = 0
  maxVideo = 0
  private activeGlobal = 0
  private activeDocument = 0
  private activeVideo = 0

  concurrencyClass(job: ConversionJob): ConversionConcurrencyClass {
    if (job.sourceId.startsWith('document')) return 'document'
    if (job.sourceId.startsWith('video')) return 'video'
    return 'other'
  }

  async acquirePack(job: ConversionJob, signal: AbortSignal): Promise<ConverterPackLease> {
    const key = this.key(job.id, job.epoch)
    const failure = this.acquireFailures.get(key)
    if (failure !== undefined) throw conversionFailure(failure)
    if (signal.aborted) throw conversionFailure('CONVERSION_CANCELLED')
    const name = this.concurrencyClass(job) === 'document'
      ? 'document'
      : this.concurrencyClass(job) === 'video' ? 'media' : 'image-icon'
    let released = false
    return {
      name,
      version: '1.0.0',
      platform: 'darwin',
      arch: 'arm64',
      root: '/signed-pack',
      executables: Object.freeze({}),
      release: () => {
        if (released) return
        released = true
        this.releases.set(key, (this.releases.get(key) ?? 0) + 1)
      },
    }
  }

  async createWriter(job: ConversionJob, _lease: ConverterPackLease, signal: AbortSignal): Promise<ManagedOutputWriter> {
    if (signal.aborted) throw conversionFailure('CONVERSION_CANCELLED')
    const key = this.key(job.id, job.epoch)
    const writer = new ControlledWriter(job, this.writerModes.get(key) ?? 'immediate')
    this.writers.set(key, writer)
    return writer
  }

  async convert(
    job: ConversionJob,
    _lease: ConverterPackLease,
    _writer: ManagedOutputWriter,
    options: { signal: AbortSignal; onProgress(progress: number): boolean },
  ): Promise<VerifiedConversionOutput> {
    if (options.signal.aborted) throw conversionFailure('CONVERSION_CANCELLED')
    const key = this.key(job.id, job.epoch)
    const attempt = deferred<VerifiedConversionOutput>() as ControlledAttempt
    attempt.onProgress = options.onProgress
    this.attempts.set(key, attempt)
    this.starts.push(job.sourceId)
    const resource = this.concurrencyClass(job)
    this.activeGlobal += 1
    if (resource === 'document') this.activeDocument += 1
    if (resource === 'video') this.activeVideo += 1
    this.maxGlobal = Math.max(this.maxGlobal, this.activeGlobal)
    this.maxDocument = Math.max(this.maxDocument, this.activeDocument)
    this.maxVideo = Math.max(this.maxVideo, this.activeVideo)
    try {
      return await attempt.promise
    } finally {
      this.activeGlobal -= 1
      if (resource === 'document') this.activeDocument -= 1
      if (resource === 'video') this.activeVideo -= 1
    }
  }

  key(jobId: string, epoch: number): string {
    return `${jobId}:${epoch}`
  }
}

const temporaryDirectories: string[] = []

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-conversion-runner-'))
  temporaryDirectories.push(directory)
  const database = openAppDatabase(join(directory, 'autoforge.sqlite'))
  database.executions.insert({
    id: 'execution',
    ownerUserId: 'alice',
    workflowId: 'file.convert.universal',
    workflowVersion: '1.0.0',
    status: 'running',
    createdAt: 1,
  })
  const runtime = new ControlledRuntime()
  const events: ConversionJobEvent[] = []
  let nextId = 0
  const runner = createConversionJobRunner({
    ownerUserId: 'alice',
    jobs: database.conversionJobs,
    runtime,
    id: () => `job-${++nextId}`,
    onEvent: (event) => { events.push(event) },
  })
  return { database, events, runner, runtime }
}

function createPersistedJob(
  database: ReturnType<typeof openAppDatabase>,
  id: string,
  status: ConversionJobStatus,
  createdAt: number,
): ConversionJob {
  return database.conversionJobs.create({
    id,
    ownerUserId: 'alice',
    executionId: 'execution',
    sourceKind: 'artifact',
    sourceId: `other-${id}`,
    targetFormat: 'png',
    status,
    createdAt,
  })
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
  throw new Error(`Timed out waiting for ${message}`)
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('conversion job runner', () => {
  it('runs at most two jobs, serializes document and video work, and bypasses blocked resource waiters fairly', async () => {
    const { database, runner, runtime } = fixture()
    runner.start()
    const jobs = [
      runner.submit({ executionId: 'execution', sourceKind: 'artifact', sourceId: 'document-1', targetFormat: 'pdf' }),
      runner.submit({ executionId: 'execution', sourceKind: 'artifact', sourceId: 'document-2', targetFormat: 'pdf' }),
      runner.submit({ executionId: 'execution', sourceKind: 'artifact', sourceId: 'video-1', targetFormat: 'mp4' }),
      runner.submit({ executionId: 'execution', sourceKind: 'artifact', sourceId: 'video-2', targetFormat: 'webm' }),
      runner.submit({ executionId: 'execution', sourceKind: 'artifact', sourceId: 'other-1', targetFormat: 'png' }),
    ]

    await waitFor(() => runtime.attempts.size === 2, 'the first two compatible jobs')
    expect(runtime.starts).toEqual(['document-1', 'video-1'])
    runtime.attempts.get(runtime.key(jobs[2].jobId, 0))!.resolve({})
    await waitFor(() => runtime.starts.includes('video-2'), 'the next video job')
    runtime.attempts.get(runtime.key(jobs[0].jobId, 0))!.resolve({})
    await waitFor(() => runtime.starts.includes('document-2'), 'the next document job')
    runtime.attempts.get(runtime.key(jobs[3].jobId, 0))!.resolve({})
    await waitFor(() => runtime.starts.includes('other-1'), 'the unrestricted job')
    runtime.attempts.get(runtime.key(jobs[1].jobId, 0))!.resolve({})
    runtime.attempts.get(runtime.key(jobs[4].jobId, 0))!.resolve({})
    await runner.idle()

    expect(runtime.maxGlobal).toBe(2)
    expect(runtime.maxDocument).toBe(1)
    expect(runtime.maxVideo).toBe(1)
    expect(jobs.map(({ jobId }) => database.conversionJobs.getOwned(jobId, 'alice')?.status)).toEqual([
      'completed', 'completed', 'completed', 'completed', 'completed',
    ])
    expect([...runtime.releases.values()]).toEqual([1, 1, 1, 1, 1])
    database.close()
  })

  it('cancels a queued job immediately and publishes its terminal event once', async () => {
    const { database, events, runner, runtime } = fixture()
    const submitted = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'other-queued', targetFormat: 'png',
    })

    await expect(runner.cancel(submitted.jobId)).resolves.toBe(true)
    expect(database.conversionJobs.getOwned(submitted.jobId, 'alice')).toMatchObject({
      status: 'cancelled', errorCode: 'CONVERSION_CANCELLED',
    })
    runner.start()
    await runner.idle()
    expect(runtime.attempts.size).toBe(0)
    expect(events.filter((event) => event.jobId === submitted.jobId && event.status === 'cancelled')).toHaveLength(1)
    database.close()
  })

  it('drains an active cancellation and drops a late process success before writer commit', async () => {
    const { database, events, runner, runtime } = fixture()
    runner.start()
    const submitted = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'other-late-success', targetFormat: 'png',
    })
    const key = runtime.key(submitted.jobId, 0)
    await waitFor(() => runtime.attempts.has(key), 'conversion start')

    const cancelling = runner.cancel(submitted.jobId)
    expect(database.conversionJobs.getOwned(submitted.jobId, 'alice')?.status).toBe('cancelled')
    runtime.attempts.get(key)!.resolve({})
    await expect(cancelling).resolves.toBe(true)

    expect(runtime.writers.get(key)).toMatchObject({ commits: 0, aborts: 1 })
    expect(runtime.releases.get(key)).toBe(1)
    expect(database.conversionJobs.getOwned(submitted.jobId, 'alice')?.status).toBe('cancelled')
    expect(events.filter((event) => event.jobId === submitted.jobId && event.status === 'completed')).toEqual([])
    database.close()
  })

  it('keeps progress events monotonic and rejects callbacks after terminal completion', async () => {
    const { database, events, runner, runtime } = fixture()
    runner.start()
    const submitted = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'other-progress', targetFormat: 'png',
    })
    const key = runtime.key(submitted.jobId, 0)
    await waitFor(() => runtime.attempts.has(key), 'conversion start')
    const attempt = runtime.attempts.get(key)!

    expect(attempt.onProgress?.(80)).toBe(true)
    expect(attempt.onProgress?.(20)).toBe(true)
    expect(database.conversionJobs.getOwned(submitted.jobId, 'alice')?.progress).toBe(80)
    runtime.attempts.get(key)!.resolve({})
    await runner.idle()
    expect(attempt.onProgress?.(90)).toBe(false)
    const progress = events
      .filter((event) => event.jobId === submitted.jobId)
      .map((event) => event.progress)
    expect(progress).toEqual([...progress].sort((left, right) => left - right))
    database.close()
  })

  it('aborts a writer commit before accepting cancellation so no artifact is registered', async () => {
    const { database, events, runner, runtime } = fixture()
    runtime.writerModes.set('job-1:0', 'controlled')
    runner.start()
    const submitted = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'other-commit-race', targetFormat: 'png',
    })
    const key = runtime.key(submitted.jobId, 0)
    await waitFor(() => runtime.attempts.has(key), 'conversion start')
    runtime.attempts.get(key)!.resolve({})
    await waitFor(() => runtime.writers.get(key)?.commits === 1, 'writer commit')

    const cancelling = runner.cancel(submitted.jobId)
    await waitFor(
      () => database.conversionJobs.getOwned(submitted.jobId, 'alice')?.status === 'cancelled',
      'writer cancellation terminal state',
    )
    expect(runner.retry(submitted.jobId)).toBe(true)
    await expect(cancelling).resolves.toBe(true)

    const writer = runtime.writers.get(key)!
    expect(writer.artifacts).toEqual([])
    expect(writer.aborts).toBe(1)
    const retryKey = runtime.key(submitted.jobId, 1)
    await waitFor(() => runtime.attempts.has(retryKey), 'retry after writer cancellation')
    runtime.attempts.get(retryKey)!.resolve({})
    await runner.idle()
    expect(database.conversionJobs.getOwned(submitted.jobId, 'alice')).toMatchObject({ epoch: 1, status: 'completed' })
    expect(events.filter((event) => event.jobId === submitted.jobId && event.epoch === 0 && event.status === 'completed')).toEqual([])
    database.close()
  })

  it('makes stale epoch progress, failure, and completion paths inert after retry', async () => {
    const { database, events, runner, runtime } = fixture()
    runner.start()
    const failing = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'other-old-failure', targetFormat: 'png',
    })
    const succeeding = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'other-old-success', targetFormat: 'png',
    })
    const failingOldKey = runtime.key(failing.jobId, 0)
    const succeedingOldKey = runtime.key(succeeding.jobId, 0)
    await waitFor(() => runtime.attempts.has(failingOldKey) && runtime.attempts.has(succeedingOldKey), 'old epoch starts')

    const cancelFailing = runner.cancel(failing.jobId)
    const cancelSucceeding = runner.cancel(succeeding.jobId)
    expect(runner.retry(failing.jobId)).toBe(true)
    expect(runner.retry(succeeding.jobId)).toBe(true)
    expect(runtime.attempts.get(failingOldKey)!.onProgress?.(88)).toBe(false)
    runtime.attempts.get(failingOldKey)!.reject(conversionFailure('CONVERSION_TIMEOUT'))
    runtime.attempts.get(succeedingOldKey)!.resolve({})
    await Promise.all([cancelFailing, cancelSucceeding])

    const failingNewKey = runtime.key(failing.jobId, 1)
    const succeedingNewKey = runtime.key(succeeding.jobId, 1)
    await waitFor(() => runtime.attempts.has(failingNewKey) && runtime.attempts.has(succeedingNewKey), 'new epoch starts')
    expect(runtime.writers.get(succeedingOldKey)?.commits).toBe(0)
    expect(database.conversionJobs.getOwned(failing.jobId, 'alice')).toMatchObject({ epoch: 1, progress: 0 })
    expect(events.filter((event) => event.epoch === 0 && (event.status === 'failed' || event.status === 'completed'))).toEqual([])

    runtime.attempts.get(failingNewKey)!.resolve({})
    runtime.attempts.get(succeedingNewKey)!.resolve({})
    await runner.idle()
    expect(database.conversionJobs.getOwned(failing.jobId, 'alice')).toMatchObject({ epoch: 1, status: 'completed' })
    expect(database.conversionJobs.getOwned(succeeding.jobId, 'alice')).toMatchObject({ epoch: 1, status: 'completed' })
    database.close()
  })

  it('fails without an artifact when output verification rejects and releases the lease', async () => {
    const { database, runner, runtime } = fixture()
    runtime.writerModes.set('job-1:0', 'fail')
    runner.start()
    const submitted = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'other-invalid-output', targetFormat: 'png',
    })
    const key = runtime.key(submitted.jobId, 0)
    await waitFor(() => runtime.attempts.has(key), 'conversion start')
    runtime.attempts.get(key)!.resolve({})
    await runner.idle()

    expect(database.conversionJobs.getOwned(submitted.jobId, 'alice')).toMatchObject({
      status: 'failed', errorCode: 'CONVERSION_INPUT_INVALID',
    })
    expect(runtime.writers.get(key)?.artifacts).toEqual([])
    expect(runtime.writers.get(key)?.aborts).toBe(1)
    expect(runtime.releases.get(key)).toBe(1)
    database.close()
  })

  it('fails closed when pack acquisition rejects without creating a writer', async () => {
    const { database, runner, runtime } = fixture()
    runtime.acquireFailures.set('job-1:0', 'CONVERSION_COMPONENT_UNAVAILABLE')
    runner.start()
    const submitted = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'other-pack-failure', targetFormat: 'png',
    })
    await runner.idle()

    expect(database.conversionJobs.getOwned(submitted.jobId, 'alice')).toMatchObject({
      status: 'failed', errorCode: 'CONVERSION_COMPONENT_UNAVAILABLE',
    })
    expect(runtime.writers.size).toBe(0)
    expect(runtime.releases.size).toBe(0)
    database.close()
  })

  it('interrupts only persisted in-flight states on restart and retries through an incremented epoch', async () => {
    const { database, runner, runtime } = fixture()
    createPersistedJob(database, 'recovery-downloading', 'downloading_component', 1)
    createPersistedJob(database, 'recovery-converting', 'converting', 2)
    createPersistedJob(database, 'recovery-verifying', 'verifying', 3)
    createPersistedJob(database, 'recovery-queued', 'queued', 4)
    createPersistedJob(database, 'recovery-completed', 'completed', 5)

    expect(runner.start()).toBe(3)
    expect(database.conversionJobs.getOwned('recovery-downloading', 'alice')?.status).toBe('interrupted')
    expect(database.conversionJobs.getOwned('recovery-converting', 'alice')?.status).toBe('interrupted')
    expect(database.conversionJobs.getOwned('recovery-verifying', 'alice')?.status).toBe('interrupted')
    expect(database.conversionJobs.getOwned('recovery-queued', 'alice')?.status).toBe('queued')
    expect(database.conversionJobs.getOwned('recovery-completed', 'alice')?.status).toBe('completed')
    expect(runner.retry('recovery-converting')).toBe(true)
    expect(database.conversionJobs.getOwned('recovery-converting', 'alice')).toMatchObject({
      status: 'queued', epoch: 1, progress: 0,
    })

    await waitFor(() => runtime.attempts.has('recovery-converting:1') && runtime.attempts.has('recovery-queued:0'), 'recovered retries')
    runtime.attempts.get('recovery-converting:1')!.resolve({})
    runtime.attempts.get('recovery-queued:0')!.resolve({})
    await runner.idle()
    database.close()
  })

  it('stop marks active jobs interrupted and waits for process drain, writer cleanup, and lease release', async () => {
    const { database, runner, runtime } = fixture()
    runner.start()
    const first = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'document-shutdown', targetFormat: 'pdf',
    })
    const second = runner.submit({
      executionId: 'execution', sourceKind: 'artifact', sourceId: 'video-shutdown', targetFormat: 'mp4',
    })
    await waitFor(() => runtime.attempts.size === 2, 'active shutdown jobs')

    let stopped = false
    const stopping = runner.stop().then(() => { stopped = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(stopped).toBe(false)
    expect(database.conversionJobs.getOwned(first.jobId, 'alice')?.status).toBe('interrupted')
    expect(database.conversionJobs.getOwned(second.jobId, 'alice')?.status).toBe('interrupted')
    runtime.attempts.get(`${first.jobId}:0`)!.reject(conversionFailure('CONVERSION_CANCELLED'))
    runtime.attempts.get(`${second.jobId}:0`)!.reject(conversionFailure('CONVERSION_CANCELLED'))
    await stopping

    expect(runtime.writers.get(`${first.jobId}:0`)).toMatchObject({ aborts: 1 })
    expect(runtime.writers.get(`${second.jobId}:0`)).toMatchObject({ aborts: 1 })
    expect(runtime.releases.get(`${first.jobId}:0`)).toBe(1)
    expect(runtime.releases.get(`${second.jobId}:0`)).toBe(1)
    database.close()
  })
})
