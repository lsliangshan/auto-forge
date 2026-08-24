# Browser Manual Intervention Auto-Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the original chat request alive while a user resolves login or another browser blocker, then atomically restore AI control and continue from a fresh page inspection.

**Architecture:** Extend the existing suspended continuation lease into two modes: authentication and generic manual intervention. A new Main-process activity coordinator waits for real physical input followed by five quiet seconds; the workspace guards promotion with page and activity revisions, while the orchestrator owns user-facing state and forces fresh evidence after every resume.

**Tech Stack:** TypeScript 6, Electron `WebContentsView`, Vue 3, Zod, Vitest 4, Playwright 1.61 headless fixtures.

**Spec:** `docs/superpowers/specs/2026-08-24-browser-manual-intervention-auto-resume-design.md`

## Global Constraints

- Only positive logged-out evidence may display “等待你登录”.
- Generic copy is exactly “自动操作暂时无法继续，请在网页中手动操作。停止操作 5 秒后将自动继续。”.
- Auto-resume requires at least one post-suspension physical key or actionable mouse event; autonomous page activity cannot arm it.
- Once armed, every physical-input, navigation, same-document navigation, redirect, or load-state event restarts the five-second quiet window.
- Promotion must validate origin, URL, navigation epoch, and activity revision before and after input-shield restoration.
- Waiting performs no model calls, uses no long polling or Worker, and is excluded from the five-minute browser-operation budget.
- Pre-wait snapshots, refs, semantic fingerprints, and private evidence never reach the resumed model request.
- Stop, close, lifecycle invalidation, policy rejection, lost ownership, and infrastructure failures remain terminal and clean up idempotently.
- Protected final actions remain user-only after resume.
- Do not run visible headed browser tests without separate user approval; use deterministic unit tests and Playwright `--list` or approved headless execution.
- Preserve unrelated dirty-worktree changes. Review every scoped diff before staging; do not include unrelated hunks in a task commit.

## File Structure

- `packages/shared/src/errors.ts`: add the stable host-owned generic intervention code.
- `packages/shared/src/contracts.test.ts`: lock schema acceptance of the new status error code.
- `apps/desktop/electron/main/browser/browser-continuation-types.ts`: carry activity revision in atomic page tokens.
- `apps/desktop/electron/main/browser/electron-browser-workspace.ts`: observe suspended physical/page activity and atomically validate promotion.
- `apps/desktop/electron/main/browser/electron-browser-workspace.test.ts`: verify input classification, revision changes, and promotion races.
- `apps/desktop/electron/main/browser/browser-manual-resume-coordinator.ts`: own the physical-input gate and five-second quiet timer.
- `apps/desktop/electron/main/browser/browser-manual-resume-coordinator.test.ts`: deterministic fake-timer and invalidation tests.
- `apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts`: retain leases for both suspension modes and normalize safe manual blockers.
- `apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts`: cover login inference, manual suspension, repeated blocking, budget pause, and cleanup.
- `apps/desktop/electron/main/agent/agent-orchestrator.ts`: wait in the same run, select precise or generic copy, redact old evidence, and force fresh inspection.
- `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`: prove no model calls while waiting and same-turn continuation afterward.
- `apps/desktop/electron/main/application.ts`: construct/dispose the manual coordinator and wire workspace activity.
- `apps/desktop/electron/main/application.test.ts`: verify lifecycle cleanup wiring.
- `apps/desktop/src/components/chat/BrowserStatusCard.vue`: render distinct non-terminal login/manual waiting states.
- `apps/desktop/tests/components/chat.test.ts`: lock labels, copy, Stop availability, and takeover visibility.
- `apps/desktop/electron/e2e/browser-continuation-main.ts`: expose deterministic manual-intervention fixture commands.
- `apps/desktop/tests/e2e/browser-continuation-fixture.ts`: provide manual input, navigation, and SPA states.
- `apps/desktop/tests/e2e/browser-continuation.spec.ts`: cover headless same-turn generic recovery.

---

### Task 1: Finish Stable Post-Login Detection

**Files:**
- Modify: `apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts`
- Test: `apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts`

**Interfaces:**
- Consumes: `BrowserPageInspector.currentPageContext(): { auth: 'authenticated' | 'required' | 'unknown'; semanticFingerprint: string }`.
- Produces: the existing `waitForAuthentication(runId, context): Promise<BrowserAuthenticationWaitResult>` contract, with stable changed-page `unknown` observations safely promoted to authenticated.

