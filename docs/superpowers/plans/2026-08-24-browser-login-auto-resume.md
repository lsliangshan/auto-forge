# Browser Login Auto-Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a same-turn browser-backed chat request alive while the user logs in, then resume automatically and answer only from fresh authenticated page evidence.

**Architecture:** Main keeps the continuation lease logically reserved while Electron suspends its input shield, so user input is unrestricted but competing automation remains blocked. A Main-process event-driven coordinator classifies authentication with adaptive fallback checks; the executor promotes the suspended tab back to automation, and the Agent forces a fresh inspection after refreshing same-turn workflow bindings.

**Tech Stack:** TypeScript 6, Electron 43 `WebContentsView`/CDP, Vue 3, Vitest 4, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-24-browser-login-auto-resume-design.md`

## Global Constraints

- Waiting is indefinite but does not survive application restart.
- Login waiting performs no model request and does not count against the five-minute active browser-tool budget.
- Login probes never retain or expose password, OTP, CAPTCHA, form values, raw page text, or snapshots.
- `required` and `unknown` keep waiting; only `authenticated` resumes.
- Non-login handoffs remain terminal.
- Automated verification must remain headless; do not open a visible browser.
- Preserve all pre-existing uncommitted changes and do not commit overlapping user-owned edits.

## File Structure

- Create `apps/desktop/electron/main/browser/browser-login-wait-coordinator.ts`: event/timer wait state only.
- Create `apps/desktop/electron/main/browser/browser-login-wait-coordinator.test.ts`: deterministic fake-timer contract tests.
- Modify `apps/desktop/electron/main/browser/electron-browser-workspace.ts`: suspended continuation ownership and shield/input behavior.
- Modify `apps/desktop/electron/main/browser/electron-browser-workspace.test.ts`: suspension, promotion, close, and competing acquisition tests.
- Modify `apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts`: authentication suspension, wait, probe, and promotion.
- Modify `apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts`: executor wait/resume and cleanup tests.
- Modify `apps/desktop/electron/main/agent/agent-orchestrator.ts`: same-turn catalog refresh and host-forced post-login inspection.
- Modify `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`: full run regression and no-model-while-waiting assertions.
- Modify `apps/desktop/electron/main/application.ts`: construct and inject the coordinator.
- Modify `apps/desktop/electron/main/application.test.ts`: lifecycle wiring and cancellation coverage.
- Modify `apps/desktop/src/components/chat/BrowserStatusCard.vue`: non-terminal login-wait actions and copy.
- Modify `apps/desktop/tests/components/chat.test.ts`: waiting-card interaction contract.

---

### Task 1: Event-driven login wait coordinator

**Files:**
- Create: `apps/desktop/electron/main/browser/browser-login-wait-coordinator.ts`
- Create: `apps/desktop/electron/main/browser/browser-login-wait-coordinator.test.ts`

**Interfaces:**
- Consumes: `onPageInvalidated(listener): () => void`, an `AbortSignal`, and a bounded async probe returning `authenticated | required | unknown`.
- Produces:

```ts
export type BrowserAuthenticationState = 'authenticated' | 'required' | 'unknown'

export interface BrowserLoginWaitInput {
  readonly runId: string
  readonly tabId: string
  readonly signal?: AbortSignal
  readonly probe: () => Promise<BrowserAuthenticationState>
}

