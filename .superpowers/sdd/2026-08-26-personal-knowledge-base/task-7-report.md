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

## Fix Round 1

### Implementation

- Made Task 7 reachable through the production boundary. Renderer exposes only a strict `granted | denied | revoked` decision; shared contracts, Preload, and authenticated IPC reject caller-supplied owner IDs, request IDs, knowledge-base scope, generation IDs, and provider controls. Application constructs `CloudBaseKnowledgeClient` from the production CloudBase Function port (or the deterministic injected Function port used by tests), and Main generates the mutation request ID.
- Replaced the hard-coded embedding consent response with the independent TokenHub consent lifecycle while preserving the separate chat-provider consent object for Task 8. Grant remains fail-closed behind every authoritative member/status/beta/cloud/kill-switch gate; denial and revocation remain callable while the gate is closed.
- Changed `KnowledgeService.search()` to derive scope from the persisted conversation selection and local sync state, classify only active `synced` bases with a non-null published generation as cloud-eligible, capture a server-published immutable generation snapshot, and invoke `CloudRetriever` with fixed Main-owned `topK = 8`. Local-only selections do not contact CloudBase. Closed gates and Function failures retain local keyword fallback; mixed local/cloud rankings are combined with deterministic RRF ordering.
- Added a SQL-backed embedding-send authorization epoch and opaque lease protocol. Every query, chunk-index, and drift-probe TokenHub call first locks/revalidates granted consent and records an admitted send. Denial/revocation advances the epoch, closes admission, drains older admitted sends, then deletes vectors. Build completion also takes a consent share lock so revocation cannot race vector persistence. No lease token, query, or chunk text is logged.
- Replaced the owner-global retrieval mode with `retrievalByBase`. SQL derives hybrid/reindexing/keyword-only from each base's published vectors and jobs; Main/shared schemas validate unique base IDs; the store, inspector, and chat selector render each cloud base independently.
- Added the separate TokenHub Guangzhou disclosure and grant/deny/revoke controls to the knowledge view. Cloud/Beta migration defaults remain disabled and the kill switch remains enabled.
- Kept the canonical and versioned forward migrations byte-identical, added owner RLS/service-role coverage for the lease table and functions, and updated rollback ordering coherently. The controller-owned `progress.md` was neither edited nor staged by this fix.

### Exact RED/GREEN evidence

#### Intended RED before production changes

- `pnpm exec vitest run packages/shared/src/contracts.test.ts --config vitest.config.ts` -> 2 failed / 76 passed: base-specific `retrievalByBase` was rejected and `knowledgeSetEmbeddingConsent` did not exist.
- `pnpm exec vitest run apps/desktop/electron/preload/bridge.test.ts apps/desktop/electron/main/ipc/register-ipc.test.ts --config vitest.config.ts` -> 3 failed / 43 passed: the bridge method and IPC channel were absent.
- `node scripts/run-vitest-electron.mjs run electron/main/knowledge/knowledge-service.test.ts --config vitest.node.config.ts -t "uses only authoritative|keeps Main-owned TokenHub"` -> 2 failed / 33 skipped: an authoritatively synced selected base still used local retrieval and consent remained hard-coded.
- `node scripts/run-vitest-electron.mjs run electron/main/application.test.ts --config vitest.node.config.ts -t "wires embedding consent"` -> 1 failed / 150 skipped: Application returned unknown local consent instead of reaching the CloudBase client.
- `node scripts/run-vitest-electron.mjs run tests/components/knowledge.test.ts --config vitest.config.ts -t "offers the separate|renders retrieval mode per cloud base"` -> 2 failed / 36 skipped: no consent decision control existed and a keyword-only base borrowed another base's hybrid state.
- `pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts --config vitest.config.ts -t "does not begin a late|serializes TokenHub"` -> 3 failed / 29 skipped: late query and build sends reached the embedding adapter after revocation, and the migration had no send-admission lease.
- Self-review RED: `node scripts/run-vitest-electron.mjs run electron/main/knowledge/knowledge-service.test.ts --config vitest.node.config.ts -t "keeps cloud availability fail-closed"` -> 1 failed / 35 skipped because a disabled beta gate was reported available when the kill switch alone was open.
- Self-review RED: `node scripts/run-vitest-electron.mjs run electron/main/knowledge/knowledge-service.test.ts --config vitest.node.config.ts -t "uses only authoritative synced selection"` -> 1 failed / 35 skipped because a local-only search still contacted the cloud entitlement boundary.

