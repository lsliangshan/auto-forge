# Task 3 Report: identity-checked page clip primitive

## Scope

- Added `BrowserPageCdpPort.capturePageScreenshot(input): Promise<string>`.
- Implemented it only in `ElectronBrowserWorkspace` using the existing continuation, origin, and navigation-epoch guards.
- Added only the TypeScript-required fixture stubs outside the three primary task files.
- Did not alter public renderer APIs, database/workflow code, or full-page visual policy.

## RED

Command:

```sh
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/electron-browser-workspace.test.ts \
  -t "bounded page clip|page clip changes"
```

Observed failure before implementation:

```text
TypeError: workspace.capturePageScreenshot is not a function
```

The first new test failed for the intended missing-method reason.

## GREEN

The implementation:

- obtains the current continuation state and enters `restricted` with only `expectedOrigin`;
- checks continuation run, expected origin, and navigation epoch before capture;
- rejects non-finite values, negative x/y, non-positive width/height, and clips over `1_000_000` pixels with `UNSUPPORTED_CONTROL`;
- sends `Page.captureScreenshot` with PNG, `fromSurface: true`, `captureBeyondViewport: true`, and `scale: 1`;
- checks the continuation state again after CDP resolves and rejects stale output with `PAGE_CHANGED`;
- rejects absent/empty response data with `INTERNAL_ERROR`.

Target test command after implementation:

```text
Test Files  1 passed (1)
Tests  2 passed | 88 skipped (90)
```

Final required browser suites:

```sh
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/electron-browser-workspace.test.ts \
  electron/main/browser/browser-page-inspector.test.ts
```

Output:

```text
Test Files  2 passed (2)
Tests  264 passed (264)
Duration  46.93s
```

Type check:

```sh
cd apps/desktop
pnpm typecheck
```

Output:

```text
$ tsc --noEmit -p tsconfig.node.json && vue-tsc --noEmit -p tsconfig.web.json
```

## Files

- `apps/desktop/electron/main/browser/browser-page-inspector.ts`
- `apps/desktop/electron/main/browser/electron-browser-workspace.ts`
- `apps/desktop/electron/main/browser/electron-browser-workspace.test.ts`
- `apps/desktop/electron/main/browser/browser-page-inspector.test.ts` (required fixture stub)
- `apps/desktop/electron/main/agent/agent-orchestrator.test.ts` (two required fixture stubs)
- `apps/desktop/electron/main/application.test.ts` (required fixture stub)

## Self-review

- The new port input is exactly a page-read input plus a four-value clip.
- Both added tests use the real workspace; the fake debugger is only the CDP boundary.
- The stale-response test delays the CDP response, increments navigation epoch via `did-navigate`, then resolves the response and observes `PAGE_CHANGED`.
- `git diff --check` passed.

## Concerns

- No remaining implementation concern. Clip-boundary validation is intentionally implemented from the brief's prescribed guard; the new RED/GREEN coverage is limited to the specified bounded-success and page-change cases.
