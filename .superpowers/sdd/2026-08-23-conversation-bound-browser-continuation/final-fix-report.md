# Final Fix Report: Conversation-Bound Browser Continuation

Date: 2026-08-23
Reviewed base: `1a6891b09a974e691ecb085f9191bd1de3d1c87e`
Pre-feature lint comparison base: `e45cb32f575a0a0759e8e321ee119dbaa561db0b`

## Outcome

The final whole-branch fix wave closes every Critical and Important final-review finding and the requested Minor/acceptance items in the automated boundary. Browser navigation authority is now an exact current-user canonical URL or an exact fresh inspected link, current workflow eligibility is revalidated before catalog admission/acquisition/actions, inspection work has raw and time/cancellation limits, browser status follows the live lease through terminal cleanup and restart recovery, and trusted tab activation takes over the automated tab before switching.

The deterministic Electron suite remains at 19 scenarios, but the draft scenario now traverses Renderer chat, the production Orchestrator, the deterministic provider, the guarded executor, and the real Workspace instead of calling the executor directly. `finalSubmissions` remains zero during automation and becomes one only after the test's explicit user click.

No production E2E switch, fixture identifier, final-submit helper, generic browser tool, or backdoor was added. The test-only Main entry remains under `apps/desktop/electron/e2e` and its generated bundle remains ignored/unpackaged.

## TDD RED/GREEN evidence by finding

### 1. Exact navigation authority and protected same-origin destinations

RED:

- New executor/Orchestrator cases demonstrated that origin-only or substring evidence could authorize a different same-origin destination and that navigation had no value-source provenance.
- Protected destination cases initially classified same-origin logout/delete/withdraw/confirm paths as ordinary navigation.
- Additional equivalence mutations reproduced two unsafe `allowed` results for `/bank/transfer` and `/checkout` (`2 failed`, `6 passed` in the focused row), followed by three unsafe `allowed` results for direct `/account/rotate`, `/feature/toggle`, and `/records/archive` paths (`3 failed`, `1 passed` in the focused row).
- The first combined injected cases were strengthened after audit: a link deceptively named `帮助中心` now reaches the real executor/Guard rather than stopping only at the Orchestrator.

GREEN:

- `navigate` requires a source. A `current_user` source must equal a canonical HTTPS URL token in the frozen current user message; origin or substring matches are rejected.
- A `page` source must identify the current snapshot/ref, resolve to a live link, and exactly equal the Main-owned current `href`. Link identity includes page version/navigation epoch and live role/name/tag/input/href semantics.
- Guard classification hands off logout/delete/withdraw/revoke/cancel/confirm/approve/submit/payment/checkout/transfer/purchase/publish/signature equivalents and common unknown mutation verbs. Unknown `action`/`operation`/`command` parameter values and mutation-style action paths also hand off.
- Page/model text cannot add current-user URL authority. Existing category-negation checks remain in force.
- Combined Orchestrator -> real executor/Guard -> Workspace cases are green for four deceptive protected links, four explicitly supplied protected URLs, an exact safe user URL, and a fresh safe inspected link. Protected cases focus/highlight and release without a Workspace mutation; safe cases reach exactly one Workspace mutation.
- Focused final guard/executor/Orchestrator command: `3 files / 190 tests passed`.

### 2. Binding reuse eligibility and identity

RED:

- Registry/catalog tests admitted a disabled/stale binding because catalog used the live-map `list` without resolving the current runtime.
- Acquisition had no second eligibility check after Workspace ownership was acquired, and an existing lease exposed no action-time eligibility assertion.
- Application tests showed that a fabricated stale fingerprint and a same-version reinstall binding remained live without explicit lifecycle revocation.

GREEN:

- Production `isEligible` resolves the authoritative installed or development runtime and requires enabled, valid-integrity state plus exact workflow id, version, source, development build hash, workflow security fingerprint, and canonical browser permission matrix.
- `listEligible` revokes stale entries before catalog admission. `acquire` checks before Workspace acquisition and again after it; a failed second check releases ownership and revokes the binding. Every inspect/action and handoff reasserts eligibility, including immediately before mutation dispatch.
- Installed remove/disable/install paths revoke the exact installed identity. Development build and run rebuilds revoke the prior development build even when the rebuilt hash is unchanged.
- Application coverage uses real remove -> same-version install, real integrity verification after file tampering, service disable/remove, development-mode disable/rebuild, and stale fingerprint paths. Registry tests cover post-acquire and live-lease eligibility races.

### 3. Raw inspection work limits and cancellation

RED:

- Oversized raw AX input was previously filtered/truncated before protected descendants could be considered; locator resolution silently sliced results; hung CDP work had no deadline; cancellation did not bound a hung command.
- New tests expected no partial snapshot and `ACTION_LIMIT_EXCEEDED`/`CANCELLED`, but the old paths continued describing nodes or remained pending.

GREEN:

- Manifest login/marker/readable/manual-action arrays have a 32-item JSON-schema and shared-contract cap. The inspector additionally caps the combined policy locator set.
- Raw inspection caps are 1,500 AX nodes, 4 MiB raw serialized AX/result data, 256 matches per locator, 2,048 matches overall, and 2,048 shared CDP calls. No protected descendant or locator result is silently sliced; exceeding a boundary rejects the entire snapshot.
- Inspector and Workspace enforce a five-second default deadline and propagate `AbortSignal`/absolute deadlines through raw reads. A hung CDP command rejects promptly with `ACTION_LIMIT_EXCEEDED`; cancel/takeover rejects with `CANCELLED`; late raw completion cannot return a partial snapshot.
- Focused coverage includes oversized AX, locator fan-out, total CDP calls, a hung command, cancellation, takeover, and zero DOM descriptions/partial output after an over-limit raw tree.

### 4. Status, lease, handoff, and restart truth

RED:

- Successful inspect/action calls emitted `completed` while the provider could still issue another browser call and before the lease was released.
- Handoff left a takeover surface although the executor had released authority. Persisted `inspecting`/`acting` blocks survived process recovery unchanged.
- Terminal cleanup failure could leave a success-looking browser card.

GREEN:

- Per-step success remains `inspecting` or `acting` with a fixed waiting-for-next-step summary. `completed` is emitted only after final cleanup succeeds. Cancel/takeover/failure terminal states match their outcomes, and cleanup failure forces both run and browser status to `failed/INTERNAL_ERROR`.
- Handoff sets a terminal `awaiting_user` status, removes Stop/Takeover availability, and makes later Orchestrator takeover return `false` without calling the executor.
- Startup recovery rewrites only `inspecting`/`acting` browser blocks belonging to chat runs actually failed by recovery. They become a fixed terminal failure; completed, handoff, unrelated, preserved-media, and malformed blocks remain untouched.
- Tests cover the provider-decision gap, successful completion, failed cleanup, cancel, takeover, handoff, absent/no-live-lease controls, and crash/reload recovery.

### 5. Trusted toolbar tab activation

RED:

- Trusted activation selected another tab without invalidating the currently automated tab, allowing an in-flight old-tab action to complete after the visible selection changed.

GREEN:

- Activating a different trusted toolbar tab synchronously clears continuation ownership/invalidation, awaits Registry/Orchestrator takeover, and only then activates the selected tab. A takeover failure prevents the switch.
- The in-flight switch test proves the old lease is invalid before selection, the late click returns `CANCELLED`, and only the selected view is attached. Toolbar repaint remains caught/fire-and-forget for immediate visual truth; user input handlers catch the asynchronous takeover promise.

### 6. Bounded terminal tombstones

RED:

- `terminalRuns` was an unbounded `Set` retaining every run id for the process lifetime.

GREEN:

- It is now a TTL/LRU `Map`, defaulting to 4,096 entries and 30 minutes. Access refreshes recency; insertion evicts the least-recently-used id; expiry is deterministic through the injected clock.
- The focused test proves capacity eviction, access-based LRU retention, late-call cancellation for retained ids, and exact TTL expiry.

