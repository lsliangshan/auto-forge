import { toSafeAppError, type ProxySettings } from '@autoforge/shared'

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
  playwrightArgs: string[]
}

export interface NetworkProxyPort {
  initialize(settings: ProxySettings): Promise<void>
  transition(settings: ProxySettings): Promise<void>
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
  snapshot(): Promise<NetworkProxySnapshot>
}

interface ElectronProxyConfig {
  mode: 'direct' | 'fixed_servers'
  proxyRules?: string
  proxyBypassRules?: string
}

interface NetworkProxyConfig {
  electron: ElectronProxyConfig
  snapshot: NetworkProxySnapshot
}

function frozenArgs(args: string[]): string[] {
  return Object.freeze([...args]) as string[]
}

export function proxyConfigFor(settings: ProxySettings): NetworkProxyConfig {
  const bypassDomains = [...new Set(settings.bypassDomains)]
  const electronBypass = ['<local>', ...bypassDomains].join(',')
  const chromiumBypass = ['<local>', ...bypassDomains].join(';')

  if (!settings.enabled) {
    return {
      electron: { mode: 'direct' },
      snapshot: {
        enabled: false,
        bypassRules: electronBypass,
        playwrightArgs: frozenArgs([]),
      },
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
      playwrightArgs: frozenArgs([
        `--proxy-server=${rules}`,
        `--proxy-bypass-list=${chromiumBypass}`,
      ]),
    },
  }
}

function copySnapshot(snapshot: NetworkProxySnapshot): NetworkProxySnapshot {
  return Object.freeze({
    ...snapshot,
    playwrightArgs: frozenArgs(snapshot.playwrightArgs),
  })
}

export class NetworkProxyService implements NetworkProxyPort {
  private activeLeases = 0
  private drainWaiters = new Set<() => void>()
  private entryBarrier: Promise<void> = Promise.resolve()
  private releaseEntryBarrier: (() => void) | undefined
  private transitionQueue: Promise<void> = Promise.resolve()
  private current = proxyConfigFor({ enabled: false, bypassDomains: [] })
  private pendingTransitions = 0

  constructor(private readonly session: ProxySessionPort) {}

  initialize(settings: ProxySettings): Promise<void> {
    return this.transition(settings)
  }

  transition(settings: ProxySettings): Promise<void> {
    const candidate = proxyConfigFor(settings)
    this.pendingTransitions += 1
    this.closeEntryBarrier()

    const operation = this.transitionQueue.then(() => this.apply(candidate))
    this.transitionQueue = operation.catch(() => undefined)

    return operation.finally(() => {
      this.pendingTransitions -= 1
      if (this.pendingTransitions === 0) this.openEntryBarrier()
    })
  }

  async fetch(input: string | Request, init?: RequestInit): Promise<Response> {
    const release = await this.acquireLease()
    let response: Response
    try {
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

  async snapshot(): Promise<NetworkProxySnapshot> {
    while (true) {
      const barrier = this.entryBarrier
      await barrier
      if (barrier === this.entryBarrier && !this.releaseEntryBarrier) {
        return copySnapshot(this.current.snapshot)
      }
    }
  }

  private async acquireLease(): Promise<() => void> {
    while (true) {
      const barrier = this.entryBarrier
      await barrier
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
    this.entryBarrier = new Promise((resolve) => {
      this.releaseEntryBarrier = resolve
    })
  }

  private openEntryBarrier(): void {
    const release = this.releaseEntryBarrier
    this.releaseEntryBarrier = undefined
    release?.()
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
      try {
        await this.session.setProxy(previous.electron)
      } catch {
        // Best-effort rollback preserves the published previous generation.
      }
      try {
        await this.session.closeAllConnections()
      } catch {
        // The safe error below must not expose either Electron failure.
      }
      throw toSafeAppError({ code: 'NETWORK_PROXY_APPLY_FAILED' })
    }
  }
}
