# AutoForge v2 Personal Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement personal knowledge-base management, encrypted local ingestion/retrieval, optional CloudBase synchronization, and grounded chat citations on current AutoForge v2 without weakening existing user-data, workflow, browser, Provider, or lifecycle boundaries.

**Architecture:** Electron Main owns identity, paths, encryption, parsing jobs, retrieval scope, consent, entitlement, and Agent routing. Conversation selection extends the existing revisioned `conversation.preferences` mutation and CloudBase user-data outbox. A separate encrypted per-UID knowledge store and a fail-closed `autoforge-knowledge` cloud surface publish immutable generations; Renderer receives narrow path-free DTOs only.

**Tech Stack:** TypeScript 6, Electron 43, Vue 3, Pinia 4, Zod 4, Vitest 4, Playwright, SQLite/FTS5, `better-sqlite3-multiple-ciphers@13.0.3`, PDF.js, Mammoth, unified/remark, parse5, CloudBase PostgreSQL/PG Storage/Functions, TokenHub `kinfra-text-embedding-0.6b`.

**Spec:** `docs/superpowers/specs/2026-08-26-personal-knowledge-base-v2-design.md`

## Global Constraints

- Base is `origin/v2@a2bd28dd4da10aec6aa68113484ba480991fc672`; implementation branch is `codex/personal-knowledge-base-v2`.
- Do not merge/rebase/bulk cherry-pick the old branch. Inspect only `43cb4f6` and `04bf6d7` with `git show` or narrow per-file diffs.
- Personal knowledge bases only; no enterprise/team/share/ACL work.
- Renderer never supplies user ID, path, SQL, FTS expression, `topK`, generation ID, entitlement, or consent authority.
- Reuse current authentication, per-user store binding, conversation outbox/revision, device identity, logout, and shutdown lifecycle.
- Conversation selection is part of the existing synchronized `conversation.preferences` payload; no isolated local selection table.
- No plaintext SQLite fallback. Unverified platforms remain unavailable.
- Non-member limit is one local base and one active logical file; replace atomically.
- Per turn: workflow <= 5, knowledge search <= 3, Agent decisions <= 10, evidence <= 8.
- CloudBase environment is `autoforge-d1gkhyfb419ba8455`, region `ap-shanghai`; do not modify the real environment.
- Cloud kill switch remains disabled until authorized staging validation succeeds.
- Never write query, text, chunk, filename, local path, Provider payload, token, key, or signed URL into logs/reports/commits.
- Every behavior uses RED -> minimal GREEN -> focused verification -> independent specification review -> independent quality review -> fix -> re-review -> commit.
- Root agent reruns every final gate on final HEAD; delegated reports are leads only.

---

### Task 0: Baseline, architecture map, design, and plan

**Files:**
- Create: `docs/superpowers/specs/2026-08-26-personal-knowledge-base-v2-design.md`
- Create: `docs/superpowers/plans/2026-08-26-personal-knowledge-base-v2.md`
- Create: `.superpowers/sdd/2026-08-26-personal-knowledge-base-v2/task-0-baseline.md`
- Create: `.superpowers/sdd/2026-08-26-personal-knowledge-base-v2/progress.md`

**Interfaces:**
- Consumes: current v2 Renderer -> Preload -> IPC -> Application -> Agent/UserDataSync paths.
- Produces: immutable scope, recorded base failures, task ledger, and file/test boundaries for Tasks 1–10.

