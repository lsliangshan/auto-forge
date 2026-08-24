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

interface TabActivityState {
  latestRevision: number
  latestPhysicalInputRevision?: number
  latestActivityAt: number
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
  private readonly tabActivities = new Map<string, TabActivityState>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(options: BrowserManualResumeCoordinatorOptions) {
    this.unsubscribe = options.onActivity((activity) => {
      const previous = this.tabActivities.get(activity.tabId)
      if (!previous || activity.revision > previous.latestRevision) {
        this.tabActivities.set(activity.tabId, {
          latestRevision: activity.revision,
          latestPhysicalInputRevision: activity.kind === 'physical_input'
            ? activity.revision
            : previous?.latestPhysicalInputRevision,
          latestActivityAt: Date.now(),
        })
      }
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
      const tabActivity = this.tabActivities.get(input.tabId)
      const latestRevision = Math.max(input.baselineActivityRevision, tabActivity?.latestRevision ?? 0)
      const armed = tabActivity?.latestPhysicalInputRevision !== undefined
        && tabActivity.latestPhysicalInputRevision > input.baselineActivityRevision
      const waiter: Waiter = {
        input,
        resolve,
        reject,
        onAbort: () => this.finish(input.runId, failure('CANCELLED')),
        armed,
        latestRevision,
        invalidationRevision: latestRevision,
        promoting: false,
        promotionQueued: false,
        settled: false,
      }
      this.waiters.set(input.runId, waiter)
      input.signal?.addEventListener('abort', waiter.onAbort, { once: true })
      if (armed && tabActivity) {
        const elapsed = Math.max(0, Date.now() - tabActivity.latestActivityAt)
        this.scheduleQuietWindow(waiter, Math.max(0, QUIET_WINDOW_MS - elapsed))
      }
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
    this.tabActivities.clear()
  }

  private scheduleQuietWindow(waiter: Waiter, delayMs = QUIET_WINDOW_MS): void {
    if (waiter.settled) return
    if (waiter.quietTimer !== undefined) clearTimeout(waiter.quietTimer)
    waiter.quietTimer = setTimeout(() => {
      waiter.quietTimer = undefined
      void this.promote(waiter)
    }, delayMs)
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
