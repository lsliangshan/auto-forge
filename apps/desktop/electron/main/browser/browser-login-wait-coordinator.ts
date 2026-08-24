import { toSafeAppError, type AppError } from '@autoforge/shared'

export type BrowserAuthenticationState = 'authenticated' | 'required' | 'unknown'

export interface BrowserLoginWaitInput {
  readonly runId: string
  readonly tabId: string
  readonly signal?: AbortSignal
  readonly probe: () => Promise<BrowserAuthenticationState>
}

interface BrowserLoginWaitCoordinatorOptions {
  onPageInvalidated(listener: (tabId: string) => void): () => void
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface Waiter {
  readonly input: BrowserLoginWaitInput
  readonly startedAt: number
  readonly resolve: () => void
  readonly reject: (error: AppError) => void
  readonly onAbort: () => void
  eventTimer?: unknown
  fallbackTimer?: unknown
  probing: boolean
  probeQueued: boolean
  invalidationRevision: number
  settled: boolean
}

const EVENT_DEBOUNCE_MS = 500
const INITIAL_FALLBACK_MS = 3_000
const BACKOFF_AFTER_MS = 60_000
const BACKED_OFF_FALLBACK_MS = 10_000

function failure(code: 'CANCELLED' | 'CONFLICT'): AppError {
  return toSafeAppError({ code })
}

export class BrowserLoginWaitCoordinator {
  private readonly waiters = new Map<string, Waiter>()
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(options: BrowserLoginWaitCoordinatorOptions) {
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.unsubscribe = options.onPageInvalidated((tabId) => {
      for (const waiter of this.waiters.values()) {
        if (waiter.input.tabId !== tabId) continue
        waiter.invalidationRevision += 1
        this.scheduleEventProbe(waiter)
      }
    })
  }

  wait(input: BrowserLoginWaitInput): Promise<void> {
    if (this.disposed) return Promise.reject(failure('CANCELLED'))
    if (this.waiters.has(input.runId)) return Promise.reject(failure('CONFLICT'))
    if (input.signal?.aborted) return Promise.reject(failure('CANCELLED'))
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        input,
        startedAt: this.now(),
        resolve,
        reject,
        onAbort: () => this.finish(input.runId, failure('CANCELLED')),
        probing: false,
        probeQueued: false,
        invalidationRevision: 0,
        settled: false,
      }
      this.waiters.set(input.runId, waiter)
      input.signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.scheduleFallback(waiter)
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

  private scheduleEventProbe(waiter: Waiter): void {
    if (waiter.settled) return
    if (waiter.probing) {
      waiter.probeQueued = true
      return
    }
    if (waiter.eventTimer !== undefined) this.clearTimer(waiter.eventTimer)
    waiter.eventTimer = this.setTimer(() => {
      waiter.eventTimer = undefined
      void this.probe(waiter)
    }, EVENT_DEBOUNCE_MS)
  }

  private scheduleFallback(waiter: Waiter): void {
    if (waiter.settled) return
    if (waiter.fallbackTimer !== undefined) this.clearTimer(waiter.fallbackTimer)
    const elapsed = this.now() - waiter.startedAt
    const delay = elapsed >= BACKOFF_AFTER_MS ? BACKED_OFF_FALLBACK_MS : INITIAL_FALLBACK_MS
    waiter.fallbackTimer = this.setTimer(() => {
      waiter.fallbackTimer = undefined
      void this.probe(waiter)
    }, delay)
  }

  private async probe(waiter: Waiter): Promise<void> {
    if (waiter.settled) return
    if (waiter.probing) {
      waiter.probeQueued = true
      return
    }
    waiter.probing = true
    const invalidationRevision = waiter.invalidationRevision
    try {
      const state = await waiter.input.probe()
      if (waiter.settled) return
      if (state === 'authenticated') {
        if (waiter.probeQueued
          || waiter.eventTimer !== undefined
          || waiter.invalidationRevision !== invalidationRevision) return
        this.finish(waiter.input.runId)
        return
      }
      this.scheduleFallback(waiter)
    } catch (error) {
      const safe = toSafeAppError(error)
      if (safe.code === 'PAGE_CHANGED') this.scheduleFallback(waiter)
      else this.finish(waiter.input.runId, safe)
    } finally {
      waiter.probing = false
      if (!waiter.settled && waiter.probeQueued) {
        waiter.probeQueued = false
        this.scheduleEventProbe(waiter)
      }
    }
  }

  private finish(runId: string, error?: AppError): void {
    const waiter = this.waiters.get(runId)
    if (!waiter || waiter.settled) return
    waiter.settled = true
    this.waiters.delete(runId)
    if (waiter.eventTimer !== undefined) this.clearTimer(waiter.eventTimer)
    if (waiter.fallbackTimer !== undefined) this.clearTimer(waiter.fallbackTimer)
    waiter.input.signal?.removeEventListener('abort', waiter.onAbort)
    if (error) waiter.reject(error)
    else waiter.resolve()
  }
}