#### GREEN after the minimal fixes

- Each focused RED command above passed after its corresponding implementation. The two Main self-review commands each passed 1 / skipped 35.
- `pnpm exec vitest run packages/shared/src/contracts.test.ts apps/desktop/electron/preload/bridge.test.ts apps/desktop/electron/main/ipc/register-ipc.test.ts apps/desktop/electron/main/knowledge/cloudbase-knowledge-client.test.ts tests/cloudbase/knowledge-handler.test.ts tests/cloudbase/user-role-handler.test.ts --config vitest.config.ts` -> 6 files / 177 tests passed.
- `node scripts/run-vitest-electron.mjs run electron/main/application.test.ts electron/main/knowledge/knowledge-service.test.ts --config vitest.node.config.ts -t "wires embedding consent|uses only authoritative synced selection|keeps Main-owned TokenHub|keeps cloud availability fail-closed"` -> 2 files / 4 focused tests passed, 183 skipped.
- `node scripts/run-vitest-electron.mjs run electron/main/knowledge electron/main/application.test.ts --config vitest.node.config.ts` -> all 11 Main knowledge files passed; Application preserved exactly the unrelated `CONTEXT_LIMIT_EXCEEDED` baseline, for 281 passed / 1 failed across 12 files.
- `node scripts/run-vitest-electron.mjs run tests/components/knowledge.test.ts --config vitest.config.ts` -> 1 file / 38 tests passed.
- `pnpm typecheck` -> all four typed workspace projects passed.
- `pnpm lint` -> exit 0 with the unchanged repository baseline of 422 warnings and 0 errors.
- `pnpm build` -> shared/workflow packages and Electron Main/Preload/Renderer/worker production builds passed.
- Forward migration `cmp` -> exit 0; both files have SHA-256 `f9d78818b61cfc4dd49c933b0712b5e07aab051775077b382b4540af306ae63c`. `git diff --check` -> clean. Refined high-risk secret scan -> clean.

### Files changed

- Shared/Preload/IPC: `packages/shared/src/desktop-api.ts`, `packages/shared/src/contracts.test.ts`, `apps/desktop/electron/preload/bridge.ts`, its test, `apps/desktop/electron/main/ipc/register-ipc.ts`, and its test.
- Application/Main: `apps/desktop/electron/main/application.ts`, its test, `knowledge/cloudbase-knowledge-client.ts`, its test, `knowledge/knowledge-service.ts`, and its test.
- Renderer: `apps/desktop/src/stores/knowledge.ts`, `views/KnowledgeView.vue`, `components/InspectorPanel.vue`, `components/chat/KnowledgeSelector.vue`, and `apps/desktop/tests/components/knowledge.test.ts`.
- Function/database: `cloudbase/knowledge/function/knowledge-handler.js`, both byte-identical forward migrations, the rollback migration, and `tests/cloudbase/knowledge-handler.test.ts`.
- Evidence: this appended Fix Round 1 section in `task-7-report.md`.

### Verification

- Verified the complete Renderer -> strict shared contract -> Preload -> authenticated owner-derived IPC -> Application/Main -> CloudBase client mutation chain. Renderer never supplies a user ID, request ID, base scope, generation snapshot, topK, model, dimensions, or TokenHub request.
- Verified local-only search makes no cloud call; only synced selected bases with a published generation use the cloud path; snapshot and fixed topK remain Main-owned; closed gates fall back locally.
- Verified deterministic query and chunk-build interleavings in which revocation returns before the stale operation reaches send admission. Both are rejected before TokenHub disclosure. SQL contract tests verify row locking, epoch advance, lease drain, vector deletion, RLS, service-role-only functions, and rollback.
- Verified base-specific hybrid/keyword-only rendering with two cloud bases, and validated duplicate base status entries are rejected at shared and Main-client boundaries.
- Verified normal Function/Main retrieval diagnostics contain metrics and opaque generation identifiers only; sentinel query, chunk, and provider payload text remains absent.

### External gates