- [ ] **Step 1: Keep the regression test red-capable**

Add or retain a test that starts on `/login`, observes `required`, navigates to `/dashboard`, observes the same `unknown` page twice, and expects automatic resume:

```ts
test.inspector.currentPageContext
  .mockResolvedValueOnce({ auth: 'required', semanticFingerprint: 'login' })
  .mockResolvedValueOnce({ auth: 'unknown', semanticFingerprint: 'dashboard' })
  .mockResolvedValueOnce({ auth: 'unknown', semanticFingerprint: 'dashboard' })

expect(await input.probe()).toBe('required')
test.state.url = 'https://service.example/dashboard'
test.state.navigationEpoch = 2
expect(await input.probe()).toBe('unknown')
expect(await input.probe()).toBe('authenticated')
```

- [ ] **Step 2: Run the focused test and verify the original behavior fails**

Run from `apps/desktop`:

```bash
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/agent/browser-continuation-tool-executor.test.ts -t "stable post-login page"
```

Expected before the fix: `tool_error/AUTH_REQUIRED` instead of `authenticated`.

- [ ] **Step 3: Implement minimal stable-unknown promotion**

Record the explicit required page at handoff and require two consecutive
`unknown` probes on one different page identity:

```ts
function samePage(left: BrowserContinuationPageState, right: BrowserContinuationPageState): boolean {
  return left.origin === right.origin
    && left.url === right.url
    && left.navigationEpoch === right.navigationEpoch
}

if (live.auth === 'required') {
  state.authenticationRequiredPage = page
  unknownCandidate = undefined
  return 'required'
}
if (live.auth === 'unknown'
  && state.authenticationRequiredPage
  && !samePage(page, state.authenticationRequiredPage)
  && unknownCandidate
  && samePage(page, unknownCandidate)) {
  authenticatedPage = page
  return 'authenticated'
}
unknownCandidate = live.auth === 'unknown' ? page : undefined
```

Clear the candidate on promotion `PAGE_CHANGED`, and keep the workspace's
existing atomic expected-page check as the final authority.

- [ ] **Step 4: Run the focused and complete executor tests**

```bash
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/agent/browser-continuation-tool-executor.test.ts
```

Expected: all executor tests pass, including the authenticated-probe redirect race.

- [ ] **Step 5: Commit only the reviewed Task 1 hunks**

```bash
git diff -- apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts
git add -p -- apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts
git commit -m "fix(browser): resume after stable post-login page"
```

### Task 2: Add Activity-Aware Atomic Workspace Tokens

**Files:**
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/electron/main/browser/browser-continuation-types.ts`
- Modify: `apps/desktop/electron/main/browser/electron-browser-workspace.ts`
- Test: `apps/desktop/electron/main/browser/electron-browser-workspace.test.ts`

**Interfaces:**
- Produces: `MANUAL_INTERVENTION_REQUIRED` in `AppErrorCode`.
- Produces: `BrowserContinuationPageState.activityRevision: number`.
- Produces: `BrowserContinuationActivity` and `onContinuationActivity(listener): () => void` on `ApplicationBrowserWorkspacePort`.
- Consumes later: both wait coordinators and executor promotion use the expanded page token.

- [ ] **Step 1: Write failing shared-contract and workspace tests**

Add schema coverage:

```ts
expect(chatBlockSchema.parse({
  type: 'browser_status', blockId: 'browser_status_manual', requestId: 'request_1',
  bindingId: 'binding_1', siteLabel: '事项办理', origin: 'https://service.example',
  state: 'awaiting_user', errorCode: 'MANUAL_INTERVENTION_REQUIRED',
})).toMatchObject({ errorCode: 'MANUAL_INTERVENTION_REQUIRED' })
```

Add workspace tests that suspend a continuation, send pointer movement,
mouse-down, key-down, navigation, and synthetic input, then assert:

```ts
expect(activities.map(({ kind }) => kind)).toEqual([
  'physical_input',
  'physical_input',
  'page_change',
])
expect((await workspace.getContinuationState(binding.tabId, 'run_1')).activityRevision)
  .toBe(3)
