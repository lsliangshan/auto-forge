# Task 5 Report: Knowledge management UI and conversation preferences

## Status

Implemented the `/knowledge` three-pane workspace and per-conversation knowledge preferences, then completed two review hardening waves. Navigation remains exactly Chat, Knowledge Base, Workflows, Developer, Executions, optional User Management, Settings. The implementation uses only the path-free `DesktopAPI.knowledge` namespace and does not add knowledge import to chat attachments.

## Implementation

- The shared Pinia knowledge Store owns availability, entitlement/consent, catalog/document/version state, selection, operations, and polling. A monotonic owner epoch plus catalog/document/version/operation/refresh request versions prevent every old-owner response from publishing after logout or account change. Logout/account transitions reset catalog, documents, versions, selections, availability, entitlement, consent, loading flags, errors, operation state, polling, and request admission.
- Processing polling is recursive single-flight rather than `setInterval`: 1.5-second success cadence, exponential failure delay, three consecutive failure cap, visible paused-refresh error, and explicit cancellation on unmount or owner reset. Background refreshes no longer blank the selected pane or let an older base request clear the current loading/error state.
- Route teardown now invalidates every admitted catalog/document/version/refresh publication, clears visible loading state, and prevents the awaiting `onMounted` continuation from starting a poll after unmount. A newer Chat catalog therefore cannot be replaced by a departed Knowledge route. Re-entry and no-processing state clear stale polling errors.
- Renderer actions derive write permission from current availability, entitlement status, selected local/cloud scope, and read-only/recycled state. Main independently rejects expired create/import/replace before file selection and re-checks local availability for recycle; export and deletion remain usable for expired/read-only data. Existing idempotent recycle recovery remains intact.
- Free-tier advisory gates mirror Main's one-library/one-active-logical-file authority: once the default library exists, create is disabled; once it has an active document, import is disabled while replacement remains available. Paid active members retain multi-library/import actions.
- Both recycle actions require explicit confirmation. The workspace adds listbox/option selection state, radio-group/group semantics, `aria-busy`, polite loading state, and scoped action disabling.
- Chat preference saves remain serialized per conversation, but owner reset discards the old queue. Each conversation separately retains the last Main-confirmed snapshot. A failed latest save reloads authoritative Main state; if that reload also fails it rolls back only to that confirmed snapshot, never another optimistic request. Older failures cannot overwrite newer state/errors, and the latest success clears only the selected conversation's error.
- Main now publishes an explicit path-free `searchable` base bit derived from an active published ready version. Processing/failed/paused libraries are selectable only when that bit proves a ready generation exists. `read_only` means non-retained downgrade data: encrypted/exportable/deletable but not searchable or selectable, matching the approved spec and Main's active-base retrieval filter. Local parsing is labeled local processing, never cloud syncing; the inspector separately reports entitlement, scope, ready-version, failed-replacement, local-processing, and cloud-sync retrieval state.

## TDD evidence

- Owner isolation RED: stale catalog and import acknowledgement repopulated `bases`, `selectedBaseId`, and `selectedDocumentId` after `reset()`; logout left all knowledge fields intact. GREEN uses owner epoch/request versions and auth-owned reset.
- Polling RED: no single-flight controller existed, an unresolved refresh overlapped indefinitely, and failures retried forever. GREEN caps three attempts with 1.5/3/6-second scheduling and cancels on reset/unmount.
- Scoped-write RED: expired local import/replace remained enabled and Main returned a quota conflict/allowed replacement instead of `FORBIDDEN`. GREEN enforces entitlement in both Renderer and Main while retaining export/recycle.
- Preference RED: failed saves left optimistic state, an old failure overwrote a newer success, a switched-away conversation stayed stale, and a new owner queued behind the old owner. GREEN reloads/rolls back under per-conversation version and owner epoch.
- Semantics/accessibility RED: processing/failed/paused bases with published versions were blanket-disabled, read-only retrieval meaning was ambiguous, recycle had no confirmation, list selection lacked roles, and an old base load cleared the current base loading state. Each now has a focused component/Store regression aligned to the approved downgrade rules.
- Broader Main verification caught an initially over-broad repeated-recycle denial; tracing the Task 4 recovery test preserved its required retry semantics while keeping the new admission gates.
- Route RED: a pending Knowledge load published after `/chat` mounted and restarted polling after unmount; stopping polling did not invalidate catalog/document/version requests. GREEN invalidates admission versions and guards the mount continuation.
- Quota RED: the free default library could invoke a mocked second create/import. GREEN disables those calls at one library/active file and keeps Replace enabled; tests no longer mock a successful second free library.
- Retrieval RED: `read_only` was advertised as searchable, local parsing as syncing, and the inspector ignored entitlement/ready-version evidence. GREEN uses Main's explicit `searchable` distinction and the approved downgrade semantics.
- Confirmed-snapshot RED: two failed queued saves plus failed authoritative reload fell back to the first optimistic edit. GREEN records only successful load/save/reload responses as fallback state.
- Timeout RED: an early child exit passed with code 0, while timeout cleanup belonged to the child that could be killed. GREEN makes the parent own the process group and temp root, rejects a missing completion marker, and proves a SIGTERM-ignoring descendant is killed before the root is removed.

## Final verification

- Shared contracts: 76 tests passed.
- Renderer: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts` — 10 files, 374 tests passed.
- Main knowledge/Application/IPC/Preload/timeout review slice — 5 files, 17 passed, 212 skipped.
- Full focused KnowledgeService plus timeout-runner suite — 34 tests passed.
- Desktop Node and Renderer typecheck passed.
- Targeted ESLint over all changed source/test/smoke files with `--quiet` passed.
- `pnpm smoke:knowledge-ui` passed, including native preparation and the production build.
- `git diff --check` passed.

## Real Electron smoke

The checked-in `pnpm smoke:knowledge-ui` command has a 60-second hard timeout. The parent creates and owns the only smoke temp root, launches Electron in a dedicated process group, sends TERM to the whole group on timeout, then KILLs the group after two seconds before recursively removing the root. The timeout regression uses a SIGTERM-ignoring descendant that continually writes a plaintext artifact; it proves the descendant stops and the entire root is absent. A code-0 child without `.knowledge-smoke-complete` is rejected, so early exits cannot fake completion.

The command builds the production Renderer and preload, compiles the smoke Main entry, launches Electron without injecting `window.autoForge`, registers validated IPC, opens a real encrypted `KnowledgeService`, and uses the production sandbox parser. Each readiness predicate is bounded, including the refreshed searchable Chat catalog.

The visible `/knowledge` UI triggered import of `smoke-source.txt`. Main returned a durable acknowledgement with `status: "parsing"` and `versionCount: 1`; the production parser then published `ready`. The visible Chat composer selected the real base and strict mode, producing two validated IPC mutations. Main persisted `{ knowledgeBaseIds: [realBaseId], knowledgeMode: "strict" }`. After a Renderer reload, the built preload/IPC path restored the real `我的知识库` choice and strict mode. The process exited 0.

## Concerns and gates

- Cloud sync, hybrid vector retrieval, signed entitlement verification, and kill-switch rollout remain later tasks. Cloud remains fail-closed; this Task 5 fix adds no cloud implementation.
- The smoke uses deterministic auth/chat ownership fixtures but no fake knowledge DTO service: import, encrypted persistence, parser publication, conversation selection, preload, validation, IPC, and visible state are real.
- macOS Chromium may emit benign `task_policy_set ... invalid argument` diagnostics after the successful JSON result; they do not affect the exit code or assertions.
