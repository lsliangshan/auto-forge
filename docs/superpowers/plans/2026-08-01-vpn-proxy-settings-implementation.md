# AutoForge VPN Proxy Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, real-time VPN proxy settings that route every current AutoForge-owned external HTTP/HTTPS path through one Main-process proxy configuration while preserving in-flight work and explicit bypass rules.

**Architecture:** Add a strict shared `ProxySettings` contract and a Main-only `NetworkProxyService` that owns Electron session proxy state, request generations, and immutable Playwright snapshots. Wire model providers and the safe media downloader through the service, apply saved settings before startup recovery/window creation, and let the settings UI submit only normalized structured values.

**Tech Stack:** Electron 43.1.1, TypeScript 6.0.3, Zod 4.4.3, Vue 3.5.40, Pinia, Element Plus 2.14.3, Playwright Chromium 1.61.1, Vitest 4.1.10

## Global Constraints

- The UI labels are exactly `http_proxy`, `https_proxy`, and `socket_proxy`.
- Proxy authentication is not supported; reject usernames and passwords.
- `http_proxy` and `https_proxy` accept only explicit-port `http://` or `https://` URLs.
- `socket_proxy` accepts only explicit-port `socks4://` or `socks5://` URLs.
- When proxying is enabled, at least one address is required and all external HTTP/HTTPS traffic must have a proxy route; never append `direct://` fallback.
- `<local>` is always bypassed and cannot be removed; user bypass rules accept exact domains, wildcard domains, IP literals, and CIDR.
- Ordinary in-flight requests finish on the old generation; new managed requests wait until the transition completes.
- Existing Playwright contexts keep their immutable proxy snapshot until the workflow closes; new contexts read the latest snapshot.
- Disabling proxying retains the entered values but applies Electron `{ mode: 'direct' }`.
- `shell.openExternal()` and other external applications are outside the proxy scope.
- Preserve TLS verification, CSP, navigation guards, sender validation, credential redaction, media URL/address validation, redirect limits, size limits, and MIME checks.
- Do not set process-level `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, or `NO_PROXY` variables.
- Do not add a runtime dependency or a proxy test button.
- Every production behavior follows RED → GREEN; run the named focused test before and after each implementation step.
- Stage only the files listed by each task; preserve unrelated user changes.

---

### Task 1: Define and normalize the shared proxy contract

**Files:**
- Create: `packages/shared/src/proxy-settings.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/src/services/desktop-api.ts`

**Interfaces:**
- Produces: `ProxySettings`, `proxySettingsSchema`, `normalizeProxySettings(value)`, and `parseProxyBypassText(value)` from `@autoforge/shared`.
- Produces: `AppErrorCode` member `NETWORK_PROXY_APPLY_FAILED` and Renderer copy `代理应用失败，已保留原配置`.
- Changes: `AppSettings.proxy` is required; `AppSettingsPatch.proxy` remains optional through `.partial()`.
- Consumes: browser-compatible `URL`; no Node-only imports in the shared package.

- [ ] **Step 1: Add failing contract tests**

Extend `packages/shared/src/contracts.test.ts` with exact settings and invalid-input coverage:

```ts
import {
  normalizeProxySettings,
  parseProxyBypassText,
  proxySettingsSchema,
} from './index'

const proxy = {
  enabled: true,
  httpProxy: 'http://127.0.0.1:7890',
  httpsProxy: 'https://proxy.example.com:8443',
  socketProxy: 'socks5://127.0.0.1:7891',
  bypassDomains: ['example.com', '*.internal.example', '10.0.0.0/8'],
}

expect(proxySettingsSchema.parse(proxy)).toEqual(proxy)
expect(appSettingsSchema.parse({ ...settings, proxy }).proxy).toEqual(proxy)
expect(appErrorCodeSchema.parse('NETWORK_PROXY_APPLY_FAILED'))
  .toBe('NETWORK_PROXY_APPLY_FAILED')

expect(() => proxySettingsSchema.parse({ enabled: true, bypassDomains: [] })).toThrow()
expect(() => proxySettingsSchema.parse({
  enabled: true,
  httpProxy: 'http://user:pass@127.0.0.1:7890',
  bypassDomains: [],
})).toThrow()
expect(() => proxySettingsSchema.parse({
  enabled: true,
  socketProxy: 'http://127.0.0.1:7891',
  bypassDomains: [],
})).toThrow()
expect(() => proxySettingsSchema.parse({
  enabled: true,
  httpsProxy: 'http://127.0.0.1',
  bypassDomains: [],
})).toThrow()

expect(parseProxyBypassText('Example.com,\n*.internal.example\nexample.com'))
  .toEqual(['example.com', '*.internal.example'])
expect(normalizeProxySettings({
  enabled: false,
  httpProxy: ' http://LOCALHOST:7890 ',
  bypassDomains: [' Example.com ', 'example.com'],
})).toEqual({
  enabled: false,
  httpProxy: 'http://localhost:7890',
  bypassDomains: ['example.com'],
})
```

Update every existing `AppSettings` fixture in this file to include:

```ts
proxy: { enabled: false, bypassDomains: [] },
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
pnpm test -- packages/shared/src/contracts.test.ts
```

Expected: the new exports, required `AppSettings.proxy`, and safe error code do not exist.

- [ ] **Step 3: Implement the strict shared schema and normalizers**

Create `packages/shared/src/proxy-settings.ts` with these exported shapes and rules:

```ts
import { z } from 'zod'