```

Add a promotion-race test that advances activity while `ensureInputShield()` is
awaiting and expects `PAGE_CHANGED`, `continuationSuspended === true`, and no
attached shield.

- [ ] **Step 2: Run the focused tests and verify missing contracts fail**

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
cd apps/desktop && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/browser/electron-browser-workspace.test.ts
```

Expected: the new error code and activity APIs are absent.

- [ ] **Step 3: Add the stable error and activity types**

Use these exact contracts:

```ts
export interface BrowserContinuationPageState {
  readonly origin: string
  readonly url: string
  readonly navigationEpoch: number
  readonly activityRevision: number
}

export interface BrowserContinuationActivity {
  readonly tabId: string
  readonly revision: number
  readonly kind: 'physical_input' | 'page_change'
}
```

Add `MANUAL_INTERVENTION_REQUIRED` to `appErrorCodeSchema` and its safe message.
Add this port member:

```ts
onContinuationActivity(listener: (activity: BrowserContinuationActivity) => void): () => void
```

- [ ] **Step 4: Implement metadata-only activity observation**

Add `activityRevision` to `TargetTabState`. Increment and emit only while
`ownerContinuationRunId` exists and `continuationSuspended` is true. Classify
`keyDown`, `mouseDown`, `mouseUp`, and wheel as `physical_input`; ignore mouse
movement and any input while automation is active. Navigation, redirect,
same-document navigation, and load-state changes emit `page_change`.

Update `getContinuationState()` to include the revision and
`assertContinuationPage()` to compare it. Preserve the existing before/after
checks around `ensureInputShield()` so a revision change produces `PAGE_CHANGED`
before `continuationSuspended` is cleared.

- [ ] **Step 5: Run contract and workspace tests**

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
cd apps/desktop && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/browser/electron-browser-workspace.test.ts
```

Expected: all focused tests pass and existing ownership/shield tests remain green.

- [ ] **Step 6: Commit only Task 2 files**

```bash
git add packages/shared/src/errors.ts packages/shared/src/contracts.test.ts \
  apps/desktop/electron/main/browser/browser-continuation-types.ts \
  apps/desktop/electron/main/browser/electron-browser-workspace.ts \
  apps/desktop/electron/main/browser/electron-browser-workspace.test.ts
git commit -m "feat(browser): track suspended user activity"
```

### Task 3: Build the Event-Driven Manual Resume Coordinator

**Files:**
- Create: `apps/desktop/electron/main/browser/browser-manual-resume-coordinator.ts`
- Create: `apps/desktop/electron/main/browser/browser-manual-resume-coordinator.test.ts`

**Interfaces:**
- Consumes: `BrowserContinuationActivity` from Task 2.
- Produces: `BrowserManualResumeCoordinator.wait(input): Promise<void>`, `cancel(runId): void`, and `dispose(): void`.
- Input contract:

```ts
export interface BrowserManualResumeWaitInput {
  readonly runId: string
  readonly tabId: string
  readonly baselineActivityRevision: number
  readonly signal?: AbortSignal
  readonly promote: () => Promise<void>
}
```

- [ ] **Step 1: Write fake-timer tests for the state machine**

Cover these exact cases:

```ts
const wait = coordinator.wait({
  runId: 'run_1', tabId: 'tab_1', baselineActivityRevision: 4, promote, signal,
})
activity({ tabId: 'tab_1', revision: 5, kind: 'page_change' })
await vi.advanceTimersByTimeAsync(60_000)
expect(promote).not.toHaveBeenCalled()

