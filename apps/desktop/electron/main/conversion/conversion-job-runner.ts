import { randomUUID } from 'node:crypto'
import type { AppErrorCode, ConversionJobStatus } from '@autoforge/shared'
import type {
  ConversionJob,
  ConversionJobTransition,
  NewConversionJob,
} from '../database/repositories.js'
import type {
  ManagedOutputWriter,
  VerifiedConversionOutput,
} from './conversion-artifact-service.js'
import type { ConverterPackLease } from './converter-pack-types.js'

export const CONVERSION_JOB_TRANSITIONS = Object.freeze({
  queued: ['downloading_component', 'cancelled'],
  downloading_component: ['converting', 'failed', 'cancelled', 'interrupted'],
  converting: ['verifying', 'failed', 'cancelled', 'interrupted'],
  verifying: ['completed', 'failed', 'cancelled', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: ['queued'],
} as const satisfies Readonly<Record<ConversionJobStatus, readonly ConversionJobStatus[]>>)

const activeStatuses = new Set<ConversionJobStatus>(['downloading_component', 'converting', 'verifying'])
const retryableStatuses = new Set<ConversionJobStatus>(['failed', 'cancelled', 'interrupted'])
const conversionFailureCodes = new Set<AppErrorCode>([
  'CONVERSION_FORMAT_UNSUPPORTED',
  'CONVERSION_COMPONENT_UNAVAILABLE',
  'CONVERSION_INPUT_INVALID',
  'CONVERSION_OUTPUT_TOO_LARGE',
  'CONVERSION_TIMEOUT',
  'CONVERSION_INTERRUPTED',
])

export type ConversionConcurrencyClass = 'document' | 'video' | 'other'

export interface ConversionJobEvent {
  readonly jobId: string
  readonly ownerUserId: string
  readonly epoch: number
  readonly status: ConversionJobStatus
  readonly progress: number
  readonly errorCode?: AppErrorCode
}

/** Main-owned composition of pack, fixed adapter/process, input, and output ports. */
export interface ConversionJobRuntime {
  concurrencyClass(job: ConversionJob): ConversionConcurrencyClass
  acquirePack(job: ConversionJob, signal: AbortSignal): Promise<ConverterPackLease>
  createWriter(job: ConversionJob, lease: ConverterPackLease, signal: AbortSignal): Promise<ManagedOutputWriter>
  convert(
    job: ConversionJob,
    lease: ConverterPackLease,
    writer: ManagedOutputWriter,
    options: { readonly signal: AbortSignal; onProgress(progress: number): boolean },
  ): Promise<VerifiedConversionOutput>
}

export interface ConversionJobRepository {
  create(input: NewConversionJob): ConversionJob
  getOwned(jobId: string, ownerUserId: string): ConversionJob | null
  claimNext(ownerUserId: string): ConversionJob | null
  transition(input: {
    jobId: string
    ownerUserId: string
    expectedEpoch: number
    expectedStatuses: ConversionJobStatus[]
    patch: ConversionJobTransition
  }): boolean
  retry(input: {
    jobId: string
    ownerUserId: string
    expectedEpoch: number
    expectedStatuses: ConversionJobStatus[]
  }): boolean
  interruptInFlight(ownerUserId: string): number
}

export type ConversionJobSubmission = Pick<
  NewConversionJob,
  'executionId' | 'sourceKind' | 'sourceId' | 'targetFormat' | 'preset'
>

export interface ConversionSubmissionReceipt {
  readonly accepted: true
  readonly jobId: string
  readonly epoch: 0
  readonly status: 'queued'
}

export interface ConversionJobRunner {
  start(): number
  submit(input: ConversionJobSubmission): ConversionSubmissionReceipt
  cancel(jobId: string): Promise<boolean>
  retry(jobId: string): boolean
  idle(): Promise<void>
  stop(): Promise<void>
}

export interface CreateConversionJobRunnerOptions {
  ownerUserId: string
  jobs: ConversionJobRepository
  runtime: ConversionJobRuntime
  id?: () => string
  now?: () => number
  onEvent?(event: ConversionJobEvent): void
}

interface PendingJob {
  readonly job: ConversionJob
  readonly resource: ConversionConcurrencyClass
}

interface ActiveJob extends PendingJob {
  readonly controller: AbortController
  status: 'downloading_component' | 'converting' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  lease?: ConverterPackLease
  writer?: ManagedOutputWriter
  writerAbortTask?: Promise<void>
  finalizationTail: Promise<void>
  done: Promise<void>
}

function errorCode(error: unknown): AppErrorCode {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && conversionFailureCodes.has(code as AppErrorCode)) return code as AppErrorCode
  }
  return 'CONVERSION_INTERRUPTED'
}

