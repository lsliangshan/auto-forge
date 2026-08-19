# OpenRouter Billing Final Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every Critical/Important finding from the whole-branch billing review so every paid OpenRouter operation is attributed to the correct local user and credential, reconciliation is stoppable, shutdown preserves errors while cleaning up, and legacy jobs remain recoverable.

**Architecture:** Three deep modules concentrate the hard invariants: credential-bound provider snapshots, a tracked streaming usage adapter, and a cancellable reconciliation loop. Existing orchestrators consume these interfaces; `VideoJobRunner` keeps legacy classification internal because it is the only consumer. The provider usage ledger remains the single source of truth and no raw API key is persisted or logged.

**Tech Stack:** TypeScript, Electron, Vitest, SQLite/better-sqlite3, Zod, OpenRouter HTTP/SSE adapters.

## Global Constraints

- Use only OpenRouter returned `usage.cost` or generation `total_cost`; never add the two or derive history from current prices.
- Keep all USD values as canonical decimal strings; no floating-point accumulation and no SQL `SUM(cost_usd)`.
- IPC accepts no `userId`; attribution always comes from the authenticated Application session.
- Raw API keys must not enter SQLite, logs, serialized jobs, UI contracts, or enumerable snapshot metadata.
- DeepSeek never creates OpenRouter usage events and never serializes OpenRouter `end_user` semantics.
- Unknown cost remains `unknown`; never replace it with zero.
- Preserve the user-approved Token policy: any valid recorded tokens count regardless of run status.
- No paid smoke test. Real OpenRouter Activity/Generation comparison remains a later manual check.
- Apply TDD for every behavior change, commit each task, and require an independent read-only review before the next task.

---

### Task 1: Harden Ledger Replay and Decimal Parsing

**Files:**

- Modify: `apps/desktop/electron/main/database/repositories.ts`
- Modify: `apps/desktop/electron/main/database/database.test.ts`
- Modify: `apps/desktop/electron/main/billing/decimal-usd.ts`
- Modify: `apps/desktop/electron/main/billing/decimal-usd.test.ts`

**Interfaces:**

- Consumes: existing `ProviderUsageRepository.start()` and `normalizeUsd()` / `addUsd()`.
- Produces: logical `start()` replay keyed by `operationKey`, plus bounded decimal parsing safe for untrusted provider strings.

- [ ] **Step 1: Write failing replay tests**

  Add a database test proving that replaying the same semantic operation with a new storage `id` and new `startedAt` returns the original stored event without inserting or throwing, while any changed attribution (`userId`, provider, fingerprint, request/chat run, model, modality) still throws `ProviderUsageConsistencyError`. Keep the existing test that reusing one `id` for a different operation throws.

- [ ] **Step 2: Run database RED**

  Run:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/database/database.test.ts
  ```

  Expected: the new replay with different id/time fails against exact-field equality.

- [ ] **Step 3: Implement semantic replay**

  Treat `operationKey` as the logical idempotency key. On conflict, compare immutable billing attribution fields but retain and return the first event's `id` and `startedAt`. Do not overwrite any stored field. Continue rejecting a supplied `id` already owned by a different operation.

- [ ] **Step 4: Write failing decimal resource-limit tests**

  Cover values such as `1e1000000000`, a decimal with more than 1,024 digits, and a fraction/exponent whose resulting scale exceeds the chosen bounded constant. The expected failure is a fast `TypeError`, not allocation or timeout. Preserve ordinary scientific notation such as `1e-7`.

- [ ] **Step 5: Implement bounded parsing and verify**

  Before `BigInt` construction or exponentiation, enforce explicit source-length, digit-count, exponent and resulting-scale limits. Constants must be named and tested; reject outside the bounds before any large `10n ** exponent` operation.

  Run database and decimal tests, Desktop Node typecheck, and `git diff --check`.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/desktop/electron/main/database/repositories.ts apps/desktop/electron/main/database/database.test.ts apps/desktop/electron/main/billing/decimal-usd.ts apps/desktop/electron/main/billing/decimal-usd.test.ts
  git commit -m "fix: harden billing replay and decimal parsing"
  ```