activity({ tabId: 'tab_1', revision: 6, kind: 'physical_input' })
await vi.advanceTimersByTimeAsync(4_999)
expect(promote).not.toHaveBeenCalled()
await vi.advanceTimersByTimeAsync(1)
expect(promote).toHaveBeenCalledOnce()
await expect(wait).resolves.toBeUndefined()
```

Also test activity at 4,999 ms resets the timer; activity during an unresolved
promotion invalidates its success; `PAGE_CHANGED` retries; abort/cancel/dispose
reject with `CANCELLED`; duplicate `runId` rejects with `CONFLICT`; all timers
and listeners clean up exactly once.

- [ ] **Step 2: Run the new test and verify the module is missing**

```bash
cd apps/desktop && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/browser/browser-manual-resume-coordinator.test.ts
```

Expected: import/module failure.

- [ ] **Step 3: Implement the coordinator without polling**

Use a waiter record with `armed`, `latestRevision`, `invalidationRevision`,
`promoting`, `promotionQueued`, `quietTimer`, and `settled`. Subscribe once in
the constructor. A physical event newer than baseline sets `armed = true`; page
events only reschedule after `armed` is true. At the timer boundary:

```ts
const revision = waiter.invalidationRevision
await waiter.input.promote()
if (waiter.promotionQueued || waiter.invalidationRevision !== revision) return
this.finish(waiter.input.runId)
```

Map `PAGE_CHANGED` to another quiet wait and all other failures to terminal
rejection. Mirror the login coordinator's cancellation-safe cleanup style.

- [ ] **Step 4: Run the coordinator tests**

```bash
cd apps/desktop && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/browser/browser-manual-resume-coordinator.test.ts
```

Expected: all coordinator tests pass under fake timers with no real waits.

- [ ] **Step 5: Commit the coordinator**

```bash
git add apps/desktop/electron/main/browser/browser-manual-resume-coordinator.ts \
  apps/desktop/electron/main/browser/browser-manual-resume-coordinator.test.ts
git commit -m "feat(browser): coordinate manual resume after user idle"
```

### Task 4: Make Manual Handoffs Resumable in the Executor

**Files:**
- Modify: `apps/desktop/electron/main/browser/browser-action-guard.ts`
- Test: `apps/desktop/electron/main/browser/browser-action-guard.test.ts`
- Modify: `apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts`
- Test: `apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts`

**Interfaces:**
- Consumes: `BrowserManualResumeCoordinator` and activity-aware page state.
- Produces: handoff code union including `MANUAL_INTERVENTION_REQUIRED`.
- Produces: `waitForManualIntervention(runId, context): Promise<BrowserManualWaitResult>` where the result union matches authentication wait: `{ kind: 'resumed' } | { kind: 'tool_error'; code: AppErrorCode }`.

- [ ] **Step 1: Write failing executor tests**

Add tests for:

```ts
expect(await executor.execute('browser_session_handoff', {
  bindingId: 'binding_1', reason: 'manual_action',
}, run())).toEqual({ kind: 'handoff', code: 'MANUAL_ACTION_REQUIRED' })
expect(workspace.suspendContinuation).toHaveBeenCalledWith('tab_1', 'agent_run_1')
expect(release).not.toHaveBeenCalled()
```

Mock `manualWait.wait` so its `promote()` captures current page state and calls
`resumeContinuation`. Assert wait time is excluded from the action limit,
`PAGE_CHANGED` keeps waiting, repeated handoff requires a new wait, and
cancel/endRun cancel both coordinators exactly once.

Add guard cases that normalize a live unsupported or ambiguous control to
`MANUAL_INTERVENTION_REQUIRED`, while `DOMAIN_BLOCKED`, `ACTION_LIMIT_EXCEEDED`,
`PAGE_CLOSED`, and lost eligibility remain terminal.

- [ ] **Step 2: Run guard and executor tests to verify failure**

```bash
cd apps/desktop && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/browser-action-guard.test.ts \
  electron/main/agent/browser-continuation-tool-executor.test.ts
```

Expected: manual reason/code and wait method are missing; current handoff releases the lease.

- [ ] **Step 3: Replace the authentication boolean with a suspension union**

Use this state shape:

```ts
type BrowserSuspension =
  | { readonly kind: 'authentication'; requiredPage: BrowserContinuationPageState }
  | { readonly kind: 'manual_intervention'; baselineActivityRevision: number }
