# VPN proxy settings final fix report

> Historical report: superseded by the pinned media transport design and
> `docs/superpowers/plans/2026-08-02-pinned-safe-media-transport-implementation.md`.

Date: 2026-08-02

Reviewed base: `ba7b85914d4ec585b34dd32bc76971e87f29f56d`

Fix-wave starting head: `c7ad9b50edb7f0911f44c52277ed2e5f9b3df187`

Status: `DONE_WITH_CONCERNS`

All implementable findings are fixed and verified. Critical finding 2 is recorded as
`BLOCKED_ARCHITECTURE`: Electron 43 does not expose a transport-boundary API that can
both retain `Session` proxy behavior and pin or verify the actual connected origin IP.
No repeated-DNS or other apparent-only mitigation was added.

## Scope and invariants

- Preserved editable-while-disabled proxy fields.
- Did not add proxy authentication.
- Did not alter `shell.openExternal()` behavior.
- Did not weaken media SSRF, redirect, timeout, size, MIME, backpressure, or ownership checks.
- Kept the main checkout's existing renderer on port 5173 and its process untouched.
- Used isolated temporary Chromium profiles, Electron `userData`, ports, and app identity;
  all temporary evidence harnesses and data were removed after validation.
- Added one directly related correction discovered by the real Chromium run: disabled
  proxy settings now launch new browser contexts with `--no-proxy-server`. Empty Chromium
  proxy arguments inherit the operating-system proxy and therefore do not meet the
  explicit-direct requirement.

## Finding results

### Critical 1 — terminal state after unconfirmed rollback: FIXED

Changed:

- `apps/desktop/electron/main/network/network-proxy-service.ts`
- `apps/desktop/electron/main/network/network-proxy-service.test.ts`

The service now enters a terminal unavailable state if either rollback `setProxy` or
rollback connection cleanup fails. The closed entry gate is rejected, not reopened.
Queued and future `fetch`, `snapshot`, and `transition` calls all reject the fixed safe
`NETWORK_PROXY_APPLY_FAILED` error, and no queued fetch reaches `session.fetch`.

RED:

```text
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/network/network-proxy-service.test.ts
Test Files  1 failed (1)
Tests       1 failed | 18 passed (19)
Failure: queued fetch resolved with Response 204 instead of rejecting.
```

GREEN:

```text
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/network/network-proxy-service.test.ts
Test Files  1 passed (1)
Tests       19 passed (19)
```

### Critical 2 — safe-media DNS preflight pinning: BLOCKED_ARCHITECTURE

No production code was changed for this finding. Electron 43.1.1's relevant public API
surface was checked locally and against its official type/docs surface:

- `Session.fetch` accepts Fetch/Request options and
  `bypassCustomProtocolHandlers`; it exposes no DNS lookup callback, pinned address, peer
  address, socket, or TLS connection hook.
- `Session.resolveHost` performs a separate lookup. Its result cannot be bound to the
  later `Session.fetch` connection.
- `net.request` accepts a URL/hostname but exposes no lookup callback or connected-peer
  verification hook. It also cannot preserve the current `Session` proxy semantics while
  forcing a prevalidated origin IP.
- HTTP CONNECT and SOCKS proxies may resolve the origin remotely, so validating local
  Node DNS does not constrain the proxy's eventual destination.
- `--host-resolver-rules` is process-startup/global state and is unsafe for dynamic,
  concurrent download/redirect destinations.
- Chrome DevTools Protocol can report a remote address only after the request has
  connected, which is too late to prevent SSRF.

Repeating `resolveHost`, comparing two DNS answers, or observing CDP after connection
would not establish the required transport-boundary guarantee and was intentionally not
implemented.

Smallest safe architecture change requiring controller approval:

1. Add a dedicated Main-process safe-media transport behind the existing downloader port.
2. Resolve and validate every redirect destination, then dial only a selected validated
   numeric IP while preserving the original HTTP `Host` and TLS SNI/certificate checks.
3. For HTTP/HTTPS/SOCKS proxy modes, own the CONNECT/SOCKS negotiation so the validated
   numeric destination—not the hostname—is sent to the proxy, while SNI/Host remains the
   original hostname.
4. Hold the existing `NetworkProxyService` lease for the entire response-body lifetime.
5. Add resolver-divergence/rebinding, redirect, proxy-mode, TLS, cancellation, size, and
   lease-transition tests before switching safe media to that transport.

