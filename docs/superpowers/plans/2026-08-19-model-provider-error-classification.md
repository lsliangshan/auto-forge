# Model Provider Error Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve safe non-streaming model-provider failure categories so chat media blocks show actionable messages without exposing provider payloads or retrying paid image requests.

**Architecture:** Extend the shared AppError allowlist, classify bounded HTTP/error-type metadata at the Electron Main provider boundary, then localize the new codes in the Renderer. Keep the current media orchestration, persistence, retry policy, and strict `{ code, message }` cross-process shape unchanged.

**Tech Stack:** TypeScript 6, Zod 4, Vitest 4, Electron 43, Vue 3.

## Global Constraints

- Do not change Seedream or any other model request parameters.
- Do not add paid requests, automatic media replay, or a retry button.
- Do not change the streaming text retry state machine.
- Do not persist or expose raw provider messages, request bodies, API keys, or unrestricted metadata.
- Do not change the database schema, proxy settings, model catalog, or media storage.
- Image generation must keep `retry: "never"` and exactly one POST attempt.
- Existing 401, 403, and cancellation semantics must remain unchanged.

---

### Task 1: Extend the shared safe AppError contract

**Files:**
- Modify: `packages/shared/src/contracts.test.ts:358-380`
- Modify: `packages/shared/src/errors.ts:3-84`

**Interfaces:**
- Consumes: existing `appErrorCodeSchema`, `AppErrorCode`, and `toSafeAppError(error: unknown): AppError`.
- Produces: five new `AppErrorCode` members: `MODEL_PROVIDER_INVALID_REQUEST`, `MODEL_PROVIDER_PAYMENT_REQUIRED`, `MODEL_PROVIDER_RATE_LIMITED`, `MODEL_PROVIDER_TIMEOUT`, and `MODEL_PROVIDER_UNAVAILABLE`.

- [ ] **Step 1: Write the failing shared-contract test**

Add after the existing safe media error-code test:

```ts
it.each([
  ['MODEL_PROVIDER_INVALID_REQUEST', 'The model provider rejected the request.'],
  ['MODEL_PROVIDER_PAYMENT_REQUIRED', 'The model provider account has insufficient credit.'],
  ['MODEL_PROVIDER_RATE_LIMITED', 'The model provider rate limited the request.'],
  ['MODEL_PROVIDER_TIMEOUT', 'The model provider request timed out.'],
  ['MODEL_PROVIDER_UNAVAILABLE', 'The model provider is unavailable.'],
] as const)('keeps %s as a fixed safe provider error', (code, message) => {
  expect(appErrorCodeSchema.parse(code)).toBe(code)
  expect(toSafeAppError({ code, message: 'RAW_PROVIDER_MESSAGE' })).toEqual({ code, message })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run packages/shared/src/contracts.test.ts
```

Expected: FAIL because `appErrorCodeSchema.parse` rejects the first new provider code.

- [ ] **Step 3: Add the five codes and fixed safe English messages**

Add the codes immediately after `MODEL_PROVIDER_ACCESS_DENIED` in `appErrorCodeSchema` and the matching entries after the existing access-denied message:

```ts
  'MODEL_PROVIDER_INVALID_REQUEST',
  'MODEL_PROVIDER_PAYMENT_REQUIRED',
  'MODEL_PROVIDER_RATE_LIMITED',
  'MODEL_PROVIDER_TIMEOUT',
  'MODEL_PROVIDER_UNAVAILABLE',
```

```ts
  MODEL_PROVIDER_INVALID_REQUEST: 'The model provider rejected the request.',
  MODEL_PROVIDER_PAYMENT_REQUIRED: 'The model provider account has insufficient credit.',
  MODEL_PROVIDER_RATE_LIMITED: 'The model provider rate limited the request.',
  MODEL_PROVIDER_TIMEOUT: 'The model provider request timed out.',
  MODEL_PROVIDER_UNAVAILABLE: 'The model provider is unavailable.',
```

- [ ] **Step 4: Run the shared-contract test and verify GREEN**

Run the Step 2 command again.

Expected: PASS with no warnings or leaked `RAW_PROVIDER_MESSAGE` text.

- [ ] **Step 5: Commit the shared contract**

```bash
git add packages/shared/src/errors.ts packages/shared/src/contracts.test.ts
git commit -m "feat: classify safe model provider failures"
```

### Task 2: Classify bounded non-streaming provider failures