- [ ] Run `git fetch origin`, verify the exact base, and record all worktrees without modifying them.
- [ ] Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test`; preserve exact pass/fail counts.
- [ ] Run `pnpm exec playwright test apps/desktop/tests/e2e/cloud-user-data-sync.spec.ts` and record visible Electron evidence.
- [ ] Map `ChatView.vue -> stores/chat.ts -> preload/bridge.ts -> register-ipc.ts -> application.ts -> agent-orchestrator.ts` and `Application -> UserDataSyncEngine -> per-user repositories -> CloudBase port`.
- [ ] Self-review the spec and plan for placeholder markers, contradictory types, ambiguous file ownership, and missing acceptance coverage; fix every finding before commit.
- [ ] Commit only the spec and plan with `docs(knowledge): define v2 personal knowledge implementation`; keep the baseline report and SDD ledger in the plan-owned ignored workspace.

### Task 1: Strict contracts and fail-closed IPC gate

**Files:**
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts`
- Modify: `apps/desktop/electron/preload/bridge.test.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Create: `apps/desktop/electron/main/knowledge/knowledge-types.ts`

**Interfaces:**
- Produces: `KnowledgeAvailability`, `KnowledgeBaseSummary`, `KnowledgeDocumentSummary`, `KnowledgeVersionSummary`, `KnowledgeSelection`, `KnowledgeEvidence`, `KnowledgeCitation`, `KnowledgeConsentState`, and `KnowledgeEntitlementState` strict schemas; `DesktopAPI.knowledge` methods and events.
- Consumes: current identifier/timestamp/error schemas and validated IPC sender boundary.

- [ ] Add RED contract cases equivalent to:
  ```ts
  expect(knowledgeSearchRequestSchema.safeParse({ query: '合同', topK: 99 }).success).toBe(false)
  expect(knowledgeListRequestSchema.safeParse({ userId: 'forged' }).success).toBe(false)
  expect(knowledgeImportRequestSchema.safeParse({ path: '/tmp/secret' }).success).toBe(false)
  expect(knowledgeSelectionSchema.parse({ baseIds: [], mode: 'mixed' })).toEqual({ baseIds: [], mode: 'mixed' })
  ```
- [ ] Run `pnpm exec vitest run packages/shared/src/contracts.test.ts` and retain the missing-schema RED output in the task report.
- [ ] Implement strict DTOs and availability reasons for encryption, parser, CloudBase, embedding, entitlement, beta, and cloud gates.
- [ ] Add bridge/IPC handlers whose file selection returns opaque import handles and whose Main handlers derive owner/scope.
- [ ] Run shared, bridge, and IPC suites plus `pnpm --filter @autoforge/shared typecheck`.
- [ ] Complete two-stage review and commit `feat(knowledge): define trusted v2 contracts`.

### Task 2: Encrypted per-user database and object storage

**Files:**
- Modify: root and desktop package manifests/lockfile only for pinned dependencies.
- Modify: `apps/desktop/scripts/prepare-native-electron.mjs`
- Create: `apps/desktop/electron/main/knowledge/key-store.ts`
- Create: `apps/desktop/electron/main/knowledge/encrypted-database.ts`
- Create: `apps/desktop/electron/main/knowledge/knowledge-schema.ts`
- Create: `apps/desktop/electron/main/knowledge/encrypted-object-store.ts`
- Create: `apps/desktop/electron/main/knowledge/key-store.test.ts`
- Create: `apps/desktop/electron/main/knowledge/encrypted-database.test.ts`
- Create: `apps/desktop/electron/main/knowledge/knowledge-schema.test.ts`
- Create: `apps/desktop/electron/main/knowledge/encrypted-object-store.test.ts`

**Interfaces:**
- Produces: `KnowledgeStoreFactory.open(ownerId)`, `KnowledgeKeyStore.loadOrCreate(ownerId)`, `KnowledgeObjectStore.put/read/delete`, schema version 1, native availability probe.
- Consumes: Electron `safeStorage`, current per-user hashed-root conventions, and owner binding token.

- [ ] Write RED Electron-runtime tests with a random sentinel and assert wrong/no key failures, `temp_store=MEMORY`, FTS5 trigram support, and active/pending recovery.
- [ ] Add artifact scanning that fails if the sentinel appears in DB, WAL, journal, temp, or recovery files.
- [ ] Pin `better-sqlite3-multiple-ciphers@13.0.3` and update native preparation without changing the existing `better-sqlite3` user-data ABI path.
- [ ] Implement the minimum key slots, encrypted opener, schema, and AEAD object store; zero temporary key buffers best-effort.
- [ ] Run correct-key, wrong-key, WAL/checkpoint, rollback, crash-rekey, and object tamper tests under Electron 43.
- [ ] Run the current macOS arm64 packaged/native probe; mark macOS x64/Windows x64 unavailable in code and report.
- [ ] Complete two-stage review and commit `feat(knowledge): add encrypted v2 local store`.

### Task 3: Sandboxed parsing pipeline

**Files:**
- Create: `apps/desktop/electron/main/knowledge/parser-protocol.ts`
- Create: `apps/desktop/electron/main/knowledge/parser-supervisor.ts`
- Create: `apps/desktop/electron/knowledge-parser/index.ts`
- Create: `apps/desktop/electron/knowledge-parser/parsers/{pdf,docx,text,markdown,html}.ts`
- Modify: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/electron/main/knowledge/parser-protocol.test.ts`
- Create: `apps/desktop/electron/main/knowledge/parser-supervisor.test.ts`
- Create deterministic fixtures under `apps/desktop/electron/main/knowledge/test-fixtures/`.

