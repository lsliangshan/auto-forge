# Manual smoke takeover-focus fix report

## Scope and implementation

- Base: `5dbd6d60df1b6df989fc160834bf30f700f5383d`.
- Changed `apps/desktop/electron/main/browser/electron-browser-workspace.ts` and `electron-browser-workspace.test.ts` only, plus this report.
- `before-mouse-event` now calls `preventDefault()` only while a continuation run owns the target tab and no CDP synthetic pointer operation is active. It no longer calls the user-takeover path.
- Keyboard input remains on the existing takeover path. Trusted toolbar/status-card Stop and Takeover routes were not changed.

## TDD evidence

Before writing the production branch, the tests named the mutation they protect: replacing the mouse listener with the previous takeover call, omitting `preventDefault`, or preventing synthetic/unowned mouse input must fail a consumer-visible lease, invalidation, pending-result, or event assertion.

### RED

Command run before the production change:

```text
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/browser/electron-browser-workspace.test.ts
```

Result:

```text
Test Files  1 failed (1)
Tests  3 failed | 62 passed (65)

blocks physical target mouse input during a pending continuation read without cancelling its result
blocks physical target mouse input during a pending continuation screenshot without cancelling its result
blocks physical target mouse input while an owned continuation tab is idle

AssertionError: expected "vi.fn()" to be called once, but got 0 times
```

The failure occurred at each new `preventDefault` assertion, proving the old listener still treated physical mouse input as takeover. Because those early assertions intentionally stopped the pending-operation tests before their test gates were resolved, Vitest additionally reported one `ACTION_LIMIT_EXCEEDED` unhandled rejection from the abandoned test operation; the focused GREEN run has no unhandled errors.

### GREEN

The same focused command after the minimal production change:

```text
Test Files  1 passed (1)
Tests  65 passed (65)
```

The focused tests prove:

- A physical target mouse event during pending continuation read and screenshot calls `preventDefault`, leaves the lease current, emits no invalidation, and lets the pending result resolve.
- The same event is blocked while the lease is idle, and trusted-toolbar controls remain present without a repaint.
- CDP-dispatched pointer input remains unblocked while `syntheticInputOperations > 0` and retains its lease.
- Mouse input is unblocked after continuation ownership is released.
- Existing keyboard takeover coverage remains green, including the rejected-toolbar-repaint takeover path now driven by `before-input-event`.

## Full verification

```text
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/electron-browser-workspace.test.ts \
  electron/main/browser/browser-continuation-registry.test.ts \
  electron/main/browser/browser-page-inspector.test.ts \
  electron/main/agent/browser-continuation-catalog.test.ts \
  electron/main/agent/browser-continuation-tool-executor.test.ts
# PASS: 5 files / 284 tests

pnpm test
# PASS: 88 files / 2454 tests; Electron 43.1.1 better-sqlite3 preparation passed

pnpm typecheck
# PASS: shared, workflow SDK, workflow schema, desktop Node, and Renderer

pnpm test:e2e:browser-continuation
# PASS: 19 passed (53.3s), including production build and real Electron launch

pnpm exec eslint apps/desktop/electron/main/browser/electron-browser-workspace.ts \
  apps/desktop/electron/main/browser/electron-browser-workspace.test.ts
# PASS: exit 0, no output

pnpm build
# PASS: exit 0; only the existing third-party VueUse annotation-placement warnings

git diff --check
# PASS: exit 0, no output
```

## Self-review

- The implementation has one ownership/synthetic-input condition and no time, focus, platform, configuration, or UI heuristic.
- Mouse events cannot clear continuation ownership, invalidate the page, invoke Registry takeover, cancel a pending restricted operation, or trigger the takeover toolbar repaint.
- The event is deliberately left unprevented for synthetic CDP pointer input and after ownership removal.
- Explicit toolbar/status-card controls and keyboard takeover retain their existing contracts; no port or IPC contract changed.
- Mutation check: removing ownership guarding, suppressing `preventDefault`, calling `handleUserTakeover`, or blocking synthetic/unowned mouse input each makes at least one focused test fail.

## Fix Round 1 — transparent trusted-toolbar input shield

### Files changed

- `apps/desktop/electron/main/browser/electron-browser-workspace.ts`
- `apps/desktop/electron/main/browser/electron-browser-workspace.test.ts`
- `apps/desktop/electron/e2e/browser-continuation-main.ts`
- `apps/desktop/tests/e2e/browser-continuation.spec.ts`
- This report.