function validResource(value: ConversionConcurrencyClass): boolean {
  return value === 'document' || value === 'video' || value === 'other'
}

export function createConversionJobRunner(options: CreateConversionJobRunnerOptions): ConversionJobRunner {
  const makeId = options.id ?? randomUUID
  const now = options.now ?? Date.now
  const pending: PendingJob[] = []
  const active = new Map<string, ActiveJob>()
  const idleWaiters = new Set<() => void>()
  let started = false
  let stopping = false
  let stopped = false
  let pumpScheduled = false
  let pumping = false
  let stopTask: Promise<void> | undefined

  const current = (jobId: string, epoch: number, status: ConversionJobStatus): ConversionJob | null => {
    const job = options.jobs.getOwned(jobId, options.ownerUserId)
    return job?.epoch === epoch && job.status === status ? job : null
  }

  const publish = (jobId: string, epoch: number, status: ConversionJobStatus): void => {
    const job = current(jobId, epoch, status)
    if (!job) return
    const event: ConversionJobEvent = {
      jobId,
      ownerUserId: options.ownerUserId,
      epoch,
      status,
      progress: job.progress,
      ...(job.errorCode === undefined ? {} : { errorCode: job.errorCode }),
    }
    try {
      options.onEvent?.(Object.freeze(event))
    } catch {
      // Observers cannot change the durable job outcome.
    }
  }

  const cas = (
    jobId: string,
    epoch: number,
    expectedStatus: ConversionJobStatus,
    patch: ConversionJobTransition,
  ): boolean => options.jobs.transition({
    jobId,
    ownerUserId: options.ownerUserId,
    expectedEpoch: epoch,
    expectedStatuses: [expectedStatus],
    patch,
  })

  const guard = (job: ConversionJob, expectedStatus: ConversionJobStatus): boolean => (
    cas(job.id, job.epoch, expectedStatus, {})
  )

  const move = (
    running: ActiveJob,
    target: ActiveJob['status'],
    patch: Omit<ConversionJobTransition, 'status'> = {},
  ): boolean => {
    const source = running.status
    if (!(CONVERSION_JOB_TRANSITIONS[source] as readonly ConversionJobStatus[]).includes(target)) return false
    const changed = cas(running.job.id, running.job.epoch, source, { ...patch, status: target })
    if (changed) running.status = target
    return changed
  }

  const withFinalization = async <T>(running: ActiveJob, operation: () => Promise<T> | T): Promise<T> => {
    const previous = running.finalizationTail
    let release!: () => void
    running.finalizationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  const idleNow = (): boolean => pending.length === 0 && active.size === 0 && !pumpScheduled && !pumping

  const resolveIdle = (): void => {
    if (!idleNow()) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }

  const resourceAvailable = (resource: ConversionConcurrencyClass): boolean => {
    if (active.size >= 2) return false
    if (resource === 'other') return true
    return ![...active.values()].some((running) => running.resource === resource)
  }

  const abortWriter = (running: ActiveJob): Promise<void> => {
    if (running.writer === undefined) return Promise.resolve()
    running.writerAbortTask ??= running.writer.abort().catch(() => undefined)
    return running.writerAbortTask
  }

  const run = async (running: ActiveJob): Promise<void> => {
    let commitFailure: unknown
    try {
      const lease = await options.runtime.acquirePack(running.job, running.controller.signal)
      running.lease = lease
      if (!guard(running.job, 'downloading_component')) return

      const writer = await options.runtime.createWriter(running.job, lease, running.controller.signal)
      running.writer = writer
      if (!guard(running.job, 'downloading_component')) return
      if (!move(running, 'converting')) return
      publish(running.job.id, running.job.epoch, 'converting')

      const output = await options.runtime.convert(running.job, lease, writer, {
        signal: running.controller.signal,
        onProgress(progress) {
          if (!Number.isFinite(progress)) return false
          const bounded = Math.max(0, Math.min(94, Math.floor(progress)))
          const snapshot = current(running.job.id, running.job.epoch, 'converting')
          if (!snapshot) return false
          const next = Math.max(snapshot.progress, bounded)
          const changed = cas(running.job.id, running.job.epoch, 'converting', { progress: next })
          if (changed && next > snapshot.progress) publish(running.job.id, running.job.epoch, 'converting')
          return changed
        },
      })
      if (!move(running, 'verifying', { progress: 95 })) return
      publish(running.job.id, running.job.epoch, 'verifying')

      await withFinalization(running, async () => {
        if (!guard(running.job, 'verifying') || running.controller.signal.aborted) return
        try {
          await writer.commit(output)
        } catch (error) {
          commitFailure = error
          return
        }
        // Successful registration wins the race. Cancellation waits on this
        // section, so a cancelled state cannot retain this new artifact.
        if (move(running, 'completed', { progress: 100, endedAt: now() })) {
          publish(running.job.id, running.job.epoch, 'completed')
        }
      })
      if (commitFailure !== undefined) throw commitFailure
    } catch (error) {
      if (!running.controller.signal.aborted && activeStatuses.has(running.status)) {
        const code = errorCode(error)
        if (move(running, 'failed', { errorCode: code, endedAt: now() })) {
          publish(running.job.id, running.job.epoch, 'failed')
        }
      }
    } finally {
      await abortWriter(running)
      try {
        running.lease?.release()
      } catch {
        // Lease release is idempotent and cannot change a durable job state.
      }
    }
  }

  const startPending = (claimed: PendingJob): void => {
    const running: ActiveJob = {
      ...claimed,
      controller: new AbortController(),
      status: 'downloading_component',
      finalizationTail: Promise.resolve(),
      done: Promise.resolve(),
    }
    active.set(claimed.job.id, running)
    running.done = run(running).finally(() => {
      if (active.get(running.job.id) === running) active.delete(running.job.id)
      schedulePump()
      resolveIdle()
    })
    void running.done.catch(() => undefined)
  }

  const dispatch = (): void => {
    while (active.size < 2) {
      const index = pending.findIndex(({ job, resource }) => !active.has(job.id) && resourceAvailable(resource))
      if (index < 0) break
      const [claimed] = pending.splice(index, 1)
      if (claimed !== undefined) startPending(claimed)
    }
  }

  const failClaim = (job: ConversionJob): void => {
    if (cas(job.id, job.epoch, 'downloading_component', {
      status: 'failed',
      errorCode: 'CONVERSION_INTERRUPTED',
      endedAt: now(),
    })) publish(job.id, job.epoch, 'failed')
  }

  const pump = (): void => {
    if (!started || stopping || stopped || pumping) {
      resolveIdle()
      return
    }
    pumping = true
    try {
      while (true) {
        const job = options.jobs.claimNext(options.ownerUserId)
        if (!job) break
        let resource: ConversionConcurrencyClass
        try {
          resource = options.runtime.concurrencyClass(job)
          if (!validResource(resource)) throw new Error('Invalid conversion concurrency class')
        } catch {
          failClaim(job)
          continue
        }
        if (!guard(job, 'downloading_component')) continue
        pending.push({ job, resource })
        publish(job.id, job.epoch, 'downloading_component')
      }
      dispatch()
    } finally {
      pumping = false
      resolveIdle()
    }
  }

  function schedulePump(): void {
    if (!started || stopping || stopped || pumpScheduled) return
    pumpScheduled = true
    queueMicrotask(() => {
      pumpScheduled = false
      pump()
    })
  }

  const terminalizeActive = async (
    running: ActiveJob,
    target: 'cancelled' | 'interrupted',
    code: 'CONVERSION_CANCELLED' | 'CONVERSION_INTERRUPTED',
  ): Promise<boolean> => {
    running.controller.abort()
    if (running.status !== 'verifying') {
      let changed = false
      if (activeStatuses.has(running.status)) {
        changed = move(running, target, { errorCode: code, endedAt: now() })
        if (changed) publish(running.job.id, running.job.epoch, target)
      }
      await running.done
      return changed
    }
    await abortWriter(running)
    const accepted = await withFinalization(running, () => {
      if (!activeStatuses.has(running.status)) return false
      const changed = move(running, target, { errorCode: code, endedAt: now() })
      if (changed) publish(running.job.id, running.job.epoch, target)
      return changed
    })
    await running.done
    return accepted
  }

  const terminalizePending = (
    jobId: string,
    epoch: number,
    target: 'cancelled' | 'interrupted',
    code: 'CONVERSION_CANCELLED' | 'CONVERSION_INTERRUPTED',
  ): boolean => {
    const index = pending.findIndex(({ job }) => job.id === jobId && job.epoch === epoch)
    if (index < 0) return false
    const [claimed] = pending.splice(index, 1)
    if (!claimed) return false
    const changed = cas(claimed.job.id, claimed.job.epoch, 'downloading_component', {
      status: target,
      errorCode: code,
      endedAt: now(),
    })
    if (changed) publish(claimed.job.id, claimed.job.epoch, target)
    schedulePump()
    resolveIdle()
    return changed
  }

  return {
    start() {
      if (started || stopping || stopped) return 0
      const interrupted = options.jobs.interruptInFlight(options.ownerUserId)
      started = true
      schedulePump()
      return interrupted
    },

    submit(input) {
      if (stopping || stopped) throw Object.assign(new Error('The conversion runner is stopping.'), {
        code: 'CONVERSION_INTERRUPTED' as const,
      })
      const job = options.jobs.create({
        ...input,
        id: makeId(),
        ownerUserId: options.ownerUserId,
        status: 'queued',
        epoch: 0,
        progress: 0,
      })
      publish(job.id, job.epoch, 'queued')
      schedulePump()
      return { accepted: true, jobId: job.id, epoch: 0, status: 'queued' }
    },

    async cancel(jobId) {
      const job = options.jobs.getOwned(jobId, options.ownerUserId)
      if (!job) return false
      const running = active.get(jobId)
      if (running !== undefined && running.job.epoch === job.epoch && running.status === job.status) {
        return terminalizeActive(running, 'cancelled', 'CONVERSION_CANCELLED')
      }
      if (terminalizePending(jobId, job.epoch, 'cancelled', 'CONVERSION_CANCELLED')) return true
      if (job.status !== 'queued') return false
      const changed = cas(job.id, job.epoch, 'queued', {
        status: 'cancelled',
        errorCode: 'CONVERSION_CANCELLED',
        endedAt: now(),
      })
      if (changed) publish(job.id, job.epoch, 'cancelled')
      return changed
    },

    retry(jobId) {
      const job = options.jobs.getOwned(jobId, options.ownerUserId)
      if (!job || !retryableStatuses.has(job.status)) return false
      const changed = options.jobs.retry({
        jobId,
        ownerUserId: options.ownerUserId,
        expectedEpoch: job.epoch,
        expectedStatuses: [job.status],
      })
      if (!changed) return false
      publish(job.id, job.epoch + 1, 'queued')
      if (!active.has(jobId)) schedulePump()
      return true
    },

    idle() {
      if (idleNow()) return Promise.resolve()
      return new Promise<void>((resolve) => { idleWaiters.add(resolve) })
    },

    stop() {
      if (stopTask !== undefined) return stopTask
      stopTask = (async () => {
        stopping = true
        started = false
        const claimed = pending.splice(0)
        for (const { job } of claimed) {
          if (cas(job.id, job.epoch, 'downloading_component', {
            status: 'interrupted',
            errorCode: 'CONVERSION_INTERRUPTED',
            endedAt: now(),
          })) publish(job.id, job.epoch, 'interrupted')
        }
        await Promise.all([...active.values()].map((running) => (
          terminalizeActive(running, 'interrupted', 'CONVERSION_INTERRUPTED')
        )))
        stopped = true
        stopping = false
        resolveIdle()
      })()
      return stopTask
    },
  }
}
