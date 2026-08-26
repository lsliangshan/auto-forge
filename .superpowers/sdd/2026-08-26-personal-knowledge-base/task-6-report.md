# Task 6 implementation report

## Outcome

- Added repository-deployable personal-knowledge CloudBase schema, matching versioned migration, destructive rollback, deployment guide, and CommonJS Cloud Function.
- Added Main-only `CloudBaseKnowledgeClient` with strict request/response envelopes and stable retry classification. It sends no caller user id, Service Role credential, direct COS credential, or permanent object URL.
- Added encrypted-database durable sync state: offline mutations, lease token/expiry/CAS, attempts capped at three, monotonic cursor, full-snapshot replacement after stale cursors, preserved content/delete conflicts, staged publication, pause, verified convert-to-local-only, cancellation, and durable orphan cleanup.
- Cloud generations remain unpublished on failure; the prior published generation changes only after server CAS publication succeeds.
- Fix round 1 adds page-last incremental cursors with `hasMore`, durable 90-day retention floors and atomic snapshots, per-base synchronization epochs, terminal third leases, durable conversion journals, one-time verified PG Storage uploads, private-byte orphan deletion, composite owner FKs, and narrow sequence grants.

## TDD evidence

- RED: missing Main client/service modules caused two focused suite import failures.
- RED: missing upload/entitlement and begin-sync APIs failed with missing methods.
- RED: cursor regression, remote generation publication, in-flight cancellation, and full-resync replacement tests failed on their intended behavior before the corresponding changes.
- GREEN: Task 6 cloud function/migration tests 5/5; Main client/sync tests 15/15.
- Fix round 1 RED: tests reproduced the skipped 1,001st change, non-advancing page loop, third-expiry lease hang, duplicate concurrent synchronization, late pause overwrite, non-durable purge conversion, overloaded conflict kind, non-consumable upload ticket, database-first orphan deletion, missing ownership FKs, and broad sequence grant.
- Fix round 1 GREEN: CloudBase function/migration and user-role tests 18/18; Main client/sync tests 27/27; all Main knowledge tests 116/116. Conversion rollback is atomic if prior-mode restoration fails.

## Verification

- `pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts tests/cloudbase/user-role-handler.test.ts`: 18/18.
- All Main knowledge tests: 116/116; the Task 6 client/sync slice is 27/27.
- Canonical Electron Main runner: 2,394 passed, with the one recorded unrelated `CONTEXT_LIMIT_EXCEEDED` context-summary billing failure kept separate.
- Workspace production build passed; built Main/Preload/Renderer output contained none of `AUTOFORGE_PG_SERVICE_KEY`, `server-only`, or `serviceKey`.
- Desktop typecheck, targeted ESLint, migration-copy equality, staged diff check, and secret-pattern scan passed.

## External release gates

- No `tcb`, `psql`, CloudBase integration variables, or approved emulator/pre-production connection is configured. No real CloudBase environment was accessed or mutated.
- The migration, RLS behavior, PG Storage privacy, job workers, rollback, retention cleanup, and concurrent publish/delete behavior still require deployment and integration testing in a disposable CloudBase pre-production environment.
- Desktop Cloud availability remains fail-closed through `kill_switch_enabled`; this task does not claim CloudBase deployment complete.

## Concerns handed to later tasks

- Task 7 must populate and verify staged parser/index generations before using the Task 6 publication CAS.
- Task 9 must provide signed entitlements/kill-switch policy and completion-aware cloud purge/download-window lifecycle.
- Cloud content upload uses a mediated authorization/storage reference seam; the private PG Storage data-plane adapter remains deployment-owned and must not become a direct COS client.
- Deployment must map and verify the documented private PG Storage adapter endpoints, including idempotent missing-object deletion and authoritative hash/size metadata; these endpoints were not called in this repository-only task.

## Fix Round 2

### What changed

