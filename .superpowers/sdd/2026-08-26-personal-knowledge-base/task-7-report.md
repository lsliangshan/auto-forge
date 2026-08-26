# Task 7 Report: Embedding consent and hybrid cloud retrieval

## Implementation

- Split the shared knowledge consent contract into independent chat-provider and TokenHub embedding consent. The embedding contract pins processor `tokenhub`, processing region `Guangzhou`, model `kinfra-text-embedding-0.6b`, and exactly 1024 dimensions. Non-granted consent is constrained to keyword-only retrieval.
- Added a Main-only `CloudRetriever` with opaque frozen published-generation snapshots, fixed Main-owned `topK = 8`, complete-scope validation, generation-to-base validation, and metrics-only diagnostics. No retrieval IPC or provider controls were exposed to Renderer.
- Extended the CloudBase Main client with embedding consent, published snapshot, hybrid search, shadow generation build, and server-owned drift-probe actions. Model, dimensions, probe text, owner identity, and generation policy remain Function/server controlled.
- Added the Cloud Function TokenHub adapter and hybrid retrieval implementation. It sends only when server-returned consent is granted, requests only the approved model, validates and restores provider response order, rejects non-1024 vectors or an explicitly different response model, computes exact cosine only for at most 10,000 vectors, and fuses keyword/vector ranks using deterministic RRF with constant 60 and binary chunk-ID tie-breaking. There is no reranker.
- Added SQL contracts for owner-scoped embedding consent, generation-chunk mappings, 1024-dimensional vectors, model/config versioning, server-owned probe fingerprints, shadow preparation/completion/failure, published-only snapshot/search, and retention cleanup. Publication creates keyword mappings regardless of embedding consent, atomically retires the prior generation, and retains it for seven days. The migration backfills keyword mappings for already-published generations.
- Revocation/denial deletes vectors but not generation-chunk mappings. Granting and reading cloud embedding consent are fail-closed through the existing entitlement/beta/cloud/kill-switch gate; denial/revocation remain available so vectors can always be removed. Provider outage or deprecation leaves the last published generation live and returns keyword-only results.
- Updated the knowledge inspector and selector to show hybrid/reindexing/keyword-only state and a separate `TokenHub（广州）` disclosure. Raw files, canonical text, chunks, and persistent vectors remain documented as Shanghai-side data; TokenHub processing is disclosed as Guangzhou.
- Kept both forward migrations byte-identical and updated the rollback for every new function and table. No live environment was contacted and cloud/beta gates were not enabled.

## Exact RED/GREEN evidence

### Intended RED before production code

- `pnpm exec vitest run packages/shared/src/contracts.test.ts` -> 1 failed / 76 passed: the prior chat-only consent schema rejected the separate TokenHub consent object.
- `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/cloud-retriever.test.ts electron/main/knowledge/cloudbase-knowledge-client.test.ts` -> collection failed because `cloud-retriever.js` and the new consent/snapshot methods did not exist.
- `pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts` -> collection failed because `hybrid-retrieval.js` did not exist.
- `node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/knowledge.test.ts -t "TokenHub Guangzhou"` -> selected UI test failed because the inspector did not disclose `TokenHub（广州）`.
- `pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts -t "server-owned probe"` -> the new drift action returned `INVALID_INPUT`.
- Focused self-review REDs reproduced: TokenHub vectors were associated in provider response order, publish `CONFLICT` was flattened to `TRANSIENT_FAILURE`, and the generation lifecycle could not attach model/config while staying in `staging`.
- `pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts -t "mismatched TokenHub|drift builds isolated|maps active chunks|checks the cloud gate"` -> 4 failed / 25 skipped, proving the explicit response-model, correct trigger, keyword-mapping, gate, and drift-CAS gaps.
- `pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts -t "deterministic reciprocal-rank"` -> 1 failed / 28 skipped: locale collation ordered `ä` before `z`, rather than the required locale-independent binary tie-break.
- `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/cloud-retriever.test.ts -t "incomplete snapshots"` -> 1 failed / 4 skipped: an incomplete remote snapshot was accepted.
- `pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts -t "drift builds isolated"` -> 1 failed / 28 skipped: unchanged probe output bypassed stored model/config drift comparison.

### GREEN after implementation

