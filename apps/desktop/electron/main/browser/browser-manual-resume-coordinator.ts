import { toSafeAppError, type AppError } from '@autoforge/shared'
import type { BrowserContinuationActivity } from './browser-continuation-types.js'

export interface BrowserManualResumeWaitInput {
  readonly runId: string
  readonly tabId: string
  readonly baselineActivityRevision: number
  readonly signal?: AbortSignal
  readonly promote: () => Promise<void>
}

interface BrowserManualResumeCoordinatorOptions {
  onActivity(listener: (activity: BrowserContinuationActivity) => void): () => void
}

interface Waiter {
  readonly input: BrowserManualResumeWaitInput
  readonly resolve: () => void
  readonly reject: (error: AppError) => void
  readonly onAbort: () => void
  armed: boolean
  latestRevision: number
  invalidationRevision: number
  promoting: boolean
  promotionQueued: boolean
  quietTimer?: ReturnType<typeof setTimeout>
  settled: boolean
}

const QUIET_WINDOW_MS = 5_000

function failure(code: 'CANCELLED' | 'CONFLICT'): AppError {
  return toSafeAppError({ code })
}

export class BrowserManualResumeCoordinator {
  private readonly waiters = new Map<string, Waiter>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(options: BrowserManualResumeCoordinatorOptions) {
    this.unsubscribe = options.onActivity((activity) => {
      for (const waiter of this.waiters.values()) {
        if (waiter.input.tabId !== activity.tabId || activity.revision <= waiter.latestRevision) continue
        waiter.latestRevision = activity.revision
        waiter.invalidationRevision = activity.revision
        if (!waiter.armed) {
          if (activity.kind !== 'physical_input') continue
          waiter.armed = true
        }
        if (waiter.promoting) {
          waiter.promotionQueued = true
          continue
        }
        this.scheduleQuietWindow(waiter)
      }
    })
  }

  wait(input: BrowserManualResumeWaitInput): Promise<void> {
    if (this.disposed) return Promise.reject(failure('CANCELLED'))
    if (this.waiters.has(input.runId)) return Promise.reject(failure('CONFLICT'))
    if (input.signal?.aborted) return Promise.reject(failure('CANCELLED'))
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        input,
        resolve,
        reject,
        onAbort: () => this.finish(input.runId, failure('CANCELLED')),
        armed: false,
        latestRevision: input.baselineActivityRevision,
        invalidationRevision: input.baselineActivityRevision,
        promoting: false,
        promotionQueued: false,
        settled: false,
      }
      this.waiters.set(input.runId, waiter)
      input.signal?.addEventListener('abort', waiter.onAbort, { once: true })
    })
  }

  cancel(runId: string): void {
    this.finish(runId, failure('CANCELLED'))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    for (const runId of [...this.waiters.keys()]) this.cancel(runId)
  }

  private scheduleQuietWindow(waiter: Waiter): void {
    if (waiter.settled) return
    if (waiter.quietTimer !== undefined) clearTimeout(waiter.quietTimer)
    waiter.quietTimer = setTimeout(() => {
      waiter.quietTimer = undefined
      void this.promote(waiter)
    }, QUIET_WINDOW_MS)
  }

  private async promote(waiter: Waiter): Promise<void> {
    if (waiter.settled) return
    if (waiter.promoting) {
      waiter.promotionQueued = true
      return
    }
    waiter.promoting = true
    waiter.promotionQueued = false
    const revision = waiter.invalidationRevision
    try {
      await waiter.input.promote()
      if (waiter.settled) return
      if (waiter.promotionQueued || waiter.invalidationRevision !== revision) return
      this.finish(waiter.input.runId)
    } catch (error) {
      if (waiter.settled) return
      const safe = toSafeAppError(error)
      if (safe.code === 'PAGE_CHANGED') this.scheduleQuietWindow(waiter)
      else this.finish(waiter.input.runId, safe)
    } finally {
      waiter.promoting = false
      if (!waiter.settled && waiter.promotionQueued) {
        waiter.promotionQueued = false
        this.scheduleQuietWindow(waiter)
      }
    }
  }

  private finish(runId: string, error?: AppError): void {
    const waiter = this.waiters.get(runId)
    if (!waiter || waiter.settled) return
    waiter.settled = true
    this.waiters.delete(runId)
    if (waiter.quietTimer !== undefined) clearTimeout(waiter.quietTimer)
    waiter.input.signal?.removeEventListener('abort', waiter.onAbort)
    if (error) waiter.reject(error)
    else waiter.resolve()
  }
}
