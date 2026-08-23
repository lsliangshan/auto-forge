# Persistent Browser Session Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve workflow website login state across new target pages and AutoForge restarts by securely restoring origin-scoped `sessionStorage`.

**Architecture:** A focused encrypted store persists one bounded origin map per AutoForge user through the existing `SecretStore`. `ElectronBrowserWorkspace` installs an allowed-origin CDP bootstrap before navigation and mirrors session-storage DOM events back to the encrypted store; Chromium continues to own all durable browser storage.

**Tech Stack:** TypeScript, Electron safeStorage, SQLite encrypted-secrets repository, Chrome DevTools Protocol DOMStorage/Page domains, Vitest, Playwright Electron E2E.

**Spec:** `docs/superpowers/specs/2026-08-23-persistent-browser-session-storage-design.md`

## Global Constraints

- Never persist or log plaintext website session-storage values outside the target renderer and OS-encrypted secret boundary.
- Restore only normalized HTTPS origins authorized by the workflow's existing permission matrix.
- Preserve the existing exact-provenance tab-reuse and conversation-bound continuation rules.
- Explicit browser-data clearing removes both Chromium data and encrypted session-storage data.
- Never downgrade to plaintext when Electron safeStorage is unavailable.

---

### Task 1: Encrypted per-user session-storage store

**Files:**
- Create: `apps/desktop/electron/main/browser/browser-session-storage-store.ts`
- Create: `apps/desktop/electron/main/browser/browser-session-storage-store.test.ts`

**Interfaces:**
- Consumes: `SecretStore.get(key)`, `SecretStore.set(key, value)`, and `SecretStore.delete(key)`.
- Produces: `BrowserSessionStorageStore` with `get(userId, allowedOrigins)`, `apply(userId, mutation)`, `clear(userId)`, and `drain()`; `EncryptedBrowserSessionStorageStore` implements the interface.

- [ ] **Step 1: Write failing tests for encrypted round-trip and isolation**

  Create real temporary application databases and fake OS encryption. Assert literal restored maps for two users and two origins, and assert raw `encrypted_secrets` rows do not contain test token values.

- [ ] **Step 2: Run the focused store test and verify RED**

  Run: `pnpm test apps/desktop/electron/main/browser/browser-session-storage-store.test.ts`

  Expected: FAIL because the store module and API do not exist.

- [ ] **Step 3: Implement the minimal encrypted store**

  Add opaque per-user secret keys, strict HTTPS-origin normalization, bounded JSON parsing, immutable returned records, and per-user serialized/coalesced writes. Reject non-string items and ignore malformed encrypted payloads without returning partial unsafe data.

- [ ] **Step 4: Add RED tests for ordered mutations, deletion, malformed payloads, and clear**

  Assert add/update/remove/clear semantics using hand-authored records; delay one encryption write and prove a later mutation wins; seed malformed JSON and non-HTTPS origins and prove nothing is restored; clear one user and prove another remains.

- [ ] **Step 5: Run the focused store test and verify GREEN**

  Run: `pnpm test apps/desktop/electron/main/browser/browser-session-storage-store.test.ts`

  Expected: PASS with no warnings.

### Task 2: Restore before navigation and persist CDP mutations

**Files:**
- Modify: `apps/desktop/electron/main/browser/electron-browser-workspace.ts`
- Modify: `apps/desktop/electron/main/browser/electron-browser-workspace.test.ts`

**Interfaces:**
- Consumes: `BrowserSessionStorageStore` from Task 1 and CDP `Page.addScriptToEvaluateOnNewDocument`, `Page.removeScriptToEvaluateOnNewDocument`, `DOMStorage.enable`, and DOMStorage mutation events.
- Produces: `ApplicationBrowserWorkspacePort.setSessionStorageStore(store)` and workspace lifecycle integration.

- [ ] **Step 1: Write a failing test for pre-navigation restoration**

  Seed a literal saved token for `https://fw.example`, open an allowed URL, and assert the Page bootstrap command is sent before target `loadURL`. Assert the generated bootstrap contains no records for a disallowed origin.

- [ ] **Step 2: Run the focused workspace test and verify RED**

  Run: `pnpm test apps/desktop/electron/main/browser/electron-browser-workspace.test.ts`

  Expected: FAIL because the workspace cannot accept a session-storage store or install a bootstrap.

- [ ] **Step 3: Implement minimal bootstrap wiring**

  Add a store setter, track each tab's bootstrap script identifier, load only allowed-origin records, serialize them safely into a fixed new-document bootstrap, install it before navigation, and remove replaced bootstrap scripts.

