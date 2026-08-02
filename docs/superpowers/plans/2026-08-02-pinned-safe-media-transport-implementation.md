# IP-Pinned Safe Media Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the media downloader's DNS-preflight-plus-hostname-fetch gap with a Main-only transport that connects every direct, CONNECT, and SOCKS origin request to a validated numeric IP while retaining the original TLS and HTTP hostname.

**Architecture:** Extend `NetworkProxyService` with an immutable settings lease, split public-address and media-route decisions into a pure Main module, and introduce a one-request `PinnedMediaTransport` over Node `https.request`. `SafeMediaDownloader` keeps all URL, redirect, header, byte, timeout, backpressure, destination, and error policy, but performs DNS, route selection, connection, redirects, and body cleanup inside one proxy-generation lease.

**Tech Stack:** Electron 43.1.1, Node HTTPS/TLS/stream APIs, TypeScript 6.0.3, Vitest 4.1.10, `https-proxy-agent@9.1.0`, `socks-proxy-agent@10.1.0`, pnpm 11.15.0

## Global Constraints

- Remote media remains HTTPS-only, without URL credentials, explicit origin ports, fragments, unsafe authority syntax, or relaxed redirect validation.
- Add exactly `https-proxy-agent@9.1.0` and `socks-proxy-agent@10.1.0` as exact runtime dependencies of `@autoforge/desktop`; add no other runtime dependency.
- Proxy authentication, PAC, environment/system proxy discovery, custom CA product settings, disabled TLS verification, and cross-download connection pooling remain unsupported.
- Direct, HTTP CONNECT, HTTPS CONNECT, SOCKS4, and SOCKS5 origin destinations must be numeric IPs validated for the same request; no component may resolve or delegate the original origin hostname after validation.
- Preserve the original hostname for TLS SNI, origin certificate verification, and the HTTP `Host` header. For an IP-literal origin, omit SNI and let TLS verify the IP literal.
- Validate every DNS answer before the first connection; one restricted, malformed, or empty answer rejects the hop before direct or proxy connection.
- Deduplicate validated addresses in resolver order. Pre-header connection failures may try only the remaining validated addresses under the same connect and total timeout budgets; never retry after response headers.
- For HTTPS media, proxy priority is `httpsProxy -> socketProxy -> httpProxy`; disabled proxy, domain bypass, and matching IP/CIDR bypass use direct transport.
- An IP/CIDR bypass may connect directly only to validated addresses that match that rule. `<local>` never overrides public-address validation.
- Freeze one defensive `ProxySettings` copy for the complete download, including DNS, redirects, response streaming, destination writes, cancellation, and cleanup.
- Proxy transitions wait for active media transport leases; terminal proxy state rejects a new media download before DNS or connection work.
- Preserve redirect count, connect/first-byte/total timeouts, raw-header validation, MIME normalization, byte limit, `Content-Length` consistency, backpressure, pending write completion, caller-owned destination semantics, and cleanup behavior.
- DNS, direct, CONNECT, SOCKS, TLS, response, body, destination, and cancellation failures expose only the fixed `MEDIA_DOWNLOAD_FAILED` application error; no URL, proxy URL, IP, body, credential, or user content appears in error text or logs.
- Production TLS uses the default trust store and default certificate verification. A locally trusted CA and non-443 port may be injected only through a non-Renderer test dependency.
- Every production behavior follows RED -> GREEN. Run the focused test before and after each implementation step and commit only the files named by that task.

---

## File Map

- `apps/desktop/electron/main/network/network-proxy-service.ts`: owns proxy generations, immutable transport snapshots, and lease lifetime.
- `apps/desktop/electron/main/network/network-proxy-service.test.ts`: proves snapshot immutability, transition gating, error release, and terminal rejection.
- `apps/desktop/electron/main/media/media-route.ts`: validates/deduplicates DNS answers, matches domain/IP/CIDR bypass rules, and selects one media route plus allowed numeric candidates.
- `apps/desktop/electron/main/media/media-route.test.ts`: pure address, bypass, route-priority, and mixed-answer tests.
- `apps/desktop/electron/main/media/pinned-media-transport.ts`: owns one Node HTTPS request, direct/proxy agent, socket, response adapter, abort, and teardown.
- `apps/desktop/electron/main/media/pinned-media-transport.test.ts`: deterministic request/abort/cleanup unit tests.
- `apps/desktop/electron/main/media/pinned-media-transport.integration.test.ts`: real loopback TLS, HTTP/HTTPS CONNECT, SOCKS4, and SOCKS5 evidence under the Electron test runtime.
- `apps/desktop/electron/main/media/test-fixtures/pinned-media-test-key.pem`: test-only private key for isolated loopback TLS listeners.
- `apps/desktop/electron/main/media/test-fixtures/pinned-media-test-cert.pem`: test-only certificate trusted explicitly by the transport integration test.
- `apps/desktop/electron/main/media/safe-download.ts`: retains download policy and consumes the frozen settings, numeric route selection, and pinned transport.
- `apps/desktop/electron/main/media/safe-download.test.ts`: retains all safety regressions and adds rebinding, bypass, address fallback, redirect reroute, and lease coverage.
- `apps/desktop/electron/main/application.ts`: composes the real transport and transport lease; no longer supplies `networkProxy.fetch` to media downloads.
- `apps/desktop/electron/main/application.test.ts`: proves real composition uses the lease and transport seam without ambient `fetch`.
- `apps/desktop/package.json` and `pnpm-lock.yaml`: exact runtime dependency declarations and lock graph.
- `apps/desktop/scripts/verify-packaged-native.mjs`: loads both proxy-agent packages from `app.asar` in the packaged Electron executable in addition to the existing SQLite probe.