```

In `ActiveRunState`, replace `suspendedForAuthentication` and the temporary
authentication-page field with `suspension?: BrowserSuspension`.

Both modes clear snapshots, call `inspector.endRun`, suspend the workspace,
record `pausedAt`, and retain the lease. Only non-resumable failures call
`cleanupAuthority()` and remember a terminal run.

- [ ] **Step 4: Add manual promotion through the coordinator callback**

Implement:

```ts
await manualWait.wait({
  runId,
  tabId: lease.binding.tabId,
  baselineActivityRevision: suspension.baselineActivityRevision,
  signal: context.signal,
  promote: async () => {
    await lease.assertEligible()
    this.assertActive(state, context)
    const expected = await workspace.getContinuationState(lease.binding.tabId, context.runId)
    await workspace.resumeContinuation(lease.binding.tabId, context.runId, expected)
  },
})
```

After success, add paused duration, clear `pausedAt` and `suspension`, and return
`{ kind: 'resumed' }`. On `PAGE_CHANGED`, the coordinator remains armed and
retries; on terminal errors, call the existing idempotent terminate path.

- [ ] **Step 5: Normalize only safe live-page blockers**

Keep the existing model-visible handoff reasons unchanged. Convert guard
handoffs for protected/unsupported controls into resumable suspension; when an
owned live-page inspection or action fails with `TARGET_AMBIGUOUS` or
`AUTH_STATE_UNKNOWN`, host-normalize the result to
`MANUAL_INTERVENTION_REQUIRED`. Do not convert policy, lifecycle, ownership,
infrastructure, or budget errors.

- [ ] **Step 6: Run all browser guard/executor/coordinator tests**

```bash
cd apps/desktop && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/browser-action-guard.test.ts \
  electron/main/browser/browser-login-wait-coordinator.test.ts \
  electron/main/browser/browser-manual-resume-coordinator.test.ts \
  electron/main/agent/browser-continuation-tool-executor.test.ts
```

Expected: all pass; no lease release occurs during either suspension mode.

- [ ] **Step 7: Commit the executor state machine**

```bash
git add -p -- apps/desktop/electron/main/browser/browser-action-guard.ts \
  apps/desktop/electron/main/browser/browser-action-guard.test.ts \
  apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts \
  apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts
git commit -m "feat(browser): resume after manual intervention"
```

### Task 5: Keep the Agent Turn Alive and Force Fresh Evidence

**Files:**
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Test: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`

**Interfaces:**
- Consumes: executor handoffs `AUTH_REQUIRED`, `MANUAL_ACTION_REQUIRED`, `UNSUPPORTED_CONTROL`, and `MANUAL_INTERVENTION_REQUIRED` plus both wait methods.
- Produces: system-owned `awaiting_user` status followed by host-forced fresh `browser_session_inspect` in the same run.

- [ ] **Step 1: Write failing same-turn orchestration tests**

For generic intervention, assert the provider is not called while the wait
promise is pending, old snapshot messages are superseded, and the resumed call
sequence is exactly:

```ts
expect(execute.mock.calls.map(([tool]) => tool)).toEqual([
  'browser_session_inspect',
  'browser_session_handoff',
  'browser_session_inspect',
])
expect(statusBlocks).toContainEqual(expect.objectContaining({
  state: 'awaiting_user',
  errorCode: 'MANUAL_INTERVENTION_REQUIRED',
  actionSummary: '自动操作暂时无法继续，请在网页中手动操作。停止操作 5 秒后将自动继续。',
}))
```

Resolve `waitForManualIntervention` and assert the same request returns the
fresh field result without another user message. Add terminal tests for Stop,
page close, domain rejection, account/workflow invalidation, and repeated
manual blocking.

- [ ] **Step 2: Run focused orchestration tests to verify current terminal behavior**

```bash
cd apps/desktop && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/agent/agent-orchestrator.test.ts -t "manual intervention"
```

Expected: the run terminalizes or calls the model before manual recovery.

- [ ] **Step 3: Add distinct host-owned waiting branches**

Set `browserTerminal = false` for every resumable handoff. Use login copy only
for `AUTH_REQUIRED`. Use “该操作需要你在网页中手动完成。停止操作 5 秒后将自动继续。”
for the evidence-backed `MANUAL_ACTION_REQUIRED` cause. Use the exact generic
copy for `UNSUPPORTED_CONTROL` and `MANUAL_INTERVENTION_REQUIRED`, where a more
specific user-facing explanation is not reliable. Await the matching executor
method without calling `drive()` or the provider.

On successful resume:

```ts
active.browserSnapshots.clear()
active.browserEvidence.length = 0
active.browserEvidenceRevision += 1
supersedeBrowserSnapshotToolMessages(active)
this.updateBrowserStatus(active, candidate, 'inspecting', '正在重新读取网页')
return this.executeBrowserTool(active, forcedInspectCall(candidate.bindingId), '')
```

Use the existing login-resume redaction and forced-inspection helpers rather
than introducing a second evidence path.

