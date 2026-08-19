# OpenRouter App Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every request emitted by `OpenRouterProvider` is attributed to the AutoForge app in OpenRouter Activity.

**Architecture:** Wrap only the OpenRouter provider's injected Fetch function and merge two fixed attribution headers into every request before it reaches the existing network transport. Keep the generic OpenAI-compatible provider, DeepSeek provider, proxy, request bodies, retries, and error mapping unchanged.

**Tech Stack:** TypeScript 6, Electron main process, Fetch API `Headers`, Vitest 4, pnpm.

## Global Constraints

- Every `OpenRouterProvider` request must send `HTTP-Referer: https://autoforge.bjqisi.cn`.
- Every `OpenRouterProvider` request must send `X-OpenRouter-Title: AutoForge`.
- Existing `Authorization` and `Content-Type` headers must remain intact.
- Do not change DeepSeek or the shared `OpenAiCompatibleProvider` contract.
- Do not change retry, timeout, response parsing, or error behavior.
- Modify only the OpenRouter provider, its direct test, the managed-Fetch integration assertion, and this plan.

---

## File Structure

- Modify `apps/desktop/electron/main/chat/openrouter-provider.ts`: define fixed public app metadata and inject it at the provider-specific Fetch boundary.
- Modify `apps/desktop/electron/main/chat/openrouter-provider.test.ts`: exercise every OpenRouter operation family and verify the two attribution headers on each resulting request.
- Modify `apps/desktop/electron/main/application.test.ts`: keep the managed-Fetch integration assertion compatible with and explicit about the new OpenRouter Header contract.
- Modify `docs/superpowers/plans/2026-08-19-openrouter-app-attribution.md`: mark execution steps complete as work proceeds.

### Task 1: Attribute every OpenRouter request

**Files:**
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.test.ts:61-139`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.ts:25-48`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.ts:284-286`

**Interfaces:**
- Consumes: existing `ProviderFetch`, `OpenRouterProvider`, `authenticatedFetch`, `listModels`, `validateCredential`, `stream`, image/video operations, and generation usage lookup.
- Produces: private `withOpenRouterAppAttribution(fetch: ProviderFetch): ProviderFetch` wrapper. No exported contract changes.

- [x] **Step 1: Write a failing provider-level attribution test**

Add this test near the beginning of the `OpenRouterProvider` describe block in `apps/desktop/electron/main/chat/openrouter-provider.test.ts`:

```ts
it('adds app attribution headers to every OpenRouter request', async () => {
  const requestHeaders: Headers[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requestHeaders.push(new Headers(init?.headers))
    if (url.endsWith('/models')) return Response.json({ data: [] })
    if (url.endsWith('/chat/completions')) return sseResponse(['data: [DONE]\n\n'])
    if (url.endsWith('/images')) {
      return Response.json({ data: [{ b64_json: 'AQID', media_type: 'image/png' }] })
    }
    if (url.endsWith('/videos')) return Response.json({ id: 'job_1', status: 'pending' })
    if (url.endsWith('/videos/job_1')) {
      return Response.json({ id: 'job_1', status: 'completed', generation_id: 'gen_1' })
    }
    if (url.endsWith('/videos/job_1/content?index=0')) return new Response('video')
    if (url.endsWith('/generation?id=gen_1')) {
      return Response.json({ data: { id: 'gen_1', total_cost: '0.25' } })
    }
    throw new Error(`Unexpected URL: ${url}`)
  })
  const provider = new OpenRouterProvider({ credential, fetch })

  await provider.listModels()
  await provider.validateCredential()
  await collect(provider.stream({ model: 'text/model', messages: [] }))
  await provider.generateImage({
    model: 'image/model',
    prompt: 'draw',
    options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
    parameterSupport: allImageParameters,
    references: [],
  })
  await provider.submitVideo({
    model: 'video/model',
    prompt: 'animate',
    options: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
    references: [],
    frameImages: [],
  })
  await provider.pollVideo('job_1')
  await provider.downloadVideo('job_1')
  await provider.getGenerationUsage('gen_1')

  expect(requestHeaders).toHaveLength(10)
  expect(requestHeaders.every((headers) => (
    headers.get('HTTP-Referer') === 'https://autoforge.bjqisi.cn'
    && headers.get('X-OpenRouter-Title') === 'AutoForge'
  ))).toBe(true)
})
```

- [x] **Step 2: Run the focused test and verify RED**

Run from the repository root:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts -t "adds app attribution headers to every OpenRouter request" --reporter=verbose
```

Expected: the new test fails because `Headers.get('HTTP-Referer')` and `Headers.get('X-OpenRouter-Title')` return `null`, so the final expectation receives `false`.

- [x] **Step 3: Add the minimal OpenRouter-specific Fetch wrapper**

Add the constants next to the existing OpenRouter endpoint constants in `apps/desktop/electron/main/chat/openrouter-provider.ts`:

```ts
const APP_REFERER = 'https://autoforge.bjqisi.cn'
const APP_TITLE = 'AutoForge'
```

Add the wrapper immediately after the `ProviderFetch` type:

```ts
function withOpenRouterAppAttribution(fetch: ProviderFetch): ProviderFetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('HTTP-Referer', APP_REFERER)
    headers.set('X-OpenRouter-Title', APP_TITLE)
    return fetch(input, {
      ...init,
      headers: Object.fromEntries(headers.entries()),
    })
  }
}
```

Change the first line of the constructor body so the wrapper is applied before the existing unauthorized-response cleanup:

```ts
const fetch = releaseUnauthorizedResponse(withOpenRouterAppAttribution(
  dependencies.fetch ?? globalThis.fetch,
))
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts -t "adds app attribution headers to every OpenRouter request" --reporter=verbose
```

Expected: the attribution test passes and reports 1 passed test.

- [x] **Step 5: Run the complete Provider regression test**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts --reporter=dot
```

Expected: every test in `openrouter-provider.test.ts` passes with no failure or unhandled rejection.

- [x] **Step 6: Run static verification**

Run:

```bash
pnpm exec eslint apps/desktop/electron/main/chat/openrouter-provider.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts
pnpm --filter @autoforge/desktop typecheck
git diff --check
```

Expected: all three commands exit with status 0 and emit no diagnostics for the changed files.

- [x] **Step 7: Commit the implementation**

```bash
git add apps/desktop/electron/main/chat/openrouter-provider.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts docs/superpowers/plans/2026-08-19-openrouter-app-attribution.md
git commit -m "feat: attribute OpenRouter requests to AutoForge"
```

Expected at this checkpoint: one implementation commit containing the provider, its direct test, and this plan. The verification-driven integration assertion is added in Task 2.

### Task 2: Align the managed-Fetch integration assertion

**Files:**
- Modify: `apps/desktop/electron/main/application.test.ts:1492-1495`
- Modify: `docs/superpowers/plans/2026-08-19-openrouter-app-attribution.md`

**Interfaces:**
- Consumes: the existing `NetworkProxyService.fetch` mock and OpenRouter credential validation path.
- Produces: an integration assertion that verifies authorization and both app-attribution headers after the request reaches the managed Fetch boundary.

- [x] **Step 1: Reproduce the integration failure**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/application.test.ts -t "routes OpenRouter and DeepSeek credential validation through the managed fetch" --reporter=verbose
```

Expected before the assertion update: FAIL because the nested Header object contains the two new attribution fields in addition to `authorization`.

- [x] **Step 2: Match and verify the complete OpenRouter Header contract**

Replace the OpenRouter managed-Fetch assertion with:

```ts
expect(networkProxy.fetch).toHaveBeenCalledWith(
  'https://openrouter.ai/api/v1/models',
  expect.objectContaining({
    headers: expect.objectContaining({
      authorization: 'Bearer sk-openrouter',
      'http-referer': 'https://autoforge.bjqisi.cn',
      'x-openrouter-title': 'AutoForge',
    }),
  }),
)
```

Keep the DeepSeek assertion unchanged so the test continues to prove the attribution metadata is OpenRouter-specific.

- [x] **Step 3: Run the focused integration test and full verification**

Run the focused application test, complete OpenRouter Provider test, project typecheck, targeted lint, and full test suite. Expected: all change-related checks pass; any unrelated flaky test must be reproduced separately and reported accurately.

- [x] **Step 4: Amend the implementation commit**

```bash
git add apps/desktop/electron/main/application.test.ts docs/superpowers/plans/2026-08-19-openrouter-app-attribution.md
git commit --amend --no-edit
```

Expected: the implementation commit also contains the managed-Fetch integration assertion required by the full regression suite.

### Task 3: Preserve Fetch semantics for Request inputs

**Files:**
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.test.ts`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.ts`
- Modify: `docs/superpowers/plans/2026-08-19-openrouter-app-attribution.md`

**Interfaces:**
- Consumes: `ProviderFetch`, whose input may be a URL string, `URL`, or `Request`.
- Produces: the existing private `withOpenRouterAppAttribution` wrapper with Request-carried Header preservation when `init.headers` is absent.

- [x] **Step 1: Add a Request-input regression test from code review**

Create a test-only subclass that exposes the inherited protected Fetch function. Send a `Request` carrying `authorization` and `content-type`, then assert the raw transport receives those fields plus both attribution fields.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts -t "preserves headers carried by a Request input while adding app attribution" --reporter=verbose
```

Expected before the wrapper fix: FAIL because the effective transport Header object lacks `authorization` and `content-type`.

- [x] **Step 3: Inherit Request headers when init headers are absent**

Initialize the wrapper Header collection with:

```ts
const headers = new Headers(
  init?.headers ?? (input instanceof Request ? input.headers : undefined),
)
```

Then set the two fixed attribution fields as before. This follows Fetch semantics: explicit `init.headers` remains authoritative; otherwise a `Request` retains its own Headers.

- [x] **Step 4: Verify the remediation and amend the implementation commit**

Run the focused Request-input test, complete Provider test, managed-Fetch integration test, full test suite, typecheck, targeted lint, and diff checks. Then amend `c790aca` with the review remediation and this updated plan.