---

### Task 1: Add an immutable proxy-generation transport lease

**Files:**
- Modify: `apps/desktop/electron/main/network/network-proxy-service.ts`
- Modify: `apps/desktop/electron/main/network/network-proxy-service.test.ts`

**Interfaces:**
- Consumes: normalized `ProxySettings` already passed to `initialize()` and `transition()`.
- Produces: `NetworkTransportSnapshot` and `NetworkProxyPort.withTransportLease<T>(operation)`.
- Guarantee: `operation` sees one deeply frozen defensive settings copy and the existing transition barrier remains closed until its returned promise settles.

- [ ] **Step 1: Write failing lease tests**

Add tests that capture the snapshot, try to mutate both the object and `bypassDomains`, and hold an operation open while a transition is queued:

```ts
it('holds an immutable transport settings snapshot until the operation settles', async () => {
  const session = fakeSession()
  const service = new NetworkProxyService(session)
  const active = proxySettings(7890)
  await service.initialize(active)
  const operationDone = deferred<void>()
  let captured!: NetworkTransportSnapshot

  const lease = service.withTransportLease(async (snapshot) => {
    captured = snapshot
    await operationDone.promise
  })
  await flushMicrotasks()

  expect(Object.isFrozen(captured)).toBe(true)
  expect(Object.isFrozen(captured.settings)).toBe(true)
  expect(Object.isFrozen(captured.settings.bypassDomains)).toBe(true)
  expect(() => { captured.settings.enabled = false }).toThrow()
  expect(() => { captured.settings.bypassDomains.push('mutated.example') }).toThrow()

  const transition = service.transition(proxySettings(7891))
  await flushMicrotasks()
  expect(session.setProxy).not.toHaveBeenLastCalledWith(
    proxyConfigFor(proxySettings(7891)).electron,
  )

  operationDone.resolve()
  await lease
  await transition
  expect(session.setProxy).toHaveBeenLastCalledWith(
    proxyConfigFor(proxySettings(7891)).electron,
  )
})
```

Add a rejection test that proves `finally` releases the lease:

```ts
it('releases a transport lease when the operation rejects', async () => {
  const service = new NetworkProxyService(fakeSession())
  const secretError = new Error('operation detail')

  await expect(service.withTransportLease(async () => {
    throw secretError
  })).rejects.toBe(secretError)

  await expect(service.transition(proxySettings(7892))).resolves.toBeUndefined()
})
```

Extend the existing rollback-failure terminal-state test with an operation spy:

```ts
const operation = vi.fn(async () => undefined)
await expect(service.withTransportLease(operation)).rejects.toMatchObject({
  code: 'NETWORK_PROXY_APPLY_FAILED',
})
expect(operation).not.toHaveBeenCalled()
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/network/network-proxy-service.test.ts
```

Expected: FAIL because `NetworkTransportSnapshot` and `withTransportLease()` do not exist.

- [ ] **Step 3: Retain a frozen normalized settings copy in every proxy config**

Extend the public port and internal config:

```ts
export interface NetworkTransportSnapshot {
  settings: ProxySettings
}

export interface NetworkProxyPort {
  initialize(settings: ProxySettings): Promise<void>
  transition(settings: ProxySettings): Promise<void>
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
  snapshot(): Promise<NetworkProxySnapshot>
  withTransportLease<T>(
    operation: (snapshot: NetworkTransportSnapshot) => Promise<T>,
  ): Promise<T>
}

interface NetworkProxyConfig {
  electron: ElectronProxyConfig
  snapshot: NetworkProxySnapshot
  settings: ProxySettings
}
```

Use one defensive copier for both stored and leased values:

```ts
function copyProxySettings(settings: ProxySettings): ProxySettings {
  return Object.freeze({
    ...settings,
    bypassDomains: Object.freeze([...settings.bypassDomains]) as string[],
  })
}
```

In `proxyConfigFor(settings)`, create `const frozenSettings = copyProxySettings(settings)` and return it as `settings: frozenSettings` in both enabled and disabled branches. Continue deriving Electron and Chromium rules from the same normalized input.

Because `proxyConfigFor()` is directly asserted with exact object equality, extend each existing expected config in `network-proxy-service.test.ts` with the matching normalized `settings` member. Do not weaken those assertions to partial matches.

- [ ] **Step 4: Implement the lease operation with the existing atomic gate**

Add this method without changing `acquireLease()` or transition ordering:

```ts
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
```

The second terminal check protects the narrow interval after barrier entry; `acquireLease()` remains the authority for atomically selecting the current generation.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the Step 2 command again.

Expected: every proxy service test passes, including the existing managed-fetch lease tests.

- [ ] **Step 6: Commit the lease slice**

```bash
git add apps/desktop/electron/main/network/network-proxy-service.ts apps/desktop/electron/main/network/network-proxy-service.test.ts
git commit -m "feat: lease immutable media proxy settings"
```

---

### Task 2: Validate addresses and select media routes without network side effects

**Files:**
- Create: `apps/desktop/electron/main/media/media-route.ts`
- Create: `apps/desktop/electron/main/media/media-route.test.ts`
- Modify: `apps/desktop/electron/main/media/safe-download.ts`
- Modify: `apps/desktop/electron/main/media/safe-download.test.ts`

**Interfaces:**
- Consumes: `ProxySettings` and `node:dns` `LookupAddress` results.
- Produces: `MediaRoute`, `MediaRouteSelection`, `validatedPublicAddresses(addresses)`, and `selectMediaRoute(settings, hostname, addresses)`.
- Guarantee: route selection is pure, preserves resolver order, and returns only numeric destinations allowed for the selected route.

