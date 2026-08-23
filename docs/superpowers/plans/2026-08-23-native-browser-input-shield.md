# Native Browser Input Shield Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent physical user input from reaching a continuation-owned Electron browser tab for the full AI browser run, without cancelling the run or blocking direct CDP automation, then restore ordinary page interaction synchronously at terminal cleanup.

**Architecture:** `ElectronBrowserWorkspace` owns one dedicated trusted input-shield `WebContentsView`, separate from the target tab and the 52-pixel toolbar. The workspace loads it once, attaches it synchronously between target and toolbar whenever the active target has `ownerContinuationRunId`, and detaches it synchronously on release; the view and document use one-step nonzero alpha so Electron/macOS native hit testing cannot pass through fully transparent pixels. Target input listeners remain defense in depth and never implicitly cancel an owned continuation.

**Tech Stack:** TypeScript, Electron 43 `BaseWindow`/`WebContentsView`, CDP 1.3, Vitest under Electron, Playwright Electron E2E.

**Spec:** `docs/superpowers/specs/2026-08-23-conversation-bound-browser-continuation-design.md`

## Global Constraints

- The stacking order during continuation is exactly `target < input shield < trusted toolbar`.
- The shield covers only `{ x: 0, y: 52, width: contentWidth, height: contentHeight - 52 }`; the toolbar remains usable.
- The shield absorbs physical pointer and keyboard input without target mutation, implicit takeover, invalidation, lease release, or Agent cancellation.
- CDP continues to target the underlying target `webContents` directly and must remain functional while the shield is attached.
- Completion, failure, cancellation, handoff, explicit Stop, and explicit Takeover detach the shield before target interaction resumes.
- The shield is not injected into the remote site's DOM and exposes no Node.js, preload, webview, permission, window-open, download, or navigation capability.
- Native and document paint use the minimum nonzero alpha that serializes to one 8-bit alpha step (`0 < alpha <= 0.004`) and remains visually imperceptible.
- No timing window, coordinates-based input classification, platform branch, or new configuration is permitted.
- The existing loading and blocked-origin trusted surfaces retain their appearance and behavior.

---

### Task 1: Dedicated shield view and synchronous lease lifecycle

**Files:**
- Modify: `apps/desktop/electron/main/browser/electron-browser-workspace.ts`
- Modify: `apps/desktop/electron/main/browser/electron-browser-workspace.test.ts`

**Interfaces:**
- Consumes: existing `WebContentsViewPort`, `BaseWindowPort`, `TargetTabState.ownerContinuationRunId`, `acquireContinuation(tabId, runId)`, `releaseContinuation(tabId, runId)`, `layout()`, and trusted-toolbar command handlers.
- Produces: private `ensureInputShield(): Promise<void>`, `inputShield?: WebContentsViewPort`, `inputShieldCreation?: Promise<void>`, and `inputShieldAttached: boolean`; no public IPC or workspace-port change.
- Produces for Task 2: a real Electron view whose background, bounds, attachment, and stacking can be inspected independently from the toolbar and target.

- [ ] **Step 1: Replace Round 1/2 assumptions with failing unit tests**

Add focused tests that identify toolbar, target, and shield as separate fake views and assert the consumer-visible behavior:

```ts
async function bindIdleContinuation(harness: ReturnType<typeof createHarness>) {
  const input = executionInput()
  const tab = await harness.workspace.acquire(input)
  const registry = continuationRegistry(harness.workspace)
  harness.workspace.setContinuationRegistry(registry)
  const binding = registry.bind({ ...input, tabId: tab.id } as BrowserContinuationBindingInput)
  harness.workspace.markContinuationBound(tab.id)
  await harness.workspace.releaseExecution(input.executionId)
  return { input, tab, registry, binding }
}

it('attaches a dedicated native input shield for the full continuation lease', async () => {
  const harness = createHarness()
  const { workspace, views, windows } = harness
  const { binding, registry } = await bindIdleContinuation(harness)

  const lease = await registry.acquire(binding.bindingId, {
    userId: 'user_1', conversationId: 'conversation_1', runId: 'run_shielded',
  })

  const [toolbar, target, shield] = views
  expect(shield).not.toBe(toolbar)
  expect(shield).not.toBe(target)
  expect(shield?.bounds.at(-1)).toEqual({ x: 0, y: 52, width: 1200, height: 748 })
  expect(windows[0]?.children).toEqual([target, shield, toolbar])
  expect(toolbar?.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 1200, height: 52 })
  expect(lease.isCurrent(binding)).toBe(true)
})
```

