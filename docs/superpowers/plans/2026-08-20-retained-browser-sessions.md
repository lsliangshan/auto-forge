# Electron Browser Workspace Implementation Plan

**Goal:** Preserve consecutive developer input, replace Playwright Chrome for Testing with one persistent multi-tab Electron browser window, and merge the verified result locally into `v2`.

**Architecture:** `ExecutionService` carries authenticated user attribution into `BrowserCapabilityService`. The capability service preserves permission semantics while an injected `ElectronBrowserWorkspace` owns `BaseWindow`, persistent-session `WebContentsView` tabs, CDP selectors, user controls, and lifecycle.

**Tech Stack:** TypeScript 6, Vue 3, Electron 43, Chrome DevTools Protocol, Vitest 4, electron-builder.

**Spec:** `docs/superpowers/specs/2026-08-20-retained-browser-sessions-design.md`

## Task 1: Consecutive Developer Input

- Add a failing component regression test that runs the same schema-driven input twice without editing.
- Replace the deep schema watch with a stable project/schema key and control primitive field values.
- Run focused renderer tests and commit.

## Task 2: User-Scoped Capability Context

- Add failing execution and agent tests proving authenticated `userId` reaches capability requests without entering worker messages.
- Add `userId` to `ExecutionStartInput`, active execution state, and `CapabilityContext`.
- Pass the current auth user from developer runs and the existing agent user from chat runs.
- Run execution, agent, and application tests and commit.

## Task 3: Electron Browser Workspace

- Define narrow workspace/tab/session/constructor ports and fake-driven tests first.
- Test one lazy `BaseWindow`, trusted toolbar, multiple switchable tabs, user-scoped persistent partitions, reuse, explicit/user close, resize, shutdown, security preferences, permissions, and proxy refresh.
- Implement `ElectronBrowserWorkspace` with injected Electron constructors and session factory.
- Add CDP tests for exact CSS/role resolution, fill, click, load waiting, and invalid matches.
- Implement CDP automation and run focused tests until green.
- Commit.

## Task 4: Browser Capability Adapter

- Replace Playwright-focused tests with workspace-port tests for permission checks, execution binding/release, same-user reuse, concurrency, explicit close, and navigation violations.
- Rewrite `BrowserCapabilityService` around the workspace port while preserving the SDK/worker contract.
- Ensure `closeExecution` releases ownership without closing tabs and shutdown closes the workspace.
- Run browser, execution, and application tests and commit.

## Task 5: Main-Process Wiring and Proxy Lifecycle

- Inject Electron `BaseWindow`, `WebContentsView`, and `session.fromPartition` from `index.ts`.
- Refresh live browser partitions after successful proxy transitions and rollback transitions.
- Add shutdown ordering and focused application/index-independent tests.
- Run focused tests and commit.

## Task 6: Remove External Browser Runtime

- Add failing build/package configuration assertions for the absence of Playwright runtime staging.
- Remove `playwright-chromium`, stage script invocation, browser runtime resources, and obsolete tests/code.
- Update the lockfile and packaged verifier assumptions.
- Run build configuration tests, dependency install, and build; commit.

## Task 7: Integrated Verification and Local Merge

- Run desktop renderer and node tests, workspace typecheck, build, `git diff --check`, and packaged directory verification.
- Perform a real `百度搜索` workflow smoke test when the GUI runtime is available; otherwise report the exact remaining manual check.
- Review every changed line against the approved spec.
- Merge the feature branch locally into `v2` without overwriting the user's dirty changes, then re-run focused verification on the merge result.
