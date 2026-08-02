# IP-pinned safe media transport design

## Status and relationship to the VPN proxy design

This specification extends the approved VPN proxy design in
`docs/superpowers/specs/2026-08-01-vpn-proxy-settings-design.md`.

It replaces only the remote-media transport decision in that document. Renderer,
model-provider, Playwright, settings, IPC, persistence, and `shell.openExternal()`
behavior remain unchanged.

The replacement is required because Electron 43 exposes no API that binds a
`Session.resolveHost()` result to the subsequent `Session.fetch()` connection. A DNS
preflight followed by Chromium or proxy-side hostname resolution leaves a DNS-rebinding
time-of-check/time-of-use gap. The media transport must therefore connect to a validated
numeric destination while preserving the original TLS and HTTP hostname.

## Goals

- Preserve the existing HTTPS-only remote-media safety contract.
- Make every actual origin connection target a numeric IP that passed the same request's
  public-address validation.
- Route proxied downloads through the authoritative AutoForge proxy generation.
- Support direct, HTTP proxy, HTTPS proxy, SOCKS4, and SOCKS5 routes without proxy
  credentials.
- Preserve the original hostname for TLS SNI, certificate validation, and the HTTP
  `Host` header.
- Hold the current proxy generation until the entire download, including redirects and
  response-body handling, ends.
- Preserve redirect, timeout, size, MIME, backpressure, destination ownership, cleanup,
  and fixed-error behavior.

## Non-goals

- Proxy username/password authentication.
- PAC files, environment-variable proxy discovery, or operating-system proxy discovery.
- HTTP media URLs; remote media remains HTTPS-only.
- Changing model-provider, Renderer, Playwright, or external-browser network paths.
- Custom CA configuration or an option to disable TLS verification.
- Connection pooling across downloads.

## Dependencies

Add exactly these runtime dependencies to `@autoforge/desktop` and lock their complete
transitive graph in `pnpm-lock.yaml`:

- `https-proxy-agent@9.1.0`
- `socks-proxy-agent@10.1.0`

`https-proxy-agent` supplies HTTP and HTTPS CONNECT tunneling for HTTPS origin requests.
`socks-proxy-agent` supplies SOCKS4 and SOCKS5 connection establishment. AutoForge, not
environment variables, selects and constructs the agent.

The implementation must review the installed source/API before use and verify that the
CONNECT or SOCKS destination comes from the numeric request host supplied by AutoForge.
If either dependency substitutes the original hostname, the implementation must stop;
it may not claim the TOCTOU issue is fixed.

## Components and interfaces

### NetworkProxyService transport lease

Add a Main-only lease operation to `NetworkProxyPort`:

```ts
interface NetworkTransportSnapshot {
  settings: ProxySettings
}

interface NetworkProxyPort {
  // Existing methods remain.
  withTransportLease<T>(
    operation: (snapshot: NetworkTransportSnapshot) => Promise<T>,
  ): Promise<T>
}
```

`withTransportLease()`:

1. Uses the existing transition entry barrier.
2. Acquires the current generation lease atomically.
3. Passes a frozen defensive copy of the current normalized `ProxySettings`.
4. Releases the lease in `finally` after the operation resolves or rejects.
5. Rejects with the existing safe proxy error in terminal proxy state.

The structured settings snapshot is Main-only. It is never exposed through Preload,
Renderer, IPC, or the Playwright snapshot.

### PinnedMediaTransport

Introduce one Main-only transport with a small request/response contract:

```ts
interface PinnedMediaRequest {
  url: URL
  destinationAddress: string
  route: MediaRoute
  signal: AbortSignal
}

type MediaRoute =
  | { kind: 'direct' }
  | { kind: 'http-connect'; proxyUrl: string }
  | { kind: 'socks'; proxyUrl: string }

interface SafeMediaResponse {
  statusCode: number
  statusMessage: string
  rawHeaders: readonly string[]
  body: ReadableStream<Uint8Array>
  cancel(reason?: unknown): Promise<void>
}
```