### 7. Truthful `region_image` contract

RED:

- The provider catalog advertised `region_image`, the executor accepted it, and the Orchestrator schema could serialize the base64 result as ordinary tool text even though no production model-vision capability was wired.

GREEN:

- The production browser tools now advertise and accept semantic inspection only. Executor input rejects `mode`, `ref`, and `region_image`; strict Orchestrator result validation accepts only a semantic snapshot.
- The existing internal inspector screenshot primitive remains isolated and tested, but there is no Agent/provider call path to it. Therefore production neither offers an unreachable vision mode nor persists screenshot bytes. Catalog/executor/strict-result/durable-exclusion tests prove that boundary.

### 8. Historical value provenance

RED:

- `history` remained in the executor/catalog affordance while the production Orchestrator always passed an empty reference list, creating a misleading contract that could never establish frozen current-user intent.

GREEN:

- `history` was removed from the value-source type, provider schema, executor schema, and run context. A model attempt to use it is rejected as `INVALID_INPUT`.
- Conservative behavior is explicit: a historical value must be restated in the current user message before it can authorize a fill/select/check. Durable history and page/model text cannot become value authority.

### 9. Automated acceptance mapping

RED:

- The E2E seed fabricated an uninstalled workflow id/fingerprint, so real eligibility correctly returned an empty catalog.
- The first real reinstall conversion exposed an obsolete fake-fingerprint assertion, and the normally run workflow exposed the second external approval (`browser.fill` then `browser.click`).
- The full-path draft test initially failed because no provider `browser_session_act` attempt existed. After adding that provider route, an intermediate run correctly rejected the non-delimited value as `INVALID_INPUT`; the user request was made explicit with `聘用单位：<value>` and then passed.

GREEN:

- Seeded bindings now derive id/version/source, permission matrix, browser-continuation policy, and security fingerprint from the genuinely installed fixture workflow.
- Same-version reinstall uses real Application `workflows.remove` and `installProject`, not a direct Registry command. Popup inheritance asserts the real parent/child fingerprint.
- The draft case now starts with Renderer chat, uses the offered inspect result in the deterministic provider, emits schema-validated fill/click actions, traverses the production Orchestrator/executor/Workspace, observes the changed DOM and exact draft beacon, and keeps `finalSubmissions: 0` until the explicit user click.
- Final real Electron command: `pnpm test:e2e:browser-continuation` -> `19/19 passed` in 52.5 seconds, including native ABI preparation and a fresh production/test-entry build.

### 10. Lint baseline

GREEN with explicit baseline debt:

- ESLint over every TypeScript/JavaScript/Vue file changed since pre-feature base `e45cb32f...` exits 0 with zero errors. It reports four warning-only formatting findings in the already-existing feature change to `SettingsView.vue`.
- Root `pnpm lint` remains exactly `333 problems (5 errors, 328 warnings)`. The five errors are only `ContextSidebar.vue` DOM globals at lines 270, 274, 287, and twice at 306.
- `git diff --exit-code e45cb32f... -- apps/desktop/src/components/ContextSidebar.vue` exits 0, proving those five errors are byte-identical pre-feature baseline debt. No broad lint cleanup or suppression was added.

## Changed interfaces and contracts

- `BrowserContinuationLease`: added asynchronous `assertEligible()`.
- `BrowserContinuationRegistryOptions`: added the production runtime `isEligible(binding)` resolver; Registry added `listEligible`.
- `BrowserValueSource`: removed `history`; navigation now requires a source.
- `BrowserActionTargetContext`: added Main-only canonical `href` for live link equality.
- `BrowserPageCdpPort` read inputs: added optional `AbortSignal` and absolute deadline.
- Browser inspect provider/executor contract: semantic snapshot only; removed region-image mode/ref arguments and image result union.
- Browser catalog: consumes only eligibility-filtered Registry bindings.
- Workflow browser-continuation arrays: maximum 32 in JSON schema and shared runtime validation; `BROWSER_CONTINUATION_ARRAY_LIMIT` documents the TypeScript contract.
- `AppRepositories.messages`: added `failInterruptedBrowserStatuses(requestIds)` for transactional startup recovery.
- Browser status UI: `awaiting_user` is terminal and disables Stop/Takeover.
- Test-only E2E command: replaced direct Registry version-change behavior with real fixture workflow reinstall; removed the direct draft scenario.