This is a real transport addition, not a surgical Electron API fix; no dependency or
partial connector was added in this wave.

### Important 3 — invalid bypass entries: FIXED

Changed:

- `packages/shared/src/proxy-settings.ts`
- `packages/shared/src/contracts.test.ts`
- `apps/desktop/electron/main/ipc/register-ipc.test.ts`

Every bypass array entry must now be wholly valid before normalization. Protocols, ports,
paths, blank/whitespace entries, comma-separated entries, and CR/LF-separated entries are
rejected. Valid entries are still normalized, lowercased, and deduplicated. Main IPC now
returns `INVALID_INPUT` before calling settings persistence.

RED:

```text
node apps/desktop/scripts/run-vitest-electron.mjs run packages/shared/src/contracts.test.ts
Test Files  1 failed (1)
Tests       1 failed | 25 passed (26)
Failure: proxySettingsSchema accepted an invalid bypass entry.

node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/ipc/register-ipc.test.ts
Test Files  1 failed (1)
Tests       1 failed | 13 passed (14)
Failure: request reached the update mock and surfaced INTERNAL_ERROR instead of INVALID_INPUT.
```

GREEN:

```text
shared contracts: 1 file passed; 26/26 tests passed
Main IPC:          1 file passed; 14/14 tests passed
```

### Important 4 — managed response-body lease leaks: FIXED

Changed:

- `apps/desktop/electron/main/chat/model-provider.ts`
- `apps/desktop/electron/main/chat/openrouter-provider.test.ts`

An oversized declared catalog body is cancelled before rejection. SSE processing now
tracks physical EOF separately from semantic `[DONE]`; `[DONE]` without EOF cancels the
reader. Both regression tests wrap the provider in a real `NetworkProxyService` and prove
that the subsequent proxy transition is no longer blocked by a leaked body lease.

RED:

```text
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts --testNamePattern "managed (catalog|SSE)"
Tests  2 failed | 130 skipped (132)
Failure: both proxy transitions lost the race to the "blocked" sentinel.
```

GREEN:

```text
Test Files  1 passed (1)
Tests       2 passed | 130 skipped (132)
```

### Important 5 — blur/switch draft race: FIXED

Changed:

- `apps/desktop/src/views/SettingsView.vue`
- `apps/desktop/tests/components/workbench.test.ts`

The Settings view now revisions local proxy edits. An older successful save may update
the authoritative store but cannot overwrite a newer local draft. If the newer switch
save fails, the newest switch and address remain visible while the safe Chinese error is
shown. The switch interaction is not swallowed, and fields remain editable while proxying
is disabled.

RED:

```text
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts --testNamePattern "preserves the newer enabled draft"
Tests  1 failed | 46 skipped (47)
Failure: aria-checked was false; expected the newer true draft.
```

GREEN:

```text
focused: 1 passed | 46 skipped (47)
complete workbench file: 47/47 passed
```

### Important 6 — explicit default proxy ports: FIXED

Changed:

- `packages/shared/src/proxy-settings.ts`
- `packages/shared/src/contracts.test.ts`

The raw authority is inspected before WHATWG URL normalization. A numeric explicit port
is validated and then used to rebuild the canonical URL. Domain and bracketed-IPv6
`:80`/`:443` forms are preserved; a genuinely missing port remains invalid.

RED:

```text
node apps/desktop/scripts/run-vitest-electron.mjs run packages/shared/src/contracts.test.ts
Test Files  1 failed (1)
Tests       1 failed | 24 passed (25)
Failure: explicit default-port input was rejected as an invalid HTTP URL.
```

GREEN:

```text
Test Files  1 passed (1)
Tests       25 passed (25)
```

### Real-evidence discovery — explicit direct browser contexts: FIXED

The first real Chromium run showed the host has HTTP, HTTPS, and SOCKS system proxies at
`127.0.0.1:7890`. A disabled snapshot with empty Playwright arguments inherited that
system proxy, so a newly created disabled context was not direct. After approval, a
focused RED was added and disabled snapshots/default browser launches were changed to
`--no-proxy-server`.

RED/GREEN:

```text
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/network/network-proxy-service.test.ts electron/main/browser/browser-capability.test.ts --testNamePattern "direct mode|immutable proxy snapshot|asynchronous proxy snapshot|launches packaged Chromium"
RED:   direct-mode test expected ["--no-proxy-server"], received []
GREEN: 2 files passed; 4 passed | 44 skipped (48)
```