The exact TypeScript names may follow local conventions, but the boundary must retain
the same responsibilities: the downloader selects a validated numeric destination and
route; the transport owns Node `https.request`, the proxy agent, the socket, and the
response adapter.

`SafeMediaResponse` preserves raw headers so duplicate or malformed `Content-Length`
checks are not weakened by WHATWG `Headers` normalization.

### SafeMediaDownloader

`SafeMediaDownloader` remains responsible for:

- canonical URL and redirect validation;
- DNS resolution and complete public-address validation;
- route selection and bypass matching;
- redirect count and timeout budgets;
- response status, content length, MIME, streamed size, and length-consistency checks;
- destination backpressure, pending write completion, and ownership;
- cancelling the current transport response on every incomplete-body path;
- fixed safe error mapping.

Application composition injects the new transport and wraps the complete download in
`networkProxy.withTransportLease()`. It no longer injects
`networkProxy.fetch` into `SafeMediaDownloader`.

## Per-hop data flow

For the initial URL and every redirect:

1. Canonicalize and validate the HTTPS URL.
2. Resolve the original hostname with the downloader's resolver.
3. Reject before connection if resolution fails, yields no addresses, or yields any
   private, loopback, link-local, multicast, unspecified, documentation-only, or other
   restricted address.
4. Deduplicate the validated numeric addresses while preserving resolver order.
5. Evaluate bypass rules against the original hostname and validated addresses.
6. Select a route from the frozen generation settings.
7. Select one validated numeric destination for the attempt.
8. Open the transport using that numeric destination.
9. Send TLS SNI and verify the origin certificate using the original hostname.
10. Send the HTTP `Host` header using the original hostname.
11. Process the response under the existing safety limits.
12. For a redirect, cancel/destroy the current response before resolving the next URL.

No later component may resolve the origin hostname again. Proxy endpoint DNS resolution
is allowed because the user explicitly trusts the configured proxy as the transport
endpoint; origin DNS resolution is not delegated to that proxy.

## Route selection and bypass

Remote media is HTTPS, so a non-bypassed request selects the first configured route in
this order:

1. `httpsProxy`
2. `socketProxy`
3. `httpProxy`

When proxying is disabled, the route is direct.

Bypass evaluation uses the same normalized entries as the rest of the application:

- exact and wildcard domain rules match the original hostname;
- IP and CIDR rules match validated numeric destination candidates;
- a matching numeric rule selects a matching validated address for a direct request;
- `<local>` does not permit an unsafe media target, because the media public-address
  check runs before bypass and still rejects local targets.

Bypass changes cannot affect an active download because the frozen transport snapshot is
held for that download's entire generation.

## Direct and proxy connections

### Direct

Use Node `https.request` with:

- the validated numeric IP as `hostname`;
- port `443`;
- the original hostname as `servername`;
- the original hostname as the `Host` header;
- default certificate verification enabled;
- no environment or global proxy agent;
- no keep-alive pooling after the download.

### HTTP or HTTPS proxy

Create a fresh `HttpsProxyAgent` from the configured `http://` or `https://` proxy URL.
The origin request still uses the validated numeric IP as its request host, so CONNECT
must target `<validated-ip>:443`. TLS inside the tunnel uses the original hostname for
SNI and certificate verification, and the HTTP request uses the original `Host`.

An `https://` proxy additionally validates the proxy server certificate with the default
trust store. No insecure certificate override is added.

### SOCKS4 or SOCKS5 proxy

Create a fresh `SocksProxyAgent` from the configured SOCKS URL. The destination passed to
the SOCKS handshake must be the validated numeric IP and port 443; the original hostname
must not be delegated to the proxy for DNS resolution. TLS and HTTP hostname behavior
inside the established socket is the same as direct and CONNECT routes.

## Address attempts