---

### Task 2: Add Credential-Bound Provider Snapshots

**Files:**

- Modify: `apps/desktop/electron/main/chat/model-provider.ts`
- Modify: `apps/desktop/electron/main/chat/model-provider-registry.ts`
- Modify: `apps/desktop/electron/main/chat/model-provider-registry.test.ts`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.ts`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.test.ts`
- Modify: `apps/desktop/electron/main/chat/deepseek-provider.ts`
- Modify: `apps/desktop/electron/main/chat/deepseek-provider.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export interface ModelProviderSnapshot {
    providerId: ModelProviderId
    provider: ModelProvider
    apiKeyFingerprint?: string
  }

  export interface ModelProviderSnapshotSource {
    acquire(providerId: ModelProviderId): Promise<ModelProviderSnapshot>
  }
  ```

- Snapshot invariants: OpenRouter has a fingerprint, DeepSeek does not; the returned provider is closed over one credential value for its lifetime; retry never rereads mutable storage; no public/enumerable snapshot field exposes the secret.

- [ ] **Step 1: Write snapshot RED tests**

  Acquire with key A, mutate the underlying credential adapter to B, then invoke and retry through the acquired provider. Assert every Authorization header uses A and fingerprint equals `fingerprintApiKey(A)`. A second acquire must use B. Assert `JSON.stringify(snapshot)` and `Object.keys(snapshot)` contain neither key.

- [ ] **Step 2: Run registry/provider RED**

  Run registry, OpenRouter and DeepSeek provider tests. Expected: current registry returns mutable providers and retries reread credentials.

- [ ] **Step 3: Implement snapshot source**

  Read the secret once inside `acquire()`, create a request-scoped provider adapter whose credential port always returns that captured value, compute only the fingerprint for the public snapshot, and preserve injected fetch/sleep/random/diagnostic dependencies. A missing key must use the existing credential-unavailable error.

- [ ] **Step 4: Verify provider behavior**

  Verify catalog, credential validation, stream, image, video and generation lookup can all operate through the bound adapter. DeepSeek snapshots must not expose an OpenRouter fingerprint and must continue omitting `user` serialization.

- [ ] **Step 5: Commit**

  Run focused provider/registry tests, Node typecheck and diff check, then commit:

  ```bash
  git add apps/desktop/electron/main/chat/model-provider.ts apps/desktop/electron/main/chat/model-provider-registry.ts apps/desktop/electron/main/chat/model-provider-registry.test.ts apps/desktop/electron/main/chat/openrouter-provider.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts apps/desktop/electron/main/chat/deepseek-provider.ts apps/desktop/electron/main/chat/deepseek-provider.test.ts
  git commit -m "feat: bind provider calls to credential snapshots"
  ```

---

### Task 3: Track Context Compression and Use Exact Agent Compatibility Cost

**Files:**

