import { toSafeAppError, type AppError, type ProxySettings } from '@autoforge/shared'

export interface ProxySessionPort {
  setProxy(config: {
    mode: 'direct' | 'fixed_servers'
    proxyRules?: string
    proxyBypassRules?: string
  }): Promise<void>
  closeAllConnections(): Promise<void>
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
}

export interface NetworkProxySnapshot {
  enabled: boolean
  proxyRules?: string
  bypassRules: string
}

export interface NetworkTransportSnapshot {
  settings: ProxySettings
}

export interface NetworkProxyPort {
  initialize(settings: ProxySettings): Promise<void>
  transition(settings: ProxySettings): Promise<void>
  transitionOrFailClosed(settings: ProxySettings): Promise<void>
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
  snapshot(): Promise<NetworkProxySnapshot>
  withTransportLease<T>(
    operation: (snapshot: NetworkTransportSnapshot) => Promise<T>,
  ): Promise<T>
}

interface ElectronProxyConfig {
  mode: 'direct' | 'fixed_servers'
  proxyRules?: string
  proxyBypassRules?: string
}

interface NetworkProxyConfig {
  electron: ElectronProxyConfig
  snapshot: NetworkProxySnapshot
  settings: ProxySettings
}

function copyProxySettings(settings: ProxySettings): ProxySettings {
  return Object.freeze({
    ...settings,
    bypassDomains: Object.freeze([...settings.bypassDomains]) as string[],
  })
}

export function proxyConfigFor(settings: ProxySettings): NetworkProxyConfig {
  const frozenSettings = copyProxySettings(settings)
  const bypassDomains = [...new Set(settings.bypassDomains)]
  const electronBypass = ['<local>', ...bypassDomains].join(',')

  if (!settings.enabled) {
    return {
      electron: { mode: 'direct' },
      snapshot: {
        enabled: false,
        bypassRules: electronBypass,
      },
      settings: frozenSettings,
    }
  }

  const http = settings.httpProxy ?? settings.socketProxy ?? settings.httpsProxy
  const https = settings.httpsProxy ?? settings.socketProxy ?? settings.httpProxy
  const rules = [
    `http=${http}`,
    `https=${https}`,
    ...(settings.socketProxy ? [`socks=${settings.socketProxy}`] : []),
  ].join(';')

  return {
    electron: {
      mode: 'fixed_servers',
      proxyRules: rules,
      proxyBypassRules: electronBypass,
    },
    snapshot: {
      enabled: true,
      proxyRules: rules,
      bypassRules: electronBypass,
    },
    settings: frozenSettings,
  }
}

function copySnapshot(snapshot: NetworkProxySnapshot): NetworkProxySnapshot {
  return Object.freeze({ ...snapshot })
}

export class NetworkProxyService implements NetworkProxyPort {
  private activeLeases = 0
  private drainWaiters = new Set<() => void>()
  private entryBarrier: Promise<void> = Promise.resolve()
  private releaseEntryBarrier: (() => void) | undefined
  private rejectEntryBarrier: ((error: AppError) => void) | undefined
  private transitionQueue: Promise<void> = Promise.resolve()
  private current = proxyConfigFor({ enabled: false, bypassDomains: [] })
  private pendingTransitions = 0
  private terminalError: AppError | undefined

  constructor(private readonly session: ProxySessionPort) {}

  initialize(settings: ProxySettings): Promise<void> {
    return this.transition(settings)
  }

  transition(settings: ProxySettings): Promise<void> {
    return this.queueTransition(settings, false)
  }

  transitionOrFailClosed(settings: ProxySettings): Promise<void> {
    return this.queueTransition(settings, true)
  }