### Implementation

- The existing trusted toolbar becomes full-content-height and is synchronously raised above the active target while that target has continuation ownership. Its document and native view background are transparent below the 52px toolbar, so the target remains visible but does not receive real pointer input.
- Ownership acquisition, explicit release, and keyboard takeover all synchronously relayout before their asynchronous toolbar repaint.
- Target mouse input remains only defense-in-depth takeover handling; the shield, not `syntheticInputOperations`, is the real-pointer boundary. CDP continues to dispatch directly to the target view, and the existing synthetic counter therefore only suppresses that direct executor event.
- Keyboard input from either the target or the now-focused trusted shield uses the existing takeover route. Loading and blocked-origin full-height trusted surfaces retain their existing layout.

### TDD evidence

#### RED

Focused unit RED, after adding the shield/keyboard/public-route expectations but before the production implementation:

```text
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/browser/electron-browser-workspace.test.ts

Test Files  1 failed (1)
Tests  6 failed | 60 passed (66)

Expected full-height toolbar shield: received height 52.
Expected keyboard takeover/release to remove shield: continuation remained current or toolbar stayed full-height.
```

Real Electron probe RED, before adding its harness command:

```text
pnpm test:e2e:browser-continuation -- --grep "transparent trusted toolbar shield"

11 passed; the new shield test failed with:
Unknown browser continuation E2E command: shieldProbe
```

The first full E2E execution after the implementation also caught an incorrect test assumption that the macOS content height was 820 rather than the actual 788. The probe was corrected to assert the required content-bound relationship (`toolbar.height === target.y + target.height`) rather than a platform titlebar constant.

#### GREEN

```text
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/browser/electron-browser-workspace.test.ts
# PASS: 1 file / 66 tests

pnpm test:e2e:browser-continuation
# PASS: 20 passed (56.5s)
```

The real `BaseWindow`/`WebContentsView` probe asserts the full-height transparent trusted view is topmost, a pointer is delivered to that shield and not to the target, and, during the same owned interval, a direct CDP pointer event is observed by the underlying target. The focused tests cover pending read/screenshot ownership, idle ownership, public toolbar takeover shrinking the shield, target and shield keyboard takeover, and pending-action cancellation.

### Full verification

```text
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/electron-browser-workspace.test.ts \
  electron/main/browser/browser-continuation-registry.test.ts \
  electron/main/browser/browser-page-inspector.test.ts \
  electron/main/agent/browser-continuation-catalog.test.ts \
  electron/main/agent/browser-continuation-tool-executor.test.ts
# PASS: 5 files / 285 tests

pnpm test
# PASS: 88 files / 2455 tests

pnpm typecheck
# PASS: all workspace packages plus desktop Node and Renderer checks

pnpm test:e2e:browser-continuation
# PASS: 20 passed (56.5s), including production build and real Electron launch

pnpm exec eslint apps/desktop/electron/main/browser/electron-browser-workspace.ts \
  apps/desktop/electron/main/browser/electron-browser-workspace.test.ts \
  apps/desktop/electron/e2e/browser-continuation-main.ts \
  apps/desktop/tests/e2e/browser-continuation.spec.ts
# PASS: exit 0, no output

pnpm build
# PASS: exit 0; only existing third-party VueUse annotation-placement warnings

git diff --check
# PASS: exit 0, no output
```

### Self-review

- The physical-pointer guarantee comes from native view stacking and transparency, not a counter, timing, coordinates, focus state, or platform branch.
- The shield is installed before `acquireContinuation()` resolves and removed synchronously on release or any explicit keyboard/takeover transition.
- CDP target dispatch remains functional while ownership is held; a simultaneous real pointer cannot reach that target because the trusted topmost shield owns the hit area.
- The public trusted-toolbar takeover path is exercised rather than low-level release. Existing Stop, loading, blocked-origin, and target keyboard paths remain green.
- No configuration, IPC contract, or visible product UI was added. The E2E probe is intentionally the only added harness surface, required to exercise the real Electron view boundary.

## Fix Round 2 — persistent composited toolbar hit surface

### Root cause and files changed

The user's physical-click smoke after restarting Main at `1403e0f` reproduced the bug: a click in visible target content reached the target `before-mouse-event` and cancelled the lease. Although the full-height trusted `WebContentsView` was topmost, its transparent area below the 52px bar had no full-viewport DOM element or nonzero composited paint, so the native click passed through it.