**Interfaces:**
- Produces: `ParserSupervisor.parse({ objectHandle, oneTimeKey, mediaType, limits, signal }) -> ParsedDocument` with format-specific coordinates.
- Consumes: encrypted object handle, one-time key, no Node integration, no network.

- [ ] Add RED fixtures for five valid formats, encrypted/scanned/malformed PDF, invalid UTF-8, dangerous HTML, DOCX expansion limit, timeout, cancellation, crash, and shutdown drain.
- [ ] Assert the parser protocol rejects extra keys, paths outside its broker, credentials, and oversized responses.
- [ ] Implement PDF.js/Mammoth/TextDecoder/unified/parse5 parsing with active-content removal and hard page/text/time/memory/response budgets.
- [ ] Verify external resources make zero network requests and parser children are terminated/cleaned after cancellation or crash.
- [ ] Run focused parser/supervisor suites and packaged sandbox smoke.
- [ ] Complete two-stage review and commit `feat(knowledge): parse documents in sandbox`.

### Task 4: Local service, durable jobs, retrieval, and lifecycle

**Files:**
- Create: `apps/desktop/electron/main/knowledge/knowledge-service.ts`
- Create: `apps/desktop/electron/main/knowledge/import-job-runner.ts`
- Create: `apps/desktop/electron/main/knowledge/local-retriever.ts`
- Create: `apps/desktop/electron/main/knowledge/export-service.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application-shutdown-completion.ts`
- Create: `apps/desktop/electron/main/knowledge/knowledge-service.test.ts`
- Create: `apps/desktop/electron/main/knowledge/import-job-runner.test.ts`
- Create: `apps/desktop/electron/main/knowledge/local-retriever.test.ts`
- Create: `apps/desktop/electron/main/knowledge/export-service.test.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/application-shutdown-completion.test.ts`

**Interfaces:**
- Produces: create/list/import/replace/version/recycle/restore/purge/export/search operations and owner-scoped bind/invalidate/drain lifecycle.
- Consumes: Task 1 DTOs, Task 2 store/object APIs, Task 3 parser, current Application admission and shutdown ordering.

- [ ] Add RED tests for owner isolation, non-member 1/1 enforcement, atomic replace, acknowledgement <= 1 second, restart recovery, generation/token CAS, failed publication retaining old ready generation, recycle/restore/purge/export, and late-owner callbacks.
- [ ] Add retrieval RED cases:
  ```ts
  await expect(search('合同条款')).resolves.toHaveLength(8)
  await expect(search('合同')).resolves.toMatchObject({ strategy: 'bounded-instr' })
  await expect(search('合')).resolves.toEqual({ kind: 'query-too-short' })
  ```
- [ ] Implement minimal durable state transitions and only allow published ready versions into search.
- [ ] Bind service start/stop to Application admission, logout discard, account switch, and shutdown drain; invalidate generation before awaits.
- [ ] Verify export ZIP manifest excludes vectors, paths, keys, hidden chunks, queries, and URLs.
- [ ] Complete two-stage review and commit `feat(knowledge): manage local v2 libraries`.

### Task 5: Three-pane UI and synchronized conversation selection

**Files:**
- Modify: `apps/desktop/src/components/AppRail.vue`
- Modify: `apps/desktop/src/router/index.ts`
- Modify: `apps/desktop/src/layouts/WorkbenchLayout.vue`
- Create: `apps/desktop/src/views/KnowledgeView.vue`
- Create: `apps/desktop/src/stores/knowledge.ts`
- Create: `apps/desktop/src/components/knowledge/KnowledgeBaseList.vue`
- Create: `apps/desktop/src/components/knowledge/KnowledgeDocumentList.vue`
- Create: `apps/desktop/src/components/knowledge/KnowledgeInspector.vue`
- Create: `apps/desktop/src/components/knowledge/KnowledgeSelector.vue`
- Modify: `apps/desktop/src/components/chat/ChatComposer.vue`
- Modify: `apps/desktop/src/stores/chat.ts`
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `apps/desktop/electron/main/database/user-data-repositories.ts`
- Modify: `apps/desktop/electron/main/database/user-data-client.test.ts`
- Create: `cloudbase/migrations/20260826220000_conversation_knowledge_preferences.sql`
- Create: `cloudbase/user-data/migrations/0002_conversation_knowledge_preferences.sql`
- Create: `cloudbase/user-data/migrations/0002_conversation_knowledge_preferences.rollback.sql`
- Modify: `cloudbase/user-data/function/user-data-handler.js`
- Modify: `tests/cloudbase/user-data-handler.test.ts`
- Modify: `tests/cloudbase/user-data-migration.test.ts`
- Create: `apps/desktop/tests/components/knowledge.test.ts`
- Modify: `apps/desktop/tests/components/chat.test.ts`
- Modify: `apps/desktop/tests/components/workbench.test.ts`