- [ ] **Step 4: Keep terminal failures precise**

`PAGE_CLOSED`, `DOMAIN_BLOCKED`, `WORKFLOW_CHANGED`, `CANCELLED`, and
infrastructure errors retain their existing failure/cancel status. Do not
rewrite them to the generic manual copy merely because the model lacks detail.

- [ ] **Step 5: Run all orchestrator tests**

```bash
cd apps/desktop && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/agent/agent-orchestrator.test.ts
```

Expected: all tests pass, including login auto-resume, old-snapshot redaction,
and generic manual same-turn recovery.

- [ ] **Step 6: Commit the orchestration behavior**

```bash
git add -p -- apps/desktop/electron/main/agent/agent-orchestrator.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.test.ts
git commit -m "feat(chat): continue after manual browser work"
```

### Task 6: Wire Lifecycle and Render the Generic Waiting State

**Files:**
- Modify: `apps/desktop/electron/main/application.ts`
- Test: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/src/components/chat/BrowserStatusCard.vue`
- Test: `apps/desktop/tests/components/chat.test.ts`

**Interfaces:**
- Consumes: `BrowserManualResumeCoordinator` and `MANUAL_INTERVENTION_REQUIRED`.
- Produces: application-owned construction/disposal and distinct Renderer state.

- [ ] **Step 1: Write failing lifecycle and component tests**

Assert application construction wires:

```ts
new BrowserManualResumeCoordinator({
  onContinuationActivity: (listener) => browserWorkspace.onContinuationActivity(listener),
})
```

Assert application shutdown disposes it exactly once, while application reset
or run cancellation cancels the affected wait through executor cleanup without
disposing the reusable application-level coordinator.

Mount a manual waiting block and assert:

```ts
expect(wrapper.text()).toContain('等待你手动操作')
expect(wrapper.text()).toContain(
  '自动操作暂时无法继续，请在网页中手动操作。停止操作 5 秒后将自动继续。',
)
expect(wrapper.find('[data-testid="take-over-browser"]').exists()).toBe(false)
expect((wrapper.get('[data-testid="stop-browser"]').element as HTMLButtonElement).disabled)
  .toBe(false)
```

Retain the equivalent login assertions with “等待你登录”.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
cd apps/desktop && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/application.test.ts
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts -t "browser"
```

Expected: manual coordinator wiring and generic non-terminal rendering are absent.

- [ ] **Step 3: Wire coordinator construction and disposal**

Construct it beside `BrowserLoginWaitCoordinator`, inject it into the executor,
and call `dispose()` in the same final application teardown path as login wait.
Run-level reset and cancellation must call `manualWait.cancel(runId)` instead of
disposing the shared coordinator. Do not add a Worker, interval, or
Renderer-owned timer.

- [ ] **Step 4: Render both waiting subtypes explicitly**

Use computed flags:

```ts
const awaitingLogin = computed(() => block.state === 'awaiting_user'
  && block.errorCode === 'AUTH_REQUIRED')
const manualCodes = ['MANUAL_ACTION_REQUIRED', 'UNSUPPORTED_CONTROL',
  'MANUAL_INTERVENTION_REQUIRED'] as const
const awaitingManual = computed(() => block.state === 'awaiting_user'
  && manualCodes.some((code) => code === block.errorCode))
const awaitingUser = computed(() => awaitingLogin.value || awaitingManual.value)
```

Map the labels to “等待你登录” and “等待你手动操作”. Both states are
non-terminal, keep Stop enabled, hide takeover because the shield is already
detached, and suppress generic `displayError()` duplication.

- [ ] **Step 5: Run application and component tests**

```bash
cd apps/desktop && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/application.test.ts
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts
```

Expected: all focused suites pass.

- [ ] **Step 6: Commit wiring and UI**

```bash
git add -p -- apps/desktop/electron/main/application.ts \
  apps/desktop/electron/main/application.test.ts \
  apps/desktop/src/components/chat/BrowserStatusCard.vue \
  apps/desktop/tests/components/chat.test.ts
git commit -m "feat(browser): show resumable manual waiting state"
```

### Task 7: Add Headless Contracts and Run Full Verification