- [ ] **Step 4: Write failing tests for CDP mutation filtering and lifecycle draining**

  Emit literal add/update/remove/clear events from the fake debugger. Assert session-storage events reach the real workspace boundary, local-storage and non-HTTPS events do not, listeners detach with the tab, and shutdown waits for `store.drain()`.

- [ ] **Step 5: Implement mutation observation and lifecycle integration**

  Extend the debugger port with message listeners, enable DOMStorage once per target tab, normalize event origins, forward only session-storage mutations, detach listeners during teardown, and drain pending encrypted writes during shutdown and clear.

- [ ] **Step 6: Run the focused workspace test and verify GREEN**

  Run: `pnpm test apps/desktop/electron/main/browser/electron-browser-workspace.test.ts`

  Expected: PASS with no warnings.

### Task 3: Wire the encrypted store into application startup and clearing

**Files:**
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Consumes: `EncryptedBrowserSessionStorageStore`, the runtime `SecretStore`, and `ApplicationBrowserWorkspacePort.setSessionStorageStore`.
- Produces: application-owned secure store installation before browser use and deletion through the existing clear-browser-data path.

- [ ] **Step 1: Write a failing application test for secure-store installation**

  Start a real runtime with the existing fake safeStorage and workspace. Assert browser persistence can round-trip one origin through the runtime's encrypted repository and that the raw row omits the literal token.

- [ ] **Step 2: Run the focused application test and verify RED**

  Run: `pnpm test apps/desktop/electron/main/application.test.ts`

  Expected: FAIL because application startup does not install the encrypted browser store.

- [ ] **Step 3: Implement minimal runtime wiring**

  Construct `EncryptedBrowserSessionStorageStore` from the existing `SecretStore` and install it on the workspace before services can open a page. Keep the existing clear-browser-data IPC and let workspace clearing delete the user record.

- [ ] **Step 4: Run focused application and store tests and verify GREEN**

  Run: `pnpm test apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/browser/browser-session-storage-store.test.ts`

  Expected: PASS with no warnings.

### Task 4: Real Electron restart and explicit-clear regression

**Files:**
- Modify: `apps/desktop/electron/e2e/browser-continuation-main.ts`
- Modify: `apps/desktop/tests/e2e/browser-continuation-fixture.ts`
- Modify: `apps/desktop/tests/e2e/browser-continuation.spec.ts`

**Interfaces:**
- Consumes: the real Electron workspace, encrypted store, and local HTTPS fixture page.
- Produces: restart-level proof that authentication represented only by sessionStorage survives and explicit clearing removes it.

- [ ] **Step 1: Add a failing E2E fixture scenario**

  Serve a page whose authenticated marker depends only on a literal session-storage item. Open it, set the item through the page, close the first workspace, create a second workspace using the same user data, and assert the marker is authenticated before application scripts redirect.

- [ ] **Step 2: Run the focused Electron E2E and verify RED**

  Run: `pnpm test:e2e:browser-continuation`

  Expected: the restart scenario fails because the new WebContents has an empty sessionStorage namespace.

- [ ] **Step 3: Complete only the fixture plumbing required for GREEN**

  Bind the real encrypted store to both workspace instances and expose a fixture command that invokes `clearUserData` between the authenticated and cleared reopen checks.

- [ ] **Step 4: Run the focused Electron E2E and verify GREEN**

  Run: `pnpm test:e2e:browser-continuation`

  Expected: restart stays authenticated; explicit clear returns to logged out; all existing browser-continuation E2E checks pass.

### Task 5: Full verification and physical acceptance handoff

**Files:**
- Modify only files required to fix verification findings caused by Tasks 1-4.

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: a clean `v2` implementation ready for the user's real Beijing-site login acceptance.

- [ ] **Step 1: Run static and unit verification**

  Run: `pnpm typecheck && pnpm lint && pnpm test`

  Expected: all commands exit 0 with no new warnings.

- [ ] **Step 2: Run build and Electron browser E2E**

  Run: `pnpm build && pnpm test:e2e:browser-continuation`

  Expected: both commands exit 0.

- [ ] **Step 3: Inspect the security boundary**

  Query only secret keys and ciphertext metadata from the test/runtime database. Confirm no known literal fixture token appears in SQLite, logs, browser action audits, or chat messages; confirm explicit clearing removes the encrypted browser-session key.

- [ ] **Step 4: Restart the development application for physical acceptance**

  Start the updated `v2` application. Ask the user to log in once, restart AutoForge, and reopen the same page through chat. Expected: the page remains logged in; after Settings -> Clear browser data it requests login again.

