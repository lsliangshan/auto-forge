import type { ReconcileProviderUsageOptions } from './provider-usage-reconciler.js'

const reconciliationDelaysMs = [1_000, 5_000, 30_000] as const

export interface ProviderUsageReconciliationPort {
  recoverInterrupted(options: ReconcileProviderUsageOptions): Promise<void>
  reconcileDue(options: ReconcileProviderUsageOptions): Promise<void>
}

export interface ProviderUsageReconciliationLoop {
  start(): void
  notifyUsageEnded(): void
  stop(): Promise<void>
}

class DefaultProviderUsageReconciliationLoop implements ProviderUsageReconciliationLoop {
  private readonly abortReason = new DOMException('Usage reconciliation stopped', 'AbortError')
  private readonly controller = new AbortController()
  private started = false
  private stopped = false
  private sequenceActive = false
  private sequenceStartedRounds = false
  private repeatSequence = false
  private sequence: Promise<void> = Promise.resolve()
  private tail: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private cancelTimer: (() => void) | undefined
  private firstFailure: unknown
  private hasFailure = false

  constructor(private readonly reconciler: ProviderUsageReconciliationPort) {}

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    void this.enqueue((options) => this.reconciler.recoverInterrupted(options)).then(() => {
      this.notifyUsageEnded()
    })
  }

  notifyUsageEnded(): void {
    if (this.stopped) return
    if (this.sequenceActive) {
      if (this.sequenceStartedRounds) this.repeatSequence = true
      return
    }
    this.beginSequence()
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true
      this.repeatSequence = false
      this.clearTimer()
      this.controller.abort(this.abortReason)
    }
    await this.sequence
    await this.tail
    if (this.hasFailure) throw this.firstFailure
  }

  private beginSequence(): void {
    this.sequenceActive = true
    this.sequenceStartedRounds = false
    this.sequence = this.runSequence().finally(() => {
      this.sequenceActive = false
      if (!this.stopped && this.repeatSequence) {
        this.repeatSequence = false
        this.beginSequence()
      }
    })
  }

  private async runSequence(): Promise<void> {
    for (const delayMs of reconciliationDelaysMs) {
      if (!await this.wait(delayMs)) return
      if (this.stopped) return
      this.sequenceStartedRounds = true
      await this.enqueue((options) => this.reconciler.reconcileDue(options))
    }
  }

  private wait(milliseconds: number): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    return new Promise((resolve) => {
      const finish = (elapsed: boolean) => {
        if (this.timer === handle) this.timer = undefined
        if (this.cancelTimer === cancel) this.cancelTimer = undefined
        resolve(elapsed)
      }
      const cancel = () => {
        clearTimeout(handle)
        finish(false)
      }
      const handle = setTimeout(() => finish(true), milliseconds)
      this.timer = handle
      this.cancelTimer = cancel
    })
  }

  private clearTimer(): void {
    this.cancelTimer?.()
    this.timer = undefined
    this.cancelTimer = undefined
  }

  private enqueue(
    operation: (options: ReconcileProviderUsageOptions) => Promise<void>,
  ): Promise<void> {
    const running = this.tail.then(async () => {
      this.controller.signal.throwIfAborted()
      await operation({ signal: this.controller.signal })
    })
    this.tail = running.catch((error: unknown) => {
      if (error === this.abortReason) return
      if (!this.hasFailure) {
        this.hasFailure = true
        this.firstFailure = error
      }
    })
    return this.tail
  }
}

export function createProviderUsageReconciliationLoop(
  reconciler: ProviderUsageReconciliationPort,
): ProviderUsageReconciliationLoop {
  return new DefaultProviderUsageReconciliationLoop(reconciler)
}