Use the existing helpers and actual returned tab shape rather than adding test-only production methods. Add a second test that emits pointer and keyboard events on the shield and verifies the target receives none, the lease remains current, no invalidation fires, and pending CDP work resolves. Add a third test proving `lease.release()` and the public toolbar Takeover route synchronously detach the shield and leave `[target, toolbar]` before their promises resolve.

Replace the old tests that assert keyboard input causes implicit takeover. The approved design now requires shield and leaked target keyboard/pointer input to be swallowed during ownership; only the trusted Stop/Takeover routes terminate ownership.

- [ ] **Step 2: Run the focused unit test and record RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts electron/main/browser/electron-browser-workspace.test.ts
```

Expected: FAIL because only toolbar and target views exist, the toolbar expands to full height, and current target/shield keyboard listeners revoke the lease.

- [ ] **Step 3: Implement the static trusted shield document and one-time creation**

Add a fixed document with no model or remote-page data:

```ts
function inputShieldDocument(): string {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
    + '<style>html,body{width:100%;height:100%;margin:0;overflow:hidden;'
    + 'background:rgb(0 0 0 / 0.004)}</style></head><body aria-hidden="true"></body></html>'
}
```

Create the shield once after the first target view exists, so existing toolbar/target construction order stays stable. Use the trusted toolbar partition and the same sandboxed, no-Node, no-preload preferences. Set the native view background with an unambiguous one-step alpha color such as `rgba(0, 0, 0, 0.004)`, deny window opening, and prevent all navigation except its initial `data:` document. Both `before-mouse-event` and `before-input-event` call `event.preventDefault()` and do not call `handleUserTakeover`.

`ensureInputShield()` must deduplicate concurrent creation with `inputShieldCreation`, close a losing/stale view on shutdown or window replacement, and resolve only after the document is loaded. `destroyViews()` and window-close cleanup close and clear the shield exactly once.

- [ ] **Step 4: Implement synchronous attachment, stacking, and detachment**

Change `layout()` so the toolbar is full-height only for loading/blocked surfaces, never for normal continuation shielding:

```ts
const shieldingTarget = !coveringTarget && active?.ownerContinuationRunId !== undefined
toolbar.setBounds({
  x: 0, y: 0, width: bounds.width,
  height: coveringTarget ? bounds.height : toolbarHeight,
})
inputShield?.setBounds({
  x: 0, y: toolbarHeight, width: bounds.width,
  height: Math.max(0, bounds.height - toolbarHeight),
})
```

When `shieldingTarget` is true, add the shield if detached, then remove/re-add the toolbar so the exact order is target, shield, toolbar. When false, remove the shield synchronously and set `inputShieldAttached = false`. Loading/blocked toolbar coverage stays topmost and opaque.

`acquireContinuation()` must `await ensureInputShield()` before setting `ownerContinuationRunId`; after ownership is set, its existing synchronous `layout()` installs the already-loaded shield before acquisition resolves. `releaseContinuation()` and `handleUserTakeover()` continue to clear ownership before calling `layout()`, so cleanup detaches before their returned promises resolve.

Remove the Round 2 `.input-shield` element and full-window pointer layer from `toolbarDocument()`. Keep the toolbar document/background limited to toolbar and loading/blocked UX.

- [ ] **Step 5: Make target input defense-in-depth non-cancelling**

For target `before-mouse-event`, while `ownerContinuationRunId` is present and `syntheticInputOperations === 0`, call `preventDefault()` without `handleUserTakeover`. While the CDP synthetic counter is nonzero, leave the event untouched because the dedicated native shield—not the counter—is the physical-input authority.

For target `before-input-event`, while `ownerContinuationRunId` is present, call `preventDefault()` without takeover. Current continuation fill/select uses DOM CDP commands and click/scroll uses mouse CDP, so this does not block an approved synthetic keyboard path. Outside ownership, neither listener changes ordinary target interaction.

- [ ] **Step 6: Run focused and impacted tests GREEN**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/browser/electron-browser-workspace.test.ts \
  electron/main/browser/browser-continuation-registry.test.ts \
  electron/main/browser/browser-page-inspector.test.ts \
  electron/main/agent/browser-continuation-catalog.test.ts \
  electron/main/agent/browser-continuation-tool-executor.test.ts
```

Expected: all tests PASS with no unhandled rejection. Mutation check: removing the dedicated view, nonzero native background, bounds, attachment order, input prevention, or synchronous detachment must fail at least one focused test.

- [ ] **Step 7: Commit Task 1**

```bash
git add apps/desktop/electron/main/browser/electron-browser-workspace.ts \
  apps/desktop/electron/main/browser/electron-browser-workspace.test.ts
git commit -m "fix(browser): add native continuation input shield"
```

---