- Create: `apps/desktop/electron/main/billing/provider-usage-stream.ts`
- Create: `apps/desktop/electron/main/billing/provider-usage-stream.test.ts`
- Modify: `apps/desktop/electron/main/chat/conversation-context.ts`
- Modify: `apps/desktop/electron/main/chat/conversation-context.test.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- Modify: `apps/desktop/tests/integration/agent-workflow.test.ts`

**Interfaces:**

- Consumes: `ModelProviderSnapshot` from Task 2 and the existing provider usage repository.
- Produces an internal tracked stream adapter:

  ```ts
  trackProviderStream({
    operationKey,
    attribution,
    request,
    provider,
    providerUsage,
    id,
    now,
  }): AsyncIterable<ModelStreamEvent>
  ```

- `PrepareConversationContextInput` receives `providerSnapshot` and a call identity `{ requestId, chatRunId, userId }`; raw secrets and repositories are not per-call inputs.
- Summary operation key: `conversation-summary:${requestId}:${expectedThroughOrdinal}:${throughOrdinal}`.

- [ ] **Step 1: Write tracked stream RED tests**

  Cover start before stream, generation binding, one exact usage report, unknown on no cost, reported cost surviving cancellation/local failure, generation surviving as unknown, early consumer return, and direct propagation of `ProviderUsageConsistencyError`.

- [ ] **Step 2: Implement the tracked stream module**

  Keep all `start → bind → report → finally unknown` behavior in this module. Never add different cost sources. `finally` must not overwrite a reported row.

- [ ] **Step 3: Write real context compression RED tests**

  Use the real context manager and SQLite for single- and multi-round compression. Assert stable distinct keys, session user attribution, fingerprint, `endUserId`, generation/cost handling, cancellation, and `conversationContexts.advance()` failure after cost persistence. Assert DeepSeek compression writes no ledger event.

- [ ] **Step 4: Integrate context and Agent**

  Pass the acquired snapshot and call identity from Agent to history. Use the same snapshot for summary and normal model turns. Replace Agent's duplicated stream ledger lifecycle with the tracked adapter where practical. Do not convert consistency errors to ordinary context conflicts.

- [ ] **Step 5: Replace floating compatibility accumulation**

  Replace `Number(...).toFixed(12)` with `addUsd([active.costUsd ?? '0', turnUsage.costUsd])`. Test `9007199254740992.000000000001 + 0.000000000009`, tiny values, zero, and undefined.

- [ ] **Step 6: Verify and commit**

  Run provider-usage-stream, conversation-context, Agent and agent-workflow integration tests, Node typecheck and diff check. Commit:

  ```bash
  git add apps/desktop/electron/main/billing/provider-usage-stream.ts apps/desktop/electron/main/billing/provider-usage-stream.test.ts apps/desktop/electron/main/chat/conversation-context.ts apps/desktop/electron/main/chat/conversation-context.test.ts apps/desktop/electron/main/agent/agent-orchestrator.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts apps/desktop/tests/integration/agent-workflow.test.ts
  git commit -m "fix: account for context compression usage"
  ```

---

### Task 4: Adopt Snapshots for Image and Audio

**Files:**

- Modify: `apps/desktop/electron/main/chat/media-generation-orchestrator.ts`
- Modify: `apps/desktop/electron/main/chat/media-generation-orchestrator.test.ts`

**Interfaces:**

- Consumes `ModelProviderSnapshotSource.acquire()` and the tracked stream adapter for audio.
- Produces image/audio operations whose fingerprint and Authorization credential come from one snapshot.

- [ ] **Step 1: Write key-switch and ledger RED tests**

  For image and audio, acquire key A, switch backing storage to B before fetch, and assert the request uses A while the ledger stores fingerprint A. Assert a later request uses B. Preserve cancellation and local-save-after-cost tests.

- [ ] **Step 2: Implement snapshot adoption**

  Acquire once per image/audio operation. The orchestrator must not accept a caller-computed fingerprint. Use the snapshot provider for all retries and pass snapshot fingerprint only to ledger attribution.

- [ ] **Step 3: Verify and commit**

  Run media generation tests, Node typecheck and diff check. Commit:

  ```bash
  git add apps/desktop/electron/main/chat/media-generation-orchestrator.ts apps/desktop/electron/main/chat/media-generation-orchestrator.test.ts
  git commit -m "fix: bind media billing to provider snapshots"
  ```

---

### Task 5: Make Reconciliation Cancellable and Finite

**Files:**

- Modify: `apps/desktop/electron/main/billing/provider-usage-reconciler.ts`
- Modify: `apps/desktop/electron/main/billing/provider-usage-reconciler.test.ts`
- Create: `apps/desktop/electron/main/billing/provider-usage-reconciliation-loop.ts`
- Create: `apps/desktop/electron/main/billing/provider-usage-reconciliation-loop.test.ts`

**Interfaces:**

- Consumes `ModelProviderSnapshotSource`.
- Reconciler methods accept `{ signal: AbortSignal, now?: number }` and pass the signal to generation lookup.
- Produces:

  ```ts
  interface ProviderUsageReconciliationLoop {
    start(): void
    notifyUsageEnded(): void
    stop(): Promise<void>
  }
  ```

- [ ] **Step 1: Write Reconciler abort RED tests**

  Cover abort before fetch, abort during a never-resolving fetch, no attempt increment on cancellation, missing credential/capability/fingerprint mismatch, and one snapshot shared by fingerprint comparison and lookup.

- [ ] **Step 2: Implement signal-aware Reconciler**

  Check the signal before acquiring, before each event and before fetch. Pass it to `getGenerationUsage`. Treat self-cancellation as cancellation, not a reconcile failure. Keep the ledger's 1s/5s/30s schedule as the only reconciliation budget.

- [ ] **Step 3: Write loop RED tests**

  Verify serialized recovery, relative finite rounds, timer coalescing, stop clearing timers, stop aborting in-flight fetch, tail drain, and preservation of the first unexpected/consistency failure.

- [ ] **Step 4: Implement the loop and commit**

  Hide timer, tail and AbortController state inside the loop. Run both billing suites, Node typecheck and diff check. Commit:

  ```bash
  git add apps/desktop/electron/main/billing/provider-usage-reconciler.ts apps/desktop/electron/main/billing/provider-usage-reconciler.test.ts apps/desktop/electron/main/billing/provider-usage-reconciliation-loop.ts apps/desktop/electron/main/billing/provider-usage-reconciliation-loop.test.ts
  git commit -m "fix: make usage reconciliation cancellable"
  ```

---

### Task 6: Support Snapshot-Safe and Legacy Video Recovery

**Files:**

- Modify: `apps/desktop/electron/main/database/repositories.ts`
- Modify: `apps/desktop/electron/main/database/database.test.ts`
- Modify: `apps/desktop/electron/main/chat/video-job-runner.ts`
- Modify: `apps/desktop/electron/main/chat/video-job-runner.test.ts`

**Interfaces:**

- Add repository lookups `chatRuns.getByRequestId(requestId)` and `providerUsage.find(operationKey)`.
- Runner-internal classification:
  - non-OpenRouter → untracked;
  - OpenRouter run with null legacy `userId/provider` → legacy-unattributed;
  - OpenRouter run owned by a user/provider → tracked;
  - contradictory combinations → `ProviderUsageConsistencyError`.

- [ ] **Step 1: Write migration/recovery RED tests**

  Build a real v4 active OpenRouter video fixture, migrate to v5, then cover completed/downloaded, provider failed and download failed outcomes. All legacy paths must reach normal terminal state with zero ledger writes. A v5 owned job missing its ledger event must throw consistency error.

- [ ] **Step 2: Write video snapshot RED tests**

  Current-process polling/download keeps the submit snapshot. After restart, a tracked job with a different current fingerprint must not poll or consume attempts; restoring the matching credential resumes. Legacy jobs may use the current credential only to finish and are never attributed retroactively.

- [ ] **Step 3: Implement lookups and internal classification**

  Do not classify solely by missing ledger event. Do not create guessed users or backfill historical cost. Keep all classification inside `VideoJobRunner`.

- [ ] **Step 4: Verify and commit**

  Run database/video tests, Node typecheck and diff check. Commit:

  ```bash
  git add apps/desktop/electron/main/database/repositories.ts apps/desktop/electron/main/database/database.test.ts apps/desktop/electron/main/chat/video-job-runner.ts apps/desktop/electron/main/chat/video-job-runner.test.ts
  git commit -m "fix: recover legacy video jobs without false billing"
  ```

---

### Task 7: Compose Application Lifecycles and Surface Billing Failures

**Files:**

- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts` only if fixtures require the final interface.

