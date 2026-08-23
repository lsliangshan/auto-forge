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