  private queueTransition(settings: ProxySettings, failClosed: boolean): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError)
    const candidate = proxyConfigFor(settings)
    this.pendingTransitions += 1
    this.closeEntryBarrier()

    const operation = this.transitionQueue.then(async () => {
      if (this.terminalError) throw this.terminalError
      try {
        await this.apply(candidate)
      } catch (error) {
        if (failClosed) {
          this.enterTerminalState(toSafeAppError({ code: 'NETWORK_PROXY_APPLY_FAILED' }))
        }
        throw error
      }
    })
    this.transitionQueue = operation.catch(() => undefined)

    return operation.finally(() => {
      this.pendingTransitions -= 1
      if (this.pendingTransitions === 0 && !this.terminalError) this.openEntryBarrier()
    })
  }

  async fetch(input: string | Request, init?: RequestInit): Promise<Response> {
    if (this.terminalError) throw this.terminalError
    const signal = init?.signal ?? undefined
    const release = await this.acquireLease(signal)
    let response: Response
    try {
      if (signal?.aborted) throw signal.reason
      response = await this.session.fetch(input, init)
    } catch (error) {
      release()
      throw error
    }

    if (!response.body) {
      release()
      return response
    }

    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read()
          if (result.done) {
            release()
            controller.close()
          } else {
            controller.enqueue(result.value)
          }
        } catch (error) {
          release()
          controller.error(error)
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason)
        } finally {
          release()
        }
      },
    })

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  async withTransportLease<T>(
    operation: (snapshot: NetworkTransportSnapshot) => Promise<T>,
  ): Promise<T> {
    if (this.terminalError) throw this.terminalError
    const release = await this.acquireLease()
    try {
      if (this.terminalError) throw this.terminalError
      return await operation(Object.freeze({
        settings: copyProxySettings(this.current.settings),
      }))
    } finally {
      release()
    }
  }

  async snapshot(): Promise<NetworkProxySnapshot> {
    if (this.terminalError) throw this.terminalError
    while (true) {
      const barrier = this.entryBarrier
      await barrier
      if (this.terminalError) throw this.terminalError
      if (barrier === this.entryBarrier && !this.releaseEntryBarrier) {
        return copySnapshot(this.current.snapshot)
      }
    }
  }

  private async acquireLease(signal?: AbortSignal): Promise<() => void> {
    while (true) {
      if (this.terminalError) throw this.terminalError
      if (signal?.aborted) throw signal.reason
      const barrier = this.entryBarrier
      let onAbort: (() => void) | undefined
      try {
        if (signal) {
          await Promise.race([
            barrier,
            new Promise<never>((_resolve, reject) => {
              onAbort = () => reject(signal.reason)
              signal.addEventListener('abort', onAbort, { once: true })
            }),
          ])
        } else {
          await barrier
        }
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort)
      }
      if (signal?.aborted) throw signal.reason
      if (this.terminalError) throw this.terminalError
      if (barrier !== this.entryBarrier || this.releaseEntryBarrier) continue

      this.activeLeases += 1
      let released = false
      return () => {
        if (released) return
        released = true
        this.activeLeases -= 1
        if (this.activeLeases !== 0) return

        const waiters = [...this.drainWaiters]
        this.drainWaiters.clear()
        for (const resolve of waiters) resolve()
      }
    }
  }

  private closeEntryBarrier(): void {
    if (this.releaseEntryBarrier) return
    const barrier = new Promise<void>((resolve, reject) => {
      this.releaseEntryBarrier = resolve
      this.rejectEntryBarrier = reject
    })
    void barrier.catch(() => undefined)
    this.entryBarrier = barrier
  }

  private openEntryBarrier(): void {
    const release = this.releaseEntryBarrier
    this.releaseEntryBarrier = undefined
    this.rejectEntryBarrier = undefined
    release?.()
  }

  private enterTerminalState(error: AppError): void {
    if (this.terminalError) return
    this.terminalError = error
    const reject = this.rejectEntryBarrier
    this.releaseEntryBarrier = undefined
    this.rejectEntryBarrier = undefined
    reject?.(error)
  }

  private waitForLeasesToDrain(): Promise<void> {
    if (this.activeLeases === 0) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.add(resolve))
  }

  private async apply(candidate: NetworkProxyConfig): Promise<void> {
    await this.waitForLeasesToDrain()
    const previous = this.current
    try {
      await this.session.setProxy(candidate.electron)
      await this.session.closeAllConnections()
      this.current = candidate
    } catch {
      let restored = true
      try {
        await this.session.setProxy(previous.electron)
      } catch {
        restored = false
      }
      try {
        await this.session.closeAllConnections()
      } catch {
        restored = false
      }
      const error = toSafeAppError({ code: 'NETWORK_PROXY_APPLY_FAILED' })
      if (!restored) this.enterTerminalState(error)
      throw error
    }
  }
}