## Isolated real Chromium evidence

Command (using a temporary test harness that was deleted afterward):

```text
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/browser/real-chromium-proxy-evidence.test.ts --reporter=verbose
Test Files  1 passed (1)
Tests       1 passed (1)
Exit        0
```

Actual services: `BrowserCapabilityService`, `NetworkProxyService`, and Playwright's staged
Chromium. Isolated root:
`/var/folders/.../autoforge-real-chromium-evidence-Lq9s5P`.

```json
{
  "ports": { "target": 59875, "local": 59876, "proxy": 59877 },
  "launchArgs": [
    [
      "--proxy-server=http=http://127.0.0.1:59877;https=http://127.0.0.1:59877",
      "--proxy-bypass-list=<local>"
    ],
    ["--no-proxy-server"]
  ],
  "targetRequests": [
    { "path": "/proxied-before-disable", "viaProxy": true },
    { "path": "/direct-new-context", "viaProxy": false },
    { "path": "/proxied-old-context-after-disable", "viaProxy": true }
  ],
  "localRequests": ["/local-bypass"],
  "targetProxyRequests": [
    "/proxied-before-disable",
    "/proxied-old-context-after-disable"
  ],
  "oldContextStillActive": true,
  "contextClosuresBeforeCleanup": 0
}
```

This proves the enabled context used the observable proxy, `<local>` bypass stayed direct,
disabling did not kill the active old context, and a new disabled context was explicitly
direct even with a system proxy configured.

## Isolated real Electron evidence

The production build was run first. A temporary bootstrap launched the actual compiled
Electron application with a unique app name, isolated `userData`/log/temp paths, renderer
port 5174, DevTools port 9335, and control port 19335. An observable loopback CONNECT proxy
on random port 61546 forwarded only `api.deepseek.com:443` and logged only the CONNECT
authority—no credential or request body.

Command/result:

```text
cd apps/desktop
node scripts/real-electron-proxy-evidence.mjs
Exit 0
```

```json
{
  "isolatedRoot": "/var/folders/.../autoforge-real-electron-evidence-1rMN9X",
  "ports": {
    "rendererPort": 5174,
    "debugPort": 9335,
    "controlPort": 19335,
    "proxyPort": 61546
  },
  "initialExternal": "DIRECT",
  "enabledExternal": "PROXY 127.0.0.1:61546",
  "enabledLocal": "DIRECT",
  "credentialResult": "HTTP 401 mapped to 验证失败",
  "proxyAuthorities": ["api.deepseek.com:443"],
  "disabledExternal": "DIRECT",
  "disabledAddressPreserved": true,
  "disabledSwitch": false
}
```

The flow used the real Settings UI to enter and enable the proxy, verified external and
`<local>` resolution, saved an isolated fake DeepSeek credential, observed the actual
provider CONNECT through the proxy and the safe Chinese `验证失败` mapping for HTTP 401,
then disabled the proxy and confirmed direct restoration plus address preservation.

Cleanup checks:

- Ports 5174, 9335, and 19335 had no listeners after exit.
- The isolated `userData` path no longer existed.
- No evidence Electron process remained.
- The main checkout's port 5173 stayed on its original PID 2781 before and after.

## Final verification

Focused regression matrix after all production changes:

```text
shared contracts: 1 file passed; 26/26 tests passed; exit 0
affected Main:    5 files passed; 205/205 tests passed; exit 0
Settings UI:      1 file passed; 47/47 tests passed; exit 0
```

Repository gates:

```text
pnpm test
Test Files  41 passed (41)
Tests       1004 passed (1004)
Exit        0

pnpm typecheck
5 workspace projects completed
Exit 0

pnpm build
shared, workflow-sdk, workflow-schema, Electron Main, Preload, Renderer, and worker built
Exit 0
Note: two existing @vueuse Rollup PURE-annotation warnings only.

pnpm exec eslint <11 changed source/test files>
0 errors; 8 existing SettingsView template-format warnings on untouched lines
Exit 0

git diff --check
No output
Exit 0
```

## Remaining concern

Only Critical finding 2 remains unresolved. It is not safe to claim DNS rebinding
protection at the actual connection boundary with the current Electron `Session` transport.
Implementation must wait for approval of the dedicated safe-media transport architecture
described above.