- Strengthened the in-flight cancellation regression so a late applied mutation would be available from the mocked pull page, then proved the invalidated synchronization neither starts that pull nor calls `applyRemoteChange` nor advances its cursor.
- Made `cancelMutation` atomically cancel the leased mutation and invalidate only that mutation's knowledge-base synchronization epoch. The epoch update is a compare-and-set against the control token captured in the same SQLite transaction.
- Preserved queued/retry cancellation behavior: only a genuinely in-flight (`leased`) cancellation invalidates the current base run. Existing per-base serialization and pause behavior are unchanged.
- Reused the existing post-await `isActive(knowledgeBaseId, epoch)` checks after mutation push, incremental pull, full resync, snapshot replacement, and individual remote-change application so late work from the invalidated run exits before import.

### TDD RED

Working directory: `apps/desktop`

Command:

`node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/sync-service.test.ts -t "rejects every late remote result from a synchronization invalidated by cancellation"`

Relevant output before the production change:

```text
FAIL  |desktop-node| electron/main/knowledge/sync-service.test.ts > KnowledgeSyncService > rejects every late remote result from a synchronization invalidated by cancellation
AssertionError: expected { status: 'synced', ...(2) } to deeply equal { status: 'paused', ...(2) }
Test Files  1 failed (1)
Tests  1 failed | 18 skipped (19)
```

This was the expected behavioral failure: cancellation left the synchronization epoch current, so the late remote mutation result continued through pull and the run completed as synced.

### TDD GREEN

Working directory: `apps/desktop`

Command:

`node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/sync-service.test.ts -t "rejects every late remote result from a synchronization invalidated by cancellation"`

Relevant output:

```text
Test Files  1 passed (1)
Tests  1 passed | 18 skipped (19)
```

Additional verification:

- `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/sync-service.test.ts`: 19/19 passed.
- `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/*.test.ts`: 116/116 passed.
- `pnpm --filter @autoforge/desktop typecheck`: passed.
- `pnpm exec eslint apps/desktop/electron/main/knowledge/sync-service.ts apps/desktop/electron/main/knowledge/sync-service.test.ts`: passed.
- `git diff --check`: passed.

### Files changed

- `apps/desktop/electron/main/knowledge/sync-service.ts`
- `apps/desktop/electron/main/knowledge/sync-service.test.ts`
- `.superpowers/sdd/2026-08-26-personal-knowledge-base/task-6-report.md`

### Self-review

- The cancellation state transition and per-base epoch invalidation are one local transaction; the mutation remains authoritative even when the remote response arrives later.
- The epoch CAS is scoped by both `knowledge_base_id` and the captured epoch, so it cannot invalidate another base and cannot overwrite a newer control transition.
- Terminal/idempotent cancellation still returns without changing the epoch, and queued/retry cancellation still does not interrupt unrelated in-flight work.
- The Renderer contract, Main-owned user scope/cloud authority, remote API envelopes, per-base synchronization serialization, pause semantics, retry rules, and `kill_switch_enabled` behavior were not changed.
- No real CloudBase endpoint was accessed or mutated. The existing emulator/pre-production deployment gate and unrelated `CONTEXT_LIMIT_EXCEEDED` baseline remain unchanged and were not addressed.

## Fix Round 3

### What changed

- Persisted `input_hash` and the original conflict response in `knowledge_conflicts`. Mutation replay now checks both `knowledge_changes` and `knowledge_conflicts` under the existing owner/mutation advisory lock, rejects a mismatched fingerprint, and returns the original conflict receipt for an identical replay.
- Added a durable orphan-cleanup state machine: prepare atomically reserves eligible objects as `cleanup_reserved` for a specific request and stores the prepared receipt; upload verification can only CAS `authorized/uploaded` objects to `verified`; completion can only mark objects reserved by the same request as `deleted`.
- Reused each locally persisted orphan `request_id` for remote cleanup retries. A single drain still handles up to 100 records, but each object uses its own durable receipt identity so a lost response can be replayed safely.
- Added document-scoped version and version-scoped block candidate keys. Active document versions and chunk document/version/block references now use coherent composite foreign keys, preventing same-base cross-document tuple corruption.
- Made synchronization stop before pull/completion whenever an unexpired leased mutation remains. Resume-before-expiry returns non-synced while retaining `mode = 'syncing'`; expiry/reclaim and the maximum-three-attempt rule are unchanged.
- Kept the feature and canonical versioned migrations byte-identical. Rollback did not require a new operation because no new table/function/constraint name was introduced; existing table drops and the existing active-version constraint drop cover these schema changes.