- [ ] **Step 1: Write failing public-address and route tests**

Create `media-route.test.ts` with a compact address helper and these cases:

```ts
import type { LookupAddress } from 'node:dns'
import { normalizeProxySettings } from '@autoforge/shared'
import { describe, expect, it } from 'vitest'
import { selectMediaRoute, validatedPublicAddresses } from './media-route.js'

const address = (value: string, family: 4 | 6): LookupAddress => ({
  address: value,
  family,
})

it('deduplicates public answers in resolver order', () => {
  expect(validatedPublicAddresses([
    address('93.184.216.34', 4),
    address('2606:4700:4700::1111', 6),
    address('93.184.216.34', 4),
  ])).toEqual([
    address('93.184.216.34', 4),
    address('2606:4700:4700::1111', 6),
  ])
})

it.each([
  [],
  [address('127.0.0.1', 4)],
  [address('93.184.216.34', 4), address('10.0.0.1', 4)],
  [address('2001:db8::1', 6)],
])('rejects empty, restricted, and mixed DNS answers before routing', (answers) => {
  expect(() => validatedPublicAddresses(answers)).toThrow()
})
```

Cover disabled mode, priority, and domain bypass:

```ts
const candidates = validatedPublicAddresses([
  address('93.184.216.34', 4),
  address('1.1.1.1', 4),
])
const settings = normalizeProxySettings({
  enabled: true,
  httpProxy: 'http://proxy.test:8080',
  httpsProxy: 'https://proxy.test:8443',
  socketProxy: 'socks5://proxy.test:1080',
  bypassDomains: ['exact.example', '*.wild.example'],
})

expect(selectMediaRoute(settings, 'media.example', candidates)).toEqual({
  route: { kind: 'http-connect', proxyUrl: 'https://proxy.test:8443' },
  destinationAddresses: candidates,
})
expect(selectMediaRoute(settings, 'exact.example', candidates).route)
  .toEqual({ kind: 'direct' })
expect(selectMediaRoute(settings, 'child.wild.example', candidates).route)
  .toEqual({ kind: 'direct' })
expect(selectMediaRoute(settings, 'wild.example', candidates).route)
  .toEqual({ kind: 'http-connect', proxyUrl: 'https://proxy.test:8443' })
```

Cover IP and CIDR bypass confinement:

```ts
const ipBypass = normalizeProxySettings({
  enabled: true,
  httpProxy: 'http://proxy.test:8080',
  bypassDomains: ['93.184.216.34', '1.1.1.0/24'],
})

expect(selectMediaRoute(ipBypass, 'media.example', candidates)).toEqual({
  route: { kind: 'direct' },
  destinationAddresses: [
    address('93.184.216.34', 4),
    address('1.1.1.1', 4),
  ],
})
```

Add separate settings fixtures with only `socketProxy` and only `httpProxy` to prove the fallback route kinds are `socks` and `http-connect` respectively.