**Interfaces:**
- Produces: `/knowledge` page, owner-epoch Pinia store, `KnowledgeSelector`, and synchronized `{ knowledgeBaseIds, knowledgeMode }` conversation preferences.
- Consumes: Task 1 API/events, Task 4 service, current `conversation.preferences` revision/outbox/CAS.

- [ ] Add RED navigation, three-column, state/error, import/replace/recycle/export/delete, selector, new-conversation-empty, owner-switch, single-flight polling, cancellation, and backoff tests.
- [ ] Extend the existing conversation preference payload rather than creating a selection table; add local/remote CAS tests for manual updates beating late pulls.
- [ ] Implement minimal route/store/components using the real Preload API; do not inject a fake `window` API in smoke verification.
- [ ] Verify logout/account switch clears the store before late responses and new conversations select none.
- [ ] Build and run real Electron Renderer -> Preload -> IPC -> Main smoke for create/import/ready/select/reload.
- [ ] Complete two-stage review and commit `feat(knowledge): add v2 library workspace`.

### Task 6: CloudBase schema, Storage contracts, and epoch-safe sync

**Files:**
- Create: `cloudbase/migrations/20260826230000_personal_knowledge.sql`
- Create: `cloudbase/knowledge/migrations/0001_personal_knowledge.sql`
- Create: `cloudbase/knowledge/migrations/0001_personal_knowledge.rollback.sql`
- Create: `cloudbase/knowledge/function/index.js`
- Create: `cloudbase/knowledge/function/knowledge-handler.js`
- Create: `cloudbase/knowledge/function/package.json`
- Create: `cloudbase/knowledge/README.md`
- Create: `docs/runbooks/cloudbase-personal-knowledge.md`
- Create: `apps/desktop/electron/main/knowledge/cloudbase-knowledge-client.ts`
- Create: `apps/desktop/electron/main/knowledge/sync-service.ts`
- Create: `tests/cloudbase/knowledge-migration.test.ts`
- Create: `tests/cloudbase/knowledge-handler.test.ts`
- Create: `apps/desktop/electron/main/knowledge/cloudbase-knowledge-client.test.ts`
- Create: `apps/desktop/electron/main/knowledge/sync-service.test.ts`

**Interfaces:**
- Produces: trusted-context `autoforge-knowledge` actions, one-time upload tickets, immutable generation publication, incremental pull, durable jobs/leases, conversion journal, and `KnowledgeSyncService`.
- Consumes: current authenticated CloudBase session, Task 4 store, current user-data deployment conventions.

- [ ] Add RED SQL/handler tests for strict keys, trusted UID, default-deny grants, composite owner keys, bounded responses, sanitized errors, ticket owner/object/hash/size/MIME binding, and Storage-before-metadata purge.
- [ ] Add RED sync tests for page-last sequence/`hasMore`, no-progress detection, zero/stale cursor snapshots, 90-day floor, lease CAS/expiry, transient retry max three, conflicts, pause, and local conversion.
- [ ] Add the mandatory race test: hold a remote mutation await, call `cancel()`, let the mutation succeed and become pull-visible, then assert the cancelled run performs no local mutation or pull application.
- [ ] Implement per-base serialization and increment the base epoch on pause/cancel/owner invalidation/conversion; recheck after every remote await and before every local write.
- [ ] Implement mirrored migration artifacts, data-preserving rollback, strict function surface, client, and durable conversion operation/request IDs.
- [ ] Run artifact consistency, secret scans, JS syntax, migration/handler/client/sync suites. Do not deploy. Keep kill switch disabled.
- [ ] Complete two-stage review and commit `feat(knowledge): add epoch-safe CloudBase sync`.

### Task 7: TokenHub consent and deterministic hybrid retrieval