**Files:**
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.test.ts:1006-1095`
- Modify: `apps/desktop/electron/main/chat/model-provider.ts:413-444,1005-1104`

**Interfaces:**
- Consumes: the five AppError codes from Task 1, HTTP status, and bounded `{ code?: string | number; error_type?: string }` metadata.
- Produces: private `classifiedProviderFailure(status: number, metadata: ProviderErrorMetadata): AppError`; `readDiagnostic(...)` returns `Promise<ProviderErrorMetadata>` while retaining its observational callback.

- [ ] **Step 1: Change the existing media HTTP table to require specific codes**

Replace its cases with:

```ts
it.each([
  [400, 'MODEL_PROVIDER_INVALID_REQUEST'],
  [401, 'CREDENTIAL_INVALID'],
  [402, 'MODEL_PROVIDER_PAYMENT_REQUIRED'],
  [403, 'MODEL_PROVIDER_ACCESS_DENIED'],
  [408, 'MODEL_PROVIDER_TIMEOUT'],
  [429, 'MODEL_PROVIDER_RATE_LIMITED'],
  [500, 'MODEL_PROVIDER_UNAVAILABLE'],
  [502, 'MODEL_PROVIDER_UNAVAILABLE'],
  [503, 'MODEL_PROVIDER_UNAVAILABLE'],
  [504, 'MODEL_PROVIDER_TIMEOUT'],
] as const)('maps media HTTP %s safely with bounded diagnostics', async (status, code) => {
  const diagnostic = vi.fn()
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    error: {
      code: status,
      message: `RAW_PROVIDER_BODY_${'x'.repeat(3_000)}`,
      metadata: { error_type: 'upstream_error' },
    },
  }), { status }))
  const provider = new OpenRouterProvider({
    credential,
    fetch,
    diagnostic,
    sleep: vi.fn(async () => undefined),
  })

  await expect(provider.generateImage({
    model: 'image/model',
    prompt: 'draw',
    options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
    parameterSupport: allImageParameters,
    references: [],
  })).rejects.toMatchObject({ code })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('RAW_PROVIDER_BODY')
  expect(JSON.stringify(diagnostic.mock.calls).length).toBeLessThan(2_000)
})
```

- [ ] **Step 2: Add a failing `error_type` precedence test**

```ts
it.each([
  ['payment_required', 'MODEL_PROVIDER_PAYMENT_REQUIRED'],
  ['rate_limit_exceeded', 'MODEL_PROVIDER_RATE_LIMITED'],
  ['timeout', 'MODEL_PROVIDER_TIMEOUT'],
  ['provider_overloaded', 'MODEL_PROVIDER_UNAVAILABLE'],
  ['content_policy_violation', 'MODEL_PROVIDER_ACCESS_DENIED'],
  ['invalid_request', 'MODEL_PROVIDER_INVALID_REQUEST'],
] as const)('prefers provider error type %s for media failures', async (errorType, code) => {
  const provider = new OpenRouterProvider({
    credential,
    fetch: vi.fn(async () => Response.json({
      error: {
        code: 400,
        message: 'RAW_PROVIDER_MESSAGE',
        metadata: { error_type: errorType },
      },
    }, { status: 400 })),
  })

  const error = await rejection(provider.generateImage({
    model: 'image/model',
    prompt: 'draw',
    options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
    parameterSupport: allImageParameters,
    references: [],
  }))

  expect(error).toMatchObject({ code })
  expect(JSON.stringify(error)).not.toContain('RAW_PROVIDER_MESSAGE')
})
```

- [ ] **Step 3: Run the focused Provider tests and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts
```

Expected: FAIL because 400/402/408/429/5xx still return `MODEL_PROVIDER_REQUEST_FAILED`.

- [ ] **Step 4: Add the private classifier and exact error-type allowlists**

Add beside `providerErrorMetadata`:

```ts
type ProviderErrorMetadata = ReturnType<typeof providerErrorMetadata>

const INVALID_PROVIDER_ERROR_TYPES = new Set([
  'context_length_exceeded',
  'max_tokens_exceeded',
  'token_limit_exceeded',
  'string_too_long',
  'invalid_request',
  'invalid_prompt',
  'not_found',
  'precondition_failed',
  'payload_too_large',
  'unprocessable',
  'invalid_image',
  'image_too_large',
  'image_too_small',
  'unsupported_image_format',
  'image_not_found',
  'image_download_failed',
])

function classifiedProviderFailure(status: number, metadata: ProviderErrorMetadata): AppError {
  const errorType = metadata.error_type?.toLowerCase()
  if (errorType === 'authentication') return failure('CREDENTIAL_INVALID')
  if (errorType === 'permission_denied'
    || errorType === 'content_policy_violation'
    || errorType === 'refusal') return failure('MODEL_PROVIDER_ACCESS_DENIED')
  if (errorType === 'payment_required') return failure('MODEL_PROVIDER_PAYMENT_REQUIRED')
  if (errorType === 'rate_limit_exceeded') return failure('MODEL_PROVIDER_RATE_LIMITED')
  if (errorType === 'timeout') return failure('MODEL_PROVIDER_TIMEOUT')
  if (errorType === 'provider_overloaded'
    || errorType === 'provider_unavailable'
    || errorType === 'server'
    || errorType === 'unmapped') return failure('MODEL_PROVIDER_UNAVAILABLE')
  if (errorType && INVALID_PROVIDER_ERROR_TYPES.has(errorType)) {
    return failure('MODEL_PROVIDER_INVALID_REQUEST')
  }

  const code = numericProviderCode(metadata.code) ?? status
  if ([400, 404, 409, 412, 413, 422].includes(code)) {
    return failure('MODEL_PROVIDER_INVALID_REQUEST')
  }
  if (code === 401) return failure('CREDENTIAL_INVALID')
  if (code === 402) return failure('MODEL_PROVIDER_PAYMENT_REQUIRED')
  if (code === 403) return failure('MODEL_PROVIDER_ACCESS_DENIED')
  if (code === 408 || code === 504) return failure('MODEL_PROVIDER_TIMEOUT')
  if (code === 429) return failure('MODEL_PROVIDER_RATE_LIMITED')
  if (code === 500 || code === 502 || code === 503) {
    return failure('MODEL_PROVIDER_UNAVAILABLE')
  }
  return failure('MODEL_PROVIDER_REQUEST_FAILED')
}
```

- [ ] **Step 5: Return bounded metadata from diagnostic reads and use the classifier**

Change `readDiagnostic` to `Promise<ProviderErrorMetadata>`, remove its early return, keep the callback best-effort, and return `metadata`:

```ts
private async readDiagnostic(
  operation: ProviderOperation,
  response: Response,
  signal?: AbortSignal,
): Promise<ProviderErrorMetadata> {
  let metadata: ProviderErrorMetadata = {}
  try {
    const parsed = JSON.parse(await boundedResponseText(response, signal)) as unknown
    const envelope = z.object({ error: providerErrorSchema.optional() }).strict().safeParse(parsed)
    const direct = providerErrorSchema.safeParse(parsed)
    metadata = providerErrorMetadata(envelope.success && envelope.data.error
      ? envelope.data.error
      : direct.success ? direct.data : undefined)
  } catch (error) {
    if (isAbort(error, signal)) throw failure('CANCELLED')
  }
  if (this.dependencies.diagnostic) {
    try {
      this.dependencies.diagnostic({ operation, status: response.status, ...metadata })
    } catch { /* diagnostics are observational */ }
  }
  return metadata
}
```

Use the returned metadata in `throwHttpFailure`:

```ts
const metadata = await this.readDiagnostic(operation, response, signal)
if (signal?.aborted) throw failure('CANCELLED')
throw classifiedProviderFailure(response.status, metadata)
```

In the 429/5xx branch of `authenticatedFetch`, retain retry timing but classify the terminal attempt:

```ts
const metadata = await this.readDiagnostic(operation, response, signal)
if (attempt === maxAttempts - 1) {
  throw classifiedProviderFailure(response.status, metadata)
}
await this.retryDelay(attempt, retryAfter(response), signal)
```

- [ ] **Step 6: Keep paid POST tests aligned with the new terminal identities**

In both the existing “attempts a paid image POST only once” and paid video submission tests, compute the expected code before the rejection assertion:

```ts
const expectedCode = failure === 'network'
  ? 'MODEL_PROVIDER_REQUEST_FAILED'
  : failure === 429
    ? 'MODEL_PROVIDER_RATE_LIMITED'
    : 'MODEL_PROVIDER_UNAVAILABLE'
```

Then replace the old fixed error assertion with:

```ts
await expect(provider.generateImage({
  model: 'image/model',
  prompt: 'draw',
  options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
  parameterSupport: allImageParameters,
  references: [],
})).rejects.toMatchObject({ code: expectedCode })
```