export class BrowserLoginWaitCoordinator {
  constructor(options: {
    onPageInvalidated(listener: (tabId: string) => void): () => void
    now?: () => number
    setTimer?: (callback: () => void, delayMs: number) => unknown
    clearTimer?: (handle: unknown) => void
  })
  wait(input: BrowserLoginWaitInput): Promise<void>
  cancel(runId: string): void
  dispose(): void
}
```

- [ ] **Step 1: Write failing coordinator tests**

Cover these exact cases with fake timers: an unrelated tab event is ignored; matching events debounce for 500 ms; `required` and `unknown` reschedule; `authenticated` resolves; fallback runs at 3 seconds during the first minute and 10 seconds afterward; concurrent `wait` for one run rejects with `CONFLICT`; abort rejects with `CANCELLED`; `cancel` and `dispose` clear both event and fallback timers exactly once.

```ts
it('resolves only after the bound tab is authenticated', async () => {
  const probe = vi.fn()
    .mockResolvedValueOnce('required')
    .mockResolvedValueOnce('authenticated')
  const waiting = coordinator.wait({ runId: 'run_1', tabId: 'tab_1', probe })
  emitInvalidated('tab_1')
  await vi.advanceTimersByTimeAsync(500)
  expect(probe).toHaveBeenCalledTimes(1)
  emitInvalidated('tab_1')
  await vi.advanceTimersByTimeAsync(500)
  await expect(waiting).resolves.toBeUndefined()
})
```

- [ ] **Step 2: Run the coordinator test and confirm RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/browser/browser-login-wait-coordinator.test.ts
```

Expected: FAIL because `BrowserLoginWaitCoordinator` does not exist.

- [ ] **Step 3: Implement the minimal coordinator**

Use one record per `runId` with separate event-debounce and fallback handles. Subscribe once at construction. Resolve only on `authenticated`; after every other successful probe schedule the next fallback from elapsed wait time. Serialize probes per waiter and coalesce events received during an in-flight probe into one later 500 ms probe.

```ts
const EVENT_DEBOUNCE_MS = 500
const INITIAL_FALLBACK_MS = 3_000
const BACKOFF_AFTER_MS = 60_000
const BACKED_OFF_FALLBACK_MS = 10_000
```

Convert thrown failures with `toSafeAppError`, preserve their safe code, and use `toSafeAppError({ code: 'CANCELLED' })` for abort/cancel.

- [ ] **Step 4: Run coordinator tests and confirm GREEN**

Run the Task 1 command. Expected: all coordinator tests pass with no pending fake timers.

---

### Task 2: Suspended continuation ownership in Electron workspace

**Files:**
- Modify: `apps/desktop/electron/main/browser/electron-browser-workspace.ts`
- Modify: `apps/desktop/electron/main/browser/electron-browser-workspace.test.ts`

**Interfaces:**
- Consumes: existing `ownerContinuationRunId`, input shield layout, `continuationState`, and continuation acquisition/release.
- Produces additions to `ApplicationBrowserWorkspacePort` and `BrowserContinuationWorkspacePort`:

```ts
suspendContinuation(tabId: string, runId: string): Promise<void>
resumeContinuation(tabId: string, runId: string): Promise<void>
```

- [ ] **Step 1: Write failing workspace tests**

Add assertions that suspension keeps `ownerContinuationRunId` reserved but detaches the shield, allows physical keyboard/mouse events without `preventDefault`, and makes a second `acquireContinuation` return `PAGE_BUSY`. Assert `resumeContinuation` reinstalls the shield before resolving. Assert page close and `releaseContinuation` work from either active or suspended state.

```ts
await workspace.suspendContinuation(tab.id, 'run_1')
expect(shieldAttached(harness)).toBe(false)
target.emit('before-input-event', inputEvent)
expect(inputEvent.preventDefault).not.toHaveBeenCalled()
await expect(workspace.acquireContinuation(tab.id, 'run_2'))
  .rejects.toMatchObject({ code: 'PAGE_BUSY' })
await workspace.resumeContinuation(tab.id, 'run_1')
expect(shieldAttached(harness)).toBe(true)
```

- [ ] **Step 2: Run focused workspace tests and confirm RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/browser/electron-browser-workspace.test.ts -t "suspended continuation"
```

Expected: FAIL because suspension methods and state do not exist.

- [ ] **Step 3: Implement suspended state**

Add `continuationSuspended: boolean` to `TargetTabState`. Initialize it to `false`; set it only after validating the exact owner. `suspendContinuation` clears highlights, sets the flag, runs `layout()`, and updates the trusted toolbar. `resumeContinuation` validates the exact owner, ensures the input shield is ready, clears the flag, and synchronously runs `layout()` before resolving. Input event guards and shield attachment must require an owner and `!continuationSuspended`. Release and destruction clear the flag.

- [ ] **Step 4: Run workspace tests and confirm GREEN**

Run the Task 2 command, then run the full workspace file. Expected: suspension tests and all existing workspace tests pass.

---

### Task 3: Executor authentication wait and automatic promotion

**Files:**
- Modify: `apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts`
- Modify: `apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Consumes: Task 1 coordinator, Task 2 suspend/resume methods, existing lease, `currentPageContext`, and cancellation signal.
- Produces:

```ts
export type BrowserAuthenticationWaitResult =
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'tool_error'; readonly code: AppErrorCode }

waitForAuthentication(
  runId: string,
  context: BrowserContinuationRunContext,
): Promise<BrowserAuthenticationWaitResult>
```

- [ ] **Step 1: Write failing executor tests**

Test that an `AUTH_REQUIRED` handoff suspends instead of releasing the lease or terminalizing the executor run. Start `waitForAuthentication`, return `required`, then `unknown`, then `authenticated`; assert no model-facing page data is returned, `resumeContinuation` is called once, snapshots are cleared, and a following inspect succeeds. Add stop, close, and non-login handoff cases; the latter must still release and terminalize immediately.

- [ ] **Step 2: Run focused executor tests and confirm RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/agent/browser-continuation-tool-executor.test.ts -t "authentication wait"
```

Expected: FAIL because login handoff currently releases authority and `waitForAuthentication` is absent.

- [ ] **Step 3: Implement executor suspension and wait**

Add `suspendedForAuthentication`, `pausedAt`, and `pausedDurationMs` to
`ActiveRunState`. For `AUTH_REQUIRED`, focus the tab, end inspector refs/cursors,
clear executor snapshots, call `suspendContinuation`, record `pausedAt`, and
keep the lease/run live. Preserve existing cleanup for other handoffs. Change
the five-minute check to use `now - startedAt - pausedDurationMs`, including an
active `pausedAt` interval; on successful promotion, fold the waiting interval
into `pausedDurationMs` before clearing `pausedAt`.

In `waitForAuthentication`, use the coordinator probe to read only:

```ts
const page = await workspace.getContinuationState(binding.tabId, context.runId)
const live = await inspector.currentPageContext({
  lease,
  tabId: binding.tabId,
  navigationEpoch: page.navigationEpoch,
  origin: page.origin,
  ...(context.signal ? { signal: context.signal } : {}),
})
return live.auth
```

After coordinator success, re-check the active run and lease, call `resumeContinuation`, clear `suspendedForAuthentication`, and return `{ kind: 'authenticated' }`. On a safe failure, terminate the executor state and return its code. `endRun`, `cancel`, and `takeOver` cancel the coordinator before releasing authority.

- [ ] **Step 4: Inject the coordinator in Application**

Construct one coordinator from `options.browserWorkspace.onPageInvalidated`, pass it to the executor, and dispose it during application browser shutdown after active Agent requests are cancelled and before the workspace is destroyed.

- [ ] **Step 5: Run executor and application tests and confirm GREEN**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/browser-continuation-tool-executor.test.ts \
  electron/main/application.test.ts
```

Expected: authentication wait and lifecycle tests pass; existing non-login handoff behavior stays green.

---

### Task 4: Same-turn binding refresh and Agent auto-resume

**Files:**
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`

**Interfaces:**
- Consumes: `BrowserContinuationCatalog.create`, Task 3 `waitForAuthentication`, existing browser status/evidence methods.
- Produces: same-turn catalog refresh and a host-forced inspect after authentication.

- [ ] **Step 1: Replace the current deferral test with a failing same-turn test**

Make a workflow completion add one eligible binding. Assert the next provider decision receives the three browser tools in the same run. Add a full authentication regression in which the handoff result arrives, the run promise remains pending, the status is `awaiting_user`, provider call count remains unchanged during the wait, authentication resolves, a fresh inspect returns `工作居住证有效期 = 2029-07-01`, and the final answer cites only that value.

```ts
const running = orchestrator.run(input)
await handoffObserved
expect(await promiseState(running)).toBe('pending')
expect(lastBrowserStatus()).toMatchObject({
  state: 'awaiting_user', errorCode: 'AUTH_REQUIRED',
  actionSummary: '网页尚未登录，请在已打开页面完成登录。登录后将自动继续，无需再次提问。',
})
authenticate()
await expect(running).resolves.toMatchObject({ status: 'completed' })
expect(JSON.stringify(lastTerminal())).toContain('2029-07-01')
expect(JSON.stringify(lastTerminal())).not.toContain('3年')
```

- [ ] **Step 2: Run focused orchestrator tests and confirm RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/agent/agent-orchestrator.test.ts -t "same run|login automatically"
```