- `apps/desktop/electron/main/browser/electron-browser-workspace.ts`
- `apps/desktop/electron/e2e/browser-continuation-main.ts`
- `apps/desktop/tests/e2e/browser-continuation.spec.ts`
- This report.

### Implementation

- The toolbar document always contains an `aria-hidden` `data-autoforge-input-shield` element, including before any continuation lease is acquired.
- `html` and `body` now explicitly fill the viewport. The surface is fixed to the content below the 52px toolbar, has `pointer-events:auto`, and uses `rgb(0 0 0 / 0.004)`: the smallest nonzero alpha that Chromium reports for a one-step 8-bit composited paint while remaining visually imperceptible.
- The toolbar, loading surface, and blocked surface are above it with their existing appearance and controls. No ownership, CDP, keyboard, Stop, or Takeover logic changed.

### TDD evidence

#### RED

Before the production document/CSS edit, I added the real Electron harness query and behavior test, then ran:

```text
pnpm --filter @autoforge/desktop exec tsup electron/e2e/browser-continuation-main.ts --format esm --platform node --external electron --external better-sqlite3 --out-dir .e2e/main --clean && \
pnpm --filter @autoforge/desktop exec playwright test tests/e2e/browser-continuation.spec.ts --grep "pre-rendered composited hit surface"

1 failed
Received value: undefined
at expect(before.surface).toMatchObject({ pointerEvents: 'auto' })
```

This is the required pre-ownership failure: the trusted toolbar document had no hit surface. It would also fail if the element were removed. Removing its viewport coverage fails the post-acquisition dimensions/`elementFromPoint` assertion; making its paint fully transparent fails the positive-alpha assertion.

#### GREEN

The same focused real-Electron command after the minimal production edit:

```text
1 passed (4.8s)
```

The probe proves the surface exists while the native view is still only 52px high. After `acquireContinuation()` returns, the already-rendered surface fills the synchronously expanded trusted view; a point at `(24, 96)` resolves to it, with `pointer-events:auto`, target-sized bounds, and `0 < alpha <= 0.004`. The existing direct-CDP assertion remains green in that same owned interval.

Chromium serializes the supplied one-step alpha as `0.004`, so the test uses that exact upper bound rather than the unrounded mathematical `1 / 255`.

### Full verification

```text
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/browser/electron-browser-workspace.test.ts
# PASS: 1 file / 66 tests

pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/electron-browser-workspace.test.ts \
  electron/main/browser/browser-continuation-registry.test.ts \
  electron/main/browser/browser-page-inspector.test.ts \
  electron/main/agent/browser-continuation-catalog.test.ts \
  electron/main/agent/browser-continuation-tool-executor.test.ts
# PASS: 5 files / 285 tests

pnpm test
# PASS: 88 files / 2455 tests

pnpm typecheck
# PASS: all workspace packages plus desktop Node and Renderer checks

pnpm test:e2e:browser-continuation
# PASS: 21 passed (1.0m), including the new persistent-hit-surface check

pnpm exec eslint apps/desktop/electron/main/browser/electron-browser-workspace.ts \
  apps/desktop/electron/e2e/browser-continuation-main.ts \
  apps/desktop/tests/e2e/browser-continuation.spec.ts
# PASS: exit 0, no output

pnpm build
# PASS: exit 0; only existing third-party VueUse annotation-placement warnings

git diff --check
# PASS: exit 0, no output
```

### Self-review and evidence limit

- The input surface is persistent before ownership, so synchronous native view expansion does not depend on asynchronous `renderToolbar()` completion.
- It is bounded below the existing trusted toolbar and deliberately below the loading/blocked trusted surfaces; their visual and hit-testing behavior remains unchanged.
- The E2E harness can inspect the real `BaseWindow`/`WebContentsView` DOM, bounds, and direct-CDP-to-target path, but it has no OS-level pointer injector for this separate native `BaseWindow` and no composite-window bitmap capture API. Therefore it cannot independently prove the macOS compositor's physical-click result or a pixel-difference tolerance against the underlying target. The persistent element, full viewport sizing, `elementFromPoint` result, and nonzero composited paint are the strongest available automated preconditions; the user's repeated physical-click smoke after this commit is the remaining closure evidence.