- The ruling still blocks live CloudBase/TokenHub access. Real PostgreSQL parsing/execution, transaction-lock and lease-drain behavior, RLS isolation, grants, vector deletion, TokenHub model/dimension behavior, publication concurrency, and Shanghai/Guangzhou data handling remain external release gates.
- A hard Function termination after send admission can strand a durable lease and make revocation wait. Before release, the live environment needs bounded provider/runtime execution plus an audited reconciliation procedure that cannot permit a post-revocation late send.
- No cloud/beta flag was enabled. Production reachability is implemented, but the existing fail-closed defaults intentionally keep the feature unavailable until the external gates pass.

### Self-review

- Re-read the full production and test diff for Renderer-controlled authority fields, direct credentials/storage access, consent conflation, unpublished generation exposure, global retrieval status, payload-bearing logs, and unrelated Task 1-5 churn.
- Corrected two issues found during self-review: cloud availability now requires every authoritative gate, and local-only selections no longer incur a cloud entitlement call.
- Moved send-release validation out of a `finally` throw so lint remains clean while preserving release-on-provider-error behavior.
- Confirmed paired migration equality, rollback dependencies, lease-table RLS/service-role restrictions, and that the kill-switch defaults remain closed.

### Concerns

- Live embedding/vector/RLS/concurrency behavior remains unverified and blocks release under the task ruling.
- The durable-lease crash-recovery procedure must be designed and exercised before enabling TokenHub sends.
- The unrelated Application context-summary test still fails only with the required `CONTEXT_LIMIT_EXCEEDED` baseline.

## Fix Round 2

### Implementation

- Replaced the unbounded admitted-send row with a durable finite-state lease: `admitted -> sending -> released | expired`. Admission expires after 10 seconds; the immediate pre-send CAS re-locks consent and the lease, verifies granted consent plus the current epoch/token/state/deadline, and creates one fixed, non-extendable 30-second sending deadline. Stale, expired, released, or old-epoch leases cannot transition to send.
- Made Function-side disclosure bounded and fail-closed. TokenHub work starts only after the SQL transition, has a 20-second abort timeout capped by the SQL deadline, and the TokenHub adapter refuses an already-expired server deadline before calling `fetch`. Query text, chunk text, lease tokens, and raw provider payloads are not logged.
- Made completion idempotent and retry-safe. Function attempts release twice, with each attempt bounded to two seconds. A lost response can be retried after the SQL state is already terminal. If the provider failed, that original safe provider error remains authoritative even when release also fails; if the provider succeeded but release cannot be confirmed, no vector result proceeds to storage/search and the operation degrades safely.
- Made revocation crash-recoverable without an indefinite wait. The consent row lock advances the epoch and closes admission first, immediately expires old admitted leases, waits only for genuinely sending old leases until their immutable deadlines, expires them, then deletes vectors. A Function crash or lost release response therefore delays revocation by at most the remaining fixed sending lease instead of stranding consent forever.
- Added seven-day cleanup for terminal send leases, service-role-only RBAC for the new start transition, coherent rollback entries, and byte-identical canonical/versioned migrations. No live service was contacted and no cloud/beta gate was opened.

### Exact RED/GREEN evidence

#### Intended RED before production changes

Command:

```text
pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts --config vitest.config.ts -t "crash-safe"
```

Exact focused result:

```text
tests/cloudbase/knowledge-handler.test.ts (38 tests | 7 failed | 31 skipped)
× crash-safe adapter refuses an expired SQL send deadline before fetch
× crash-safe pre-send CAS blocks an admitted operation revoked before disclosure
× crash-safe release retries idempotent completion after a lost response
× crash-safe release failure preserves the original provider error
× crash-safe timeout aborts a send and attempts release
× crash-safe revocation expires a stranded sending lease at its fixed deadline
× defines the crash-safe finite-state send protocol and bounded revocation

Test Files  1 failed (1)
Tests       7 failed | 31 skipped (38)
Duration    363ms
```

The failures showed the intended missing behavior: the adapter fetched past an expired deadline; no start CAS was called; one-shot completion changed hybrid success to `provider_unavailable`; release failure masked `MODEL_DEPRECATED`; a hung provider hit the test timeout; the stranded lease remained `admitted`; and the migration had no finite-state/expiry contract.

#### GREEN after the minimal fix

The exact same focused command produced:

```text
Test Files  1 passed (1)
Tests       7 passed | 31 skipped (38)
Duration    143ms
```

Additional exact covering results:

- `pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts --config vitest.config.ts` -> `1 passed`, `38 passed`.
- `pnpm exec vitest run packages/shared/src/contracts.test.ts apps/desktop/electron/preload/bridge.test.ts apps/desktop/electron/main/ipc/register-ipc.test.ts apps/desktop/electron/main/knowledge/cloudbase-knowledge-client.test.ts tests/cloudbase/knowledge-handler.test.ts tests/cloudbase/user-role-handler.test.ts --config vitest.config.ts` -> `6 passed`, `183 passed`.
- From `apps/desktop`, `node scripts/run-vitest-electron.mjs run electron/main/knowledge electron/main/application.test.ts --config vitest.node.config.ts` -> all 11 Main knowledge files passed; combined result `11 passed | 1 failed`, `281 passed | 1 failed`, with only the required `CONTEXT_LIMIT_EXCEEDED` Application baseline.
- From `apps/desktop`, `node scripts/run-vitest-electron.mjs run tests/components/knowledge.test.ts --config vitest.config.ts` -> `1 passed`, `38 passed`.
- From `apps/desktop`, `pnpm test` -> Renderer `10 passed`, `382 passed`; Node `91 passed | 1 failed`, `2410 passed | 1 failed`, with only the same required `CONTEXT_LIMIT_EXCEEDED` baseline.
- `pnpm typecheck` -> all four typed workspace projects passed.
- `pnpm lint` -> exit 0, `0 errors`, unchanged `422 warnings`.
- `pnpm build` -> shared/workflow packages plus Electron Main, Preload, Renderer, and worker builds passed.
- `node --check cloudbase/knowledge/function/knowledge-handler.js` and `node --check cloudbase/knowledge/function/index.js` -> exit 0.
- Forward migration `cmp` -> exit 0; both SHA-256 values are `cbe4a9f1157233a0c15ad3d5c57cadd9f3a9d8fd5e112dff7945cba8090c8d73`.
- `git diff --check` -> clean. Refined high-risk secret scan -> no matches.

### Files changed

- Function: `cloudbase/knowledge/function/knowledge-handler.js`.
- Database: `cloudbase/knowledge/migrations/0001_personal_knowledge.sql`, `cloudbase/migrations/20260826120000_personal_knowledge.sql`, and `cloudbase/knowledge/migrations/0001_personal_knowledge.rollback.sql`.
- Tests: `tests/cloudbase/knowledge-handler.test.ts`.
- Evidence: this appended Fix Round 2 section in `task-7-report.md`.

### Verification

- Deterministic deferred/interleaving tests cover an admitted operation revoked before disclosure, fixed-deadline recovery of a stranded sending operation, denial of new admission while revocation drains, vector deletion only after the drain, idempotent replay after a lost completion response, two failed release attempts, original-provider-error preservation, timeout abort, and adapter refusal after expiry.
- SQL contract tests cover the four states, 10-second admitted expiry, immediate current-consent/epoch/token/state/deadline CAS, non-extendable 30-second sending deadline, idempotent terminal completion, admitted cancellation, sending-only bounded revocation wait, seven-day terminal pruning, service-role RBAC, rollback, RLS table inclusion, and exact migration equality.
- Re-ran shared, Preload/IPC, Application, KnowledgeService/CloudRetriever/cloud client, Function/migration/RBAC, all Main knowledge, and UI knowledge boundaries. Task 7 changes introduced no new failure.
- Reviewed logs and diagnostics: production logging still contains only mode/reason/count/model/dimension/opaque generation metadata. It does not contain lease tokens, query/chunk/document text, filenames, paths, URLs, credentials, or provider payloads.

### External gates and bounded assumptions

- Repository safety bounds are internal implementation limits, not public performance guarantees: admitted leases are 10 seconds, sending leases are fixed at 30 seconds, TokenHub work times out and aborts at 20 seconds, and two release RPC attempts are each capped at two seconds. Terminal leases are retained for seven days before trusted-worker cleanup.
- Live validation must prove CloudBase/PostgreSQL permits the revocation transaction to wait through the maximum remaining 30-second sending deadline, `clock_timestamp()` and Function host clocks are sufficiently aligned for the returned epoch-millisecond deadline, and deployed statement/Function timeouts do not abort the safe drain prematurely.
- Live validation must prove the TokenHub transport honors `AbortSignal` and infrastructure bounds an already-started request within the fixed sending lease. If transport ignores abort, repository code still prevents late result persistence, but the vendor/runtime bound is required before enabling disclosure.
- Real migration parsing/execution, lock/CAS interleavings, crash/termination recovery, RLS/grants, vector deletion, cleanup scheduling, and TokenHub behavior remain external release gates because no approved pre-production environment or credential exists.
- Cloud/beta availability remains fail-closed and the kill switch remains enabled.

