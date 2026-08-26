# Task 5 Report: Knowledge management UI and conversation preferences

## Status

Implemented the `/knowledge` three-pane workspace and per-conversation knowledge preferences, then completed four review hardening waves. Navigation remains exactly Chat, Knowledge Base, Workflows, Developer, Executions, optional User Management, Settings. The implementation uses only the path-free `DesktopAPI.knowledge` namespace and does not add knowledge import to chat attachments.

## Implementation

- The shared Pinia knowledge Store owns availability, entitlement/consent, catalog/document/version state, selection, operations, and polling. A monotonic owner epoch plus catalog/document/version/operation/refresh request versions prevent every old-owner response from publishing after logout or account change. Logout/account transitions reset catalog, documents, versions, selections, availability, entitlement, consent, loading flags, errors, operation state, polling, and request admission.
- Processing polling is recursive single-flight rather than `setInterval`: 1.5-second success cadence, exponential failure delay, three consecutive failure cap, visible paused-refresh error, and explicit cancellation on unmount or owner reset. Background refreshes no longer blank the selected pane or let an older base request clear the current loading/error state.
- Route teardown now invalidates every admitted catalog/document/version/refresh publication, clears visible loading state, and prevents the awaiting `onMounted` continuation from starting a poll after unmount. A newer Chat catalog therefore cannot be replaced by a departed Knowledge route. Re-entry and no-processing state clear stale polling errors.
- Renderer actions derive write permission from current availability, entitlement status, selected local/cloud scope, and read-only/recycled state. Main independently rejects expired create/import/replace before file selection and re-checks local availability for recycle; export and deletion remain usable for expired/read-only data. Existing idempotent recycle recovery remains intact.
- Free-tier advisory gates mirror Main's one-library/one-active-logical-file authority: once the default library exists, create is disabled; once it has an active document, import is disabled while replacement remains available. Paid active members retain multi-library/import actions.
- Both recycle actions require explicit confirmation. The workspace adds listbox/option selection state, radio-group/group semantics, `aria-busy`, polite loading state, and scoped action disabling.
- Chat preference saves remain serialized per conversation, but owner reset discards the old queue. Each conversation separately retains the last Main-confirmed snapshot. A failed latest save reloads authoritative Main state; if that reload also fails it rolls back only to that confirmed snapshot, never another optimistic request. Older failures cannot overwrite newer state/errors, and the latest success clears only the selected conversation's error.
- Main now uses one literal active-plus-published-ready SQL predicate to publish the path-free `searchable` bit, filter persisted conversation selections, and admit selection updates. Recycling the last ready document therefore removes a saved base from authoritative reads and rejects re-selection. Processing/failed/paused libraries are selectable only when the bit proves a ready generation exists. `read_only` data remains encrypted/exportable/deletable but not searchable or newly selectable. A checked stale/read-only/deleted choice remains enabled only for removal, including while an earlier optimistic save is in flight. Local parsing is labeled local processing, never cloud syncing; a deleted document is reported deleted/non-retrievable before retained-version or base state is considered.
- The smoke runner resolves and validates its freshly created workspace beneath the real OS temporary root, then overwrites child `AUTOFORGE_KNOWLEDGE_SMOKE_ROOT`, `TMPDIR`, `TMP`, and `TEMP` with that exact parent-owned path. Only the smoke process tree is scoped; normal production `tmpdir()` behavior is unchanged.

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
- Authoritative-selection RED: Main accepted an active empty base, retained it after its last ready document was recycled, and three queries encoded different notions of eligibility. GREEN reuses the same published-ready predicate in catalog, selection read, and selection write paths; the new lifecycle test covers empty admission, successful publication, last-document recycle, stale selection filtering, and rejected re-admission.
- Stale-choice RED: checked read-only/deleted choices and choices that became unavailable during an in-flight save were HTML-disabled, trapping the user. GREEN disables an unavailable choice only when it is unchecked, with component tests proving the actual empty preference mutation and final Store state.
- Probe-containment RED: the real `KnowledgeService` parser probe created `probe.txt` and `probe.afobj` in the caller's temp root, outside the runner-owned cleanup boundary. GREEN scopes all child temp variables after caller environment merge. The hard-timeout regression bundles and launches the real service, observes both probe file paths and sizes without copying plaintext outside the root, spawns a SIGTERM-ignoring descendant, and proves the child, descendant, and entire workspace are gone after TERM/KILL.

## Final verification

- Focused Main KnowledgeService: 33 tests passed; focused knowledge Renderer component/Store: 35 tests passed.
- Full Renderer: 10 files, 379 tests passed.
- Full Desktop Node: 88 files and 2,366 tests passed; the single pre-existing context-summary billing test still fails with `CONTEXT_LIMIT_EXCEEDED` instead of completion, matching the baseline ledger and outside Task 5.
- Workspace shared, Desktop Node, and Renderer typecheck passed.
- Targeted ESLint over all round-3 changed source/test files with `--quiet` passed.
- `pnpm --filter @autoforge/desktop smoke:knowledge-ui` passed, including native preparation and the production build.
- Round-4 smoke-runner suite: 3 tests passed, including the real KnowledgeService probe hard-timeout regression.
- Round-4 workspace typecheck, targeted smoke runner/test ESLint, and `git diff --check` passed.

## Real Electron smoke

The checked-in `pnpm smoke:knowledge-ui` command has a 60-second hard timeout. The parent creates and validates the only smoke temp root, forces the child process tree's temp variables to that root, launches Electron in a dedicated process group, sends TERM to the whole group on timeout, then KILLs the group after two seconds before recursively removing the root. The regression traverses the actual `KnowledgeService` encrypted parser probe and a SIGTERM-ignoring descendant; it proves the plaintext probe, encrypted snapshot, and descendant artifacts are contained before the whole process tree and root disappear. A code-0 child without `.knowledge-smoke-complete` is rejected, so early exits cannot fake completion.

The command builds the production Renderer and preload, compiles the smoke Main entry, launches Electron without injecting `window.autoForge`, registers validated IPC, opens a real encrypted `KnowledgeService`, and uses the production sandbox parser. Each readiness predicate is bounded, including the refreshed searchable Chat catalog.

The visible `/knowledge` UI triggered import of `smoke-source.txt`. Main returned a durable acknowledgement with `status: "parsing"` and `versionCount: 1`; the production parser then published `ready`. The visible Chat composer selected the real base and strict mode, producing two validated IPC mutations. Main persisted `{ knowledgeBaseIds: [realBaseId], knowledgeMode: "strict" }`. After a Renderer reload, the built preload/IPC path restored the real `我的知识库` choice and strict mode. The process exited 0.

## Concerns and gates

- Cloud sync, hybrid vector retrieval, signed entitlement verification, and kill-switch rollout remain later tasks. Cloud remains fail-closed; this Task 5 fix adds no cloud implementation.
- The smoke uses deterministic auth/chat ownership fixtures but no fake knowledge DTO service: import, encrypted persistence, parser publication, conversation selection, preload, validation, IPC, and visible state are real.
- macOS Chromium may emit benign `task_policy_set ... invalid argument` diagnostics after the successful JSON result; they do not affect the exit code or assertions.
- The exact stale root `<system-temp>/autoforge-knowledge-probe` was moved recoverably, without a glob, to `<user-trash>/autoforge-knowledge-probe-task5-round4`; its `probe.txt` and `probe.afobj` remain there until Trash is emptied.