All resolver results must be validated before the first connection. The transport may
try validated addresses sequentially in resolver order when a connection fails, while
the original total/connect timeout budgets continue running. It must never resolve the
hostname again and must never attempt an address outside the validated set.

Once response headers are accepted, no alternative address is attempted for that hop.

## Cancellation, leases, and transitions

- `withTransportLease()` covers DNS, connection establishment, redirects, body reading,
  destination writes, and cleanup.
- Abort destroys the active Node request/socket and proxy agent.
- A redirect, rejected response, size/MIME error, timeout, destination error, or read
  error cancels/destroys the current response before the lease is released.
- Success waits for physical response EOF and pending destination writes.
- Proxy transition waits for the active media lease to end and does not interrupt it.
- No agent or socket survives beyond the download operation.
- Terminal proxy state rejects new media downloads before any DNS or connection work.

## Error and privacy behavior

DNS, direct connect, proxy connect, SOCKS handshake, TLS, certificate, timeout, response,
stream, and destination failures map to the existing fixed `MEDIA_DOWNLOAD_FAILED`
error. Error text and logs must not include:

- the media URL;
- the proxy URL;
- the validated IP;
- request or response bodies;
- credentials or user content.

Proxy authentication remains unsupported, and proxy URLs containing credentials remain
invalid at the shared schema boundary.

## Testing strategy

Implementation follows TDD. Each behavior must have a focused RED before production
code and a GREEN afterward.

### Unit and integration matrix

- direct numeric-IP connection with original TLS SNI and `Host`;
- HTTP proxy CONNECT destination is numeric;
- HTTPS proxy CONNECT destination is numeric and the proxy certificate is verified;
- SOCKS4 and SOCKS5 destinations are numeric;
- no environment/system proxy inheritance;
- exact domain, wildcard domain, IP, and CIDR bypass;
- disabled proxy is direct;
- `httpsProxy -> socketProxy -> httpProxy` fallback;
- resolver divergence/rebinding: ambient hostname resolution points elsewhere or fails,
  while the request succeeds only through the selected validated IP;
- mixed public/private answers reject before direct or proxy connection;
- redirects cancel the previous body and independently re-resolve, revalidate, and
  reroute;
- multiple validated-address fallback stays within the validated set and timeout budget;
- TLS SNI/certificate mismatch fails safely;
- CONNECT, SOCKS, body, destination, and cancellation failures release the transport
  lease;
- an in-flight media download delays a proxy transition until completion;
- terminal proxy state prevents media DNS/connection work;
- all existing status, raw-header, content-length, MIME, byte-limit, timeout,
  backpressure, pending-write, ownership, and cleanup regressions remain green.

Test-only loopback TLS/proxy/SOCKS fixtures may inject a classifier or trusted test CA.
Production address classification and CA trust must remain unchanged.

### Real verification

Use isolated temporary ports, app identity, `userData`, and profiles without changing
the host system proxy or the main checkout process. Verify:

- direct pinned download;
- HTTP and HTTPS CONNECT download;
- SOCKS4 and SOCKS5 download;
- observable CONNECT/SOCKS destination is numeric;
- origin observes the original `Host` and TLS SNI;
- bypass is direct;
- a media body in progress delays transition, which proceeds after completion;
- temporary listeners, profiles, user data, agents, and sockets are cleaned up.

Run the full repository tests, typecheck, lint, production build, directory packaging,
and packaged-native verification. Inspect the packaged application to confirm both new
runtime dependencies and their transitive files are present.

## Acceptance criteria

- No media origin connection performs a second hostname lookup after validation.
- Direct, CONNECT, and SOCKS routes send only validated numeric origin destinations.
- Origin TLS and HTTP identity remain the original hostname.
- Proxy settings and bypass rules are frozen for the entire download.
- Proxy transitions wait for active media downloads and resume afterward.
- All existing media safety guarantees remain enforced.
- Direct, HTTP/HTTPS proxy, and SOCKS4/5 paths have focused and real evidence.
- Full automated and packaging gates pass with no new errors.
