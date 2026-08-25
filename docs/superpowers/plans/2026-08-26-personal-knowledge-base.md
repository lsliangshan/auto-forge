# Personal Knowledge Base Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Deliver the approved personal knowledge-base foundation, CloudBase contracts, chat routing/citations, entitlement enforcement, and rollout controls without weakening AutoForge's existing Electron trust boundaries.

**Architecture:** Electron Main owns encrypted knowledge persistence, import/parsing jobs, retrieval scope, entitlements, and Agent routing. Renderer receives narrow DTOs through validated Preload/IPC contracts. CloudBase uses user JWT + RLS and durable jobs; synced generations publish atomically. The implementation is feature-gated so unfinished cloud infrastructure cannot expose a misleading working UI.

**Tech Stack:** TypeScript, Electron 43, Vue 3/Pinia, Vitest, Zod, SQLite/FTS5, `better-sqlite3-multiple-ciphers@13.0.3`, CloudBase PG/Storage/Functions, PDF.js, Mammoth, unified/remark, parse5.

**Spec:** `docs/superpowers/specs/2026-08-26-personal-knowledge-base-design.md`

## Global constraints

- Personal knowledge bases only; no enterprise/team/share implementation.
- Renderer is untrusted. Paths, keys, user scope, entitlements, `topK`, index snapshots, SQL, and provider disclosure policy are Main-owned.
- No plaintext fallback when encrypted DB, safeStorage, FTS5, or packaging verification fails.
- Non-member limit is one local knowledge base and one active logical file; replacement is atomic.
- Route priority is workflow, then selected knowledge bases, then final AI synthesis.
- Per-turn limits are workflow 5, knowledge search 3, total decisions 10, evidence `topK` 8.
- Initial document types are text-layer PDF, DOCX, UTF-8 TXT, Markdown, and HTML.
- Cloud client uses user session JWT + RLS; never ship service-role credentials or direct COS access.
- Only published ready versions are searchable; current-turn selection/index snapshots are immutable.
- Normal logs and diagnostics exclude document/query/chunk text, filenames, paths, signed URLs, and secrets.
- Preserve the recorded unrelated baseline `CONTEXT_LIMIT_EXCEEDED` failure; do not alter it as part of this work.

## Task 1: Contracts, feature gate, and persistence seams

**Files:**
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts`
- Modify: `apps/desktop/electron/preload/bridge.test.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Create: `apps/desktop/electron/main/knowledge/knowledge-types.ts`

Define strict DTOs and schemas for knowledge bases, documents/versions, status, conversation selection (`knowledgeBaseIds`, `knowledgeMode`), local search results, citation references, entitlement state, consent state, and feature availability. Add a narrow `knowledge` DesktopAPI namespace and validated IPC channels. The contracts must not accept paths, user ids, SQL, caller-selected `topK`, or index ids. Add a feature-availability response that can report fail-closed native/storage reasons.

TDD:

1. Add contract rejection tests for extra fields, arbitrary scope, malformed citations, and limits.
2. Run the shared/preload/IPC tests and observe the expected failures.
3. Add the minimal shared, bridge, and handler seams.
4. Re-run targeted tests and typecheck changed packages.
5. Commit: `feat(knowledge): define trusted IPC contracts`.

## Task 2: Encrypted local database POC and key lifecycle

**Files:**
- Modify: root/package workspace manifests and lockfile only as required
- Create: `apps/desktop/electron/main/knowledge/encrypted-database.ts`
- Create: `apps/desktop/electron/main/knowledge/key-store.ts`
- Create: `apps/desktop/electron/main/knowledge/knowledge-schema.ts`
- Create: `apps/desktop/electron/main/knowledge/encrypted-database.test.ts`
- Modify: native packaging/preparation scripts and electron-builder config only where the POC proves necessary

Install and pin `better-sqlite3-multiple-ciphers@13.0.3`. Build a per-user database opener, safeStorage-backed active/pending wrapped-key record, verified `temp_store=MEMORY`, compile-option/FTS probe, wrong-key failure, crash-safe rekey recovery, and schema containing knowledge bases, documents, immutable versions, blocks/chunks, external-content trigram FTS, jobs, cursors, conflicts, and tombstones. Keep the existing app DB free of sensitive KB metadata.

TDD/POC:

1. Write tests using random temporary directories and literal sentinel text.
2. Prove tests fail before implementation.
3. Implement the minimal connection/key/schema lifecycle.
4. Test correct/wrong/no key, FTS search, transaction rollback, WAL/checkpoint, active/pending recovery, and absence of sentinel plaintext in DB/WAL/journal/temp.
5. Run Electron-runtime native tests and packaged-native probes available on the current platform; record unverified target platforms as a release gate, never as passing.
6. Commit: `feat(knowledge): add encrypted local store`.

## Task 3: Restricted parsing and encrypted object snapshots