- All focused RED commands above pass after their corresponding minimal implementation.
- `pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts tests/cloudbase/user-role-handler.test.ts packages/shared/src/contracts.test.ts` -> 3 files passed, 116 tests passed.
- `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/*.test.ts electron/main/ipc/register-ipc.test.ts electron/preload/*.test.ts` -> 14 files passed, 175 tests passed.
- `node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/knowledge.test.ts` -> 1 file passed, 36 tests passed.
- `pnpm typecheck` -> all four typed workspace projects passed.
- `pnpm lint` -> exit 0, 0 errors; the repository still reports 422 warnings.
- `pnpm build` -> shared/workflow packages and Electron Main/Preload/Renderer/worker production builds passed.
- `pnpm test` from `apps/desktop` -> Renderer 10 files / 380 tests passed; Node 91 files / 2,406 tests passed with exactly one preserved failure: `electron/main/application.test.ts > bills real context-summary streams through the Application-supplied provider snapshot`, which receives `CONTEXT_LIMIT_EXCEEDED`.
- Forward migration `cmp` -> exit 0. `git diff --check` -> clean. High-risk secret pattern scan -> clean. Controller-owned `progress.md` -> unmodified.

## Files changed

- Shared contracts: `packages/shared/src/desktop-api.ts`, `packages/shared/src/contracts.test.ts`.
- Main: `apps/desktop/electron/main/knowledge/cloud-retriever.ts`, its test, `cloudbase-knowledge-client.ts`, its test, knowledge consent defaults, and IPC fixtures.
- Renderer: `InspectorPanel.vue`, `KnowledgeSelector.vue`, and knowledge component tests.
- Function/retrieval: `cloudbase/knowledge/function/hybrid-retrieval.js`, `knowledge-handler.js`, `index.js`, and `tests/cloudbase/knowledge-handler.test.ts`.
- Database/deployment: canonical and versioned forward migrations, rollback migration, and `cloudbase/knowledge/README.md`.
- Evidence: this report only. The controller-owned progress file was not staged or modified.

## Verification

- Verified denied and revoked consent never invoke the injected embedding adapter in focused tests; SQL revocation deletes vectors while leaving keyword mappings.
- Verified exact 1024 dimensions at shared DTO, Function adapter, JavaScript vector validation, SQL row constraint, and versioned generation configuration boundaries.
- Verified deterministic RRF, exact-cosine ranking, fixed small-index bound, and no external reranker.
- Verified provider outage/deprecation returns keyword-only evidence from the captured published generation and does not log query text or raw provider errors.
- Verified Function and Main both reject candidates outside the captured published snapshot; Main also rejects forged/incomplete snapshots and generation/base mismatches.
- Verified shadow completion precedes atomic publication, a publish CAS loss preserves the ready shadow and original `CONFLICT`, drift compares probe plus stored model/config, and the prior published generation receives a seven-day retention deadline.
- Verified normal retrieval/build logs contain only mode, degradation reason, generation/result counts, model, dimensions, and opaque generation IDs; sentinel document/query/chunk/provider text is absent.
- Running the workspace-root `pnpm test` wrapper also produced three cwd-sensitive `knowledge-smoke-runner.test.ts` failures because those tests resolve desktop scripts from root. Running the desktop package script from its intended directory passes those smoke tests and leaves only the required context-summary baseline. No unrelated smoke-runner code was changed.

## External gates

- No approved CloudBase pre-production environment or TokenHub credential exists, so real Function networking, TokenHub response/model behavior, PostgreSQL parsing/execution, exact-cosine payload limits, RLS isolation, grants, revocation/build races, publication CAS concurrency, retention scheduling, and actual vector deletion remain release gates.
- Shanghai persistence and Guangzhou processing/data-handling claims require infrastructure, vendor, and compliance verification before enabling the feature.
- Server deployment must inject `AUTOFORGE_TOKENHUB_BASE_URL` and `AUTOFORGE_TOKENHUB_API_KEY`; neither may enter Electron. The live environment must keep beta/cloud disabled until migration, storage, RLS, TokenHub, and failure-mode checks pass.
- A trusted server worker must schedule reindex/drift builds and retention cleanup. Repository contracts are present, but live scheduling was not enabled or exercised.

## Self-review

- Corrected provider response ordering by validated unique `index` fields and rejected explicit response-model mismatch.
- Preserved a ready shadow on publish CAS loss instead of incorrectly failing it.
- Corrected the generation trigger while restoring the unrelated version lifecycle to its prior behavior.
- Added publish-time and migration-time generation-chunk mappings so denied/revoked users retain keyword retrieval without vectors.
- Added pre-send cloud gating, drift expected-generation CAS, and stored model/config drift comparison.
- Replaced locale-sensitive tie-breaking with binary comparison and strengthened Main snapshot completeness/base binding.
- Reviewed the full diff for unrelated Task 1-5 changes, secrets, payload-bearing logs, Renderer-owned policy fields, migration mismatch, and progress-file churn; none remain.

## Concerns

- Live TokenHub, PostgreSQL/CloudBase migration, vector, RLS, retention, and concurrency behavior is unverified by ruling and must block release.
- The unrelated context-summary baseline still fails as required. The workspace-root test wrapper additionally has an existing cwd-sensitive smoke-test invocation issue; the intended desktop-package invocation passes those smoke tests.