### TDD RED and GREEN

#### Conflict replay receipt

Working directory: repository root.

Command:

`pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts -t "replays a persisted conflict receipt only for the original mutation input"`

RED:

```text
AssertionError: expected push-mutation SQL to contain
SELECT * INTO existing_conflict FROM public.knowledge_conflicts
Test Files  1 failed (1)
Tests  1 failed | 8 skipped (9)
```

GREEN:

```text
Test Files  1 passed (1)
Tests  1 passed | 8 skipped (9)
```

#### Orphan cleanup reservation versus upload verification

Working directory: repository root.

Command:

`pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts -t "reserves orphan cleanup so upload verification and deletion cannot both win"`

RED:

```text
AssertionError: expected migration SQL to contain 'cleanup_reserved'
Test Files  1 failed (1)
Tests  1 failed | 9 skipped (10)
```

GREEN:

```text
Test Files  1 passed (1)
Tests  1 passed | 9 skipped (10)
```

#### Durable orphan cleanup recovery

Working directory: `apps/desktop`.

Command:

`node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/sync-service.test.ts -t "reuses the durable orphan cleanup request after a lost response"`

RED:

```text
AssertionError: expected 'generated_1' to be 'cleanup:storage/object_retry'
Test Files  1 failed (1)
Tests  1 failed | 20 skipped (21)
```

GREEN:

```text
Test Files  1 passed (1)
Tests  1 passed | 20 skipped (21)
```

#### Coherent document/version/block ownership

Working directory: repository root.

Command:

`pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts -t "rejects cross-document version and block tuples inside one knowledge base"`

RED:

```text
AssertionError: expected knowledge_versions SQL to contain
UNIQUE(owner_id, knowledge_base_id, document_id, id)
Test Files  1 failed (1)
Tests  1 failed | 10 skipped (11)
```

GREEN:

```text
Test Files  1 passed (1)
Tests  1 passed | 10 skipped (11)
```

#### Resume before invalidated lease expiry

Working directory: `apps/desktop`.

Command:

`node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/sync-service.test.ts -t "does not report synced when resumed before an invalidated lease expires"`

RED:

```text
AssertionError: expected status 'synced' to deeply equal status 'paused'
Test Files  1 failed (1)
Tests  1 failed | 19 skipped (20)
```

GREEN:

```text
Test Files  1 passed (1)
Tests  1 passed | 19 skipped (20)
```

### Final verification

- `pnpm exec vitest run tests/cloudbase/knowledge-handler.test.ts tests/cloudbase/user-role-handler.test.ts`: 21/21 passed.
- `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/sync-service.test.ts`: 21/21 passed.
- `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/*.test.ts`: 118/118 passed.
- `pnpm --filter @autoforge/desktop typecheck`: passed.
- `pnpm exec eslint tests/cloudbase/knowledge-handler.test.ts apps/desktop/electron/main/knowledge/sync-service.ts apps/desktop/electron/main/knowledge/sync-service.test.ts`: passed.
- `cmp -s cloudbase/knowledge/migrations/0001_personal_knowledge.sql cloudbase/migrations/20260826120000_personal_knowledge.sql`: passed.
- `git diff --check`: passed.

### Files changed

- `cloudbase/knowledge/migrations/0001_personal_knowledge.sql`
- `cloudbase/migrations/20260826120000_personal_knowledge.sql`
- `tests/cloudbase/knowledge-handler.test.ts`
- `apps/desktop/electron/main/knowledge/sync-service.ts`
- `apps/desktop/electron/main/knowledge/sync-service.test.ts`
- `.superpowers/sdd/2026-08-26-personal-knowledge-base/task-6-report.md`

### Self-review