**Files:**
- Create: `apps/desktop/electron/main/knowledge/encrypted-object-store.ts`
- Create: `apps/desktop/electron/main/knowledge/parser-protocol.ts`
- Create: `apps/desktop/electron/main/knowledge/parser-worker.ts`
- Create: `apps/desktop/electron/main/knowledge/parser-supervisor.ts`
- Create: `apps/desktop/electron/main/knowledge/parsers/*`
- Create corresponding focused tests and safe fixtures

Implement AEAD snapshot encryption with a random per-file key wrapped by the user key. Add a restricted child-parser protocol for the five formats, structural coordinates, normalized text/chunks, hard budgets, cancellation, and explicit unsupported/scanned/encrypted errors. External HTML resources and document scripting stay disabled. The child receives only the encrypted snapshot location and one-time file key.

TDD:

1. Add tiny deterministic fixtures for every supported type plus malformed, encrypted, scanned, oversized, timed-out, and cancellation cases.
2. Watch protocol and parser tests fail before implementation.
3. Implement only the supported parsing paths and sanitizer.
4. Verify the supervisor kills/drains workers and no secret crosses its protocol.
5. Commit: `feat(knowledge): parse encrypted document snapshots`.

## Task 4: Local knowledge service, retrieval, lifecycle, and IPC

**Files:**
- Create: `apps/desktop/electron/main/knowledge/knowledge-service.ts`
- Create: `apps/desktop/electron/main/knowledge/local-retriever.ts`
- Create: `apps/desktop/electron/main/knowledge/export-service.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/index.ts`
- Add focused service/application tests

Wire login-scoped open/close, lazy default KB, create/list/select/import/replace/delete/recycle/purge/export, durable processing states, atomic ready-version publication, and bounded retrieval. Enforce non-member 1/1 in Main. Three-or-more-character queries use safe literal trigram MATCH; two-character queries use bounded selected-scope `instr`; one-character queries return an ask-for-detail outcome. Local purge rebuilds the encrypted DB and rotates its key without claiming physical overwrite.

TDD:

1. Add service tests for cross-user denial, state transitions, atomic replacement/publication, failure rollback, short-query behavior, selected scope, logout cleanup, export manifest, and purge.
2. Observe failures, implement minimal services, and re-run.
3. Add Application and IPC boundary tests using real repositories and mocked native dialogs only.
4. Commit: `feat(knowledge): manage and search local libraries`.

## Task 5: Knowledge management UI and conversation preferences

**Files:**
- Modify: `apps/desktop/src/components/AppRail.vue`
- Modify: `apps/desktop/src/router/index.ts`
- Modify: `apps/desktop/src/layouts/WorkbenchLayout.vue`
- Modify: `apps/desktop/src/components/ContextSidebar.vue`
- Modify: `apps/desktop/src/components/InspectorPanel.vue`
- Create: `apps/desktop/src/views/KnowledgeView.vue`
- Create: `apps/desktop/src/stores/knowledge.ts`
- Modify: `apps/desktop/src/components/chat/ChatComposer.vue`
- Modify: `apps/desktop/src/stores/chat.ts`
- Modify conversation persistence in Main/database code as needed
- Add/update component, store, router, and application tests

Add the `/knowledge` three-pane experience, status/error handling, import/replace flows, and fail-closed availability UI. Add per-conversation multi-select and strict/mixed mode above the composer. Persist selection in Main; a new chat selects none. The UI must distinguish local-only, syncing, synced, keyword-only, unavailable, read-only, and expired states.

TDD:

1. Update navigation/order tests and add user-visible management/selector tests.
2. Observe failures before component/store code.
3. Implement the smallest route/store/components that exercise the real DesktopAPI boundary.
4. Run Renderer tests and a real Electron smoke check through Renderer → Preload → IPC → Main → visible state.
5. Commit: `feat(knowledge): add personal library workspace`.

## Task 6: CloudBase schema, RLS, storage, and durable sync

**Files:**
- Create CloudBase SQL migrations under the repository's established CloudBase directory
- Create/update Cloud Functions for upload authorization, publication, sync, delete, and entitlements
- Create: `apps/desktop/electron/main/knowledge/cloudbase-knowledge-client.ts`
- Create: `apps/desktop/electron/main/knowledge/sync-service.ts`
- Add migration policy tests, client contract tests, and sync state-machine tests

Add the approved self-managed cloud lifecycle: RLS tables, PG Storage references, immutable versions/generations, durable leases/CAS/idempotency, monotonic change sequence, 90-day tombstones, conflicts, staging, atomic publication, cancellation, and orphan cleanup. Electron uses only the logged-in user's JWT. Pause and convert-to-local-only are separate and conversion verifies a complete download before cloud deletion.

TDD:

1. Add authorization tests proving cross-user reads/writes fail and service-role material is absent from client bundles.
2. Add sync state-machine tests for offline queue, stale cursor/full resync, conflict preservation, retry classification/max three, and failed staging retaining the old generation.
3. Implement SQL/functions/client/service.
4. Run local CloudBase emulator/integration checks if configured; otherwise keep cloud feature disabled and record the external deployment gate.
5. Commit: `feat(knowledge): add CloudBase synchronization`.