const domainPattern = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
function canonicalProxyUrl(
  value: string,
  protocols: ReadonlySet<string>,
): string | undefined {
  try {
    const trimmed = value.trim()
    const parsed = new URL(trimmed)
    if (!protocols.has(parsed.protocol)
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.port === ''
      || (parsed.pathname !== '' && parsed.pathname !== '/')
      || parsed.search !== ''
      || parsed.hash !== '') return undefined
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return undefined
  }
}

const httpProxySchema = z.string().superRefine((value, context) => {
  if (!canonicalProxyUrl(value, new Set(['http:', 'https:']))) {
    context.addIssue({ code: 'custom', message: 'Invalid HTTP proxy URL' })
  }
})

const socketProxySchema = z.string().superRefine((value, context) => {
  if (!canonicalProxyUrl(value, new Set(['socks4:', 'socks5:']))) {
    context.addIssue({ code: 'custom', message: 'Invalid SOCKS proxy URL' })
  }
})

export const proxySettingsSchema = z.object({
  enabled: z.boolean(),
  httpProxy: httpProxySchema.optional(),
  httpsProxy: httpProxySchema.optional(),
  socketProxy: socketProxySchema.optional(),
  bypassDomains: z.array(z.string()).max(256),
}).strict().superRefine((value, context) => {
  if (value.enabled && !value.httpProxy && !value.httpsProxy && !value.socketProxy) {
    context.addIssue({ code: 'custom', path: ['enabled'], message: 'At least one proxy is required' })
  }
})

export type ProxySettings = z.infer<typeof proxySettingsSchema>
```

Implement `parseProxyBypassText` by splitting on `/[,\n]/u`, trimming, lowercasing host patterns, rejecting protocol/port/path syntax, validating exact/wildcard domains plus IP/CIDR forms, and preserving first occurrence. Validate IP literals through a temporary `http://` URL and require a canonical hostname match; for CIDR, split the suffix, require an integer prefix in `0..32` for IPv4 or `0..128` for IPv6, and validate the address half with the same helper. Implement `normalizeProxySettings` by canonicalizing present addresses, removing blank optional addresses, normalizing the bypass array through `parseProxyBypassText(value.bypassDomains.join('\n'))`, and finally parsing with `proxySettingsSchema`.

Export the module from `packages/shared/src/index.ts`. Add `proxy: proxySettingsSchema` to `appSettingsSchema`. Add the safe error to `packages/shared/src/errors.ts`:

```ts
'NETWORK_PROXY_APPLY_FAILED',

NETWORK_PROXY_APPLY_FAILED: 'The network proxy configuration could not be applied.',
```

Add the exact Chinese mapping to `apps/desktop/src/services/desktop-api.ts`:

```ts
NETWORK_PROXY_APPLY_FAILED: '代理应用失败，已保留原配置',
```

- [ ] **Step 4: Run the contract test and verify GREEN**

Run the Step 2 command again.

Expected: all shared contract tests pass, including strict proxy validation and normalization.

- [ ] **Step 5: Commit the shared contract slice**

```bash
git add packages/shared/src/proxy-settings.ts packages/shared/src/index.ts packages/shared/src/desktop-api.ts packages/shared/src/errors.ts packages/shared/src/contracts.test.ts apps/desktop/src/services/desktop-api.ts
git commit -m "feat: define vpn proxy settings contract"
```

---

### Task 2: Implement the Main-process proxy coordinator

**Files:**
- Create: `apps/desktop/electron/main/network/network-proxy-service.ts`
- Create: `apps/desktop/electron/main/network/network-proxy-service.test.ts`

**Interfaces:**
- Consumes: normalized `ProxySettings` from Task 1 and an Electron-session-shaped `ProxySessionPort`.
- Produces: `NetworkProxySnapshot`, `NetworkProxyPort`, `NetworkProxyService`, and `proxyConfigFor(settings)`.
- Produces: `NetworkProxyPort.fetch(input, init)` that holds a request lease until the response body finishes, errors, or is cancelled.
- Produces: immutable Playwright `args` per snapshot without exposing raw Electron config to Renderer.

- [ ] **Step 1: Write failing proxy rule and direct-mode tests**

Create `network-proxy-service.test.ts` with a fake session and these assertions:

```ts
const enabled = normalizeProxySettings({
  enabled: true,
  httpProxy: 'http://127.0.0.1:7890',
  socketProxy: 'socks5://127.0.0.1:7891',
  bypassDomains: ['example.com'],
})

expect(proxyConfigFor(enabled)).toEqual({
  electron: {
    mode: 'fixed_servers',
    proxyRules: [
      'http=http://127.0.0.1:7890',
      'https=socks5://127.0.0.1:7891',
      'socks=socks5://127.0.0.1:7891',
    ].join(';'),
    proxyBypassRules: '<local>,example.com',
  },
  snapshot: {
    enabled: true,
    proxyRules: expect.any(String),
    bypassRules: '<local>,example.com',
    playwrightArgs: [
      '--proxy-server=http=http://127.0.0.1:7890;https=socks5://127.0.0.1:7891;socks=socks5://127.0.0.1:7891',
      '--proxy-bypass-list=<local>;example.com',
    ],
  },
})

expect(proxyConfigFor({ enabled: false, bypassDomains: [] })).toEqual({
  electron: { mode: 'direct' },
  snapshot: {
    enabled: false,
    bypassRules: '<local>',
    playwrightArgs: [],
  },
})
```

