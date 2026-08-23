# Persistent Browser Session Storage Design

## Goal

Pages opened by workflows must retain their authenticated site state when a workflow opens the page again, including after AutoForge restarts. Existing persistent Chromium storage remains authoritative for cookies, local storage, IndexedDB, Cache Storage, service workers, and HTTP cache. This design adds the missing persistence boundary for `sessionStorage`.

## Confirmed Root Cause

Workflow target pages already use one opaque persistent Electron partition per AutoForge user. The affected Beijing service stores its effective login token under `sessionStorage.PTOKEN`, so a newly-created WebContents receives an empty session-storage namespace even though the persistent partition and its durable site data are unchanged.

## Security Boundary

- Persist session-storage values only through Electron `safeStorage`; never write plaintext values to SQLite, logs, audit records, chat history, or renderer IPC.
- Isolate records by AutoForge user and HTTPS origin. A workflow can receive restored values only after its existing browser permission matrix authorizes that origin.
- Do not expose saved keys or values through a new Renderer API.
- Do not override server-side expiry, revocation, or a site's decision to clear its own login state.
- If operating-system encryption is unavailable, do not downgrade to plaintext persistence. The page may open without restored session state and require login.

## Storage Model

Add one encrypted secret per AutoForge user. Its key contains only a SHA-256 digest of the user id. The encrypted JSON payload maps normalized HTTPS origins to session-storage key/value records. Parsing is fail-closed: malformed payloads, non-HTTPS origins, non-string values, or data beyond Chromium-equivalent bounded quotas are ignored rather than injected.

The store serializes writes per user so rapid DOM storage events cannot commit stale snapshots out of order. Explicit browser-data clearing deletes both the Chromium partition data and this encrypted record.

## Browser Lifecycle

Before navigating a target WebContents, Main loads saved records only for origins already allowed by the workflow and installs a CDP new-document bootstrap. The bootstrap checks `location.origin` and restores that origin's records before site scripts execute.

Main enables the CDP `DOMStorage` domain and listens for session-storage add, update, remove, and clear events. Local-storage events are ignored because Chromium already persists local storage. Mutations update the encrypted per-user snapshot without logging values. Pending writes are drained before a controlled shutdown or explicit browser-data clearing.

Within one application run, existing exact-provenance tab reuse remains unchanged. This avoids weakening the conversation-bound continuation contract; cross-run persistence is provided by the encrypted origin-scoped snapshot instead of broader tab reuse.

## Clearing and Identity Changes

- `Settings -> Clear browser data` closes the user's target tabs, clears the persistent partition, and deletes the encrypted session-storage record.
- AutoForge logout or account switch closes/revokes visible browser bindings but retains site data, matching the existing persistent-cookie policy.
- Different AutoForge users never share encrypted records or restored values.

## Failure Semantics

Failure to decrypt, parse, or restore session state must not expose secrets or crash the desktop application. The target page remains usable and may request login. Persistence failures are represented only by fixed safe errors or internal non-secret diagnostics.

## Verification

- Unit coverage proves encrypted round trips, user/origin isolation, malformed-data rejection, ordered writes, and explicit clearing without plaintext persistence.
- Workspace coverage proves restoration is registered before navigation, only allowed HTTPS origins are injected, session-storage CDP mutations persist, local-storage events are ignored, and pending writes drain on shutdown.
- Electron E2E creates a session-storage-authenticated fixture, restarts the workspace, reopens it, and observes the authenticated state. Clearing browser data must return the fixture to logged-out state.