Expected: current-turn binding is absent and login handoff terminalizes instead of waiting.

- [ ] **Step 3: Add catalog refresh after completed workflow execution**

Create one private helper that calls `catalog.create`, replaces `active.browserCatalog`, updates offered tools, and appends `BROWSER_CONTINUATION_POLICY` exactly once if browser tools first appear after workflow execution. Call it after a completed workflow result is appended and before the next `drive` decision. Do not refresh for failed/cancelled workflow execution.

- [ ] **Step 4: Implement authentication wait in the browser-tool path**

For `AUTH_REQUIRED`, do not set `browserTerminal`. Persist/emit the non-terminal status and append the handoff exchange, then await `executor.waitForAuthentication`. While awaiting, do not call `drive` or a provider. On authentication:

1. clear handoff code, snapshots, snapshot tool-message tracking, and field evidence;
2. increment the evidence revision when evidence was discarded;
3. refresh the exact binding and revalidate workflow version;
4. update status to `inspecting` without `AUTH_REQUIRED`;
5. invoke a host-generated `browser_session_inspect` with the original trusted inspect intent.

Safe wait failures terminalize with their exact code. Existing manual/unsupported handoffs remain terminal.

- [ ] **Step 5: Run orchestrator tests and confirm GREEN**

Run the Task 4 command, then the complete orchestrator test file. Expected: same-run and auto-resume tests pass, no provider request occurs while awaiting login, and all existing browser security tests remain green.

---

### Task 5: Renderer waiting semantics and full verification

**Files:**
- Modify: `apps/desktop/src/components/chat/BrowserStatusCard.vue`
- Modify: `apps/desktop/tests/components/chat.test.ts`

**Interfaces:**
- Consumes: existing `browser_status` block with `state: 'awaiting_user'` and `errorCode: 'AUTH_REQUIRED'`.
- Produces: login waiting is non-terminal for Stop, while takeover is unavailable.

- [ ] **Step 1: Write failing component tests**

For `awaiting_user + AUTH_REQUIRED`, assert the status label is `等待你登录`, the system action summary is visible, Stop is enabled and calls `chat.cancel`, and takeover is absent or disabled. Keep manual-action handoff terminal.

- [ ] **Step 2: Run component tests and confirm RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts -t "等待你登录"
```

Expected: Stop is currently disabled because every `awaiting_user` block is terminal.

- [ ] **Step 3: Implement the minimal card change**

Derive `awaitingLogin` from `state === 'awaiting_user' && errorCode === 'AUTH_REQUIRED'`. Use it for the label, keep Stop enabled, and hide or disable takeover. Preserve existing action identity/race protection and every other terminal-state rule.

- [ ] **Step 4: Run targeted and full verification**

Run:

```bash
pnpm --filter @autoforge/desktop typecheck
pnpm --filter @autoforge/desktop test
pnpm lint
pnpm build
git diff --check
```

Do not run the Electron E2E suite because it opens a visible application window.
Report unrelated pre-existing failures separately from regressions caused by
this implementation.

---

## Success Gate

- The same chat turn continues from workflow completion into browser inspection.
- Explicit login requirement leaves the run pending indefinitely with user input unblocked.
- Login success automatically resumes without a new message.
- Final personal data is supported by fresh authenticated evidence only.
- Stop, page close, account/conversation invalidation, and shutdown clean up deterministically.
- Focused regression tests, desktop typecheck/test, lint, build, and diff checks pass or have clearly isolated pre-existing failures.