Also assert that only `httpsProxy` covers both HTTP and HTTPS, only `socketProxy` covers HTTP/HTTPS/SOCKS, bypass rules are deduplicated, and none of the generated strings contains `direct://`.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
pnpm test -- apps/desktop/electron/main/network/network-proxy-service.test.ts
```

Expected: the module and exported functions do not exist.

- [ ] **Step 3: Implement deterministic rule generation**

Create exact public interfaces:

```ts
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
```

Use exact route selection:

```ts
const http = settings.httpProxy ?? settings.socketProxy ?? settings.httpsProxy
const https = settings.httpsProxy ?? settings.socketProxy ?? settings.httpProxy
const rules = [
  `http=${http}`,
  `https=${https}`,
  ...(settings.socketProxy ? [`socks=${settings.socketProxy}`] : []),
].join(';')
```

Always prepend `<local>` to the Electron comma-separated bypass list and the Chromium semicolon-separated bypass list. Freeze/copy snapshot arrays before returning them so callers cannot mutate service state.

- [ ] **Step 4: Add failing transition and request-lease tests**

Add a deferred response body test:

```ts
const firstBody = deferred<ReadableStreamReadResult<Uint8Array>>()
session.fetch.mockResolvedValue(new Response(new ReadableStream({
  pull(controller) {
    return firstBody.promise.then((result) => {
      if (result.done) controller.close()
      else controller.enqueue(result.value)
    })
  },
})))

const response = await service.fetch('https://example.com')
const reader = response.body!.getReader()
const transition = service.transition(nextSettings)
const queuedFetch = service.fetch('https://after.example')

expect(session.setProxy).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'fixed_servers' }))
expect(session.fetch).toHaveBeenCalledTimes(1)

firstBody.resolve({ done: true, value: undefined })
await reader.read()
await transition
await queuedFetch

expect(session.setProxy).toHaveBeenLastCalledWith(proxyConfigFor(nextSettings).electron)
expect(session.closeAllConnections).toHaveBeenCalledOnce()
expect(session.fetch).toHaveBeenCalledTimes(2)
```

Add tests for body `cancel()`, body read error, body-less response, two serialized transitions, and `setProxy`/`closeAllConnections` failure restoring the previous config and throwing `NETWORK_PROXY_APPLY_FAILED` without leaking addresses.

- [ ] **Step 5: Run the focused test and verify the new cases are RED**

Run the Step 2 command again.

Expected: rule generation passes after Step 3, while transition gating and response-body lease cases fail because the coordinator is incomplete.

- [ ] **Step 6: Implement generations, response wrapping, transition rollback, and initialization**

Implement `NetworkProxyService` with:

```ts
private activeLeases = 0
private drainWaiters = new Set<() => void>()
private entryBarrier: Promise<void> = Promise.resolve()
private releaseEntryBarrier: (() => void) | undefined
private transitionQueue: Promise<void> = Promise.resolve()
private current = proxyConfigFor({ enabled: false, bypassDomains: [] })
```

Required behavior:

- `fetch` awaits `entryBarrier`, increments `activeLeases`, calls `session.fetch`, and wraps `response.body` in a new `ReadableStream`.
- `snapshot` awaits the same `entryBarrier` and returns a defensive copy, so a new automation context started during transition cannot capture the old generation.
- The wrapper releases exactly once on end, read error, or cancel; a body-less response releases immediately.
- The wrapped `Response` preserves the original status, status text, and headers.
- If `session.fetch` rejects, release before rethrowing the original safe provider handling path.
- `transition` chains onto `transitionQueue`, closes the entry barrier, waits until `activeLeases === 0`, applies the candidate with `setProxy`, calls `closeAllConnections`, publishes the candidate snapshot, and reopens the barrier.
- If either Electron call fails, best-effort reapply the previous Electron config, best-effort close connections, reopen the old generation, and throw `toSafeAppError({ code: 'NETWORK_PROXY_APPLY_FAILED' })`.
- `initialize` applies the saved config before any lease is accepted and does not silently downgrade to direct.

- [ ] **Step 7: Run the proxy service tests and verify GREEN**

Run the Step 2 command again.

Expected: every config, lease, transition, cancellation, serialization, and rollback test passes.

- [ ] **Step 8: Commit the proxy coordinator**

```bash
git add apps/desktop/electron/main/network/network-proxy-service.ts apps/desktop/electron/main/network/network-proxy-service.test.ts
git commit -m "feat: coordinate electron network proxy"
```

---

### Task 3: Make settings persistence transactional and wire startup/model traffic

**Files:**
- Modify: `apps/desktop/electron/main/settings/settings-service.ts`
- Modify: `apps/desktop/electron/main/settings/settings-service.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/index.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Modify: `apps/desktop/tests/components/workbench.test.ts`