## Security analysis

- Authority is frozen from the current user message before page data reaches the model. Page data can identify only a fresh exact link; it cannot add a user URL, value, action category, workflow identity, permission, or conversation binding.
- Canonical URL comparison covers the full scheme/host/port/path/query/fragment and rejects userinfo/non-HTTPS values. Navigation never falls back to origin or substring authority.
- The Guard independently classifies destination semantics after authorization. Exact user authorization does not automate logout, destructive, financial, submit/approval, or unknown mutation-like navigation; it hands control to the user.
- Runtime reuse is fail-closed at catalog, pre-acquire, post-acquire, live lease, and pre-dispatch boundaries. Revalidation compares the current authoritative runtime and revokes/cleans stale ownership.
- Raw inspection work is bounded before semantic filtering. Over-limit/hung/cancelled work yields stable safe errors and no partial model-visible snapshot.
- Browser status is derived from live lifecycle, not per-tool optimism. Handoff and terminal cleanup remove active controls; restart recovery cannot leave a persisted active-looking card for an interrupted run.
- Tombstones retain realistic late-call rejection without unbounded memory growth.
- Screenshot bytes and historical values have no production Agent contract. Durable context continues to contain only the bounded Main-owned browser-status/evidence projection.
- Repository search over production Main/Preload/Renderer sources finds no E2E marker, `finalSubmissions`, or test-entry hook. The only remaining `region_image` references are the isolated internal inspector primitive and its unit tests.

## Final verification

- Impacted contracts/Main/Renderer suite: `13 files / 784 tests passed`.
- Shared and workflow-schema builds: PASS (`tsc -p tsconfig.json` for both).
- Focused shared/schema contracts: `2 files / 94 tests passed`.
- Full unit suite: `88 files / 2288 tests passed`; native Electron `better-sqlite3` probe passed first.
- Full typecheck: PASS for shared, workflow SDK, workflow schema, desktop Node, and Renderer.
- Full build: PASS. The only messages were the two existing third-party VueUse misplaced `/* #__PURE__ */` warnings.
- Full real Electron E2E: `19/19 passed` in 52.5 seconds.
- Feature-diff ESLint: exit 0, zero errors, four warning-only `SettingsView.vue` findings.
- Root lint: expected baseline exit 1, exactly 5 errors and 328 warnings as documented above.
- Pre-feature `ContextSidebar.vue` diff: clean/byte-identical.
- `git diff --check`: PASS.
- Production E2E/backdoor marker search: no matches.

A non-gating diagnostic `pnpm --filter @autoforge/workflow-schema test` still resolves the root Vitest config relative to the package working directory and therefore looks for `packages/workflow-schema/apps/desktop/vitest.config.ts`. This pre-existing package-script issue was not broadened into the feature; the repository-owned Electron Vitest runner above passes all 94 focused shared/schema contracts.

## Remaining concerns and manual acceptance

- The five pre-feature `ContextSidebar.vue` lint errors remain explicit baseline debt; no feature file has a lint error.
- Historical values require restatement in the current request. This is deliberately conservative until a stable, Main-owned historical-message-reference contract can bind the user's current intent.
- Agent vision/region screenshots are deliberately not offered. Supporting them later requires a Main-owned model-vision capability and ephemeral media transport that is excluded from durable context.
- The user-assisted Beijing portal smoke was **not performed and is not claimed as passed**. It remains pending because it requires the user to enter private credentials and personally verify the real portal's login, source/read-time, draft stop-before-submit, takeover, cross-conversation denial, and durable redaction behavior.