**Files:**
- Modify: `apps/desktop/electron/e2e/browser-continuation-main.ts`
- Modify: `apps/desktop/tests/e2e/browser-continuation-fixture.ts`
- Modify: `apps/desktop/tests/e2e/browser-continuation.spec.ts`
- Verify all files from Tasks 1–6.

**Interfaces:**
- Consumes: the complete activity, suspension, orchestration, and UI contracts.
- Produces: deterministic headless acceptance coverage for the user-visible flow.

- [ ] **Step 1: Add deterministic fixture states**

Expose one page that requires a manual text/control action before the requested
field appears, plus navigation and same-document variants. The command bridge
must issue real target `before-input-event`/mouse events and page transitions;
it must not call the coordinator directly.

- [ ] **Step 2: Add headless same-turn tests**

For typing, navigation, and same-document variants:

```ts
await submitChat(page, '读取证件“有效期至”')
await expect(page.getByText('等待你手动操作')).toBeVisible()
const before = (await command<HarnessSnapshot>(electronApp, 'snapshot')).providerRequests.length
await command(electronApp, 'manualResolve', { mode })
await expect.poll(async () => (
  await command<HarnessSnapshot>(electronApp, 'snapshot')
).providerRequests.length).toBe(before)
await command(electronApp, 'advanceManualQuietWindow', { milliseconds: 5_000 })
await command(electronApp, 'waitForIdle', { conversationId })
await expect(page.getByText('工作居住证有效期：2028-06-30')).toBeVisible()
```

Add a race case where new input at 4,999 ms delays recovery and a repeated
blocker case that requires a new physical event.

- [ ] **Step 3: List the E2E suite without opening a browser**

```bash
pnpm exec playwright test apps/desktop/tests/e2e/browser-continuation.spec.ts --list
```

Expected: the updated tests are discovered and compile; do not run headed mode.

- [ ] **Step 4: Run scoped static checks**

```bash
pnpm typecheck
pnpm exec eslint \
  packages/shared/src/errors.ts packages/shared/src/contracts.test.ts \
  apps/desktop/electron/main/browser/browser-continuation-types.ts \
  apps/desktop/electron/main/browser/electron-browser-workspace.ts \
  apps/desktop/electron/main/browser/electron-browser-workspace.test.ts \
  apps/desktop/electron/main/browser/browser-manual-resume-coordinator.ts \
  apps/desktop/electron/main/browser/browser-manual-resume-coordinator.test.ts \
  apps/desktop/electron/main/browser/browser-login-wait-coordinator.ts \
  apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts \
  apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.test.ts \
  apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts \
  apps/desktop/src/components/chat/BrowserStatusCard.vue apps/desktop/tests/components/chat.test.ts \
  apps/desktop/electron/e2e/browser-continuation-main.ts \
  apps/desktop/tests/e2e/browser-continuation-fixture.ts \
  apps/desktop/tests/e2e/browser-continuation.spec.ts
```

Expected: both commands exit 0. If repository-wide unrelated lint failures
exist, report them separately; do not modify unrelated files.

- [ ] **Step 5: Run the complete desktop test and build gates**

```bash
pnpm test
pnpm build
git diff --check
```

Expected: all tests pass, build succeeds, and no whitespace errors remain.

- [ ] **Step 6: Review the final scoped diff against both specs**

```bash
git diff --stat
git diff -- \
  packages/shared/src/errors.ts packages/shared/src/contracts.test.ts \
  apps/desktop/electron/main/browser \
  apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts \
  apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.test.ts \
  apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts \
  apps/desktop/src/components/chat/BrowserStatusCard.vue apps/desktop/tests/components/chat.test.ts \
  apps/desktop/electron/e2e/browser-continuation-main.ts \
  apps/desktop/tests/e2e/browser-continuation-fixture.ts \
  apps/desktop/tests/e2e/browser-continuation.spec.ts
```

Check explicitly that no pre-wait evidence survives, no generic blocker is
misreported as login, no terminal security error becomes resumable, and no
timer/worker remains after terminal cleanup.

- [ ] **Step 7: Commit only reviewed E2E and remaining verification changes**

```bash
git add -p -- apps/desktop/electron/e2e/browser-continuation-main.ts \
  apps/desktop/tests/e2e/browser-continuation-fixture.ts \
  apps/desktop/tests/e2e/browser-continuation.spec.ts
git commit -m "test(browser): cover manual intervention auto-resume"
```
