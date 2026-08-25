# Task 5 Report: Knowledge management UI and conversation preferences

## Status

Implemented the `/knowledge` three-pane workspace and per-conversation knowledge preferences, then completed the review hardening wave. Navigation remains exactly Chat, Knowledge Base, Workflows, Developer, Executions, optional User Management, Settings. The implementation uses only the path-free `DesktopAPI.knowledge` namespace and does not add knowledge import to chat attachments.

## Implementation

- The shared Pinia knowledge Store owns availability, entitlement/consent, catalog/document/version state, selection, operations, and polling. A monotonic owner epoch plus catalog/document/version/operation/refresh request versions prevent every old-owner response from publishing after logout or account change. Logout/account transitions reset catalog, documents, versions, selections, availability, entitlement, consent, loading flags, errors, operation state, polling, and request admission.
- Processing polling is recursive single-flight rather than `setInterval`: 1.5-second success cadence, exponential failure delay, three consecutive failure cap, visible paused-refresh error, and explicit cancellation on unmount or owner reset. Background refreshes no longer blank the selected pane or let an older base request clear the current loading/error state.
- Renderer actions derive write permission from current availability, entitlement status, selected local/cloud scope, and read-only/recycled state. Main independently rejects expired create/import/replace before file selection and re-checks local availability for recycle; export and deletion remain usable for expired/read-only data. Existing idempotent recycle recovery remains intact.
- Both recycle actions require explicit confirmation. The workspace adds listbox/option selection state, radio-group/group semantics, `aria-busy`, polite loading state, and scoped action disabling.
- Chat preference saves remain serialized per conversation, but owner reset discards the old queue. A failed latest save reloads authoritative Main state (or rolls back if reload fails), including when the conversation is no longer selected. Older failures cannot overwrite newer state/errors, and the latest success clears only the selected conversation's error.
- Syncing/processing, synced, keyword-only, read-only, paused, failed-with-only-ready-versions-usable, expired, unavailable, and deleted/missing states are distinct. Read-only and published ready versions remain selectable/retrievable; failed status no longer claims a ready version unless the immutable version list proves one exists.

## TDD evidence

- Owner isolation RED: stale catalog and import acknowledgement repopulated `bases`, `selectedBaseId`, and `selectedDocumentId` after `reset()`; logout left all knowledge fields intact. GREEN uses owner epoch/request versions and auth-owned reset.
- Polling RED: no single-flight controller existed, an unresolved refresh overlapped indefinitely, and failures retried forever. GREEN caps three attempts with 1.5/3/6-second scheduling and cancels on reset/unmount.
- Scoped-write RED: expired local import/replace remained enabled and Main returned a quota conflict/allowed replacement instead of `FORBIDDEN`. GREEN enforces entitlement in both Renderer and Main while retaining export/recycle.
- Preference RED: failed saves left optimistic state, an old failure overwrote a newer success, a switched-away conversation stayed stale, and a new owner queued behind the old owner. GREEN reloads/rolls back under per-conversation version and owner epoch.
- Semantics/accessibility RED: usable processing/failed/paused/read-only bases were blanket-disabled, recycle had no confirmation, list selection lacked roles, and an old base load cleared the current base loading state. Each now has a focused component/Store regression.
- Broader Main verification caught an initially over-broad repeated-recycle denial; tracing the Task 4 recovery test preserved its required retry semantics while keeping the new admission gates.

## Final verification

- Renderer: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts` — 10 files, 366 tests passed.
- Main knowledge/Application review slice: `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/knowledge-service.test.ts electron/main/application.test.ts -t "knowledge|entitlement|recycle"` — 11 passed, 169 skipped.
- Focused recycle journal plus entitlement: 5 passed, 25 skipped.
- Desktop Node and Renderer typecheck passed.
- Targeted ESLint over all changed source/test/smoke files with `--quiet` passed.
- `pnpm smoke:knowledge-ui` passed, including native preparation and the production build.
- `git diff --check` passed.

## Real Electron smoke

The checked-in `pnpm smoke:knowledge-ui` command has a 60-second hard timeout with TERM/KILL cleanup. It builds the production Renderer and preload, compiles the smoke Main entry, launches Electron without injecting `window.autoForge`, registers validated IPC, opens a real encrypted `KnowledgeService`, and uses the production sandbox parser.

The visible `/knowledge` UI triggered import of `smoke-source.txt`. Main returned a durable acknowledgement with `status: "parsing"` and `versionCount: 1`; the production parser then published `ready`. The visible Chat composer selected the real base and strict mode, producing two validated IPC mutations. Main persisted `{ knowledgeBaseIds: [realBaseId], knowledgeMode: "strict" }`. After a Renderer reload, the built preload/IPC path restored the real `我的知识库` choice and strict mode. The process exited 0.

## Concerns and gates

- Cloud sync, hybrid vector retrieval, signed entitlement verification, and kill-switch rollout remain later tasks. Cloud remains fail-closed; this Task 5 fix adds no cloud implementation.
- The smoke uses deterministic auth/chat ownership fixtures but no fake knowledge DTO service: import, encrypted persistence, parser publication, conversation selection, preload, validation, IPC, and visible state are real.
- macOS Chromium may emit benign `task_policy_set ... invalid argument` diagnostics after the successful JSON result; they do not affect the exit code or assertions.