### Task 2: Real Electron boundary evidence and terminal-path regression

**Files:**
- Modify: `apps/desktop/electron/e2e/browser-continuation-main.ts`
- Modify: `apps/desktop/tests/e2e/browser-continuation.spec.ts`
- Modify: `.superpowers/sdd/2026-08-23-native-browser-input-shield/progress.md` through the SDD controller only; this file is git-ignored and must not be committed.

**Interfaces:**
- Consumes: Task 1's dedicated shield view, exact native view stacking, `holdBusy`/`releaseBusy`, direct CDP click probe, and public Stop/Takeover routes.
- Produces: E2E-only `nativeInputShieldState` command returning safe structural fields: native background, bounds, attachment order, toolbar bounds, target bounds, shield event count, target event count, and direct-CDP target event count. It returns no page text, values, cookies, URLs with query data, or DOM excerpts.

- [ ] **Step 1: Write the failing real-Electron tests**

Replace the Round 1/2 toolbar-shield probes with a dedicated-view probe. Before ownership assert the shield exists, is loaded, and is detached. During `holdBusy`, assert:

```ts
expect(owned).toMatchObject({
  attached: true,
  order: ['target', 'shield', 'toolbar'],
  shieldBounds: { x: 0, y: 52 },
  toolbarBounds: { x: 0, y: 0, height: 52 },
  nativeAlphaGreaterThanZero: true,
  documentAlphaGreaterThanZero: true,
  targetEventsAfterShieldInput: 0,
  directCdpTargetEvents: 1,
})
expect(owned.nativeAlpha).toBeLessThanOrEqual(0.004)
expect(owned.documentAlpha).toBeLessThanOrEqual(0.004)
```

After `releaseBusy`, assert `attached:false` and order `['target', 'toolbar']`. Exercise public Takeover and Stop separately and assert the shield is detached before each terminal status is emitted. Keep the existing Agent cancellation, handoff, error, and normal-completion tests in the impacted matrix; add a single combined regression only where none currently observes workspace detachment.

- [ ] **Step 2: Run the focused E2E test and record RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec tsup electron/e2e/browser-continuation-main.ts \
  --format esm --platform node --external electron --external better-sqlite3 \
  --out-dir .e2e/main --clean && \
pnpm --filter @autoforge/desktop exec playwright test \
  tests/e2e/browser-continuation.spec.ts --grep "dedicated native input shield"
```

Expected: FAIL because `nativeInputShieldState` is absent and Round 2 still reports the toolbar as the shield.

- [ ] **Step 3: Add the minimal safe E2E inspection command**

Identify views by workspace identity and native child membership, not array position alone. Send test input directly to the shield only to prove its own event handler and send CDP directly to the target only to prove CDP bypass; label both as selected-WebContents injection, not OS-native input. Parse native and computed alpha independently. Do not claim that `sendInputEvent` proves macOS hit testing.

If the existing harness cannot capture the composited `BaseWindow`, report that exact limitation. Do not add AppleScript, accessibility privileges, platform-specific automation, or a false bitmap proxy. The user's physical-click smoke remains the acceptance boundary.

- [ ] **Step 4: Run complete verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm test:e2e:browser-continuation
pnpm exec eslint \
  apps/desktop/electron/main/browser/electron-browser-workspace.ts \
  apps/desktop/electron/main/browser/electron-browser-workspace.test.ts \
  apps/desktop/electron/e2e/browser-continuation-main.ts \
  apps/desktop/tests/e2e/browser-continuation.spec.ts
pnpm build
git diff --check
```

Expected: unit, typecheck, Electron E2E, changed-file ESLint, build, and diff checks PASS. Existing third-party build warnings may remain only if byte-identical in cause and scope.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/desktop/electron/e2e/browser-continuation-main.ts \
  apps/desktop/tests/e2e/browser-continuation.spec.ts
git commit -m "test(browser): verify native continuation shield"
```

- [ ] **Step 6: Restart Main and run user-assisted native acceptance**

Stop the existing Electron dev process and restart from `apps/desktop` with the repository's configured Node and `.env`. The user repeats a continuation query and physically clicks the visible target content during an established AI operation and immediately/repeatedly near lease acquisition.

Acceptance requires all of the following:

- the page remains visibly unobscured;
- physical mouse and keyboard input do not mutate the target or cancel automation;
- the status remains active and no binding is revoked or invalidated;
- direct AI CDP actions still complete;
- explicit Stop/Takeover work;
- after normal completion or explicit terminal action, the user can operate the page immediately.

If physical input still reaches the target, stop this plan. Do not add another alpha or CSS variation; escalate to the already-considered transparent child-window architecture with a new approved spec amendment.
