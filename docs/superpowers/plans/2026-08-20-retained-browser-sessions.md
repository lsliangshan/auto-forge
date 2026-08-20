# Retained Browser Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve developer debug input across equivalent builds, retain successful workflow browser windows for user interaction, and verify the bundled Chromium dependency.

**Architecture:** `ExecutionService` reports successful terminal browser ownership through a capability lifecycle method. `BrowserCapabilityService` performs an atomic handoff from guarded automation state to an unguarded retained user session keyed by workflow ID, while packaging continues to ship a pinned Chromium runtime and now verifies it can execute.

**Tech Stack:** TypeScript 6, Vue 3, Pinia, Electron 43, Playwright Chromium 1.61, Vitest 4, electron-builder.

**Spec:** `docs/superpowers/specs/2026-08-20-retained-browser-sessions-design.md`

## Global Constraints

- Retain only successful browser executions; all other terminal outcomes close immediately.
- Keep at most one retained browser per `workflowId`.
- Do not change workflow SDK, manifest permissions, or database schemas.
- Bundle Chromium; do not download it at runtime or use a user-installed browser.
- Preserve all pre-existing user changes in the main `v2` worktree.

---

### Task 1: Preserve Schema-Driven Debug Input

**Files:**
- Modify: `apps/desktop/src/components/developer/DebugPanel.vue`
- Test: `apps/desktop/tests/components/developer.test.ts`

**Interfaces:**
- Consumes: `developer.selectedProjectId`, `developer.currentManifest`, `developer.debugInput`.
- Produces: a stable schema watch key and controlled primitive input values.

- [ ] Add a component test that enters `今日天气`, completes one run, invokes a second run without editing, and expects both `developer.run` calls to contain `{ keyword: '今日天气' }`.
- [ ] Run the focused component test and confirm it fails because the second call contains `{}`.
- [ ] Replace the deep object watch with a selected-project/schema-content key and bind primitive controls to `debugInput`.
- [ ] Run the component tests and confirm they pass.
- [ ] Commit the task.

### Task 2: Define Terminal Capability Ownership

**Files:**
- Modify: `apps/desktop/electron/main/workflows/execution-service.ts`
- Test: `apps/desktop/electron/main/workflows/execution-service.test.ts`

**Interfaces:**
- Produces: `CapabilityPort.retainExecution(executionId: string, workflowId: string): Promise<void> | void`.
- Preserves: `closeExecution(executionId: string): Promise<void> | void`.

- [ ] Add tests proving completed executions call `retainExecution`, failed executions call `closeExecution`, and retention failure falls back to close without changing the durable completed result.
- [ ] Run focused execution-service tests and confirm the missing method/behavior fails.
- [ ] Add the lifecycle method and minimal terminal branching, retaining before policy release.
- [ ] Update complete test doubles with the new method.
- [ ] Run execution-service and application tests.
- [ ] Commit the task.

### Task 3: Handoff and Retain Browser Sessions

**Files:**
- Modify: `apps/desktop/electron/main/browser/browser-capability.ts`
- Test: `apps/desktop/electron/main/browser/browser-capability.test.ts`

**Interfaces:**
- Consumes: `retainExecution(executionId, workflowId)` from Task 2.
- Produces: `BrowserCapabilityService.shutdown(): Promise<void>` and in-memory retained sessions keyed by workflow ID.

- [ ] Add tests for successful handoff, free navigation after handoff, cleanup on user close, same-workflow replacement, different-workflow independence, and shutdown cleanup.
- [ ] Run the browser tests and confirm the retention tests fail.
- [ ] Track route handlers and retained state, dispose route/CDP guards during handoff, and serialize retention transitions.
- [ ] Close a same-workflow retained session before creating the next owner.
- [ ] Clean profiles when a retained context closes and implement shutdown for active plus retained states.
- [ ] Run the browser tests until green.
- [ ] Commit the task.

### Task 4: Application Shutdown and Browser Runtime Error

**Files:**
- Modify: `packages/shared/src/errors.ts`
- Modify: `apps/desktop/src/services/desktop-api.ts`
- Modify: `apps/desktop/electron/main/browser/browser-capability.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Test: `packages/shared/src/contracts.test.ts`
- Test: `apps/desktop/electron/main/browser/browser-capability.test.ts`
- Test: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Produces: `BROWSER_RUNTIME_UNAVAILABLE` safe application error.
- Consumes: `BrowserCapabilityService.shutdown()` from Task 3.

- [ ] Add failing tests for missing packaged runtime, launch failure, localized renderer copy, and application shutdown cleanup ordering.
- [ ] Add the error code and map runtime resolution/launch failures to it.
- [ ] Add browser shutdown to application close after execution shutdown and before database close.
- [ ] Run shared, browser, renderer, and application tests.
- [ ] Commit the task.

### Task 5: Verify Packaged Chromium

**Files:**
- Modify: `apps/desktop/scripts/verify-packaged-native.mjs`
- Test: packaged `pnpm dist:dir` verification on the supported host target.

**Interfaces:**
- Consumes: packaged `resources/browser-runtime.json` written by `stage:browser`.
- Produces: a failing package build when the bundled browser path is unsafe, missing, or cannot execute `--version`.

- [ ] Resolve and validate the packaged browser manifest and executable without allowing resources-directory escape.
- [ ] Spawn the packaged Chromium executable with `--version` and require exit code zero.
- [ ] Run focused lint/typecheck and the packaged directory verification.
- [ ] Commit the task.

### Task 6: Integrated Verification and Local Merge

**Files:**
- Verify all changed files and docs.

- [ ] Run `pnpm typecheck`.
- [ ] Run ESLint on all changed TypeScript/Vue files.
- [ ] Run `pnpm test` and investigate any failure rather than ignoring it.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm dist:dir` on the supported host target.
- [ ] Review `git diff --check`, changed files, and commits against the spec.
- [ ] Merge the feature branch locally into `v2`, restore the user's pre-existing changes, and re-run focused plus full verification on the merged commit snapshot.