**Files:**
- Modify: `cloudbase/migrations/20260826230000_personal_knowledge.sql`
- Modify: `cloudbase/knowledge/migrations/0001_personal_knowledge.sql`
- Modify: `cloudbase/knowledge/function/knowledge-handler.js`
- Create: `apps/desktop/electron/main/knowledge/cloud-retriever.ts`
- Create: `apps/desktop/electron/main/knowledge/reciprocal-rank-fusion.ts`
- Create: `apps/desktop/electron/main/knowledge/cloud-retriever.test.ts`
- Create: `apps/desktop/electron/main/knowledge/reciprocal-rank-fusion.test.ts`
- Modify: `tests/cloudbase/knowledge-handler.test.ts`

**Interfaces:**
- Produces: separate embedding consent, 1024-dimension generation metadata, deterministic keyword/vector RRF, shadow publication, seven-day previous-generation retention, keyword-only fallback.
- Consumes: published cloud generations and Task 6 jobs.

- [ ] Add RED tests for refusal/revocation, no post-revocation send, vector deletion, exact 1024 dimensions, stable RRF tie-breaking, small-set cosine, outage behavior, drift probe, shadow isolation, and atomic switch.
- [ ] Implement the fixed model/config record and consent state transitions; omit HNSW until benchmark evidence exists.
- [ ] Verify unpublished generations never search and the previous published generation remains available during provider failure.
- [ ] Scan diagnostics for query/chunk content and keep cloud execution disabled without authorized environment configuration.
- [ ] Complete two-stage review and commit `feat(knowledge): add consented hybrid retrieval`.

### Task 8: Workflow-first Agent routing, grounding, and citations

**Files:**
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Create: `apps/desktop/electron/main/agent/knowledge-evidence.ts`
- Create: `apps/desktop/electron/main/agent/knowledge-evidence.test.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- Modify: `apps/desktop/electron/main/chat/conversation-context.ts`
- Modify: `apps/desktop/electron/main/chat/conversation-context.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `packages/shared/src/events.ts`
- Modify: `apps/desktop/src/stores/chat.ts`
- Modify: `apps/desktop/src/components/chat/MessageBlock.vue`
- Create: `apps/desktop/src/components/chat/KnowledgeStatusCard.vue`
- Create: `apps/desktop/src/components/chat/KnowledgeCitation.vue`
- Create: `apps/desktop/src/components/chat/KnowledgeSourcePreview.vue`
- Create: `apps/desktop/tests/components/knowledge-citations.test.ts`

**Interfaces:**
- Produces: Main-owned `knowledge_search({ query, rewrite? })`, immutable request evidence registry, Provider consent gate, citation validator/one repair attempt, strict/mixed final-answer policy, and citation previews.
- Consumes: current workflow/browser catalog logic, Task 5 captured selection, Task 4/7 retrievers, current Provider/context/usage paths.

- [ ] Add RED routing matrix tests for exact workflow only, KB only, workflow -> KB composite, later browser continuation, workflow denial/error/cancel, non-text output, no tool-capable model, workflow calls <= 5, knowledge searches <= 3, Agent decisions <= 10, and at most eight total evidence items in the immutable current-turn registry across all searches.
- [ ] Add RED security tests proving model-provided IDs, owner, `topK`, SQL, path, generation, and prompt-injection evidence cannot alter Main scope or tools.
- [ ] Add RED grounding tests for strict insufficient evidence, mixed labeling, Provider consent denial/switch, invalid citation, one repair success/failure, and source unavailable.
- [ ] Implement knowledge catalog exposure only after workflow resolution while preserving `WORKFLOW_AGENT_POLICY`, `workflowLaunchOnlyRequest`, browser tools, leading messages, context budgets, Provider snapshots, and usage purposes.
- [ ] Validate citations against the capped current-turn evidence registry before persistence; send only minimum snippets after per-Provider consent.
- [ ] Extend `packages/shared/src/events.ts`, hydrate the new knowledge blocks in the existing `apps/desktop/src/stores/chat.ts` chat-event owner, and mount their views from `apps/desktop/src/components/chat/MessageBlock.vue`; keep persisted and live event blocks equivalent.
- [ ] Run context-compression regressions proving hidden chunks/paths/signed URLs never enter summaries or Provider payloads.
- [ ] Run real Electron select -> ask -> retrieve -> cite -> preview flow.
- [ ] Complete two-stage review and commit `feat(knowledge): ground v2 chat with citations`.