## Task 7: Embedding consent and hybrid cloud retrieval

**Files:**
- Create/update Cloud Functions for TokenHub embedding and generation publication
- Create: `apps/desktop/electron/main/knowledge/cloud-retriever.ts`
- Modify consent/entitlement DTOs and UI state from prior tasks
- Add retrieval, consent, drift, and degradation tests

Implement separate TokenHub consent, 1024-dimensional `kinfra-text-embedding-0.6b` indexing, keyword/vector RRF, exact-cosine small-index path, versioned model/config, probe drift, shadow build, atomic switch, seven-day previous generation, and keyword-only degradation. Consent revocation stops sends and deletes vectors.

TDD:

1. Add tests for denied/revoked consent, vector dimensions, deterministic RRF, outage behavior, drift isolation, shadow publication, and prior-generation retention.
2. Observe failures, implement the minimal cloud/function and Main orchestration.
3. Verify no document/query text appears in logs and no unpublished generation is searchable.
4. Commit: `feat(knowledge): add consented hybrid retrieval`.

## Task 8: Agent routing, grounding, and citation UI

**Files:**
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify associated policy/context files only where required
- Modify: `packages/shared/src/events.ts`
- Create/modify chat citation/status components and tests
- Add Agent orchestration, context-budget, and application tests

Add Main-owned `knowledge_search` after workflow resolution, enforcing immutable conversation scope and the 5/3/10/8 budgets. Allow only query/rewrite arguments. Restrict the path to text/tool-capable models. Preserve workflow-only launch behavior and visible workflow errors. Add per-provider snippet disclosure consent, one citation-repair attempt, strict refusal, mixed labeling, untrusted-evidence delimiters, streamed final output after validation, status cards, immutable citation persistence, and unavailable-source behavior.

TDD:

1. Add routing matrix tests: workflow only, KB only, workflow→KB composite, no evidence strict, mixed fallback, workflow error, non-text, invalid scope injection, budget exhaustion, prompt injection in evidence, invalid citation, repair success/failure, provider-consent denial/switch.
2. Observe each relevant failure before implementation.
3. Implement the minimal orchestration/tool/catalog/context changes.
4. Add Renderer tests for status and citation click/preview.
5. Run targeted context-compression tests to ensure historical citations do not leak hidden chunks or paths.
6. Commit: `feat(knowledge): ground chat answers with citations`.

## Task 9: Membership downgrade, deletion, export, and kill switch

**Files:**
- Modify knowledge services, shared contracts, and UI from prior tasks
- Add entitlement verifier/public-key configuration in Main
- Add lifecycle, signed-snapshot, clock/grace, and kill-switch tests

Verify signed entitlement snapshots in Main, apply 72-hour offline grace, beta/cloud entitlements, non-member downgrade selection/read-only behavior, 30-day download window, 30-day recycle window, immediate purge, and server cloud kill switch. Ensure local management/export/delete remain available when cloud operations/tool catalogs are disabled.

TDD:

1. Add literal signed-fixture tests for valid/expired/wrong-user/wrong-key/tampered snapshots and clock boundaries.
2. Add downgrade/recovery/purge/kill-switch behavioral tests.
3. Implement enforcement and UI states.
4. Commit: `feat(knowledge): enforce membership lifecycle`.

## Task 10: Verification, benchmarks, privacy docs, and release gate

**Files:**
- Add benchmark/evaluation harnesses and non-sensitive fixtures
- Add privacy/data-flow/release documentation
- Update packaging verification scripts and CI matrices only as required
- Update this spec with measured safety limits only when evidence exists

Build security, relevance, grounding, processing, and performance harnesses. Verify current-platform packaged native loading and record remaining macOS/Windows matrix work as a release gate. Add disclosures for Shanghai/Guangzhou/chat providers, retention, export/delete, membership, and degraded behavior. Keep cloud/beta feature flags off unless all required platform, CloudBase, entitlement-key, consent, and benchmark gates are configured.

Verification:

1. Run focused tests after each mutation and the full typecheck/build/test suites at the end.
2. Run encrypted sentinel, cross-user, retrieval/citation evaluation, and performance harnesses.
3. Run real Electron smoke flows for local import→ready→chat retrieval→citation preview→export/delete and cloud-disabled degradation.
4. Request a whole-branch code review and resolve Critical/Important findings.
5. Commit: `test(knowledge): gate personal library rollout`.

## Final handoff

Before push:

- branch diff contains only this feature and its documentation;
- every new/changed behavior has a targeted passing test that was observed failing first;
- typecheck and build pass;
- full tests pass except the recorded unrelated baseline failure, which is reproduced and reported separately;
- secrets, local paths, raw document/query/chunk text, and signed URLs are absent from logs, fixtures, and commits;
- unverified CloudBase/platform/benchmark gates remain disabled rather than being reported complete;
- commit history is coherent and the branch is pushed to `origin/codex/personal-knowledge-base`.