- Conflict replay preserves the exact original sequence/revisions and still rejects reuse of a mutation ID with different base/entity/operation/revision/payload input.
- Orphan prepare and upload verify contend on the same object row with disjoint source-state predicates, so PostgreSQL row locking and CAS permit only one winner. Cleanup retries reuse the persisted prepare receipt and PG Storage deletion remains idempotent.
- Objects reserved for cleanup retain `verified_at IS NULL`, so publication remains blocked until cleanup completes; completed cleanup sets `deleted_at`, keeping deleted objects outside publication readiness checks.
- Composite foreign keys now enforce document → active version and chunk → document/version/block coherence even when all referenced rows share one owner and knowledge base.
- Outstanding leased mutations prevent both pull and the `synced` CAS, while per-base promise serialization, pause/cancel epochs, lease reclaim, terminal third attempts, and retry classification remain intact.
- Renderer trust boundaries, Main/server ownership, service-role isolation, and `kill_switch_enabled` were not changed.
- No CloudBase service, emulator, or pre-production database was available or accessed. PostgreSQL concurrency and FK enforcement still require the existing disposable pre-production deployment gate; the unrelated `CONTEXT_LIMIT_EXCEEDED` baseline remains unchanged.

## Fix Round 4

### What changed

- Replaced the raw `cleanup:${storageReference}` cleanup identity with `cleanup:v1:<sha256>`, a deterministic 75-character request ID derived from the full storage reference.
- Kept the request ID in the existing `cloud_sync_orphans` row and reused it unchanged for each retry, including after reconstructing the sync service over the same durable database state.
- Added a 512-character storage-reference regression that passes the generated request through the real `CloudBaseKnowledgeClient` validator and a mocked function port. It proves the persisted and sent ID is accepted by the 128-character contract, contains no raw storage path, is stable for the same reference, and differs for another reference.
- Left the one-object-per-request cleanup reservation and local delete CAS unchanged. No API, SQL, or storage-reference limits were widened.

### TDD RED

Working directory: `apps/desktop`.

Command:

`node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/sync-service.test.ts -t "uses an accepted private durable cleanup identity for a long storage reference"`

Relevant output before the production change:

```text
FAIL  |desktop-node| electron/main/knowledge/sync-service.test.ts > KnowledgeSyncService > uses an accepted private durable cleanup identity for a long storage reference
AssertionError: expected 'cleanup:private/storage/sssssssssssss…' to match /^cleanup:v1:[a-f0-9]{64}$/
Test Files  1 failed (1)
Tests  1 failed | 20 skipped (21)
```

This was the intended failure: a valid maximum-length storage reference was copied into the durable cleanup request ID, exceeding the client/API limit and exposing the reference in the identifier.

### TDD GREEN

The same focused command passed after the production change:

```text
Test Files  1 passed (1)
Tests  1 passed | 20 skipped (21)
```

### Final verification

- Focused long-reference regression: 1/1 passed.
- `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/sync-service.test.ts`: 21/21 passed.
- `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/*.test.ts`: 118/118 passed.
- `pnpm --filter @autoforge/desktop typecheck`: passed.
- `pnpm exec eslint apps/desktop/electron/main/knowledge/sync-service.ts apps/desktop/electron/main/knowledge/sync-service.test.ts`: passed.
- `git diff --check`: passed.

### Files changed

- `apps/desktop/electron/main/knowledge/sync-service.ts`
- `apps/desktop/electron/main/knowledge/sync-service.test.ts`
- `.superpowers/sdd/2026-08-26-personal-knowledge-base/task-6-report.md`

### Self-review

- The SHA-256 digest provides a fixed-length, deterministic, collision-resistant per-reference identity; the `cleanup:v1:` namespace makes its purpose and format explicit without embedding the storage reference.
- The request is still persisted before any remote call and is replayed byte-for-byte after a lost response or service restart. Each remote request still reserves and completes exactly one storage object.
- Cleanup success still deletes the local row only when knowledge base, storage reference, and persisted request ID all match, preserving the existing CAS behavior.
- Renderer trust boundaries, Main/server ownership, API and SQL length limits, cleanup reservation semantics, and `kill_switch_enabled` were not changed.
- No real CloudBase service was accessed or mutated. The existing emulator/pre-production deployment gate and unrelated `CONTEXT_LIMIT_EXCEEDED` baseline remain unchanged.