**Interfaces:**

- Consumes all Tasks 2–6 interfaces.
- Removes caller-computed fingerprint reads and the old reconciliation timer/tail implementation.
- Application owns a private failure latch and a single `trackChatWork()` helper.

- [ ] **Step 1: Write Application RED tests**

  Cover real provider key A → switch B barriers, summary billing through Application, Agent/Image/Audio consistency rejection reaching the latch, refusal of new work after consistency failure, and close rethrowing the original typed error.

- [ ] **Step 2: Write shutdown RED tests**

  A never-returning generation lookup must receive abort and allow close to finish. If `videoJobs.stop()` throws, Agent/media cancellation, active work drain, execution shutdown, reconciliation stop and database close must all still occur. Multiple failures must use deterministic priority with consistency error first.

- [ ] **Step 3: Integrate provider snapshot source and reconciliation loop**

  Application no longer reads the OpenRouter key merely to compute a fingerprint. Catalog/validation and each operation use acquired bound snapshots. Remove the obsolete registry/get or temporary dual interface only after every consumer is migrated.

- [ ] **Step 4: Implement background failure latch**

  Ordinary business failures remain represented by orchestrator results/terminal state. Unexpected rejected promises are latched; `ProviderUsageConsistencyError` sets `acceptingWork = false`. Do not use unconditional `.catch(() => undefined)` for Agent/Image/Audio work.