### Self-review

- Re-read the complete Round 2 production/test/migration diff for indefinite waits, lease extension, late sends, release-error masking, vector persistence after revoke, owner/policy injection, payload-bearing logs, RBAC/RLS omissions, migration drift, rollback ordering, and unrelated Task 1-5 changes.
- Confirmed every continuation after a provider success requires confirmed terminal release; an unconfirmed release leaves SQL recovery authoritative and prevents vector use. Confirmed provider failure remains authoritative over release failure.
- Confirmed revoke/start/begin serialize on the consent row; completion remains able to transition a sending lease while revocation waits; no code path extends a sending deadline; expired/old-epoch starts fail closed.
- Confirmed the controller-owned `progress.md` was not edited or staged by this fix. No real CloudBase or TokenHub call was made.

### Concerns

- Live PostgreSQL/CloudBase, TokenHub abort/timeout, clock alignment, Function transaction duration, RLS, and cleanup scheduling remain unverified release blockers under the ruling.
- The unrelated Application context-summary suite retains exactly the required `CONTEXT_LIMIT_EXCEEDED` baseline failure.

## Fix Round 3

### Implementation

- Tightened the Function completion boundary so a provider result is usable only when completion returns the exact pair `released: true` and `state: released`. An `expired`, admitted, missing, malformed, conflicted, or otherwise unconfirmed completion discards provider success and degrades/fails safely. Provider-error paths still preserve the original safe provider error when completion cannot be confirmed.
- Replaced the broad SQL completion update with an exact consent-and-lease CAS. Completion now locks the owner consent row and the exact owner/token/epoch lease row, distinguishes existing `released`, `expired`, `admitted`, and missing rows, and never fabricates success for a missing or pruned lease.
- Existing exact terminal `released` replay remains idempotently successful. Existing `expired` replay remains expired. An unexpired admitted lease is rejected as admitted; an expired or consent-invalid admitted lease is atomically expired. Wrong token and wrong epoch resolve as missing/non-success without mutating another lease.
- A new release transition is possible only from exact `sending`, while consent is still granted at the same epoch and `expires_at > clock_timestamp()`. Consent/epoch mismatch atomically expires the sending lease. If the deadline crosses during completion, the guarded update loses and the same transaction expires the lease instead of restoring success.
- Kept both forward migrations byte-identical. No schema/RBAC/rollback shape changed in this round, no live service was contacted, and no cloud/beta gate was opened.

### Exact RED/GREEN evidence

#### Intended RED before production changes

Command:

```text
pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts --config vitest.config.ts -t "crash-safe"
```

Exact focused result:

```text
tests/cloudbase/knowledge-handler.test.ts (40 tests | 3 failed | 31 skipped)
× crash-safe discards provider success when completion reports an expired deadline
× crash-safe never persists provider success when consent changes before completion
× defines the crash-safe finite-state send protocol and bounded revocation

Test Files  1 failed (1)
Tests       3 failed | 6 passed | 31 skipped (40)
Duration    158ms
```

The first failure returned `mode: hybrid` and surfaced `VECTOR_RESULT_MUST_BE_DISCARDED` after the lease deadline. The second persisted and published `generation_shadow` after the consent epoch changed. The SQL contract failure showed no consent/lease completion locks and still contained the broad admitted-or-sending release plus `COALESCE(..., 'released')` missing-row fabrication.

#### GREEN after the minimal fix

The exact same focused command produced:

```text
Test Files  1 passed (1)
Tests       9 passed | 31 skipped (40)
Duration    146ms
```

Additional exact covering results:

- `pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts tests/cloudbase/user-role-handler.test.ts --config vitest.config.ts` -> `2 passed`, `50 passed`.
- `pnpm exec vitest run packages/shared/src/contracts.test.ts apps/desktop/electron/preload/bridge.test.ts apps/desktop/electron/main/ipc/register-ipc.test.ts apps/desktop/electron/main/knowledge/cloudbase-knowledge-client.test.ts tests/cloudbase/knowledge-handler.test.ts tests/cloudbase/user-role-handler.test.ts --config vitest.config.ts` -> `6 passed`, `185 passed`.
- From `apps/desktop`, `node scripts/run-vitest-electron.mjs run electron/main/knowledge electron/main/application.test.ts --config vitest.node.config.ts` -> all 11 Main knowledge files passed; combined result `11 passed | 1 failed`, `281 passed | 1 failed`, with only the required `CONTEXT_LIMIT_EXCEEDED` Application baseline.
- From `apps/desktop`, `node scripts/run-vitest-electron.mjs run tests/components/knowledge.test.ts --config vitest.config.ts` -> `1 passed`, `38 passed`.
- `pnpm typecheck` -> all four typed workspace projects passed.
- `pnpm lint` -> exit 0, `0 errors`, unchanged `422 warnings`.
- `pnpm build` -> shared/workflow packages plus Electron Main, Preload, Renderer, and worker builds passed.
- `node --check cloudbase/knowledge/function/knowledge-handler.js` -> exit 0.
- Forward migration `cmp` -> exit 0; both SHA-256 values are `97652bdb1934ca74ad594433c465caf5a201a6b9e99e07d7268618f133943e94`.
- `git diff --check` -> clean. Refined high-risk secret scan -> no matches.

### Files changed

- Function: `cloudbase/knowledge/function/knowledge-handler.js`.
- Database: `cloudbase/knowledge/migrations/0001_personal_knowledge.sql` and byte-identical `cloudbase/migrations/20260826120000_personal_knowledge.sql`.
- Tests: `tests/cloudbase/knowledge-handler.test.ts`.
- Evidence: this appended Fix Round 3 section in `task-7-report.md`.

### Verification

- Deterministically verified provider success followed by deadline expiry returns keyword-only retrieval and removes the vector-only candidate from the result.
- Deterministically verified provider success followed by a consent-epoch change never calls embedding-generation completion, never persists vectors, never publishes the shadow, and fails safely.
- Tight SQL assertions cover exact owner/token/epoch lookup; missing/pruned and wrong-token/wrong-epoch non-success; admitted rejection/expiry; expired replay; exact released replay; granted/current consent; exact `sending`; and the unexpired deadline predicate. The prior broad state update and missing-row success default are explicitly forbidden.
- Verified the existing provider-error/release-failure test still preserves `MODEL_DEPRECATED`, and lost-response replay still accepts an existing exact released lease.
- Re-ran Function/migration/RBAC, shared/client/Preload/IPC, all Main knowledge, Application baseline, and UI knowledge boundaries. Task 7 introduced no new failure.

### External gates

- Real PostgreSQL parsing/execution and concurrent completion-versus-revocation scheduling remain external release gates because no approved CloudBase pre-production environment exists. Live testing must cover both lock orders: completion winning first and safely releasing, and revocation winning first so completion waits and then observes expiry/revocation.
- If revocation owns the consent row first, completion cannot release while revocation drains; the repository remains bounded by the fixed 30-second sending deadline from Round 2. Live statement/Function timeout configuration must permit that safe bounded path.
- TokenHub abort/runtime bounds, clock alignment, RLS/grants, vector deletion, and cleanup scheduling remain release blockers. Cloud/beta availability and the kill switch remain fail-closed.

### Self-review

- Re-read the complete Round 3 diff for fabricated missing success, admitted release, expired resurrection, wrong token/epoch mutation, consent races, deadline check/use races, idempotency loss, provider-error masking, vector persistence after revoke, payload-bearing logs, migration drift, and unrelated Task 1-5 changes.
- Confirmed completion and revoke use the same consent-first lock order. If completion wins, revocation subsequently deletes vectors; if revocation wins, completion cannot report release and the fixed lease deadline bounds the wait.
- Confirmed Function continuation is now strictly coupled to exact `released`; every other response is discarded. No Renderer/Main authority surface, log payload, RBAC grant, schema object, or rollback dependency changed.
- Confirmed the controller-owned `progress.md` was not edited or staged by this fix. No real CloudBase or TokenHub call was made.

### Concerns

- Live SQL transaction, lock-order, TokenHub, clock, RLS, deletion, and timeout behavior remains unverified and must block release under the ruling.
- The unrelated Application context-summary suite retains exactly the required `CONTEXT_LIMIT_EXCEEDED` baseline failure.