## Fix Round 5

### What changed

- Added an upgrade compatibility path for durable orphan rows written before `e818adc`. `cleanupOrphans` now selects and validates the next batch inside one SQLite transaction, then rewrites only the exact legacy `cleanup:${storageReference}` identity to the existing deterministic `cleanup:v1:<sha256>` identity before any remote submission.
- Leaves an already-correct v1 identity unchanged. Any other persisted identity fails closed with `INVALID_INPUT`; arbitrary request IDs are neither normalized nor submitted.
- Persists the rewritten identity before the remote await, so a crash or lost response reuses the same private 75-character request after service reconstruction. The existing one-object request and post-response delete CAS remain unchanged.
- Kept the 128-character client/API/SQL limit and the 512-character storage-reference limit unchanged.

### TDD RED

Working directory: `apps/desktop`.

Command:

`node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/sync-service.test.ts -t "upgrades a pre-fix durable orphan identity before submission and restart retry"`

Relevant output before the production change:

```text
FAIL  |desktop-node| electron/main/knowledge/sync-service.test.ts > KnowledgeSyncService > upgrades a pre-fix durable orphan identity before submission and restart retry
AssertionError: expected CloudKnowledgeError: INVALID_INPUT to match object { code: 'TRANSIENT_FAILURE' }
Test Files  1 failed (1)
Tests  1 failed | 22 skipped (23)
```

The manually inserted pre-fix row used a valid 512-character storage reference and its historical 520-character `cleanup:${storageReference}` request ID. The real `CloudBaseKnowledgeClient` rejected that stored ID before the mocked Function port could observe the simulated lost response.

Fail-closed command:

`node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/sync-service.test.ts -t "fails closed for an unrelated durable orphan cleanup identity"`

Relevant RED output:

```text
AssertionError: promise resolved "undefined" instead of rejecting
Test Files  1 failed (1)
Tests  1 failed | 22 skipped (23)
```

Before the production change, an unrelated short request ID was accepted, submitted, and deleted instead of being rejected locally.

### TDD GREEN

Command:

`node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/sync-service.test.ts -t "pre-fix durable|unrelated durable"`

Relevant output:

```text
Test Files  1 passed (1)
Tests  2 passed | 21 skipped (23)
```

The regression proves the legacy rewrite is committed before a lost response, remains byte-for-byte stable after service restart, passes the real client validator, and is reused for the successful retry. It also proves unrelated durable identities remain stored and never reach the remote.

### Final verification

- Focused legacy/fail-closed regressions: 2/2 passed.
- `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/sync-service.test.ts`: 23/23 passed.
- `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/*.test.ts`: 120/120 passed.
- `pnpm --filter @autoforge/desktop typecheck`: passed.
- `pnpm exec eslint apps/desktop/electron/main/knowledge/sync-service.ts apps/desktop/electron/main/knowledge/sync-service.test.ts`: passed.
- `git diff --check`: passed.

### Files changed

- `apps/desktop/electron/main/knowledge/sync-service.ts`
- `apps/desktop/electron/main/knowledge/sync-service.test.ts`
- `.superpowers/sdd/2026-08-26-personal-knowledge-base/task-6-report.md`

### Self-review

- Migration recognition is exact: only `cleanup:${storageReference}` is eligible, and the accepted v1 identity must equal the SHA-256 identity derived from that row's full storage reference. A syntactically plausible but mismatched v1 ID therefore also fails closed.
- Selection, validation, and every eligible request-ID update share one SQLite transaction. No remote call can occur until that transaction commits, and a malformed row rolls back the batch rather than leaving a partial migration.
- The existing remote call still contains exactly one storage reference, and local deletion still compares knowledge base, storage reference, and the now-persisted request ID.
- No CloudBase service, emulator, or pre-production database was accessed. `kill_switch_enabled`, the external deployment gate, and the unrelated `CONTEXT_LIMIT_EXCEEDED` baseline remain unchanged.