For the video submission test, use the same `expectedCode` calculation and this exact assertion:

```ts
await expect(provider.submitVideo({
  model: 'video/model',
  prompt: 'animate',
  options: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
  references: [],
  frameImages: [],
})).rejects.toMatchObject({ code: expectedCode })
```

Keep the existing assertions that `fetch` is called once and `sleep` is not called.

- [ ] **Step 7: Run focused Provider tests and verify GREEN**

Run the Step 3 command again.

Expected: PASS; paid image/video POST failure cases still report exactly one fetch and zero sleeps.

- [ ] **Step 8: Commit Provider classification**

```bash
git add apps/desktop/electron/main/chat/model-provider.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts
git commit -m "fix: preserve model provider failure categories"
```

### Task 3: Localize actionable chat failure messages

**Files:**
- Modify: `apps/desktop/tests/components/chat.test.ts:765-780`
- Modify: `apps/desktop/src/services/desktop-api.ts:20-50`

**Interfaces:**
- Consumes: the five AppError codes from Task 1.
- Produces: fixed Chinese Renderer messages returned by `displayError(error, fallback?)`.

- [ ] **Step 1: Add the five failing localization cases**

Add to the existing `it.each` table:

```ts
['MODEL_PROVIDER_INVALID_REQUEST', '供应商不接受当前模型参数，请刷新模型列表或调整生成设置'],
['MODEL_PROVIDER_PAYMENT_REQUIRED', '供应商账户或 API Key 额度不足，请充值或检查限额'],
['MODEL_PROVIDER_RATE_LIMITED', '供应商请求过于频繁，请稍后重试'],
['MODEL_PROVIDER_TIMEOUT', '供应商响应超时，请稍后重试'],
['MODEL_PROVIDER_UNAVAILABLE', '供应商或所选模型暂时不可用，请稍后重试'],
```

- [ ] **Step 2: Run the focused Renderer test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts
```

Expected: FAIL because `displayError` falls back instead of returning the new messages.

- [ ] **Step 3: Add the fixed message mappings**

Add after `MODEL_PROVIDER_ACCESS_DENIED` in `messages`:

```ts
MODEL_PROVIDER_INVALID_REQUEST: '供应商不接受当前模型参数，请刷新模型列表或调整生成设置',
MODEL_PROVIDER_PAYMENT_REQUIRED: '供应商账户或 API Key 额度不足，请充值或检查限额',
MODEL_PROVIDER_RATE_LIMITED: '供应商请求过于频繁，请稍后重试',
MODEL_PROVIDER_TIMEOUT: '供应商响应超时，请稍后重试',
MODEL_PROVIDER_UNAVAILABLE: '供应商或所选模型暂时不可用，请稍后重试',
```

- [ ] **Step 4: Run the focused Renderer test and verify GREEN**

Run the Step 2 command again.

Expected: PASS; the existing unsafe `message` argument remains ignored.

- [ ] **Step 5: Commit Renderer localization**

```bash
git add apps/desktop/src/services/desktop-api.ts apps/desktop/tests/components/chat.test.ts
git commit -m "feat: explain model provider failures in chat"
```

### Task 4: Verify the complete change

**Files:**
- Verify: files changed by Tasks 1-3; do not add production edits during this task unless a verification failure proves they are required.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: evidence that focused tests, full tests, type checking, linting, and build remain healthy.

- [ ] **Step 1: Run all three focused suites**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run packages/shared/src/contracts.test.ts
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 2: Run type checking**

```bash
pnpm typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Run lint**

```bash
pnpm lint
```

Expected: exit code 0 with no new warnings.

- [ ] **Step 4: Run the complete automated test suite**

```bash
pnpm test
```

Expected: exit code 0. If an unrelated pre-existing failure appears, record it separately and do not modify unrelated code.

- [ ] **Step 5: Run the production build**

```bash
pnpm build
```

Expected: exit code 0.

- [ ] **Step 6: Check security and change scope**

```bash
rg -n 'RAW_PROVIDER|DEBUG-' packages/shared/src/errors.ts apps/desktop/src/services apps/desktop/electron/main/chat/model-provider.ts
git diff --check
git status --short
```

Expected: `rg` finds no production `RAW_PROVIDER` or `DEBUG-` instrumentation; `git diff --check` exits 0; only intentional commits/files are present.