### Task 9: Signed entitlement, downgrade, export/delete, and kill switch

**Files:**
- Create: `apps/desktop/electron/main/knowledge/entitlement-verifier.ts`
- Create: `apps/desktop/electron/main/knowledge/entitlement-verifier.test.ts`
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `apps/desktop/electron/main/knowledge/knowledge-service.ts`
- Modify: `apps/desktop/electron/main/knowledge/sync-service.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify: `apps/desktop/src/stores/knowledge.ts`
- Modify: `apps/desktop/src/views/KnowledgeView.vue`
- Modify: `apps/desktop/tests/components/knowledge.test.ts`

**Interfaces:**
- Produces: Main-verified entitlement snapshot, 72-hour grace, beta/cloud gates, downgrade selection/read-only state, 30+30-day cloud lifecycle, and local-preserving cloud kill switch.
- Consumes: built-in public key configuration and existing authorization refresh lifecycle.

- [ ] Add RED Ed25519 fixture tests for valid, tampered, wrong-user, unknown-key, issued-in-future, expired, and grace-boundary snapshots.
- [ ] Add RED behavior tests for non-member 1/1, expiry keep-one selection, encrypted read-only extras, stopped search/cloud operations, export/delete availability, 30-day conversion, recycle, immediate purge, and kill switch catalog removal.
- [ ] Implement Main enforcement; Renderer flags remain advisory.
- [ ] Verify cloud-off preserves local management/export/delete/authorized local retrieval.
- [ ] Complete two-stage review and commit `feat(knowledge): enforce v2 membership lifecycle`.

### Task 10: Security evaluation, benchmarks, privacy, and release gates

**Files:**
- Create: `apps/desktop/electron/main/knowledge/evaluation/corpus.json`
- Create: `apps/desktop/electron/main/knowledge/evaluation/knowledge-evaluation.test.ts`
- Create: `apps/desktop/electron/main/knowledge/evaluation/knowledge-benchmark.test.ts`
- Create: `apps/desktop/electron/e2e/knowledge-smoke-main.ts`
- Create: `apps/desktop/tests/e2e/knowledge-smoke.spec.ts`
- Modify: `package.json`
- Modify: `playwright.config.ts`
- Create: `docs/privacy/personal-knowledge-base-data-flow.md`
- Create: `docs/runbooks/personal-knowledge-base-release.md`
- Create: `.superpowers/sdd/2026-08-26-personal-knowledge-base-v2/final-verification.md`.

**Interfaces:**
- Produces: machine-readable gate results and fail-closed availability inputs.
- Consumes: all prior tasks plus recorded origin/v2 baseline.

- [ ] Run cross-owner matrices and persisted-artifact sentinel scans; require zero leaks.
- [ ] Run deterministic evaluation: Recall@8 >= 90%, citation support/grounding/no-evidence each >= 95%, supported-document success >= 99%.
- [ ] Run performance profiles: 10,000 chunks FTS p95 <= 300 ms, import ack <= 1 s, 100-page PDF ready p95 <= 2 minutes; record cloud <= 2 s only with authorized staging evidence.
- [ ] Add privacy disclosure for Shanghai CloudBase, Guangzhou TokenHub, chat Providers, purposes, retention, consent, export/delete, and degradation.
- [ ] Run full real Electron local flow and cloud-off/embedding-refusal/expiry/Provider-switch paths.
- [ ] Invoke whole-branch independent review; fix all Critical/Important findings and rerun it.
- [ ] Complete two-stage review and commit `test(knowledge): gate v2 personal library rollout`.

## Final Branch Verification and Delivery

- [ ] Invoke `superpowers:verification-before-completion` and run build, typecheck, lint, focused suites, full tests, Electron smoke, evaluation, security scans, and `git diff --check` on final HEAD.
- [ ] Reproduce recorded origin/v2 failures in a clean base worktree where needed; do not classify new/changed overlap as baseline.
- [ ] Verify the diff contains only personal knowledge-base work and necessary current-v2 integration.
- [ ] Invoke `superpowers:requesting-code-review`, resolve all Critical/Important findings, and rerun final gates personally.
- [ ] Invoke `superpowers:finishing-a-development-branch`; push only `codex/personal-knowledge-base-v2` and confirm with `git ls-remote`.
- [ ] Do not deploy CloudBase, merge, delete the old branch, or create a PR.