- [ ] **Step 5: Implement cleanup-all-then-throw close**

  Stop admission, abort reconciliation, drain admission, stop video, cancel other runners, drain chat work, shut down executions and close the database even if an earlier step fails. Preserve the first consistency failure and throw only after all cleanup has settled.

- [ ] **Step 6: Verify and commit**

  Run Application, IPC, Agent, media, video and reconciliation tests, full Desktop typecheck and diff check. Commit:

  ```bash
  git add apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/ipc/register-ipc.test.ts
  git commit -m "fix: surface billing failures through application shutdown"
  ```

---

### Task 8: Full Regression and Final Review

**Files:**

- Modify only if a new test proves a defect in the files listed above.
- Append evidence to `.superpowers/sdd/task-10-report.md` without committing process reports.

- [ ] **Step 1: Run focused billing suites**

  Run decimal, database, provider registry/providers, tracked stream, context, reconciler/loop, Agent, media, video, Application, IPC, shared contracts and UI tests. All must pass.

- [ ] **Step 2: Run full commands**

  ```bash
  pnpm typecheck
  pnpm test
  pnpm lint
  pnpm build
  git diff --check
  ```

  Report the exact status of each. Existing unrelated lint/test flakes may be identified with file history and isolated reruns but must not be called passing.

- [ ] **Step 3: Request a whole-branch review**

  Review from `32c5a01` to the new HEAD. Recheck every prior Critical/Important plus raw-key storage/logging, duplicate cost sources, renderer user injection, delete cascades and all modalities.

- [ ] **Step 4: Prepare manual reconciliation only**

  Do not create a paid script or issue a paid request. State: “自动化契约验证通过，等待真实 generation 与官网 Activity/Generation 人工对账” until a user-generated OpenRouter operation is compared.

---

## Self-Review

- Spec coverage: all seven whole-branch findings plus semantic start replay and bounded decimal parsing map to Tasks 1–7.
- Type consistency: snapshot source is introduced in Task 2, consumed by Tasks 3–7; Application composition is intentionally last.
- File overlap: Tasks are sequential. Agent decimal and context are together; Application is isolated to Task 7; repository changes occur in Tasks 1 and 6 with independent tests and reviews.
- Placeholder scan: no TBD/TODO or unspecified implementation step remains.