- [ ] **Step 2: Run the new route test and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/media/media-route.test.ts
```

Expected: FAIL because `media-route.ts` does not exist.

- [ ] **Step 3: Extract address validation from the downloader**

Move the existing IPv4 parsing, IPv6 byte conversion, prefix matching, IANA special-prefix constants, and prohibited-address checks from `safe-download.ts` into `media-route.ts` without changing the prefix tables. Export this strict wrapper:

```ts
export function validatedPublicAddresses(
  addresses: readonly LookupAddress[],
): readonly LookupAddress[] {
  if (addresses.length === 0) throw new Error('Invalid media address set')
  const seen = new Set<string>()
  const validated: LookupAddress[] = []
  for (const answer of addresses) {
    if (
      typeof answer !== 'object'
      || answer === null
      || (answer.family !== 4 && answer.family !== 6)
      || isIP(answer.address) !== answer.family
      || (answer.family === 4
        ? prohibitedIpv4(answer.address)
        : prohibitedIpv6(answer.address))
    ) throw new Error('Invalid media address set')
    const key = `${answer.family}:${answer.address.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    validated.push({ address: answer.address, family: answer.family })
  }
  return Object.freeze(validated.map((answer) => Object.freeze({ ...answer })))
}
```

Keep all thrown text inside Main and let `SafeMediaDownloader` catch it and return `MEDIA_DOWNLOAD_FAILED`; never log it.

- [ ] **Step 4: Implement exact domain, IP, CIDR, and route selection**

Define the route contract and selector:

```ts
export type MediaRoute =
  | { kind: 'direct' }
  | { kind: 'http-connect'; proxyUrl: string }
  | { kind: 'socks'; proxyUrl: string }

export interface MediaRouteSelection {
  route: MediaRoute
  destinationAddresses: readonly LookupAddress[]
}

export function selectMediaRoute(
  settings: ProxySettings,
  hostname: string,
  addresses: readonly LookupAddress[],
): MediaRouteSelection {
  if (!settings.enabled) {
    return { route: { kind: 'direct' }, destinationAddresses: addresses }
  }

  const normalizedHost = hostname.toLowerCase()
  const domainBypass = settings.bypassDomains.some((rule) => {
    if (isIP(rule) !== 0 || rule.includes('/')) return false
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2)
      return normalizedHost !== suffix && normalizedHost.endsWith(`.${suffix}`)
    }
    return normalizedHost === rule
  })
  if (domainBypass) {
    return { route: { kind: 'direct' }, destinationAddresses: addresses }
  }

  const matchingAddresses = addresses.filter((candidate) => (
    settings.bypassDomains.some((rule) => addressMatchesRule(candidate, rule))
  ))
  if (matchingAddresses.length > 0) {
    return { route: { kind: 'direct' }, destinationAddresses: matchingAddresses }
  }

  if (settings.httpsProxy) {
    return {
      route: { kind: 'http-connect', proxyUrl: settings.httpsProxy },
      destinationAddresses: addresses,
    }
  }
  if (settings.socketProxy) {
    return {
      route: { kind: 'socks', proxyUrl: settings.socketProxy },
      destinationAddresses: addresses,
    }
  }
  if (settings.httpProxy) {
    return {
      route: { kind: 'http-connect', proxyUrl: settings.httpProxy },
      destinationAddresses: addresses,
    }
  }
  throw new Error('Enabled proxy has no media route')
}
```

Implement `addressMatchesRule` with the already extracted byte/prefix helpers: exact IP requires equal address family and bytes; CIDR parses its suffix, requires `0..32` or `0..128`, and calls `matchesPrefix`. Domain strings return false.

Use this implementation so an invalid or cross-family rule can never become a match:

```ts
function addressMatchesRule(candidate: LookupAddress, rule: string): boolean {
  const separator = rule.lastIndexOf('/')
  const ruleAddress = separator === -1 ? rule : rule.slice(0, separator)
  const family = isIP(ruleAddress)
  if (family === 0 || family !== candidate.family) return false

  const candidateBytes = family === 4
    ? parseIpv4(candidate.address)
    : ipv6Bytes(candidate.address)
  const ruleBytes = family === 4 ? parseIpv4(ruleAddress) : ipv6Bytes(ruleAddress)
  if (!candidateBytes || !ruleBytes) return false

  const maximumBits = family === 4 ? 32 : 128
  const bits = separator === -1 ? maximumBits : Number(rule.slice(separator + 1))
  if (!Number.isInteger(bits) || bits < 0 || bits > maximumBits) return false
  return matchesPrefix(
    Uint8Array.from(candidateBytes),
    Uint8Array.from(ruleBytes),
    bits,
  )
}
```

- [ ] **Step 5: Rewire existing downloader address tests to the extracted function**

Import `validatedPublicAddresses` in `safe-download.ts`, delete only the moved helpers/constants, and replace `publicAddresses(...)` calls with `validatedPublicAddresses(...)`. Keep the downloader's catch-and-map behavior unchanged.

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/media/media-route.test.ts electron/main/media/safe-download.test.ts
```

Expected: both files pass; the extraction does not alter the existing SSRF policy.

- [ ] **Step 6: Commit the pure routing slice**

```bash
git add apps/desktop/electron/main/media/media-route.ts apps/desktop/electron/main/media/media-route.test.ts apps/desktop/electron/main/media/safe-download.ts apps/desktop/electron/main/media/safe-download.test.ts
git commit -m "refactor: isolate safe media route selection"
```

---

### Task 3: Pin dependencies and implement the numeric-destination transport

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/desktop/electron/main/media/pinned-media-transport.ts`
- Create: `apps/desktop/electron/main/media/pinned-media-transport.test.ts`
- Create: `apps/desktop/electron/main/media/pinned-media-transport.integration.test.ts`
- Create: `apps/desktop/electron/main/media/test-fixtures/pinned-media-test-key.pem`
- Create: `apps/desktop/electron/main/media/test-fixtures/pinned-media-test-cert.pem`

**Interfaces:**
- Consumes: `MediaRoute` from Task 2 and a downloader-selected numeric destination.
- Produces: `PinnedMediaRequest`, `SafeMediaResponse`, `PinnedMediaTransportPort`, and `PinnedMediaTransport`.
- Guarantee: request settlement occurs at response headers; the response owns body cancellation, and every terminal path destroys the Node request and per-request agent.

- [ ] **Step 1: Add exact runtime dependencies**

Run:

```bash
pnpm --filter @autoforge/desktop add --save-exact https-proxy-agent@9.1.0 socks-proxy-agent@10.1.0
```

Verify `apps/desktop/package.json` contains exact strings without `^` or `~`:

```json
"https-proxy-agent": "9.1.0",
"socks-proxy-agent": "10.1.0"
```

- [ ] **Step 2: Inspect the installed agent source before writing the adapter**

Resolve the installed entry points:

```bash
pnpm --filter @autoforge/desktop exec node -p "require.resolve('https-proxy-agent')"
pnpm --filter @autoforge/desktop exec node -p "require.resolve('socks-proxy-agent')"
```

Read the resolved modules and their `package.json` files. Confirm all of the following before continuing:

- `HttpsProxyAgent` derives the CONNECT authority from the request option `host`/`port`, not `servername` or URL `Host` header.
- `SocksProxyAgent` passes request option `host`/`port` into the SOCKS destination and selects numeric ATYP when `host` is numeric.
- neither package reads `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, or `NO_PROXY` on its own;
- constructor options can provide a CA for the HTTPS proxy connection in tests without changing origin TLS options.

If source inspection contradicts any item, stop this task and report the exact source line; do not weaken numeric pinning or TLS verification.

- [ ] **Step 3: Write the failing transport contract tests**

Create `pinned-media-transport.test.ts` with an injected `httpsRequest` spy and fake `IncomingMessage`. Assert that a domain URL with a numeric destination produces:

```ts
expect(httpsRequest).toHaveBeenCalledWith(expect.objectContaining({
  protocol: 'https:',
  hostname: '93.184.216.34',
  port: 443,
  servername: 'media.example',
  method: 'GET',
  path: '/asset.png?size=2',
  headers: { host: 'media.example', accept: '*/*' },
  agent: expect.anything(),
  signal: expect.any(AbortSignal),
}), expect.any(Function))
```

Add cases for:

```ts
await expect(transport.request({
  url: new URL('https://media.example/'),
  destinationAddress: 'not-an-ip',
  route: { kind: 'direct' },
  signal: new AbortController().signal,
})).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED' })

expect(ipLiteralOptions.servername).toBeUndefined()
expect(ipLiteralOptions.headers).toMatchObject({ host: '93.184.216.34' })
```

Prove abort before headers calls `request.destroy()`, agent destruction is idempotent, response EOF destroys the agent, and `SafeMediaResponse.cancel(secretError)` rejects no data outward while destroying response/request/agent.

- [ ] **Step 4: Run the unit transport test and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/media/pinned-media-transport.test.ts
```

Expected: FAIL because the transport module does not exist.

- [ ] **Step 5: Implement the transport boundary and direct request**

Create these exported contracts:

```ts
export interface PinnedMediaRequest {
  url: URL
  destinationAddress: string
  route: MediaRoute
  signal: AbortSignal
}

export interface SafeMediaResponse {
  statusCode: number
  statusMessage: string
  rawHeaders: readonly string[]
  body: ReadableStream<Uint8Array>
  cancel(reason?: unknown): Promise<void>
}

export interface PinnedMediaTransportPort {
  request(input: PinnedMediaRequest): Promise<SafeMediaResponse>
}
```

Use a Main-only test seam that is never added to settings, IPC, or Renderer types:

```ts
interface PinnedMediaTransportDependencies {
  httpsRequest: typeof httpsRequest
  originPort: number
  originCa?: string | Buffer
  proxyCa?: string | Buffer
}

const productionDependencies: PinnedMediaTransportDependencies = {
  httpsRequest,
  originPort: 443,
}
```

Merge test overrides without exposing them outside Main:

```ts
constructor(dependencies: Partial<PinnedMediaTransportDependencies> = {}) {
  this.dependencies = { ...productionDependencies, ...dependencies }
}
```

Build request options only from the validated numeric destination and original URL identity:

```ts
const originalHostname = bareHostname(input.url)
if (isIP(input.destinationAddress) === 0) throw failure()
const requestOptions: RequestOptions = {
  protocol: 'https:',
  hostname: input.destinationAddress,
  port: this.dependencies.originPort,
  method: 'GET',
  path: `${input.url.pathname}${input.url.search}`,
  headers: { host: input.url.host, accept: '*/*' },
  servername: isIP(originalHostname) === 0 ? originalHostname : undefined,
  rejectUnauthorized: true,
  signal: input.signal,
  agent,
  ...(this.dependencies.originCa ? { ca: this.dependencies.originCa } : {}),
}
```

For direct requests create a fresh `https.Agent({ keepAlive: false })`. Do not pass the URL itself to `https.request`, do not supply `lookup`, and do not read proxy environment variables.

- [ ] **Step 6: Add CONNECT and SOCKS agents without changing origin identity**

Select one new agent per request:

```ts
function agentFor(
  route: MediaRoute,
  dependencies: PinnedMediaTransportDependencies,
): Agent {
  if (route.kind === 'direct') return new https.Agent({ keepAlive: false })
  if (route.kind === 'http-connect') {
    return new HttpsProxyAgent(route.proxyUrl, {
      keepAlive: false,
      ...(dependencies.proxyCa ? { ca: dependencies.proxyCa } : {}),
    })
  }
  return new SocksProxyAgent(route.proxyUrl, { keepAlive: false })
}
```

Pass the same numeric `hostname`, origin `port`, original `servername`, and original `Host` options to `https.request` for all routes. The proxy URL is used only to construct its agent. Reject any unexpected route, URL protocol, URL port, URL credential, or non-IP destination with `MEDIA_DOWNLOAD_FAILED`.

Adapt `IncomingMessage` with `Readable.toWeb(response) as ReadableStream<Uint8Array>`. Copy `response.rawHeaders`, `statusCode`, and `statusMessage` defensively. Register one idempotent cleanup function that destroys the agent after response `end`, `aborted`, `error`, explicit cancellation, request error, or abort. `cancel(reason)` destroys the response and request before cleanup and resolves after teardown; it never returns the raw reason.

- [ ] **Step 7: Run the unit transport test and verify GREEN**

Run the Step 4 command again.

Expected: direct/CONNECT/SOCKS option construction, abort, response adaptation, and idempotent teardown tests pass.

- [ ] **Step 8: Generate a checked-in test-only TLS fixture**

Create the fixture directory and generate one self-signed certificate valid for the origin DNS identity and the loopback HTTPS-proxy IP:

```bash
mkdir -p apps/desktop/electron/main/media/test-fixtures
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 10950 -subj "/CN=media.test" -addext "subjectAltName=DNS:media.test,IP:127.0.0.1" -keyout apps/desktop/electron/main/media/test-fixtures/pinned-media-test-key.pem -out apps/desktop/electron/main/media/test-fixtures/pinned-media-test-cert.pem
```

These files are test fixtures only. `application.ts` must instantiate the transport without `originCa`, `proxyCa`, or `originPort` overrides.

- [ ] **Step 9: Write real loopback integration tests for every route**

Create an HTTPS origin on `127.0.0.1` with the fixture certificate. Its `SNICallback` records `servername`, and its request handler records `request.headers.host`, returns `content-length: 2`, and ends with `ok`. Read the certificate with:

```ts
const fixtureDirectory = new URL('./test-fixtures/', import.meta.url)
const key = await readFile(new URL('pinned-media-test-key.pem', fixtureDirectory))
const cert = await readFile(new URL('pinned-media-test-cert.pem', fixtureDirectory))
```

Use a shared listener helper that binds port `0`, records its assigned port, and registers `afterEach` cleanup. Instantiate the transport with the real `https.request`, the origin's assigned port, and `originCa: cert`.

For direct mode, request `new URL('https://media.test/asset')` with destination `127.0.0.1`. Assert body `ok`, observed SNI `media.test`, and observed Host `media.test`. Success proves the origin hostname was not needed for connection routing.

For HTTP CONNECT, create a `net.Server` that handles `connect`, records `request.url`, opens `net.connect(originPort, '127.0.0.1')`, replies `HTTP/1.1 200 Connection Established`, forwards `head`, and pipes both sockets. Assert:

```ts
expect(connectAuthorities).toEqual([`127.0.0.1:${originPort}`])
expect(connectAuthorities[0]).not.toContain('media.test')
```

For HTTPS CONNECT, use `https.createServer({ key, cert })` with the same CONNECT handler, a proxy URL using `https://127.0.0.1:<port>`, and `proxyCa: cert`. First assert the request succeeds and records a numeric authority. Then instantiate without `proxyCa` and assert rejection, proving proxy-certificate verification remains enabled.

For SOCKS5, implement the minimal no-auth handshake: accept `[0x05, methods...]`, reply `[0x05, 0x00]`, parse the connect request, require `ATYP === 0x01` for the IPv4 destination, record the four address bytes and port, connect the origin, reply with success, and pipe sockets. Assert the recorded address is `127.0.0.1` and no domain ATYP `0x03` occurs.

For SOCKS4, parse version `0x04`, command `0x01`, two-byte port, four-byte IPv4 address, and the NUL-terminated user ID. Reply `[0x00, 0x5a, ...]`, connect the origin, and pipe sockets. Assert the recorded four bytes are `127.0.0.1` and the request contains no SOCKS4a domain suffix.

Set fake environment proxy variables around the direct test and restore them in `finally`:

```ts
process.env.HTTP_PROXY = 'http://127.0.0.1:1'
process.env.HTTPS_PROXY = 'http://127.0.0.1:1'
process.env.ALL_PROXY = 'socks5://127.0.0.1:1'
```

The direct request must still succeed, proving the transport does not inherit them.

- [ ] **Step 10: Run real integration tests under the pinned Electron runtime**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/media/pinned-media-transport.test.ts electron/main/media/pinned-media-transport.integration.test.ts
```

Expected: direct, HTTP CONNECT, HTTPS CONNECT, SOCKS4, SOCKS5, TLS identity, numeric destination, environment isolation, abort, and cleanup tests all pass; every temporary listener closes in `afterEach`.

- [ ] **Step 11: Commit the transport slice**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/electron/main/media/pinned-media-transport.ts apps/desktop/electron/main/media/pinned-media-transport.test.ts apps/desktop/electron/main/media/pinned-media-transport.integration.test.ts apps/desktop/electron/main/media/test-fixtures/pinned-media-test-key.pem apps/desktop/electron/main/media/test-fixtures/pinned-media-test-cert.pem
git commit -m "feat: add pinned media proxy transport"
```

---

### Task 4: Move the safe downloader and application composition onto the pinned transport

**Files:**
- Modify: `apps/desktop/electron/main/media/safe-download.ts`
- Modify: `apps/desktop/electron/main/media/safe-download.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Consumes: `NetworkProxyPort.withTransportLease`, `NetworkTransportSnapshot`, `PinnedMediaTransportPort`, `validatedPublicAddresses`, and `selectMediaRoute`.
- Changes: `SafeMediaDownloaderDependencies.fetch` is removed; dependencies gain `transport` and `withTransportLease`.
- Guarantee: one lease begins before initial DNS and ends only after success or complete failure cleanup; redirects stay inside that lease.

- [ ] **Step 1: Write failing downloader tests for lease scope and rebinding closure**

Replace the fetch-shaped test harness with a `PinnedMediaTransportPort` mock whose `request` receives URL, numeric destination, route, and signal and returns a `SafeMediaResponse`. Keep the existing controllable Web stream and destination helpers.

Add a rebinding test:

```ts
it('connects only to the address returned by this download resolver', async () => {
  const request = vi.fn(async ({ destinationAddress }: PinnedMediaRequest) => {
    expect(destinationAddress).toBe('93.184.216.34')
    return safeResponse({ body: bytes('ok'), headers: ['content-length', '2'] })
  })
  const downloader = downloaderWith({
    resolveHost: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    transport: { request },
  })

  await expect(downloader.download(
    'https://ambient-dns-must-not-run.invalid/file',
    writableSink(),
    { maxBytes: 10 },
  )).resolves.toEqual({ byteSize: 2 })
  expect(request).toHaveBeenCalledOnce()
})
```

Add a lease-scope test that records events and uses a redirect response followed by a final body:

```ts
expect(events).toEqual([
  'lease:start',
  'dns:first.example',
  'request:first.example',
  'cancel:first.example',
  'dns:second.example',
  'request:second.example',
  'body:end',
  'lease:end',
])
```

Add tests that terminal lease rejection leaves `resolveHost` and `transport.request` uncalled, and that CONNECT, SOCKS, response-body, destination, timeout, and cancellation failures still produce exactly:

```ts
{ code: 'MEDIA_DOWNLOAD_FAILED', message: 'The media download failed.' }
```

- [ ] **Step 2: Write failing route, fallback, and raw-header tests**

Add table-driven tests for disabled direct, exact/wildcard domain bypass, IP/CIDR bypass, and `httpsProxy -> socketProxy -> httpProxy`. Inspect the mock's `PinnedMediaRequest.route` and `destinationAddress` rather than browser `fetch` options.

Add sequential fallback proof:

```ts
const request = vi.fn()
  .mockRejectedValueOnce(new Error('first address failed'))
  .mockResolvedValueOnce(safeResponse({
    body: bytes('ok'),
    headers: ['content-length', '2'],
  }))
expect(request.mock.calls.map(([input]) => input.destinationAddress)).toEqual([
  '93.184.216.34',
  '1.1.1.1',
])
```

Also assert that an accepted response whose body later fails does not try the second address.

Preserve raw-header strictness with these cases:

```ts
it.each([
  ['duplicate length', ['content-length', '2', 'Content-Length', '2']],
  ['conflicting length', ['content-length', '2', 'Content-Length', '3']],
  ['odd raw header array', ['content-length']],
  ['non-string raw value', ['content-length', 2] as unknown as string[]],
])('rejects %s', async (_name, rawHeaders) => {
  await expect(downloadResponse({ rawHeaders })).rejects.toMatchObject({
    code: 'MEDIA_DOWNLOAD_FAILED',
  })
})
```

- [ ] **Step 3: Run the downloader and application tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/media/safe-download.test.ts electron/main/application.test.ts
```

Expected: FAIL because the downloader still expects `fetch`, does not accept routes/leases, and application composition still binds `networkProxy.fetch`.

- [ ] **Step 4: Replace fetch dependencies with the transport and lease ports**

Change dependencies to:

```ts
export interface SafeMediaDownloaderDependencies {
  resolveHost(hostname: string): Promise<readonly LookupAddress[]>
  transport: PinnedMediaTransportPort
  withTransportLease<T>(
    operation: (snapshot: NetworkTransportSnapshot) => Promise<T>,
  ): Promise<T>
  setTimer(callback: () => void, milliseconds: number): TimerHandle
  clearTimer(handle: TimerHandle): void
}
```

The constructor's production defaults are:

```ts
this.dependencies = {
  resolveHost: defaultResolveHost,
  transport: new PinnedMediaTransport(),
  withTransportLease: async (operation) => operation({
    settings: Object.freeze({
      enabled: false,
      bypassDomains: Object.freeze([]) as string[],
    }),
  }),
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  ...dependencies,
}
```

The direct default exists for focused downloader tests and isolated use. Application production composition must always inject `networkProxy.withTransportLease`.

Wrap the complete state machine once:

```ts
void this.dependencies.withTransportLease(async ({ settings }) => {
  if (context.aborted) throw failure()
  return this.downloadValidated(
    initialUrl,
    destination,
    validated,
    context,
    settings,
  )
}).then(succeed, fail)
```

- [ ] **Step 5: Resolve, validate, route, and attempt only pinned addresses per hop**

Inside `downloadValidated`, replace the preflight-only call with:

```ts
const hostname = bareHostname(currentUrl)
let addresses: readonly LookupAddress[]
try {
  addresses = isIP(hostname) === 0
    ? validatedPublicAddresses(await this.dependencies.resolveHost(hostname))
    : validatedPublicAddresses([{
      address: hostname,
      family: isIP(hostname) as 4 | 6,
    }])
} catch {
  throw failure()
}
if (context.aborted) throw failure()

const selection = selectMediaRoute(settings, hostname, addresses)
const result = await this.requestOnce(
  currentUrl,
  selection,
  destination,
  options,
  context,
)
```

In `requestOnce`, start one connect timer before the attempt loop. Call:

```ts
for (const candidate of selection.destinationAddresses) {
  try {
    response = await this.dependencies.transport.request({
      url,
      destinationAddress: candidate.address,
      route: selection.route,
      signal: controller.signal,
    })
    break
  } catch {
    if (controller.signal.aborted || context.aborted) {
      fail()
      return
    }
  }
}
if (!response) {
  fail()
  return
}
```

The loop catches only `request()` rejection, which by contract occurs before response headers. Once a `SafeMediaResponse` exists, no address fallback path remains.

- [ ] **Step 6: Parse raw headers and preserve response/body cleanup**

Replace WHATWG `Headers` access with strict raw-pair helpers:

```ts
function rawHeaderValues(rawHeaders: readonly string[], name: string): string[] {
  if (rawHeaders.length % 2 !== 0) throw failure()
  const values: string[] = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (typeof key !== 'string' || typeof value !== 'string') throw failure()
    if (key.toLowerCase() === name) values.push(value)
  }
  return values
}

function singleRawHeader(rawHeaders: readonly string[], name: string): string | null {
  const values = rawHeaderValues(rawHeaders, name)
  if (values.length > 1) throw failure()
  return values[0] ?? null
}
```

Use `singleRawHeader` for `location`, `content-length`, and `content-type`. Validate integer `statusCode`, obtain the Web reader from `response.body`, and store `response.cancel` as the owned teardown. Every redirect awaits `response.cancel(failure())` before returning its location. Every non-success status, malformed header, size violation, timeout, stream failure, destination failure, and external abort invokes the same idempotent cancel path before rejecting.

Success still requires body EOF, declared-length equality, no pending writes, and no outstanding drain wait. The downloader never ends or destroys the caller-owned destination.

- [ ] **Step 7: Compose the real transport in `application.ts`**

Add an optional Main-only test seam to the application options:

```ts
mediaTransport?: PinnedMediaTransportPort
```

Replace the current downloader construction with:

```ts
downloader: new SafeMediaDownloader({
  transport: options.mediaTransport ?? new PinnedMediaTransport(),
  withTransportLease: options.networkProxy.withTransportLease.bind(options.networkProxy),
}),
```

Do not change model-provider fetch composition at the other existing `networkProxy.fetch` call sites; this supplemental design replaces only media transport.

Update the application test's `NetworkProxyPort` mock so `withTransportLease` calls its operation with a frozen direct settings snapshot. In the generated-image test inject a fake `mediaTransport`, assert it receives the numeric destination and direct route, assert `withTransportLease` is called once, and retain the `globalThis.fetch` rejection spy to prove ambient fetch is unused.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/network/network-proxy-service.test.ts electron/main/media/media-route.test.ts electron/main/media/pinned-media-transport.test.ts electron/main/media/pinned-media-transport.integration.test.ts electron/main/media/safe-download.test.ts electron/main/application.test.ts
```

Expected: all named tests pass, including every pre-existing downloader lifecycle and ownership regression.

- [ ] **Step 9: Run desktop typecheck and commit the migration**

Run:

```bash
pnpm --filter @autoforge/desktop typecheck
```

Expected: both Main and Renderer typechecks pass without widening IPC or Renderer contracts.

Commit:

```bash
git add apps/desktop/electron/main/media/safe-download.ts apps/desktop/electron/main/media/safe-download.test.ts apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts
git commit -m "fix: pin safe media downloads to validated addresses"
```

---

### Task 5: Verify packaged dependencies and run all release gates

**Files:**
- Modify: `apps/desktop/scripts/verify-packaged-native.mjs`

**Interfaces:**
- Consumes: the completed transport and exact locked packages.
- Produces: a packaged-runtime probe that imports both proxy agents from `app.asar` and preserves the existing Electron ABI SQLite query.
- Guarantee: no completion claim is made until focused, full-repository, build, real-route, and directory-package checks pass.

- [ ] **Step 1: Extend the packaged Electron probe**

Add archive package paths:

```js
const httpsProxyAgentPackage = join(appArchive, 'node_modules', 'https-proxy-agent')
const socksProxyAgentPackage = join(appArchive, 'node_modules', 'socks-proxy-agent')
```

Extend the probe without removing the SQLite query:

```js
const probe = [
  'const Database = require(process.argv[1])',
  'const { HttpsProxyAgent } = require(process.argv[2])',
  'const { SocksProxyAgent } = require(process.argv[3])',
  'if (typeof HttpsProxyAgent !== "function") throw new Error("Packaged https-proxy-agent load failed")',
  'if (typeof SocksProxyAgent !== "function") throw new Error("Packaged socks-proxy-agent load failed")',
  'const database = new Database(":memory:")',
  'const result = database.prepare("select 1 as ok").get()',
  'database.close()',
  'if (result.ok !== 1) throw new Error("Packaged SQLite query failed")',
  'console.log(`Packaged proxy agents and better-sqlite3 loaded under Electron ${process.versions.electron}`)',
].join(';')
```

Pass all three package paths to the packaged executable:

```js
const result = spawnSync(executable, [
  '-e',
  probe,
  databasePackage,
  httpsProxyAgentPackage,
  socksProxyAgentPackage,
], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
})
```

- [ ] **Step 2: Run focused security tests once more**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/network/network-proxy-service.test.ts electron/main/media/media-route.test.ts electron/main/media/pinned-media-transport.test.ts electron/main/media/pinned-media-transport.integration.test.ts electron/main/media/safe-download.test.ts electron/main/application.test.ts
```

Expected evidence:

- direct, HTTP CONNECT, HTTPS CONNECT, SOCKS4, and SOCKS5 paths pass under the pinned Electron executable;
- CONNECT authorities and SOCKS destinations are numeric;
- origin SNI and Host remain `media.test`;
- HTTPS proxy trust failure is rejected;
- environment proxy variables do not affect direct mode;
- transition, terminal state, redirect cancellation, fallback confinement, raw headers, timeout, size, backpressure, destination ownership, and cleanup tests pass.

- [ ] **Step 3: Run full static and automated gates**

Run each command separately and retain its exit status:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Expected: every command exits `0`. If a pre-existing unrelated failure appears, record the exact command and failure separately; do not describe the full gate as passing.

- [ ] **Step 4: Build and probe the directory package**

Run:

```bash
pnpm dist:dir
```

Expected: the macOS arm64 directory package succeeds and `verify-packaged-native.mjs` prints that `https-proxy-agent`, `socks-proxy-agent`, and `better-sqlite3` loaded under the packaged Electron executable.

The successful `require()` calls from `app.asar` are the package-presence and transitive-load evidence. Confirm `apps/desktop/electron-builder.yml` still packages only `out/**`; therefore source tests, the test certificate, and the test private key are not application inputs and must not be copied into `out/` by the build.

- [ ] **Step 5: Review the final diff against the security invariants**

Run:

```bash
git diff --check
git status --short
git diff 0dd1ee8 -- apps/desktop/electron/main/network apps/desktop/electron/main/media apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts apps/desktop/package.json apps/desktop/scripts/verify-packaged-native.mjs pnpm-lock.yaml
```

Confirm from the diff that:

- the original hostname appears only in SNI/certificate identity and `Host`, never as a connection destination;
- all agent construction receives the downloader-selected numeric request host;
- the transport lease encloses DNS through final cleanup;
- no proxy environment lookup, credential support, TLS bypass, pooling, IPC, or Renderer surface was added;
- every thrown network detail is caught and mapped to the fixed safe media error;
- only exact dependency versions are declared.

- [ ] **Step 6: Commit the package verification gate**

```bash
git add apps/desktop/scripts/verify-packaged-native.mjs
git commit -m "test: verify packaged media proxy agents"
```

After the commit, rerun `git status --short` and require an empty result before handing off the branch.