**Interfaces:**
- Consumes: `NetworkProxyPort` from Task 2.
- Produces: `SettingsService.preview(patch): AppSettings` and `SettingsService.commit(settings): AppSettings` while preserving `update(patch)`.
- Changes: `ApplicationRuntimeOptions.networkProxy` is required in production/test composition.
- Changes: runtime `recover()` initializes the saved proxy before any recovery network work and before `createMainWindow`.
- Produces: OpenRouter and DeepSeek instances whose `fetch` dependency is `networkProxy.fetch`.

- [ ] **Step 1: Write failing settings normalization and preview/commit tests**

Update the `defaults` fixture and every expected settings object in `settings-service.test.ts` with:

```ts
proxy: { enabled: false, bypassDomains: [] },
```

Add:

```ts
it('normalizes legacy settings to a disabled proxy without persisting preview', () => {
  const repository = settingsRepository({ theme: 'dark' })
  const service = new SettingsService(repository, defaults)
  const candidate = service.preview({
    proxy: {
      enabled: true,
      httpProxy: ' http://LOCALHOST:7890 ',
      bypassDomains: [' Example.com '],
    },
  })

  expect(service.get().proxy).toEqual({ enabled: false, bypassDomains: [] })
  expect(candidate.proxy).toEqual({
    enabled: true,
    httpProxy: 'http://localhost:7890',
    bypassDomains: ['example.com'],
  })
  expect(service.commit(candidate)).toEqual(candidate)
  expect(service.get()).toEqual(candidate)
})
```

- [ ] **Step 2: Run the settings test and verify RED**

Run:

```bash
pnpm test -- apps/desktop/electron/main/settings/settings-service.test.ts
```

Expected: defaults lack `proxy` and `preview`/`commit` do not exist.

- [ ] **Step 3: Implement candidate settings and legacy proxy defaults**

Add `proxy?: unknown` to the internal legacy shape. Normalize it with:

```ts
proxy: normalizeProxySettings(
  typeof stored.proxy === 'object' && stored.proxy !== null
    ? stored.proxy as ProxySettings
    : this.defaults.proxy,
),
```

Split the current update behavior without changing callers:

```ts
preview(patch: AppSettingsPatch): AppSettings {
  return this.normalize({ ...this.get(), ...patch })
}

commit(settings: AppSettings): AppSettings {
  const normalized = this.normalize(settings)
  this.repository.set(settingsKey, normalized)
  return normalized
}

update(patch: AppSettingsPatch): AppSettings {
  return this.commit(this.preview(patch))
}
```

Run the Step 2 command again and verify GREEN.

- [ ] **Step 4: Write failing application tests for startup order, provider fetch injection, commit, and rollback**

Extend the shared application test setup with a fake network port:

```ts
const networkProxy = {
  initialize: vi.fn().mockResolvedValue(undefined),
  transition: vi.fn().mockResolvedValue(undefined),
  fetch: vi.fn(globalThis.fetch),
  snapshot: vi.fn(async () => ({ enabled: false, bypassRules: '<local>', playwrightArgs: [] })),
}
```

Pass it as `networkProxy` to every `createApplicationRuntime` setup. Add tests:

```ts
it('initializes the saved proxy before runtime recovery continues', async () => {
  const runtime = createApplicationRuntime(options({ networkProxy }))
  await runtime.recover()
  expect(networkProxy.initialize).toHaveBeenCalledWith({ enabled: false, bypassDomains: [] })
  expect(networkProxy.initialize.mock.invocationCallOrder[0])
    .toBeLessThan(recoveryProbe.mock.invocationCallOrder[0])
})

it('applies proxy changes before committing settings', async () => {
  const runtime = createApplicationRuntime(options({ networkProxy }))
  const next = await runtime.services.settings.update({
    proxy: { enabled: true, httpProxy: 'http://127.0.0.1:7890', bypassDomains: [] },
  })
  expect(networkProxy.transition).toHaveBeenCalledWith(next.proxy)
  expect(runtime.services.settings.get().proxy).toEqual(next.proxy)
})

it('retains the old setting when proxy application fails', async () => {
  networkProxy.transition.mockRejectedValueOnce(toSafeAppError({ code: 'NETWORK_PROXY_APPLY_FAILED' }))
  const runtime = createApplicationRuntime(options({ networkProxy }))
  await expect(runtime.services.settings.update({
    proxy: { enabled: true, socketProxy: 'socks5://127.0.0.1:7891', bypassDomains: [] },
  })).rejects.toMatchObject({ code: 'NETWORK_PROXY_APPLY_FAILED' })
  expect(runtime.services.settings.get().proxy).toEqual({ enabled: false, bypassDomains: [] })
})
```

Add a provider-construction assertion by letting the fake `networkProxy.fetch` return the model/credential fixture and verifying both OpenRouter and DeepSeek validation calls reach that fake instead of `globalThis.fetch`.

- [ ] **Step 5: Run the application-focused tests and verify RED**

Run:

```bash
pnpm test -- apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/ipc/register-ipc.test.ts
```

Expected: runtime options do not accept the network port, recovery does not initialize it, and settings update persists without transition.

- [ ] **Step 6: Wire the proxy service through Main composition**

In `application.ts`, require:

```ts
networkProxy: NetworkProxyPort
```

Add the proxy default to `SettingsService` construction:

```ts
proxy: { enabled: false, bypassDomains: [] },
```

Construct both providers with the managed fetch:

```ts
new OpenRouterProvider({ credential: secretStore, fetch: options.networkProxy.fetch.bind(options.networkProxy) })
new DeepSeekProvider({ credential: secretStore, fetch: options.networkProxy.fetch.bind(options.networkProxy) })
```

At the beginning of the returned runtime `recover()` method, call:

```ts
await options.networkProxy.initialize(settings.get().proxy)
```

Replace the settings update service with candidate/apply/commit/rollback behavior:

```ts
update: async (patch) => {
  const previous = settings.get()
  const candidate = settings.preview(patch)
  if (JSON.stringify(previous.proxy) === JSON.stringify(candidate.proxy)) {
    return settings.commit(candidate)
  }
  await options.networkProxy.transition(candidate.proxy)
  try {
    return settings.commit(candidate)
  } catch {
    await options.networkProxy.transition(previous.proxy)
    throw failure('INTERNAL_ERROR')
  }
},
```

In `index.ts`, import Electron `net`, create one service after `app.whenReady()` is available inside async `initialize`, and pass the default session adapter:

```ts
const networkProxy = new NetworkProxyService({
  setProxy: (config) => session.defaultSession.setProxy(config),
  closeAllConnections: () => session.defaultSession.closeAllConnections(),
  fetch: (input, init) => net.fetch(input, init),
})
```

Make `initialize` async and pass `networkProxy` into `createApplicationRuntime`. The existing `startDesktopApplication` already awaits an async initializer and runtime recovery; do not add another startup abstraction.

- [ ] **Step 7: Update all test settings fixtures and verify GREEN**

Add `proxy: { enabled: false, bypassDomains: [] }` to application, IPC, and Renderer `AppSettings` fixtures. Run the Step 5 command and:

```bash
pnpm test -- apps/desktop/tests/components/workbench.test.ts
```

Expected: Main composition tests and existing settings UI tests pass with the required new contract.

- [ ] **Step 8: Commit transactional settings and startup wiring**

```bash
git add apps/desktop/electron/main/settings/settings-service.ts apps/desktop/electron/main/settings/settings-service.test.ts apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/index.ts apps/desktop/electron/main/ipc/register-ipc.test.ts apps/desktop/tests/components/workbench.test.ts
git commit -m "feat: apply proxy settings before network startup"
```

---

### Task 4: Route safe media downloads through the managed Electron session

**Files:**
- Modify: `apps/desktop/electron/main/media/safe-download.ts`
- Modify: `apps/desktop/electron/main/media/safe-download.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Changes: `SafeMediaDownloaderDependencies.request` becomes `fetch(input, init): Promise<Response>`.
- Consumes: `NetworkProxyPort.fetch` from Task 2.
- Preserves: `SafeMediaDownloader.download(url, destination, options)` public API and all current safe error behavior.
- Preserves: DNS public-address preflight on every initial/redirect target before the managed session sees the URL.

- [ ] **Step 1: Add a failing managed-fetch transport test without deleting existing safety tests**

Add a minimal fetch harness beside the current request harness:

```ts
const fetch = vi.fn(async () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3]))
    controller.close()
  },
}), {
  status: 200,
  headers: { 'content-type': 'image/png', 'content-length': '3' },
}))
const downloader = new SafeMediaDownloader({
  resolveHost: async () => [PUBLIC_IPV4],
  fetch,
})
const sink = new RecordingSink()

await expect(downloader.download('https://provider.example/result.png', sink, { maxBytes: 10 }))
  .resolves.toEqual({ byteSize: 3, contentType: 'image/png' })
expect(fetch).toHaveBeenCalledWith('https://provider.example/result.png', expect.objectContaining({
  method: 'GET',
  redirect: 'manual',
  signal: expect.any(AbortSignal),
}))
expect(sink.bytes()).toEqual(Buffer.from([1, 2, 3]))
```

Add explicit managed-fetch cases for redirect revalidation, private redirect rejection before the second fetch, declared/streamed oversize, total timeout, first-byte timeout, destination backpressure, destination failure, abort/cancel, malformed status/body, and response-body read error. Keep the expected fixed `MEDIA_DOWNLOAD_FAILED` object.

- [ ] **Step 2: Run safe-download tests and verify RED**

Run:

```bash
pnpm test -- apps/desktop/electron/main/media/safe-download.test.ts
```

Expected: `SafeMediaDownloader` does not accept a `fetch` dependency and still calls Node HTTPS.

- [ ] **Step 3: Replace only the transport boundary with fetch while retaining validation**

Change dependencies to:

```ts
export interface SafeMediaDownloaderDependencies {
  resolveHost(hostname: string): Promise<readonly LookupAddress[]>
  fetch(input: string, init: RequestInit): Promise<Response>
  setTimer(callback: () => void, milliseconds: number): TimerHandle
  clearTimer(handle: TimerHandle): void
}
```

Default `fetch` remains `globalThis.fetch` for isolated Node tests, while application composition injects the managed Electron fetch. Remove `httpsRequest`, `ClientRequest`, socket, and pinned lookup code only after the new tests are RED.

For each validated hop:

```ts
const controller = new AbortController()
const response = await this.dependencies.fetch(url.href, {
  method: 'GET',
  redirect: 'manual',
  signal: controller.signal,
})
```

Required ordering:

1. Canonicalize URL.
2. Resolve hostname and reject non-public answers.
3. Start connect timer before fetch; clear it when response headers arrive.
4. Handle redirects with `Location`, decrement the existing redirect budget, and return to step 1.
5. Reject non-2xx and invalid/missing body.
6. Validate content length before reading.
7. Start first-byte timer; clear it on first chunk.
8. Read through `response.body.getReader()`, enforce streamed byte limit, and write to the caller-owned Node destination with existing drain/backpressure semantics.
9. On timeout, destination error/close, response read error, or cancellation, abort the controller and cancel the reader; never end or destroy the destination.
10. Resolve only after the final asynchronous destination write callback succeeds.

Do not weaken canonical URL or address classification helpers. The proxy endpoint is user-trusted transport, but the target hostname must still pass the same public-address checks before each request.

- [ ] **Step 4: Run all safe-download tests and verify GREEN**

Run the Step 2 command again.

Expected: all pre-existing URL, DNS, redirect, timeout, size, backpressure, and cleanup tests plus the managed-fetch cases pass.

- [ ] **Step 5: Inject the managed transport and verify application wiring**

In `application.ts` construct:

```ts
downloader: new SafeMediaDownloader({
  fetch: options.networkProxy.fetch.bind(options.networkProxy),
}),
```

Extend `application.test.ts` so a URL-based image generation fixture completes only when the fake `networkProxy.fetch` returns the download response, and assert the URL was never sent through `globalThis.fetch`.

Run:

```bash
pnpm test -- apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/chat/media-generation-orchestrator.test.ts
```

Expected: managed proxy fetch is the authoritative production media transport.

- [ ] **Step 6: Commit the media transport slice**

```bash
git add apps/desktop/electron/main/media/safe-download.ts apps/desktop/electron/main/media/safe-download.test.ts apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts
git commit -m "feat: proxy safe media downloads"
```

---

### Task 5: Give each automation browser an immutable proxy snapshot

**Files:**
- Modify: `apps/desktop/electron/main/browser/browser-capability.ts`
- Modify: `apps/desktop/electron/main/browser/browser-capability.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Consumes: `NetworkProxySnapshot` and `networkProxy.snapshot()` from Task 2.
- Changes: `BrowserCapabilityServiceOptions.proxySnapshot?: () => Promise<NetworkProxySnapshot>`.
- Changes: internal `BrowserLauncher.launchPersistentContext` options include optional `args: string[]`.
- Preserves: every existing navigation, permission, isolation, cleanup, and profile behavior.

- [ ] **Step 1: Write failing snapshot tests**

Add a fake-launcher test:

```ts
let snapshot = {
  enabled: true,
  proxyRules: 'http=http://127.0.0.1:7890;https=http://127.0.0.1:7890',
  bypassRules: '<local>,example.com',
  playwrightArgs: [
    '--proxy-server=http=http://127.0.0.1:7890;https=http://127.0.0.1:7890',
    '--proxy-bypass-list=<local>;example.com',
  ],
}
const launches: string[][] = []
const service = new BrowserCapabilityService({
  authorization,
  proxySnapshot: async () => snapshot,
  launcher: fakeLauncher((options) => launches.push(options.args ?? [])),
})

await service.open(contextOne, 'https://example.com')
snapshot = { enabled: false, bypassRules: '<local>', playwrightArgs: [] }
await service.url(contextOne)
await service.open(contextTwo, 'https://example.com')

expect(launches).toEqual([
  [
    '--proxy-server=http=http://127.0.0.1:7890;https=http://127.0.0.1:7890',
    '--proxy-bypass-list=<local>;example.com',
  ],
  [],
])
```

Also assert that changing the provider does not close `contextOne`, reload its page, or mutate the captured first launch options.

- [ ] **Step 2: Run the browser test and verify RED**

Run:

```bash
pnpm test -- apps/desktop/electron/main/browser/browser-capability.test.ts
```

Expected: `proxySnapshot` and `args` are absent.

- [ ] **Step 3: Add snapshot-at-context-creation behavior**

Extend the exact launcher option type:

```ts
options: {
  headless: boolean
  executablePath: string
  serviceWorkers: 'block'
  args?: string[]
}
```

Store a default provider:

```ts
this.proxySnapshot = options.proxySnapshot
  ?? (async () => ({ enabled: false, bypassRules: '<local>', playwrightArgs: [] }))
```

Inside `createOwner`, read exactly once and copy args:

```ts
const proxy = await this.proxySnapshot()
context = await this.launcher.launchPersistentContext(profilePath, {
  headless: this.headless,
  executablePath,
  serviceWorkers: 'block',
  ...(proxy.playwrightArgs.length ? { args: [...proxy.playwrightArgs] } : {}),
})
```

In `application.ts`, pass:

```ts
proxySnapshot: () => options.networkProxy.snapshot(),
```

- [ ] **Step 4: Run browser and application tests and verify GREEN**

Run:

```bash
pnpm test -- apps/desktop/electron/main/browser/browser-capability.test.ts apps/desktop/electron/main/application.test.ts
```

Expected: new contexts use the current snapshot, old contexts remain alive, and all existing browser security tests pass.

- [ ] **Step 5: Commit browser snapshot support**

```bash
git add apps/desktop/electron/main/browser/browser-capability.ts apps/desktop/electron/main/browser/browser-capability.test.ts apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts
git commit -m "feat: proxy new automation browsers"
```

---

### Task 6: Add the VPN proxy settings UI and complete verification

**Files:**
- Modify: `apps/desktop/src/views/SettingsView.vue`
- Modify: `apps/desktop/tests/components/workbench.test.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`

**Interfaces:**
- Consumes: `ProxySettings`, `normalizeProxySettings`, and `parseProxyBypassText` from Task 1.
- Consumes: existing `settings.update({ proxy })` queue and `NETWORK_PROXY_APPLY_FAILED` display mapping.
- Produces: exact test IDs `proxy-enabled`, `http-proxy`, `https-proxy`, `socket-proxy`, and `proxy-bypass`.
- Preserves: draft values when Main rejects a transition and retains addresses when proxying is disabled.

- [ ] **Step 1: Write failing component tests for rendering, normalization, disabling, and failure**

Add the disabled proxy to `createApi().settings.get`. Then add:

```ts
it('shows and saves normalized VPN proxy settings without per-character updates', async () => {
  const api = createApi()
  vi.mocked(api.settings.update).mockImplementation(async (patch) => ({
    ...await api.settings.get(),
    ...patch,
  }))
  const { wrapper } = await mountApp('/settings', api)

  expect(wrapper.text()).toContain('VPN 代理')
  expect(wrapper.text()).toContain('http_proxy')
  expect(wrapper.text()).toContain('https_proxy')
  expect(wrapper.text()).toContain('socket_proxy')

  await wrapper.get('[data-testid="http-proxy"] input').setValue(' http://LOCALHOST:7890 ')
  expect(api.settings.update).not.toHaveBeenCalled()
  await wrapper.get('[data-testid="proxy-bypass"] textarea').setValue('Example.com\n*.internal.example')
  await wrapper.get('[data-testid="proxy-enabled"]').trigger('click')

  await vi.waitFor(() => expect(api.settings.update).toHaveBeenCalledWith({
    proxy: {
      enabled: true,
      httpProxy: 'http://localhost:7890',
      bypassDomains: ['example.com', '*.internal.example'],
    },
  }))
})

it('keeps entered addresses when proxying is disabled', async () => {
  const { wrapper, api } = await mountApp('/settings', apiWithEnabledProxy())
  await wrapper.get('[data-testid="proxy-enabled"]').trigger('click')
  await vi.waitFor(() => expect(api.settings.update).toHaveBeenCalledWith({
    proxy: expect.objectContaining({ enabled: false, httpProxy: 'http://127.0.0.1:7890' }),
  }))
  expect((wrapper.get('[data-testid="http-proxy"] input').element as HTMLInputElement).value)
    .toBe('http://127.0.0.1:7890')
})

it('keeps the draft and shows the safe error when Main rejects proxy application', async () => {
  const api = createApi()
  vi.mocked(api.settings.update).mockRejectedValue({
    code: 'NETWORK_PROXY_APPLY_FAILED',
    message: 'unsafe raw address',
  })
  const { wrapper } = await mountApp('/settings', api)
  await wrapper.get('[data-testid="http-proxy"] input').setValue('http://127.0.0.1:7890')
  await wrapper.get('[data-testid="proxy-enabled"]').trigger('click')
  await vi.waitFor(() => expect(wrapper.text()).toContain('代理应用失败，已保留原配置'))
  expect(wrapper.text()).not.toContain('unsafe raw address')
  expect((wrapper.get('[data-testid="http-proxy"] input').element as HTMLInputElement).value)
    .toBe('http://127.0.0.1:7890')
})
```

Add local-validation tests for enabled-without-address and credential-bearing URLs, asserting `api.settings.update` is not called and exact field copy is rendered.

- [ ] **Step 2: Run the component test and verify RED**

Run:

```bash
pnpm test -- apps/desktop/tests/components/workbench.test.ts
```

Expected: the VPN proxy section and test IDs are absent.

- [ ] **Step 3: Implement the focused SettingsView draft**

In `SettingsView.vue`, add:

```ts
const proxyDraft = reactive({
  enabled: false,
  httpProxy: '',
  httpsProxy: '',
  socketProxy: '',
  bypassText: '',
})
const proxyValidationError = ref('')

watch(() => settings.settings?.proxy, (proxy) => {
  if (!proxy) return
  proxyDraft.enabled = proxy.enabled
  proxyDraft.httpProxy = proxy.httpProxy ?? ''
  proxyDraft.httpsProxy = proxy.httpsProxy ?? ''
  proxyDraft.socketProxy = proxy.socketProxy ?? ''
  proxyDraft.bypassText = proxy.bypassDomains.join('\n')
}, { immediate: true, deep: true })
```

Implement one submission function:

```ts
async function saveProxyDraft() {
  proxyValidationError.value = ''
  try {
    const proxy = normalizeProxySettings({
      enabled: proxyDraft.enabled,
      ...(proxyDraft.httpProxy.trim() ? { httpProxy: proxyDraft.httpProxy } : {}),
      ...(proxyDraft.httpsProxy.trim() ? { httpsProxy: proxyDraft.httpsProxy } : {}),
      ...(proxyDraft.socketProxy.trim() ? { socketProxy: proxyDraft.socketProxy } : {}),
      bypassDomains: parseProxyBypassText(proxyDraft.bypassText),
    })
    await settings.update({ proxy })
  } catch {
    proxyValidationError.value = proxyDraft.enabled
      && !proxyDraft.httpProxy.trim()
      && !proxyDraft.httpsProxy.trim()
      && !proxyDraft.socketProxy.trim()
      ? '启用代理时至少填写一个代理地址'
      : '请输入不包含用户名、密码和路径的有效代理地址'
  }
}
```

Do not catch Main failures in this function after `settings.update`; the store already converts them to its safe top-level error. Distinguish bypass parsing locally and render `代理忽略域名格式不正确`.

Add a `settings-section` between model and appearance with an `el-switch`, three `el-input` values, one `el-input type="textarea"`, the exact labels/test IDs, status copy, `<local>` explanation, and external-browser scope note. Trigger `saveProxyDraft` on switch `change` and field `blur`, not on `input`.

- [ ] **Step 4: Verify GREEN and the existing Pinia rejection behavior**

Run the Step 2 command again. The rejection test must prove the existing store updates `this.settings` only after fulfilled IPC and leaves the authoritative setting plus the local draft unchanged after rejection; do not add a proxy-specific queue.

Expected: all new UI tests and all pre-existing workbench tests pass.

- [ ] **Step 5: Run strict IPC and complete automated verification**

Run:

```bash
pnpm test -- apps/desktop/electron/main/ipc/register-ipc.test.ts
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected:

- IPC rejects extra proxy keys and malformed proxy URLs.
- The complete Vitest suite passes.
- TypeScript/Vue type checking exits 0.
- Electron production build exits 0.
- `git diff --check` reports no whitespace errors.

- [ ] **Step 6: Perform real Electron proxy verification**

Start the real app using the repository command:

```bash
pnpm dev
```

Use a temporary local observable HTTP CONNECT proxy bound to an explicit loopback port. In the app:

1. Enter that endpoint in `http_proxy`, leave the other fields empty, enable VPN proxy, and save.
2. From a Main-only diagnostic that does not print credentials or content, check `session.defaultSession.resolveProxy('https://openrouter.ai/')`; expect the configured `PROXY` route, never `DIRECT`.
3. Check an entered bypass domain; expect `DIRECT`.
4. Start a model-list or credential-validation request and confirm the local proxy receives the CONNECT destination.
5. Start an automation browser context and confirm its launched command/options contain the same proxy generation.
6. Disable VPN proxy without active requests; verify `resolveProxy('https://openrouter.ai/')` returns `DIRECT` and later requests do not reach the local proxy.
7. Repeat a proxy change during a controlled delayed request; verify the delayed request finishes, a new request waits, and only the new request uses the new proxy.

Do not include API keys, prompts, response bodies, proxy URLs, or user data in captured evidence. Stop only the explicitly identified temporary proxy and dev processes after verification.

- [ ] **Step 7: Commit the UI and final test slice**

```bash
git add apps/desktop/src/views/SettingsView.vue apps/desktop/tests/components/workbench.test.ts apps/desktop/electron/main/ipc/register-ipc.test.ts
git commit -m "feat: add vpn proxy settings ui"
```

---

## Final Review Checklist

- [ ] Compare every changed file with `docs/superpowers/specs/2026-08-01-vpn-proxy-settings-design.md`.
- [ ] Confirm every production function added in this plan has a test that was observed failing before implementation.
- [ ] Confirm enabled proxy configs contain no `direct://` fallback and always cover HTTP and HTTPS.
- [ ] Confirm `<local>` appears in Electron and Playwright bypass rules even when the user list is empty.
- [ ] Confirm OpenRouter, DeepSeek, media downloads, Renderer/default session, and newly created automation browser contexts each use the unified proxy path.
- [ ] Confirm `shell.openExternal()` remains explicitly out of scope.
- [ ] Confirm ordinary in-flight requests are not interrupted and active Playwright contexts are not recreated.
- [ ] Confirm disabling retains addresses and applies `direct` before settings persistence returns.
- [ ] Confirm no proxy address, API key, prompt, provider body, absolute media path, or user content reaches logs or errors.
- [ ] Confirm focused tests, full tests, typecheck, build, real Electron proxy verification, and `git diff --check` all passed before claiming completion.
